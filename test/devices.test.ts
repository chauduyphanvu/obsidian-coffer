import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agoText, deviceKey, forgetDevice, heartbeatDue, listDevices, statusText, statusTone, writeHeartbeat, type DeviceStatus } from '../src/core/devices.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function setup(names = ['A', 'B']) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  const devices = names.map((n) => new Device(n, net, clock));
  return { clock, mem, net, devices };
}

const beat = async (d: Device, platform = 'test') => writeHeartbeat(await d.engine.view(), { platform, version: '1.2.3' });
const list = async (d: Device) => listDevices(await d.engine.view());
const devKeys = (mem: MemoryStore) => [...mem.objects.keys()].filter((k) => k.startsWith('dev/'));

async function commit(d: Device, ...texts: string[]) {
  for (const t of texts) {
    d.fs.put('n.md', t);
    await d.sync();
  }
}

test('two devices each see the other once they have synced and written their heartbeats', async () => {
  const { devices: [a, b], clock } = setup();
  await commit(a, '1\n');
  await beat(a, 'macOS');
  clock.now += 5 * MINUTE;
  await b.sync();
  await beat(b, 'iOS');

  const fromA = await list(a);
  assert.deepEqual(fromA.map((d) => [d.name, d.isSelf, d.state, d.behind]), [['A', true, 'current', 0], ['B', false, 'current', 0]]);
  assert.deepEqual([fromA[1].platform, fromA[1].version, fromA[1].lastSeen], ['iOS', '1.2.3', clock.now]);
  assert.deepEqual([fromA[0].platform, fromA[0].lastSeen], ['macOS', clock.now - 5 * MINUTE]);

  const fromB = await list(b);
  assert.deepEqual(fromB.map((d) => [d.name, d.isSelf]), [['B', true], ['A', false]]);
});

test('this device is listed first, then the rest by when they were last seen', async () => {
  const { devices: [a, b, c, d], clock } = setup(['A', 'B', 'C', 'D']);
  for (const x of [c, a, d, b]) {
    await beat(x);
    clock.now += MINUTE;
  }
  assert.deepEqual((await list(d)).map((x) => x.name), ['D', 'B', 'A', 'C']);
});

test('behind counts the commits a device has not seen, and this device is never behind itself', async () => {
  const { devices: [a, b] } = setup();
  await commit(a, '1\n');
  await b.sync();
  await beat(a);
  await beat(b);
  await commit(a, '2\n', '3\n', '4\n');
  await beat(a);

  const fromA = await list(a);
  assert.deepEqual(fromA.map((d) => [d.name, d.behind, d.state]), [['A', 0, 'current'], ['B', 3, 'behind']]);

  // B's own record is older than what its view has just learned; that is not B being behind.
  const fromB = await list(b);
  assert.deepEqual(fromB.map((d) => [d.name, d.behind, d.state]), [['B', 0, 'current'], ['A', 0, 'current']]);
});

test('a device ahead of this one counts as 0 behind, never negative', async () => {
  const { devices: [a, b] } = setup();
  await commit(a, '1\n');
  await b.sync();
  await beat(a);
  const stale = await b.engine.view(); // B's view of the log stops at commit 1
  await commit(a, '2\n', '3\n');
  await beat(a);

  const a2 = (await listDevices(stale)).find((d) => d.name === 'A')!;
  assert.deepEqual([a2.behind, a2.state], [0, 'current']);
});

test('a device is quiet once it has not written for more than 7 days, even if it is also behind', async () => {
  const { devices: [a, b], clock } = setup();
  await commit(a, '1\n');
  await b.sync();
  await beat(b);
  await commit(a, '2\n');
  await beat(a);
  const stateOfB = async () => (await list(a)).find((d) => d.name === 'B')!;

  clock.now += 7 * DAY;
  assert.equal((await stateOfB()).state, 'behind', 'exactly 7 days is not yet quiet');
  clock.now += 1;
  const quiet = await stateOfB();
  assert.deepEqual([quiet.state, quiet.behind], ['quiet', 1]);
  assert.equal(statusText(quiet, clock.now), 'Not seen for 7 days');

  await beat(b); // its view has caught up by now
  assert.equal((await stateOfB()).state, 'current', 'writing a heartbeat ends it');
});

/** Storage that shows B another version of the log from commit 2 on, so A and B both hold a commit 2. */
async function forked() {
  const env = setup();
  const [a, b] = env.devices;
  await commit(a, '1\n');
  await b.sync();
  await beat(a);
  await beat(b);
  const copy = new MemoryStore(() => env.clock.now);
  for (const [k, o] of env.mem.objects) copy.objects.set(k, { data: o.data.slice(), modified: o.modified });
  b.store = copy;
  b.restart();
  await commit(a, 'from A\n');
  await commit(b, 'from B\n');
  return { ...env, a, b, copy };
}

test('devices that hold different commits under the same number are marked diverged', async () => {
  const { a, b, mem, copy } = await forked();
  await beat(a);
  await beat(b); // written to B's copy of storage
  const key = await deviceKey((await b.engine.view()).repo, 'B');
  mem.objects.set(key, copy.objects.get(key)!); // where A can read it

  const fromA = await list(a);
  const theirs = fromA.find((d) => d.name === 'B')!;
  assert.deepEqual([theirs.state, theirs.behind], ['diverged', 0]);
  assert.deepEqual([fromA[0].name, fromA[0].state], ['A', 'current']);
  assert.equal(statusTone(theirs), 'critical');
});

test('divergence needs the same commit number and a digest on both sides', async () => {
  const { a, b, mem, copy } = await forked();
  await beat(a);
  await beat(b);
  const key = await deviceKey((await b.engine.view()).repo, 'B');
  const theirs = async () => (await list(a)).find((d) => d.name === 'B')!;
  mem.objects.set(key, copy.objects.get(key)!);
  assert.equal((await theirs()).state, 'diverged');

  // A moves on: the numbers differ now, and that is only behind.
  await commit(a, 'from A, again\n');
  assert.deepEqual([(await theirs()).state, (await theirs()).behind], ['behind', 1]);

  // A record without a digest, as written before the log was chained, is not compared.
  const { repo, st } = await a.engine.view();
  await repo.writeDoc(key, { name: 'B', platform: 'old', version: '0.0.1', time: a.clock.now, seq: st.lastSeq });
  assert.equal((await theirs()).state, 'current');
});

test('a device that sees the same history as this one is current at the same commit number', async () => {
  const { devices: [a, b] } = setup();
  await commit(a, '1\n', '2\n');
  await b.sync();
  await beat(a);
  await beat(b);
  const fromA = await list(a);
  assert.deepEqual(fromA.map((d) => d.state), ['current', 'current']);
});

test('names with slashes, spaces and emoji round-trip, and no two names share a key', async () => {
  const names = ['a/b', 'a b', 'a  b', 'a\tb', '📱 Phone', '👩‍💻', '../vault.json', 'log/000000000001', 'dev/x', 'A', 'a', '', 'é', 'é', 'x'.repeat(2000)];
  const { devices, mem, clock } = setup(names);
  for (const d of devices) {
    await beat(d);
    clock.now += 1000;
  }
  const found = await list(devices[0]);
  assert.deepEqual(found.map((d) => d.name).sort(), [...names].sort());
  assert.equal(found[0].name, names[0]);
  assert.equal(found[0].isSelf, true);
  assert.equal(found.filter((d) => d.isSelf).length, 1);

  const keys = devKeys(mem);
  assert.equal(new Set(keys).size, names.length);
  for (const k of keys) assert.match(k, /^dev\/[A-Za-z0-9_-]{22}$/);
  const { repo } = await devices[0].engine.view();
  for (const n of names) assert.ok(keys.includes(await deviceKey(repo, n)));
});

test('a key is the same on every device of the vault', async () => {
  const { devices: [a, b] } = setup();
  const [ra, rb] = [(await a.engine.view()).repo, (await b.engine.view()).repo];
  assert.equal(await deviceKey(ra, 'My phone'), await deviceKey(rb, 'My phone'));
  assert.notEqual(await deviceKey(ra, 'My phone'), await deviceKey(ra, 'My phone '));
});

test('a record that cannot be read or understood is skipped', async () => {
  const { devices: [a, b], mem, clock } = setup();
  await beat(a);
  await beat(b);
  const { repo } = await a.engine.view();
  mem.objects.set('dev/garbage', { data: Uint8Array.from({ length: 80 }, (_, i) => i), modified: clock.now });
  mem.objects.set('dev/short', { data: new Uint8Array(3), modified: clock.now });
  await repo.writeDoc('dev/shape', { hello: 'world' });
  await repo.writeDoc('dev/null', null);
  await repo.writeDoc('dev/text', 'A');
  await repo.writeDoc('dev/seq', { name: 'X', platform: 'p', version: '1', time: clock.now, seq: -1 });
  await repo.writeDoc('dev/head', { name: 'Y', platform: 'p', version: '1', time: clock.now, seq: 0, head: 7 });
  mem.objects.set('dev/moved', mem.objects.get(await deviceKey(repo, 'B'))!); // sealed for another key

  assert.deepEqual((await list(a)).map((d) => d.name), ['A', 'B']);
});

test('forgetting a device removes its record; this device cannot be forgotten', async () => {
  const { devices: [a, b], mem } = setup();
  await beat(a);
  await beat(b);
  const view = await a.engine.view();
  assert.equal(devKeys(mem).length, 2);

  await assert.rejects(forgetDevice(view, 'A'), /cannot be forgotten/);
  assert.equal(devKeys(mem).length, 2);

  await forgetDevice(view, 'B');
  assert.deepEqual((await list(a)).map((d) => d.name), ['A']);
  assert.deepEqual(devKeys(mem), [await deviceKey(view.repo, 'A')]);
  await forgetDevice(view, 'B'); // already gone: nothing to do
  await beat(b);
  assert.deepEqual((await list(a)).map((d) => d.name), ['A', 'B'], 'a device that syncs again is back');
});

test('a heartbeat is one write, and listing is one list plus one read per record', async () => {
  const { devices: [a, b, c], net } = setup(['A', 'B', 'C']);
  for (const d of [a, b, c]) await beat(d);
  const view = await a.engine.view();

  net.reset();
  await writeHeartbeat(view, { platform: 'test', version: '1' });
  assert.deepEqual([net.stats.get, net.stats.put, net.stats.list, net.stats.delete], [0, 1, 0, 0]);

  net.reset();
  await listDevices(view);
  assert.deepEqual([net.stats.get, net.stats.put, net.stats.list, net.stats.delete], [3, 0, 1, 0]);
});

test('a heartbeat is due when none was written this session, and then every 30 minutes', () => {
  const t = 1_800_000_000_000;
  assert.equal(heartbeatDue(0, t), true);
  assert.equal(heartbeatDue(t, t), false);
  assert.equal(heartbeatDue(t, t + 30 * MINUTE), false);
  assert.equal(heartbeatDue(t, t + 30 * MINUTE + 1), true);
  assert.equal(heartbeatDue(t, t + DAY), true);
});

test('how long ago, in words', () => {
  assert.equal(agoText(0), 'just now');
  assert.equal(agoText(MINUTE - 1), 'just now');
  assert.equal(agoText(-5 * MINUTE), 'just now', 'another device\'s clock can be ahead');
  assert.equal(agoText(MINUTE), '1 minute ago');
  assert.equal(agoText(2 * MINUTE - 1), '1 minute ago');
  assert.equal(agoText(2 * MINUTE), '2 minutes ago');
  assert.equal(agoText(HOUR - 1), '59 minutes ago');
  assert.equal(agoText(HOUR), '1 hour ago');
  assert.equal(agoText(2 * HOUR), '2 hours ago');
  assert.equal(agoText(DAY - 1), '23 hours ago');
  assert.equal(agoText(DAY), '1 day ago');
  assert.equal(agoText(3 * DAY + 5 * HOUR), '3 days ago');
});

test('the words and tone for each state', () => {
  const now = 1_800_000_000_000;
  const device = (over: Partial<DeviceStatus>): DeviceStatus => ({ name: 'Pixel', platform: 'Android', version: '1', lastSeen: now, behind: 0, isSelf: false, state: 'current', ...over });

  const current = device({});
  assert.equal(statusText(current, now), 'Up to date');
  assert.equal(statusTone(current), 'ok');

  const behind = (n: number) => device({ state: 'behind', behind: n });
  assert.equal(statusText(behind(1), now), '1 change behind');
  assert.equal(statusText(behind(2), now), '2 changes behind');
  assert.equal(statusText(behind(12), now), '12 changes behind');
  assert.equal(statusTone(behind(1)), 'warning');

  const quiet = (days: number) => device({ state: 'quiet', behind: 4, lastSeen: now - days * DAY - HOUR });
  assert.equal(statusText(quiet(9), now), 'Not seen for 9 days');
  assert.equal(statusText(quiet(7), now), 'Not seen for 7 days');
  assert.equal(statusTone(quiet(9)), 'warning');

  const diverged = device({ state: 'diverged' });
  const text = statusText(diverged, now);
  assert.match(text, /^This device and Pixel disagree about the sync history\./);
  assert.match(text, /"Check synced data for damage"/);
  assert.equal(statusTone(diverged), 'critical');
});
