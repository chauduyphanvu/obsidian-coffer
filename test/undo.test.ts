import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncConfig } from '../src/core/config.ts';
import { ext } from '../src/core/paths.ts';
import { operationAt, planUndo } from '../src/core/timeline.ts';
import { applyRestore, operationLabel, undoSteps } from '../src/plugin/restore.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { SimStore } from '../src/testing/netsim.ts';
import { DAY, Device } from './helpers.ts';

const MINUTE = 60_000;

function setup(config: Partial<SyncConfig> = {}) {
  const clock = { now: 1_800_000_000_000 };
  const net = new SimStore(new MemoryStore(() => clock.now));
  return { clock, a: new Device('A', net, clock, config), b: new Device('B', net, clock, config) };
}

/** Syncs and returns the number of the newest commit: the one this sync made, when it made one. */
async function send(d: Device): Promise<number> {
  const r = await d.sync();
  assert.deepEqual(r.errors, []);
  return d.engine.position();
}

/** Undoes the operation commit `seq` belongs to on `d`, the way the command line does: sync, plan, apply, sync. */
async function undo(d: Device, seq: number) {
  await send(d);
  const v = await d.engine.view();
  const op = await operationAt(v.repo, v.st.lastSeq, v.cfg, seq);
  const { steps, skipped } = await undoSteps(
    planUndo(op.changes, v.st.remote),
    v.st.remote,
    () => false,
    (e) => d.engine.readVersion(e),
    (path) => v.cfg.mergeExtensions.includes(ext(path)),
  );
  const synced = new Map([...v.st.synced].map(([key, s]) => [key, { lsize: s.lsize, lmtime: s.lmtime }]));
  const applied = await applyRestore(
    steps,
    synced,
    {
      stat: (path) => d.fs.stat(path),
      write: async (path, data) => void (await d.fs.write(path, data)),
      remove: (path) => d.fs.remove(path),
      read: (e) => d.engine.readVersion(e),
    },
    4,
  );
  const r = await d.engine.sync({ allowDeletes: applied.done.filter((s) => s.kind === 'remove').map((s) => s.path) });
  assert.deepEqual(r.errors, []);
  return { op, steps, skipped, applied };
}

test('undo takes one edit back out of a note and keeps what another device wrote in it since', async () => {
  const { clock, a, b } = setup();
  a.fs.put('note.md', 'one\ntwo\nthree\nfour\nfive\n');
  await send(a);
  clock.now += 5 * MINUTE;
  a.fs.put('note.md', 'ONE\ntwo\nthree\nfour\nfive\n');
  const edit = await send(a);
  clock.now += 5 * MINUTE;
  await send(b);
  b.fs.put('note.md', 'ONE\ntwo\nthree\nfour\nFIVE\n');
  await send(b);
  clock.now += 5 * MINUTE;

  const { op, steps, skipped } = await undo(a, edit);
  assert.equal(operationLabel(op), '1 changed');
  assert.deepEqual(steps.map((s) => [s.kind, s.path]), [['change', 'note.md']]);
  assert.deepEqual(skipped, []);
  assert.equal(a.fs.text('note.md'), 'one\ntwo\nthree\nfour\nFIVE\n');
  await send(b);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('undo moves a folder of notes back, with the edit one of them got since, and leaves a note added there since', async () => {
  const { clock, a, b } = setup();
  for (let i = 1; i <= 5; i++) a.fs.put(`notes/n${i}.md`, `note ${i}\nits text\n`);
  await send(a);
  clock.now += 5 * MINUTE;
  for (let i = 1; i <= 5; i++) {
    a.fs.put(`archive/n${i}.md`, a.fs.text(`notes/n${i}.md`)!);
    await a.fs.remove(`notes/n${i}.md`);
  }
  const move = await send(a);
  clock.now += 5 * MINUTE;
  await send(b);
  b.fs.put('archive/n1.md', 'note 1\nits text\nand a line from B\n');
  b.fs.put('archive/new.md', 'made after the move\n');
  await send(b);
  clock.now += 5 * MINUTE;

  const { op, skipped } = await undo(a, move);
  assert.equal(operationLabel(op), '5 moved');
  assert.deepEqual(skipped, []);
  assert.deepEqual([...a.fs.files.keys()].sort(), ['archive/new.md', 'notes/n1.md', 'notes/n2.md', 'notes/n3.md', 'notes/n4.md', 'notes/n5.md']);
  assert.equal(a.fs.text('notes/n1.md'), 'note 1\nits text\nand a line from B\n');
  assert.equal(a.fs.text('notes/n2.md'), 'note 2\nits text\n');
  await send(b);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('undo brings back a deleted file and removes an added one, when neither was touched since', async () => {
  const { clock, a, b } = setup();
  a.fs.put('keep.md', 'kept\n');
  a.fs.put('old.md', 'deleted by the operation\n');
  await send(a);
  clock.now += 5 * MINUTE;
  await a.fs.remove('old.md');
  a.fs.put('added.md', 'added by the operation\n');
  const seq = await send(a);
  clock.now += 5 * MINUTE;

  const { op, steps } = await undo(a, seq);
  assert.equal(operationLabel(op), '1 added, 1 deleted');
  assert.deepEqual(steps.map((s) => [s.kind, s.path]), [['remove', 'added.md'], ['add', 'old.md']]);
  assert.deepEqual([...a.fs.files.keys()].sort(), ['keep.md', 'old.md']);
  assert.equal(a.fs.text('old.md'), 'deleted by the operation\n');
  await send(b);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('undo leaves alone what it cannot take back safely, and says why', async () => {
  const { clock, a } = setup();
  a.fs.put('deleted.md', 'first life\n');
  a.fs.put('both.md', 'line\n');
  a.fs.put('picture.png', new Uint8Array([1, 2, 3]));
  a.fs.put('dropped.md', 'here before\n');
  await send(a);
  clock.now += 5 * MINUTE;
  await a.fs.remove('deleted.md');
  a.fs.put('added.md', 'as added\n');
  a.fs.put('both.md', 'line changed by the operation\n');
  a.fs.put('picture.png', new Uint8Array([4, 5, 6]));
  a.fs.put('dropped.md', 'here before, edited\n');
  const seq = await send(a);
  clock.now += 5 * MINUTE;
  a.fs.put('deleted.md', 'second life\n');
  a.fs.put('added.md', 'as added, then edited\n');
  a.fs.put('both.md', 'line changed again since\n');
  a.fs.put('picture.png', new Uint8Array([7, 8, 9]));
  await a.fs.remove('dropped.md');
  await send(a);
  clock.now += 5 * MINUTE;
  const before = a.snapshot();

  const { steps, skipped } = await undo(a, seq);
  assert.deepEqual(steps, []);
  assert.deepEqual(skipped, [
    { path: 'added.md', why: 'added-edited' },
    { path: 'both.md', why: 'edited' },
    { path: 'deleted.md', why: 'made-again' },
    { path: 'dropped.md', why: 'gone' },
    { path: 'picture.png', why: 'edited' },
  ]);
  assert.deepEqual(a.snapshot(), before);
});

test('a moved note that was moved on or whose old name is taken stays where it is', async () => {
  const { clock, a } = setup();
  a.fs.put('a/one.md', 'the first note, long enough to be told apart\n');
  a.fs.put('a/two.md', 'the second note, long enough to be told apart\n');
  await send(a);
  clock.now += 5 * MINUTE;
  for (const n of ['one', 'two']) {
    a.fs.put(`b/${n}.md`, a.fs.text(`a/${n}.md`)!);
    await a.fs.remove(`a/${n}.md`);
  }
  const move = await send(a);
  clock.now += 5 * MINUTE;
  a.fs.put('c/one.md', a.fs.text('b/one.md')!);
  await a.fs.remove('b/one.md');
  a.fs.put('a/two.md', 'something new under the old name\n');
  await send(a);
  clock.now += 5 * MINUTE;
  const before = a.snapshot();

  const { steps, skipped } = await undo(a, move);
  assert.deepEqual(steps, []);
  assert.deepEqual(skipped, [
    { path: 'a/two.md', why: 'taken' },
    { path: 'b/one.md', why: 'gone' },
  ]);
  assert.deepEqual(a.snapshot(), before);
});

test('an operation is the commits one device sent together: not another device\'s, and not its own from minutes later', async () => {
  const { clock, a, b } = setup({ commitBatchBytes: 1 });
  a.fs.put('base.md', 'base\n');
  const base = await send(a);
  clock.now += 5 * MINUTE;
  // One sync, a commit per file.
  a.fs.put('x.md', 'x\n');
  a.fs.put('y.md', 'y\n');
  a.fs.put('z.md', 'z\n');
  const last = await send(a);
  assert.equal(last, base + 3);
  clock.now += 10_000;
  await send(b);
  b.fs.put('from-b.md', 'b\n');
  const other = await send(b);
  clock.now += 10_000;
  a.fs.put('soon.md', 'ten seconds after B\n');
  const soon = await send(a);
  clock.now += 5 * MINUTE;
  a.fs.put('later.md', 'minutes later\n');
  const later = await send(a);

  const v = await a.engine.view();
  const at = (seq: number) => operationAt(v.repo, v.st.lastSeq, v.cfg, seq);
  for (const seq of [base + 1, base + 2, base + 3]) {
    const op = await at(seq);
    assert.deepEqual([op.first, op.seq, op.changes.map((c) => c.path)], [base + 1, base + 3, ['x.md', 'y.md', 'z.md']]);
  }
  assert.deepEqual((await at(other)).changes.map((c) => c.path), ['from-b.md']);
  assert.deepEqual([(await at(soon)).first, (await at(soon)).seq], [soon, soon]);
  assert.deepEqual([(await at(later)).first, (await at(later)).seq], [later, later]);
  await assert.rejects(at(later + 1), /no change with the number/);
});

test('an undo can itself be undone', async () => {
  const { clock, a } = setup();
  a.fs.put('note.md', 'before\n');
  await send(a);
  clock.now += 5 * MINUTE;
  a.fs.put('note.md', 'after\n');
  const edit = await send(a);
  clock.now += 5 * MINUTE;
  await undo(a, edit);
  assert.equal(a.fs.text('note.md'), 'before\n');
  const undone = a.engine.position();
  assert.ok(undone > edit);
  clock.now += 5 * MINUTE;
  await undo(a, undone);
  assert.equal(a.fs.text('note.md'), 'after\n');
});

test('when cleanup has removed the version from before, the file is left as it is and named', async () => {
  const { clock, a } = setup({ retentionDays: 2 });
  a.fs.put('plain.md', 'plain, first\n');
  a.fs.put('merged.md', 'one\ntwo\nthree\n');
  await send(a);
  clock.now += 2 * MINUTE;
  a.fs.put('plain.md', 'plain, second\n');
  a.fs.put('merged.md', 'ONE\ntwo\nthree\n');
  const seq = await send(a);
  clock.now += 5 * MINUTE;
  a.fs.put('merged.md', 'ONE\ntwo\nTHREE\n');
  await send(a);
  // The first versions were current for two minutes: thinned away once they are days old.
  for (let day = 0; day < 6; day++) {
    clock.now += DAY;
    a.fs.put('daily.md', `day ${day}\n`);
    await send(a);
    await a.engine.gc();
  }
  const before = a.snapshot();

  const { steps, skipped, applied } = await undo(a, seq);
  assert.deepEqual(skipped, [{ path: 'merged.md', why: 'lost' }]);
  assert.deepEqual(steps.map((s) => [s.kind, s.path]), [['change', 'plain.md']]);
  assert.deepEqual(applied.done, []);
  assert.deepEqual(applied.failed.map((f) => f.path), ['plain.md']);
  assert.match(applied.failed[0].message, /Remote pack \S+ is missing/);
  assert.deepEqual(a.snapshot(), before);
});
