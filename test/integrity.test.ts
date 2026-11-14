import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryError } from '../src/core/engine.ts';
import { Repo } from '../src/core/repo.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { describeFailure } from '../src/plugin/status.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { withRetry } from '../src/stores/retry.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function setup(names = ['A', 'B'], config = {}) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  const devices = names.map((n) => new Device(n, net, clock, config));
  return { clock, mem, net, devices };
}

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

const key = (prefix: string, seq: number) => `${prefix}/${String(seq).padStart(12, '0')}`;

const failure = (p: Promise<unknown>) =>
  p.then(
    () => assert.fail('expected the sync to fail'),
    (e: Error) => e,
  );

/** Storage that can answer one device from somewhere else than the others. */
class Switch implements RemoteStore {
  target: RemoteStore;
  constructor(target: RemoteStore) {
    this.target = target;
  }
  get(k: string, range?: { start: number; end: number }) {
    return this.target.get(k, range);
  }
  put(k: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    return this.target.put(k, data, opts);
  }
  delete(k: string) {
    return this.target.delete(k);
  }
  list(prefix: string, startAfter?: string) {
    return this.target.list(prefix, startAfter);
  }
}

/** A switch whose next delete takes effect and then fails as if its reply were lost, after `meanwhile` has run. */
class LosesReply extends Switch {
  meanwhile?: () => Promise<void>;
  async delete(k: string) {
    await super.delete(k);
    const f = this.meanwhile;
    if (!f) return;
    this.meanwhile = undefined;
    await f();
    throw new Error('connection reset');
  }
}

function copyOf(mem: MemoryStore, clock: { now: number }): MemoryStore {
  const out = new MemoryStore(() => clock.now);
  for (const [k, o] of mem.objects) out.objects.set(k, { data: o.data.slice(), modified: o.modified });
  return out;
}

const logs = (mem: MemoryStore) => [...mem.objects.keys()].filter((k) => k.startsWith('log/')).sort();

/** Storage that runs `hook` ahead of each request, to change what it holds or fail one at a chosen moment, and counts what it is asked to delete. */
class Tap implements RemoteStore {
  inner: RemoteStore;
  hook?: (op: 'get' | 'put' | 'delete' | 'list', k: string) => Promise<void> | void;
  deletes: string[] = [];
  /** Requests in flight at once, at most. */
  peak = 0;
  private live = 0;
  constructor(inner: RemoteStore) {
    this.inner = inner;
  }
  private async run<T>(op: 'get' | 'put' | 'delete' | 'list', k: string, request: () => Promise<T>): Promise<T> {
    this.peak = Math.max(this.peak, ++this.live);
    try {
      await this.hook?.(op, k);
      return await request();
    } finally {
      this.live--;
    }
  }
  get(k: string, range?: { start: number; end: number }) {
    return this.run('get', k, () => this.inner.get(k, range));
  }
  put(k: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    return this.run('put', k, () => this.inner.put(k, data, opts));
  }
  delete(k: string) {
    this.deletes.push(k);
    return this.run('delete', k, () => this.inner.delete(k));
  }
  list(prefix: string, startAfter?: string) {
    return this.run('list', prefix, () => this.inner.list(prefix, startAfter));
  }
}

/** A deletes `old.bin`, then cleanup runs long after, while B has been offline since before the delete. */
async function staleDevice() {
  const env = setup(['A', 'B'], { snapshotEvery: 2, retentionDays: 7 });
  const { devices: [a, b], clock } = env;
  a.fs.put('old.bin', random(100_000, 1));
  await a.sync();
  await b.sync();
  a.fs.files.delete('old.bin');
  await a.sync(); // commit 2, and a snapshot that later becomes cleanup's floor
  clock.now += 10 * DAY;
  const gc = await a.engine.gc();
  assert.ok(gc.packsDeleted >= 1, 'the deleted file\'s data is outside the window and goes');
  return env;
}

test('a device back after the retention window does not commit data cleanup already deleted (lost race, same pass)', async () => {
  const { devices: [a, b], net, clock } = await staleDevice();
  // Renamed while offline: a delete plus a small new file whose content the stale table still lists.
  const f = b.fs.files.get('old.bin')!;
  b.fs.files.delete('old.bin');
  b.fs.files.set('renamed.bin', f);
  await b.sync();

  const c = new Device('C', net, clock, b.config);
  await c.sync();
  assert.deepEqual(c.fs.files.get('renamed.bin')?.data, f.data);
  await a.sync();
  assert.deepEqual(a.fs.files.get('renamed.bin')?.data, f.data);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('a device back after the retention window does not commit data cleanup already deleted (next pass)', async () => {
  const { devices: [a, b], net, clock } = await staleDevice();
  // Edited while offline, and deleted elsewhere: the edit wins and is pushed in the pass after the lost race,
  // with most of its chunks unchanged from the version cleanup removed.
  const edited = new Uint8Array(100_010);
  edited.set(b.fs.files.get('old.bin')!.data);
  edited.set(random(10, 2), 100_000);
  b.fs.put('old.bin', edited);
  await b.sync();

  const c = new Device('C', net, clock, b.config);
  await c.sync();
  assert.deepEqual(c.fs.files.get('old.bin')?.data, edited);
  await a.sync();
  assert.deepEqual(a.fs.files.get('old.bin')?.data, edited);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('a device notices when the newest commit it saw is gone from storage', async () => {
  const { devices: [a, b], mem } = setup();
  for (const text of ['1\n', '2\n', '3\n']) {
    a.fs.put('n.md', text);
    await a.sync();
  }
  await b.sync();
  mem.objects.delete(key('log', 3)); // storage rolled back by one commit

  b.restart(); // checked at start
  const e = await failure(b.sync());
  assert.match(e.message, /commit 3, the newest this device has seen, is missing/);
  assert.ok(e instanceof HistoryError);
  assert.equal(describeFailure(e).id, 'history');

  // A device that keeps running sees nothing new. An edit of its own is committed at once, and the commit
  // finds the one before it gone: it is taken back, so the log is the one storage had.
  await a.sync();
  a.fs.put('n.md', '4\n');
  await assert.rejects(a.sync(), (x) => x instanceof HistoryError && /is missing/.test(x.message));
  assert.deepEqual(logs(mem), [key('log', 1), key('log', 2)], 'the commit was taken back, and nothing else was');

  // Each carries on from storage as it is once told to.
  await b.engine.acceptStorage();
  await b.sync();
  await a.engine.acceptStorage();
  await a.sync();
  await b.sync();
  await a.sync();
  assert.deepEqual(a.snapshot(), b.snapshot());
  // Storage's version under the name, each device's own beside it.
  assert.equal(a.fs.text('n.md'), '2\n');
  assert.deepEqual([...a.fs.files.keys()].filter((p) => p !== 'n.md').map((p) => a.fs.text(p)).sort(), ['3\n', '4\n']);
  assert.deepEqual((await a.engine.verify()).problems, []);
});

test('a device notices when storage shows devices different versions of the log', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const [toA, toB, toC] = [new Switch(mem), new Switch(mem), new Switch(mem)];
  const [a, b, c] = [new Device('A', toA, clock), new Device('B', toB, clock), new Device('C', toC, clock)];
  a.fs.put('n.md', 'one\n');
  await a.sync();
  await b.sync();
  await c.sync();
  // From here storage answers B from a copy of itself, so A and B both get commit 2.
  const forked = copyOf(mem, clock);
  toB.target = forked;
  a.fs.put('a.md', 'from A\n');
  await a.sync();
  await c.sync(); // C sees A's commit 2
  b.fs.put('b.md', 'from B\n');
  await b.sync();
  a.fs.put('a.md', 'from A, again\n');
  await a.sync();

  // Shown what A committed next, B finds it does not follow B's own commit 2.
  toB.target = mem;
  const e = await failure(b.sync());
  assert.match(e.message, /commit 3 does not follow the commit before it/);
  assert.ok(e instanceof HistoryError);
  assert.equal(describeFailure(e).id, 'history');
  assert.equal(b.fs.text('a.md'), undefined, 'nothing from the other version was written');

  // Shown B's commit 2 in place of A's, C notices at its next start.
  toC.target = forked;
  c.restart();
  const e2 = await failure(c.sync());
  assert.match(e2.message, /commit 2 is not the one this device saw/);
  assert.ok(e2 instanceof HistoryError);
  assert.equal(describeFailure(e2).id, 'history');

  // Each carries on from the storage it is shown once told to, keeping its own edit.
  await b.engine.acceptStorage();
  await b.sync();
  await a.sync();
  assert.equal(a.fs.text('b.md'), 'from B\n');
  assert.equal(b.fs.text('a.md'), 'from A, again\n');
  assert.deepEqual(a.snapshot(), b.snapshot());
  await c.engine.acceptStorage();
  await c.sync();
  assert.equal(c.fs.text('b.md'), 'from B\n');
  assert.deepEqual((await b.engine.verify()).problems, []);
});

test('a commit from a version that does not chain the log is accepted, and the chain picks up after it', async () => {
  const { devices: [a, b], clock } = setup();
  a.fs.put('n.md', 'one\n');
  await a.sync();
  await b.sync();
  const { repo, st } = await a.engine.view();
  // What an older version of the plugin writes: no link to the commit before.
  await repo.writeCommit({ seq: 2, device: 'old', time: clock.now, changes: [{ path: 'copy.md', entry: st.remote.get('n.md')! }] });
  a.fs.put('n.md', 'one\ntwo\n');
  await a.sync(); // loses the race for 2, then commits 3 naming the old-style commit 2
  await b.sync();
  assert.equal(b.fs.text('copy.md'), 'one\n');
  assert.equal(b.fs.text('n.md'), 'one\ntwo\n');
  assert.deepEqual((await b.engine.verify()).problems, []);

  // A link to anything but the commit before is refused. Storage's own commits disagree, which accepting it would find again.
  await repo.writeCommit({ seq: 4, device: 'X', time: clock.now, changes: [], prev: 'not the digest of commit 3' });
  const e = await failure(b.sync());
  assert.match(e.message, /commit 4 does not follow/);
  assert.ok(!(e instanceof HistoryError));
  await assert.rejects(b.engine.acceptStorage(), (x) => !(x instanceof HistoryError) && /commit 4 does not follow/.test((x as Error).message));
  assert.deepEqual((await a.engine.verify()).problems.map((p) => p.object), [key('log', 4)]);
});

test('a state saved before the log was chained is anchored by its first sync', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('n.md', 'one\n');
  await a.sync();
  await b.sync();
  const saved = JSON.parse(b.state.data!);
  delete saved.h;
  b.state.data = JSON.stringify(saved);
  b.restart();
  b.fs.put('n.md', 'one\ntwo\n'); // small enough to commit without looking first, but there is no head to name yet
  await b.sync();
  assert.ok(JSON.parse(b.state.data!).h);
  await a.sync();
  assert.equal(a.fs.text('n.md'), 'one\ntwo\n');
  assert.deepEqual((await a.engine.verify()).problems, []);
});

test('a device that starts from a snapshot checks it against the commit it was taken at', async () => {
  const { devices: [a], mem, net, clock } = setup(['A'], { snapshotEvery: 2 });
  for (const text of ['1\n', '2\n', '3\n']) {
    a.fs.put('n.md', text);
    await a.sync();
  }
  const { repo } = await a.engine.view();
  const files = (await repo.readSnapshot(2))!;
  const fresh = () => new Device('C', net, clock, { snapshotEvery: 2 });

  // Written before the log was chained: no digest in it, so the chain goes on from commit 2 as stored.
  mem.objects.delete(key('snap', 2));
  await repo.writeSnapshot(2, files);
  const c = fresh();
  await c.sync();
  assert.equal(c.fs.text('n.md'), '3\n');

  mem.objects.delete(key('snap', 2));
  await repo.writeSnapshot(2, files, 'the digest of some other commit 2');
  const e = await failure(fresh().sync());
  assert.match(e.message, /snapshot 2 was taken at a different commit 2/);
  assert.ok(!(e instanceof HistoryError), 'a device starting afresh, as accepting storage does, finds it again');
  assert.equal(describeFailure(e).id, 'damaged');
});

test('damage within storage is a plain error, which accepting storage would only find again', async () => {
  const commits = async (d: Device, texts: string[]) => {
    for (const text of texts) {
      d.fs.put('n.md', text);
      await d.sync();
    }
  };
  // The newest commit this device saw is gone while later ones are stored: a hole in the log, not a log cut back.
  {
    const { devices: [a, b], mem } = setup();
    await commits(a, ['1\n', '2\n']);
    await b.sync();
    await commits(a, ['3\n', '4\n']);
    mem.objects.delete(key('log', 2));
    b.restart();
    const e = await failure(b.sync());
    assert.match(e.message, /commit 2, the newest this device has seen, is missing/);
    assert.ok(!(e instanceof HistoryError));
    await assert.rejects(b.engine.acceptStorage(), (x) => !(x instanceof HistoryError) && /gap before commit 3/.test((x as Error).message));
  }
  // A gap past it.
  {
    const { devices: [a, b], mem } = setup();
    await commits(a, ['1\n']);
    await b.sync();
    await commits(a, ['2\n', '3\n', '4\n', '5\n']);
    mem.objects.delete(key('log', 4));
    const e = await failure(b.sync());
    assert.match(e.message, /gap before commit 5/);
    assert.ok(!(e instanceof HistoryError));
    await assert.rejects(b.engine.acceptStorage(), (x) => !(x instanceof HistoryError) && /gap before commit 5/.test((x as Error).message));
  }
  // A snapshot whose commit is gone.
  {
    const { devices: [a, b], mem } = setup(['A', 'B'], { snapshotEvery: 2 });
    await commits(a, ['1\n', '2\n', '3\n']);
    mem.objects.delete(key('log', 2));
    const e = await failure(b.sync());
    assert.match(e.message, /commit 2 is missing, though a snapshot was taken at it/);
    assert.ok(!(e instanceof HistoryError));
    await assert.rejects(b.engine.acceptStorage(), /commit 2 is missing, though a snapshot was taken at it/);
  }
});

test('checking that the newest commit is still there costs one more read, at start and then hourly', async () => {
  const { devices: [a, b], net, clock } = setup();
  a.fs.put('a.md', 'x\n');
  await a.sync();
  await b.sync();
  const reads = async () => {
    net.reset();
    await b.sync();
    return net.stats.get;
  };
  b.restart();
  assert.equal(await reads(), 4, 'the key header, the two probes, and the newest commit');
  assert.equal(await reads(), 2);
  clock.now += HOUR;
  assert.equal(await reads(), 3);
  assert.equal(await reads(), 2);

  // A small edit is committed without looking first, due or not: the commit reads the one before it as it is written.
  b.fs.put('a.md', 'x\ny\n');
  net.reset();
  await b.sync();
  assert.deepEqual([net.stats.get, net.stats.put, net.stats.list], [1, 2, 0]);
  clock.now += HOUR;
  b.fs.put('a.md', 'x\ny\nz\n');
  net.reset();
  await b.sync();
  assert.deepEqual([net.stats.get, net.stats.put, net.stats.list], [1, 2, 0]);
  assert.equal(await reads(), 2, 'that check counts: the next sync does not read the newest commit again');
});

test('a commit written on a log replaced under this device is taken back at once, and a device that read it meanwhile carries on after its retry', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const toA = new Switch(mem);
  const a = new Device('A', toA, clock);
  const b = new Device('B', new Switch(mem), clock);
  a.fs.put('one.md', 'one\n');
  await a.sync();
  await b.sync();
  // From here B is on a copy of storage, where its commit 2 stands in place of A's.
  const copy = copyOf(mem, clock);
  (b.store as Switch).target = copy;
  b.fs.put('b.md', 'from B\n');
  await b.sync();
  a.fs.put('a.md', 'from A\n');
  await a.sync();

  // A is shown the copy, and its next edit would go on top of a commit 2 that is not its own.
  const tap = new Tap(copy);
  toA.target = tap;
  let meanwhile: Error | undefined;
  tap.hook = async (op) => {
    if (op === 'delete') meanwhile = await failure(b.sync());
  };
  a.fs.put('a.md', 'from A, again\n');
  const e = await failure(a.sync());
  assert.ok(e instanceof HistoryError);
  assert.match(e.message, /commit 2 is not the one this device saw/);
  assert.deepEqual(tap.deletes, [key('log', 3)]);
  assert.deepEqual(logs(copy), [key('log', 1), key('log', 2)]);
  // Read before it was gone, the commit stops B once; it does not follow B's own commit 2.
  assert.match(meanwhile!.message, /commit 3 does not follow the commit before it/);

  tap.hook = undefined;
  assert.deepEqual((await b.sync()).errors, []);
  assert.deepEqual((await b.engine.verify()).problems, []);
  await a.engine.acceptStorage();
  await a.sync();
  await b.sync();
  assert.equal(b.fs.text('a.md'), 'from A, again\n');
  assert.equal(a.fs.text('b.md'), 'from B\n');
  assert.deepEqual((await b.engine.verify()).problems, []);
});

/** A on retrying storage, having written commits 1 to 3; then storage loses commit 3, so that A's next commit, 4, finds the one before it gone. */
async function cutBack() {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const tap = new Tap(mem);
  const a = new Device('A', withRetry(tap, 3, 1), clock);
  for (const text of ['1\n', '2\n', '3\n']) {
    a.fs.put('n.md', text);
    await a.sync();
  }
  mem.objects.delete(key('log', 3));
  a.fs.put('n.md', '4\n');
  return { mem, tap, a };
}

test('a commit taken back on storage that retries is deleted once, and only if it is still this device\'s', async () => {
  const { mem, tap, a } = await cutBack();
  await assert.rejects(a.sync(), (x) => x instanceof HistoryError && /is missing/.test(x.message));
  assert.deepEqual(tap.deletes, [key('log', 4)]);
  assert.deepEqual(logs(mem), [key('log', 1), key('log', 2)]);

  // Found changed at the moment it is read again, it is left where it is.
  const again = await cutBack();
  again.tap.hook = (op, k) => {
    if (op === 'get' && k === key('log', 4)) again.mem.objects.get(k)!.data[30] ^= 1;
  };
  await assert.rejects(again.a.sync(), (x) => x instanceof HistoryError && /is missing/.test(x.message));
  assert.deepEqual(again.tap.deletes, []);
  assert.deepEqual(logs(again.mem), [1, 2, 4].map((n) => key('log', n)));
});

test('a commit that cannot be taken back is tried for once, and the failure that made it unwanted is still the one reported', async () => {
  const { mem, tap, a } = await cutBack();
  tap.hook = (op) => {
    if (op === 'delete') throw new Error('boom');
  };
  await assert.rejects(a.sync(), (x) => x instanceof HistoryError && /is missing/.test(x.message));
  assert.deepEqual(tap.deletes, [key('log', 4)], 'one request, though the storage retries what fails');
  assert.deepEqual(logs(mem), [1, 2, 4].map((n) => key('log', n)));
});

test('a retraction whose reply is lost is not sent again: the commit another device wrote at that number meanwhile stays', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const toA = new LosesReply(mem);
  const a = new Device('A', withRetry(toA, 3, 1), clock);
  const d = new Device('D', mem, clock);
  a.fs.put('one.md', 'one\n');
  await a.sync();
  await d.sync();
  // A commits 2 on a copy of storage, as after a restore it was shown; D commits its own 2 on the real one.
  toA.target = copyOf(mem, clock);
  a.fs.put('a.md', 'from A\n');
  await a.sync();
  toA.target = mem;
  d.fs.put('d.md', 'from D\n');
  await d.sync();

  // A's next edit lands at 3 on the real log, where its check finds D's 2, and it takes 3 back. The reply is lost,
  // and before any second request D commits its own 3.
  toA.meanwhile = async () => {
    d.fs.put('d.md', 'from D, again\n');
    assert.equal((await d.sync()).commits, 1);
  };
  a.fs.put('a.md', 'from A, again\n');
  await assert.rejects(a.sync(), (x) => x instanceof HistoryError && /commit 2 is not the one this device saw/.test(x.message));
  assert.deepEqual(logs(mem), [1, 2, 3].map((n) => key('log', n)));
  assert.deepEqual((await d.sync()).errors, []);
  assert.deepEqual((await d.engine.verify()).problems, []);
});

test('a commit that loses the race for its number takes nothing back', async () => {
  const { devices: [a, b], net } = setup();
  a.fs.put('x.md', 'x\n');
  await a.sync();
  await b.sync();
  a.fs.put('a.md', 'a\n');
  b.fs.put('b.md', 'b\n');
  net.reset();
  const results = await Promise.all([a.sync(), b.sync()]);
  assert.ok(results.some((r) => r.rounds > 1), 'one of them lost the number');
  assert.equal(net.stats.delete, 0);
  await a.sync();
  await b.sync();
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual((await a.engine.verify()).problems, []);
});

test('a commit that finds its number taken never deletes the commit that took it, though the commit before it is not the one this device saw', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const toA = new Switch(mem);
  const a = new Device('A', toA, clock);
  const b = new Device('B', new Switch(mem), clock);
  a.fs.put('one.md', 'one\n');
  await a.sync();
  await b.sync();
  const copy = copyOf(mem, clock);
  (b.store as Switch).target = copy;
  for (const text of ['1\n', '2\n']) {
    b.fs.put('b.md', text);
    await b.sync(); // commits 2 and 3 of the copy
  }
  a.fs.put('a.md', 'from A\n');
  await a.sync(); // commit 2 of the original

  const tap = new Tap(copy);
  toA.target = tap;
  a.fs.put('a.md', 'from A, again\n');
  const e = await failure(a.sync()); // commit 3 is taken, and commit 2 below it is not A's
  assert.ok(e instanceof HistoryError);
  assert.deepEqual(tap.deletes, []);
  assert.deepEqual(logs(copy), [1, 2, 3].map((n) => key('log', n)));
  assert.deepEqual((await b.sync()).errors, []);
  assert.deepEqual((await b.engine.verify()).problems, []);
});

test('a commit whose predecessor cannot be read is kept: only a commit found missing or different takes it back', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const tap = new Tap(mem);
  const a = new Device('A', tap, clock);
  const edit = async (text: string) => {
    a.fs.put('n.md', text);
    return a.sync();
  };
  await edit('1\n');
  await edit('2\n');

  // The read fails while the write goes through.
  tap.hook = (op, k) => {
    if (op === 'get' && k === key('log', 2)) throw new Error('injected: request failed');
  };
  assert.equal((await edit('3\n')).commits, 1);
  assert.ok(mem.objects.has(key('log', 3)));

  // The read finds something that does not open, which says nothing of whether the log was replaced.
  tap.hook = undefined;
  mem.objects.get(key('log', 3))!.data[30] ^= 1;
  assert.equal((await edit('4\n')).commits, 1);
  assert.deepEqual(tap.deletes, []);
  assert.deepEqual(logs(mem), [1, 2, 3, 4].map((n) => key('log', n)));
});

test('a compaction move written onto a log cut back meanwhile is taken back', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const tap = new Tap(mem);
  const a = new Device('A', tap, clock, { snapshotEvery: 10 });
  for (let i = 0; i < 10; i++) {
    a.fs.put(`n${i}.md`, `# Note ${i}\n\n${'Some text that is the same in every note. '.repeat(3)}\n${i}\n`);
    await a.sync();
    clock.now += HOUR;
  }
  clock.now += 2 * DAY;
  // After cleanup has read the log, and before its move is written: storage loses the newest commit.
  tap.hook = (op, k) => {
    if (op !== 'put' || !k.startsWith('pack/')) return;
    tap.hook = undefined;
    mem.objects.delete(key('log', 10));
  };
  const e = await failure(a.engine.gc());
  assert.ok(e instanceof HistoryError);
  assert.match(e.message, /commit 10, the newest this device has seen, is missing/);
  assert.deepEqual(tap.deletes, [key('log', 11)]);
  assert.equal(logs(mem).at(-1), key('log', 9));
});

test('the commit and the read that checks the one before it are in flight together, so the check costs no extra round trip', async () => {
  const clock = { now: 1_800_000_000_000 };
  const tap = new Tap(new MemoryStore(() => clock.now));
  tap.hook = () => new Promise((done) => setTimeout(done, 50));
  const a = new Device('A', tap, clock);
  a.fs.put('n.md', '1\n');
  await a.sync();
  a.fs.put('n.md', '2\n');
  tap.peak = 0;
  await a.sync();
  assert.ok(tap.peak >= 2, `${tap.peak} request in flight`);
});

test('verify finds nothing wrong with a healthy vault, quick or deep, and changes nothing', async () => {
  const { devices: [a, b], mem, net } = setup(['A', 'B'], { snapshotEvery: 3 });
  a.fs.put('one.md', 'one\n');
  a.fs.put('pic.bin', random(300_000, 1));
  await a.sync();
  for (let i = 0; i < 4; i++) {
    b.fs.put(`b${i}.md`, `${i}\n`);
    await b.sync();
  }
  await a.sync();
  const objects = () => [...mem.objects].map(([k, o]) => `${k}:${Buffer.from(o.data).toString('base64')}`).sort();
  const before = objects();
  const state = a.state.data;
  const phases = new Set<string>();
  net.reset();

  const quick = await a.engine.verify({ onProgress: (p) => phases.add(p.phase) });
  assert.deepEqual(quick.problems, []);
  assert.deepEqual([quick.deep, quick.commits, quick.snapshot, quick.files, quick.chunks], [false, 5, 3, 6, 0]);
  assert.ok(quick.packs >= 2);

  const deep = await a.engine.verify({ deep: true, onProgress: (p) => phases.add(p.phase) });
  assert.deepEqual(deep.problems, []);
  assert.ok(deep.chunks > 10 && deep.bytes > 300_000, JSON.stringify(deep));
  assert.deepEqual([...phases].sort(), ['chunks', 'log']);

  assert.equal(net.stats.put + net.stats.delete, 0);
  assert.deepEqual(objects(), before);
  assert.equal(a.state.data, state);
});

test('a missing, short or damaged pack fails only the files stored in it: a new device downloads every other file and reports those', async () => {
  const { devices: [a, b], mem } = setup(['A', 'B'], { packMaxBlobBytes: 4096 });
  for (const [i, name] of ['a.bin', 'b.bin', 'c.bin', 'd.bin'].entries()) a.fs.put(name, random(20_000, i + 1));
  a.fs.put('note.md', 'kept\n');
  a.fs.put('copy of d.bin', a.fs.files.get('d.bin')!.data);
  await a.sync();
  const { st } = await a.engine.view();
  const pack = (path: string) => `pack/${st.remote.get(path)!.chunks[0].pack}`;
  mem.objects.delete(pack('a.bin'));
  const short = mem.objects.get(pack('b.bin'))!;
  short.data = short.data.slice(0, short.data.length - 10);
  mem.objects.get(pack('c.bin'))!.data[40] ^= 1;

  const r = await b.sync();
  assert.deepEqual(r.errors.map((e) => e.path).sort(), ['a.bin', 'b.bin', 'c.bin']);
  assert.match(r.errors.find((e) => e.path === 'a.bin')!.message, /Remote pack .* is missing/);
  assert.deepEqual([...b.fs.files.keys()].sort(), ['copy of d.bin', 'd.bin', 'note.md']);
  assert.deepEqual(b.fs.files.get('d.bin')!.data, a.fs.files.get('d.bin')!.data);
  const again = await b.sync();
  assert.deepEqual(again.errors.map((e) => e.path).sort(), ['a.bin', 'b.bin', 'c.bin'], 'tried again, never written half');
  assert.equal(b.fs.files.has('a.bin'), false);
});

test('a conflict whose other version cannot be downloaded keeps the file as it is and makes no copy, however often it is tried', async () => {
  const { devices: [a, b], mem } = setup(['A', 'B'], { packMaxBlobBytes: 4096 });
  a.fs.put('x.bin', random(20_000, 1));
  await a.sync();
  await b.sync();
  a.fs.put('x.bin', random(20_000, 2));
  await a.sync();
  const { st } = await a.engine.view();
  mem.objects.delete(`pack/${st.remote.get('x.bin')!.chunks[0].pack}`);
  const mine = random(20_000, 3);
  b.fs.put('x.bin', mine);
  for (let i = 0; i < 2; i++) {
    const r = await b.sync();
    assert.deepEqual(r.errors.map((e) => e.path), ['x.bin']);
    assert.deepEqual(r.conflictCopies, []);
  }
  assert.deepEqual([...b.fs.files.keys()], ['x.bin']);
  assert.deepEqual(b.fs.files.get('x.bin')!.data, mine);
});

test('verify names the files a missing or short pack affects, and deep mode finds a damaged chunk', async () => {
  const { devices: [a], mem } = setup(['A'], { packMaxBlobBytes: 4096 }); // every chunk in a pack of its own
  for (const [i, name] of ['a.bin', 'b.bin', 'c.bin'].entries()) a.fs.put(name, random(20_000, i + 1));
  await a.sync();
  const { st } = await a.engine.view();
  const pack = (path: string) => `pack/${st.remote.get(path)!.chunks[0].pack}`;
  mem.objects.delete(pack('a.bin'));
  const short = mem.objects.get(pack('b.bin'))!;
  short.data = short.data.slice(0, short.data.length - 10);
  mem.objects.get(pack('c.bin'))!.data[40] ^= 1;

  const quick = await a.engine.verify();
  assert.deepEqual(quick.problems.map((p) => [p.object, p.paths]), [[pack('a.bin'), ['a.bin']], [pack('b.bin'), ['b.bin']]]);
  assert.match(quick.problems[0].message, /is missing/);
  assert.match(quick.problems[1].message, /shorter/);

  const deep = await a.engine.verify({ deep: true });
  assert.equal(deep.problems.length, 3);
  assert.deepEqual([deep.problems[2].object, deep.problems[2].paths], [pack('c.bin'), ['c.bin']]);
  assert.match(deep.problems[2].message, /cannot be read: .*corrupted or tampered/);
});

test('verify reports a snapshot that disagrees with the log, a broken link and a gap', async () => {
  const { devices: [a], mem, clock } = setup(['A'], { snapshotEvery: 2 });
  a.fs.put('other.md', 'x\n');
  for (const text of ['1\n', '2\n', '3\n', '4\n', '5\n']) {
    a.fs.put('n.md', text);
    await a.sync();
  }
  const { repo } = await a.engine.view();

  const files = (await repo.readSnapshot(4))!;
  files.delete('other.md');
  mem.objects.delete(key('snap', 4));
  await repo.writeSnapshot(4, files, (await repo.readCommit(4))!.hash);
  let r = await a.engine.verify();
  assert.deepEqual(r.problems.map((p) => [p.object, p.paths]), [[key('snap', 4), ['other.md']]]);
  assert.match(r.problems[0].message, /does not match the file table the log builds/);

  mem.objects.delete(key('log', 5));
  await repo.writeCommit({ seq: 5, device: 'X', time: clock.now, changes: [], prev: 'not commit 4' });
  mem.objects.delete(key('log', 3));
  r = await a.engine.verify();
  assert.deepEqual(r.problems.map((p) => p.object), [key('log', 3), key('log', 5), key('log', 5)]);
  assert.match(r.problems[0].message, /Commit 3 is missing: there is a gap before commit 4/);
  assert.match(r.problems[1].message, /Commit 5 does not follow commit 4/);
  assert.match(r.problems[2].message, /Commit 5 is not the one this device saw/);
  assert.equal(r.snapshot, 0, 'the log no longer reaches the snapshot intact, so they are not compared');
  assert.equal(r.files, 1, 'past the gap the table is the snapshot\'s, as a new device would see it');
});

test('documents outside the log are encrypted, listed and deleted, and cannot reach the vault\'s own objects', async () => {
  const { devices: [a], mem, clock } = setup(['A']);
  a.fs.put('n.md', 'x\n');
  await a.sync();
  const { repo } = await a.engine.view();
  const t0 = clock.now;
  await repo.writeDoc('dev/laptop', { name: 'Secret laptop', seq: 1 });
  clock.now += 1000;
  await repo.writeDoc('dev/phone', { name: 'Phone' });
  assert.deepEqual(await repo.readDoc('dev/laptop'), { name: 'Secret laptop', seq: 1 });
  assert.equal(await repo.readDoc('dev/tablet'), null);
  assert.deepEqual(await repo.listDocs('dev/'), [{ key: 'dev/laptop', modified: t0 }, { key: 'dev/phone', modified: t0 + 1000 }]);
  assert.ok(!Buffer.from(mem.objects.get('dev/laptop')!.data).toString('latin1').includes('Secret'));

  // Bound to its key: a document copied to another key does not open there.
  mem.objects.set('dev/phone', mem.objects.get('dev/laptop')!);
  await assert.rejects(repo.readDoc('dev/phone'), /tampered/);
  await repo.deleteDoc('dev/phone');
  assert.deepEqual((await repo.listDocs('dev/')).map((d) => d.key), ['dev/laptop']);

  for (const k of [key('log', 1), key('snap', 1), key('idx', 1), 'pack/x', 'vault.json', 'pruned', '']) {
    await assert.rejects(repo.writeDoc(k, {}), /not a document key/);
    await assert.rejects(repo.readDoc(k), /not a document key/);
    await assert.rejects(repo.deleteDoc(k), /not a document key/);
    await assert.rejects(repo.listDocs(k), /not a document key/);
  }
  assert.deepEqual(await repo.listDocs('v'), [], 'the key header is not a document');
  await repo.setPrunedTo(1);
  assert.deepEqual(await repo.listDocs('p'), [], 'nor is the record of how far cleanup has gone');
  assert.ok(mem.objects.has(key('log', 1)) && mem.objects.has('vault.json'));
});

test('view brings the remote file table up to date for features that only read', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('n.md', 'x\n');
  await a.sync();
  await b.sync();
  a.fs.put('m.md', 'y\n');
  await a.sync();
  const v = await b.engine.view();
  assert.equal(v.st.lastSeq, 2);
  assert.deepEqual([...v.st.remote.keys()].sort(), ['m.md', 'n.md']);
  assert.equal(v.cfg.deviceName, 'B');
  assert.equal(v.now, 1_800_000_000_000);
  await b.sync();
  assert.equal(b.fs.text('m.md'), 'y\n');
});

test('storage that holds a vault\'s objects but not its vault.json is never given a new header, by sync, a new device or a device that only receives', async () => {
  const { devices: [a, b], mem, net, clock } = setup(['A', 'B']);
  a.fs.put('n.md', '1\n');
  await a.sync();
  await b.sync();
  const header = mem.objects.get('vault.json')!;
  mem.objects.delete('vault.json');
  const before = [...mem.objects.keys()].sort();
  net.reset();

  a.fs.put('n.md', '2\n');
  const message = /vault key file, vault\.json, is missing from storage.*Put it back from a backup or from bucket versioning; nothing was written/;
  for (const d of [a, new Device('C', net, clock, a.config), new Device('R', net, clock, { ...a.config, readOnly: true })]) {
    d.restart();
    await assert.rejects(d.sync(), message, d.name);
  }
  assert.equal(net.stats.put + net.stats.delete, 0);
  assert.deepEqual([...mem.objects.keys()].sort(), before, 'no new vault.json, and nothing else written');
  assert.match(describeFailure(await failure(a.sync())).title, /damaged/, 'the plugin says the data is damaged and keeps this device\'s files');

  // Which is also what the first step of setup finds, instead of a form for choosing a passphrase.
  await assert.rejects(Repo.exists(net), message);

  mem.objects.set('vault.json', header);
  assert.equal((await a.sync()).pushed, 1);
  assert.equal((await b.sync()).pulled, 1);
  assert.equal(await Repo.exists(net), true);
});

test('storage with no vault at all still gets one, and opening a vault asks for no extra list', async () => {
  const mem = new MemoryStore();
  const lists: string[] = [];
  const store: RemoteStore = { get: (k, r) => mem.get(k, r), put: (k, d, o) => mem.put(k, d, o), delete: (k) => mem.delete(k), list: (p, s) => (lists.push(p), mem.list(p, s)) };
  assert.equal(await Repo.exists(store), false);
  const create = { kdfIterations: 1000, chunk: { min: 4096, avg: 16384, max: 65536 } };
  await Repo.open(store, 'a passphrase', create);
  assert.ok(mem.objects.has('vault.json'));
  assert.deepEqual(lists.sort(), ['log/', 'log/', 'pack/', 'pack/', 'snap/', 'snap/'], 'each of the three prefixes was looked at once for each of the two calls');
  lists.length = 0;
  await Repo.open(store, 'a passphrase', create);
  assert.deepEqual(lists, []);
});

test('a state file cut short starts again from storage as it is: nothing is deleted, and a file that differs is kept both ways', async () => {
  const { devices: [a, b] } = setup();
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  await b.sync();
  b.fs.put('n1.md', '1, edited elsewhere\n');
  await b.sync();
  a.fs.put('n2.md', '2, edited here\n');
  const full = (await a.state.load())!;
  await a.state.save(full.slice(0, full.length >> 1));
  a.restart();
  const r = await a.sync();
  assert.equal(r.deletedLocal + r.deletedRemote, 0);
  // Without the version both last agreed on, only the two files that differ can not be told apart; the 28 others match up.
  assert.equal(r.conflictCopies.length, 2);
  const texts = [...a.fs.files.values()].map((f) => new TextDecoder().decode(f.data));
  for (const t of ['1\n', '1, edited elsewhere\n', '2\n', '2, edited here\n']) assert.ok(texts.includes(t), t);
  await b.sync();
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal((await a.sync()).commits, 0, 'settled');
});
