import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncConfig } from '../src/core/config.ts';
import { listDevices, writeHeartbeat } from '../src/core/devices.ts';
import { BranchClosedError, UpgradeBlockedError } from '../src/core/engine.ts';
import { planMerge, takeRows, versionAtLeast, type Branch } from '../src/core/lines.ts';
import { Repo } from '../src/core/repo.ts';
import type { Entry } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { DAY, Device, TEST_CONFIG } from './helpers.ts';

const MINUTE = 60_000;
const MB = 1 << 20;

function setup(config: Partial<SyncConfig> = {}) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  return { clock, mem, net, a: new Device('A', net, clock, config), b: new Device('B', net, clock, config) };
}

async function ok(d: Device) {
  const r = await d.sync();
  assert.deepEqual(r.errors, []);
  return r;
}

/** A vault with `files`, synced to both devices and upgraded for branches. */
async function vault(files: Record<string, string | Uint8Array>, config: Partial<SyncConfig> = {}) {
  const s = setup(config);
  for (const [path, data] of Object.entries(files)) s.a.fs.put(path, data);
  await ok(s.a);
  await ok(s.b);
  await s.a.engine.upgrade();
  return s;
}

async function start(d: Device, name: string): Promise<Branch> {
  await ok(d);
  return d.engine.startBranch(name);
}

async function go(d: Device, to?: Branch) {
  await d.engine.switchLine(to);
  return ok(d);
}

async function merge(d: Device, b: Branch) {
  await ok(d);
  const draft = await d.engine.mergePlan(b);
  const res = await d.engine.mergeApply(draft);
  await ok(d);
  return { draft, res };
}

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

const files = (d: Device) => Object.fromEntries([...d.fs.files.keys()].sort().map((p) => [p, d.fs.text(p)]));

test('versions compare by their numbers', () => {
  assert.ok(versionAtLeast('0.12.0', '0.12.0'));
  assert.ok(versionAtLeast('1.0.0', '0.12.0'));
  assert.ok(versionAtLeast('0.12.1-beta', '0.12.0'));
  assert.ok(!versionAtLeast('0.11.9', '0.12.0'));
  assert.ok(!versionAtLeast('0.9.12', '0.12.0'));
  assert.ok(!versionAtLeast('dev', '0.12.0'));
});

test('the vault is upgraded only once no device record names an older version, and a branch needs the upgrade', async () => {
  const { a, b, mem } = setup();
  a.fs.put('note.md', 'one\n');
  await ok(a);
  await ok(b);
  await writeHeartbeat(await b.engine.view(), { platform: 'test', version: '0.11.1' });
  await assert.rejects(a.engine.startBranch('trip'), /not been upgraded/);
  await assert.rejects(a.engine.upgrade(), (e: unknown) => e instanceof UpgradeBlockedError && e.devices.length === 1 && e.devices[0].name === 'B');
  assert.equal((await Repo.header(mem))!.format, 1);
  assert.deepEqual(await a.engine.branches(), { upgraded: false, branches: [] });

  await writeHeartbeat(await b.engine.view(), { platform: 'test', version: '0.12.0' });
  await a.engine.upgrade();
  assert.equal((await Repo.header(mem))!.format, 3);
  // B opened the vault before the upgrade: it finds out when it asks.
  assert.equal((await b.engine.branches()).upgraded, true);
  await b.engine.startBranch('trip');
  // A second upgrade is nothing.
  await a.engine.upgrade();
});

test('a vault of a newer format than this version reads is refused and nothing is written', async () => {
  const { a, mem } = setup();
  a.fs.put('note.md', 'one\n');
  await ok(a);
  const header = (await Repo.header(mem))!;
  await mem.put('vault.json', new TextEncoder().encode(JSON.stringify({ ...header, format: 4 })));
  const before = (await mem.list('')).length;
  const c = new Device('C', mem, a.clock);
  await assert.rejects(c.sync(), /format 4/);
  assert.equal((await mem.list('')).length, before);
});

test('a branch diverges from the main line, and a device takes the files of the line it switches to', async () => {
  const { a, b } = await vault({ 'note.md': 'one\n', 'gone.md': 'x\n', 'same.md': 'same\n' });
  const trip = await start(a, 'Trip');
  assert.deepEqual((await a.engine.branches()).current, trip.id);
  a.fs.put('note.md', 'one\nbranch\n');
  a.fs.put('new.md', 'new\n');
  await a.fs.remove('gone.md');
  await ok(a);

  // The main line has none of it.
  b.fs.put('main.md', 'main\n');
  await ok(b);
  assert.deepEqual(files(b), { 'gone.md': 'x\n', 'main.md': 'main\n', 'note.md': 'one\n', 'same.md': 'same\n' });

  const r = await go(b, trip);
  assert.deepEqual(files(b), { 'new.md': 'new\n', 'note.md': 'one\nbranch\n', 'same.md': 'same\n' });
  assert.deepEqual(r.conflictCopies, []);
  await go(a);
  assert.deepEqual(files(a), { 'gone.md': 'x\n', 'main.md': 'main\n', 'note.md': 'one\n', 'same.md': 'same\n' });
  await go(a, trip);
  assert.deepEqual(files(a), files(b));

  // The two devices sync with each other on the branch.
  b.fs.put('new.md', 'new\nfrom B\n');
  await ok(b);
  await ok(a);
  assert.equal(a.fs.text('new.md'), 'new\nfrom B\n');
  // A restart stays on the branch.
  a.restart();
  await ok(a);
  assert.equal((await a.engine.branches()).current, trip.id);
  assert.deepEqual(files(a), files(b));
});

test('switching to a line with far fewer files is not stopped as a mass deletion, and sends no deletion', async () => {
  const { a, b } = await vault({ 'keep.md': 'keep\n' });
  const big = await start(a, 'big');
  for (let i = 0; i < 40; i++) a.fs.put(`many/${i}.md`, `file ${i}\n`);
  await ok(a);
  const r = await go(a);
  assert.equal(r.deletedLocal, 40);
  assert.equal(r.deletedRemote, 0);
  assert.deepEqual(files(a), { 'keep.md': 'keep\n' });
  await go(b, big);
  assert.equal(b.fs.files.size, 41);
});

test('an edit made here and not sent when the device switches is merged into the line it goes to', async () => {
  const { a } = await vault({ 'note.md': 'one\ntwo\nthree\n' });
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'one\ntwo\nthree\nbranch\n');
  await ok(a);
  a.fs.put('note.md', 'ONE\ntwo\nthree\nbranch\n');
  // Not synced: the switch itself only changes the state.
  await a.engine.switchLine();
  const r = await ok(a);
  assert.equal(r.merged, 1);
  assert.equal(a.fs.text('note.md'), 'ONE\ntwo\nthree\n');
  await go(a, trip);
  assert.equal(a.fs.text('note.md'), 'one\ntwo\nthree\nbranch\n');
});

test('a switch cut short after it changed files, and before that was saved, sends none of them when the device switches back', async () => {
  const { a, b, clock, mem } = await vault({ 'note.md': 'main\n', 'only-main.md': 'x\n' });
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'branch\n');
  a.fs.put('only-branch.md', 'y\n');
  await a.fs.remove('only-main.md');
  await ok(a);
  // B switches, its sync changes the files, and the app is closed before the state is saved.
  await b.engine.switchLine(trip);
  const save = b.state.save.bind(b.state);
  b.state.save = (data) => (b.fs.text('note.md') === 'branch\n' ? Promise.reject(new Error('killed')) : save(data));
  await assert.rejects(b.sync(), /killed/);
  b.state.save = save;
  assert.deepEqual(files(b), { 'note.md': 'branch\n', 'only-branch.md': 'y\n' });
  b.restart();
  await b.engine.switchLine();
  const r = await ok(b);
  assert.equal(r.pushed + r.deletedRemote, 0);
  assert.deepEqual(files(b), { 'note.md': 'main\n', 'only-main.md': 'x\n' });
  const c = new Device('C', mem, clock);
  await ok(c);
  assert.deepEqual(files(c), { 'note.md': 'main\n', 'only-main.md': 'x\n' });
  // An edit really made on the branch and not sent still comes along.
  await go(b, trip);
  b.fs.put('note.md', 'branch\nedited here\n');
  await b.engine.switchLine();
  await ok(b);
  // Next to a line the main line changed, so both versions are kept.
  assert.ok(Object.values(files(b)).some((text) => /edited here/.test(text!)));
  assert.equal(b.fs.text('note.md'), 'main\n');
});

test('a file edited after a switch was cut short does not replace the first line’s version when the device goes back', async () => {
  const { a, b, clock, mem } = await vault({ 'note.md': 'one\ntwo\nthree\n' });
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'one\nthree\nbranch\n');
  await ok(a);
  // The main line gains a line the branch never had.
  b.fs.put('note.md', 'one\ntwo\nthree\nonly on main\n');
  await ok(b);
  await b.engine.switchLine(trip);
  const save = b.state.save.bind(b.state);
  b.state.save = (data) => (b.fs.text('note.md') === 'one\nthree\nbranch\n' ? Promise.reject(new Error('killed')) : save(data));
  await assert.rejects(b.sync(), /killed/);
  b.state.save = save;
  b.restart();
  // Edited before any sync finishes, then back to the main line.
  b.fs.put('note.md', 'one\nthree\nbranch\nedited\n');
  await b.engine.switchLine();
  const r = await ok(b);
  assert.equal(b.fs.text('note.md'), 'one\ntwo\nthree\nonly on main\n');
  assert.equal(r.conflictCopies.length, 1);
  assert.equal(b.fs.text(r.conflictCopies[0]), 'one\nthree\nbranch\nedited\n');
  const c = new Device('C', mem, clock);
  await ok(c);
  assert.equal(c.fs.text('note.md'), 'one\ntwo\nthree\nonly on main\n');
  // Once a sync has finished cleanly, an edit made here is an edit of what the record says again, and merges.
  b.fs.put('note.md', 'one\ntwo\nthree\nonly on main\nmore from here\n');
  await b.engine.switchLine();
  b.fs.put('other.md', 'x\n');
  await ok(b);
  assert.equal(c.fs.text('note.md'), 'one\ntwo\nthree\nonly on main\n');
  await ok(c);
  assert.equal(c.fs.text('note.md'), 'one\ntwo\nthree\nonly on main\nmore from here\n');
});

test('merging a branch takes its changes, combines notes changed on both lines, and keeps both of what cannot be combined', async () => {
  const pic = random(3000, 1);
  const { a, b } = await vault({ 'note.md': 'one\ntwo\nthree\nfour\n', 'theirs.md': 't\n', 'ours.md': 'o\n', 'drop.md': 'd\n', 'pic.png': pic, 'edited-here.md': 'e\n', 'edited-there.md': 'e\n' });
  const trip = await start(a, 'Trip');
  a.fs.put('note.md', 'one\ntwo\nthree\nfour\nbranch\n');
  a.fs.put('theirs.md', 't\nmore\n');
  a.fs.put('added.md', 'added\n');
  a.fs.put('pic.png', random(3000, 2));
  a.fs.put('edited-there.md', 'e\nkept\n');
  await a.fs.remove('drop.md');
  await a.fs.remove('edited-here.md');
  await ok(a);

  b.fs.put('note.md', 'ONE\ntwo\nthree\nfour\n');
  b.fs.put('ours.md', 'o\nmore\n');
  b.fs.put('pic.png', random(3000, 3));
  b.fs.put('edited-here.md', 'e\nkept\n');
  await b.fs.remove('edited-there.md');
  const { draft, res } = await merge(b, trip);
  assert.equal(draft.from, 'Trip');
  assert.deepEqual(res.skipped, []);
  assert.equal(res.merged, 1);
  assert.equal(res.removed, 1);
  assert.equal(res.copies.length, 1);
  assert.match(res.copies[0], /^pic \(conflict Trip \d{8}-\d{6}\)\.png$/);
  assert.equal(b.fs.text('note.md'), 'ONE\ntwo\nthree\nfour\nbranch\n');
  assert.equal(b.fs.text('theirs.md'), 't\nmore\n');
  assert.equal(b.fs.text('ours.md'), 'o\nmore\n');
  assert.equal(b.fs.text('added.md'), 'added\n');
  assert.ok(!b.fs.files.has('drop.md'));
  // An edit wins over a deletion, whichever line made it.
  assert.equal(b.fs.text('edited-here.md'), 'e\nkept\n');
  assert.equal(b.fs.text('edited-there.md'), 'e\nkept\n');
  assert.deepEqual(b.fs.files.get('pic.png')!.data, random(3000, 3));
  assert.deepEqual(b.fs.files.get(res.copies[0])!.data, random(3000, 2));

  // Again at once: nothing more.
  const again = await merge(b, trip);
  assert.deepEqual({ ...again.res, commitSeq: undefined }, { taken: 0, removed: 0, merged: 0, copies: [], skipped: [], commitSeq: undefined });
  assert.deepEqual([again.draft.take, again.draft.merged, again.draft.copies], [[], [], []]);

  // The branch goes on, takes the main line's changes, and merges back a second time without doubling anything.
  a.fs.put('added.md', 'added\nsecond\n');
  const up = await merge(a, trip);
  assert.equal(up.draft.from, 'main');
  assert.equal(a.fs.text('note.md'), 'ONE\ntwo\nthree\nfour\nbranch\n');
  assert.equal(a.fs.text('ours.md'), 'o\nmore\n');
  assert.equal(a.fs.text('added.md'), 'added\nsecond\n');
  assert.deepEqual(a.fs.files.get('pic.png')!.data, random(3000, 3));
  b.fs.put('ours.md', 'o\nmore\nthird\n');
  const back = await merge(b, trip);
  assert.deepEqual(back.res.copies, []);
  assert.equal(b.fs.text('added.md'), 'added\nsecond\n');
  assert.equal(b.fs.text('ours.md'), 'o\nmore\nthird\n');
  await merge(a, trip);
  assert.deepEqual(files(a), files(b));
});

test('a file moved on one line takes the other line’s edit to its new name, and a folder moved whole takes new files with it', async () => {
  const { a, b } = await vault({ 'Old/a.md': 'alpha\nbeta\n', 'Old/b.md': 'bravo\n', 'solo.md': 'solo text\n', 'theirs.md': 'theirs text\n' });
  const tidy = await start(a, 'tidy');
  // The branch moves a folder and a file; the main line edits them and adds to the folder.
  for (const name of ['a.md', 'b.md']) await a.fs.rename(`Old/${name}`, `New/${name}`);
  await a.fs.rename('solo.md', 'Kept/solo.md');
  a.fs.put('theirs.md', 'theirs text\nedited on the branch\n');
  await ok(a);
  b.fs.put('Old/a.md', 'alpha\nbeta\nedited on main\n');
  b.fs.put('Old/extra.md', 'extra\n');
  b.fs.put('solo.md', 'solo text\nedited on main\n');
  await b.fs.rename('theirs.md', 'Moved/theirs.md');

  const { res } = await merge(b, tidy);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(files(b), {
    'Kept/solo.md': 'solo text\nedited on main\n',
    'Moved/theirs.md': 'theirs text\nedited on the branch\n',
    'New/a.md': 'alpha\nbeta\nedited on main\n',
    'New/b.md': 'bravo\n',
    'New/extra.md': 'extra\n',
  });
  // And the other way round gives the branch the same files.
  await merge(a, tidy);
  assert.deepEqual(files(a), files(b));
});

test('planMerge leaves alone what only we changed and never joins two files that merely look alike', () => {
  const e = (id: string): Entry => ({ size: 5, mtime: 1, chunks: [{ id, pack: 'p', off: 0, len: 5, size: 5 }] });
  const base = new Map([['a.md', e('x')], ['b.md', e('x')], ['c.md', e('c')]]);
  // Two files with the same content moved: which went where cannot be told, so paths decide.
  const theirs = new Map([['A/a.md', e('x')], ['B/b.md', e('x')], ['c.md', e('c')]]);
  const ours = new Map([['a.md', e('x2')], ['b.md', e('x')], ['c.md', e('c2')]]);
  const plan = planMerge(base, ours, theirs);
  assert.deepEqual(plan.both, []);
  assert.deepEqual(plan.take.map((t) => [t.path, !!t.entry]), [['b.md', false], ['A/a.md', true], ['B/b.md', true]]);
  // Read as rows: with two files of that content come, which one the gone file became cannot be told.
  assert.deepEqual(takeRows(plan.take).map((r) => r.kind), ['remove', 'add', 'add']);
  const moved = planMerge(new Map([['old/c.md', e('c')]]), new Map([['old/c.md', e('c')]]), new Map([['new/c.md', e('c')]]));
  assert.deepEqual(takeRows(moved.take), [{ kind: 'move', path: 'old/c.md', to: 'new/c.md' }]);
});

test('a merge downloads nothing for the versions it takes, and a file left in storage stays there', async () => {
  const { a, b, net } = await vault({ 'note.md': 'one\n' }, {});
  const c = new Device('C', net, a.clock, { deferAboveMB: 1 });
  await ok(c);
  const media = await start(a, 'media');
  a.fs.put('big.bin', random(2 * MB, 7));
  a.fs.put('small.md', 'small\n');
  await ok(a);

  await ok(c);
  net.reset();
  const draft = await c.engine.mergePlan(media);
  const res = await c.engine.mergeApply(draft);
  assert.equal(res.taken, 2);
  assert.ok(net.stats.down < 64 << 10, `downloaded ${net.stats.down} bytes`);
  assert.ok(net.stats.up < 64 << 10, `uploaded ${net.stats.up} bytes`);
  const r = await ok(c);
  assert.deepEqual(r.deferred, ['big.bin']);
  assert.ok(!c.fs.files.has('big.bin'));
  assert.equal(c.fs.text('small.md'), 'small\n');
  // Another device on the main line gets the file itself.
  await ok(b);
  assert.deepEqual(b.fs.files.get('big.bin')!.data, random(2 * MB, 7));
});

test('a change this line makes after a merge was worked out is not overwritten: that file is left for the next merge', async () => {
  const { a, b } = await vault({ 'note.md': 'one\ntwo\nthree\n', 'other.md': 'o\n' });
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'one\ntwo\nthree\nbranch\n');
  a.fs.put('other.md', 'o\nbranch\n');
  await ok(a);
  await ok(b);
  const draft = await b.engine.mergePlan(trip);
  b.fs.put('note.md', 'ONE\ntwo\nthree\n');
  await ok(b);
  const res = await b.engine.mergeApply(draft);
  assert.deepEqual(res.skipped, ['note.md']);
  assert.equal(res.taken, 1);
  await ok(b);
  assert.equal(b.fs.text('note.md'), 'ONE\ntwo\nthree\n');
  const { res: second } = await merge(b, trip);
  assert.deepEqual(second.skipped, []);
  assert.equal(b.fs.text('note.md'), 'ONE\ntwo\nthree\nbranch\n');
  assert.equal(b.fs.text('other.md'), 'o\nbranch\n');
});

test('a merge stopped after its commit and before the common table moved is finished by merging again', async () => {
  const { a, b } = await vault({ 'note.md': 'one\ntwo\nthree\n' });
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'one\ntwo\nthree\nbranch\n');
  await ok(a);
  b.fs.put('note.md', 'ONE\ntwo\nthree\n');
  await ok(b);
  const draft = await b.engine.mergePlan(trip);
  const repo = await b.engine.documents();
  const writeBase = repo.writeBase.bind(repo);
  repo.writeBase = () => Promise.reject(new Error('cut off'));
  await assert.rejects(b.engine.mergeApply(draft), /cut off/);
  repo.writeBase = writeBase;
  await ok(b);
  assert.equal(b.fs.text('note.md'), 'ONE\ntwo\nthree\nbranch\n');
  const { res } = await merge(b, trip);
  assert.deepEqual(res.copies, []);
  assert.deepEqual(res.skipped, []);
  assert.equal(b.fs.text('note.md'), 'ONE\ntwo\nthree\nbranch\n');
});

test('a device on a branch closed elsewhere sends nothing more there, and its unsent edit goes to the main line when it switches', async () => {
  const { a, b } = await vault({ 'note.md': 'one\ntwo\nthree\n', 'main.md': 'm\n' });
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'one\ntwo\nthree\nbranch\n');
  await ok(a);
  await assert.rejects(a.engine.closeBranch(trip), /switch to another line first/);
  const closed = await b.engine.closeBranch(trip);
  assert.equal(closed.closedBy, 'B');
  assert.equal((await b.engine.closeBranch(closed)).closed, closed.closed);

  a.fs.put('main.md', 'm\nedited after the branch closed\n');
  await assert.rejects(a.sync(), BranchClosedError);
  a.restart();
  await assert.rejects(a.sync(), BranchClosedError);
  await assert.rejects(b.engine.switchLine(closed), BranchClosedError);
  await assert.rejects(b.engine.mergePlan(closed), /closed/);

  const r = await go(a);
  assert.deepEqual(r.conflictCopies, []);
  assert.equal(a.fs.text('main.md'), 'm\nedited after the branch closed\n');
  // What only the branch held is not on the main line.
  assert.equal(a.fs.text('note.md'), 'one\ntwo\nthree\n');
  await ok(b);
  assert.equal(b.fs.text('main.md'), 'm\nedited after the branch closed\n');
  // The name is free again.
  await b.engine.startBranch('trip');
});

test('a branch with no commit of its own is found closed too, even after cleanup removed it', async () => {
  const { a, b, clock, mem } = await vault({ 'note.md': 'one\n' });
  const idle = await start(a, 'idle');
  await b.engine.closeBranch(idle);
  clock.now += 31 * DAY;
  await b.engine.gc();
  assert.deepEqual(await mem.list('line/'), []);
  assert.deepEqual((await b.engine.branches()).branches, []);
  a.restart();
  a.fs.put('note.md', 'one\ntwo\n');
  await assert.rejects(a.sync(), BranchClosedError);
  assert.deepEqual(await mem.list('line/'), []);
  await go(a);
  await ok(b);
  assert.equal(b.fs.text('note.md'), 'one\ntwo\n');
});

test('cleanup on either line keeps what the other line and the common table still read', async () => {
  const { a, b, clock, mem } = await vault({ 'a.md': 'main old\n', 'gone.md': 'only the branch keeps this\n'.repeat(400), 'big.bin': random(300_000, 4) }, { retentionDays: 5 });
  const keep = await start(a, 'keep');
  a.fs.put('branch-only.bin', random(300_000, 5));
  await ok(a);
  // The main line deletes what the branch still has, and the branch what the main line still has.
  await b.fs.remove('gone.md');
  await b.fs.remove('big.bin');
  b.fs.put('a.md', 'main new\n');
  await ok(b);
  await a.fs.remove('a.md');
  await ok(a);
  for (let day = 0; day < 12; day++) {
    clock.now += DAY;
    b.fs.put('tick.md', `main day ${day}\n`);
    await ok(b);
    a.fs.put('tock.md', `branch day ${day}\n`);
    await ok(a);
    await (day % 2 ? a : b).engine.gc();
  }
  const packs = (await mem.list('pack/')).length;
  assert.ok(packs > 0);
  assert.deepEqual((await a.engine.verify({ deep: true })).problems, []);
  assert.deepEqual((await b.engine.verify({ deep: true })).problems, []);

  // A device new to the branch downloads all of it, and the merge still has its common table.
  const c = new Device('C', mem, clock, { retentionDays: 5 });
  await ok(c);
  await go(c, keep);
  assert.equal(c.fs.text('gone.md'), 'only the branch keeps this\n'.repeat(400));
  assert.deepEqual(c.fs.files.get('big.bin')!.data, random(300_000, 4));
  assert.deepEqual(c.fs.files.get('branch-only.bin')!.data, random(300_000, 5));
  const { res } = await merge(b, keep);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(b.fs.files.get('branch-only.bin')!.data, random(300_000, 5));
  // Deleted on the main line and untouched on the branch, it stays deleted; edited on the main line and deleted on the branch, it stays.
  assert.ok(!b.fs.files.has('gone.md'));
  assert.equal(b.fs.text('a.md'), 'main new\n');

  // Once the branch is closed and its time is up, what only it kept goes.
  await go(a);
  await go(c);
  await b.engine.closeBranch(keep);
  clock.now += 32 * DAY;
  b.fs.put('tick.md', 'later\n');
  await ok(b);
  const r = await b.engine.gc();
  assert.ok(r.packsDeleted > 0);
  assert.deepEqual((await b.engine.verify({ deep: true })).problems, []);
});

test('history on a branch reaches back before it started, and its own versions are not on the main line', async () => {
  const { a, b, clock } = await vault({ 'note.md': 'v1\n' });
  clock.now += 10 * MINUTE;
  a.fs.put('note.md', 'v2\n');
  await ok(a);
  clock.now += 10 * MINUTE;
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'v3 on the branch\n');
  await ok(a);
  const text = async (d: Device, e: Entry | null) => new TextDecoder().decode(await d.engine.readVersion(e!));
  const onBranch = await a.engine.history('note.md');
  assert.deepEqual(await Promise.all(onBranch.map((v) => text(a, v.entry))), ['v3 on the branch\n', 'v2\n', 'v1\n']);
  await ok(b);
  const onMain = await b.engine.history('note.md');
  assert.deepEqual(await Promise.all(onMain.map((v) => text(b, v.entry))), ['v2\n', 'v1\n']);
  assert.deepEqual((await a.engine.verify()).problems, []);
  assert.equal((await a.engine.branches()).current, trip.id);
});

test('a snapshot interval that began before the branch started reads whole on the branch', async () => {
  const { a, mem, clock } = await vault({ 'note.md': 'start\n' }, { snapshotEvery: 4 });
  for (let i = 0; i < 2; i++) {
    a.fs.put('note.md', `main ${i}\n`);
    await ok(a);
  }
  await start(a, 'trip');
  for (let i = 0; i < 9; i++) {
    clock.now += MINUTE;
    a.fs.put('note.md', `branch ${i}\n`);
    await ok(a);
  }
  assert.ok((await mem.list('line/')).some((o) => /\/idx\//.test(o.key)));
  assert.ok((await mem.list('line/')).filter((o) => /\/snap\//.test(o.key)).length >= 2);
  const versions = await a.engine.history('note.md');
  assert.equal(versions.length, 12);
  assert.deepEqual((await a.engine.verify()).problems, []);
  // A device new to the branch starts from the branch's own newest snapshot.
  const c = new Device('C', mem, clock, { snapshotEvery: 4 });
  await ok(c);
  await go(c, (await c.engine.branches()).branches[0]);
  assert.equal(c.fs.text('note.md'), 'branch 8\n');
});

test('a sync with nothing to do costs the same requests on a branch as on the main line', async () => {
  const { a, b, net } = await vault({ 'note.md': 'one\n' });
  await ok(b);
  net.reset();
  await ok(b);
  const main = { ...net.stats };
  const trip = await start(a, 'trip');
  a.fs.put('note.md', 'one\ntwo\n');
  await ok(a);
  await ok(a);
  net.reset();
  await ok(a);
  assert.deepEqual({ get: net.stats.get, put: net.stats.put, list: net.stats.list, delete: net.stats.delete }, { get: main.get, put: main.put, list: main.list, delete: main.delete });
  assert.ok(trip.id);
});

test('the device list says which line a device is on and counts behind only within a line', async () => {
  const { a, b } = await vault({ 'note.md': 'one\n' });
  const trip = await start(a, 'trip');
  for (let i = 0; i < 3; i++) {
    a.fs.put('note.md', `branch ${i}\n`);
    await ok(a);
  }
  await writeHeartbeat(await a.engine.view(), { platform: 'test', version: '0.12.0' });
  await writeHeartbeat(await b.engine.view(), { platform: 'test', version: '0.12.0' });
  const seen = await listDevices(await b.engine.view());
  const other = seen.find((d) => d.name === 'A')!;
  assert.equal(other.line, trip.id);
  assert.equal(other.behind, 0);
  assert.equal(other.state, 'current');
  assert.equal(seen.find((d) => d.name === 'B')!.line, undefined);
});

test('a branch name is checked, and a branch starts from the main line only', async () => {
  const { a } = await vault({ 'note.md': 'one\n' });
  await assert.rejects(a.engine.startBranch(' '), /Give the branch a name/);
  await assert.rejects(a.engine.startBranch('Main'), /own line/);
  const trip = await start(a, 'Trip');
  await assert.rejects(a.engine.startBranch('other'), /switch to it first/);
  await go(a);
  await assert.rejects(a.engine.startBranch('trip'), /already a branch/);
  const other = await a.engine.startBranch('other');
  await assert.rejects(a.engine.mergePlan(trip), /main line only/);
  assert.equal(other.fork, trip.fork);
  assert.equal(TEST_CONFIG.kdfIterations, 1000);
});
