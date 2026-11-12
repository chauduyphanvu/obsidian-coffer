import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listDevices, writeHeartbeat } from '../src/core/devices.ts';
import { SafetyError } from '../src/core/engine.ts';
import type { ObjectInfo, RemoteStore } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { Device } from './helpers.ts';

/** Storage whose pack uploads can be held up, to keep a sync in progress for as long as a test needs. */
class Gate implements RemoteStore {
  private inner: RemoteStore;
  private held?: { reached: () => void; release: Promise<void> };
  constructor(inner: RemoteStore) {
    this.inner = inner;
  }
  /** Holds the next pack upload. Resolves to a function that lets it go, once an upload is waiting. */
  hold(): Promise<() => void> {
    let open!: () => void;
    const release = new Promise<void>((r) => (open = r));
    return new Promise((reached) => (this.held = { reached: () => reached(open), release }));
  }
  get(key: string, range?: { start: number; end: number }) {
    return this.inner.get(key, range);
  }
  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    const h = this.held;
    if (h && key.startsWith('pack/')) {
      this.held = undefined;
      h.reached();
      await h.release;
    }
    return this.inner.put(key, data, opts);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    return this.inner.list(prefix, startAfter);
  }
}

function setup() {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const gate = new Gate(mem);
  const [a, b] = ['A', 'B'].map((n) => new Device(n, gate, clock));
  return { clock, gate, a, b };
}

const settled = async <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return done;
};

test('reads that bring the remote table up to date, called at once, apply each new commit once', async () => {
  const { a, b } = setup();
  a.fs.put('n.md', 'one\n');
  await a.sync();
  await b.sync();
  for (let i = 0; i < 3; i++) {
    a.fs.put('n.md', `one\n${i}\n`);
    a.fs.put(`new${i}.md`, `${i}\n`);
    await a.sync();
    const results = await Promise.allSettled([
      b.engine.view(),
      b.engine.view(),
      b.engine.history('n.md'),
      b.engine.remoteChanged().then(async (changed) => {
        if (changed) await b.sync();
      }),
      b.engine.view().then((v) => writeHeartbeat(v, { platform: 'test', version: '1' })),
      b.engine.view().then((v) => listDevices(v)),
      b.sync(),
    ]);
    assert.deepEqual(results.filter((r) => r.status === 'rejected'), []);
  }
  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.deepEqual((await b.engine.verify()).problems, []);
});

test('reads that need no up-to-date table do not wait for a sync stuck uploading; those that do wait, then see its commit', async () => {
  const { a, gate } = setup();
  a.fs.put('n.md', 'one\n');
  await a.sync();
  const entry = (await a.engine.view()).st.remote.get('n.md')!;
  a.fs.put('big.md', 'x'.repeat(300_000));
  const released = gate.hold();
  const sync = a.sync();
  const release = await released;

  assert.equal(await a.engine.remoteChanged(), false);
  assert.equal(new TextDecoder().decode(await a.engine.readVersion(entry)), 'one\n');
  assert.deepEqual((await a.engine.verify()).problems, []);
  const view = a.engine.view();
  const history = a.engine.history('big.md');
  assert.equal(await settled(view), false, 'the table is being changed: the view waits');
  assert.equal(await settled(history), false);

  release();
  assert.equal((await sync).pushed, 1);
  assert.equal((await view).st.remote.has('big.md'), true);
  assert.equal((await history).length, 1);
});

test('operations run in the order they were called, and one that fails does not hold up the next', async () => {
  const { a, b } = setup();
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  await b.sync();
  const order: string[] = [];
  a.fs.files.clear();
  const refused = a.sync().catch((e) => {
    order.push(e instanceof SafetyError ? 'refused' : 'other');
  });
  const seen = a.engine.view().then((v) => order.push(`view ${v.st.remote.size}`));
  const kept = a.engine.keepAllFiles().then((n) => order.push(`kept ${n}`));
  const after = a.sync().then((r) => order.push(`sync ${r.pulled}`));
  await Promise.all([refused, seen, kept, after]);
  assert.deepEqual(order, ['refused', 'view 30', 'kept 30', 'sync 30']);
});

test('a cleanup and a sync called together on one device both finish, and the vault stays whole', async () => {
  const { a, b, clock } = setup();
  for (let i = 0; i < 12; i++) {
    a.fs.put(`n${i % 4}.md`, `rev ${i}\n`);
    await a.sync();
    clock.now += 3_600_000;
  }
  await b.sync();
  clock.now += 3 * 86_400_000;
  a.fs.put('late.md', 'late\n');
  const [gc, r] = await Promise.all([a.engine.gc(), a.sync(), a.engine.history('n0.md')]);
  assert.ok(gc.packsDeleted + gc.packsCombined >= 0);
  assert.equal(r.pushed, 1);
  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.deepEqual((await b.engine.verify({ deep: true })).problems, []);
});
