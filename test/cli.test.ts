import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveConfig } from '../src/core/config.ts';
import { listDevices } from '../src/core/devices.ts';
import { SafetyError, SyncEngine, type SyncResult } from '../src/core/engine.ts';
import { decodeInvite, encodeFollow, encodeInvite } from '../src/core/members.ts';
import { createMemberShare } from '../src/core/membership.ts';
import { seqKey } from '../src/core/repo.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { placeOf } from '../src/node/member.ts';
import { FolderStore, NodeFS } from '../src/node/nodefs.ts';
import { SyncLoop, watchVault, type LoopOptions } from '../src/node/watch.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { DAY, Device, TEST_CONFIG, rawRepo } from './helpers.ts';

const PASSPHRASE = 'pw-for-tests';
// COFFER_CLI points the same tests at the release bundle, dist/coffer.js.
const CLI = process.env.COFFER_CLI ? resolve(process.env.COFFER_CLI) : new URL('../src/node/cli.ts', import.meta.url).pathname;

/**
 * A vault, a folder remote and a config file in a temporary folder, and the CLI pointed at them.
 * Given another setup, a second device: its own vault, the same remote.
 */
function setup(sync: object, other?: { dir: string }) {
  const dir = other?.dir ?? mkdtempSync(join(tmpdir(), 'coffer-cli-'));
  const name = other ? 'vault2' : 'vault';
  const vault = join(dir, name);
  mkdirSync(vault);
  const config = join(dir, `${name}.json`);
  writeFileSync(config, JSON.stringify({ vault, remote: { type: 'folder', path: join(dir, 'remote') }, sync: { kdfIterations: 1000, ...sync } }));
  const run = (...args: string[]) =>
    spawnSync('node', [CLI, ...args, `--config=${config}`], { encoding: 'utf8', env: { ...process.env, COFFER_PASSPHRASE: PASSPHRASE } });
  const cli = (...args: string[]) => run(...args).stdout;
  return { dir, vault, config, run, cli, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The CLI run as typed from `cwd`, with no --config added. */
const bare = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, COFFER_PASSPHRASE: PASSPHRASE, ...env } });

/** As `bare`, for a run that must leave this process free to answer, as a test server does. */
const bareAsync = (args: string[], env: Record<string, string>, cwd?: string, input?: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn('node', [CLI, ...args], { env: { ...process.env, ...env }, cwd });
    if (input !== undefined) child.stdin.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.once('close', (status) => done({ status, stdout, stderr }));
  });

const NOTHING_QUICK = 'nothing to repair: every stored object is present and whole in size (repair --deep reads their contents)';
const NOTHING_DEEP = 'nothing to repair: every stored object is present and whole in size, and the contents the current files use were read and are intact';

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A file over a 1 MB deferAboveMB, each `fill` its own content. */
const big = (vault: string, name: string, fill: number) => writeFileSync(join(vault, name), Buffer.alloc(1_300_000, fill));

function put(vault: string, path: string, text: string): void {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), text);
}

/** Every file in a vault but the CLI's own state, with its text. */
function files(vault: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of (readdirSync(vault, { recursive: true }) as string[]).sort()) {
    if (!p.startsWith('.coffer') && statSync(join(vault, p)).isFile()) out[p.split(sep).join('/')] = readFileSync(join(vault, p), 'utf8');
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
    assert.match(stopped.stderr, /the newest this device has seen, is missing.*\nif storage was put back to a backup or an older copy on purpose, run accept-storage to carry on from it as it is now\n$/);
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

test('cli: repair stores a removed pack again from the vault that has its files, and a vault without them exits 1 and writes nothing', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    put(t.vault, 'b.md', 'b\n');
    t.cli('sync');
    const u = setup({}, t);
    u.cli('sync');
    const clean = t.run('repair');
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout, `${NOTHING_QUICK}\n`);

    const remote = (dir: string) => readdirSync(join(t.dir, 'remote', dir));
    const [pack] = remote('pack');
    rmSync(join(t.dir, 'remote', 'pack', pack));
    const commits = remote('log').length;
    rmSync(join(u.vault, 'a.md'));
    rmSync(join(u.vault, 'b.md'));
    const none = u.run('repair');
    assert.equal(none.status, 1);
    assert.equal(none.stdout, 'repaired 0 files (0 chunks stored again), 2 still missing\n');
    assert.equal(none.stderr, 'still missing: a.md\nstill missing: b.md\n');
    assert.deepEqual([remote('pack'), remote('log').length], [[], commits]);

    const r = t.run('repair');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'repaired: a.md\nrepaired: b.md\nrepaired 2 files (2 chunks stored again), 0 still missing\n');
    assert.equal(remote('pack').length, 1);
    assert.equal(remote('log').length, commits + 1);
    const deep = t.run('verify', '--deep');
    assert.equal(deep.status, 0, deep.stdout);
    assert.equal(t.run('repair', '--deep').stdout, `${NOTHING_DEEP}\n`);
    assert.match(t.run('repair', '--dep').stderr, /^unknown option for repair: --dep$/m);

    // A vault that starts afresh downloads the files that were repaired.
    rmSync(join(u.vault, '.coffer'), { recursive: true });
    assert.match(u.cli('sync'), /^sent 0, received 2,/);
    assert.deepEqual(files(u.vault), { 'a.md': 'a\n', 'b.md': 'b\n' });
  } finally {
    t.done();
  }
});

test('cli: a device that only receives refuses what would write to storage or to files it never sends, and still looks, checks and accepts storage', async () => {
  const a = setup({ deviceName: 'laptop' });
  const b = setup({ deviceName: 'reader', readOnly: true }, a);
  try {
    put(a.vault, 'a.md', 'one\n');
    a.cli('sync');
    assert.match(b.cli('sync'), /^sent 0, received 1,/);
    const remote = join(a.dir, 'remote');
    const stored = () => (readdirSync(remote, { recursive: true }) as string[]).sort();
    cpSync(remote, join(a.dir, 'backup'), { recursive: true });
    const then = new Date().toISOString();
    await sleep(20);
    put(a.vault, 'a.md', 'one\ntwo\n');
    a.cli('sync');
    assert.match(b.cli('sync'), /^sent 0, received 1,/);
    for (const pack of readdirSync(join(remote, 'pack'))) rmSync(join(remote, 'pack', pack));
    const before = { remote: stored(), vault: files(b.vault) };

    for (const [args, why] of [
      [['repair'], 'it cannot store data in storage again'],
      [['repair', '--deep'], 'it cannot store data in storage again'],
      [['restore', 'a.md', '1'], 'a restored file would never be sent'],
      [['restore-at', then], 'a restore would never be sent'],
      [['clean'], 'it does not clean up storage'],
      [['change-passphrase'], 'it cannot change the passphrase in storage'],
    ] as const) {
      const r = b.run(...args);
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, `this device only receives changes, so ${why}; run ${args[0]} from a device that sends them\n`);
    }
    assert.deepEqual({ remote: stored(), vault: files(b.vault) }, before);

    const dry = b.run('restore-at', then, '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\n  change      a\.md\ndry run: would bring back 0, change 1 and remove 0; nothing changed\n$/);
    assert.equal(b.run('verify').status, 1, 'verify reads and reports the missing packs');
    assert.match(b.cli('history', 'a.md'), /\bbytes\b/);
    assert.deepEqual({ remote: stored(), vault: files(b.vault) }, before);

    rmSync(remote, { recursive: true });
    cpSync(join(a.dir, 'backup'), remote, { recursive: true });
    const gone = stored();
    assert.equal(b.run('sync').status, 1);
    const r = b.run('accept-storage');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^carrying on from storage as it is now\n/);
    assert.deepEqual(stored(), gone, 'accepting storage wrote nothing to it');
    assert.equal(b.run('sync').status, 0);
  } finally {
    a.done();
  }
});

test('cli: an option the command does not know stops it before it does anything, so a mistyped --dry-run never restores for real', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    t.cli('sync');
    put(t.vault, 'b.md', 'b\n');
    t.cli('sync');
    const typo = t.run('restore-at', '1', '--dryrun');
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /^unknown option for restore-at: --dryrun$/m);
    assert.deepEqual(files(t.vault), { 'a.md': 'a\n', 'b.md': 'b\n' });
    assert.match(t.run('sync', '--forse').stderr, /^unknown option for sync: --forse$/m);
    assert.match(t.run('log', '--deep').stderr, /^unknown option for log: --deep$/m);
    assert.equal(t.run('verify', '--deep').status, 0);
    const unknown = t.run('frobnicate');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^unknown command: frobnicate$/m);
  } finally {
    t.done();
  }
});

test('cli: restore leaves alone a file with changes not synced yet, which no stored version holds', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'one\n');
    t.cli('sync');
    put(t.vault, 'a.md', 'two\n');
    t.cli('sync');
    put(t.vault, 'a.md', 'three, typed and not synced\n');
    const refused = t.run('restore', 'a.md', '1');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /a\.md has changes on this device that are not synced yet; run sync first/);
    assert.equal(readFileSync(join(t.vault, 'a.md'), 'utf8'), 'three, typed and not synced\n');
    t.cli('sync');
    assert.match(t.cli('restore', 'a.md', '1'), /^restored a\.md as of /);
    assert.equal(readFileSync(join(t.vault, 'a.md'), 'utf8'), 'one\n');
  } finally {
    t.done();
  }
});

test('cli: says what went wrong with the config file, a path with no stored versions, and how to force a refused sync', () => {
  const t = setup({ maxDeleteCount: 1 });
  try {
    const missing = spawnSync('node', [CLI, 'sync', `--config=${join(t.dir, 'nope.json')}`], { encoding: 'utf8', env: { ...process.env, COFFER_PASSPHRASE: PASSPHRASE } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^config file .*nope\.json not found; pass --config=<file>$/m);
    writeFileSync(join(t.dir, 'bad.json'), '{"vault": "x",\n');
    const bad = spawnSync('node', [CLI, 'sync', `--config=${join(t.dir, 'bad.json')}`], { encoding: 'utf8', env: { ...process.env, COFFER_PASSPHRASE: PASSPHRASE } });
    assert.match(bad.stderr, /^config file .*bad\.json is not valid JSON: /m);

    const none = t.run('history', 'nothing/here.md');
    assert.equal(none.status, 1);
    assert.match(none.stderr, /^no stored versions of nothing\/here\.md$/m);

    for (const n of ['a', 'b', 'c']) put(t.vault, `${n}.md`, `${n}\n`);
    t.cli('sync');
    for (const n of ['a', 'b', 'c']) rmSync(join(t.vault, `${n}.md`));
    const refused = t.run('sync');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^Refusing to sync: .*\nto delete them anyway, run sync --force$/m);
  } finally {
    t.done();
  }
});

test('cli: a half-written file left by a sync that was killed is never sent as a note of its own', () => {
  const a = setup({});
  const b = setup({}, a);
  try {
    put(a.vault, 'a.md', 'a\n');
    put(a.vault, 'sub/b.md.coffer-tmp', 'half of b');
    assert.match(a.cli('sync'), /^sent 1,/);
    b.cli('sync');
    assert.deepEqual(files(b.vault), { 'a.md': 'a\n' });
  } finally {
    a.done();
  }
});

test('cli: a storage folder that is gone, as a drive not mounted, fails the sync instead of being recreated empty and committed to', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    t.cli('sync');
    const remote = join(t.dir, 'remote');
    const away = join(t.dir, 'remote-away');
    renameSync(remote, away);
    put(t.vault, 'a.md', 'edited while the drive was away\n');
    const gone = t.run('sync');
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /storage folder .*remote is missing; .* check that it is mounted/);
    assert.equal(existsSync(remote), false);
    renameSync(away, remote);
    assert.match(t.cli('sync'), /^sent 1,/);
    assert.equal(t.run('verify').status, 0);
  } finally {
    t.done();
  }
});

test('a folder remote that disappears is reported missing by every operation and never recreated; a first run may create it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-folder-'));
  try {
    const root = join(dir, 'remote');
    const store = new FolderStore(root);
    assert.equal(await store.get('vault.json'), null);
    assert.equal(await store.put('log/000000000001', new Uint8Array([1]), { ifNoneMatch: true }), true);
    rmSync(root, { recursive: true });
    await assert.rejects(store.get('log/000000000002', { start: 0, end: 1 }), /storage folder .* is missing/);
    await assert.rejects(store.put('log/000000000002', new Uint8Array([2]), { ifNoneMatch: true }), /is missing/);
    await assert.rejects(store.put('pack/abc', new Uint8Array([2])), /is missing/);
    await assert.rejects(store.list('log/'), /is missing/);
    await assert.rejects(store.delete('log/000000000001'), /is missing/);
    assert.equal(existsSync(root), false);
    await assert.rejects(new FolderStore(root, { create: false }).get('vault.json'), /is missing/);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflictCopies: [], skipped: 0, tooLarge: [], deferred: [], unsent: [], arrived: [], errors: [], commits: 0, rounds: 1, ...over,
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
  const dir = mkdtempSync(join(tmpdir(), 'coffer-watch-'));
  const fs = new NodeFS(dir);
  const seen: string[] = [];
  mkdirSync(join(dir, 'notes'));
  mkdirSync(join(dir, '.coffer'));
  const watcher = watchVault(dir, fs, '.coffer', (path) => seen.push(path), (e) => assert.fail(e.message));
  const reported = async (path: string) => {
    await eventually(() => seen.includes(path));
    await sleep(200);
  };
  try {
    await fs.write('notes/a.md', new TextEncoder().encode('one'), 1_700_000_000_000);
    await fs.write('notes/a.md', new TextEncoder().encode('two!'), 1_700_000_001_000);
    await fs.write('notes/b.md', new TextEncoder().encode('b'));
    await fs.remove('notes/b.md');
    writeFileSync(join(dir, '.coffer', 'state.json'), '{}');
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

test("watch: a file put back the way the sync last left it is still reported, once someone else changed it in between", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-watch-'));
  const fs = new NodeFS(dir);
  const seen: string[] = [];
  const watcher = watchVault(dir, fs, '.coffer', (path) => seen.push(path), (e) => assert.fail(e.message));
  const count = () => seen.filter((p) => p === 'x.md').length;
  try {
    // The sync applies another device's deletion of x.md.
    await fs.write('x.md', new TextEncoder().encode('from another device'));
    await fs.remove('x.md');
    await sleep(300);
    assert.equal(count(), 0, "the sync's own write and removal");
    writeFileSync(join(dir, 'x.md'), 'made again by hand');
    await eventually(() => count() > 0);
    await sleep(300);
    const before = count();
    rmSync(join(dir, 'x.md'));
    await eventually(() => count() > before);
  } finally {
    watcher.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NodeFS remembers what its own writes left only while a watcher asks, and only for a minute after each', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-own-'));
  const fs = new NodeFS(dir);
  const bytes = new TextEncoder().encode('x');
  try {
    await fs.write('notes/a.md', bytes);
    await fs.remove('notes/a.md');
    await fs.write('b.md', bytes);
    assert.equal(await fs.isOwnChange('b.md'), false, 'nothing is remembered with no watcher');
    assert.equal(await fs.isOwnChange('notes/a.md'), false);

    t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    fs.rememberOwn();
    await fs.write('notes/c.md', bytes);
    assert.equal(await fs.isOwnChange('notes/c.md'), true);
    assert.equal(await fs.isOwnChange('notes'), true, 'and the folder above');
    t.mock.timers.tick(60_000);
    assert.equal(await fs.isOwnChange('notes/c.md'), true, 'echoes can come late');
    t.mock.timers.tick(1);
    assert.equal(await fs.isOwnChange('notes/c.md'), false, 'then it is forgotten');
    await fs.write('d.md', bytes);
    assert.equal(await fs.isOwnChange('notes'), false);
    assert.equal(await fs.isOwnChange('d.md'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli watch: sends local edits, receives another device\'s changes, and stops on SIGTERM', async () => {
  const a = setup({});
  const b = setup({ deviceName: 'other' }, a);
  const child = spawn('node', [CLI, 'watch', '--poll=0.2', '--interval=60', `--config=${a.config}`], { env: { ...process.env, COFFER_PASSPHRASE: PASSPHRASE } });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  // The first line says what is watched; the rest are the syncs that did something.
  const lines = () => out.split('\n').filter(Boolean).slice(1);
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
    assert.match(out.split('\n')[0], /^\S+Z watching .*vault against folder .*remote; checking for changes every 0\.2s/);
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

test('cli: the devices list names the system the CLI runs on in plain words', async () => {
  const t = setup({ deviceName: 'server' });
  try {
    put(t.vault, 'note.md', 'hello\n');
    t.cli('sync');
    const reader = new SyncEngine({
      fs: new NodeFS(t.vault),
      store: new FolderStore(join(t.dir, 'remote')),
      stateStore: { load: async () => null, save: async () => {} },
      passphrase: PASSPHRASE,
      config: resolveConfig({ deviceName: 'reader', kdfIterations: 1000 }),
    });
    const [server] = await listDevices(await reader.view());
    const expected = { darwin: 'CLI on macOS', win32: 'CLI on Windows', linux: 'CLI on Linux' }[process.platform as string] ?? `CLI on ${process.platform}`;
    assert.equal(server.platform, expected);
    const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(server.version, version);
  } finally {
    t.done();
  }
});

test('cli: an option that takes a value is read after a space as after =, and a missing, repeated or stray value is refused, never ignored', () => {
  const t = setup({});
  const other = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    t.cli('sync');
    put(t.vault, 'b.md', 'b\n');
    t.cli('sync');
    // The working folder's coffer.json belongs to another vault: using it by mistake would answer for the wrong vault.
    copyFileSync(other.config, join(other.dir, 'coffer.json'));
    const typed = (...args: string[]) => bare(other.dir, args);
    const equals = join(t.dir, 'v=1.json');
    copyFileSync(t.config, equals);
    for (const form of [['--config', t.config], [`--config=${t.config}`], [`--config=${equals}`]]) {
      const r = typed('history', 'a.md', ...form);
      assert.equal(r.status, 0, `${form.join(' ')}: ${r.stderr}`);
      assert.match(r.stdout, /2 bytes/);
    }
    assert.equal(typed('log', '--limit', '1', '--config', t.config).stdout.trim().split('\n').length, 1);
    assert.equal(typed('log', '--limit=1', '--config', t.config).stdout.trim().split('\n').length, 1);

    put(t.vault, 'c.md', 'c\n');
    const commits = () => readdirSync(join(t.dir, 'remote', 'log')).length;
    const before = commits();
    for (const [args, message] of [
      [['log', '--config'], /^--config needs a value/m],
      [['log', '--config='], /^--config needs a value/m],
      [['log', '--limit', `--config=${t.config}`], /^--limit needs a value/m],
      [['log', '--limit=1', '--limit=2', `--config=${t.config}`], /^--limit is given twice/m],
      [['sync', '--force=no', `--config=${t.config}`], /^--force takes no value/m],
      [['sync', '--frob=1', `--config=${t.config}`], /^unknown option for sync: --frob$/m],
    ] as const) {
      const r = typed(...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
      assert.match(r.stderr, message, args.join(' '));
    }
    assert.equal(commits(), before, 'a refused command did nothing');
  } finally {
    t.done();
    other.done();
  }
});

test('cli: a config that is not an object, or lacks a vault or a usable remote, is refused in one line, not with a TypeError', () => {
  const t = setup({});
  try {
    const file = join(t.dir, 'odd.json');
    const remote = (r: object) => JSON.stringify({ vault: t.vault, remote: r });
    for (const [text, why] of [
      ['{}', /needs "vault"/],
      ['null', /must hold a JSON object/],
      ['[]', /must hold a JSON object/],
      ['"x"', /must hold a JSON object/],
      [JSON.stringify({ vault: t.vault }), /needs "remote"/],
      [remote({ type: 'ftp' }), /needs "remote\.type" to be s3, webdav or folder/],
      [remote({ type: 'folder' }), /needs "remote\.path"/],
      [remote({ type: 'webdav', url: 'http://localhost' }), /needs "remote\.username"/],
      [remote({ type: 's3', endpoint: 'http://localhost' }), /needs "remote\.bucket"/],
      [JSON.stringify({ vault: t.vault, sync: 'nope' }), /needs "sync" to be a JSON object/],
      [JSON.stringify({ vault: t.vault, sync: { readonly: true } }), /has "sync\.readonly", which is not a setting/],
      [JSON.stringify({ vault: t.vault, sync: { readOnly: 'false' } }), /needs "sync\.readOnly" to be true or false/],
      [JSON.stringify({ vault: t.vault, sync: { deferAboveMB: -1 } }), /needs "sync\.deferAboveMB" to be a number, 0 or more/],
      [JSON.stringify({ vault: t.vault, sync: { exclude: 'a' } }), /needs "sync\.exclude" to be a list of texts/],
    ] as const) {
      writeFileSync(file, text);
      const r = bare(t.dir, ['sync', `--config=${file}`]);
      assert.equal(r.status, 1, text);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`^config file ${escaped(file)} .*\\n$`), text);
      assert.match(r.stderr, why, text);
      assert.doesNotMatch(r.stderr, /TypeError|\n\s+at /);
    }
  } finally {
    t.done();
  }
});

test('cli: --help and help print the usage and exit 0, --version prints the version, and no command at all is a usage error', () => {
  const t = setup({});
  try {
    for (const args of [['--help'], ['help'], ['sync', '--help'], ['--help', '--frob']]) {
      const r = bare(t.dir, args);
      assert.equal(r.status, 0, args.join(' '));
      assert.match(r.stdout, /^Usage: node coffer\.js <command>/);
      assert.equal(r.stderr, '');
    }
    const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as { version: string };
    const v = bare(t.dir, ['--version']);
    assert.deepEqual([v.status, v.stdout, v.stderr], [0, `${version}\n`, '']);
    const none = bare(t.dir, []);
    assert.equal(none.status, 2);
    assert.match(none.stdout, /^Usage: /);
  } finally {
    t.done();
  }
});

test('cli: a new vault and a new passphrase need at least 8 characters, an existing vault opens with whatever it was made with', async () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'a\n');
    const remote = join(t.dir, 'remote');
    const short = (...args: string[]) => bare(t.dir, [...args, `--config=${t.config}`], { COFFER_PASSPHRASE: 'abc', COFFER_NEW_PASSPHRASE: 'abc' });
    const refused = short('sync');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^a new vault needs a passphrase of at least 8 characters, and COFFER_PASSPHRASE has 3\n$/);
    assert.equal(existsSync(join(remote, 'vault.json')), false, 'no vault was made');

    // A vault made before there was a minimum: opening it takes no more than its own passphrase.
    const old = new SyncEngine({
      fs: new NodeFS(t.vault),
      store: new FolderStore(remote),
      stateStore: { load: async () => null, save: async () => {} },
      passphrase: 'abc',
      config: resolveConfig({ deviceName: 'old', kdfIterations: 1000 }),
    });
    await old.sync();
    const opened = short('sync');
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(short('verify').status, 0);

    const header = () => readFileSync(join(remote, 'vault.json'), 'utf8');
    const was = header();
    const tooShort = short('change-passphrase');
    assert.equal(tooShort.status, 1);
    assert.match(tooShort.stderr, /^a new passphrase needs at least 8 characters, and COFFER_NEW_PASSPHRASE has 3\n$/);
    assert.equal(header(), was);
    const changed = bare(t.dir, ['change-passphrase', `--config=${t.config}`], { COFFER_PASSPHRASE: 'abc', COFFER_NEW_PASSPHRASE: 'eight-chars' });
    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(header(), was);
    assert.equal(bare(t.dir, ['sync', `--config=${t.config}`], { COFFER_PASSPHRASE: 'eight-chars' }).status, 0);
  } finally {
    t.done();
  }
});

test('cli: a 403 from storage says that keys which may only read need readOnly, unless it is on already', async () => {
  const server = createServer((req, res) => {
    res.statusCode = req.method === 'GET' || req.method === 'PROPFIND' ? 404 : 403;
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const dir = mkdtempSync(join(tmpdir(), 'coffer-cli-'));
  try {
    const { port } = server.address() as AddressInfo;
    const run = (sync: object) => {
      mkdirSync(join(dir, 'vault'), { recursive: true });
      const config = join(dir, 'coffer.json');
      writeFileSync(config, JSON.stringify({ vault: join(dir, 'vault'), remote: { type: 'webdav', url: `http://127.0.0.1:${port}/dav`, username: 'u' }, sync: { kdfIterations: 1000, ...sync } }));
      return bareAsync(['sync', `--config=${config}`], { COFFER_PASSPHRASE: PASSPHRASE, COFFER_WEBDAV_PASSWORD: 'x' });
    };
    const writer = await run({});
    assert.equal(writer.status, 1);
    assert.match(writer.stderr, /^WebDAV refused the login or the folder \(HTTP 403\)\nif these keys may only read, set "readOnly": true under "sync" in the config file, so this device only receives\n$/);

    server.removeAllListeners('request');
    server.on('request', (_, res) => res.writeHead(403).end());
    const reader = await run({ readOnly: true });
    assert.equal(reader.status, 1);
    assert.equal(reader.stderr, 'WebDAV refused the login or the folder (HTTP 403)\n');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: restore-at leaves alone the files deferAboveMB keeps in storage: it neither plans to remove or change them nor offers that again', async () => {
  const a = setup({ deviceName: 'laptop' });
  const b = setup({ deviceName: 'phone', deferAboveMB: 1 }, a);
  try {
    put(a.vault, 'small.md', 'one\n');
    a.cli('sync');
    big(a.vault, 'big.bin', 7);
    put(a.vault, 'small.md', 'two\n');
    a.cli('sync');
    assert.match(b.cli('sync'), /^sent 0, received 1,/);
    assert.deepEqual(files(b.vault), { 'small.md': 'two\n' });

    const dry = b.run('restore-at', '1', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\n  change      small\.md\n1 file left out of sync or in storage on this device stays as it is\.\ndry run: would bring back 0, change 1 and remove 0; nothing changed\n$/);
    assert.doesNotMatch(dry.stdout, /big\.bin/);

    const r = b.run('restore-at', '1');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /restored the vault as of \S+: brought back 0, changed 1, removed 0\nthen synced: sent 1, received 0, deleted 0 here and 0 remotely/);
    assert.deepEqual(files(b.vault), { 'small.md': 'one\n' });
    assert.match(a.cli('sync'), /^sent 0, received 1,/);
    assert.equal(statSync(join(a.vault, 'big.bin')).size, 1_300_000, 'the file stays in storage and on the other device');

    const again = b.run('restore-at', '1', '--dry-run');
    assert.match(again.stdout, /\n1 file left out of sync or in storage on this device stays as it is\.\nnothing to do: it already matches\n$/);
  } finally {
    a.done();
  }
});

test('cli: sync lists the files deferAboveMB leaves in storage, and fetch downloads the ones named and refuses any that are not left there', () => {
  const a = setup({ deviceName: 'laptop' });
  const b = setup({ deviceName: 'phone', deferAboveMB: 1 }, a);
  try {
    put(a.vault, 'small.md', 'small\n');
    big(a.vault, 'big.bin', 1);
    big(a.vault, 'ý.bin', 2);
    a.cli('sync');
    const left = /^not downloaded, over sync\.deferAboveMB \(run fetch to download\): (.*)$/gm;
    for (let i = 0; i < 2; i++) {
      const r = b.run('sync');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, i ? /^sent 0, received 0,/ : /^sent 0, received 1,/);
      assert.deepEqual([...r.stderr.matchAll(left)].map((m) => m[1]), ['big.bin', 'ý.bin']);
    }
    assert.deepEqual(files(b.vault), { 'small.md': 'small\n' });

    for (const args of [['big.bin', 'small.md'], ['nothing.bin']]) {
      const r = b.run('fetch', ...args);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^cannot fetch (small\.md|nothing\.bin): not a file left in storage by sync\.deferAboveMB; nothing was downloaded\n$/);
    }
    assert.deepEqual(Object.keys(files(b.vault)), ['small.md'], 'one that cannot be fetched stops the others');

    const got = b.run('fetch', 'big.bin', 'ý.bin'.normalize('NFD'));
    assert.equal(got.status, 0, got.stderr);
    assert.match(got.stdout, /^sent 0, received 2,/);
    assert.equal(got.stderr, '');
    assert.deepEqual(readFileSync(join(b.vault, 'big.bin')), Buffer.alloc(1_300_000, 1));
    assert.deepEqual(readFileSync(join(b.vault, 'ý.bin')), Buffer.alloc(1_300_000, 2));
    assert.equal(b.run('sync').stderr, '', 'what was fetched syncs like any other file');
    assert.match(b.run('fetch', 'big.bin').stderr, /^cannot fetch big\.bin: not a file left in storage/);

    const none = b.run('fetch');
    assert.equal(none.status, 2);
    assert.match(none.stdout, /^Usage: /);
    assert.match(none.stdout, /\n {2}fetch <path>\.\.\. +download files that sync\.deferAboveMB leaves in storage\b/);
    assert.match(none.stdout, /sync\.deferAboveMB/);
  } finally {
    a.done();
  }
});

test('cli watch: says at startup what it watches, and lists files not sent, over the limit or left in storage when that list changes, not at every sync', async () => {
  const a = setup({ deviceName: 'laptop' });
  const b = setup({ deviceName: 'phone', deferAboveMB: 1, readOnly: true }, a);
  put(a.vault, 'small.md', 'small\n');
  big(a.vault, 'big.bin', 1);
  a.cli('sync');
  const child = spawn('node', [CLI, 'watch', '--poll=0.2', '--interval=60', `--config=${b.config}`], { env: { ...process.env, COFFER_PASSPHRASE: PASSPHRASE } });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  const count = (text: string, what: RegExp) => [...text.matchAll(new RegExp(what, 'g'))].length;
  try {
    await eventually(() => out.includes('\n'));
    const [start, ...rest] = out.split('\n');
    assert.match(start, new RegExp(`^\\S+Z watching ${escaped(b.vault)} against folder ${escaped(join(a.dir, 'remote'))}, receive only; `));
    assert.match(start, /checking for changes every 0\.2s and syncing everything every 60s$/);
    assert.ok(!rest.join('').includes('watching'));

    await eventually(() => /received 1,/.test(out) && /big\.bin/.test(err));
    assert.match(err, /^\S+Z not downloaded, over sync\.deferAboveMB \(run fetch to download\): big\.bin$/m);

    writeFileSync(join(b.vault, 'mine.md'), 'mine\n');
    await eventually(() => /not sent, this device only receives: mine\.md/.test(err));
    put(a.vault, 'second.md', 'second\n');
    a.cli('sync');
    await eventually(() => count(out, /received 1,/) === 2);
    assert.equal(count(err, /mine\.md/), 1, 'the same list is not printed again by the next sync');
    assert.equal(count(err, /big\.bin/), 1);

    big(a.vault, 'big2.bin', 2);
    a.cli('sync');
    await eventually(() => /big2\.bin/.test(err));
    assert.equal(count(out, /received 1,/), 2, 'nothing was received: the list alone changed');
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  } finally {
    child.kill('SIGKILL');
    a.done();
  }
});

test('cli: a repair that found every object present says so only as far as it looked, and a flipped byte inside a pack is for --deep', () => {
  const t = setup({});
  try {
    put(t.vault, 'a.md', 'hi\n');
    writeFileSync(join(t.vault, 'blob.bin'), randomBytes(2000));
    t.cli('sync');
    const dir = join(t.dir, 'remote', 'pack');
    const [pack] = readdirSync(dir);
    const bytes = readFileSync(join(dir, pack));
    bytes[bytes.length - 100] ^= 1;
    writeFileSync(join(dir, pack), bytes);

    assert.equal(t.run('verify').status, 0, 'a listing cannot see inside a pack');
    const deepCheck = t.run('verify', '--deep');
    assert.equal(deepCheck.status, 1);
    assert.match(deepCheck.stdout, /cannot be read: .*corrupted or tampered/);
    const quick = t.run('repair');
    assert.equal(quick.status, 0, quick.stderr);
    assert.equal(quick.stdout, `${NOTHING_QUICK}\n`);
    assert.doesNotMatch(quick.stdout, /all the stored data/);

    const deep = t.run('repair', '--deep');
    assert.equal(deep.status, 0, deep.stderr);
    assert.match(deep.stdout, /^repaired: blob\.bin\nrepaired 1 file \(1 chunk stored again\), 0 still missing\n$/);
    assert.equal(t.run('verify', '--deep').status, 0);
    assert.equal(t.run('repair', '--deep').stdout, `${NOTHING_DEEP}\n`);
  } finally {
    t.done();
  }
});

test('cli: verify says which files have an earlier version that can no longer be restored, and that the current files are fine, as restore and repair then find', async () => {
  const t = setup({});
  try {
    const packs = () => readdirSync(join(t.dir, 'remote', 'pack')).sort();
    const versions: string[][] = [];
    for (let i = 1; i <= 3; i++) {
      put(t.vault, 'note.md', `version ${i}: ${randomBytes(1500).toString('hex')}\n`);
      t.cli('sync');
      versions.push(packs());
      await sleep(20);
    }
    assert.equal(t.run('verify').status, 0);
    const [second] = versions[1].filter((p) => !versions[0].includes(p));
    rmSync(join(t.dir, 'remote', 'pack', second));

    for (const args of [['verify'], ['verify', '--deep']]) {
      const r = t.run(...args);
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(
        r.stdout.replace(/\(\d+(\.\d)? MB downloaded\)/, '(0.0 MB downloaded)'),
        `problem: Pack ${second} is missing: earlier versions of 1 file cannot be restored, though the current files are fine (pack/${second})\n` +
          `  earlier versions of note.md cannot be restored\n` +
          `checked 3 commits, 1 file, 1 pack${args[1] ? ', 1 chunk (0.0 MB downloaded)' : ''}: 1 problem\n`,
      );
    }
    const restore = t.run('restore', 'note.md', '2');
    assert.equal(restore.status, 1);
    assert.match(restore.stderr, /Remote pack .* is missing/);
    const repair = t.run('repair');
    assert.equal(repair.status, 0, 'repair exits 0 for a loss of history alone, as before');
    assert.match(repair.stdout, /^earlier versions cannot be restored: note\.md\n/);
  } finally {
    t.done();
  }
});

// Shared folders with members. The owner's device runs in this process over a storage folder, a WebDAV server over that
// folder stands in for the provider (keys that write, keys that only read, and an address anyone may read), and each
// CLI device joins with a link and syncs through that server.

/** What the CLI is run with for a shared folder with members: nothing it should read, and a wrong key it must not use. */
const MEMBER_ENV = { COFFER_PASSPHRASE: '', COFFER_ACCESS_KEY: '', COFFER_SECRET_KEY: '', COFFER_WEBDAV_PASSWORD: 'wrong-key-from-the-environment' };

/** A WebDAV server over `root`. `seen` lists each request with the account that made it ('' for none); with `publicRead`, anyone may GET. */
async function davServer(root: string) {
  const accounts = new Map<string, { password: string; write: boolean }>();
  const seen: { user: string; method: string; key: string }[] = [];
  const state = { publicRead: false };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = req.method!;
      const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname).replace(/^\/dav\/?/, '').replace(/\/+$/, '');
      const file = join(root, ...key.split('/').filter(Boolean));
      const [name = '', ...pw] = Buffer.from(/^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '', 'base64').toString('utf8').split(':');
      const user = accounts.get(name)?.password === pw.join(':') ? name : '';
      seen.push({ user, method, key });
      const reply = (status: number, data?: Buffer | string, headers: Record<string, string> = {}) => {
        res.writeHead(status, headers);
        res.end(data);
      };
      if (!user && !(method === 'GET' && state.publicRead)) return reply(401);
      if (method !== 'GET' && method !== 'PROPFIND' && !accounts.get(user)?.write) return reply(403);
      if (method === 'GET') {
        if (!existsSync(file) || !statSync(file).isFile()) return reply(404);
        const data = readFileSync(file);
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
        if (!range) return reply(200, data);
        return Number(range[1]) >= data.length ? reply(416) : reply(206, data.subarray(Number(range[1]), Number(range[2]) + 1));
      }
      if (method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && existsSync(file)) return reply(412);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.concat(chunks));
        return reply(201);
      }
      if (method === 'DELETE') {
        if (!existsSync(file)) return reply(404);
        rmSync(file, { recursive: true });
        return reply(204);
      }
      if (method === 'MKCOL') {
        mkdirSync(file, { recursive: true });
        return reply(201);
      }
      if (method === 'PROPFIND' && existsSync(file)) {
        const rows = readdirSync(file)
          .filter((n) => !n.endsWith('.tmp') && statSync(join(file, n)).isFile())
          .map((n) => {
            const st = statSync(join(file, n));
            return `<d:response><d:href>/dav/${key}/${encodeURIComponent(n)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${st.size}</d:getcontentlength><d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified></d:prop></d:propstat></d:response>`;
          });
        return reply(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`, { 'content-type': 'application/xml' });
      }
      return reply(404);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav`;
  return { url, accounts, seen, state, close: () => server.close() };
}

/** A member share started by an owner's device, its storage served by `davServer`, and a way to make a CLI device for it. */
async function memberHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-cli-'));
  const remote = join(dir, 'remote');
  const dav = await davServer(remote);
  dav.accounts.set('writer', { password: 'w-pw', write: true });
  dav.accounts.set('reader', { password: 'r-pw', write: false });
  const store = new FolderStore(remote);
  const clock = { now: Date.now() };
  const keys = await createMemberShare(store, { owner: 'Vu', device: 'owner-mac', passphrase: 'owner passphrase', kdfIterations: 1000, chunk: TEST_CONFIG.chunk!, now: clock.now });
  const owner = new Device('owner-mac', store, clock, {}, keys);
  await owner.sync();
  const where = (user: string, password: string) => ({ storageType: 'webdav', webdavUrl: dav.url, webdavUser: user, webdavPassword: password });
  const link = async (name: string, role: 'write' | 'read', o: { expires?: number; folder?: string } = {}) => {
    const grant = await owner.engine.invite({ name, role, expires: o.expires ?? clock.now + 7 * DAY });
    return encodeInvite({ ...grant, storage: role === 'write' ? where('writer', 'w-pw') : where('reader', 'r-pw'), share: 'Family', folder: o.folder ?? 'Family' });
  };
  const followLink = async (name: string) => encodeFollow({ ...(await owner.engine.invite({ name, role: 'read', expires: 0 })), url: dav.url, share: 'Family', folder: 'Family' });
  const device = (name: string) => {
    const vault = join(dir, name);
    const config = join(dir, `${name}.json`);
    return {
      vault,
      config,
      keys: join(vault, '.coffer', 'keys.json'),
      run: (args: string[], env: Record<string, string> = {}) => bareAsync([...args, `--config=${config}`], { ...MEMBER_ENV, ...env }),
      join: (text: string) => bareAsync(['join', text, `--vault=${vault}`, `--config=${config}`], MEMBER_ENV),
      watch: (...args: string[]) => watching([...args, `--config=${config}`], MEMBER_ENV),
    };
  };
  const lastSigner = async () => {
    const raw = await rawRepo(store, keys);
    return (await raw.readCommit((await raw.commitSeqsAfter(0)).at(-1)!))!.signer;
  };
  return { dir, remote, dav, store, keys, owner, clock, link, followLink, device, lastSigner, done: () => (dav.close(), rmSync(dir, { recursive: true, force: true })) };
}

/** `watch` running, for a test to look at and stop. */
function watching(args: string[], env: Record<string, string>) {
  const child = spawn('node', [CLI, 'watch', ...args], { env: { ...process.env, ...env } });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  return { child, exited, out: () => out, err: () => err };
}

const WAITING = "waiting for Vu's device to confirm this device; until then it only receives";

test("cli join: a write invite writes a config with no secret in it and keys only its owner can read, waits for the owner's device, then sends signed changes", async () => {
  const h = await memberHarness();
  try {
    h.owner.fs.put('plan.md', 'v1\n');
    await h.owner.sync();
    const invite = await h.link('Lan', 'write');
    const lan = h.device('lan');
    const joined = await lan.join(invite);
    assert.equal(joined.status, 0, joined.stderr);
    assert.match(joined.stdout, /^joined “Family” as a member who writes\n/);
    assert.match(joined.stdout, /this device only receives until the owner's device confirms it/);
    assert.equal(joined.stderr, '');

    assert.deepEqual(JSON.parse(readFileSync(lan.config, 'utf8')), { vault: lan.vault, remote: { type: 'webdav', url: h.dav.url, username: 'writer' }, share: 'Family' });
    const kept = JSON.parse(readFileSync(lan.keys, 'utf8')) as { member: { id: string; master: string; key: { d: string } }; storage: object };
    assert.deepEqual(kept.storage, { webdavPassword: 'w-pw' });
    assert.equal(kept.member.id, decodeInvite(invite).member);
    if (process.platform !== 'win32') assert.equal(statSync(lan.keys).mode & 0o777, 0o600);
    const configText = readFileSync(lan.config, 'utf8');
    for (const secret of ['w-pw', kept.member.master, kept.member.key.d, decodeInvite(invite).secret]) assert.ok(!configText.includes(secret), 'the config holds no secret');
    assert.equal((await lan.run(['check'])).status, 0);

    const first = await lan.run(['sync']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^sent 0, received 1,/);
    assert.equal(first.stderr, `${WAITING}\n`);
    assert.equal(readFileSync(join(lan.vault, 'plan.md'), 'utf8'), 'v1\n');

    put(lan.vault, 'lan.md', 'by lan\n');
    const held = await lan.run(['sync']);
    assert.match(held.stdout, /^sent 0, received 0,/);
    assert.equal(held.stderr, `not sent, this device only receives: lan.md\n${WAITING}\n`);

    assert.deepEqual(await h.owner.engine.confirmJoins(), [kept.member.id]);
    const sent = await lan.run(['sync']);
    assert.match(sent.stdout, /^sent 1,/);
    assert.equal(sent.stderr, '');
    assert.equal(await h.lastSigner(), kept.member.id, 'the change is signed with the key this device made');
    await h.owner.sync();
    assert.equal(h.owner.fs.text('lan.md'), 'by lan\n');
    assert.equal((await lan.run(['verify'])).status, 0);
    assert.equal(existsSync(join(h.remote, 'dev')), false, 'no heartbeat is written into a shared folder with members');
  } finally {
    h.done();
  }
});

test('cli join: a read invite and a follow link only receive, never write to storage, and say so when asked for what would write or list', async () => {
  const h = await memberHarness();
  try {
    h.owner.fs.put('plan.md', 'v1\n');
    await h.owner.sync();
    const mai = h.device('mai');
    const joinedRead = await mai.join(await h.link('Mai', 'read'));
    assert.equal(joinedRead.status, 0, joinedRead.stderr);
    assert.match(joinedRead.stdout, /^joined “Family” as a member who reads\n/);
    assert.deepEqual(JSON.parse(readFileSync(mai.config, 'utf8')), { vault: mai.vault, remote: { type: 'webdav', url: h.dav.url, username: 'reader' }, share: 'Family', sync: { readOnly: true } });
    const synced = await mai.run(['sync']);
    assert.equal(synced.status, 0, synced.stderr);
    assert.match(synced.stdout, /^sent 0, received 1,/);
    put(mai.vault, 'mai.md', 'mine\n');
    assert.equal((await mai.run(['sync'])).stderr, 'not sent, this device only receives: mai.md\n');
    for (const [args, why] of [
      [['repair'], 'it cannot store data in storage again'],
      [['clean'], 'it does not clean up storage'],
      [['restore', 'plan.md', '1'], 'a restored file would never be sent'],
    ] as const) {
      const r = await mai.run([...args]);
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(r.stderr, `this device only receives changes, so ${why}; run ${args[0]} from a device that sends them\n`);
    }
    const passphrase = await mai.run(['change-passphrase']);
    assert.equal(passphrase.status, 1);
    assert.equal(passphrase.stderr, 'change-passphrase does not work on a shared folder with members: a device joins it with the keys of an invite and has no passphrase to change\n');
    assert.equal((await mai.run(['verify'])).status, 0);
    assert.match((await mai.run(['history', 'plan.md'])).stdout, /3 bytes/);
    assert.deepEqual(h.dav.seen.filter((r) => r.user === 'reader' && r.method !== 'GET' && r.method !== 'PROPFIND'), [], 'its key was never used to write');

    h.dav.state.publicRead = true;
    const fan = h.device('fan');
    const joinedFollow = await fan.join(await h.followLink('Fan'));
    assert.equal(joinedFollow.status, 0, joinedFollow.stderr);
    assert.match(joinedFollow.stdout, /^joined “Family” as a follower\n/);
    assert.deepEqual(JSON.parse(readFileSync(fan.config, 'utf8')), { vault: fan.vault, remote: { type: 'follow', url: h.dav.url }, share: 'Family', sync: { readOnly: true } });
    assert.deepEqual(JSON.parse(readFileSync(fan.keys, 'utf8')).storage, {});
    assert.match((await fan.run(['sync'])).stdout, /^sent 0, received 1,/);
    h.owner.fs.put('news.md', 'new\n');
    await h.owner.sync();
    const more = await fan.run(['sync']);
    assert.match(more.stdout, /^sent 0, received 1,/);
    assert.equal(readFileSync(join(fan.vault, 'news.md'), 'utf8'), 'new\n');
    assert.match((await fan.run(['history', 'news.md'])).stdout, /4 bytes/);
    assert.equal((await fan.run(['log'])).status, 0);
    for (const command of ['check', 'verify'] as const) {
      const r = await fan.run([command]);
      assert.equal(r.status, 1, command);
      assert.match(r.stderr, new RegExp(`^${command} does not work on a followed folder: it is read over its public address, which cannot be listed`));
    }
    assert.match((await fan.run(['clean'])).stderr, /^this device only receives changes/);
    const asked = h.dav.seen.filter((r) => r.user === '');
    assert.ok(asked.length > 0);
    assert.deepEqual([...new Set(asked.map((r) => r.method))], ['GET'], 'a follower only ever reads, by name, with no key');
  } finally {
    h.done();
  }
});

test('cli: a device removed from a shared folder says so and stops, and watch stops by itself', async () => {
  const h = await memberHarness();
  try {
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    await h.owner.engine.confirmJoins();
    put(lan.vault, 'lan.md', 'by lan\n');
    assert.match((await lan.run(['sync'])).stdout, /^sent 1,/);
    await h.owner.engine.removeMember(JSON.parse(readFileSync(lan.keys, 'utf8')).member.id);

    const r = await lan.run(['sync']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(
      r.stderr,
      `This device was removed from the shared folder, so it no longer syncs it\n“Family” is not synced here any more; to join it again, ask its owner for a new invite, delete ${lan.config} and ${join(lan.vault, '.coffer')} (the files in the folder stay) and run join with it\n`,
    );
    const w = lan.watch('--poll=0.2', '--interval=60');
    try {
      assert.equal(await w.exited, 1);
      assert.match(w.out(), /^\S+Z watching .*lan against WebDAV http:\/\/127\.0\.0\.1:\d+\/dav; checking for changes every 0\.2s and syncing everything every 60s\n$/);
      assert.match(w.err(), /\S+Z This device was removed from the shared folder, so it no longer syncs it\. Not watching any more\.\n\S+Z “Family” is not synced here any more/);
      assert.doesNotMatch(w.err(), /retrying/);
    } finally {
      w.child.kill('SIGKILL');
    }
  } finally {
    h.done();
  }
});

test('cli: verify finds a removed member’s earlier changes valid, on a device that joined after the removal and on the removed one', async () => {
  const h = await memberHarness();
  try {
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    await h.owner.engine.confirmJoins();
    put(lan.vault, 'lan.md', 'by lan\n');
    assert.match((await lan.run(['sync'])).stdout, /^sent 1,/);
    await h.owner.engine.removeMember(JSON.parse(readFileSync(lan.keys, 'utf8')).member.id);
    assert.equal((await lan.run(['sync'])).status, 1);
    const ann = h.device('ann');
    assert.equal((await ann.join(await h.link('Ann', 'write'))).status, 0);
    await h.owner.engine.confirmJoins();
    assert.equal((await ann.run(['sync'])).status, 0);
    for (const d of [ann, lan]) {
      for (const deep of [[], ['--deep']]) {
        const r = await d.run(['verify', ...deep]);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /^checked \d+ commits, 1 file, 1 pack.*: no problems\n$/);
      }
    }
    const repaired = await ann.run(['repair', '--deep']);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /^nothing to repair/);
  } finally {
    h.done();
  }
});

test('cli: a removed device joins its folder again with a new invite only once it deletes the sync record it was told about, and keeps its files', async () => {
  const h = await memberHarness();
  try {
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    await h.owner.engine.confirmJoins();
    put(lan.vault, 'lan.md', 'by lan\n');
    assert.match((await lan.run(['sync'])).stdout, /^sent 1,/);
    await h.owner.engine.removeMember(JSON.parse(readFileSync(lan.keys, 'utf8')).member.id);
    assert.equal((await lan.run(['sync'])).status, 1);
    put(lan.vault, 'after.md', 'written after the removal\n');

    // Joined over the old sync record, the new member would read as removed for good: it is refused, whatever else was deleted.
    const again = await h.link('Lan', 'write');
    const record = join(lan.vault, '.coffer');
    rmSync(lan.config);
    rmSync(lan.keys);
    const refused = await lan.join(again);
    assert.equal(refused.status, 1);
    assert.equal(
      refused.stderr,
      `${lan.vault} holds the sync record of an earlier sync or join (${record}); to join into this folder again, delete ${record} first (the files stay, and any that differ from the shared folder's are kept as conflict copies), or pass --vault=<folder> to join into another folder\n`,
    );
    assert.equal(existsSync(lan.config), false, 'nothing was written');

    rmSync(record, { recursive: true });
    assert.equal((await lan.join(again)).status, 0);
    assert.equal(existsSync(join(lan.vault, 'after.md')), true, 'the files stay');
    await h.owner.engine.confirmJoins();
    const first = await lan.run(['sync']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^sent 1, received 0,/);
    assert.equal(first.stderr, '');
    await h.owner.sync();
    assert.equal(h.owner.fs.text('after.md'), 'written after the removal\n');
    assert.equal((await lan.run(['sync'])).status, 0, 'it syncs like any member now');
  } finally {
    h.done();
  }
});

test('cli: a writing device that is not confirmed, or was removed, refuses what writes or would never be sent, as one set to only receive does', async () => {
  const h = await memberHarness();
  try {
    h.owner.fs.put('plan.md', 'v1\n');
    await h.owner.sync();
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    assert.match((await lan.run(['sync'])).stdout, /^sent 0, received 1,/);
    const seq = /^\s*(\d+)\s/.exec((await lan.run(['history', 'plan.md'])).stdout)![1];
    writeFileSync(join(lan.vault, 'plan.md'), 'kept as it is\n');

    for (const [args, why] of [
      [['clean'], 'it does not clean up storage'],
      [['repair'], 'it cannot store data in storage again'],
      [['restore', 'plan.md', seq], 'a restored file would never be sent'],
      [['restore-at', seq], 'a restore would never be sent'],
    ] as const) {
      const r = await lan.run([...args]);
      assert.equal(r.status, 1, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
      assert.equal(r.stderr, `this device only receives until Vu's device confirms it, so ${why}; run ${args[0]} once it may send them\n`);
    }
    assert.equal(readFileSync(join(lan.vault, 'plan.md'), 'utf8'), 'kept as it is\n', 'a refused restore wrote nothing');
    const dry = await lan.run(['restore-at', seq, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);

    assert.deepEqual(await h.owner.engine.confirmJoins(), [JSON.parse(readFileSync(lan.keys, 'utf8')).member.id]);
    assert.equal((await lan.run(['sync'])).status, 0);
    assert.equal((await lan.run(['clean'])).status, 0, 'confirmed, it may');

    await h.owner.engine.removeMember(JSON.parse(readFileSync(lan.keys, 'utf8')).member.id);
    assert.equal((await lan.run(['sync'])).status, 1);
    const gone = await lan.run(['clean']);
    assert.equal(gone.status, 1);
    assert.equal(gone.stdout, '');
    assert.match(gone.stderr, /^This device was removed from the shared folder, so it no longer syncs it\n“Family” is not synced here any more; to join it again, ask its owner for a new invite, delete /);
  } finally {
    h.done();
  }
});

test('cli: storage keys that storage no longer accepts say, for a shared folder, that the owner may have given everyone new ones', async () => {
  const h = await memberHarness();
  try {
    h.owner.fs.put('plan.md', 'v1\n');
    await h.owner.sync();
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    assert.equal((await lan.run(['sync'])).status, 0);
    h.dav.accounts.delete('writer');
    const r = await lan.run(['sync']);
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      `WebDAV refused the login or the folder (HTTP 401)\nthe storage refused the keys this device holds for “Family”; if the owner gave everyone new storage keys since this device last synced, those no longer work, so ask for a new invite, delete ${lan.config} and ${join(lan.vault, '.coffer')} (the files in the folder stay) and run join with it\n`,
    );
  } finally {
    h.done();
  }
});

test('cli: a change in a shared folder that no member made stops the sync with the reason, and syncing carries on once the owner removes it', async () => {
  const h = await memberHarness();
  try {
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    await h.owner.engine.confirmJoins();
    h.owner.fs.put('a.md', 'a\n');
    await h.owner.sync();
    assert.match((await lan.run(['sync'])).stdout, /^sent 0, received 1,/);

    const raw = await rawRepo(h.store, h.keys);
    const last = (await raw.commitSeqsAfter(0)).at(-1)!;
    writeFileSync(join(h.remote, seqKey('log', last + 1)), randomBytes(300));
    put(lan.vault, 'lan.md', 'by lan\n');
    const stuck = await lan.run(['sync']);
    assert.equal(stuck.status, 1);
    assert.equal(stuck.stdout, '');
    assert.match(stuck.stderr, new RegExp(`^Commit ${last + 1} in storage was not made by a member who may write to this shared folder: .*\\n“Family” stays as it was here: this device applies nothing from that change on, and syncs again once the owner has removed it from storage\\n$`));

    // A watch says so each time it tries again, with the reason, and carries on trying.
    const w = lan.watch('--poll=0.2', '--interval=60');
    try {
      await eventually(() => /retrying in 5s\n\S+Z “Family” stays as it was here/.test(w.err()));
      assert.match(w.err(), new RegExp(`\\S+Z sync failed: Commit ${last + 1} in storage was not made by a member who may write to this shared folder: .*; retrying in 5s\\n`));
      assert.equal(w.child.exitCode, null);
    } finally {
      w.child.kill('SIGKILL');
    }
    await assert.rejects(h.owner.sync());
    assert.deepEqual(await h.owner.engine.removeUnverifiable(), [last + 1]);
    const again = await lan.run(['sync']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^sent 1,/);
    await h.owner.sync();
    assert.equal(h.owner.fs.text('lan.md'), 'by lan\n');
  } finally {
    h.done();
  }
});

test('cli: new storage keys from the owner are used once they are shown to work, and until then the old ones stay', async () => {
  const h = await memberHarness();
  try {
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    await h.owner.engine.confirmJoins();
    const keysNow = () => JSON.parse(readFileSync(lan.keys, 'utf8')) as { storage: object };
    const configBefore = readFileSync(lan.config, 'utf8');

    // Keys the provider does not know (yet): said once, and nothing changes.
    await h.owner.engine.writeRekey({ write: { webdavUser: 'writer2', webdavPassword: 'w2-pw' } });
    const refused = await lan.run(['sync']);
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stderr, /^the owner sent new storage keys, but they do not work here \(WebDAV refused the login or the folder \(HTTP 401\)\); this device keeps the ones it has\n$/);
    assert.deepEqual(keysNow().storage, { webdavPassword: 'w-pw' });
    assert.equal((await lan.run(['sync'])).stderr, refused.stderr, 'each run that cannot use them says so, and tries them again');
    const w = lan.watch('--poll=0.2', '--interval=60');
    try {
      await eventually(() => w.err().includes('keeps the ones it has'));
      for (const [i, name] of ['one.md', 'two.md'].entries()) {
        put(lan.vault, name, `${name}\n`);
        await eventually(() => w.out().split('\n').filter((l) => / sent 1,/.test(l)).length === i + 1);
      }
      assert.equal(w.err().split('keeps the ones it has').length - 1, 1, 'a watch says so once, not at every sync');
    } finally {
      w.child.kill('SIGKILL');
    }

    h.dav.accounts.set('writer2', { password: 'w2-pw', write: true });
    const switched = await lan.run(['sync']);
    assert.equal(switched.status, 0, switched.stderr);
    assert.equal(switched.stderr, 'the owner sent new storage keys, and this device now uses them\n');
    assert.deepEqual(keysNow().storage, { webdavUser: 'writer2', webdavPassword: 'w2-pw' });
    assert.equal(readFileSync(lan.config, 'utf8'), configBefore, 'the config file is not touched');
    if (process.platform !== 'win32') assert.equal(statSync(lan.keys).mode & 0o777, 0o600);

    // The old keys are gone at the provider, and nothing notices.
    h.dav.accounts.delete('writer');
    h.owner.fs.put('after.md', 'after\n');
    await h.owner.sync();
    const after = await lan.run(['sync']);
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /^sent 0, received 1,/);
    assert.equal(after.stderr, '');
    assert.ok(h.dav.seen.some((r) => r.user === 'writer2' && r.method === 'GET'));
    assert.equal((await lan.run(['sync'])).stderr, '', 'the offer taken is not offered again');
  } finally {
    h.done();
  }
});

test('cli join: what it refuses leaves the invite unused and nothing behind', async () => {
  const h = await memberHarness();
  try {
    const none = await bareAsync(['join', `--config=${join(h.dir, 'x.json')}`], MEMBER_ENV);
    assert.equal(none.status, 2);
    assert.equal(none.stderr, 'join takes the link to join with on standard input: join - [--vault=<folder>], or in COFFER_LINK\n');
    const lan = h.device('lan');
    for (const [text, why] of [
      ['coffershare2.abcdefgh', /^join takes an invite to a shared folder with members \(it starts with coffershare3\.\) or a follow link \(cofferfollow1\.\); a link that starts with coffershare2\. is for the Obsidian plugin\n$/],
      ['hello', /^That is not a link join can use: it starts with coffershare3\. for an invite and cofferfollow1\. for a follow link\n$/],
      ['coffershare3.bm90LWpzb24', /^That is not an invite link to a shared folder, or it was cut short when it was copied\n$/],
    ] as const) {
      const r = await lan.join(text);
      assert.equal(r.status, 1, text);
      assert.match(r.stderr, why);
    }
    const named = async (storage: Record<string, unknown>) =>
      encodeInvite({ ...(await h.owner.engine.invite({ name: 'Ned', role: 'read', expires: h.clock.now + DAY })), storage, share: 'Family', folder: 'Family' });
    for (const [storage, why] of [
      [{}, /^That invite does not say where the shared folder is stored in a way this version can read\n$/],
      [{ storageType: 'webdav', webdavUrl: 'ftp://example.com/x', webdavPassword: 'p' }, /^That invite does not say where/],
      [{ storageType: 's3', endpoint: 'https://s3.example.com', bucket: 'b' }, /^That invite carries no keys for the storage it names\n$/],
    ] as const) {
      const r = await lan.join(await named(storage));
      assert.equal(r.status, 1, JSON.stringify(storage));
      assert.match(r.stderr, why);
    }
    assert.deepEqual(readdirSync(h.dir).sort(), ['remote']);

    // A config that exists, or keys already in the folder, are refused before the invite is touched: it still joins.
    const invite = await h.link('Lan', 'write');
    writeFileSync(lan.config, '{}');
    const clash = await lan.join(invite);
    assert.equal(clash.status, 1);
    assert.equal(clash.stderr, `config file ${lan.config} exists already; pass --config=<file> to write another\n`);
    assert.equal(readFileSync(lan.config, 'utf8'), '{}');
    assert.equal(existsSync(lan.vault), false);
    rmSync(lan.config);
    assert.equal((await lan.join(invite)).status, 0);
    const twice = await bareAsync(['join', invite, `--vault=${lan.vault}`, `--config=${join(h.dir, 'again.json')}`], MEMBER_ENV);
    assert.equal(twice.status, 1);
    assert.equal(twice.stderr, `${lan.vault} already holds the keys of a shared folder; pass --vault=<folder> to join into another folder\n`);
    assert.equal(existsSync(join(h.dir, 'again.json')), false);

    // One invite adds one device.
    const other = h.device('other');
    const used = await other.join(invite);
    assert.equal(used.status, 1);
    assert.match(used.stderr, /^This invite was already used on another device\. Ask for a new one/);
    assert.equal(existsSync(other.config) || existsSync(other.vault), false);

    const old = await h.link('Old', 'read', { expires: Date.now() + 1 });
    await sleep(20);
    const expired = await h.device('old').join(old);
    assert.equal(expired.status, 1);
    assert.match(expired.stderr, /^This invite has expired\. Ask for a new one\./);
  } finally {
    h.done();
  }
});

test('cli join: takes the link from standard input or COFFER_LINK, bare or in the obsidian:// link the plugin copies', async () => {
  const h = await memberHarness();
  try {
    const wrapped = (code: string) => `obsidian://coffer?share=${encodeURIComponent(code)}`;
    const lan = h.device('lan');
    const r = await bareAsync(['join', '-', `--vault=${lan.vault}`, `--config=${lan.config}`], MEMBER_ENV, undefined, `${wrapped(await h.link('Lan', 'write'))}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^joined “Family” as a member who writes\n/);
    h.dav.state.publicRead = true;
    const mai = h.device('mai');
    const m = await bareAsync(['join', `--vault=${mai.vault}`, `--config=${mai.config}`], { ...MEMBER_ENV, COFFER_LINK: wrapped(await h.followLink('Readers')) });
    assert.equal(m.status, 0, m.stderr);
    assert.match(m.stdout, /^joined “Family” as a follower\n/);
    const empty = await bareAsync(['join', '-', `--config=${join(h.dir, 'x.json')}`], MEMBER_ENV, undefined, '');
    assert.equal(empty.status, 2);
  } finally {
    h.done();
  }
});

test('cli join: a WebDAV address and password are taken as the plugin takes them, spaces and all', () => {
  const at = placeOf({ storageType: 'webdav', webdavUrl: ' https://cloud.example/remote.php/dav/files/me/My Notes/coffer ', webdavUser: ' me ', webdavPassword: ' pa ss ' });
  assert.deepEqual(at, {
    remote: { type: 'webdav', url: 'https://cloud.example/remote.php/dav/files/me/My Notes/coffer', username: 'me' },
    creds: { webdavPassword: ' pa ss ' },
  });
  assert.throws(() => placeOf({ storageType: 'webdav', webdavUrl: 'https:// x', webdavPassword: 'p' }), /does not say where/);
  assert.throws(() => placeOf({ storageType: 'webdav', webdavUrl: 'https://x', webdavPassword: '' }), /carries no keys/);
});

test('cli join: the folder is the name the link suggests, here, and a name from a link never leads out of the folder it is run in', async () => {
  const h = await memberHarness();
  const cwd = join(h.dir, 'here');
  mkdirSync(cwd);
  // The CLI sees the folder it runs in by its real path.
  const real = realpathSync(cwd);
  try {
    h.owner.fs.put('plan.md', 'v1\n');
    await h.owner.sync();
    const r = await bareAsync(['join', await h.link('Mai', 'read')], MEMBER_ENV, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^joined “Family” as a member who reads\\n  folder  ${escaped(join(real, 'Family'))}\\n  config  ${escaped(join(real, 'coffer.json'))}\\n`));
    assert.match(r.stdout, new RegExp(`next: sync --config=${escaped(join(real, 'coffer.json'))}\\n$`));
    const sync = await bareAsync(['sync'], MEMBER_ENV, cwd);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(readFileSync(join(cwd, 'Family', 'plan.md'), 'utf8'), 'v1\n');

    const hostile = await bareAsync(['join', await h.link('Fay', 'read', { folder: '../../etc' }), `--config=${join(cwd, 'fay.json')}`], MEMBER_ENV, cwd);
    assert.equal(hostile.status, 0, hostile.stderr);
    assert.equal(JSON.parse(readFileSync(join(cwd, 'fay.json'), 'utf8')).vault, join(real, 'etc'));
    rmSync(join(cwd, 'Family'), { recursive: true });
    const nameless = await bareAsync(['join', await h.link('Jo', 'read', { folder: 'a:b' }), `--config=${join(cwd, 'jo.json')}`], MEMBER_ENV, cwd);
    assert.equal(nameless.status, 0, 'the share name is used when the folder name will not do');
    assert.equal(JSON.parse(readFileSync(join(cwd, 'jo.json'), 'utf8')).vault, join(real, 'Family'));
  } finally {
    h.done();
  }
});

test('cli watch: a member waiting for the owner says so once, and sends what it held back once the owner confirms it', async () => {
  const h = await memberHarness();
  try {
    h.owner.fs.put('plan.md', 'v1\n');
    await h.owner.sync();
    const lan = h.device('lan');
    assert.equal((await lan.join(await h.link('Lan', 'write'))).status, 0);
    const w = lan.watch('--poll=0.2', '--interval=60');
    try {
      await eventually(() => w.out().includes('received 1'));
      put(lan.vault, 'lan.md', 'by lan\n');
      await eventually(() => w.err().includes('not sent, this device only receives: lan.md'));
      await sleep(600);
      assert.equal(w.err().split(WAITING).length - 1, 1, 'said once, not at every sync');

      await h.owner.engine.confirmJoins();
      await eventually(() => w.out().split('\n').some((l) => / sent 1, received 0,/.test(l)));
      await h.owner.sync();
      assert.equal(h.owner.fs.text('lan.md'), 'by lan\n');
      w.child.kill('SIGTERM');
      assert.equal(await w.exited, 0);
      assert.equal(w.err().split(WAITING).length - 1, 1);
    } finally {
      w.child.kill('SIGKILL');
    }
  } finally {
    h.done();
  }
});

test('cli: a shared folder whose keys file is gone or damaged says so instead of asking for a passphrase', async () => {
  const h = await memberHarness();
  try {
    const mai = h.device('mai');
    assert.equal((await mai.join(await h.link('Mai', 'read'))).status, 0);
    const kept = readFileSync(mai.keys, 'utf8');
    rmSync(mai.keys);
    const gone = await mai.run(['sync']);
    assert.equal(gone.status, 1);
    assert.equal(gone.stderr, `the keys of this shared folder are not here: ${mai.keys} is missing. Join it again with a new invite\n`);
    writeFileSync(mai.keys, '{"member":{"repo":"x"}}');
    assert.equal((await mai.run(['sync'])).stderr, `the keys file ${mai.keys} is damaged. Join the shared folder again with a new invite\n`);
    writeFileSync(mai.keys, kept);
    assert.equal((await mai.run(['sync'])).status, 0);
    const config = { ...JSON.parse(readFileSync(mai.config, 'utf8')), share: 5 };
    writeFileSync(mai.config, JSON.stringify(config));
    assert.equal((await mai.run(['sync'])).stderr, `config file ${mai.config} needs "share" to be the name of the shared folder, as join writes it\n`);
  } finally {
    h.done();
  }
});
