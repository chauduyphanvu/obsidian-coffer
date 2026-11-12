import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SafetyError } from '../src/core/engine.ts';
import { lineDiff } from '../src/core/merge.ts';
import { planRestore, tableAt } from '../src/core/timeline.ts';
import type { Entry } from '../src/core/types.ts';
import type { VerifyReport } from '../src/core/verify.ts';
import {
  byDay,
  changesLabel,
  countSteps,
  countable,
  dayLabel,
  deleteLimitCrossed,
  describeCleanup,
  describeVerify,
  deviceLabel,
  diffLines,
  keepOut,
  lineChanges,
  matchesQuery,
  momentLabel,
  placeRestored,
  previewVersion,
  restoreSteps,
  sameSteps,
  scopeName,
  sizeLabel,
  stepSummary,
  timeLabel,
  timeLabels,
} from '../src/plugin/restore.ts';
import { MAX_COMPARE_BYTES } from '../src/plugin/status.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { Device } from './helpers.ts';

const encode = (s: string) => new TextEncoder().encode(s);
const entry = (id: string): Entry => ({ size: 1, mtime: 0, chunks: [{ id, pack: 'p', off: 0, len: 1, size: 1 }] });

test('a restore plan becomes removals first, then writes, each in path order, without the protected paths', () => {
  const current = new Map([['a.md', entry('a0')], ['z.md', entry('z0')], ['c.md', entry('c0')], ['Private/y.md', entry('y0')]]);
  const plan = {
    write: [
      { path: 'b.md', entry: entry('b1') },
      { path: 'a.md', entry: entry('a1') },
      { path: '.obsidian/plugins/self-sync/main.js', entry: entry('m1') },
      { path: 'Private/x.md', entry: entry('x1') },
    ],
    remove: ['z.md', 'c.md', 'Private/y.md'],
  };
  const { steps, left } = restoreSteps(plan, current, keepOut(['Private/'], ['.obsidian/plugins/self-sync']));
  assert.deepEqual(steps.map((s) => [s.kind, s.path]), [['remove', 'c.md'], ['remove', 'z.md'], ['change', 'a.md'], ['add', 'b.md']]);
  assert.equal(steps[2].entry, plan.write[1].entry);
  assert.equal(left, 3);
  assert.deepEqual(countSteps(steps), { add: 1, change: 1, remove: 2 });
  assert.ok(sameSteps(steps, restoreSteps(plan, current, keepOut(['Private/'], ['.obsidian/plugins/self-sync'])).steps));
  assert.ok(!sameSteps(steps, steps.slice(1)));
  assert.ok(!sameSteps(steps, steps.map((s) => (s.path === 'b.md' ? { ...s, kind: 'change' as const } : s))));
});

test('kept out: excluded patterns and whole folders, but not a folder that only starts with the same name', () => {
  const kept = keepOut(['*.tmp', 'Private/', '.obsidian/workspace*.json'], ['.obsidian/plugins/self-sync/']);
  assert.ok(kept('notes/draft.tmp'));
  assert.ok(kept('Private/a/b.md'));
  assert.ok(kept('.obsidian/workspace-mobile.json'));
  assert.ok(kept('.obsidian/plugins/self-sync/data.json'));
  assert.ok(kept('.obsidian/plugins/self-sync/main.js'), "the plugin's own code is never rolled back by a restore");
  assert.ok(!kept('.obsidian/plugins/self-sync-extra/main.js'));
  assert.ok(!kept('Privateer.md'));
  assert.ok(!kept('notes/a.md'));
  assert.ok(keepOut([], ['.obsidian'])('.obsidian/app.json'), 'the settings folder when it does not sync on this device');
});

test('what a restore will do and did, in one sentence that reads right for one', () => {
  assert.equal(stepSummary({ add: 3, change: 2, remove: 1 }), '3 files will be brought back, 2 changed and 1 removed.');
  assert.equal(stepSummary({ add: 0, change: 1, remove: 0 }), '1 file will be changed.');
  assert.equal(stepSummary({ add: 0, change: 2, remove: 5 }), '2 files will be changed and 5 removed.');
  assert.equal(stepSummary({ add: 0, change: 0, remove: 0 }), 'Nothing needs to change: it already matches that time.');
  assert.equal(stepSummary({ add: 1, change: 0, remove: 0 }, true), '1 file was brought back.');
  assert.equal(stepSummary({ add: 1200, change: 0, remove: 3 }, true), '1,200 files were brought back and 3 removed.');
  assert.equal(scopeName(''), 'the whole vault');
  assert.equal(scopeName('Projects/2026/'), '“Projects/2026”');
  assert.equal(changesLabel({ added: 3, changed: 0, deleted: 1 }), '3 added, 1 deleted');
  assert.equal(changesLabel({ added: 0, changed: 0, deleted: 0 }), 'no files changed');
  assert.equal(deviceLabel('phone', 'phone'), 'this device');
  assert.equal(deviceLabel('laptop', 'phone'), 'laptop');
});

test('a deleted file comes back where it was, or beside what has its name now, never on top of another', () => {
  const taken = new Set(['notes/a.md', 'notes/a (restored).md', 'readme', 'n.v2/x', '.gitignore'].map((p) => p.toLowerCase()));
  const to = placeRestored(['notes/free.md', 'notes/a.md', 'README', 'n.v2/x', '.gitignore', 'notes/free.md'.replace('free', 'Free')], taken);
  assert.deepEqual([...to.values()], ['notes/free.md', 'notes/a (restored 2).md', 'README (restored)', 'n.v2/x (restored)', '.gitignore (restored)', 'notes/Free (restored).md']);
  assert.ok(taken.has('notes/a (restored 2).md'), 'what was placed counts as taken for the next restore');
  const nfd = 'ý.md'.normalize('NFD');
  assert.equal(placeRestored([nfd], new Set(['ý.md'.normalize('NFC')])).get(nfd), `${nfd.slice(0, -3)} (restored).md`);
});

test('the delete limit predicted after a restore is the one the engine enforces', async () => {
  for (const [files, remove, write] of [[13, 12, 0], [13, 10, 0], [40, 20, 0], [40, 21, 0], [40, 25, 4], [40, 25, 5]]) {
    const a = new Device('A', new MemoryStore(), { now: 1_800_000_000_000 });
    for (let i = 0; i < files; i++) a.fs.put(`n${i}.md`, `${i}\n`);
    await a.sync();
    for (let i = 0; i < remove; i++) a.fs.files.delete(`n${i}.md`);
    for (let i = 0; i < write; i++) a.fs.put(`new${i}.md`, `new ${i}\n`);
    const crossed = deleteLimitCrossed(write, remove, files, a.config);
    const refused = await a.sync().then(() => false, (e) => e instanceof SafetyError);
    assert.equal(refused, crossed !== undefined, `${files} files, ${remove} removed, ${write} written`);
  }
  assert.equal(deleteLimitCrossed(0, 12, 13, { maxDeleteCount: 10, maxDeleteFraction: 0.5 }), 10);
  assert.equal(deleteLimitCrossed(0, 30, 45, { maxDeleteCount: 10, maxDeleteFraction: 0.5 }), 22);
});

test('restoring the vault to an earlier time: protected paths stay, only the restore\'s own deletions get past the guard, and the other device carries them out', async () => {
  const clock = { now: 1_800_000_000_000 };
  const store = new MemoryStore(() => clock.now);
  const a = new Device('A', store, clock, { exclude: ['Private/'] });
  const b = new Device('B', store, clock);
  a.fs.put('keep.md', 'keep v1\n');
  for (let i = 0; i < 3; i++) a.fs.put(`notes/${i}.md`, `note ${i}\n`);
  await a.sync();
  const then = clock.now;
  clock.now += 60_000;
  a.fs.put('keep.md', 'keep v2\n');
  for (let i = 0; i < 15; i++) a.fs.put(`drafts/${i}.md`, `draft ${i}\n`);
  await a.sync();
  await b.sync();
  b.fs.put('Private/p.md', 'only synced by B\n');
  clock.now += 60_000;
  await b.sync();
  await a.sync();

  // What the plugin reads: the engine's own view, whose table is current even when the last sync had nothing to save.
  const { repo, st, cfg, now } = await a.engine.view();
  const past = await tableAt(repo, st.remote, st.lastSeq, cfg, now, then);
  const kept = keepOut(a.config.exclude, []);
  const { steps, left } = restoreSteps(planRestore(st.remote, past.files), st.remote, kept);
  assert.equal(left, 1, "B's file in a folder this device leaves out is not removed");
  assert.deepEqual(countSteps(steps), { add: 0, change: 1, remove: 15 });

  const apply = async () => {
    for (const s of steps) if (s.kind === 'remove') a.fs.files.delete(s.path);
    for (const s of steps) if (s.entry) a.fs.put(s.path, await a.engine.readVersion(s.entry));
  };
  await apply();
  const removed = steps.filter((s) => s.kind === 'remove').map((s) => s.path);
  await assert.rejects(a.sync(), SafetyError, 'a plain sync takes them for files that vanished');
  await assert.rejects(a.engine.sync({ allowDeletes: removed.slice(0, 3) }), SafetyError, 'the deletions not named still count');
  assert.equal((await a.engine.sync({ allowDeletes: removed })).deletedRemote, 15);
  clock.now += 60_000;
  // The commit says the deletions were confirmed, so the other device carries them out without pausing.
  await b.sync();
  assert.deepEqual(
    Object.fromEntries([...b.fs.files.keys()].sort().map((p) => [p, b.fs.text(p)])),
    { 'Private/p.md': 'only synced by B\n', 'keep.md': 'keep v1\n', 'notes/0.md': 'note 0\n', 'notes/1.md': 'note 1\n', 'notes/2.md': 'note 2\n' },
  );
});

test('a clean-up says what it deleted and what it packed tighter, or that nothing needed doing', () => {
  const none = { packsDeleted: 0, bytesFreed: 0, snapshotsDeleted: 0, packsCombined: 0, packsWritten: 0, bytesMoved: 0, bytesFreedLater: 0 };
  assert.equal(describeCleanup(none), 'Nothing needed cleaning up: no stored version has expired, and the stored data is already packed tightly.');
  assert.equal(
    describeCleanup({ ...none, packsDeleted: 3, bytesFreed: 2_500_000, snapshotsDeleted: 1 }),
    'Deleted 3 storage objects (2.5 MB) and 1 old overview of the vault that no version you can restore needs.',
  );
  assert.equal(describeCleanup({ ...none, snapshotsDeleted: 2 }), 'Deleted 2 old overviews of the vault that no version you can restore needs.');
  assert.equal(
    describeCleanup({ ...none, packsDeleted: 1, bytesFreed: 400, packsCombined: 5, packsWritten: 1, bytesMoved: 1_200_000, bytesFreedLater: 9_000_000 }),
    'Deleted 1 storage object (400 bytes) that no version you can restore needs. ' +
      'Copied the data still in use out of 5 small or mostly unused storage objects into 1 new one (1.2 MB). ' +
      'The old ones (9.0 MB) are deleted by a later clean-up, once no version you can restore reads them.',
  );
});

test('days and times read as a person says them, with seconds only where two share a minute', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime();
  assert.equal(dayLabel(new Date(2026, 10, 11, 0, 5).getTime(), now), 'Today');
  assert.equal(dayLabel(new Date(2026, 10, 10, 23, 59).getTime(), now), 'Yesterday');
  const earlier = dayLabel(new Date(2026, 10, 9, 12).getTime(), now);
  assert.match(earlier, /9/);
  assert.doesNotMatch(earlier, /2026/);
  assert.match(dayLabel(new Date(2025, 10, 9, 12).getTime(), now), /2025/);
  assert.equal(momentLabel(new Date(2026, 10, 11, 14, 32).getTime(), now), `today at ${timeLabel(new Date(2026, 10, 11, 14, 32).getTime())}`);
  assert.match(momentLabel(new Date(2026, 10, 10, 9).getTime(), now), /^yesterday at /);
  assert.match(momentLabel(new Date(2026, 10, 2, 9).getTime(), now), /^on .*2.* at /);

  const t = new Date(2026, 10, 11, 14, 32, 5).getTime();
  const labels = timeLabels([t, t + 10_000, t + 5 * 60_000]);
  assert.notEqual(labels[0], labels[1]);
  assert.equal(labels[0], timeLabel(t, true));
  assert.equal(labels[2], timeLabel(t + 5 * 60_000));

  const items = [now - 1000, now - 2000, now - 86_400_000 * 1.5, now - 86_400_000 * 2];
  assert.deepEqual(byDay(items, (x) => x, now).map((d) => [d.day, d.items.length]), [['Today', 2], ['Yesterday', 1], [dayLabel(items[3], now), 1]]);
});

test('sizes, filters and which files are worth counting lines for', () => {
  assert.deepEqual([0, 1, 999, 1000, 1500, 9_960, 12_345, 999_999, 1.2e9].map(sizeLabel), ['0 bytes', '1 byte', '999 bytes', '1.0 KB', '1.5 KB', '10 KB', '12 KB', '1.0 MB', '1.2 GB']);
  const path = 'Projects/2026/Plan ý.md';
  assert.ok(matchesQuery(path, 'plan'));
  assert.ok(matchesQuery(path, '  PROJ   plan '));
  assert.ok(matchesQuery(path, ''));
  assert.ok(matchesQuery(path, 'ý'.normalize('NFD')));
  assert.ok(!matchesQuery(path, 'plan notes'));
  assert.ok(countable('a.md', 100));
  assert.ok(countable('board.canvas', 100));
  assert.ok(!countable('photo.png', 100));
  assert.ok(!countable('a.md', MAX_COMPARE_BYTES + 1));
});

test('lines added and removed between two versions, and nothing for files that are not text', () => {
  assert.deepEqual(lineChanges(encode('a\nb\n'), encode('a\nB\nc\n')), { added: 2, removed: 1 });
  assert.deepEqual(lineChanges(encode('same\n'), encode('same\n')), { added: 0, removed: 0 });
  assert.equal(lineChanges(Uint8Array.of(0x89, 0x50, 0, 1), encode('a\n')), undefined);
});

test('changes show every changed line with a little shared text around it, and say how much they skip', () => {
  const text = (n: number, edit: (i: number) => string | null = () => null) =>
    Array.from({ length: n }, (_, i) => edit(i) ?? `line ${i}`).map((l) => `${l}\n`).join('');
  const one = diffLines(lineDiff(text(20), text(20, (i) => (i === 10 ? 'TEN' : null)))!, 3);
  assert.deepEqual(one, [
    { kind: 'gap', lines: 7 },
    { kind: 'same', text: 'line 7' },
    { kind: 'same', text: 'line 8' },
    { kind: 'same', text: 'line 9' },
    { kind: 'removed', text: 'line 10' },
    { kind: 'added', text: 'TEN' },
    { kind: 'same', text: 'line 11' },
    { kind: 'same', text: 'line 12' },
    { kind: 'same', text: 'line 13' },
    { kind: 'gap', lines: 6 },
  ]);
  // Six shared lines between two changes are shown whole rather than as a gap of none.
  const two = diffLines(lineDiff(text(12), text(12, (i) => (i === 2 || i === 9 ? `X${i}` : null)))!, 3);
  assert.equal(two.filter((l) => l.kind === 'gap').length, 0);
  assert.deepEqual(two.slice(0, 3).map((l) => l.kind), ['same', 'same', 'removed']);
  assert.deepEqual(diffLines(lineDiff('a\r\n', 'b\r\n')!, 3), [{ kind: 'removed', text: 'a' }, { kind: 'added', text: 'b' }]);
});

test('a version is shown as changes against the file now, or whole, or only as facts', () => {
  const kind = (p: ReturnType<typeof previewVersion>) => (p.kind === 'text' || p.kind === 'facts' ? `${p.kind}:${p.why}` : p.kind);
  assert.equal(kind(previewVersion(undefined, encode('x'))), 'facts:large');
  assert.equal(kind(previewVersion(Uint8Array.of(0x89, 0, 1), encode('x'))), 'facts:binary');
  assert.equal(kind(previewVersion(encode('old\n'), null)), 'text:missing');
  assert.equal(kind(previewVersion(encode('old\n'), undefined)), 'text:different');
  assert.equal(kind(previewVersion(encode('same\n'), encode('same\n'))), 'same');
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');
  assert.equal(kind(previewVersion(encode(lines(1500, 'a')), encode(lines(1500, 'b')))), 'text:different');
  const p = previewVersion(encode('title\nold line\nend\n'), encode('title\nnew line\nmore\nend\n'));
  assert.equal(p.kind, 'changes');
  if (p.kind !== 'changes') return;
  assert.deepEqual([p.added, p.removed], [1, 2], 'restoring adds the version\'s lines and removes the ones only the file now has');
  assert.equal(p.text, 'title\nold line\nend\n');
  assert.deepEqual(p.lines.filter((l) => l.kind !== 'same').map((l) => [l.kind, 'text' in l ? l.text : '']), [['removed', 'new line'], ['removed', 'more'], ['added', 'old line']]);
});

test('a storage check reads as what was checked, and each kind of problem once with the files it affects', () => {
  const report = (over: Partial<VerifyReport> = {}): VerifyReport => ({ deep: false, commits: 120, snapshot: 100, files: 1, packs: 3, chunks: 0, bytes: 0, problems: [], ...over });
  const ok = describeVerify(report());
  assert.equal(ok.ok, true);
  assert.equal(ok.title, 'No damage found');
  assert.equal(ok.detail, 'Checked 1 file, the history of 120 syncs and 3 storage objects.');
  assert.match(describeVerify(report({ deep: true, bytes: 12_300_000 })).detail, /downloaded 12 MB/);

  const bad = describeVerify(
    report({
      problems: [
        { message: 'Commit 7 is missing', object: 'log/000000000007' },
        { message: 'Pack p1 is missing', object: 'pack/p1', paths: ['b.md', 'a.md'] },
        { message: 'Pack p2 is missing', object: 'pack/p2', paths: ['a.md', 'c.md'] },
        { message: 'odd' },
      ],
    }),
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.title, '4 problems found');
  assert.deepEqual(bad.findings.map((f) => [f.title, f.files, f.messages.length]), [
    ['Stored file data is missing or damaged', ['a.md', 'b.md', 'c.md'], 2],
    ['Part of the sync history is missing or damaged', [], 1],
    ['Something in storage does not add up', [], 1],
  ]);
});
