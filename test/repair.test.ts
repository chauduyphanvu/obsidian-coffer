import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Packer } from '../src/core/packer.ts';
import { verifyRepo } from '../src/core/verify.ts';
import { sameContent, type RemoteStore } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

const DAY = 86_400_000;

/** Storage that runs `before` ahead of the next commit write, as another device's sync would land in between. */
class Before implements RemoteStore {
  inner: RemoteStore;
  before?: () => Promise<void>;
  constructor(inner: RemoteStore) {
    this.inner = inner;
  }
  get(k: string, range?: { start: number; end: number }) {
    return this.inner.get(k, range);
  }
  async put(k: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    if (k.startsWith('log/') && opts?.ifNoneMatch) {
      const f = this.before;
      this.before = undefined;
      await f?.();
    }
    return this.inner.put(k, data, opts);
  }
  delete(k: string) {
    return this.inner.delete(k);
  }
  list(prefix: string, startAfter?: string) {
    return this.inner.list(prefix, startAfter);
  }
}

function setup(names = ['A', 'B'], config = {}) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  const befores = names.map(() => new Before(net));
  const devices = names.map((n, i) => new Device(n, befores[i], clock, config));
  return { clock, mem, net, devices, befores };
}

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

const packKeys = (mem: MemoryStore) => [...mem.objects.keys()].filter((k) => k.startsWith('pack/'));
const logKeys = (mem: MemoryStore) => [...mem.objects.keys()].filter((k) => k.startsWith('log/'));

/** The pack that holds a file's first chunk. */
async function packOf(d: Device, path: string): Promise<string> {
  return `pack/${(await d.engine.view()).st.remote.get(path)!.chunks[0].pack}`;
}

/** A first sync that puts a.bin and a copy of it in one pack, and a second that puts two more files in another. */
async function twoPacks(env = setup()) {
  const { devices: [a] } = env;
  a.fs.put('a.bin', random(3000, 1));
  a.fs.put('copy of a.bin', a.fs.files.get('a.bin')!.data);
  await a.sync();
  a.fs.put('b.bin', random(3000, 2));
  a.fs.put('note.md', 'kept\n');
  await a.sync();
  return env;
}

test('a device that has the files stores again what a deleted pack held, and another then downloads only those files', async () => {
  const { devices: [a, b], mem, net, clock } = await twoPacks();
  await b.sync();
  const pack = await packOf(a, 'a.bin');
  assert.equal(await packOf(a, 'copy of a.bin'), pack);
  assert.notEqual(await packOf(a, 'b.bin'), pack);
  mem.objects.delete(pack);

  // A new device downloads what it can and fails the files in the missing pack.
  const c = new Device('C', net, clock, a.config);
  const rc = await c.sync();
  assert.deepEqual(rc.errors.map((e) => e.path).sort(), ['a.bin', 'copy of a.bin']);
  assert.deepEqual([...c.fs.files.keys()].sort(), ['b.bin', 'note.md']);

  assert.deepEqual((await a.engine.verify()).problems.map((p) => p.object), [pack]);
  const before = new Map((await a.engine.view()).st.remote);
  const r = await a.engine.repair();
  assert.deepEqual(r, { repaired: ['a.bin', 'copy of a.bin'], unrepaired: [], historyOnly: [], chunks: 1 });
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);

  // One commit, flagged as a move, and no content changed.
  const { repo, st } = await a.engine.view();
  const move = (await repo.readCommit(st.lastSeq))!;
  assert.equal(move.moved, true);
  assert.deepEqual(move.changes.map((x) => x.path).sort(), ['a.bin', 'copy of a.bin']);
  assert.deepEqual([...st.remote.keys()].sort(), [...before.keys()].sort());
  for (const [path, e] of before) assert.ok(sameContent(e, st.remote.get(path)!), path);

  // The first device downloaded nothing and sees nothing to do; the new one retries and pulls exactly those two.
  const rb = await b.sync();
  assert.deepEqual([rb.pulled, rb.pushed, rb.commits, rb.errors.length], [0, 0, 0, 0]);
  const again = await c.sync();
  assert.deepEqual([again.pulled, again.errors.length], [2, 0]);
  assert.deepEqual(c.snapshot(), a.snapshot());
});

test('a pack cut short is suspect all through: every current chunk in it is stored again', async () => {
  const { devices: [a], mem } = setup(['A']);
  a.fs.put('x.bin', random(3000, 1));
  a.fs.put('y.bin', random(3000, 2));
  await a.sync();
  const pack = await packOf(a, 'x.bin');
  assert.equal(await packOf(a, 'y.bin'), pack);
  const o = mem.objects.get(pack)!;
  o.data = o.data.slice(0, o.data.length - 10);
  assert.match((await a.engine.verify()).problems[0].message, /shorter/);

  const r = await a.engine.repair();
  assert.deepEqual(r, { repaired: ['x.bin', 'y.bin'], unrepaired: [], historyOnly: [], chunks: 2 });
  const { st } = await a.engine.view();
  for (const path of ['x.bin', 'y.bin']) assert.notEqual(`pack/${st.remote.get(path)!.chunks[0].pack}`, pack);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('a flipped byte inside a pack that is all there is found only by the deep repair', async () => {
  const { devices: [a], mem, net } = setup(['A']);
  a.fs.put('x.bin', random(3000, 1));
  a.fs.put('y.bin', random(3000, 2));
  await a.sync();
  // The two files are packed in whichever order they were sealed.
  const at = (await a.engine.view()).st.remote.get('x.bin')!.chunks[0].off;
  mem.objects.get(await packOf(a, 'x.bin'))!.data[at + 40] ^= 1;
  assert.deepEqual((await a.engine.verify()).problems, []);

  net.reset();
  assert.deepEqual(await a.engine.repair(), { repaired: [], unrepaired: [], historyOnly: [], chunks: 0 });
  assert.equal(net.stats.put + net.stats.delete, 0);

  const phases = new Set<string>();
  const r = await a.engine.repair({ deep: true, onProgress: (p) => phases.add(p.phase) });
  assert.deepEqual(r, { repaired: ['x.bin'], unrepaired: [], historyOnly: [], chunks: 1 });
  assert.deepEqual([...phases], ['chunks']);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('a device without the files reports them and writes nothing at all', async () => {
  const { devices: [a, b], mem, net } = await twoPacks();
  await b.sync();
  mem.objects.delete(await packOf(a, 'a.bin'));
  b.fs.files.delete('a.bin');
  b.fs.files.delete('copy of a.bin');
  const objects = mem.objects.size;
  const seq = (await b.engine.view()).st.lastSeq;

  net.reset();
  const r = await b.engine.repair();
  assert.deepEqual(r, { repaired: [], unrepaired: ['a.bin', 'copy of a.bin'], historyOnly: [], chunks: 0 });
  assert.equal(net.stats.put + net.stats.delete, 0);
  assert.equal(mem.objects.size, objects);
  assert.equal((await b.engine.view()).st.lastSeq, seq);
});

test('files excluded here, or over the size limit here, are not sources', async () => {
  const { devices: [a], mem, net, clock } = await twoPacks();
  mem.objects.delete(await packOf(a, 'a.bin'));
  const seq = (await a.engine.view()).st.lastSeq;
  const same = (config: object) => {
    const d = new Device('D', net, clock, { ...a.config, ...config });
    d.fs.put('a.bin', a.fs.files.get('a.bin')!.data);
    d.fs.put('copy of a.bin', a.fs.files.get('a.bin')!.data);
    return d;
  };
  for (const config of [{ exclude: ['*.bin', 'copy of*'] }, { maxFileSizeMB: 0.001 }]) {
    net.reset();
    const r = await same(config).engine.repair();
    assert.deepEqual([r.repaired, r.unrepaired, r.chunks], [[], ['a.bin', 'copy of a.bin'], 0], JSON.stringify(config));
    assert.equal(net.stats.put + net.stats.delete, 0);
  }
  assert.equal((await a.engine.view()).st.lastSeq, seq);
});

test('a file edited here since: its unchanged chunks are stored again, and the next sync makes the current version whole', async () => {
  const { devices: [a, b], mem } = setup();
  const data = random(200_000, 1); // a dozen chunks in one pack
  a.fs.put('big.bin', data);
  await a.sync();
  await b.sync();
  mem.objects.delete(await packOf(a, 'big.bin'));
  const edited = data.slice();
  edited.set(random(100, 2), edited.length - 100); // the last chunk only
  a.fs.put('big.bin', edited);

  const r = await a.engine.repair();
  assert.deepEqual([r.repaired, r.unrepaired], [[], ['big.bin']], 'the last chunk of the stored version is on no device');
  const { st } = await a.engine.view();
  const chunks = st.remote.get('big.bin')!.chunks;
  assert.ok(r.chunks >= 5 && r.chunks === chunks.length - 1, `${r.chunks} of ${chunks.length}`);
  assert.equal(chunks.filter((c) => !mem.objects.has(`pack/${c.pack}`)).length, 1, 'only the changed one is still missing');

  const sent = await a.sync();
  assert.equal(sent.pushed, 1);
  // The current file is whole. The version before the edit, whose last chunk is on no device, is the one thing a check still finds.
  const after = (await a.engine.verify({ deep: true })).problems;
  assert.deepEqual(after.map((p) => [p.paths, p.earlier]), [[undefined, ['big.bin']]]);
  await b.sync();
  assert.deepEqual(b.fs.files.get('big.bin')!.data, edited);
});

test('a chunk that another file keeps where it can be read is pointed there, and nothing is uploaded', async () => {
  const { devices: [a, b], mem, net, clock } = setup();
  a.fs.put('n.md', 'one note, one chunk\n');
  await a.sync();
  await b.sync();
  // A second place for the same chunk, as a device that raced another to store it would leave.
  const { repo, st } = await a.engine.view();
  const first = st.remote.get('n.md')!;
  const { parts, ids } = await repo.split(a.fs.files.get('n.md')!.data);
  const packer = new Packer(repo, 1 << 20, 1 << 20, 1);
  const ref = packer.add(ids[0], await repo.sealChunk(ids[0], parts[0], false), parts[0].length);
  await packer.flush();
  await repo.writeCommit({
    seq: st.lastSeq + 1, device: 'X', time: clock.now, prev: st.head,
    changes: [{ path: 'copy.md', entry: { size: first.size, mtime: first.mtime, chunks: [ref] } }],
  });
  await b.sync();
  mem.objects.delete(`pack/${first.chunks[0].pack}`);
  b.fs.files.delete('n.md');

  const packs = packKeys(mem).length;
  net.reset();
  const r = await b.engine.repair();
  assert.deepEqual(r, { repaired: ['n.md'], unrepaired: [], historyOnly: [], chunks: 0 });
  assert.equal(packKeys(mem).length, packs);
  assert.equal(net.stats.put, 1, 'the move commit');
  const fixed = (await b.engine.view()).st.remote.get('n.md')!;
  assert.equal(fixed.chunks[0].pack, ref.pack);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('an edit that lands between the upload and the move is kept, and that file is not rewritten', async () => {
  const { devices: [a, b], befores, mem } = setup();
  a.fs.put('a.bin', random(3000, 1));
  a.fs.put('c.bin', random(3000, 2));
  await a.sync();
  await b.sync();
  mem.objects.delete(await packOf(a, 'a.bin'));
  const edited = random(3000, 3);
  b.fs.put('a.bin', edited);
  befores[0].before = async () => {
    await b.sync();
  };

  const r = await a.engine.repair();
  // a.bin is no longer damaged, but the version before the edit, which the move would have mended, stays lost: no current file keeps its chunk.
  assert.deepEqual(r, { repaired: ['a.bin', 'c.bin'], unrepaired: [], historyOnly: ['a.bin'], chunks: 2 });
  const { repo, st } = await a.engine.view();
  const move = (await repo.readCommit(st.lastSeq))!;
  assert.equal(move.moved, true);
  assert.deepEqual(move.changes.map((x) => x.path), ['c.bin']);
  const edit = (await repo.readCommit(st.lastSeq - 1))!;
  assert.deepEqual(edit.changes.map((x) => x.path), ['a.bin']);
  assert.ok(sameContent(st.remote.get('a.bin')!, edit.changes[0].entry!));

  await a.sync();
  await b.sync();
  assert.deepEqual(a.fs.files.get('a.bin')!.data, edited);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual((await a.engine.verify({ deep: true })).problems.map((p) => [p.paths, p.earlier]), [[undefined, ['a.bin']]], 'the version before the edit, as the repair said');
});

test('two devices repairing at once: one move commits, and the other\'s packs are orphans that cleanup removes a day later', async () => {
  const { devices: [a, c], mem, clock } = setup(['A', 'C']);
  a.fs.put('a.bin', random(3000, 1));
  a.fs.put('b.bin', random(3000, 2));
  await a.sync();
  await c.sync();
  mem.objects.delete(await packOf(a, 'a.bin'));
  const commits = logKeys(mem).length;

  const [ra, rc] = await Promise.all([a.engine.repair(), c.engine.repair()]);
  for (const r of [ra, rc]) assert.deepEqual([r.repaired, r.unrepaired], [['a.bin', 'b.bin'], []]);
  assert.equal(logKeys(mem).length, commits + 1, 'one move');
  assert.equal(packKeys(mem).length, 2, 'both stored it');
  await a.sync();
  await c.sync();
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);

  clock.now += 2 * DAY;
  assert.equal((await a.engine.gc()).packsDeleted, 1);
  assert.equal(packKeys(mem).length, 1);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
  assert.deepEqual((await c.engine.verify({ deep: true })).problems, []);
});

test('an earlier version in data that is gone is reported, though the check of the current files finds nothing wrong', async () => {
  const { devices: [a], mem, net } = setup(['A']);
  a.fs.put('x', random(3000, 1));
  await a.sync();
  const old = await packOf(a, 'x');
  a.fs.put('x', random(3000, 2));
  await a.sync();
  mem.objects.delete(old);
  // The current files are fine, which a verify now also says apart from the earlier version it cannot restore.
  assert.deepEqual((await a.engine.verify()).problems.map((p) => [p.object, p.paths, p.earlier]), [[old, undefined, ['x']]]);
  assert.equal((await a.engine.history('x')).length, 2);

  net.reset();
  assert.deepEqual(await a.engine.repair(), { repaired: [], unrepaired: [], historyOnly: ['x'], chunks: 0 });
  assert.equal(net.stats.put + net.stats.delete, 0);
});

test('an earlier version whose chunks a current file still keeps is readable again once those are stored again', async () => {
  const { devices: [a], mem } = setup(['A']);
  const data = random(3000, 1);
  a.fs.put('x.bin', data);
  await a.sync();
  const pack = await packOf(a, 'x.bin');
  a.fs.put('y.bin', data); // the same chunk, so no new data
  a.fs.put('x.bin', random(3000, 2));
  await a.sync();
  mem.objects.delete(pack);
  assert.equal((await a.engine.verify()).problems.length, 1);

  const r = await a.engine.repair();
  assert.deepEqual(r, { repaired: ['y.bin'], unrepaired: [], historyOnly: [], chunks: 1 });
  const old = (await a.engine.history('x.bin')).at(-1)!;
  assert.deepEqual(await a.engine.readVersion(old.entry!), data);
});

test('what a repair did is reported even when the history it would also report on cannot be read', async () => {
  const { devices: [a], mem } = setup(['A']);
  a.fs.put('x.bin', random(3000, 1));
  await a.sync();
  a.fs.put('y.md', 'y\n');
  await a.sync();
  mem.objects.delete(await packOf(a, 'x.bin'));
  mem.objects.delete('log/000000000001');
  assert.deepEqual(await a.engine.repair(), { repaired: ['x.bin'], unrepaired: [], historyOnly: [], chunks: 1 });
});

test('verify reports data only earlier versions need as its own kind of problem: per pack, naming the files whose earlier versions are lost, quick or deep', async () => {
  const { devices: [a], mem } = setup(['A']);
  a.fs.put('x', random(3000, 1));
  a.fs.put('y', random(3000, 2));
  await a.sync();
  const first = await packOf(a, 'x');
  assert.equal(await packOf(a, 'y'), first, 'both are stored in one pack');
  a.fs.put('x', random(3000, 3));
  a.fs.put('y', random(3000, 4));
  a.fs.put('z', random(3000, 5));
  await a.sync();
  a.fs.put('z', random(3000, 6));
  await a.sync();
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);

  const latest = await packOf(a, 'z');
  const pack = mem.objects.get(first)!;
  pack.data = pack.data.slice(0, 100);
  for (const deep of [false, true]) {
    const r = await a.engine.verify({ deep });
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    const [p] = r.problems;
    assert.deepEqual([p.object, p.earlier, p.paths], [first, ['x', 'y'], undefined]);
    assert.match(p.message, /^Pack \w+ is \d+ bytes, shorter than the \d+ that earlier versions of 2 files need: they cannot be restored, though the current files are fine$/);
  }

  mem.objects.delete(first);
  mem.objects.delete(latest);
  const r = await a.engine.verify();
  assert.deepEqual(r.problems.map((p) => [p.object, p.paths, p.earlier]), [[latest, ['z'], undefined], [first, undefined, ['x', 'y']]], 'the current files first');
  assert.match(r.problems[1].message, /^Pack \w+ is missing: earlier versions of 2 files cannot be restored, though the current files are fine$/);
});

test('verify says nothing of an earlier version history no longer offers, a pack a current file needs too, or a file whose current version is damaged', async () => {
  const { devices: [a], mem, clock } = setup(['A']);
  a.fs.put('x', random(3000, 1));
  await a.sync();
  const old = await packOf(a, 'x');
  a.fs.put('x', random(3000, 2));
  await a.sync();
  mem.objects.delete(old);
  assert.equal((await a.engine.verify()).problems.length, 1);
  clock.now += 40 * DAY;
  assert.equal((await a.engine.history('x')).length, 1, 'the first version is no longer offered');
  assert.deepEqual((await a.engine.verify()).problems, []);

  // A pack that is missing for a current file is one problem, not also an earlier version of another file.
  const shared = setup(['A']);
  const [d] = shared.devices;
  const data = random(3000, 1);
  d.fs.put('p.bin', data);
  await d.sync();
  const pack = await packOf(d, 'p.bin');
  d.fs.put('q.bin', data);
  d.fs.put('p.bin', random(3000, 2));
  await d.sync();
  shared.mem.objects.delete(pack);
  assert.deepEqual((await d.engine.verify()).problems.map((p) => [p.object, p.paths, p.earlier]), [[pack, ['q.bin'], undefined]]);
});

test('verify\'s look at earlier versions costs a list, a read of the pruned marker and one read per interval of the log, and writes nothing, though a digest is missing', async () => {
  const { devices: [a], mem, net } = setup(['A'], { snapshotEvery: 10 });
  for (let i = 0; i < 25; i++) {
    a.fs.put('n.md', `${i}\n`);
    await a.sync();
  }
  const { repo, st, cfg, now } = await a.engine.view();
  const quick = async () => {
    net.reset();
    await verifyRepo(repo, { concurrency: cfg.concurrency, rangeGapBytes: cfg.rangeGapBytes, seen: { seq: st.lastSeq, head: st.head } });
    return { ...net.stats };
  };
  const without = await quick();
  net.reset();
  const full = await a.engine.verify();
  assert.deepEqual(full.problems, []);
  const extra = { get: net.stats.get - without.get, list: net.stats.list - without.list, put: net.stats.put - without.put };
  // The pruned marker, one digest for each full interval of 10 commits, and the commits of the interval not yet full; one list of the snapshots.
  assert.deepEqual(extra, { get: 1 + 2 + 5, list: 1, put: 0 }, JSON.stringify(without));

  const digest = [...mem.objects.keys()].find((k) => k.startsWith('idx/'))!;
  mem.objects.delete(digest);
  net.reset();
  assert.deepEqual((await a.engine.verify()).problems, []);
  assert.equal(net.stats.put + net.stats.delete, 0, 'a missing digest is not written back by a check');
  assert.equal(mem.objects.has(digest), false);
});
