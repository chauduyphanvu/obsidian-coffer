import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteStore } from '../src/core/types.ts';
import { describeFailure } from '../src/plugin/status.ts';
import { MemoryStore } from '../src/stores/memory.ts';
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

function copyOf(mem: MemoryStore, clock: { now: number }): MemoryStore {
  const out = new MemoryStore(() => clock.now);
  for (const [k, o] of mem.objects) out.objects.set(k, { data: o.data.slice(), modified: o.modified });
  return out;
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
  const { devices: [a, b], mem, clock } = setup();
  for (const text of ['1\n', '2\n', '3\n']) {
    a.fs.put('n.md', text);
    await a.sync();
  }
  await b.sync();
  mem.objects.delete(key('log', 3)); // storage rolled back by one commit

  b.restart(); // checked at start
  const e = await failure(b.sync());
  assert.match(e.message, /commit 3, the newest this device has seen, is missing/);
  assert.equal(describeFailure(e).id, 'damaged');

  // A device that keeps running and sees nothing new checks again within the hour,
  // before an edit of its own would be committed on top of the gap.
  await a.sync();
  clock.now += HOUR;
  a.fs.put('n.md', '4\n');
  await assert.rejects(a.sync(), /is missing/);
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
  assert.equal(describeFailure(e).id, 'damaged');
  assert.equal(b.fs.text('a.md'), undefined, 'nothing from the other version was written');

  // Shown B's commit 2 in place of A's, C notices at its next start.
  toC.target = forked;
  c.restart();
  const e2 = await failure(c.sync());
  assert.match(e2.message, /commit 2 is not the one this device saw/);
  assert.equal(describeFailure(e2).id, 'damaged');
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

  // A link to anything but the commit before is refused.
  await repo.writeCommit({ seq: 4, device: 'X', time: clock.now, changes: [], prev: 'not the digest of commit 3' });
  assert.match((await failure(b.sync())).message, /commit 4 does not follow/);
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
  assert.equal(describeFailure(e).id, 'damaged');
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

  // A small edit is committed without reading anything, unless the check is due.
  b.fs.put('a.md', 'x\ny\n');
  net.reset();
  await b.sync();
  assert.equal(net.stats.get + net.stats.list, 0);
  clock.now += HOUR;
  b.fs.put('a.md', 'x\ny\nz\n');
  net.reset();
  await b.sync();
  assert.equal(net.stats.get, 3);
  assert.equal(net.stats.put, 2);
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

  for (const k of [key('log', 1), key('snap', 1), key('idx', 1), 'pack/x', 'vault.json', '']) {
    await assert.rejects(repo.writeDoc(k, {}), /not a document key/);
    await assert.rejects(repo.readDoc(k), /not a document key/);
    await assert.rejects(repo.deleteDoc(k), /not a document key/);
    await assert.rejects(repo.listDocs(k), /not a document key/);
  }
  assert.deepEqual(await repo.listDocs('v'), [], 'the key header is not a document');
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
