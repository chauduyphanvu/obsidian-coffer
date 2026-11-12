import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncConfig } from '../src/core/config.ts';
import { Repo } from '../src/core/repo.ts';
import { LocalState } from '../src/core/state.ts';
import { listCommits, listDeleted, planRestore, tableAt, TooOldError } from '../src/core/timeline.ts';
import { sameContent, type Entry } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { Device, TEST_CONFIG } from './helpers.ts';

const DAY = 86_400_000;

function setup(config: Partial<SyncConfig> = {}, names = ['A']) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  return { clock, mem, net, devices: names.map((n) => new Device(n, net, clock, config)) };
}

/** What the engine hands over for history, read from the device's saved state without its engine. */
async function view(d: Device) {
  const repo = await Repo.open(d.store, 'test passphrase', { kdfIterations: TEST_CONFIG.kdfIterations!, chunk: TEST_CONFIG.chunk! });
  const st = LocalState.parse(await d.state.load());
  return { repo, remote: st.remote, lastSeq: st.lastSeq, cfg: d.config, now: d.clock.now };
}
type View = Awaited<ReturnType<typeof view>>;

const at = (v: View, time: number) => tableAt(v.repo, v.remote, v.lastSeq, v.cfg, v.now, time);
const deleted = (v: View, folder?: string) => listDeleted(v.repo, v.lastSeq, v.cfg, v.now, folder);
const commits = (v: View, opts?: { limit?: number; since?: number }) => listCommits(v.repo, v.lastSeq, v.cfg, v.now, opts);
const tooOld = (seq: number) => (e: unknown) => e instanceof TooOldError && e.earliest.seq === seq;

/** The vault right after commit `seq`, the slow obvious way. */
async function replay(repo: Repo, seq: number): Promise<Map<string, Entry>> {
  const st = new LocalState();
  for (let i = 1; i <= seq; i++) st.apply((await repo.readCommit(i))!);
  return st.remote;
}

/** A version's bytes, fetched chunk by chunk from its packs. */
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

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

test('the vault before, between, exactly at and after commits', async () => {
  const { devices: [a], clock } = setup();
  const times: number[] = [];
  for (const [path, body] of [['a.md', 'one\n'], ['b.md', 'two\n'], ['a.md', 'three\n']]) {
    a.fs.put(path, body);
    times.push(clock.now);
    await a.sync();
    clock.now += 60_000;
  }
  const v = await view(a);
  assert.equal(v.lastSeq, 3);

  const between = await at(v, times[1] + 30_000);
  assert.equal(between.commit.seq, 2);
  assert.deepEqual(between.files, await replay(v.repo, 2));
  assert.equal((await at(v, times[1])).commit.seq, 2, 'a moment exactly at a commit includes it');
  assert.equal((await at(v, times[1] - 1)).commit.seq, 1);

  const now = await at(v, v.now);
  assert.deepEqual(now.commit, { seq: 3, time: times[2], device: 'A' });
  assert.deepEqual(now.files, v.remote);
  assert.deepEqual(now.earliest, { seq: 1, time: times[0], device: 'A' });

  await assert.rejects(at(v, times[0] - 1), tooOld(1), 'nothing existed before the first commit');
});

test('every moment matches a replay of the log, across snapshot intervals, with and without digests', async () => {
  const { devices: [a], clock, mem } = setup({ snapshotEvery: 5 });
  const r = rng(11);
  const paths = ['n/a.md', 'n/b.md', 'n/sub/c.md', 'o/d.md', 'o/e.md', 'f.md'];
  const times = [0];
  for (let i = 1; i <= 33; i++) {
    const path = paths[Math.floor(r() * paths.length)];
    if (a.fs.files.has(path) && r() < 0.35) a.fs.files.delete(path);
    else a.fs.put(path, `${path} rev ${i}\n`);
    times.push(clock.now);
    await a.sync();
    clock.now += 60_000;
  }
  const v = await view(a);
  assert.equal(v.lastSeq, 33);
  const tables = [new Map<string, Entry>()];
  for (let s = 1; s <= 33; s++) tables.push(await replay(v.repo, s));

  const check = async () => {
    for (let s = 1; s <= 33; s++) {
      for (const t of [times[s], times[s] + 30_000]) {
        const p = await at(v, t);
        assert.equal(p.commit.seq, s);
        assert.deepEqual(p.files, tables[s], `the vault at commit ${s}`);
      }
    }
    const list = await commits(v);
    assert.deepEqual(list.map((c) => c.seq), Array.from({ length: 33 }, (_, i) => 33 - i));
    for (const s of list) {
      const { changes } = (await v.repo.readCommit(s.seq))!;
      const before = tables[s.seq - 1];
      assert.deepEqual(
        { added: s.added, changed: s.changed, deleted: s.deleted },
        {
          added: changes.filter((ch) => ch.entry && !before.has(ch.path)).length,
          changed: changes.filter((ch) => ch.entry && before.has(ch.path)).length,
          deleted: changes.filter((ch) => !ch.entry).length,
        },
        `commit ${s.seq}`,
      );
    }
  };
  await check();
  assert.deepEqual((await commits(v, { limit: 2 })).map((c) => c.seq), [33, 32]);
  assert.deepEqual((await commits(v, { since: times[30] })).map((c) => c.seq), [33, 32, 31, 30]);

  for (const key of [...mem.objects.keys()]) if (key.startsWith('idx/')) mem.objects.delete(key);
  await check();
});

test('an old moment, a recent one, the newest commits and the window each cost a handful of requests, not the log', async () => {
  const { devices: [a], clock, net } = setup({ snapshotEvery: 10, retentionDays: 2 });
  const HOUR = 3_600_000;
  const times = [0];
  for (let i = 1; i <= 95; i++) {
    if (i === 60) a.fs.files.delete('gone.md');
    else a.fs.put(i === 2 ? 'gone.md' : i === 93 ? 'new.md' : `n${i % 7}.md`, `rev ${i}\n`);
    times.push(clock.now);
    await a.sync();
    clock.now += HOUR;
  }
  // The window starts at hour 47, so snapshot 40 (hour 39) is the newest one older than it.
  const v = await view(a);
  const cost = async (f: () => Promise<unknown>) => {
    net.reset();
    await f();
    return net.stats.get + net.stats.list;
  };
  // The earliest moment is the last commit up to the floor snapshot (40) that ends its day, which takes
  // commit 41 to tell. The snapshot listing, the digests of 31-40 and 41-50 (read once, for the earliest
  // moment and the replay alike), and snapshot 40.
  assert.equal(await cost(() => at(v, times[45] + 1)), 4);
  // The listing, the digests of 31-40 and 41-50 for the earliest moment, commits 91-95 in one batch, and snapshot 90 to show new.md did not exist yet.
  assert.equal(await cost(() => at(v, times[92] + 1)), 9);
  assert.equal((await at(v, times[92] + 1)).files.has('new.md'), false);
  assert.equal(await cost(() => commits(v, { limit: 3 })), 7);
  // The listing, commits 91-95, the digests of 31-90 (commit 40 itself shows it ends its day), and snapshot 40 for gone.md's last version.
  assert.equal(await cost(() => deleted(v)), 13);
  assert.deepEqual((await deleted(v)).map((d) => [d.path, d.seq]), [['gone.md', 60]]);
  // The listing, commits 91-95, the digests of 31-90, and snapshot 30 to show new.md did not exist before 93.
  assert.equal(await cost(() => commits(v)), 13);
  assert.equal((await commits(v)).at(-1)!.seq, 40);
});

test('after cleanup the earliest moment moves forward, older ones are refused, and everything offered can be read', async () => {
  const { devices: [a], clock, net } = setup({ snapshotEvery: 2, retentionDays: 7, packMaxBlobBytes: 4096 });
  const times = [0];
  const commit = async (edit: () => void) => {
    edit();
    times.push(clock.now);
    await a.sync();
    clock.now += DAY;
  };
  await commit(() => {
    a.fs.put('keep.md', 'keep\n');
    a.fs.put('old.bin', random(300_000, 1));
    a.fs.put('drop.bin', random(300_000, 3));
    a.fs.put('notes/gone.md', 'gone\n');
    a.fs.put('notes/old.md', 'old\n');
  });
  await commit(() => a.fs.put('old.bin', random(300_000, 2))); // 2, snapshot
  await commit(() => a.fs.files.delete('notes/gone.md')); // 3
  await commit(() => {
    a.fs.files.delete('drop.bin');
    a.fs.put('later.md', 'later\n');
  }); // 4, snapshot
  await commit(() => a.fs.files.delete('notes/old.md')); // 5

  let v = await view(a);
  assert.deepEqual((await at(v, times[1])).earliest.seq, 1);
  assert.deepEqual((await deleted(v)).map((d) => [d.path, d.seq]), [['notes/old.md', 5], ['drop.bin', 4], ['notes/gone.md', 3]]);

  // The window now starts on day 13: snapshots 2 and 4 are both older, and 4 is the one cleanup keeps.
  clock.now += 15 * DAY;
  v = await view(a);
  assert.equal((await at(v, times[5])).earliest.seq, 4, 'the earliest moment does not wait for cleanup to run');
  await a.engine.gc();
  v = await view(a);
  const first = await at(v, times[4]);
  assert.deepEqual(first.earliest, { seq: 4, time: times[4], device: 'A' });
  assert.equal(first.commit.seq, 4);
  await assert.rejects(at(v, times[4] - 1), tooOld(4));
  net.reset();
  await assert.rejects(at(v, times[1]), tooOld(4));
  assert.equal(net.stats.get + net.stats.list, 3, 'refused without replaying the log from its start');
  const before = await replay(v.repo, 1);
  await assert.rejects(download(v.repo, before.get('old.bin')!), /is gone/, 'the refused moments really lost data');
  await assert.rejects(download(v.repo, before.get('drop.bin')!), /is gone/);

  for (const e of first.files.values()) await download(v.repo, e);
  assert.equal(await text(v.repo, first.files.get('notes/old.md')!), 'old\n');
  const plan = planRestore(v.remote, first.files);
  assert.deepEqual(plan, { write: [{ path: 'notes/old.md', entry: first.files.get('notes/old.md')! }], remove: [] });

  const gone = await deleted(v);
  assert.deepEqual(gone.map((d) => d.path), ['notes/old.md'], 'files deleted at or before the earliest moment are not offered');
  assert.equal(await text(v.repo, gone[0].entry), 'old\n');
  assert.deepEqual((await commits(v)).map((c) => [c.seq, c.added, c.changed, c.deleted]), [[5, 0, 0, 1], [4, 1, 0, 1]]);
});

/** Deletes, a delete then re-create, a rename and a delete on another device. */
async function history() {
  const { devices: [a, b], clock } = setup({}, ['A', 'B']);
  const times = [0];
  const step = async (d: Device, edit: () => void) => {
    edit();
    times.push(clock.now);
    await d.sync();
    clock.now += 60_000;
  };
  await step(a, () => {
    for (const path of ['notes/a.md', 'notes/b.md', 'notes/c.md', 'other/d.md', 'notesy.md']) a.fs.put(path, `${path}\n`);
  });
  await step(a, () => a.fs.files.delete('notes/a.md')); // 2
  await step(a, () => a.fs.files.delete('notes/b.md')); // 3
  await step(a, () => a.fs.put('notes/b.md', 'b again\n')); // 4
  await step(a, () => {
    a.fs.put('notes/sub/c.md', a.fs.text('notes/c.md')!);
    a.fs.files.delete('notes/c.md');
  }); // 5: a rename
  await step(a, () => a.fs.files.delete('notesy.md')); // 6
  await b.sync();
  await step(b, () => b.fs.files.delete('other/d.md')); // 7
  await step(b, () => b.fs.put('notes/b.md', 'b edited\n')); // 8
  return { v: await view(b), times };
}

test('deleted files leave out re-created ones, list a renamed file under its old name, and narrow to a folder', async () => {
  const { v } = await history();
  const all = await deleted(v);
  assert.deepEqual(all.map((d) => [d.path, d.seq, d.device]), [
    ['other/d.md', 7, 'B'],
    ['notesy.md', 6, 'A'],
    ['notes/c.md', 5, 'A'],
    ['notes/a.md', 2, 'A'],
  ]);
  assert.ok(sameContent(all[2].entry, v.remote.get('notes/sub/c.md')!));
  assert.equal(await text(v.repo, all[3].entry), 'notes/a.md\n');
  assert.deepEqual((await deleted(v, 'notes')).map((d) => d.path), ['notes/c.md', 'notes/a.md']);
  assert.deepEqual((await deleted(v, 'notes/')).map((d) => d.path), ['notes/c.md', 'notes/a.md']);
  assert.deepEqual(await deleted(v, 'notes/sub'), []);
});

test('the commit list counts what each commit did, newest first, and stops early', async () => {
  const { v, times } = await history();
  const counts = (list: { seq: number; device: string; added: number; changed: number; deleted: number }[]) =>
    list.map((c) => [c.seq, c.device, c.added, c.changed, c.deleted]);
  assert.deepEqual(counts(await commits(v)), [
    [8, 'B', 0, 1, 0],
    [7, 'B', 0, 0, 1],
    [6, 'A', 0, 0, 1],
    [5, 'A', 1, 0, 1],
    [4, 'A', 1, 0, 0],
    [3, 'A', 0, 0, 1],
    [2, 'A', 0, 0, 1],
    [1, 'A', 5, 0, 0],
  ]);
  assert.deepEqual(counts(await commits(v, { limit: 3 })), [[8, 'B', 0, 1, 0], [7, 'B', 0, 0, 1], [6, 'A', 0, 0, 1]]);
  assert.deepEqual((await commits(v, { since: times[4] })).map((c) => [c.seq, c.time]), [[8, times[8]], [7, times[7]], [6, times[6]], [5, times[5]], [4, times[4]]]);
});

test('a folder restore plan leaves other folders alone, skips identical files, and applying it brings the bytes back', async () => {
  const { devices: [a, b], clock } = setup({}, ['A', 'B']);
  for (const [path, body] of [['notes/a.md', 'a1\n'], ['notes/b.md', 'b1\n'], ['notes/same.md', 'same\n'], ['notes/r.md', 'r\n'], ['other/x.md', 'x1\n']]) a.fs.put(path, body);
  await a.sync();
  const then = clock.now;
  clock.now += 60_000;
  a.fs.put('notes/a.md', 'a2\n');
  a.fs.files.delete('notes/b.md');
  a.fs.put('notes/new.md', 'new\n');
  a.fs.put('notes/r2.md', 'r\n');
  a.fs.files.delete('notes/r.md');
  a.fs.put('other/x.md', 'x2\n');
  await a.sync();

  let v = await view(a);
  const target = (await at(v, then)).files;
  const plan = planRestore(v.remote, target, 'notes');
  assert.deepEqual(plan.write.map((w) => w.path).sort(), ['notes/a.md', 'notes/b.md', 'notes/r.md']);
  assert.deepEqual(plan.remove.sort(), ['notes/new.md', 'notes/r2.md']);
  assert.deepEqual(planRestore(v.remote, target).write.map((w) => w.path).sort(), ['notes/a.md', 'notes/b.md', 'notes/r.md', 'other/x.md']);
  assert.deepEqual(planRestore(v.remote, v.remote), { write: [], remove: [] });

  for (const path of plan.remove) a.fs.files.delete(path);
  for (const { path, entry } of plan.write) a.fs.put(path, await download(v.repo, entry));
  clock.now += 60_000;
  await a.sync();
  await b.sync();
  assert.deepEqual(
    Object.fromEntries([...b.fs.files.keys()].sort().map((path) => [path, b.fs.text(path)])),
    { 'notes/a.md': 'a1\n', 'notes/b.md': 'b1\n', 'notes/r.md': 'r\n', 'notes/same.md': 'same\n', 'other/x.md': 'x2\n' },
  );
  v = await view(a);
  assert.deepEqual(planRestore(v.remote, target, 'notes'), { write: [], remove: [] }, 'the folder now matches the moment');
});

test('paging by sequence number lists every moment once, even moments that share a millisecond', async () => {
  const { devices: [a], clock } = setup();
  for (let i = 0; i < 9; i++) {
    if (i % 3 === 0) clock.now += 60_000; // three commits in each millisecond
    a.fs.put(`n${i}.md`, `${i}\n`);
    await a.sync();
  }
  const v = await view(a);
  const all = await commits(v);
  assert.equal(all.length, 9);
  const page = async (o: { beforeSeq?: number; before?: number }) => listCommits(v.repo, v.lastSeq, v.cfg, v.now, { limit: 2, ...o });
  const bySeq = [];
  for (let beforeSeq: number | undefined; ; ) {
    const p = await page({ beforeSeq });
    if (!p.length) break;
    bySeq.push(...p);
    beforeSeq = p.at(-1)!.seq;
  }
  assert.deepEqual(bySeq, all);
  const byTime = [];
  for (let before: number | undefined; ; ) {
    const p = await page({ before });
    if (!p.length) break;
    byTime.push(...p);
    before = p.at(-1)!.time;
  }
  assert.ok(byTime.length < all.length, 'a time cannot tell moments in the same millisecond apart');
  assert.deepEqual(await page({ beforeSeq: 1 }), []);
  assert.deepEqual((await page({ beforeSeq: 100 })).map((c) => c.seq), [9, 8]);
});
