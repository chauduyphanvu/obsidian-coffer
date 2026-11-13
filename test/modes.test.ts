import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SafetyError } from '../src/core/engine.ts';
import { planChanges } from '../src/core/plan.ts';
import { LocalState } from '../src/core/state.ts';
import { planRestore } from '../src/core/timeline.ts';
import { ReadOnlyError, readOnlyStore, type Entry, type ObjectInfo, type RemoteStore } from '../src/core/types.ts';
import { keepDeferred, restoreSteps } from '../src/plugin/restore.ts';
import { fromB64 } from '../src/core/bytes.ts';
import { sealWithPassphrase } from '../src/core/crypto.ts';
import { codeIterations, decodeInvite, decodeSetupCode, defaultSettings, encodeSetupCode, shareWith } from '../src/plugin/settings.ts';
import { readOnlyInviteCode } from '../src/plugin/shares.ts';
import { describeFailure, resultProblems } from '../src/plugin/status.ts';
import { checkStore } from '../src/stores/doctor.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

const MB = 1 << 20;

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

/** Storage that runs `before` ahead of each request, to change things at a chosen moment of a sync. */
class Tap implements RemoteStore {
  before?: (op: 'get' | 'put' | 'delete' | 'list', key: string) => Promise<void>;
  private inner: RemoteStore;
  constructor(inner: RemoteStore) {
    this.inner = inner;
  }
  async get(key: string, range?: { start: number; end: number }) {
    await this.before?.('get', key);
    return this.inner.get(key, range);
  }
  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    await this.before?.('put', key);
    return this.inner.put(key, data, opts);
  }
  async delete(key: string) {
    await this.before?.('delete', key);
    return this.inner.delete(key);
  }
  async list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    await this.before?.('list', prefix);
    return this.inner.list(prefix, startAfter);
  }
}

/** Runs `f` once, at the first request for `op` that `match` accepts. */
const once = (tap: Tap, op: 'get' | 'put', match: (key: string) => boolean, f: () => Promise<void>) => {
  tap.before = async (o, key) => {
    if (o !== op || !match(key)) return;
    tap.before = undefined;
    await f();
  };
};

/** A writing device A, and device B over its own counted connection to the same storage, with `b` as B's settings. */
function setup(b: object = {}, a: object = {}) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const netA = new SimStore(mem);
  const tapB = new Tap(mem);
  const netB = new SimStore(tapB);
  return { clock, mem, netA, netB, tapB, a: new Device('A', netA, clock, a), b: new Device('B', netB, clock, b) };
}

const writes = (net: SimStore) => net.stats.put + net.stats.delete;
const keys = (mem: MemoryStore) => [...mem.objects.keys()].sort();
const remoteHas = async (d: Device, path: string) => (await d.engine.view()).st.remote.has(path);

// Deferred attachments

test('a file over the deferral limit stays in storage: it is listed, survives a restart, and is never deleted', async () => {
  const { a, b, clock } = setup({ deferAboveMB: 1 });
  a.fs.put('big.bin', random(2 * MB, 1));
  a.fs.put('note.md', 'hi\n');
  await a.sync();

  const r = await b.sync();
  assert.deepEqual(r.deferred, ['big.bin']);
  assert.equal(r.pulled, 1);
  assert.ok(!b.fs.files.has('big.bin') && b.fs.files.has('note.md'));
  assert.deepEqual(r.tooLarge, [], 'deferred and too large never overlap');

  for (const restart of [false, true, true]) {
    if (restart) b.restart();
    clock.now += 60_000;
    const again = await b.sync();
    assert.deepEqual(again.deferred, ['big.bin']);
    assert.deepEqual([again.pulled, again.pushed, again.deletedRemote, again.deletedLocal, again.commits, again.errors.length], [0, 0, 0, 0, 0, 0]);
  }
  await a.sync();
  assert.ok(a.fs.files.has('big.bin'), 'the device that has it keeps it');
  assert.ok(await remoteHas(a, 'big.bin'), 'and storage does too');
  assert.deepEqual((await a.sync()).deletedLocal, 0);
});

test('fetching downloads a deferred file, in a full sync or a hinted one, and from then on it syncs like any other', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  const v1 = random(2 * MB, 1);
  a.fs.put('big.bin', v1);
  a.fs.put('huge.bin', random(3 * MB, 7));
  await a.sync();
  assert.deepEqual((await b.sync()).deferred, ['big.bin', 'huge.bin']);

  let listed = 0;
  const list = b.fs.list.bind(b.fs);
  b.fs.list = () => {
    listed++;
    return list();
  };
  const r = await b.engine.sync({ changed: [], fetch: ['big.bin'] });
  assert.equal(listed, 0, 'the hint was honoured: the vault was not listed');
  assert.equal(r.pulled, 1);
  assert.deepEqual(r.deferred, ['huge.bin']);
  assert.deepEqual(b.fs.files.get('big.bin')!.data, v1);
  assert.ok(!b.fs.files.has('huge.bin'));
  assert.deepEqual((await b.engine.sync({ changed: [] })).deferred, ['huge.bin'], 'a file fetched is not listed again by a sync that only looks at some paths');

  const v2 = random(2 * MB, 2);
  a.fs.put('big.bin', v2);
  await a.sync();
  assert.equal((await b.sync()).pulled, 1, 'an update arrives');
  assert.deepEqual(b.fs.files.get('big.bin')!.data, v2);

  b.fs.put('big.bin', random(2 * MB, 3));
  assert.equal((await b.sync()).pushed, 1, 'an edit is sent');
  await a.sync();
  assert.deepEqual(a.fs.files.get('big.bin')!.data, b.fs.files.get('big.bin')!.data);

  b.fs.files.delete('big.bin');
  assert.equal((await b.sync()).deletedRemote, 1, 'deleting it deletes it everywhere');
  assert.equal((await a.sync()).deletedLocal, 1);
  assert.ok(!(await remoteHas(b, 'big.bin')) && (await remoteHas(b, 'huge.bin')));

  b.fs.put('huge.bin', random(1000, 4));
  await b.sync();
  assert.ok((await b.engine.sync({ fetch: ['nothing.bin', 'big.bin'] })).errors.length === 0, 'a path that is not deferred is ignored');
});

test('the size limit wins over deferral: a fetch cannot bring in a file over it', async () => {
  const { a, b } = setup({ deferAboveMB: 1, maxFileSizeMB: 3 });
  a.fs.put('mid.bin', random(2 * MB, 1));
  a.fs.put('huge.bin', random(4 * MB, 2));
  await a.sync();
  const r = await b.sync();
  assert.deepEqual([r.deferred, r.tooLarge], [['mid.bin'], ['huge.bin']]);
  const fetched = await b.engine.sync({ fetch: ['mid.bin', 'huge.bin'] });
  assert.deepEqual([fetched.deferred, fetched.tooLarge, fetched.pulled], [[], ['huge.bin'], 1]);
  assert.ok(b.fs.files.has('mid.bin') && !b.fs.files.has('huge.bin'));
});

test('a file that shrinks below the limit is pulled on its own, and one that grows past it while synced keeps syncing', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  a.fs.put('x.bin', random(2 * MB, 1));
  a.fs.put('y.bin', random(500_000, 2));
  await a.sync();
  assert.deepEqual((await b.sync()).deferred, ['x.bin']);
  a.fs.put('x.bin', random(100_000, 3));
  await a.sync();
  const r = await b.engine.sync({ changed: [] });
  assert.deepEqual([r.deferred, r.pulled], [[], 1]);

  a.fs.put('y.bin', random(2 * MB, 4));
  await a.sync();
  const grown = await b.sync();
  assert.deepEqual([grown.deferred, grown.pulled], [[], 1], 'a file this device already syncs is not left behind');
  assert.deepEqual(b.fs.files.get('y.bin')!.data, a.fs.files.get('y.bin')!.data);
});

test('a hinted sync leaves a new large remote file in storage', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  a.fs.put('a.md', 'one\n');
  await a.sync();
  await b.sync();
  a.fs.put('late.bin', random(2 * MB, 5));
  await a.sync();
  const r = await b.engine.sync({ changed: [] });
  assert.deepEqual([r.deferred, r.pulled, r.commits], [['late.bin'], 0, 0]);
});

test('deferred files are no deletions: another device deleting thirty of them stops nobody, deleting thirty fetched ones does', async () => {
  const { a, b, clock } = setup({ deferAboveMB: 0.01 });
  for (let i = 0; i < 30; i++) a.fs.put(`att${i}.bin`, random(20_000, i + 1));
  a.fs.put('note.md', 'keep\n');
  await a.sync();
  const first = await b.sync();
  assert.equal(first.deferred.length, 30);
  assert.deepEqual(await b.engine.deferred().then((l) => l.length), 30);

  for (let i = 0; i < 30; i++) a.fs.files.delete(`att${i}.bin`);
  await a.sync(true);
  const r = await b.sync();
  assert.deepEqual([r.deletedLocal, r.deferred, r.errors.length], [0, [], 0], 'no SafetyError, nothing to delete');
  assert.ok(b.fs.files.has('note.md'));

  for (let i = 0; i < 30; i++) a.fs.put(`att${i}.bin`, random(20_000, i + 100));
  await a.sync();
  clock.now += 1000;
  await b.engine.sync({ fetch: Array.from({ length: 30 }, (_, i) => `att${i}.bin`) });
  assert.equal([...b.fs.files.keys()].filter((p) => p.startsWith('att')).length, 30);
  for (let i = 0; i < 30; i++) a.fs.files.delete(`att${i}.bin`);
  await a.sync(true);
  await assert.rejects(b.sync(), SafetyError);
});

test('a file that A commits again while B fetches it: B writes what it planned and the next sync brings the newer one', async () => {
  const { a, b, tapB } = setup({ deferAboveMB: 1 });
  a.fs.put('big.bin', random(2 * MB, 1));
  await a.sync();
  await b.sync();
  const v2 = random(2 * MB, 2);
  once(tapB, 'get', (k) => k.startsWith('pack/'), async () => {
    a.fs.put('big.bin', v2);
    await a.sync();
  });
  const r = await b.engine.sync({ fetch: ['big.bin'] });
  assert.equal(r.pulled, 1);
  assert.notDeepEqual(b.fs.files.get('big.bin')!.data, v2, 'the version it planned');
  const next = await b.sync();
  assert.equal(next.pulled, 1);
  assert.deepEqual(b.fs.files.get('big.bin')!.data, v2);
  assert.equal(next.pushed, 0, 'nothing of it goes back');
});

test('a file created at a deferred path is a conflict, and both versions are kept', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  const theirs = random(2 * MB, 1);
  a.fs.put('big.bin', theirs);
  await a.sync();
  await b.sync();
  const mine = random(3000, 2);
  b.fs.put('big.bin', mine);
  const r = await b.engine.sync({ changed: ['big.bin'] });
  assert.equal(r.conflictCopies.length, 1);
  assert.deepEqual(r.deferred, []);
  assert.deepEqual(b.fs.files.get('big.bin')!.data, theirs);
  assert.deepEqual(b.fs.files.get(r.conflictCopies[0])!.data, mine);
});

test('a file created at the path while a fetch is downloading is not overwritten', async () => {
  const { a, b, tapB } = setup({ deferAboveMB: 1 });
  a.fs.put('big.bin', random(2 * MB, 1));
  await a.sync();
  await b.sync();
  const mine = random(5000, 9);
  once(tapB, 'get', (k) => k.startsWith('pack/'), async () => b.fs.put('big.bin', mine));
  const r = await b.engine.sync({ fetch: ['big.bin'] });
  assert.equal(r.skipped, 1);
  assert.deepEqual(b.fs.files.get('big.bin')!.data, mine);
  const next = await b.sync();
  assert.equal(next.conflictCopies.length, 1, 'and meets the remote file as a conflict next');
  assert.deepEqual(b.fs.files.get(next.conflictCopies[0])!.data, mine);
});

test('a rename on another device downloads neither name', async () => {
  const { a, b, netB } = setup({ deferAboveMB: 1 });
  a.fs.put('big.bin', random(2 * MB, 1));
  await a.sync();
  await b.sync();
  const moved = a.fs.files.get('big.bin')!;
  a.fs.files.delete('big.bin');
  a.fs.files.set('renamed.bin', moved);
  await a.sync();
  netB.reset();
  const r = await b.sync();
  assert.deepEqual([r.deferred, r.pulled, r.deletedLocal], [['renamed.bin'], 0, 0]);
  assert.ok(netB.stats.down < 100_000, `${netB.stats.down} bytes came down`);
});

test('a rename on another device of a file this device holds moves it here, and nothing is downloaded', async () => {
  const { a, b, tapB } = setup({ deferAboveMB: 1 });
  const data = random(2 * MB, 1);
  a.fs.put('big.pdf', data);
  await a.sync();
  await b.sync();
  await b.engine.sync({ fetch: ['big.pdf'] });
  assert.deepEqual(b.fs.files.get('big.pdf')!.data, data);
  const moved = a.fs.files.get('big.pdf')!;
  a.fs.files.delete('big.pdf');
  a.fs.files.set('docs/big.pdf', moved);
  await a.sync();

  assert.deepEqual(await b.engine.deferred(), [], 'a file this device has is not one left in storage, whatever it is called now');
  const packs: string[] = [];
  tapB.before = async (op, key) => {
    if (op === 'get' && key.startsWith('pack/')) packs.push(key);
  };
  const r = await b.sync();
  assert.deepEqual([r.deferred, r.pulled, r.deletedLocal, r.errors.length], [[], 1, 1, 0]);
  assert.deepEqual([...b.fs.files.keys()], ['docs/big.pdf']);
  assert.deepEqual(b.fs.files.get('docs/big.pdf')!.data, data);
  assert.deepEqual(packs, [], 'its bytes were here already');
  const next = await b.sync();
  assert.deepEqual([next.pulled, next.pushed, next.deletedLocal, next.deferred, packs], [0, 0, 0, [], []]);
});

test('a folder of held large files moved on another device is no mass deletion here, and downloads nothing', async () => {
  const { a, b, tapB } = setup({ deferAboveMB: 0.01 });
  const names = Array.from({ length: 30 }, (_, i) => `att${i}.bin`);
  names.forEach((n, i) => a.fs.put(`old/${n}`, random(20_000, i + 1)));
  a.fs.put('note.md', 'keep\n');
  await a.sync();
  assert.equal((await b.sync()).deferred.length, 30);
  await b.engine.sync({ fetch: names.map((n) => `old/${n}`) });
  assert.equal([...b.fs.files.keys()].filter((p) => p.startsWith('old/')).length, 30);

  for (const n of names) {
    a.fs.files.set(`new/${n}`, a.fs.files.get(`old/${n}`)!);
    a.fs.files.delete(`old/${n}`);
  }
  await a.sync();
  const packs: string[] = [];
  tapB.before = async (op, key) => {
    if (op === 'get' && key.startsWith('pack/')) packs.push(key);
  };
  const r = await b.sync();
  assert.deepEqual([r.deletedLocal, r.pulled, r.deferred, r.errors.length, packs], [30, 30, [], 0, []]);
  assert.deepEqual([...b.fs.files.keys()].sort(), ['note.md', ...names.map((n) => `new/${n}`)].sort());
  names.forEach((n, i) => assert.deepEqual(b.fs.files.get(`new/${n}`)!.data, random(20_000, i + 1)));
});

test('a copy of a held large file elsewhere arrives, and a copy of one this device never had stays in storage', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  const held = random(2 * MB, 1);
  const never = random(2 * MB, 2);
  a.fs.put('held.bin', held);
  a.fs.put('never.bin', never);
  await a.sync();
  assert.deepEqual((await b.sync()).deferred, ['held.bin', 'never.bin']);
  await b.engine.sync({ fetch: ['held.bin'] });
  a.fs.put('copy/held.bin', held);
  a.fs.put('copy/never.bin', never);
  await a.sync();
  assert.deepEqual((await b.engine.deferred()).map((f) => f.path), ['copy/never.bin', 'never.bin']);
  const r = await b.sync();
  assert.deepEqual([r.pulled, r.deferred], [1, ['copy/never.bin', 'never.bin']]);
  assert.deepEqual(b.fs.files.get('copy/held.bin')!.data, held);
});

test('deferred() lists the files with their sizes, and not one that is on this device', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  a.fs.put('big.bin', random(2 * MB, 1));
  a.fs.put('sub/vid.bin', random(3 * MB, 2));
  a.fs.put('small.bin', random(1000, 3));
  await a.sync();
  await b.sync();
  assert.deepEqual(await b.engine.deferred(), [{ path: 'big.bin', size: 2 * MB }, { path: 'sub/vid.bin', size: 3 * MB }]);
  b.fs.put('big.bin', random(10, 4));
  assert.deepEqual((await b.engine.deferred()).map((f) => f.path), ['sub/vid.bin']);
  assert.deepEqual(await a.engine.deferred(), [], 'a device with no limit has none');
});

test('a restore to an earlier time leaves deferred files alone', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  a.fs.put('note.md', 'one\n');
  await a.sync();
  const before = (await a.engine.view()).st.remote;
  const earlier = new Map(before);
  a.fs.put('big.bin', random(2 * MB, 1));
  a.fs.put('note.md', 'two\n');
  await a.sync();
  const { deferred } = await b.sync();
  assert.deepEqual(deferred, ['big.bin']);

  const { st } = await b.engine.view();
  const plan = planRestore(st.remote, earlier);
  assert.ok(plan.remove.includes('big.bin'), 'it would be taken away, a file that is not here');
  const left = new Set(deferred);
  const { steps, left: count } = restoreSteps(plan, st.remote, (path) => left.has(path));
  assert.deepEqual(steps.map((s) => [s.kind, s.path]), [['change', 'note.md']]);
  assert.equal(count, 1);
});

test('a restore asked before the first sync of a session leaves deferred files alone too: the engine says what is left, not the last sync', async () => {
  const { a, b } = setup({ deferAboveMB: 1 });
  a.fs.put('note.md', 'one\n');
  await a.sync();
  const earlier = new Map((await a.engine.view()).st.remote);
  a.fs.put('big.bin', random(2 * MB, 1));
  a.fs.put('note.md', 'two\n');
  await a.sync();
  await b.sync();
  b.restart(); // a new engine, as after the app starts: no sync has run, so nothing has said what is left in storage

  const kept = await keepDeferred((path) => path === 'skip.md', b.engine);
  const { st } = await b.engine.view();
  const plan = planRestore(st.remote, earlier);
  assert.ok(plan.remove.includes('big.bin'), 'it would be taken away, a file that is not here');
  const { steps, left } = restoreSteps(plan, st.remote, kept);
  assert.deepEqual(steps.map((s) => [s.kind, s.path]), [['change', 'note.md']]);
  assert.equal(left, 1);
  assert.deepEqual([kept('skip.md'), kept('big.bin'), kept('note.md')], [true, true, false]);

  await b.engine.sync({ fetch: ['big.bin'] });
  assert.equal((await keepDeferred(() => false, b.engine))('big.bin'), false, 'one that was downloaded is an ordinary file again');
});

test('the plan never turns a file left in storage into a deletion, whatever else is true of it', () => {
  const entry = (size: number): Entry => ({ size, mtime: 1, chunks: [{ id: `c${size}`, pack: 'p', off: 0, len: size, size }] });
  const limit = 1000;
  for (const here of [false, true]) {
    for (const agreed of [false, true]) {
      for (const there of [false, true]) {
        for (const size of [500, 5000]) {
          for (const defers of [false, true]) {
            const st = new LocalState();
            const e = entry(size);
            if (there) st.remote.set('f', e);
            if (agreed) st.synced.set('f', { entry: e, lsize: size, lmtime: 1 });
            const local = new Map(here ? [['f', { key: 'f', path: 'f', size, mtime: agreed ? 1 : 2 }]] : []);
            const p = planChanges(local, st, () => false, Infinity, new Set(), undefined, defers ? (_, r) => r.size > limit : undefined);
            const never = !here && !agreed && there && size > limit && defers;
            const touched = [...p.pushes.map((f) => f.key), ...p.pushDeletes, ...p.pulls, ...p.pullDeletes, ...p.conflicts];
            const note = JSON.stringify({ here, agreed, there, size, defers });
            if (never) assert.deepEqual(touched, [], note);
            else if (here && agreed && !there) assert.deepEqual(p.pullDeletes, ['f'], `a deletion elsewhere still arrives: ${note}`);
            else if (!here && agreed && there) assert.deepEqual(p.pushDeletes, ['f'], `a deletion here is still sent: ${note}`);
            else if (!here && !agreed && there) assert.deepEqual(p.pulls, ['f'], note);
          }
        }
      }
    }
  }
});

// Read-only mode

test('a device that only reads receives everything and writes nothing, at any request', async () => {
  const { a, b, netB, mem, clock } = setup({ readOnly: true });
  a.fs.put('notes/one.md', 'hello\n');
  a.fs.put('img/pic.png', random(50_000, 1));
  a.fs.put('empty.md', '');
  await a.sync();

  const r = await b.sync();
  assert.equal(r.pulled, 3);
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.deepEqual(r.unsent, []);
  assert.equal(writes(netB), 0);

  a.fs.put('notes/one.md', 'hello\nworld\n');
  a.fs.files.delete('img/pic.png');
  await a.sync();
  const stored = keys(mem);
  clock.now += 60_000;
  const next = await b.engine.sync({ changed: [] });
  assert.deepEqual([next.pulled, next.deletedLocal], [1, 1]);
  assert.deepEqual(b.snapshot(), a.snapshot());
  b.restart();
  await b.sync();
  assert.ok(await b.engine.remoteChanged().then((x) => !x));
  assert.equal(writes(netB), 0);
  assert.deepEqual(keys(mem), stored, 'nothing of B is stored');
});

test('the same line edited on both sides: this device keeps its version beside storage\'s, as unsent, and it never reaches A', async () => {
  const { a, b, netB, mem } = setup({ readOnly: true });
  a.fs.put('n.md', 'line\n');
  await a.sync();
  await b.sync();
  a.fs.put('n.md', 'from A\n');
  b.fs.put('n.md', 'from B\n');
  await a.sync();
  const r = await b.sync();
  assert.equal(r.conflictCopies.length, 1);
  assert.deepEqual(r.unsent, r.conflictCopies);
  assert.equal(b.fs.text('n.md'), 'from A\n', 'storage\'s version takes the name');
  assert.equal(b.fs.text(r.conflictCopies[0]), 'from B\n');

  const copies = [r.conflictCopies[0]];
  for (const next of [await b.sync(), await b.engine.sync({ changed: [] })]) {
    assert.deepEqual([next.conflictCopies, next.unsent], [[], copies], 'listed again, and no more copies');
  }
  await a.sync();
  assert.deepEqual([...a.fs.files.keys()], ['n.md']);
  assert.equal(writes(netB), 0);
  assert.equal((await a.engine.view()).st.remote.size, 1);
  assert.equal(keys(mem).filter((k) => k.startsWith('log/')).length, (await a.engine.view()).st.lastSeq, 'storage holds the commits of A and none of B');
});

test('edits to different paragraphs are merged here, still unsent, and merged again when storage changes', async () => {
  const { a, b, netB } = setup({ readOnly: true });
  a.fs.put('n.md', 'one\n\ntwo\n\nthree\n');
  await a.sync();
  await b.sync();
  a.fs.put('n.md', 'ONE\n\ntwo\n\nthree\n');
  b.fs.put('n.md', 'one\n\ntwo\n\nthree\n\nfour\n');
  await a.sync();
  const r = await b.sync();
  assert.deepEqual([r.merged, r.conflictCopies, r.unsent], [1, [], ['n.md']]);
  assert.equal(b.fs.text('n.md'), 'ONE\n\ntwo\n\nthree\n\nfour\n');

  const again = await b.sync();
  assert.deepEqual([again.merged, again.unsent], [0, ['n.md']]);

  a.fs.put('n.md', 'ONE\n\nTWO\n\nthree\n');
  await a.sync();
  const last = await b.sync();
  assert.deepEqual([last.merged, last.conflictCopies, last.unsent], [1, [], ['n.md']]);
  assert.equal(b.fs.text('n.md'), 'ONE\n\nTWO\n\nthree\n\nfour\n');
  await a.sync();
  assert.equal(a.fs.text('n.md'), 'ONE\n\nTWO\n\nthree\n', 'A never sees what B changed');
  assert.equal(writes(netB), 0);
});

test('a file deleted here comes back from storage, and wiping the folder is no mass deletion', async () => {
  const { a, b, netB } = setup({ readOnly: true });
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  await b.sync();

  b.fs.files.delete('n3.md');
  const one = await b.sync();
  assert.deepEqual([one.pulled, one.deletedRemote, one.pushed], [1, 0, 0]);
  assert.equal(b.fs.text('n3.md'), '3\n');

  b.fs.files.clear();
  const all = await b.sync();
  assert.deepEqual([all.pulled, all.deletedRemote], [30, 0], 'everything is downloaded again, nothing paused');
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.equal(writes(netB), 0);
  await a.sync();
  assert.equal(a.fs.files.size, 30);
  assert.equal((await a.engine.view()).st.remote.size, 30);

  b.fs.files.delete('n7.md');
  const hinted = await b.engine.sync({ changed: ['n7.md'] });
  assert.equal(hinted.pulled, 1);
});

test('a remote mass delete still pauses a device that only reads', async () => {
  const { a, b } = setup({ readOnly: true });
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  await b.sync();
  a.fs.files.clear();
  await a.sync(true);
  await assert.rejects(b.sync(), SafetyError);
  assert.equal(b.fs.files.size, 30);
  const forced = await b.sync(true);
  assert.equal(forced.deletedLocal, 30);
});

test('an edit made here beats a deletion elsewhere: the file stays and is listed as unsent', async () => {
  const { a, b, netB } = setup({ readOnly: true });
  a.fs.put('n.md', 'one\n');
  a.fs.put('gone.md', 'bye\n');
  await a.sync();
  await b.sync();
  a.fs.files.delete('n.md');
  a.fs.files.delete('gone.md');
  await a.sync();
  b.fs.put('n.md', 'one\nmine\n');
  const r = await b.sync();
  assert.deepEqual([r.deletedLocal, r.unsent, b.fs.text('n.md')], [1, ['n.md'], 'one\nmine\n'], 'the untouched file went with the deletion, the edited one stayed');
  assert.ok(!b.fs.files.has('gone.md'));
  assert.equal(writes(netB), 0);
});

test('whatever happens on both sides, a device that only reads writes nothing and keeps every line typed on it', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { a, b, netB, mem } = setup({ readOnly: true });
    const r = rng(seed);
    const names = ['n0.md', 'n1.md', 'n2.md', 'n3.md'];
    const alive = new Set<string>();
    const touched = new Set<string>();
    const typed = (d: Device, path: string, line: string) => d.fs.put(path, `${d.fs.text(path) ?? ''}${line}\n`);
    await a.sync();
    await b.sync();
    for (let step = 0; step < 40; step++) {
      const path = names[Math.floor(r() * names.length)];
      const roll = r();
      if (roll < 0.25) {
        typed(a, path, `A${step}`);
        await a.sync();
      } else if (roll < 0.35) {
        a.fs.files.delete(path);
        await a.sync(true);
      } else if (roll < 0.7) {
        typed(b, path, `B${step}`);
        alive.add(`B${step}`);
        touched.add(path);
      } else if (roll < 0.8) {
        for (const m of (b.fs.text(path) ?? '').split('\n')) alive.delete(m);
        b.fs.files.delete(path);
        touched.add(path);
      } else {
        const hinted = roll < 0.9;
        await b.engine.sync(hinted ? { changed: [...touched] } : {});
        touched.clear();
        if (!hinted) b.restart();
      }
    }
    const last = await b.sync();
    const text = [...b.fs.files.keys()].map((p) => b.fs.text(p)).join('\n');
    for (const m of alive) assert.ok(text.includes(`${m}\n`), `seed ${seed}: ${m} was lost`);
    assert.deepEqual(last.errors, [], `seed ${seed}`);
    assert.equal(writes(netB), 0, `seed ${seed}`);
    assert.ok(![...a.fs.files.keys()].some((p) => /B\d/.test(a.fs.text(p) ?? '')), `seed ${seed}: nothing of B reached A`);
    assert.ok(![...mem.objects.keys()].some((k) => k.startsWith('dev/')), `seed ${seed}`);
  }
});

test('a settings file that cannot be merged is not overwritten here: it stays, and is listed as unsent', async () => {
  const css = '.obsidian/snippets/x.css';
  const { a, b, netB } = setup({ readOnly: true });
  a.fs.put(css, 'a { color: black }\n');
  await a.sync();
  await b.sync();
  a.fs.put(css, 'a { color: red }\n');
  b.fs.put(css, 'a { color: blue }\n');
  await a.sync();
  for (let i = 0; i < 2; i++) {
    const r = await b.sync();
    assert.deepEqual([r.unsent, r.conflictCopies, b.fs.text(css)], [[css], [], 'a { color: blue }\n'], 'the same each time');
  }
  assert.equal(writes(netB), 0);

  const writer = new Device('W', netB, { now: 1_800_000_000_000 });
  assert.equal((await writer.sync()).errors.length, 0);
  assert.equal(writer.fs.text(css), 'a { color: red }\n');
});

test('a new file stays here and is listed, in full and in hinted syncs', async () => {
  const { a, b, netB, mem } = setup({ readOnly: true });
  a.fs.put('a.md', 'a\n');
  await a.sync();
  await b.sync();
  b.fs.put('new.md', 'mine\n');
  assert.deepEqual((await b.sync()).unsent, ['new.md']);
  assert.deepEqual((await b.engine.sync({ changed: [] })).unsent, ['new.md']);
  assert.deepEqual((await b.engine.sync({ changed: ['a.md'] })).unsent, ['new.md']);
  b.fs.put('new.md', 'mine, edited\n');
  assert.deepEqual((await b.engine.sync({ changed: ['new.md'] })).unsent, ['new.md']);
  a.fs.put('a.md', 'a2\n');
  await a.sync();
  const stored = keys(mem);
  assert.deepEqual((await b.engine.sync({ changed: [] })).unsent, ['new.md'], 'a pull does not make it forget');
  assert.equal(b.fs.text('new.md'), 'mine, edited\n');
  assert.equal(writes(netB), 0);
  assert.deepEqual(keys(mem), stored);
  await a.sync();
  assert.ok(!a.fs.files.has('new.md'));
});

test('a file that was only touched is not a change; an edit that is then undone is no longer one', async () => {
  const { a, b } = setup({ readOnly: true });
  a.fs.put('n.md', 'same\n');
  await a.sync();
  await b.sync();
  const f = b.fs.files.get('n.md')!;
  b.fs.files.set('n.md', { data: f.data.slice(), mtime: f.mtime + 5000 });
  assert.deepEqual((await b.sync()).unsent, []);
  b.fs.put('n.md', 'edited\n');
  assert.deepEqual((await b.sync()).unsent, ['n.md']);
  b.fs.put('n.md', 'same\n');
  assert.deepEqual((await b.sync()).unsent, []);

  a.fs.put('n.md', 'changed in storage\n');
  await a.sync();
  const touched = b.fs.files.get('n.md')!;
  b.fs.files.set('n.md', { data: touched.data.slice(), mtime: touched.mtime + 5000 });
  const r = await b.sync();
  assert.deepEqual([r.unsent, r.conflictCopies, b.fs.text('n.md')], [[], [], 'changed in storage\n'], 'touched here, changed there: the change arrives and nothing is left unsent');
  assert.deepEqual((await b.sync()).unsent, []);
});

test('storage that refuses writes with HTTP 403 works for a device that only reads, and is an access problem for one that writes', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const a = new Device('A', mem, clock);
  a.fs.put('n.md', 'one\n');
  await a.sync();
  const refusing: RemoteStore = {
    get: (k, range) => mem.get(k, range),
    list: (p, after) => mem.list(p, after),
    put: () => Promise.reject(new Error('S3 PUT failed with HTTP 403 (AccessDenied)')),
    delete: () => Promise.reject(new Error('S3 DELETE failed with HTTP 403 (AccessDenied)')),
  };
  const reader = new Device('R', refusing, clock, { readOnly: true });
  assert.equal((await reader.sync()).pulled, 1);
  reader.fs.put('local.md', 'x\n');
  assert.deepEqual((await reader.sync()).unsent, ['local.md']);

  const writer = new Device('W', refusing, clock);
  writer.fs.put('mine.md', 'x\n');
  const e = await writer.sync().then(() => undefined, (err: unknown) => err);
  assert.equal(describeFailure(e).id, 'access');
  assert.match(describeFailure(e).detail, /Only receive changes/);
});

test('empty storage is a clear error for a device that only reads, and nothing is written', async () => {
  const { b, mem, netB } = setup({ readOnly: true });
  await assert.rejects(b.sync(), /Storage holds no synced vault yet, and this device only reads from it/);
  assert.equal(mem.objects.size, 0);
  assert.equal(writes(netB), 0);
});

test('cleanup, a passphrase change and the history of a device that only reads write nothing', async () => {
  const { a, b, mem, netB } = setup({ readOnly: true }, { snapshotEvery: 4 });
  b.config.snapshotEvery = 4;
  b.restart();
  for (let i = 0; i < 10; i++) {
    a.fs.put('x.md', `rev ${i}\n`);
    await a.sync();
  }
  await b.sync();
  const header = Buffer.from(mem.objects.get('vault.json')!.data).toString();
  netB.reset();
  assert.deepEqual(await b.engine.gc(), { packsDeleted: 0, bytesFreed: 0, snapshotsDeleted: 0, packsCombined: 0, packsWritten: 0, bytesMoved: 0, bytesFreedLater: 0 });
  assert.deepEqual(netB.stats, { get: 0, put: 0, list: 0, delete: 0, up: 0, down: 0 }, 'no request at all');

  await assert.rejects(b.engine.changePassphrase('another passphrase'), ReadOnlyError);
  assert.equal(Buffer.from(mem.objects.get('vault.json')!.data).toString(), header);

  for (const key of [...mem.objects.keys()]) if (key.startsWith('idx/')) mem.objects.delete(key);
  const writer = new Device('C', mem, { now: 1_800_000_000_000 }, { snapshotEvery: 4 });
  await writer.engine.history('x.md');
  assert.ok([...mem.objects.keys()].some((k) => k.startsWith('idx/')), 'a device that writes would have written the index back');
  for (const key of [...mem.objects.keys()]) if (key.startsWith('idx/')) mem.objects.delete(key);
  assert.equal((await b.engine.history('x.md')).length, 10);
  assert.equal(writes(netB), 0);
  assert.ok(![...mem.objects.keys()].some((k) => k.startsWith('idx/')));
});

test('a file edited on this device between the plan and the write keeps its newer content and is listed as unsent next time', async () => {
  for (const [name, edit, merged] of [['another paragraph', 'one\n\ntwo\n\nthree\n\nmine\n', true], ['the same line', 'my one\n\ntwo\n\nthree\n', false]] as const) {
    const { a, b, tapB, netB } = setup({ readOnly: true });
    a.fs.put('n.md', 'one\n\ntwo\n\nthree\n');
    await a.sync();
    await b.sync();
    a.fs.put('n.md', 'ONE\n\ntwo\n\nthree\n');
    await a.sync();
    once(tapB, 'get', (k) => k.startsWith('pack/'), async () => b.fs.put('n.md', edit));
    const r = await b.sync();
    assert.equal(r.skipped, 1, name);
    assert.equal(b.fs.text('n.md'), edit, name);

    const next = await b.engine.sync({ changed: [] });
    assert.equal(next.merged, merged ? 1 : 0, name);
    assert.equal(next.conflictCopies.length, merged ? 0 : 1, name);
    const text = [...b.fs.files.keys()].map((p) => b.fs.text(p)).join('|');
    assert.ok(text.includes(merged ? 'mine' : 'my one'), `${name}: the edit is still here`);
    assert.ok(next.unsent.length >= 1, name);
    assert.equal(writes(netB), 0, name);
    assert.equal(a.fs.text('n.md'), 'ONE\n\ntwo\n\nthree\n');
  }
});

test('a file edited here as storage deletes it is not deleted, and is listed as unsent', async () => {
  const { a, b, netB } = setup({ readOnly: true });
  a.fs.put('n.md', 'one\n');
  await a.sync();
  await b.sync();
  a.fs.files.delete('n.md');
  await a.sync();
  const stat = b.fs.stat.bind(b.fs);
  b.fs.stat = async (path) => {
    b.fs.stat = stat;
    b.fs.put('n.md', 'one\nmine\n');
    return stat(path);
  };
  const r = await b.sync();
  assert.deepEqual([r.deletedLocal, r.skipped, b.fs.text('n.md')], [0, 1, 'one\nmine\n']);
  assert.deepEqual((await b.sync()).unsent, ['n.md']);
  assert.equal(writes(netB), 0);
});

test('the doctor of a device that only reads asks only to read a missing object and to list the log', async () => {
  const mem = new MemoryStore();
  const counted = new SimStore(mem);
  const report = await checkStore(counted, true);
  assert.deepEqual(report.checks.map((c) => c.name), ['read a missing object', 'list log/']);
  assert.ok(report.ok);
  assert.equal(writes(counted), 0);

  const refusing: RemoteStore = {
    get: (k, range) => mem.get(k, range),
    list: (p, after) => mem.list(p, after),
    put: () => Promise.reject(new Error('HTTP 403')),
    delete: () => Promise.reject(new Error('HTTP 403')),
  };
  assert.ok((await checkStore(refusing, true)).ok);
  assert.ok(!(await checkStore(refusing)).ok);
  const down: RemoteStore = { ...refusing, list: () => Promise.reject(new Error('HTTP 403 AccessDenied')) };
  const bad = await checkStore(down, true);
  assert.deepEqual([bad.ok, bad.checks.map((c) => c.ok)], [false, [true, false]]);
});

test('the read-only store passes reads through and refuses every write before it is sent', async () => {
  const mem = new MemoryStore();
  await mem.put('a', new Uint8Array([1, 2, 3]));
  const net = new SimStore(mem);
  const ro = readOnlyStore(net);
  assert.deepEqual([...(await ro.get('a'))!], [1, 2, 3]);
  assert.deepEqual((await ro.list('')).map((o) => o.key), ['a']);
  await assert.rejects(ro.put('b', new Uint8Array(1)), ReadOnlyError);
  await assert.rejects(ro.put('b', new Uint8Array(1), { ifNoneMatch: true }), /only reads from storage/);
  await assert.rejects(ro.delete('a'), ReadOnlyError);
  assert.equal(writes(net), 0);
  assert.ok(mem.objects.has('a') && !mem.objects.has('b'));
});

test('unsent files are a warning of their own, told once however many there are', () => {
  const r = { errors: [], tooLarge: [], unsent: ['a.md', 'b.md'] };
  const [p] = resultProblems(r, [], 200);
  assert.deepEqual([p.id, p.severity, p.title, p.action, p.files], ['unsent', 'warning', '2 files changed here, not sent', 'files', ['a.md', 'b.md']]);
  assert.equal(resultProblems({ ...r, unsent: ['a.md', 'b.md', 'c.md'] }, [], 200)[0].id, p.id);
  assert.equal(resultProblems({ ...r, unsent: ['a.md'] }, [], 200)[0].title, '1 file changed here, not sent');
  assert.deepEqual(resultProblems({ ...r, unsent: [] }, [], 200), []);
});

test('an invite carries Only receive changes, and one made without it does not; a vault\'s setup code never does', async () => {
  const look = (n: string) => ({ ak: 'AKID', sk: 'SECRET', pp: 'vault pass' })[n] ?? '';
  const vault = { ...defaultSettings(false), endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'pp' };
  const reading = await decodeSetupCode(await encodeSetupCode({ ...vault, readOnly: true }, look), 'vault pass', 'V');
  assert.equal(reading.settings.readOnly, undefined, 'whether the new device only receives is its own choice, made on its join step');
  assert.equal((await decodeSetupCode(await encodeSetupCode(vault, look), 'vault pass', 'V')).settings.readOnly, undefined);
  const older = await sealWithPassphrase(JSON.stringify({ storageType: 's3', endpoint: 'https://s3.example.com', bucket: 'bkt', accessKey: 'AKID', secretKey: 'SECRET', readOnly: true }), 'vault pass', 1000);
  assert.equal((await decodeSetupCode(`coffer2.${older}`, 'vault pass', 'V')).settings.readOnly, undefined, 'nor does one an earlier version made on a device that only receives');

  const work = shareWith({ id: 'w', folder: 'Work', endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'pp', readOnly: true });
  const invite = await decodeInvite(await encodeSetupCode(work, look, 'Work'), 'vault pass', 'V', 'j1');
  assert.deepEqual([invite.storage.readOnly, invite.folder], [true, 'Work']);
  assert.equal((await decodeInvite(await encodeSetupCode({ ...work, readOnly: false }, look, 'Work'), 'vault pass', 'V', 'j1')).storage.readOnly, undefined);
});

test('an invite for someone who may only read carries the keys made for that, not this device\'s, and turns on receiving only', async () => {
  const look = (n: string) => ({ ak: 'WRITE-ID', sk: 'WRITE-SECRET', dp: 'WRITE-PW', sp: 'share pass' })[n] ?? '';
  const read = { access: 'READ-ID', secret: 'READ-SECRET', password: 'READ-PW', user: 'reader' };
  const s3 = shareWith({ id: 'w', folder: 'Work', endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'sp' });
  const invite = await decodeInvite(await readOnlyInviteCode(s3, read, look, 'Work', codeIterations()), 'share pass', 'V', 'j1');
  assert.deepEqual(invite.secrets.map(([, v]) => v), ['READ-ID', 'READ-SECRET', 'share pass']);
  assert.deepEqual([invite.storage.readOnly, invite.storage.bucket, invite.folder], [true, 'bkt', 'Work']);

  const dav = shareWith({ id: 'd', folder: 'Docs', storageType: 'webdav', webdavUrl: 'https://dav.example.com/x', webdavUser: 'owner', webdavPasswordSecret: 'dp', passphraseSecret: 'sp' });
  const asked = await decodeInvite(await readOnlyInviteCode(dav, read, look, 'Docs', codeIterations()), 'share pass', 'V', 'j2');
  assert.deepEqual([asked.storage.webdavUser, asked.storage.readOnly], ['reader', true]);
  assert.deepEqual(asked.secrets.map(([, v]) => v), ['READ-PW', 'share pass']);
  assert.ok(!JSON.stringify([invite, asked]).includes('WRITE-'), 'none of the keys this device writes with');
  assert.equal(dav.readOnly, false, 'the share itself is as it was');
});

test('a read-only invite is sealed at the cost the vault asks for, like any other link', async () => {
  const look = (n: string) => ({ ak: 'ak', sk: 'sk', sp: 'share pass' })[n] ?? '';
  const read = { access: 'READ-ID', secret: 'READ-SECRET', password: '', user: '' };
  const share = shareWith({ id: 'w', folder: 'Work', endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'sp' });
  const countOf = (code: string) => new DataView(fromB64(code.slice(code.indexOf('.') + 1)).buffer).getUint32(0);
  assert.equal(countOf(await readOnlyInviteCode(share, read, look, 'Work', codeIterations(undefined))), codeIterations());
  assert.equal(countOf(await readOnlyInviteCode(share, read, look, 'Work', codeIterations(700_000))), 700_000);
});

const CLI = new URL('../src/node/cli.ts', import.meta.url).pathname;

test('cli: sync.readOnly receives, lists what it did not send, writes nothing to the remote, and does not clean up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-modes-'));
  try {
    const setup = (name: string, sync: object) => {
      const vault = join(dir, name);
      mkdirSync(vault);
      const config = join(dir, `${name}.json`);
      writeFileSync(config, JSON.stringify({ vault, remote: { type: 'folder', path: join(dir, 'remote') }, sync: { kdfIterations: 1000, deviceName: name, ...sync } }));
      return { vault, run: (...args: string[]) => spawnSync('node', [CLI, ...args, `--config=${config}`], { encoding: 'utf8', env: { ...process.env, COFFER_PASSPHRASE: 'pw-for-tests' } }) };
    };
    const everything = () => (readdirSync(join(dir, 'remote'), { recursive: true }) as string[]).sort();
    const a = setup('a', {});
    const b = setup('b', { readOnly: true });
    writeFileSync(join(a.vault, 'note.md'), 'hello\n');
    assert.match(a.run('sync').stdout, /^sent 1,/);
    const stored = everything();

    assert.match(b.run('sync').stdout, /^sent 0, received 1,/);
    assert.equal(readFileSync(join(b.vault, 'note.md'), 'utf8'), 'hello\n');
    writeFileSync(join(b.vault, 'mine.md'), 'local\n');
    const again = b.run('sync');
    assert.match(again.stdout, /^sent 0, received 0,/);
    assert.match(again.stderr, /not sent, this device only receives: mine\.md/);
    assert.equal(again.status, 0);
    assert.deepEqual(everything(), stored, 'nothing of B reached the remote, not even its heartbeat');

    const clean = b.run('clean');
    assert.equal(clean.status, 1);
    assert.match(clean.stderr, /only receives changes/);
    const check = b.run('check');
    assert.equal(check.status, 0);
    assert.match(check.stdout, /read a missing object/);
    assert.doesNotMatch(check.stdout, /create an object/);
    assert.deepEqual(everything(), stored);
    assert.ok(!existsSync(join(a.vault, 'mine.md')));
    a.run('sync');
    assert.ok(!existsSync(join(a.vault, 'mine.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
