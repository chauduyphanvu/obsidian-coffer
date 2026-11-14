import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utf8 } from '../src/core/bytes.ts';
import { deflate, inflate } from '../src/core/compress.ts';
import { fragmented, planCompaction } from '../src/core/compact.ts';
import { resolveConfig, type SyncConfig } from '../src/core/config.ts';
import { open, seal, unlockKeys, type KeyHeader } from '../src/core/crypto.ts';
import { Repo, seqKey } from '../src/core/repo.ts';
import { Forward, Reads } from '../src/core/retention.ts';
import { listCommits, listDeleted, tableAt, TooOldError } from '../src/core/timeline.ts';
import { sameContent, type ChunkRef, type Commit, type Entry, type RemoteStore } from '../src/core/types.ts';
import { cleanupDue } from '../src/plugin/settings.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Midnight UTC, so tests can place commits in hour and day buckets. */
const T0 = Date.UTC(2027, 0, 10);

function setup(names = ['A', 'B'], config: Partial<SyncConfig> = {}, store?: (net: SimStore) => RemoteStore) {
  const clock = { now: T0 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  const devices = names.map((n) => new Device(n, store ? store(net) : net, clock, config));
  return { clock, mem, net, devices };
}

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

/** A version's bytes, fetched chunk by chunk from the places it records. */
async function download(repo: Repo, e: Entry): Promise<Uint8Array> {
  const out = new Uint8Array(e.size);
  let pos = 0;
  for (const c of e.chunks) {
    const sealed = await repo.getPackRange(c.pack, c.off, c.off + c.len);
    if (!sealed) throw new Error(`Pack ${c.pack} is gone`);
    out.set(await repo.openChunk(c.id, sealed), pos);
    pos += c.size;
  }
  return out;
}
const text = async (repo: Repo, e: Entry) => new TextDecoder().decode(await download(repo, e));

const packKeys = (mem: MemoryStore) => [...mem.objects.keys()].filter((k) => k.startsWith('pack/'));

/**
 * The kept moments and the vault at each, worked out the slow obvious way from the whole log: a
 * moment is a user commit younger than a day, or the last one of its UTC hour while younger than a
 * week, or the last one of its UTC day; none older than the last day-ending commit at or before the
 * newest snapshot stored before the retention window. The vault at a moment is the one just before the
 * next user commit.
 */
async function oracle(repo: Repo, lastSeq: number, cfg: SyncConfig, now: number) {
  const log: Commit[] = [];
  for (let s = 1; s <= lastSeq; s++) log.push((await repo.readCommit(s))!);
  const users = log.filter((c) => !c.moved);
  const next = new Map(users.map((c, i) => [c.seq, users[i + 1]?.time]));
  const bucket = (t: number, size: number) => Math.floor(t / size);
  const endsDay = (c: Commit) => next.get(c.seq) === undefined || bucket(c.time, DAY) !== bucket(next.get(c.seq)!, DAY);
  const endsHour = (c: Commit) => next.get(c.seq) === undefined || bucket(c.time, HOUR) !== bucket(next.get(c.seq)!, HOUR);
  const tier = (c: Commit) => now - c.time < DAY || endsDay(c) || (now - c.time < 7 * DAY && endsHour(c));
  const floor = (await repo.snapshots()).filter((s) => s.modified <= now - cfg.retentionDays * DAY).pop();
  const first = floor ? users.filter((c) => c.seq <= floor.seq && endsDay(c)).pop() : undefined;
  const moments = users.filter((c) => c.seq >= (first?.seq ?? 0) && tier(c));
  const isMoment = new Set(moments.map((c) => c.seq));
  const tables = new Map<number, Map<string, Entry>>();
  const table = new Map<string, Entry>();
  let prev: Commit | undefined;
  for (const c of log) {
    if (!c.moved) {
      if (prev && isMoment.has(prev.seq)) tables.set(prev.seq, new Map(table));
      prev = c;
    }
    for (const { path, entry } of c.changes) {
      if (entry) table.set(path, entry);
      else table.delete(path);
    }
  }
  if (prev && isMoment.has(prev.seq)) tables.set(prev.seq, new Map(table));
  /** The versions of `path` current at some moment, or now, by the commit that wrote them, newest first. */
  const versions = (path: string) => {
    const writes = users.filter((c) => c.changes.some((ch) => ch.path === path));
    return writes
      .filter((w, i) => {
        const end = writes[i + 1]?.seq ?? Infinity;
        return end === Infinity || moments.some((m) => m.seq >= w.seq && m.seq < end);
      })
      .map((w) => w.seq)
      .reverse();
  };
  return { moments, tables, versions };
}

const sameFiles = (a: Map<string, Entry>, b: Map<string, Entry>) => a.size === b.size && [...a].every(([p, e]) => b.has(p) && sameContent(e, b.get(p)!));

/** Ten days of edits: a busy morning ten days back, a busy hour five days back, and a few minutes of today. */
async function tenDays(config: Partial<SyncConfig> = {}) {
  const env = setup(['A', 'B'], { packMaxBlobBytes: 4096, ...config });
  const { devices: [a], clock } = env;
  const at: number[] = [0];
  const edit = async (time: number, f: () => void) => {
    clock.now = time;
    f();
    at.push(time);
    await a.sync();
  };
  let rev = 0;
  const note = () => a.fs.put('n.md', `revision ${++rev}\n`);
  await edit(T0 + 9 * HOUR, () => {
    note();
    a.fs.put('other.md', 'other\n');
    a.fs.put('brief.md', 'here for a moment\n');
  }); // 1
  await edit(T0 + 9 * HOUR + 30 * MIN, note); // 2
  await edit(T0 + 13 * HOUR + 10 * MIN, () => a.fs.files.delete('brief.md')); // 3: its only version never ends a day
  await edit(T0 + 13 * HOUR + 50 * MIN, note); // 4
  await edit(T0 + 23 * HOUR, note); // 5: ends day 0
  const d5 = T0 + 5 * DAY;
  await edit(d5 + 10 * HOUR, note); // 6
  await edit(d5 + 10 * HOUR + 20 * MIN, () => a.fs.put('later.md', 'later\n')); // 7
  await edit(d5 + 10 * HOUR + 40 * MIN, note); // 8: ends hour 10
  await edit(d5 + 11 * HOUR + 15 * MIN, () => a.fs.files.delete('later.md')); // 9: ends hour 11 and day 5
  const today = T0 + 9 * DAY + 20 * HOUR;
  for (let i = 0; i < 3; i++) await edit(today + i * MIN, note); // 10-12
  clock.now = T0 + 10 * DAY;
  return { ...env, at };
}

test('thinning keeps every state of the last day, one an hour back to a week and one a day after', async () => {
  const { devices: [a, b], at } = await tenDays();
  const v = await a.engine.view();
  const { moments, tables, versions } = await oracle(v.repo, v.st.lastSeq, v.cfg, v.now);
  assert.deepEqual(moments.map((c) => c.seq), [5, 8, 9, 10, 11, 12]);

  const list = await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now);
  assert.deepEqual(list.map((c) => c.seq), [12, 11, 10, 9, 8, 5]);
  // Counted since the kept moment before: 8 covers 6 to 8, where later.md came and n.md changed.
  assert.deepEqual(list.map((c) => [c.seq, c.added, c.changed, c.deleted]), [[12, 0, 1, 0], [11, 0, 1, 0], [10, 0, 1, 0], [9, 0, 0, 1], [8, 1, 1, 0], [5, 2, 0, 0]]);

  // A time inside a thinned stretch resolves to the kept moment before it, and says so.
  for (let s = 1; s < at.length; s++) {
    for (const t of [at[s], at[s] + MIN]) {
      const want = moments.filter((m) => m.time <= t).pop();
      if (!want) {
        await assert.rejects(tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, t), (e) => e instanceof TooOldError && e.earliest.seq === 5);
        continue;
      }
      const got = await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, t);
      assert.equal(got.commit.seq, want.seq, `time of commit ${s}`);
      assert.ok(sameFiles(got.files, tables.get(want.seq)!));
      assert.equal(got.earliest.seq, 5);
    }
  }
  assert.deepEqual((await a.engine.history('n.md')).map((x) => x.seq), versions('n.md'));
  assert.deepEqual((await a.engine.history('n.md')).map((x) => x.seq), [12, 11, 10, 8, 5]);
  // brief.md never lived through a kept moment; later.md did, at 8.
  assert.deepEqual((await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now)).map((d) => [d.path, d.seq]), [['later.md', 9]]);

  // Another device, and cleanup, change none of the answers; everything offered can still be read.
  const answers = async (d: Device) => {
    const w = await d.engine.view();
    return JSON.stringify({
      commits: await listCommits(w.repo, w.st.lastSeq, w.cfg, w.now),
      versions: (await d.engine.history('n.md')).map((x) => [x.seq, x.entry?.chunks.map((c) => c.id)]),
      deleted: (await listDeleted(w.repo, w.st.lastSeq, w.cfg, w.now)).map((x) => x.path),
    });
  };
  await b.sync();
  const before = await answers(a);
  assert.equal(await answers(b), before);
  const r = await a.engine.gc();
  // n.md's thinned revisions from commits 2, 4 and 6; brief.md shares its pack with other.md, still current.
  assert.equal(r.packsDeleted, 3, JSON.stringify(r));
  assert.equal(await answers(a), before);
  assert.equal(await answers(b), before);
  for (const m of moments) for (const e of tables.get(m.seq)!.values()) await download(v.repo, e);
  for (const x of await a.engine.history('n.md')) await download(v.repo, x.entry!);
  for (const d of await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now)) assert.equal(await text(v.repo, d.entry), 'later\n');
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('device clocks that disagree, and commits in one millisecond, change what is kept but never offer what cleanup removed', async () => {
  const { devices: [a, b], clock } = setup(['A', 'B'], { packMaxBlobBytes: 4096, snapshotEvery: 4, retentionDays: 5 });
  const behind = { now: clock.now };
  b.clock = behind; // B's clock runs 50 minutes behind
  let rev = 0;
  const note = (d: Device) => () => d.fs.put('n.md', `revision ${++rev}\n`);
  const edit = async (d: Device, time: number, f = note(d)) => {
    clock.now = time;
    behind.now = time - 50 * MIN;
    await d.sync();
    f();
    await d.sync();
  };
  for (let day = 0; day < 10; day += 2) {
    const t = T0 + day * DAY + 23 * HOUR + 30 * MIN;
    await edit(a, t);
    await edit(b, t + 5 * MIN); // made later, stamped in the hour and day before
    await edit(b, t + 5 * MIN); // the same millisecond
    await edit(a, t + 20 * MIN, () => {
      note(a)();
      a.fs.put(`d${day}.md`, `brief ${day}\n`);
    });
    await edit(b, t + 2 * HOUR, () => b.fs.files.delete(`d${day}.md`));
  }
  for (const days of [11, 13, 16]) {
    clock.now = T0 + days * DAY;
    behind.now = clock.now - 50 * MIN;
    const v = await a.engine.view();
    const { moments } = await oracle(v.repo, v.st.lastSeq, v.cfg, v.now);
    const list = await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now);
    assert.deepEqual(list.map((c) => c.seq), moments.map((c) => c.seq).reverse(), `day ${days}`);
    const versions = await a.engine.history('n.md');
    const deleted = await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now);
    await a.engine.gc();
    for (const m of list) {
      for (const e of (await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, { seq: m.seq })).files.values()) await download(v.repo, e);
    }
    for (const x of versions) await download(v.repo, x.entry!);
    for (const d of deleted) assert.match(await text(v.repo, d.entry), /^brief/);
  }
});

/** Twenty days of a note edited once a day, on devices that keep versions for the given days, one store between them. */
async function daily(days: number[], store: (net: SimStore) => RemoteStore = (net) => net) {
  const clock = { now: T0 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  const devices = days.map((d, i) => new Device('ABC'[i], store(net), clock, { packMaxBlobBytes: 4096, snapshotEvery: 4, retentionDays: d }));
  const [a] = devices;
  for (let day = 0; day < 20; day++) {
    clock.now = T0 + day * DAY + 12 * HOUR;
    a.fs.put('n.md', `day ${day}\n`);
    if (day === 2) a.fs.put('brief.md', 'brief\n');
    if (day === 4) a.fs.files.delete('brief.md');
    if (day === 17) a.fs.put('late.md', 'late\n');
    if (day === 18) a.fs.files.delete('late.md');
    await a.sync();
  }
  for (const d of devices.slice(1)) await d.sync();
  clock.now = T0 + 20 * DAY;
  return { clock, mem, net, devices };
}

/** Every moment, version of n.md and deleted file the device offers, each read whole. */
async function offered(d: Device) {
  const v = await d.engine.view();
  const moments = (await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now)).map((c) => c.seq);
  for (const seq of moments) {
    for (const e of (await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, { seq })).files.values()) await download(v.repo, e);
  }
  const versions = (await d.engine.history('n.md')).map((x) => x.seq);
  for (const x of await d.engine.history('n.md')) await download(v.repo, x.entry!);
  const deleted = await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now);
  for (const x of deleted) await download(v.repo, x.entry);
  const earliest = (await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, v.now)).earliest.seq;
  return { moments, versions, deleted: deleted.map((x) => x.path), earliest };
}

test('devices that keep versions for different lengths of time offer only what cleanup on any of them has kept', async () => {
  const { clock, devices: [a, b] } = await daily([3, 30]);

  assert.equal((await offered(b)).moments.length, 20, 'before any cleanup, B offers its whole month');
  assert.ok((await a.engine.gc()).packsDeleted >= 10);
  const shortest = await offered(a);
  assert.deepEqual(shortest.moments, [20, 19, 18, 17, 16]);
  assert.deepEqual(await offered(b), shortest, 'B offers nothing cleanup on A removed');

  // Cleanup on B goes no further back than A's did, and takes nothing A or B offers.
  await b.engine.gc();
  assert.deepEqual(await offered(a), shortest);
  assert.deepEqual(await offered(b), shortest);

  // Days later B, by its own window, still offers what A's cleanup kept, and its own cleanup moves the record
  // neither back nor on; once A cleans up again, B follows it forward.
  for (let day = 20; day < 24; day++) {
    clock.now = T0 + day * DAY + 12 * HOUR;
    a.fs.put('n.md', `day ${day}\n`);
    await a.sync();
  }
  clock.now = T0 + 25 * DAY;
  await b.engine.gc();
  assert.equal((await offered(b)).earliest, shortest.earliest);
  assert.ok((await offered(a)).earliest > shortest.earliest, 'A offers less by its own window');
  await a.engine.gc();
  const later = await offered(a);
  assert.deepEqual(later.moments, [24, 23, 22, 21, 20]);
  assert.deepEqual(await offered(b), later);
  assert.deepEqual((await b.engine.verify({ deep: true })).problems, []);
});

/** Storage that runs `on` around each read and write. */
class Taps implements RemoteStore {
  inner: RemoteStore;
  on?: (when: 'before' | 'after', op: 'get' | 'put', key: string) => Promise<void>;
  constructor(inner: RemoteStore) {
    this.inner = inner;
  }
  private async tap<T>(key: string, op: 'get' | 'put', f: () => Promise<T>): Promise<T> {
    await this.on?.('before', op, key);
    const out = await f();
    await this.on?.('after', op, key);
    return out;
  }
  get(k: string, range?: { start: number; end: number }) {
    return this.tap(k, 'get', () => this.inner.get(k, range));
  }
  put(k: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    return this.tap(k, 'put', () => this.inner.put(k, data, opts));
  }
  delete(k: string) {
    return this.inner.delete(k);
  }
  list(prefix: string, startAfter?: string) {
    return this.inner.list(prefix, startAfter);
  }
}

test('two cleanups at once with different windows leave the record at the further one', async () => {
  const pruned = async (d: Device) => (await d.engine.view()).repo.prunedTo();
  const taps = (net: SimStore) => new Taps(net);
  // A keeps 3 days and cleans up to snapshot 16; B keeps 10 and would clean up to 8.

  // A's cleanup runs whole after B has read the record and worked out what to keep, before B writes it: B
  // reads it again first.
  {
    const { devices: [a, b] } = await daily([3, 10], taps);
    let once = true;
    (b.store as Taps).on = async (when, op, key) => {
      if (when === 'after' && key.startsWith('snap/') && once) {
        once = false;
        await a.engine.gc();
      }
    };
    await b.engine.gc();
    assert.equal(await pruned(b), 16);
    assert.deepEqual(await offered(b), await offered(a));
  }
  // B's write lands just after A's, before A deletes: A looks again once it has deleted.
  {
    const { devices: [a, b] } = await daily([3, 10], taps);
    let wrote!: () => void;
    let landed!: () => void;
    const aWrote = new Promise<void>((r) => (wrote = r));
    const bLanded = new Promise<void>((r) => (landed = r));
    let gcA: Promise<unknown> | undefined;
    (a.store as Taps).on = async (when, op, key) => {
      if (key === 'pruned' && when === 'after' && op === 'put' && wrote) {
        wrote();
        wrote = undefined!;
        await bLanded;
      }
    };
    (b.store as Taps).on = async (when, op, key) => {
      if (key !== 'pruned' || op !== 'put') return;
      if (when === 'before') {
        gcA = a.engine.gc();
        await aWrote;
      } else landed();
    };
    await b.engine.gc();
    await gcA;
    assert.equal(await pruned(b), 16);
    assert.deepEqual(await offered(b), await offered(a));
  }
});

test('the earliest moment is the last day-ending state at or before the floor snapshot, and only moves forward', async () => {
  const { devices: [a], clock } = setup(['A'], { snapshotEvery: 3, retentionDays: 2, packMaxBlobBytes: 4096 });
  // Every four hours for four days.
  for (let i = 0; i < 24; i++) {
    clock.now = T0 + i * 4 * HOUR;
    a.fs.put(`n${i % 5}.md`, `rev ${i}\n`);
    await a.sync();
  }
  let last = 0;
  for (let t = T0 + 3 * DAY; t <= T0 + 9 * DAY; t += 7 * HOUR) {
    clock.now = t;
    const v = await a.engine.view();
    const { moments, tables } = await oracle(v.repo, v.st.lastSeq, v.cfg, v.now);
    const list = await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now);
    assert.deepEqual(list.map((c) => c.seq), moments.map((c) => c.seq).reverse(), `at +${(t - T0) / HOUR}h`);
    const earliest = (await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, t)).earliest;
    assert.equal(earliest.seq, moments[0].seq);
    assert.ok(earliest.seq >= last, 'never moves back');
    last = earliest.seq;
    await a.engine.gc();
    for (const m of moments) for (const e of tables.get(m.seq)!.values()) await download(v.repo, e);
  }
  assert.ok(last > 12, `${last}`);
});

test('a picker pages back through the moments from a snapshot near the page, not from the newest commit', async () => {
  const { devices: [a], clock, net } = setup(['A'], { snapshotEvery: 10 });
  for (let i = 0; i < 120; i++) {
    clock.now = T0 + i * 3 * HOUR;
    a.fs.put(`n${i % 9}.md`, `rev ${i}\n`);
    await a.sync();
  }
  clock.now += HOUR;
  const v = await a.engine.view();
  const all = await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now);
  const pages = [];
  for (let before: number | undefined; ; ) {
    net.reset();
    const page = await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now, { limit: 8, before });
    if (!page.length) break;
    if (before !== undefined && page[0].time < T0 + 6 * DAY) assert.ok(net.stats.get + net.stats.list <= 8, `${net.stats.get} reads for an old page`);
    pages.push(...page);
    before = page.at(-1)!.time;
  }
  assert.deepEqual(pages, all);
});

test('a device back after a while cannot bring a thinned version\'s chunks back by reference', async () => {
  const { devices: [a, b], net, clock } = setup(['A', 'B'], { packMaxBlobBytes: 4096 });
  const v1 = random(100_000, 1);
  a.fs.put('f.bin', v1);
  await a.sync();
  await b.sync();
  // Edited in the middle four times within the hour: the first version is never the last of an hour.
  let cur = v1;
  for (let i = 0; i < 4; i++) {
    clock.now += 5 * MIN;
    cur = cur.slice();
    cur.set(random(2000, 10 + i), 50_000);
    a.fs.put('f.bin', cur);
    await a.sync();
  }
  clock.now += 3 * DAY;
  const r = await a.engine.gc();
  assert.ok(r.packsDeleted >= 1, JSON.stringify(r));

  // B, away all along, still lists v1 in its table. It edits its own copy (sharing the chunks cleanup
  // removed) and saves another copy of v1 under a new name.
  const mine = v1.slice();
  mine.set(random(10, 99), 0);
  b.fs.put('f.bin', mine);
  b.fs.put('copy.bin', v1);
  net.reset();
  const res = await b.sync();
  assert.equal(res.conflictCopies.length, 1);

  const c = new Device('C', net, clock, b.config);
  await c.sync();
  assert.deepEqual(c.fs.files.get('copy.bin')!.data, v1);
  assert.deepEqual(c.fs.files.get(res.conflictCopies[0])!.data, mine);
  assert.deepEqual(c.fs.files.get('f.bin')!.data, cur);
  assert.deepEqual((await c.engine.verify({ deep: true })).problems, []);
});

/** A vault that grew one note per commit, an hour apart: one small pack per note. */
async function grown(n: number, config: Partial<SyncConfig> = {}, store?: (net: SimStore) => RemoteStore) {
  const env = setup(['A', 'B'], { snapshotEvery: 10, ...config }, store);
  const { devices: [a, b], clock } = env;
  for (let i = 0; i < n; i++) {
    a.fs.put(`n${i}.md`, `# Note ${i}\n\n${'Some text that is the same in every note. '.repeat(3)}\n${i}\n`);
    await a.sync();
    clock.now += HOUR;
  }
  await b.sync();
  clock.now += 2 * DAY;
  return env;
}

/** What a device sees of history, by commit and content. */
async function seen(d: Device) {
  const v = await d.engine.view();
  return JSON.stringify({
    commits: await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now),
    versions: (await d.engine.history('n3.md')).map((x) => [x.seq, x.time, x.entry?.chunks.map((c) => c.id)]),
    deleted: await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now),
  }, (k, val) => (k === 'entry' ? val.chunks.map((c: { id: string }) => c.id) : val));
}

test('cleanup combines small packs; a new device then needs fewer requests, and no device sees a change', async () => {
  const { devices: [a, b], net, mem, clock } = await grown(40);
  const download = async () => {
    const d = new Device('N', net, clock, a.config);
    net.reset();
    await d.sync();
    assert.deepEqual(d.snapshot(), a.snapshot());
    return net.stats.get;
  };
  const before = await download();
  const history = await seen(a);
  const packs = packKeys(mem).length;

  const r = await a.engine.gc();
  assert.deepEqual([r.packsDeleted, r.packsCombined, r.packsWritten], [0, 40, 1], JSON.stringify(r));
  assert.ok(r.bytesMoved > 0 && r.bytesFreedLater >= r.bytesMoved, JSON.stringify(r));
  assert.equal(packKeys(mem).length, packs + 1, 'the old packs stay while older moments read them');
  const after = await download();
  // Forty pack reads become one; the move's commit is one more read.
  assert.equal(after, before - 38, `${before} requests before, ${after} after`);

  // Not a version, a moment or a count anywhere; other devices pull and push nothing.
  assert.equal(await seen(a), history);
  const rb = await b.sync();
  assert.deepEqual([rb.pushed, rb.pulled, rb.deletedLocal, rb.merged, rb.commits], [0, 0, 0, 0, 0]);
  assert.equal(await seen(b), history);
  const { st } = await b.engine.view();
  const moved = new Set([...st.remote.values()].map((e) => e.chunks[0].pack));
  assert.equal(moved.size, 1);
  assert.ok([...st.synced.values()].every((s) => moved.has(s.entry.chunks[0].pack)), 'merge bases moved too');
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);

  // Every moment still reads from the places it records.
  const v = await a.engine.view();
  for (const c of await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now)) {
    const past = await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, c.time);
    for (const e of past.files.values()) await text(v.repo, e);
  }

  // Nothing more worth doing: the next run writes nothing. It frees the pack of the note the newest
  // commit wrote: the vault at that moment is the vault just before the next user commit, so it reads
  // the moved copy, and no older moment had that note.
  net.reset();
  const again = await a.engine.gc();
  assert.deepEqual([again.packsDeleted, again.packsCombined, again.packsWritten], [1, 0, 0]);
  assert.equal(net.stats.put, 0);

  // Once every moment before the move has left the window, the old packs go, and nothing offered breaks.
  clock.now += 32 * DAY;
  const later = await a.engine.gc();
  assert.equal(later.packsDeleted, 39, JSON.stringify(later));
  assert.equal(again.bytesFreed + later.bytesFreed, r.bytesFreedLater);
  assert.equal(packKeys(mem).length, 1);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
  for (const x of await a.engine.history('n3.md')) await text(v.repo, x.entry!);
  assert.equal(await download(), after);
});

test('a run with nothing worth doing costs what cleanup without compaction costs', async () => {
  const { devices: [a, b], net, clock } = await grown(12);
  a.fs.put('big.md', 'x'.repeat(300_000)); // one pack near full size and all current
  await a.sync();
  clock.now += 2 * DAY;
  await a.engine.gc(); // combines the twelve small ones
  clock.now += 2 * DAY;
  const cost = async (d: Device) => {
    net.reset();
    await d.engine.gc();
    return { ...net.stats, up: 0, down: 0 };
  };
  const off = new Device('X', net, clock, { ...a.config, compactMaxBytes: 0 });
  await off.sync();
  await b.sync();
  await off.engine.gc();
  assert.deepEqual(await cost(b), await cost(off));
  assert.equal(net.stats.put, 0);
});

test('a pack mostly holding data no file uses is emptied on its own; one small pack alone is left be', async () => {
  const { devices: [a], clock } = setup(['A'], { packTargetBytes: 64 << 10 });
  a.fs.put('small.md', 'small\n');
  await a.sync();
  clock.now += 2 * DAY;
  assert.equal((await a.engine.gc()).packsCombined, 0, 'copying one small pack would only make another like it');

  for (let i = 0; i < 6; i++) a.fs.put(`n${i}.md`, random(9000, i + 1));
  await a.sync(); // one pack, about full
  for (let i = 1; i < 6; i++) a.fs.files.delete(`n${i}.md`);
  await a.sync(true);
  clock.now += 2 * DAY;
  const r = await a.engine.gc();
  assert.deepEqual([r.packsCombined, r.packsWritten], [2, 1], JSON.stringify(r));
  assert.ok(r.bytesFreedLater > 4 * r.bytesMoved, JSON.stringify(r));
  assert.equal((await a.engine.gc()).packsCombined, 0, 'converged');
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('large chunks stored alone and packs near full size and mostly current are not rewritten', async () => {
  const { devices: [a], clock } = setup(['A']);
  a.fs.put('photo.bin', random(200_000, 1)); // chunks stored alone
  await a.sync();
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, random(3000, 100 + i));
  await a.sync(); // about 90 KB in one pack: over a quarter of the target, all current
  clock.now += 2 * DAY;
  const r = await a.engine.gc();
  assert.deepEqual([r.packsCombined, r.bytesMoved], [0, 0]);
});

test('the bytes copied per run are capped, the most valuable packs first, and later runs finish the job', async () => {
  const { devices: [a], clock } = await grown(30, { compactMaxBytes: 1500 });
  const runs = [];
  for (let i = 0; i < 12; i++) {
    const r = await a.engine.gc();
    if (!r.packsCombined) break;
    assert.ok(r.bytesMoved <= 1500, JSON.stringify(r));
    runs.push(r.packsCombined);
    clock.now += 2 * DAY;
  }
  assert.ok(runs.length >= 3, JSON.stringify(runs));
  const v = await a.engine.view();
  assert.ok(new Set([...v.st.remote.values()].map((e) => e.chunks[0].pack)).size < 8);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

/** Storage that runs `before` ahead of the next commit write it is asked for, or fails it. */
class Hook implements RemoteStore {
  inner: RemoteStore;
  before?: () => Promise<void>;
  fail = false;
  constructor(inner: RemoteStore) {
    this.inner = inner;
  }
  get(k: string, range?: { start: number; end: number }) {
    return this.inner.get(k, range);
  }
  async put(k: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    if (k.startsWith('log/') && opts?.ifNoneMatch) {
      if (this.fail) throw new Error('injected: crash before the commit');
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

const longNote = (tag: string) => Array.from({ length: 1500 }, (_, i) => `line ${i} of a long note ${i % 7 ? '' : tag}\n`).join('');

test('a device with an unsynced edit to a moved file commits it as is, its unchanged chunks at their new place', async () => {
  const { devices: [a, b], mem, clock } = await grown(8);
  a.fs.put('long.md', longNote('v1')); // several chunks
  await a.sync();
  await b.sync();
  clock.now += 2 * DAY;
  await b.sync(); // B is current and its head check fresh, so its next small edit commits without looking first
  const old = new Set(packKeys(mem).map((k) => k.slice(5)));
  b.fs.put('long.md', `${b.fs.text('long.md')}one more line from B\n`);
  b.fs.put('n3.md', 'edited on B\n');
  const r = await a.engine.gc();
  assert.ok(r.packsCombined >= 9, JSON.stringify(r));

  const rb = await b.sync();
  assert.deepEqual([rb.pushed, rb.merged, rb.conflictCopies.length, rb.errors.length], [2, 0, 0, 0]);
  const { st } = await b.engine.view();
  assert.ok(st.remote.get('long.md')!.chunks.every((c) => !old.has(c.pack)), 'no reference to a place the data moved from');
  await a.sync();
  assert.equal(a.fs.text('n3.md'), 'edited on B\n');
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('an edit that wins the race against a move is kept, and the move looks again and leaves it alone', async () => {
  const hooks: Hook[] = [];
  const { devices: [a, b], net, clock } = await grown(8, {}, (n) => {
    const h = new Hook(n);
    hooks.push(h);
    return h;
  });
  a.fs.put('long.md', longNote('v1'));
  await a.sync();
  await b.sync();
  clock.now += 2 * DAY;
  b.fs.put('n3.md', 'edited on B\n');
  b.fs.put('long.md', `${b.fs.text('long.md')}one more line from B\n`); // shares its other chunks with the moved version
  hooks[0].before = async () => {
    await b.sync();
  };
  const r = await a.engine.gc();
  assert.ok(r.packsCombined >= 1, JSON.stringify(r));

  const { repo, st } = await a.engine.view();
  const move = (await repo.readCommit(st.lastSeq))!;
  assert.equal(move.moved, true);
  const edit = (await repo.readCommit(st.lastSeq - 1))!;
  assert.deepEqual(edit.changes.map((c) => c.path).sort(), ['long.md', 'n3.md']);
  // The move was worked out again against B's commit: n3.md's new content is not touched, and long.md
  // keeps B's content with the chunks it shares with the old version at their new place.
  assert.ok(!move.changes.some((c) => c.path === 'n3.md'));
  const long = move.changes.find((c) => c.path === 'long.md')!.entry!;
  assert.ok(sameContent(long, edit.changes.find((c) => c.path === 'long.md')!.entry!));
  await a.sync();
  await b.sync();
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.fs.text('n3.md'), 'edited on B\n');
  const c = new Device('C', net, clock, a.config);
  await c.sync();
  assert.deepEqual(c.snapshot(), a.snapshot());
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('two devices compacting at once: one move commits, the other\'s copies are orphans cleanup removes', async () => {
  const { devices: [a, b], mem, clock } = await grown(10);
  const [ra, rb] = await Promise.all([a.engine.gc(), b.engine.gc()]);
  assert.equal(Math.min(ra.packsCombined, rb.packsCombined), 0, `${JSON.stringify(ra)} ${JSON.stringify(rb)}`);
  assert.equal(Math.max(ra.packsCombined, rb.packsCombined), 10);
  const packs = packKeys(mem).length;
  assert.equal(packs, 10 + 2, 'both copied');
  await a.sync();
  await b.sync();
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
  clock.now += 2 * DAY;
  assert.ok((await a.engine.gc()).packsDeleted >= 1, 'the orphan copy goes after the grace day');
  assert.deepEqual((await b.engine.verify({ deep: true })).problems, []);
});

test('a crash between copying and committing leaves only orphan packs, which a later cleanup removes', async () => {
  let hook!: Hook;
  const { devices: [a, b], mem, net, clock } = await grown(10, {}, (n) => (hook ??= new Hook(n)));
  hook.fail = true;
  await assert.rejects(a.engine.gc(), /injected/);
  hook.fail = false;
  assert.equal(packKeys(mem).length, 11);
  a.restart();
  await b.sync();
  assert.deepEqual((await b.engine.verify({ deep: true })).problems, []);
  clock.now += 2 * DAY;
  const r = await a.engine.gc();
  assert.deepEqual([r.packsDeleted, r.packsCombined], [1, 10], JSON.stringify(r));
  const c = new Device('C', net, clock, a.config);
  await c.sync();
  assert.deepEqual(c.snapshot(), a.snapshot());
  assert.deepEqual((await c.engine.verify({ deep: true })).problems, []);
});

test('a device away across a move and the removal of the old packs still merges with its base', async () => {
  const { devices: [a, b], mem, clock } = setup(['A', 'B'], { snapshotEvery: 4 });
  const base = '# Plan\n\nfirst\n\nsecond\n\nthird\n';
  a.fs.put('n.md', base);
  await a.sync(); // 1
  a.fs.put('other.md', 'other\n');
  await a.sync(); // 2
  await b.sync();
  b.fs.put('n.md', base.replace('first', 'FIRST from B')); // B's edit, not synced: B is away from here on
  clock.now += 2 * DAY;
  const r = await a.engine.gc(); // 3: moves both notes into one pack
  assert.equal(r.packsCombined, 2, JSON.stringify(r));
  a.fs.put('n.md', base.replace('third', 'THIRD from A'));
  await a.sync(); // 4, a snapshot
  clock.now += 32 * DAY;
  const late = await a.engine.gc();
  assert.equal(late.packsDeleted, 2, 'the places the move copied from are gone');
  const saved = JSON.parse(b.state.data!) as { p: string[] };
  assert.ok(saved.p.every((pack) => !mem.objects.has(`pack/${pack}`)), 'including the one B\'s base was read from');

  const rb = await b.sync();
  assert.deepEqual([rb.merged, rb.conflictCopies.length, rb.pulled, rb.errors.length], [1, 0, 0, 0], JSON.stringify(rb));
  await a.sync();
  assert.equal(a.fs.text('n.md'), base.replace('first', 'FIRST from B').replace('third', 'THIRD from A'));
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

/** Rewrites history index `seq` as a version from before moves wrote it: each commit re-encoded with only the fields it knew. */
async function oldIndex(mem: MemoryStore, seq: number): Promise<void> {
  const header = JSON.parse(new TextDecoder().decode(mem.objects.get('vault.json')!.data)) as { id: string; kdf: KeyHeader };
  const keys = await unlockKeys(header.kdf, 'test passphrase');
  const key = seqKey('idx', seq);
  const aad = `${header.id}:${key}`;
  const { plain } = await open(keys, mem.objects.get(key)!.data, aad);
  const commits = JSON.parse(new TextDecoder().decode(await inflate(plain, Infinity))) as { d: unknown; t: unknown; p: unknown; c: unknown }[];
  const old = commits.map(({ d, t, p, c }) => ({ d, t, p, c }));
  mem.objects.get(key)!.data = await seal(keys, await deflate(utf8.encode(JSON.stringify(old))), aad);
}

test('a history index written by a version that drops the move flag does not turn the move into a moment, a version or activity', async () => {
  const { devices: [a, b], mem, clock } = await grown(8);
  assert.equal((await a.engine.gc()).packsCombined, 8); // 9: a move
  clock.now += HOUR;
  a.fs.put('n3.md', 'edited\n');
  await a.sync(); // 10: a snapshot, and the index of 1-10
  await b.sync();
  const before = await seen(a);
  const { repo } = await a.engine.view();
  assert.equal((await repo.readDigest(10, 10))?.[8].moved, true, 'this version keeps the flag in the index');

  await oldIndex(mem, 10);
  assert.equal(await seen(a), before);
  assert.equal(await seen(b), before);
  clock.now += 3 * DAY;
  const r = await a.engine.gc();
  assert.equal(r.packsDeleted, 1, 'n7.md\'s first place: moment 8 reads the copy, the move being part of it, not a moment of its own');
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('a history index an older version wrote is written again by the first reader that has all its commits', async () => {
  const { devices: [a, b], mem, net } = await grown(8);
  assert.equal((await a.engine.gc()).packsCombined, 8); // 9: a move
  a.fs.put('n3.md', 'edited\n');
  await a.sync(); // 10: a snapshot, and the index of 1-10
  await b.sync();
  const before = await seen(a);
  const { repo } = await a.engine.view();
  const read = async (r: Repo) => {
    net.reset();
    const walk = new Forward(new Reads(r, a.config), 1, 10);
    const moved: number[] = [];
    for (let c: Commit | undefined; (c = await walk.next()); ) if (c.moved) moved.push(c.seq);
    return { gets: net.stats.get, puts: net.stats.put, moved };
  };

  await oldIndex(mem, 10);
  assert.deepEqual(await read(repo), { gets: 11, puts: 1, moved: [9] }, 'the index, each commit, and the index written again');
  assert.deepEqual(await read(repo), { gets: 1, puts: 0, moved: [9] });
  assert.equal((await repo.readDigest(10, 10))?.[8].moved, true);

  // A version from before the flags writing it again only starts the cycle over.
  await oldIndex(mem, 10);
  assert.equal(await seen(b), before);
  assert.equal((await read(repo)).gets, 1, 'mended by the history B read');

  // A reader that cannot write still reads.
  await oldIndex(mem, 10);
  const refusing: RemoteStore = {
    get: (k, range) => net.get(k, range),
    put: async (k, data, opts) => (k.startsWith('idx/') ? Promise.reject(new Error('injected: no writing')) : net.put(k, data, opts)),
    delete: (k) => net.delete(k),
    list: (prefix, after) => net.list(prefix, after),
  };
  const readOnly = await Repo.open(refusing, 'test passphrase', { kdfIterations: a.config.kdfIterations, chunk: a.config.chunk });
  assert.deepEqual((await read(readOnly)).moved, [9]);
  assert.equal(await repo.readDigest(10, 10), null);
});

test('verify passes after compaction and names a move that points at missing data', async () => {
  const { devices: [a], mem } = await grown(6);
  await a.engine.gc();
  assert.deepEqual((await a.engine.verify()).problems, []);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
  const { st } = await a.engine.view();
  const pack = st.remote.get('n0.md')!.chunks[0].pack;
  mem.objects.delete(`pack/${pack}`);
  const [p] = (await a.engine.verify()).problems;
  assert.equal(p.object, `pack/${pack}`);
  assert.match(p.message, /is missing, though commit 7 moved data there/);
  assert.deepEqual(p.paths, Array.from({ length: 6 }, (_, i) => `n${i}.md`));
});

test('verify reports a commit marked as a move that changes content', async () => {
  const { devices: [a] } = await grown(2);
  const { repo, st } = await a.engine.view();
  const other = st.remote.get('n1.md')!;
  await repo.writeCommit({ seq: st.lastSeq + 1, device: 'X', time: 0, changes: [{ path: 'n0.md', entry: other }], prev: st.head, moved: true });
  const problems = (await a.engine.verify()).problems;
  assert.deepEqual(problems.map((p) => [p.object, p.paths]), [[`log/${String(st.lastSeq + 1).padStart(12, '0')}`, ['n0.md']]]);
  assert.match(problems[0].message, /marked as only moving data but changes/);
});

test('a move is not activity: it neither ends an hour\'s run of commits nor becomes a moment', async () => {
  const { devices: [a], clock } = setup(['A'], { packMaxBlobBytes: 4096 });
  clock.now = T0 - DAY - 2 * HOUR;
  a.fs.put('a.md', 'a\n');
  await a.sync(); // 1
  a.fs.put('b.md', 'b\n');
  await a.sync(); // 2
  clock.now = T0 + 10 * HOUR + 10 * MIN;
  a.fs.put('c.md', 'c1\n');
  await a.sync(); // 3: the last user commit of hour 10
  clock.now = T0 + 10 * HOUR + 30 * MIN;
  assert.equal((await a.engine.gc()).packsCombined, 2); // 4, a move in the same hour
  clock.now = T0 + 11 * HOUR + 20 * MIN;
  a.fs.put('c.md', 'c2\n');
  await a.sync(); // 5
  clock.now = T0 + 3 * DAY;
  await a.engine.gc();
  const v = await a.engine.view();
  assert.deepEqual((await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now)).map((c) => c.seq), [5, 3, 2]);
  const versions = await a.engine.history('c.md');
  assert.deepEqual(versions.map((x) => x.seq), [5, 3]);
  assert.equal(await text(v.repo, versions[1].entry!), 'c1\n');
});

test('after storage is restored from an older backup, accepting it treats every difference as changed on both sides', async () => {
  const { devices: [a, b], mem, net, clock } = setup(['A', 'B']);
  a.fs.put('same.md', 'same\n');
  a.fs.put('edited.md', 'one\n');
  a.fs.put('gone.md', 'gone\n');
  a.fs.put('pic.bin', random(50_000, 1));
  a.fs.put('.obsidian/app.json', JSON.stringify({ theme: 'dark' }));
  await a.sync();
  await b.sync();
  const backup = new Map([...mem.objects].map(([k, o]) => [k, { data: o.data.slice(), modified: o.modified }]));

  clock.now += HOUR;
  b.fs.put('edited.md', 'one\ntwo\n');
  b.fs.put('new.md', 'new\n');
  b.fs.files.delete('gone.md');
  b.fs.put('.obsidian/app.json', JSON.stringify({ theme: 'dark', vim: true }));
  await b.sync();
  a.fs.put('from-a.md', 'from A\n');
  await a.sync();

  mem.objects = backup; // the bucket restored from the backup
  b.restart();
  await assert.rejects(b.sync(), /the newest this device has seen, is missing/);
  await assert.rejects(b.sync(), /is missing/, 'refused until accepted');
  await b.engine.acceptStorage();
  net.reset();
  const r = await b.sync();
  assert.equal(r.conflictCopies.length, 1);
  assert.equal(b.fs.text('edited.md'), 'one\n', 'storage\'s version under the name');
  assert.equal(b.fs.text(r.conflictCopies[0]), 'one\ntwo\n', 'this device\'s beside it');
  assert.equal(b.fs.text('gone.md'), 'gone\n', 'deleted here after the backup: comes back rather than being deleted from storage');
  assert.equal(b.fs.text('new.md'), 'new\n');
  assert.deepEqual(JSON.parse(b.fs.text('.obsidian/app.json')!), { theme: 'dark', vim: true });
  assert.equal(r.deletedLocal + r.deletedRemote, 0);
  assert.ok(net.stats.down < 5000, `identical files are matched up, not downloaded: ${net.stats.down} bytes`);

  a.restart();
  await assert.rejects(a.sync(), /is missing/);
  await a.engine.acceptStorage();
  await a.sync();
  await b.sync();
  await a.sync();
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.fs.text('from-a.md'), 'from A\n');
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

const chunk = (pack: string, off: number, len: number): ChunkRef => ({ id: `${pack}:${off}`, pack, off, len, size: len });
/** One file per pack, each holding the chunks `chunks(i)` says. */
const packsOf = (n: number, chunks: (i: number) => ChunkRef[]) =>
  new Map<string, Entry>(Array.from({ length: n }, (_, i): [string, Entry] => [`n${i}.md`, { size: 1, mtime: 0, chunks: chunks(i) }]));

test('storage is fragmented at 32 small packs of one size class, counted from the file table alone', () => {
  const cfg = resolveConfig({});
  const quarter = cfg.packTargetBytes / 4;
  const small = (n: number) => packsOf(n, (i) => [chunk(`p${i}`, 100, 300)]);
  assert.equal(fragmented(small(31), cfg), false);
  assert.equal(fragmented(small(32), cfg), true);
  assert.equal(fragmented(new Map(), cfg), false);

  // Only the furthest end of a pack counts, and a pack counts once however many files keep data in it.
  const shared = new Map([...small(31), ['more.md', { size: 1, mtime: 0, chunks: [chunk('p0', 400, 300), chunk('p1', 100, 300)] }] as [string, Entry]]);
  assert.equal(fragmented(shared, cfg), false, '31 packs');
  assert.equal(fragmented(new Map([...small(31), ['another.md', { size: 1, mtime: 0, chunks: [chunk('p31', 0, 10)] }] as [string, Entry]]), cfg), true);

  // Packs a quarter of the target or more are not small, and neither is one with a chunk stored alone.
  assert.equal(fragmented(packsOf(40, (i) => [chunk(`p${i}`, quarter - 1000, 1000)]), cfg), false, 'ends at a quarter of the target');
  assert.equal(fragmented(packsOf(32, (i) => [chunk(`p${i}`, quarter - 1001, 1000)]), cfg), true, 'ends just short of it');
  assert.equal(fragmented(packsOf(40, (i) => [chunk(`p${i}`, 0, cfg.packMaxBlobBytes)]), cfg), false, 'a chunk stored alone');
  assert.equal(fragmented(packsOf(40, (i) => [chunk(`p${i}`, 0, 200), chunk(`p${i}`, 200, cfg.packMaxBlobBytes)]), cfg), false, 'with small ones beside it');
  const mixed = new Map([...small(31), ...packsOf(40, (i) => [chunk(`q${i}`, quarter, 100)])].map(([k, v], i): [string, Entry] => [`${k}${i}`, v]));
  assert.equal(fragmented(mixed, cfg), false, 'big packs are no help');

  // The classes are counted apart: packs one cleanup combined are crowded only by packs of their own size.
  const combined = (n: number, tag: string) => packsOf(n, (i) => [chunk(`${tag}${i}`, 20_000, 300)]);
  const both = (a: Map<string, Entry>, b: Map<string, Entry>) => new Map([...a, ...b].map(([k, v], i): [string, Entry] => [`${k}.${i}`, v]));
  assert.equal(fragmented(both(small(31), combined(31, 'c')), cfg), false, '62 packs in two classes');
  assert.equal(fragmented(combined(31, 'c'), cfg), false);
  assert.equal(fragmented(combined(32, 'c'), cfg), true, 'they pile up in turn');
});

test('a cleanup that fragmentation asks for combines the crowded size classes only, so a pack it wrote before is not copied again', () => {
  const cfg = resolveConfig({});
  const now = T0 + 10 * DAY;
  const plan = (table: Map<string, Entry>, sizes: Record<string, number> = {}) => {
    const size = new Map<string, number>();
    for (const e of table.values()) for (const c of e.chunks) size.set(c.pack, Math.max(size.get(c.pack) ?? 0, c.off + c.len));
    return planCompaction([...size].map(([id, n]) => ({ id, size: sizes[id] ?? n, modified: T0 })), table, cfg, now);
  };
  const fresh = (n: number) => packsOf(n, (i) => [chunk(`f${i}`, 0, 500)]);
  const written = (n: number) => new Map(Array.from({ length: n }, (_, i): [string, Entry] => [`w${i}.md`, { size: 1, mtime: 0, chunks: [chunk(`w${i}`, 0, 20_000)] }]));
  const packIds = (table: Map<string, Entry>) => [...table.values()].map((e) => e.chunks[0].pack).sort();

  // 32 fresh packs crowd their class: the 20 KB pack an earlier cleanup wrote stays where it is.
  const crowded = plan(new Map([...fresh(32), ...written(1)]))!;
  assert.deepEqual(crowded.packs.map((p) => p.id).sort(), packIds(fresh(32)));

  // Not crowded, nothing is left out that cleanup combined before.
  const calm = plan(new Map([...fresh(31), ...written(1)]))!;
  assert.equal(calm.packs.length, 32);
  assert.ok(calm.packs.some((p) => p.id === 'w0'));

  // A big pack mostly holding data no file uses is emptied all the same, as the calendar's cleanup would.
  const wasteful = new Map([['old.md', { size: 1, mtime: 0, chunks: [chunk('old', 3_900_000, 50_000)] }] as [string, Entry]]);
  const empties = plan(new Map([...fresh(32), ...wasteful]), { old: 4_000_000 })!;
  assert.deepEqual(empties.packs.map((p) => p.id).sort(), ['old', ...packIds(fresh(32))].sort());

  // Written packs crowd their own class in turn, and the fresh ones wait for their own.
  const turn = plan(new Map([...fresh(5), ...written(32)]))!;
  assert.deepEqual(turn.packs.map((p) => p.id).sort(), packIds(written(32)));
});

test('an early cleanup copies what it wrote last time no more, and a cleanup of storage that is not fragmented still combines it', async () => {
  const { devices: [a], clock } = setup(['A']);
  const add = async (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      a.fs.put(`n${i}.bin`, random(700, i + 1)); // 28 KB in all, over what an early cleanup would combine again
      await a.sync();
      clock.now += HOUR;
    }
    clock.now += 2 * DAY;
  };
  const packOf = async (path: string) => (await a.engine.view()).st.remote.get(path)!.chunks[0].pack;

  await add(0, 40);
  assert.equal(await a.engine.compactionDue(), true);
  assert.equal((await a.engine.gc()).packsCombined, 40);
  const written = await packOf('n0.bin');

  await add(40, 80);
  assert.equal(await a.engine.compactionDue(), true);
  const second = await a.engine.gc();
  assert.equal(second.packsCombined, 40, 'only the new ones');
  assert.ok(second.bytesMoved < 40 * 800, `${second.bytesMoved} bytes`);
  assert.equal(await packOf('n0.bin'), written);
  assert.notEqual(await packOf('n79.bin'), written);

  await add(80, 83);
  assert.equal(await a.engine.compactionDue(), false);
  assert.equal((await a.engine.gc()).packsCombined, 5, 'the two written ones and the three new');
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});

test('cleanup asked for by fragmentation runs within days, at most once a day and only after a commit, and a new device then needs far fewer requests', async () => {
  const grow = async (early: boolean) => {
    const { devices: [a], clock, net, mem } = setup(['A']);
    const start = clock.now;
    let last = start;
    const cleanups: number[] = [];
    // Whether the plugin runs cleanup after a sync that made `commits` commits.
    const due = async (commits: number) => cleanupDue({ autoCleanDays: 7, lastCleanup: last }, clock.now, early && commits > 0 && (await a.engine.compactionDue()));
    const sync = async () => {
      const r = await a.sync();
      if (await due(r.commits)) {
        await a.engine.gc();
        last = clock.now;
        cleanups.push(clock.now - start);
      }
      return r;
    };
    for (let i = 0; i < 300; i++) {
      a.fs.put(`n${i}.md`, `# Note ${i}\n\n${'Some text that is the same in every note. '.repeat(3)}\n${i}\n`);
      await sync();
      clock.now += HOUR;
    }
    const joiner = new Device('N', net, clock, a.config);
    net.reset();
    await joiner.sync();
    assert.deepEqual(joiner.snapshot(), a.snapshot());
    const stored = [...mem.objects.values()].reduce((n, o) => n + o.data.length, 0);
    return { a, clock, due, cleanups, requests: net.stats.get + net.stats.list, stored, last: () => last };
  };

  const weekly = await grow(false);
  assert.ok(weekly.cleanups[0] > 7 * DAY, 'only the calendar');
  const early = await grow(true);
  assert.ok(early.cleanups.length >= 4 && early.cleanups[0] < 7 * DAY, JSON.stringify(early.cleanups));
  early.cleanups.slice(1).forEach((t, i) => assert.ok(t - early.cleanups[i] > DAY, `twice within a day: ${early.cleanups}`));
  assert.ok(early.requests * 2 < weekly.requests, `${early.requests} requests for a new device, against ${weekly.requests} with the weekly cleanup alone`);
  assert.ok(early.stored < 2 * weekly.stored, `${early.stored} bytes stored, against ${weekly.stored} with the weekly cleanup alone`);

  // Fragmented again and a day since the last cleanup: a sync that sends nothing does not ask, one that sends something does.
  const { a, clock, due } = early;
  for (let i = 0; i < 40; i++) {
    a.fs.put(`later${i}.md`, `later ${i}\n`);
    await a.sync();
  }
  clock.now += 2 * DAY;
  assert.equal(await a.engine.compactionDue(), true);
  const idle = await a.sync();
  assert.equal(idle.commits, 0);
  assert.equal(await due(idle.commits), false);
  a.fs.put('one more.md', 'one more\n');
  assert.equal(await due((await a.sync()).commits), true);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
});
