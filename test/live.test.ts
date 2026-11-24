import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIVE_PREFIX, LiveLinks, liveDocs, parseSignal, type Wire } from '../src/core/live.ts';
import { stunProblem, stunUrl } from '../src/plugin/live.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

/** Connections that open when the device that offered takes the answer, as WebRTC's do, with no network. */
class Wires {
  private byToken = new Map<string, FakeWire>();
  private n = 0;
  made = 0;
  make = (): FakeWire => {
    this.made++;
    return new FakeWire(this);
  };
  token(w: FakeWire, kind: string): string {
    const t = `${kind}:${++this.n}`;
    this.byToken.set(t, w);
    return t;
  }
  of(token: string): FakeWire {
    const w = this.byToken.get(token);
    if (!w) throw new Error(`no connection behind ${token}`);
    return w;
  }
}

class FakeWire implements Wire {
  onopen?: () => void;
  onmessage?: (text: string) => void;
  onclose?: () => void;
  peer?: FakeWire;
  open = false;
  closed = false;
  private all: Wires;
  constructor(all: Wires) {
    this.all = all;
  }
  offer(): Promise<string> {
    return Promise.resolve(this.all.token(this, 'offer'));
  }
  answer(offer: string): Promise<string> {
    this.peer = this.all.of(offer);
    return Promise.resolve(this.all.token(this, 'answer'));
  }
  accept(answer: string): Promise<void> {
    const other = this.all.of(answer);
    if (other.closed || this.closed || other.peer !== this) return Promise.resolve();
    this.peer = other;
    this.open = other.open = true;
    this.onopen?.();
    other.onopen?.();
    return Promise.resolve();
  }
  send(text: string): void {
    if (!this.open || !this.peer?.open) throw new Error('not open');
    this.peer.onmessage?.(text);
  }
  close(): void {
    this.closed = true;
    this.open = false;
  }
  /** The other end went away, as when its app is closed. */
  lose(): void {
    this.open = false;
    this.onclose?.();
  }
}

async function setup(names = ['Mac', 'iPhone']) {
  const clock = { now: 1_800_000_000_000 };
  const net = new SimStore(new MemoryStore(() => clock.now));
  const wires = new Wires();
  const timers: { at: number; fn: () => void }[] = [];
  const settle = async () => {
    for (let i = 0; i < 40; i++) await new Promise((ok) => setImmediate(ok));
  };
  /** Lets `ms` pass, running what falls due in order, with everything each one starts finished before the next. */
  const pass = async (ms: number) => {
    const end = clock.now + ms;
    for (;;) {
      await settle();
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      clock.now = Math.max(clock.now, next.at);
      next.fn();
    }
    clock.now = end;
    await settle();
  };
  const devices = [];
  for (const name of names) {
    const d = new Device(name, net, clock);
    // A vault in use: what a new device downloads first is not reported as another device's change.
    if (!devices.length) d.fs.put('seed.md', 'seed\n');
    await d.sync();
    const behind: [string, number][] = [];
    let changes = 0;
    // The commit the files are at, as the plugin keeps it: taken after each sync.
    const at = { seq: d.engine.position() };
    const sync = d.sync.bind(d);
    d.sync = async (force) => {
      const r = await sync(force);
      at.seq = d.engine.position();
      return r;
    };
    const live = new LiveLinks({
      me: name,
      docs: async () => liveDocs(await d.engine.documents()),
      wire: wires.make,
      now: () => clock.now,
      later: (ms, fn) => {
        const t = { at: clock.now + ms, fn };
        timers.push(t);
        return () => void (timers.includes(t) && timers.splice(timers.indexOf(t), 1));
      },
      position: () => at.seq,
      onBehind: (peer, seq) => behind.push([peer, seq]),
      onChange: () => changes++,
    });
    devices.push({ d, live, behind, changes: () => changes });
  }
  const left = async () => (await net.list(LIVE_PREFIX)).map((o) => o.key);
  return { clock, net, wires, timers, pass, devices, left };
}

/** One device sends a change, the other receives it, and each tells its links, as the plugin does after a sync. */
async function change(from: { d: Device; live: LiveLinks }, to: { d: Device; live: LiveLinks }, path: string, text: string) {
  from.d.fs.put(path, text);
  const sent = await from.d.sync();
  assert.equal(sent.commits, 1);
  from.live.committed(from.d.engine.position());
  const got = await to.d.sync();
  await to.live.saw(got.arrived.map((a) => a.device));
}

test('a device that receives another’s change leaves it an offer, the two link, and from then on one hears at once that the other synced', async () => {
  const { devices, pass, left, net } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  assert.equal((await left()).length, 1, 'the offer, and nothing else');
  assert.deepEqual(mac.live.peers(), []);

  await pass(60_000);
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  assert.deepEqual(phone.live.peers(), ['Mac']);
  assert.deepEqual(await left(), [], 'the offer and the answer are gone once read');
  assert.equal(mac.changes(), 1);
  assert.deepEqual(mac.behind, [], 'both are at the same commit');

  mac.d.fs.put('a.md', 'one\ntwo\n');
  await mac.d.sync();
  net.reset();
  mac.live.committed(mac.d.engine.position());
  assert.deepEqual(phone.behind, [['Mac', mac.d.engine.position()]], 'told over the link, with no request to storage');
  assert.deepEqual(net.stats, { get: 0, put: 0, list: 0, delete: 0, up: 0, down: 0 });
  await phone.d.sync();
  assert.equal(new TextDecoder().decode(phone.d.fs.files.get('a.md')!.data), 'one\ntwo\n');
});

test('what the devices leave each other is sealed with the vault’s key and names no device', async () => {
  const { devices, net } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  const [key] = (await net.list(LIVE_PREFIX)).map((o) => o.key);
  assert.doesNotMatch(key, /Mac|iPhone/);
  const raw = new TextDecoder('latin1').decode((await net.get(key))!);
  assert.doesNotMatch(raw, /offer|iPhone|Mac/);
  const doc = parseSignal(await (await mac.d.engine.documents()).readDoc(key));
  assert.equal(doc?.kind, 'offer');
  assert.equal(doc?.from, 'iPhone');
  assert.equal(doc?.to, 'Mac');
});

test('a device alone looks for offers eight times in the two minutes after it sends a change, and asks storage nothing else', async () => {
  const { devices, pass, net, timers } = await setup(['Mac']);
  const [mac] = devices;
  mac.d.fs.put('a.md', 'one\n');
  await mac.d.sync();
  net.reset();
  mac.live.committed(mac.d.engine.position());
  await pass(10 * 60_000);
  assert.deepEqual(net.stats, { get: 0, put: 0, list: 8, delete: 0, up: 0, down: 0 });
  assert.equal(timers.length, 0, 'and then stops');
  // Changes sent close together share their looks.
  mac.live.committed(1);
  mac.live.committed(1);
  await pass(10 * 60_000);
  assert.equal(net.stats.list, 16);
});

test('an offer nobody answers is withdrawn after a minute', async () => {
  const { devices, pass, left } = await setup();
  const [mac, phone] = devices;
  mac.d.fs.put('a.md', 'one\n');
  await mac.d.sync();
  // The Mac's app closes before it looks.
  const got = await phone.d.sync();
  await phone.live.saw(got.arrived.map((a) => a.device));
  assert.equal((await left()).length, 1);
  await pass(90_000);
  assert.deepEqual(await left(), []);
  assert.deepEqual(phone.live.peers(), []);
  // And it can offer again later.
  await pass(60_000);
  await phone.live.saw(['Mac']);
  assert.equal((await left()).length, 1);
});

test('when both devices offer at once, one offer stands and one link opens', async () => {
  const { devices, pass, left, wires } = await setup();
  const [mac, phone] = devices;
  await Promise.all([mac.live.saw(['iPhone']), phone.live.saw(['Mac'])]);
  assert.equal((await left()).length, 2);
  await pass(60_000);
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  assert.deepEqual(phone.live.peers(), ['Mac']);
  assert.deepEqual(await left(), []);
  assert.equal(wires.made, 3, 'the Mac’s offer stood; the iPhone dropped its own and answered');
  mac.live.committed(99);
  assert.deepEqual(phone.behind, [['Mac', 99]]);
  phone.live.committed(100);
  assert.deepEqual(mac.behind, [['iPhone', 100]]);
});

test('a link that ends is forgotten, and the next change received sets one up again', async () => {
  const { devices, pass, wires } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  await pass(60_000);
  assert.deepEqual(phone.live.peers(), ['Mac']);
  const before = wires.made;
  // The phone's app goes to the background: the Mac's end notices, the phone's is gone with it.
  for (const d of devices) (d.live as unknown as { links: Map<string, { wire: FakeWire }> }).links.forEach((l) => l.wire.lose());
  assert.deepEqual(mac.live.peers(), []);
  assert.deepEqual(phone.live.peers(), []);
  assert.equal(mac.changes(), 2);
  mac.live.committed(5);
  assert.deepEqual(phone.behind, [], 'nothing is sent into a link that ended');

  await change(mac, phone, 'a.md', 'one\ntwo\n');
  await pass(60_000);
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  assert.equal(wires.made, before + 2);
});

test('a device that offers again replaces the link the other still holds', async () => {
  const { devices, pass } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  await pass(60_000);
  // The phone lost its end and the Mac has not noticed.
  (phone.live as unknown as { links: Map<string, { wire: FakeWire }> }).links.forEach((l) => l.wire.lose());
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  await change(mac, phone, 'a.md', 'one\ntwo\n');
  await pass(60_000);
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  assert.deepEqual(phone.live.peers(), ['Mac']);
  mac.live.committed(77);
  assert.deepEqual(phone.behind.at(-1), ['Mac', 77]);
});

test('what does not open with the vault’s key, is too old, or was put under another device’s place is removed and not acted on', async () => {
  const { devices, pass, net, left, wires, clock } = await setup();
  const [mac, phone] = devices;
  const docs = liveDocs(await mac.d.engine.documents());
  const mine = `${LIVE_PREFIX}${await docs.id('Mac')}/`;
  const from = await docs.id('iPhone');
  // Bytes from someone who can write to storage and has no key.
  await net.put(`${mine}${await docs.id('Ghost')}-o`, new TextEncoder().encode('not sealed'));
  // An offer that sat for ten minutes.
  await docs.write(`${mine}${await docs.id('Old')}-o`, { v: 1, kind: 'offer', from: 'Old', to: 'Mac', id: 'abcdefgh1234', time: clock.now - 10 * 60_000, sdp: 'offer:0' });
  // A real offer copied to a place it was not written for does not open there: its key is part of its seal.
  await phone.live.saw(['Mac']);
  const real = (await left()).find((k) => k === `${mine}${from}-o`);
  assert.ok(real);
  await net.put(`${mine}${await docs.id('Other')}-o`, (await net.get(real))!);
  const made = wires.made;
  mac.live.committed(1);
  await pass(30_000);
  assert.equal(wires.made, made + 1, 'only the real offer was answered');
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  assert.deepEqual(await left(), []);
});

test('turning it off ends the links and takes back an offer still waiting', async () => {
  const { devices, pass, left } = await setup(['Mac', 'iPhone', 'iPad']);
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  await pass(60_000);
  await phone.live.saw(['iPad']);
  assert.equal((await left()).length, 1);
  await phone.live.close();
  assert.deepEqual(await left(), []);
  assert.deepEqual(phone.live.peers(), []);
  phone.live.committed(9);
  await phone.live.saw(['Mac']);
  await pass(5 * 60_000);
  assert.deepEqual(await left(), [], 'and nothing more is written');
});

test('a device links to at most four others', async () => {
  const { devices, left } = await setup(['Mac']);
  await devices[0].live.saw(['a', 'b', 'c', 'd', 'e', 'f', 'Mac']);
  assert.equal((await left()).length, 4);
});

test('an offer or answer is read field by field', () => {
  const ok = { v: 1, kind: 'answer', from: 'Mac', to: 'iPhone', id: 'abcdefgh1234', time: 1, sdp: 'x' };
  assert.deepEqual(parseSignal(ok), ok);
  for (const bad of [null, 'x', { ...ok, v: 2 }, { ...ok, kind: 'hello' }, { ...ok, from: '' }, { ...ok, id: 'short' }, { ...ok, sdp: '' }, { ...ok, sdp: 'x'.repeat(20_001) }, { ...ok, time: '1' }]) {
    assert.equal(parseSignal(bad), undefined);
  }
});

test('an offer that is read a second time, or put back by someone who can write to storage, does not end the link it made', async () => {
  const { devices, pass, net, left } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  const [key] = await left();
  const offer = (await net.get(key))!;
  await pass(60_000);
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  await net.put(key, offer);
  mac.live.committed(5);
  await pass(60_000);
  assert.deepEqual(mac.live.peers(), ['iPhone']);
  assert.deepEqual(phone.live.peers(), ['Mac']);
  assert.equal(mac.changes(), 1, 'the link never closed');
  assert.deepEqual(await left(), []);
});

test('an offer whose read fails once is read at the next look, not removed', async () => {
  const { devices, pass, net, left } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  const get = net.get.bind(net);
  let failed = 0;
  net.get = (key, range) => (key.startsWith(LIVE_PREFIX) && !failed++ ? Promise.reject(new Error('timeout')) : get(key, range));
  await pass(7_000);
  assert.equal(failed, 1);
  assert.equal((await left()).length, 1, 'still there');
  await pass(60_000);
  assert.deepEqual(mac.live.peers(), ['iPhone']);
});

test('after a connection that never opened, a device waits before it offers again, longer each time', async () => {
  const { devices, pass, left, wires } = await setup();
  const [, phone] = devices;
  const offers = async () => {
    const before = wires.made;
    await phone.live.saw(['Mac']);
    return wires.made - before;
  };
  assert.equal(await offers(), 1);
  await pass(70_000);
  assert.deepEqual(await left(), [], 'withdrawn');
  assert.equal(await offers(), 0, 'not within 30 seconds of giving up');
  await pass(31_000);
  assert.equal(await offers(), 1);
  await pass(70_000);
  await pass(31_000);
  assert.equal(await offers(), 0, 'a minute the second time');
  await pass(30_000);
  assert.equal(await offers(), 1);
});

test('ending the links says nothing of a change to them, so the host can do it while it sets itself up', async () => {
  const { devices, pass } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  await pass(60_000);
  const before = mac.changes();
  await mac.live.close();
  assert.equal(mac.changes(), before);
  assert.deepEqual(mac.live.peers(), []);
});

test('a device is behind only by commits its files are not at: one it has merely read does not hide a linked device’s word', async () => {
  const { devices, pass } = await setup();
  const [mac, phone] = devices;
  await change(mac, phone, 'a.md', 'one\n');
  await pass(60_000);
  const at = phone.d.engine.position();
  mac.d.fs.put('a.md', 'one\ntwo\n');
  await mac.d.sync();
  // The phone reads the log, as its device list does, without syncing.
  await phone.d.engine.view();
  assert.equal(phone.d.engine.position(), at + 1, 'the engine has read the commit');
  mac.live.committed(mac.d.engine.position());
  assert.deepEqual(phone.behind, [['Mac', at + 1]]);
});

test('the address of a helper server is taken with or without its scheme, and none means none', () => {
  assert.equal(stunUrl(''), '');
  assert.equal(stunUrl('  '), '');
  assert.equal(stunUrl(' stun.example.com:3478 '), 'stun:stun.example.com:3478');
  assert.equal(stunUrl('stun:stun.example.com'), 'stun:stun.example.com');
  assert.equal(stunUrl('STUNS:stun.example.com:5349'), 'STUNS:stun.example.com:5349');
  // A wrong one counts as none, and says why.
  for (const bad of ['https://stun.example.com', 'turn:relay.example.com:3478', 'stun.example.com:3478/path', 'two words']) {
    assert.equal(stunUrl(bad), '', bad);
    assert.match(stunProblem(bad), /not the address of a STUN server/);
  }
  assert.equal(stunProblem('stun.example.com:3478'), '');
  assert.equal(stunProblem(''), '');
});
