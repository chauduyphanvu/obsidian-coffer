import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChoices, diffCounts, hunks, lineDiff, type Choice, type DiffRegion } from '../src/core/merge.ts';
import { fileName } from '../src/core/paths.ts';
import { MAX_COMPARE_BYTES, compareConflict, resultProblems, unchangedSince, withConflicts, type Snapshot } from '../src/plugin/status.ts';
import { rng } from '../src/testing/netsim.ts';

const encode = (s: string) => new TextEncoder().encode(s);
const snap = (content: string | Uint8Array, mtime = 1): Snapshot => {
  const data = typeof content === 'string' ? encode(content) : content;
  return { size: data.length, mtime, data };
};
const countChanges = (rs: DiffRegion[]) => diffCounts(rs).changes;
const every = (rs: DiffRegion[], c: Choice) => applyChoices(rs, Array(countChanges(rs)).fill(c));
const sameBytes = (x: string, y: string) => Buffer.from(encode(x)).equals(Buffer.from(encode(y)));

/** Length of a longest common subsequence of lines, by the textbook table. */
function lcsLength(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
  return t[a.length][b.length];
}

test('lineDiff: shared runs and changes alternate in reading order, with where each starts', () => {
  const rs = lineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')!;
  assert.deepEqual(rs, [
    { kind: 'same', lines: ['a\n'], aStart: 0, bStart: 0 },
    { kind: 'change', a: ['b\n'], b: ['B\n'], aStart: 1, bStart: 1 },
    { kind: 'same', lines: ['c\n', 'd\n'], aStart: 2, bStart: 2 },
    { kind: 'change', a: [], b: ['e\n'], aStart: 4, bStart: 4 },
  ]);
  assert.deepEqual(diffCounts(rs), { changes: 2, removed: 1, added: 2 });
  assert.equal(applyChoices(rs, ['theirs', 'mine']), 'a\nB\nc\nd\n');
  assert.equal(applyChoices(rs, ['both', 'theirs']), 'a\nb\nB\nc\nd\ne\n');
  assert.throws(() => applyChoices(rs, ['mine']), /1 choices for 2 changes/);
});

test('lineDiff: identical texts, empty texts and an empty side', () => {
  const same = lineDiff('x\ny\n', 'x\ny\n')!;
  assert.deepEqual(same, [{ kind: 'same', lines: ['x\n', 'y\n'], aStart: 0, bStart: 0 }]);
  assert.deepEqual(diffCounts(same), { changes: 0, removed: 0, added: 0 });
  assert.deepEqual(hunks(same, 3), []);
  assert.equal(applyChoices(same, []), 'x\ny\n');

  assert.deepEqual(lineDiff('', ''), []);
  assert.equal(applyChoices([], []), '');

  const added = lineDiff('', 'a\nb\n')!;
  assert.deepEqual(added, [{ kind: 'change', a: [], b: ['a\n', 'b\n'], aStart: 0, bStart: 0 }]);
  assert.equal(every(added, 'mine'), '');
  assert.equal(every(added, 'theirs'), 'a\nb\n');
  const removed = lineDiff('a\nb\n', '')!;
  assert.deepEqual(diffCounts(removed), { changes: 1, removed: 2, added: 0 });
  assert.equal(every(removed, 'both'), 'a\nb\n');
});

test('lineDiff: Windows line endings are kept, and a change of ending alone is a change', () => {
  const rs = lineDiff('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')!;
  assert.deepEqual(rs[1], { kind: 'change', a: ['b\r\n'], b: ['B\r\n'], aStart: 1, bStart: 1 });
  assert.equal(applyChoices(rs, ['both']), 'a\r\nb\r\nB\r\nc\r\n');

  const endings = lineDiff('a\nb\n', 'a\r\nb\r\n')!;
  assert.deepEqual(diffCounts(endings), { changes: 1, removed: 2, added: 2 });
  assert.equal(every(endings, 'mine'), 'a\nb\n');
  assert.equal(every(endings, 'theirs'), 'a\r\nb\r\n');
});

test('applyChoices: a last line without an ending does not run into the other side', () => {
  const rs = lineDiff('a\nb', 'a\nb\nc\n')!;
  assert.deepEqual(rs[1], { kind: 'change', a: ['b'], b: ['b\n', 'c\n'], aStart: 1, bStart: 1 });
  assert.equal(every(rs, 'mine'), 'a\nb');
  assert.equal(every(rs, 'theirs'), 'a\nb\nc\n');
  assert.equal(every(rs, 'both'), 'a\nb\nb\nc\n');
  // The added ending follows the file's own.
  assert.equal(every(lineDiff('a\r\nb', 'a\r\nc')!, 'both'), 'a\r\nb\r\nc');
  assert.equal(every(lineDiff('one', 'two')!, 'both'), 'one\ntwo');
  // Both lacking an ending: the result does too.
  assert.equal(every(lineDiff('x\none', 'x\ntwo')!, 'both'), 'x\none\ntwo');
});

test('hunks: each change with at most n shared lines either side', () => {
  const a = ['1', '2', '3', '4', '5', 'old', '6', 'mid', '7', '8', '9', '10'].map((l) => `${l}\n`).join('');
  const b = a.replace('old\n', 'new\n').replace('mid\n', 'MID\n');
  const hs = hunks(lineDiff(a, b)!, 3);
  assert.equal(hs.length, 2);
  assert.deepEqual(hs[0].before, ['3\n', '4\n', '5\n']);
  assert.deepEqual(hs[0].after, ['6\n']);
  assert.deepEqual(hs[1].before, ['6\n']);
  assert.deepEqual(hs[1].after, ['7\n', '8\n', '9\n']);
  assert.deepEqual(hs[0].change.a, ['old\n']);
  assert.deepEqual(hs[1].change.b, ['MID\n']);

  const edges = hunks(lineDiff('first\nkeep\nlast\n', 'FIRST\nkeep\nLAST\n')!, 3);
  assert.deepEqual([edges[0].before, edges[0].after, edges[1].before, edges[1].after], [[], ['keep\n'], ['keep\n'], []]);
  assert.deepEqual(hunks(lineDiff(a, b)!, 0).map((h) => [h.before, h.after]), [[[], []], [[], []]]);
});

test('lineDiff gives up on texts too different to diff quickly, and stays quick on a long note with a few edits', () => {
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');
  let t = Date.now();
  assert.equal(lineDiff(lines(1500, 'a'), lines(1500, 'b')), null);
  assert.ok(Date.now() - t < 3000, `gave up after ${Date.now() - t} ms`);

  const long = lines(50_000, 'line');
  const edited = long.replace('line 100\n', 'edited\n').replace('line 30000\n', '').replace('line 49999\n', 'line 49999\nadded\n');
  t = Date.now();
  const rs = lineDiff(long, edited)!;
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  assert.deepEqual(diffCounts(rs), { changes: 3, removed: 2, added: 2 });
  assert.equal(every(rs, 'mine'), long);
  assert.equal(every(rs, 'theirs'), edited);
});

test('property: all "mine" gives the copy back and all "theirs" the original, byte for byte', () => {
  const r = rng(11);
  const pick = (n: number) => (r() * n) | 0;
  const vocab = ['', 'alpha', 'beta', 'gamma', '- [ ] task', '# Heading', 'δ ünïcode', '\t indented', 'emoji 🎉', '  '];
  const text = (lines: string[], ending: string, last: boolean, bom: boolean) =>
    (bom ? '﻿' : '') + lines.map((l, i) => (i < lines.length - 1 || last ? l + (pick(12) === 0 ? '\r\n' : ending) : l)).join('');
  for (let iter = 0; iter < 3000; iter++) {
    const base = Array.from({ length: pick(14) }, () => vocab[pick(vocab.length)]);
    const other = [...base];
    for (let n = pick(5); n > 0; n--) {
      const at = pick(other.length + 1);
      const kind = pick(3);
      if (kind === 0) other.splice(at, 0, vocab[pick(vocab.length)]);
      else if (kind === 1) other.splice(at, 1);
      else other[at] = `changed ${iter}`;
    }
    const ending = pick(3) ? '\n' : '\r\n';
    const a = text(base, ending, pick(4) > 0, pick(10) === 0);
    const b = pick(5) ? text(other, ending, pick(4) > 0, pick(10) === 0) : text(other, ending === '\n' ? '\r\n' : '\n', true, false);
    const rs = lineDiff(a, b);
    assert.ok(rs, `iter ${iter}`);

    assert.ok(sameBytes(every(rs, 'mine'), a), `iter ${iter}: mine`);
    assert.ok(sameBytes(every(rs, 'theirs'), b), `iter ${iter}: theirs`);
    // Regions alternate, none is empty, and each starts where the one before ended.
    let ia = 0;
    let ib = 0;
    rs.forEach((x, k) => {
      if (k) assert.notEqual(x.kind, rs[k - 1].kind, `iter ${iter}: two ${x.kind} regions in a row`);
      assert.deepEqual([x.aStart, x.bStart], [ia, ib], `iter ${iter}: region ${k} start`);
      const [na, nb] = x.kind === 'same' ? [x.lines.length, x.lines.length] : [x.a.length, x.b.length];
      assert.ok(na + nb > 0, `iter ${iter}: empty region`);
      ia += na;
      ib += nb;
    });
    // As few changed lines as possible: the shared lines are a longest common run.
    const split = (s: string) => (s ? s.split(/(?<=\n)/) : []);
    assert.equal(rs.reduce((n, x) => n + (x.kind === 'same' ? x.lines.length : 0), 0), lcsLength(split(a), split(b)), `iter ${iter}: not minimal`);
    // Any mix of choices is made only of the two sides' lines.
    const choices = Array.from({ length: countChanges(rs) }, () => (['mine', 'theirs', 'both'] as const)[pick(3)]);
    const mixed = applyChoices(rs, choices);
    const fromA = new Set(split(a).map((l) => l.replace(/\r?\n$/, '')));
    const fromB = new Set(split(b).map((l) => l.replace(/\r?\n$/, '')));
    for (const l of split(mixed)) assert.ok(fromA.has(l.replace(/\r?\n$/, '')) || fromB.has(l.replace(/\r?\n$/, '')), `iter ${iter}: line ${JSON.stringify(l)}`);
  }
});

test('a conflict is compared line by line only when both sides are text a diff can follow', () => {
  const kind = (c: ReturnType<typeof compareConflict>) => (c.kind === 'lines' ? 'lines' : c.reason);
  assert.equal(kind(compareConflict('n.md', snap('mine\n'), undefined)), 'missing');
  assert.equal(kind(compareConflict('n.md', snap('same\n'), snap('same\n', 2))), 'same');
  assert.equal(kind(compareConflict('n.md', { size: MAX_COMPARE_BYTES + 1, mtime: 1 }, snap('x'))), 'large');
  assert.equal(kind(compareConflict('p.png', snap(Uint8Array.of(0x89, 0x50, 0x4e, 0x47)), snap(Uint8Array.of(0x89, 0x50, 0x4e, 0x48)))), 'binary');
  assert.equal(kind(compareConflict('n.md', snap('a\0b'), snap('a\n'))), 'binary');
  assert.equal(kind(compareConflict('board.canvas', snap('{"nodes":[1]}\n'), snap('{"nodes":[2]}\n'))), 'structured');
  assert.equal(kind(compareConflict('data.json', snap('{"a":1}\n'), snap('{"a":2}\n'))), 'structured');
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');
  assert.equal(kind(compareConflict('n.md', snap(lines(1500, 'a')), snap(lines(1500, 'b')))), 'different');

  const text = compareConflict('n.md', snap('one\r\ntwo\r\n'), snap('one\r\nTWO\r\n'));
  assert.equal(text.kind, 'lines');
  if (text.kind === 'lines') assert.deepEqual(diffCounts(text.regions), { changes: 1, removed: 1, added: 1 });
});

test('a byte order mark survives comparing and choosing', () => {
  const mine = encode('﻿title\nmine\n');
  const theirs = encode('﻿title\ntheirs\n');
  assert.deepEqual([...mine.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const c = compareConflict('n.md', snap(mine), snap(theirs));
  assert.equal(c.kind, 'lines');
  if (c.kind !== 'lines') return;
  assert.deepEqual(encode(every(c.regions, 'mine')), mine);
  assert.deepEqual(encode(every(c.regions, 'theirs')), theirs);
  assert.deepEqual(encode(every(c.regions, 'both')), encode('﻿title\nmine\ntheirs\n'));
});

test('a file counts as changed since it was shown by its bytes when known, else by size and time', () => {
  assert.ok(unchangedSince(undefined, undefined));
  assert.ok(!unchangedSince(undefined, snap('new')));
  assert.ok(!unchangedSince(snap('gone'), undefined));
  assert.ok(unchangedSince(snap('same', 1), snap('same', 2)), 'rewritten with the same bytes');
  assert.ok(!unchangedSince(snap('abc', 1), snap('abd', 1)), 'same size and time, other bytes');
  assert.ok(unchangedSince({ size: 9e6, mtime: 5 }, { size: 9e6, mtime: 5 }));
  assert.ok(!unchangedSince({ size: 9e6, mtime: 5 }, { size: 9e6, mtime: 6 }));
  assert.ok(!unchangedSince(snap('small'), { size: 9e6, mtime: 1 }), 'grew past the comparing limit');
});

test('the conflict problem follows the copies still waiting, and goes when the last is resolved', () => {
  const r = { errors: [{ path: 'x.md', message: 'EACCES' }], tooLarge: [] };
  const copies = ['a (conflict phone 20261111-120000).md', 'b (conflict phone 20261111-120000).md'];
  const problems = resultProblems(r, copies, 200);
  assert.deepEqual(problems.map((p) => p.id.split(':')[0]), ['failed-files', 'conflicts']);

  const one = withConflicts(problems, copies.slice(1));
  assert.deepEqual(one[1].files, copies.slice(1));
  assert.equal(one[1].id, `conflicts:${copies[1]}`);
  assert.equal(one[1].title, '1 file changed on two devices');
  assert.equal(one[0], problems[0]);

  assert.deepEqual(withConflicts(problems, []).map((p) => p.id.split(':')[0]), ['failed-files']);
  // Copies alone do not raise the problem between syncs; the next sync does.
  assert.deepEqual(withConflicts([problems[0]], copies), [problems[0]]);
});

test('fileName is the last part of a path', () => {
  assert.equal(fileName('a/b/c.md'), 'c.md');
  assert.equal(fileName('top.md'), 'top.md');
  assert.equal(fileName('dir.v2/README (conflict B 20260102-150405)'), 'README (conflict B 20260102-150405)');
});
