import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { SafetyError, type SyncResult } from '../src/core/engine.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { NodeFS } from '../src/node/nodefs.ts';
import { SyncLoop, watchVault, type LoopOptions } from '../src/node/watch.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { Device } from './helpers.ts';

const CLI = new URL('../src/node/cli.ts', import.meta.url).pathname;

/**
 * A vault, a folder remote and a config file in a temporary folder, and the CLI pointed at them.
 * Given another setup, a second device: its own vault, the same remote.
 */
function setup(sync: object, other?: { dir: string }) {
  const dir = other?.dir ?? mkdtempSync(join(tmpdir(), 'selfsync-cli-'));
  const name = other ? 'vault2' : 'vault';
  const vault = join(dir, name);
  mkdirSync(vault);
  const config = join(dir, `${name}.json`);
  writeFileSync(config, JSON.stringify({ vault, remote: { type: 'folder', path: join(dir, 'remote') }, sync: { kdfIterations: 1000, ...sync } }));
  const run = (...args: string[]) =>
    spawnSync('node', [CLI, ...args, `--config=${config}`], { encoding: 'utf8', env: { ...process.env, SELFSYNC_PASSPHRASE: 'pw' } });
  const cli = (...args: string[]) => run(...args).stdout;
  return { dir, vault, config, run, cli, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function put(vault: string, path: string, text: string): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), text);
}

/** Every file in a vault but the CLI's own state, with its text. */
function files(vault: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (readdirSync(vault, { recursive: true }) as string[]).sort()) {
    if (!p.startsWith('.self-sync') && statSync(join(vault, p)).isFile()) out[p.split(sep).join('/')] = readFileSync(join(vault, p), 'utf8');
  }
  return out;
}

test("cli: a custom exclude list never syncs the CLI's own state", () => {
  const t = setup({ exclude: ['*.tmp'] });
  try {
    writeFileSync(join(t.vault, 'note.md'), 'hello\n');
    assert.match(t.cli('sync'), /^sent 1,/);
    assert.match(t.cli('sync'), /^sent 0, received 0,/);
  } finally {
    t.done();
  }
});

test('cli: history finds a file whichever Unicode form its name is typed in', () => {
  const t = setup({});
  try {
    const name = 'ý tưởng.md';
    writeFileSync(join(t.vault, name), 'x\n');
    t.cli('sync');
    assert.match(t.cli('history', name.normalize('NFC')), /2 bytes/);
    assert.match(t.cli('history', name.normalize('NFD')), /2 bytes/);
  } finally {
    t.done();
  }
});

test('cli: deleted lists files deleted on another device, newest first, and narrows to a folder', () => {
  const a = setup({ deviceName: 'laptop' });
  const b = setup({ deviceName: 'phone' }, a);
  try {
    put(a.vault, 'notes/a.md', 'a\n');
    put(a.vault, 'other/b.md', 'b\n');
    put(a.vault, 'kept.md', 'kept\n');
    a.cli('sync');
    b.cli('sync');
    rmSync(join(b.vault, 'notes', 'a.md'));
    b.cli('sync');
    rmSync(join(b.vault, 'other', 'b.md'));
    b.cli('sync');
    const lines = a.cli('deleted').trim().split('\n');
    assert.deepEqual(lines.map((l) => l.split(/\s+/).slice(1)), [['phone', 'other/b.md'], ['phone', 'notes/a.md']]);
    assert.ok(lines.every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l)));
    assert.ok(Date.parse(lines[0].split(' ')[0]) >= Date.parse(lines[1].split(' ')[0]));
    assert.deepEqual(a.cli('deleted', 'notes/').trim().split('\n').map((l) => l.split(/\s+/).at(-1)), ['notes/a.md']);
    assert.equal(a.cli('deleted', 'nowhere'), '');
  } finally {
    a.done();
  }
});

test('cli: restore-at brings a folder back exactly, leaves other folders alone, and sends it, so the other device gets it at its next sync', async () => {
  const a = setup({ deviceName: 'laptop' });
  const b = setup({ deviceName: 'phone' }, a);
  try {
    put(a.vault, 'notes/a.md', 'a1\n');
    put(a.vault, 'notes/b.md', 'b1\n');
    put(a.vault, 'notes/same.md', 'same\n');
    put(a.vault, 'other/x.md', 'x1\n');
    a.cli('sync');
    const then = new Date().toISOString();
    await sleep(20);
    put(a.vault, 'notes/a.md', 'a2\n');
    rmSync(join(a.vault, 'notes', 'b.md'));
    put(a.vault, 'notes/sub/new.md', 'new\n');
    put(a.vault, 'other/x.md', 'x2\n');
    a.cli('sync');
    b.cli('sync');
    const before = files(a.vault);

    const dry = a.run('restore-at', then, 'notes', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    const out = dry.stdout.trim().split('\n');
    const used = /^notes\/ as of (\S+), synced by laptop:$/.exec(out[0]);
    assert.ok(used && Date.parse(used[1]) < Date.parse(then), 'it names the moment it used, the last sync before the time asked for');
    assert.deepEqual(out.slice(1, -1), ['  remove      notes/sub/new.md', '  change      notes/a.md', '  bring back  notes/b.md']);
    assert.match(out.at(-1)!, /^dry run: would bring back 1, change 1 and remove 1; nothing changed$/);
    assert.deepEqual(files(a.vault), before);

    const r = a.run('restore-at', then, 'notes');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^synced first: sent 0, received 0/);
    assert.match(r.stdout, /\nrestored notes\/ as of \S+: brought back 1, changed 1, removed 1\nthen synced: sent 2, received 0, deleted 0 here and 1 remotely, merged 0\n$/);
    assert.doesNotMatch(r.stdout, /--force/);
    const expected = { 'notes/a.md': 'a1\n', 'notes/b.md': 'b1\n', 'notes/same.md': 'same\n', 'other/x.md': 'x2\n' };
    assert.deepEqual(files(a.vault), expected);
    assert.equal(existsSync(join(a.vault, 'notes', 'sub')), false);

    assert.match(a.cli('sync'), /^sent 0, received 0, deleted 0 here and 0 remotely/, 'already sent');
    assert.match(a.cli('restore-at', then, 'notes', '--dry-run'), /nothing to do: it already matches/);
    assert.match(b.cli('sync'), /^sent 0, received 2, deleted 1 here/);
    assert.deepEqual(files(b.vault), expected);
  } finally {
    a.done();
  }
});

test('cli: restore-at sends the many files it removes without --force, another device on this version deletes them too, and it says older ones stop', async () => {
  const t = setup({ deviceName: 'laptop' });
  const other = setup({ deviceName: 'phone' }, t);
  try {
    put(t.vault, 'keep.md', 'keep\n');
    t.cli('sync');
    const then = new Date().toISOString();
    await sleep(20);
    for (let i = 0; i < 12; i++) put(t.vault, `drafts/${i}.md`, `${i}\n`);
    t.cli('sync');
    other.cli('sync');
    const r = t.run('restore-at', then);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /brought back 0, changed 0, removed 12\nthen synced: sent 0, received 0, deleted 0 here and 12 remotely/);
    assert.match(r.stdout, /the 12 files removed went to storage as deletions you asked for, so no --force was needed, and other devices delete them when they next sync; one on an older version, or many syncs behind, stops first, as it does before deleting more than 10 files at once/);
    assert.match(t.cli('sync'), /^sent 0, received 0, deleted 0 here and 0 remotely/);
    const there = other.run('sync');
    assert.equal(there.status, 0, there.stderr);
    assert.match(there.stdout, /^sent 0, received 0, deleted 12 here/);
    assert.deepEqual(files(t.vault), { 'keep.md': 'keep\n' });
    assert.deepEqual(files(other.vault), { 'keep.md': 'keep\n' });
  } finally {
    t.done();
  }
});

test('cli: restore-at needs a time it can read, and one not before the earliest that can be restored', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    t.cli('sync');
    let r = t.run('restore-at', 'yesterday');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"yesterday" is not a time; use ISO 8601/);
    r = t.run('restore-at', '2000-01-01T00:00:00Z', '--dry-run');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /too far back; the earliest time that can be restored is \d{4}-\d\d-\d\dT/);
    assert.deepEqual(files(t.vault), { 'a.md': 'a\n' });
  } finally {
    t.done();
  }
});

test('cli: accept-storage carries on after storage was put back to an older copy, deleting nothing and keeping both versions', () => {
  const t = setup({ deviceName: 'laptop' });
  try {
    put(t.vault, 'a.md', 'one\n');
    t.cli('sync');
    const remote = join(t.dir, 'remote');
    cpSync(remote, join(t.dir, 'backup'), { recursive: true });
    put(t.vault, 'a.md', 'one\ntwo\n');
    put(t.vault, 'b.md', 'b\n');
    t.cli('sync');
    rmSync(remote, { recursive: true });
    cpSync(join(t.dir, 'backup'), remote, { recursive: true });

    const stopped = t.run('sync');
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /the newest this device has seen, is missing/);
    const r = t.run('accept-storage');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^carrying on from storage as it is now\nsent \d+, received \d+, deleted 0 here and 0 remotely, merged 0\nboth versions kept: a \(conflict/);
    const copy = Object.keys(files(t.vault)).find((p) => p.includes('conflict'))!;
    assert.deepEqual(files(t.vault), { 'a.md': 'one\n', [copy]: 'one\ntwo\n', 'b.md': 'b\n' });
    assert.match(t.cli('sync'), /^sent 0, received 0, deleted 0 here and 0 remotely/);
  } finally {
    t.done();
  }
});

test('cli: clean says what it did, including when there was nothing to do', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    t.cli('sync');
    const r = t.run('clean');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'nothing to clean: no stored version has expired, and no pack is worth combining\n');
  } finally {
    t.done();
  }
});

test('cli: log lists the times the vault can go back to, newest first, with what each sync changed', () => {
  const t = setup({ deviceName: 'laptop' });
  try {
    put(t.vault, 'a.md', 'a\n');
    t.cli('sync');
    put(t.vault, 'a.md', 'a2\n');
    put(t.vault, 'b.md', 'b\n');
    t.cli('sync');
    rmSync(join(t.vault, 'a.md'));
    t.cli('sync');
    const lines = t.cli('log').trim().split('\n');
    const fields = lines.map((l) => l.trim().split(/\s+/));
    assert.deepEqual(fields.map((f) => f.slice(2).join(' ')), [
      'laptop 0 added, 0 changed, 1 deleted',
      'laptop 1 added, 1 changed, 0 deleted',
      'laptop 1 added, 0 changed, 0 deleted',
    ]);
    assert.deepEqual(fields.map((f) => f[0]), ['3', '2', '1'], 'each moment comes after its number, which restore-at takes');
    const times = fields.map((f) => Date.parse(f[1]));
    assert.ok(times[0] >= times[1] && times[1] >= times[2]);
    assert.deepEqual(t.cli('log', '--limit=1').trim().split('\n'), [lines[0]]);
    const bad = t.run('log', '--limit=0');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--limit must be a whole number above 0/);
  } finally {
    t.done();
  }
});

test('cli: restore-at takes the number log prints for a moment, and restores exactly that one', () => {
  const t = setup({ deviceName: 'laptop' });
  try {
    put(t.vault, 'a.md', 'one\n');
    t.cli('sync');
    put(t.vault, 'a.md', 'two\n');
    put(t.vault, 'b.md', 'b\n');
    t.cli('sync');
    put(t.vault, 'a.md', 'three\n');
    t.cli('sync');
    const [, middle] = t.cli('log').trim().split('\n').map((l) => l.trim().split(/\s+/));
    assert.equal(middle[0], '2');
    const dry = t.run('restore-at', '2', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(dry.stdout.trim().split('\n').slice(0, 2), [`the vault as of ${middle[1]}, synced by laptop:`, '  change      a.md']);
    const r = t.run('restore-at', '2');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(files(t.vault), { 'a.md': 'two\n', 'b.md': 'b\n' });
    const none = t.run('restore-at', '9', '--dry-run');
    assert.equal(none.status, 1);
    assert.notEqual(none.stderr, '');
    assert.deepEqual(files(t.vault), { 'a.md': 'two\n', 'b.md': 'b\n' });
  } finally {
    t.done();
  }
});

test('cli: verify exits 0 on a healthy remote, and 1 naming the files affected after a pack is removed by hand', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    put(t.vault, 'b.md', 'b\n');
    t.cli('sync');
    const ok = t.run('verify');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'checked 1 commit, 2 files, 1 pack: no problems\n');
    const deep = t.run('verify', '--deep');
    assert.equal(deep.status, 0, deep.stderr);
    assert.match(deep.stdout, /^checked 1 commit, 2 files, 1 pack, 2 chunks \([\d.]+ MB downloaded\): no problems\n$/);

    const packs = readdirSync(join(t.dir, 'remote', 'pack'));
    assert.equal(packs.length, 1);
    rmSync(join(t.dir, 'remote', 'pack', packs[0]));
    const bad = t.run('verify');
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, new RegExp(`^problem: Pack ${packs[0]} is missing \\(pack/${packs[0]}\\)$`, 'm'));
    assert.match(bad.stdout, /^ {2}affects a\.md\n {2}affects b\.md$/m);
    assert.match(bad.stdout, /: 1 problem\n$/);
  } finally {
    t.done();
  }
});

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflictCopies: [], skipped: 0, tooLarge: [], errors: [], commits: 0, rounds: 1, ...over,
});

const immediate = () => new Promise<void>((done) => setImmediate(done));

/** Waits without timers, so it works while they are mocked. */
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !cond(); await immediate()) assert.ok(Date.now() < end, 'timed out');
}

/** Waits on real timers, for tests that run the CLI or a file watcher. */
async function eventually(cond: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !cond(); await sleep(20)) assert.ok(Date.now() < end, 'timed out');
}

/** A SyncLoop on mocked timers whose syncs finish when the test says so. */
function fakeLoop(t: TestContext, over: Partial<LoopOptions> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = {
    syncs: 0,
    polls: 0,
    maxActive: 0,
    remote: false,
    pending: [] as { ok: (r: SyncResult) => void; fail: (e: unknown) => void }[],
    failures: [] as { e: unknown; retryMs?: number }[],
    /** Advances a second at a time, letting what each tick started finish before the next. */
    async tick(ms: number) {
      for (let left = ms; left > 0; left -= 1000) {
        t.mock.timers.tick(Math.min(left, 1000));
        await immediate();
      }
    },
    async finish(r = result()) {
      h.pending.shift()!.ok(r);
      await immediate();
    },
    async fail(e: unknown) {
      h.pending.shift()!.fail(e);
      await immediate();
    },
  };
  const loop = new SyncLoop({
    sync: () =>
      new Promise<SyncResult>((resolve, reject) => {
        h.syncs++;
        h.pending.push({ ok: resolve, fail: reject });
        h.maxActive = Math.max(h.maxActive, h.pending.length);
      }),
    remoteChanged: async () => {
      h.polls++;
      return h.remote;
    },
    onResult: () => {},
    onFailure: (e, retryMs) => h.failures.push({ e, retryMs }),
    debounceMs: 3000,
    pollMs: 1e9,
    intervalMs: 1e9,
    ...over,
  });
  /** Stops the loop, finishing the sync it is waiting for. */
  const stop = async () => {
    const stopped = loop.stop();
    while (h.pending.length) await h.finish();
    await stopped;
  };
  return { loop, h, stop };
}

test('watch: a change during a sync causes exactly one more sync after it, never two at once', async (t) => {
  const { loop, h, stop } = fakeLoop(t);
  loop.start();
  assert.equal(h.syncs, 1);
  loop.changed();
  loop.changed();
  await h.tick(60_000);
  assert.equal(h.syncs, 1);
  await h.finish();
  await h.tick(2999);
  assert.equal(h.syncs, 1);
  await h.tick(1);
  assert.equal(h.syncs, 2);
  await h.finish();
  await h.tick(60_000);
  assert.equal(h.syncs, 2);
  assert.equal(h.maxActive, 1);
  await stop();
});

test('watch: syncs once changes have stopped for a few seconds', async (t) => {
  const { loop, h, stop } = fakeLoop(t);
  loop.start();
  await h.finish();
  loop.changed();
  await h.tick(2000);
  loop.changed();
  await h.tick(2999);
  assert.equal(h.syncs, 1);
  await h.tick(1);
  assert.equal(h.syncs, 2);
  await stop();
});

test('watch: a remote change starts a sync, and a poll is skipped while one is running', async (t) => {
  const { loop, h, stop } = fakeLoop(t, { pollMs: 1000 });
  loop.start();
  await h.finish();
  await h.tick(3000);
  assert.deepEqual([h.polls, h.syncs], [3, 1]);
  h.remote = true;
  await h.tick(1000);
  assert.deepEqual([h.polls, h.syncs], [4, 2]);
  await h.tick(5000);
  assert.equal(h.polls, 4);
  await h.finish();
  await stop();
});

test('watch: syncs everything every interval, for changes the watcher missed', async (t) => {
  const { loop, h, stop } = fakeLoop(t, { intervalMs: 5000 });
  loop.start();
  await h.finish();
  await h.tick(4999);
  assert.equal(h.syncs, 1);
  await h.tick(1);
  assert.equal(h.syncs, 2);
  await stop();
});

test('watch: a failed sync is retried after 5 s, then 10, doubling to 5 minutes, and a success starts over', async (t) => {
  const { loop, h, stop } = fakeLoop(t, { pollMs: 1000, intervalMs: 2000 });
  h.remote = true;
  loop.start();
  for (const wait of [5, 10, 20, 40, 80, 160, 300, 300]) {
    await h.fail(new Error('fetch failed'));
    assert.equal(h.failures.at(-1)!.retryMs, wait * 1000);
    await h.tick(wait * 1000 - 1);
    assert.equal(h.pending.length, 0, `no retry before ${wait} s`);
    await h.tick(1);
    assert.equal(h.pending.length, 1, `retry after ${wait} s`);
  }
  await h.finish();
  await h.tick(1000);
  await h.fail(new Error('fetch failed'));
  assert.equal(h.failures.at(-1)!.retryMs, 5000);
  await stop();
});

test('watch: a refused mass delete is reported once and not retried until something changes', async (t) => {
  const { loop, h, stop } = fakeLoop(t, { pollMs: 1000, intervalMs: 5000 });
  h.remote = true;
  loop.start();
  await h.fail(new SafetyError(0, 100));
  assert.ok(h.failures[0].e instanceof SafetyError);
  assert.equal(h.failures[0].retryMs, undefined);
  await h.tick(10 * 60_000);
  assert.deepEqual([h.syncs, h.polls, h.failures.length], [1, 0, 1]);
  loop.changed();
  await h.tick(3000);
  assert.equal(h.syncs, 2);
  await stop();
});

test('watch: stopping waits for the sync in progress and starts nothing after it', async (t) => {
  const { loop, h } = fakeLoop(t, { pollMs: 1000, intervalMs: 1000 });
  loop.start();
  let stopped = false;
  void loop.stop().then(() => (stopped = true));
  await h.tick(5000);
  assert.equal(stopped, false);
  await h.finish();
  await until(() => stopped);
  await h.tick(60_000);
  assert.deepEqual([h.syncs, h.polls], [1, 0]);
});

test('watch: with the storage down it retries with backoff, then sends the edit when it is back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const inner = new MemoryStore();
  let down = true;
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A) => (down ? Promise.reject(new Error('fetch failed')) : fn(...a));
  const store: RemoteStore = { get: guard(inner.get.bind(inner)), put: guard(inner.put.bind(inner)), delete: guard(inner.delete.bind(inner)), list: guard(inner.list.bind(inner)) };
  const clock = { now: 1_700_000_000_000 };
  const here = new Device('here', store, clock);
  const there = new Device('there', inner, clock);
  here.fs.put('a.md', 'hello');
  const retries: (number | undefined)[] = [];
  const results: SyncResult[] = [];
  const loop = new SyncLoop({
    sync: () => here.sync(),
    remoteChanged: () => here.engine.remoteChanged(),
    onResult: (r) => results.push(r),
    onFailure: (_e, retryMs) => retries.push(retryMs),
    debounceMs: 3000,
    pollMs: 1e9,
    intervalMs: 1e9,
  });
  loop.start();
  await until(() => retries.length === 1);
  t.mock.timers.tick(5000);
  await until(() => retries.length === 2);
  assert.deepEqual(retries, [5000, 10_000]);
  down = false;
  t.mock.timers.tick(10_000);
  await until(() => results.length === 1);
  assert.equal(results[0].pushed, 1);
  await there.sync();
  assert.equal(there.fs.text('a.md'), 'hello');
  await loop.stop();
});

test("watch: the sync's own writes and the state folder are not local changes, an edit of the same file is", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfsync-watch-'));
  const fs = new NodeFS(dir);
  const seen: string[] = [];
  mkdirSync(join(dir, 'notes'));
  mkdirSync(join(dir, '.self-sync'));
  const watcher = watchVault(dir, fs, '.self-sync', (path) => seen.push(path), (e) => assert.fail(e.message));
  const reported = async (path: string) => {
    await eventually(() => seen.includes(path));
    await sleep(200);
  };
  try {
    await fs.write('notes/a.md', new TextEncoder().encode('one'), 1_700_000_000_000);
    await fs.write('notes/a.md', new TextEncoder().encode('two!'), 1_700_000_001_000);
    await fs.write('notes/b.md', new TextEncoder().encode('b'));
    await fs.remove('notes/b.md');
    writeFileSync(join(dir, '.self-sync', 'state.json'), '{}');
    writeFileSync(join(dir, 'user.md'), 'hello');
    await reported('user.md');
    assert.deepEqual([...new Set(seen)], ['user.md']);
    writeFileSync(join(dir, 'notes', 'a.md'), 'edited by hand');
    await reported('notes/a.md');
  } finally {
    watcher.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli watch: sends local edits, receives another device\'s changes, and stops on SIGTERM', async () => {
  const a = setup({});
  const b = setup({ deviceName: 'other' }, a);
  const child = spawn('node', [CLI, 'watch', '--poll=0.2', '--interval=60', `--config=${a.config}`], { env: { ...process.env, SELFSYNC_PASSPHRASE: 'pw' } });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const lines = () => out.split('\n').filter(Boolean);
  try {
    writeFileSync(join(a.vault, 'one.md'), '1\n');
    await eventually(() => lines().length === 1);
    assert.match(b.cli('sync'), /^sent 0, received 1,/);
    assert.equal(readFileSync(join(b.vault, 'one.md'), 'utf8'), '1\n');

    writeFileSync(join(b.vault, 'two.md'), '2\n');
    assert.match(b.cli('sync'), /^sent 1,/);
    await eventually(() => existsSync(join(a.vault, 'two.md')) && lines().length === 2);
    assert.equal(readFileSync(join(a.vault, 'two.md'), 'utf8'), '2\n');

    writeFileSync(join(a.vault, 'three.md'), '3\n');
    await eventually(() => lines().length === 3);
    assert.match(b.cli('sync'), /^sent 0, received 1,/);
    assert.equal(readFileSync(join(b.vault, 'three.md'), 'utf8'), '3\n');

    await sleep(1000);
    assert.deepEqual(
      lines().map((l) => l.replace(/^\S+Z /, '')),
      ['sent 1, received 0, deleted 0 here and 0 remotely, merged 0', 'sent 0, received 1, deleted 0 here and 0 remotely, merged 0', 'sent 1, received 0, deleted 0 here and 0 remotely, merged 0'],
    );
    assert.ok(lines().every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l)));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(err, '');
  } finally {
    child.kill('SIGKILL');
    a.done();
  }
});

test('cli watch: --poll and --interval must be positive numbers of seconds', () => {
  const t = setup({});
  try {
    const r = t.run('watch', '--poll=0');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--poll must be a number of seconds above 0/);
  } finally {
    t.done();
  }
});
