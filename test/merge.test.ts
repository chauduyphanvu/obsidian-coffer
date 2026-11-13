import assert from 'node:assert/strict';
import { test } from 'node:test';
import { merge3, mergeCanvas, mergeNote, words } from '../src/core/merge.ts';
import { rng } from '../src/testing/netsim.ts';

test('merge3 by words: different sentences of one paragraph merge', () => {
  const base = 'The cat sat on the mat. It was warm outside. Nobody came by all day.\n';
  const ours = 'The cat sat on the mat. It was very warm outside. Nobody came by all day.\n';
  const theirs = 'The cat sat on the mat. It was warm outside. Nobody came by all week.\n';
  const both = 'The cat sat on the mat. It was very warm outside. Nobody came by all week.\n';
  assert.equal(merge3(base, ours, theirs), both);
  assert.equal(merge3(base, theirs, ours), both);
  // A paragraph among others: lines the other side did not touch keep merging by line.
  const doc = (p: string) => `# Title\n\n${p}\n\nlast\n`;
  assert.equal(merge3(doc(base.trim()), doc(ours.trim()), doc(theirs.trim())), doc(both.trim()));
});

test('merge3 by words: the same word edited differently, adjacent words and different insertions at one spot conflict', () => {
  assert.equal(merge3('one two three four five\n', 'one TWO three four five\n', 'one Two three four five\n'), null);
  assert.equal(merge3('one two three four five\n', 'one TWO three four five\n', 'one two THREE four five\n'), null);
  // Only whitespace between two edits is not an unchanged word.
  assert.equal(merge3('I like cats\n', 'I love cats\n', 'I like dogs\n'), null);
  assert.equal(merge3('alpha beta gamma\n', 'alpha X beta gamma\n', 'alpha Y beta gamma\n'), null);
  assert.equal(merge3('alpha beta gamma\n', 'alpha beta gamma X\n', 'alpha beta gamma Y\n'), null);
  // One side deleting a paragraph the other edited is a conflict, not a deletion.
  assert.equal(merge3('intro\n\nthe middle paragraph has words\n\nend\n', 'intro\n\nend\n', 'intro\n\nthe middle PARAGRAPH has words\n\nend\n'), null);
  assert.equal(merge3('a b c\n', '', 'a b c d\n'), null);
});

test('merge3 by words: the same edit on both sides, whitespace edits and edits far apart', () => {
  assert.equal(merge3('a b c d e\n', 'a B c d E\n', 'a B c d e\n'), 'a B c d E\n');
  assert.equal(merge3('a b c d e\n', 'a B c d e\n', 'a B c d E\n'), 'a B c d E\n');
  assert.equal(merge3('one two three four\n', 'one  two three four\n', 'one two three FOUR\n'), 'one  two three FOUR\n');
  assert.equal(merge3('one two three four\n', 'one two three FOUR\n', 'one  two three four\n'), 'one  two three FOUR\n');
  assert.equal(merge3('a b c d\n', 'a b c\n', 'a b c d e\n'), null);
});

test('merge3 by words: Windows line endings are kept', () => {
  const base = 'The quick brown fox jumps over the lazy dog.\r\nTail line.\r\n';
  const ours = 'The slow brown fox jumps over the lazy dog.\r\nTail line.\r\n';
  const theirs = 'The quick brown fox jumps over the lazy cat.\r\nTail line.\r\n';
  assert.equal(merge3(base, ours, theirs), 'The slow brown fox jumps over the lazy cat.\r\nTail line.\r\n');
  assert.equal(merge3(base, theirs, ours), 'The slow brown fox jumps over the lazy cat.\r\nTail line.\r\n');
  // An ending changed on the line the other side edited is a conflict; on another line it is not.
  assert.equal(merge3('a b c\nd e f\n', 'a b c\r\nd e f\r\n', 'a b c\nd e F\n'), null);
  assert.equal(merge3('a b c\nd e f\n', 'a b c\r\nd e f\n', 'a b c\nd e F\n'), 'a b c\r\nd e F\n');
});

test('merge3 by words: decomposed Vietnamese, CJK and emoji', () => {
  const nfd = (s: string) => s.normalize('NFD');
  const viet = nfd('Tiếng Việt rất hay và đẹp lắm nhé');
  assert.equal(merge3(viet, nfd('Tiếng Nam rất hay và đẹp lắm nhé'), nfd('Tiếng Việt rất hay và đẹp lắm nha')), nfd('Tiếng Nam rất hay và đẹp lắm nha'));
  // The marks stay with their letters: two edits inside one word conflict, and a base letter is never split from its mark.
  assert.equal(merge3(viet, nfd('Tiếng Việt rất hay và đẹp lắm nhé'.replace('Việt', 'Viêt')), nfd('Tiếng Việt rất hay và đẹp lắm nhé'.replace('Việt', 'Vịet'))), null);

  const cjk = '今天天气很好我们去公园玩';
  assert.equal(merge3(cjk, cjk.replace('好', '棒'), cjk.replace('玩', '耍')), '今天天气很棒我们去公园耍');
  assert.equal(merge3(cjk, cjk.replace('很', '真'), cjk.replace('好', '棒')), null);
  assert.equal(merge3('今日は天気がいいです\n', '今日は天気がいいです。\n', '今夜は天気がいいです\n'), '今夜は天気がいいです。\n');

  const emoji = 'Great job 🎉 team 👍 well done 👨‍👩‍👧 today';
  assert.equal(merge3(emoji, emoji.replace('🎉', '🚀'), emoji.replace('👍', '🙌')), 'Great job 🚀 team 🙌 well done 👨‍👩‍👧 today');
  assert.equal(merge3(emoji, emoji.replace('🎉', '🚀'), emoji.replace('🎉', '🙌')), null);
  // A lone surrogate does not break the split.
  assert.equal(merge3('a \ud83d b c d\n', 'A \ud83d b c d\n', 'a \ud83d b c D\n'), 'A \ud83d b c D\n');
});

test('merge3 by words: fuzz against an independent oracle', () => {
  const r = rng(11);
  const pick = (n: number) => (r() * n) | 0;
  const fresh = ['Việt'.normalize('NFD'), '今', '日本語', '🎉', '👨‍👩‍👧', 'été', '(x)', '3.14', 'ß', "don't", '_u_', '—', 'x'.repeat(30)];
  for (let iter = 0; iter < 2000; iter++) {
    const base = Array.from({ length: 7 + pick(30) }, (_, i) => `w${i}`);
    const half = base.length >> 1;
    // Each side edits its own half, with an unchanged word between, so the correct merge is known by construction.
    const edit = (words: string[], tag: string) => {
      const out = [...words];
      for (let n = pick(4); n > 0 && out.length; n--) {
        const at = pick(out.length);
        const kind = pick(3);
        const word = `${fresh[pick(fresh.length)]}${tag}${n}`;
        if (kind === 0) out.splice(at, 0, word);
        else if (kind === 1) out.splice(at, 1);
        else out[at] = word;
      }
      return out;
    };
    const keep = base[half];
    const left = edit(base.slice(0, half), 'A');
    const right = edit(base.slice(half + 1), 'B');
    const text = (ws: string[]) => `${ws.join(' ')}\n`;
    const b = text(base);
    const ours = text([...left, keep, ...base.slice(half + 1)]);
    const theirs = text([...base.slice(0, half), keep, ...right]);
    const want = text([...left, keep, ...right]);
    assert.equal(merge3(b, ours, theirs), want, `iter ${iter}`);
    assert.equal(merge3(b, theirs, ours), want, `iter ${iter} swapped`);
    assert.equal(merge3(b, ours, b), ours);
    assert.equal(merge3(b, ours, ours), ours);
  }
});

test('mergeNote: properties merge key by key and the text below merges as before', () => {
  const note = (props: string, body = 'Body text\n') => `---\n${props}---\n${body}`;
  const base = note('title: A\nauthor: B\nstatus: draft\n');
  // Edits to neighbouring keys are not a conflict.
  assert.equal(mergeNote(base, note('title: A2\nauthor: B\nstatus: draft\n'), note('title: A\nauthor: B2\nstatus: draft\n')), note('title: A2\nauthor: B2\nstatus: draft\n'));
  // Properties on one side, text on the other.
  assert.equal(mergeNote(base, note('title: A\nauthor: B\nstatus: draft\n', 'Body changed\n'), note('title: A\nauthor: B\nstatus: done\n')), note('title: A\nauthor: B\nstatus: done\n', 'Body changed\n'));
  // Each side adds keys: theirs' order, then what only ours added.
  assert.equal(
    mergeNote(base, note('title: A\nauthor: B\nstatus: draft\nrating: 5\n'), note('title: A\nauthor: B\nstatus: draft\nyear: 2024\n')),
    note('title: A\nauthor: B\nstatus: draft\nyear: 2024\nrating: 5\n'),
  );
  // Both added a block to a note that had none.
  assert.equal(mergeNote('text\n', note('a: 1\n', 'text\n'), note('b: 2\n', 'text\n')), note('b: 2\na: 1\n', 'text\n'));
  // Windows line endings stay.
  const crlf = (props: string) => `---\r\n${props}---\r\nBody\r\n`;
  assert.equal(mergeNote(crlf('title: A\r\nstatus: x\r\n'), crlf('title: A2\r\nstatus: x\r\n'), crlf('title: A\r\nstatus: y\r\n')), crlf('title: A2\r\nstatus: y\r\n'));
  // Quoted keys and block values travel with their key.
  const rich = (title: string, extra: string) => note(`"my key": 1\ntitle: ${title}\ndesc: |\n  long\n  text\n# a comment\n${extra}`);
  assert.equal(mergeNote(rich('A', ''), rich('A', 'x: 1\n'), rich('B', '')), rich('B', 'x: 1\n'));
});

test('mergeNote: lists of tags merge as sets, in the style of theirs', () => {
  const note = (props: string) => `---\n${props}---\nBody\n`;
  assert.equal(mergeNote(note('tags: [a]\n'), note('tags: [a, b]\n'), note('tags: [a, c]\n')), note('tags: [a, c, b]\n'));
  assert.equal(mergeNote(note('tags:\n  - a\n'), note('tags:\n  - a\n  - b\n'), note('tags:\n    - a\n    - c\n')), note('tags:\n    - a\n    - c\n    - b\n'));
  assert.equal(mergeNote(note('tags: [a, b]\n'), note('tags: [b]\n'), note('tags: [a, b, c]\n')), note('tags: [b, c]\n'));
  // Inline on one side, a block on the other; both started with no tags at all.
  assert.equal(mergeNote(note('tags: [a]\n'), note('tags:\n  - a\n  - b\n'), note('tags: [a, c]\n')), note('tags: [a, c, b]\n'));
  assert.equal(mergeNote(note('x: 1\n'), note('x: 1\ntags: [a]\n'), note('x: 1\ntags:\n  - b\n')), note('x: 1\ntags:\n  - b\n  - a\n'));
  assert.equal(mergeNote(note('tags:\n'), note('tags:\n  - a\n'), note('tags:\n  - b\n')), note('tags:\n  - b\n  - a\n'));
  // Neighbouring keys changed on each side as well.
  assert.equal(mergeNote(note('title: A\ntags: [a]\n'), note('title: B\ntags: [a, b]\n'), note('title: A\ntags: [a, c]\n')), note('title: B\ntags: [a, c, b]\n'));
  // Not plain lists: the text of the entry is merged instead.
  assert.equal(mergeNote(note('tags:\n  - a: 1\n'), note('tags:\n  - a: 2\n'), note('tags:\n  - a: 3\n')), null);
});

test('mergeNote: a value both sides changed merges by words, or conflicts', () => {
  const note = (props: string) => `---\n${props}---\nBody\n`;
  const desc = 'description: alpha beta gamma delta epsilon\n';
  assert.equal(
    mergeNote(note(desc), note('description: ALPHA beta gamma delta epsilon\n'), note('description: alpha beta gamma delta EPSILON\n')),
    note('description: ALPHA beta gamma delta EPSILON\n'),
  );
  assert.equal(mergeNote(note(desc), note('description: ALPHA beta gamma delta epsilon\n'), note('description: Alpha beta gamma delta epsilon\n')), null);
  assert.equal(mergeNote(note(desc), note('description: alpha BETA gamma delta epsilon\n'), note('description: alpha beta GAMMA delta epsilon\n')), null);
  // The same key added with different values.
  assert.equal(mergeNote(note('a: 1\n'), note('a: 1\nstatus: x\n'), note('a: 1\nstatus: y\n')), null);
  // A conflict in the properties is a conflict of the note, even when the text below merges.
  assert.equal(mergeNote(`---\n${desc}---\nBody\n`, `---\ndescription: X beta gamma delta epsilon\n---\nBody\n`, `---\ndescription: Y beta gamma delta epsilon\n---\nBody 2\n`), null);
});

test('mergeNote: a key one side deleted and the other left alone is gone; one it edited stays', () => {
  const note = (props: string) => `---\n${props}---\nBody\n`;
  const base = note('title: A\nstatus: draft\nrating: 3\n');
  assert.equal(mergeNote(base, note('title: A\nrating: 3\n'), note('title: B\nstatus: draft\nrating: 3\n')), note('title: B\nrating: 3\n'));
  assert.equal(mergeNote(base, note('title: B\nstatus: draft\nrating: 3\n'), note('title: A\nrating: 3\n')), note('title: B\nrating: 3\n'));
  assert.equal(mergeNote(base, note('title: A\nrating: 3\n'), note('title: A\nstatus: published\nrating: 3\n')), note('title: A\nstatus: published\nrating: 3\n'));
  assert.equal(mergeNote(base, note('title: A\nstatus: published\nrating: 3\n'), note('title: A\nrating: 3\n')), note('title: A\nrating: 3\nstatus: published\n'));
  // Both deleted it.
  assert.equal(mergeNote(base, note('title: A\nrating: 3\n'), note('title: A\nrating: 3\n')), note('title: A\nrating: 3\n'));
});

test('mergeNote: a side without properties, or properties it cannot read, merges as plain text', () => {
  const note = (props: string, body = 'body\n') => `---\n${props}---\n${body}`;
  // One side has no properties block: the whole text merges line by line.
  assert.equal(mergeNote(note('a: 1\n'), `new top\n${note('a: 1\n')}`, note('a: 2\n')), `new top\n${note('a: 2\n')}`);
  assert.equal(mergeNote(note('a: 1\n'), note('a: 2\n'), 'no properties\n'), null);
  // An opening line with no closing one is not a block, and neither is `---` with something after it.
  assert.equal(mergeNote('---\na: 1\nbody\n', '---\na: 2\nbody\n', '---\na: 1\nbody\nmore\n'), '---\na: 2\nbody\nmore\n');
  assert.equal(mergeNote('--- x\na: 1\n---\nb\n', '--- x\na: 2\n---\nb\n', '--- x\na: 1\n---\nb\nc\n'), '--- x\na: 2\n---\nb\nc\n');

  // A line that is not a key, a key repeated, or a flow mapping.
  const odd = (a: string, b: string) => note(`title: ${a}\nnot yaml at all\nmore: ${b}\n`);
  assert.equal(mergeNote(odd('A', 'x'), odd('A2', 'x'), odd('A', 'y')), odd('A2', 'y'));
  assert.equal(mergeNote(note('not yaml\n'), note('not YAML\n'), note('not Yaml\n')), null);
  assert.equal(mergeNote(note('a: 1\na: 2\nz: 1\n'), note('a: 1\na: 2\nz: 2\n'), note('a: 0\na: 2\nz: 1\n')), note('a: 0\na: 2\nz: 2\n'));
  assert.equal(mergeNote(note('a: 1\na: 2\n'), note('a: 1\na: 3\n'), note('a: 1\na: 4\n')), null);
});

test('mergeNote: a closing line with no line break after it gets one when the text below is not empty', () => {
  // Theirs ends right after the closing `---`, and ours has text below it.
  assert.equal(mergeNote('---\na: 1\n---', '---\na: 1\n---\nHello\n', '---\na: 2\n---'), '---\na: 2\n---\nHello\n');
  assert.equal(mergeNote('---\r\na: 1\r\n---', '---\r\na: 1\r\n---\r\nHello\r\n', '---\r\na: 2\r\n---'), '---\r\na: 2\r\n---\r\nHello\r\n');
  assert.equal(mergeNote('---\na: 1\n---', '---\na: 1\nb: 1\n---\nHello\n', '---\na: 2\n---\nHello\n'), '---\na: 2\nb: 1\n---\nHello\n');
  // With nothing below, nothing is added.
  assert.equal(mergeNote('---\na: 1\n---', '---\na: 1\nb: 1\n---', '---\na: 2\n---'), '---\na: 2\nb: 1\n---');
});

test('mergeNote: fuzz over property and text edits, with and without a final line break, always leaves a properties block that reads', () => {
  const r = rng(7);
  const pick = (n: number) => (r() * n) | 0;
  type Val = { scalar: string } | { items: string[]; inline: boolean };
  interface Doc {
    props: Map<string, Val>;
    body: string[];
    closeBreak: boolean;
  }
  const render = (d: Doc) => {
    let s = '---\n';
    for (const [k, v] of d.props) {
      if ('scalar' in v) s += `${k}: ${v.scalar}\n`;
      else s += v.inline ? `${k}: [${v.items.join(', ')}]\n` : `${k}:\n${v.items.map((x) => `  - ${x}\n`).join('')}`;
    }
    return `${s}---${d.body.length || d.closeBreak ? '\n' : ''}${d.body.join('')}`;
  };
  // A block that reads: it opens and closes on lines of exactly `---`, and holds each key once.
  const reads = (text: string) => {
    const lines = text.split('\n');
    const end = lines.findIndex((l, i) => i > 0 && l === '---');
    if (lines[0] !== '---' || end < 0) return false;
    const keys = lines.slice(1, end).filter((l) => /^[a-z0-9]+:/.test(l)).map((l) => l.slice(0, l.indexOf(':')));
    return new Set(keys).size === keys.length;
  };
  let fresh = 0;
  let merged = 0;
  const bad: string[] = [];
  for (let iter = 0; iter < 4000; iter++) {
    const props = new Map<string, Val>();
    for (let i = 0, n = 1 + pick(4); i < n; i++) {
      props.set(`k${i}`, r() < 0.5 ? { scalar: `v${i}` } : { inline: r() < 0.5, items: Array.from({ length: pick(3) }, (_, j) => `i${i}${j}`) });
    }
    const base: Doc = { props, body: r() < 0.4 ? [] : Array.from({ length: 1 + pick(3) }, (_, i) => `line ${i}\n`), closeBreak: r() < 0.7 };
    const edit = (side: string): Doc => {
      const p = new Map<string, Val>();
      for (const [k, v] of base.props) {
        const x = r();
        if (x < 0.1) continue;
        if (x >= 0.3) p.set(k, v);
        else if ('scalar' in v) p.set(k, { scalar: `${side}${fresh++}` });
        else p.set(k, { ...v, items: [...v.items.filter(() => r() < 0.7), ...(r() < 0.6 ? [`${side}${fresh++}`] : [])] });
      }
      if (r() < 0.2) p.set(`n${side}${fresh++}`, { scalar: 'new' });
      const body = [...base.body];
      if (r() < 0.3) body.push(`${side} added ${fresh++}\n`);
      if (r() < 0.2 && body.length) body[0] = `${side} edit ${fresh++}\n`;
      return { props: p, body, closeBreak: r() < 0.5 ? base.closeBreak : !base.closeBreak };
    };
    const [o, a, b] = [render(base), render(edit('x')), render(edit('y'))];
    const m = mergeNote(o, a, b);
    if (m === null) continue;
    merged++;
    if (!reads(m) && bad.length < 3) bad.push(JSON.stringify({ o, a, b, m }));
  }
  assert.deepEqual(bad, []);
  assert.ok(merged > 2000, `${merged} of 4000 merged`);
});

test('mergeNote: a list item that would not read back inline is written as a block, and one that does stays inline', () => {
  const note = (props: string) => `---\n${props}---\nBody\n`;
  // A comma would split a name into two values, and ` #` would start a comment that swallows the bracket.
  assert.equal(mergeNote(note('authors: [Smith]\n'), note('authors:\n  - Smith\n  - Doe, John\n'), note('authors: [Smith, Lee]\n')), note('authors:\n  - Smith\n  - Lee\n  - Doe, John\n'));
  assert.equal(mergeNote(note('tags: [a]\n'), note('tags:\n  - a\n  - b #c\n'), note('tags: [a, d]\n')), note('tags:\n  - a\n  - d\n  - b #c\n'));
  assert.equal(mergeNote(note('tags: [a]\n'), note('tags:\n  - a\n  - "x"\n'), note('tags: [a, d]\n')), note('tags:\n  - a\n  - d\n  - "x"\n'));
  for (const item of ['x[1]', 'x{y}', 'x,y', 'x #y', "'x'"]) {
    assert.equal(mergeNote(note('t: [a]\n'), note(`t:\n  - a\n  - ${item}\n`), note('t: [a, d]\n')), note(`t:\n  - a\n  - d\n  - ${item}\n`), item);
  }
  // CRLF and a longer indent are kept in the block it becomes.
  assert.equal(mergeNote('---\r\nt: [a]\r\n---\r\n', '---\r\nt:\r\n  - a\r\n  - x, y\r\n---\r\n', '---\r\nt: [a, d]\r\n---\r\n'), '---\r\nt:\r\n  - a\r\n  - d\r\n  - x, y\r\n---\r\n');
  // Items that read back stay inline, whichever side they came from.
  assert.equal(mergeNote(note('t: [a]\n'), note('t:\n  - a\n  - b c\n  - d-e\n'), note('t: [a, f]\n')), note('t: [a, f, b c, d-e]\n'));

  // The other way: theirs is a block, ours inline.
  assert.equal(mergeNote(note('authors:\n  - Smith\n'), note('authors: [Smith, Lee]\n'), note('authors:\n  - Smith\n  - Doe, John\n')), note('authors:\n  - Smith\n  - Doe, John\n  - Lee\n'));
  assert.equal(mergeNote(note('t:\n  - a\n'), note('t: [a, b]\n'), note('t:\n    - a\n    - c, d\n')), note('t:\n    - a\n    - c, d\n    - b\n'));
  // An item neither style can hold is not forced into either: the entry merges as text, here to a conflict.
  assert.equal(mergeNote(note('t:\n  - a\n'), note('t: [a, !x]\n'), note('t:\n  - a\n  - b\n')), null);
});

test('words: the tokens of any text join back to it, lone carriage returns, marks, zero-width characters and emoji included', () => {
  const r = rng(5);
  const pick = (n: number) => (r() * n) | 0;
  const parts = ['\r', '\n', '\r\n', '\t', ' ', '  ', '\u00a0', '\u200b', '\u200d', '\ufeff', '\u2028', '\v', '😀', '👨‍👩‍👧', 'e\u0301', 'a', 'word', '今', 'か', 'ア', 'ก', '\ud800', '-', '(x)'];
  for (let iter = 0; iter < 5000; iter++) {
    const s = Array.from({ length: pick(14) }, () => parts[pick(parts.length)]).join('');
    assert.equal(words(s).join(''), s, JSON.stringify(s));
  }
  assert.deepEqual(words('a\rb\r\nc'), ['a', '\r', 'b', '\r\n', 'c']);
});

test('merge3 by words: a carriage return that is not part of a line ending is kept', () => {
  assert.equal(merge3('one two\rthree four five\n', 'ONE two\rthree four five\n', 'one two\rthree four FIVE\n'), 'ONE two\rthree four FIVE\n');
  assert.equal(merge3('one two\r\rthree four five\n', 'one two\r\rthree four FIVE\n', 'ONE two\r\rthree four five\n'), 'ONE two\r\rthree four FIVE\n');
});

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'text', text: `text of ${id}`, x: 0, y: 0, width: 250, height: 60, ...extra });
const edge = (id: string, from: string, to: string) => ({ id, fromNode: from, fromSide: 'right', toNode: to, toSide: 'left' });
const obsidian = (nodes: object[], edges: object[] = []) => {
  const list = (key: string, xs: object[]) => (xs.length ? `\t"${key}":[\n${xs.map((x) => `\t\t${JSON.stringify(x)}`).join(',\n')}\n\t]` : `\t"${key}":[]`);
  return `{\n${list('nodes', nodes)},\n${list('edges', edges)}\n}`;
};
const parse = (text: string | null) => JSON.parse(text!) as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };

test('mergeCanvas: a node moved on one side and reworded on the other keeps both', () => {
  const base = obsidian([node('a'), node('b', { text: 'one two three four five' })], [edge('e', 'a', 'b')]);
  const ours = obsidian([node('a', { x: 100, y: -40 }), node('b', { text: 'ONE two three four five' })], [edge('e', 'a', 'b')]);
  const theirs = obsidian([node('a', { text: 'reworded' }), node('b', { text: 'one two three four FIVE', color: '4' })], [edge('e', 'a', 'b')]);
  const merged = parse(mergeCanvas(base, ours, theirs));
  assert.deepEqual(merged.nodes, [node('a', { x: 100, y: -40, text: 'reworded' }), node('b', { text: 'ONE two three four FIVE', color: '4' })]);
  assert.deepEqual(merged.edges, [edge('e', 'a', 'b')]);
});

test('mergeCanvas: where both changed a position or colour, theirs wins; a text both changed conflicts', () => {
  const base = obsidian([node('a', { text: 'x y z' })]);
  const moved = (x: number, text: string) => obsidian([node('a', { x, text, color: String(x) })]);
  assert.deepEqual(parse(mergeCanvas(base, moved(10, 'x y z'), moved(20, 'x y z'))).nodes, [node('a', { x: 20, color: '20', text: 'x y z' })]);
  assert.equal(mergeCanvas(base, moved(10, 'x A z'), moved(20, 'x B z')), null);
  assert.deepEqual(parse(mergeCanvas(base, moved(10, 'x y z'), moved(20, 'x y z!'))).nodes, [node('a', { x: 20, color: '20', text: 'x y z!' })]);
});

test('mergeCanvas: nodes added on both sides are all kept, theirs first', () => {
  const base = obsidian([node('a')]);
  const ours = obsidian([node('a'), node('o1'), node('o2')], [edge('eo', 'a', 'o1')]);
  const theirs = obsidian([node('t1'), node('a')], [edge('et', 't1', 'a')]);
  const merged = parse(mergeCanvas(base, ours, theirs));
  assert.deepEqual(merged.nodes.map((n) => n.id), ['t1', 'a', 'o1', 'o2']);
  assert.deepEqual(merged.edges.map((e) => e.id), ['et', 'eo']);
});

test('mergeCanvas: a node deleted on one side and moved on the other is kept; one deleted and untouched is gone', () => {
  const base = obsidian([node('a'), node('b'), node('c')], [edge('e', 'a', 'b')]);
  const ours = obsidian([node('a'), node('c')]);
  const theirs = obsidian([node('a'), node('b', { x: 500 }), node('c', { y: 9 })], [edge('e', 'a', 'b')]);
  const merged = parse(mergeCanvas(base, ours, theirs));
  assert.deepEqual(merged.nodes, [node('a'), node('b', { x: 500 }), node('c', { y: 9 })]);
  // The edge was deleted by one side and not touched by the other, so it goes.
  assert.deepEqual(merged.edges, []);
  const gone = parse(mergeCanvas(base, obsidian([node('a'), node('c')]), obsidian([node('a', { x: 1 }), node('b'), node('c')], [edge('e', 'a', 'b')])));
  assert.deepEqual(gone.nodes.map((n) => n.id), ['a', 'c']);
  assert.deepEqual(gone.edges, []);
});

test('mergeCanvas: an edge to a node that was deleted is dropped', () => {
  const base = obsidian([node('a'), node('b')], [edge('e1', 'a', 'b')]);
  const ours = obsidian([node('a')]);
  const theirs = obsidian([node('a'), node('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
  const merged = parse(mergeCanvas(base, ours, theirs));
  assert.deepEqual(merged.nodes.map((n) => n.id), ['a']);
  assert.deepEqual(merged.edges, []);
});

test('mergeCanvas: something that is not a canvas, or two ids alike, is not merged', () => {
  const base = obsidian([node('a')]);
  const one = obsidian([node('a', { x: 1 })]);
  const two = obsidian([node('a'), node('b')]);
  assert.equal(mergeCanvas(base, 'not json', two), null);
  assert.equal(mergeCanvas(base, one, '{"nodes":'), null);
  assert.equal(mergeCanvas(base, '[]', two), null);
  assert.equal(mergeCanvas(base, '{"nodes":{}}', two), null);
  assert.equal(mergeCanvas(base, one, obsidian([node('a'), node('b'), node('b')])), null);
  assert.equal(mergeCanvas(base, one, JSON.stringify({ nodes: [{ text: 'no id' }] })), null);
  assert.equal(mergeCanvas(base, one, JSON.stringify({ nodes: [{ id: 5 }] })), null);
  // A base that cannot be read is an empty canvas: everything either side has is an addition.
  assert.deepEqual(parse(mergeCanvas('garbage', obsidian([node('a')]), obsidian([node('b')]))).nodes.map((n) => n.id), ['b', 'a']);
  // Missing lists are empty ones.
  assert.deepEqual(parse(mergeCanvas('{}', '{"nodes":[{"id":"a"}]}', '{"edges":[]}')).nodes, [{ id: 'a' }]);
});

test('mergeCanvas: a result equal to one side is that side\'s bytes, any other is written the way Obsidian does', () => {
  const base = obsidian([node('a')]);
  const added = [node('a'), node('b')];
  const ours = JSON.stringify({ nodes: [node('a', { x: 7 }), node('b')], edges: [] }, null, 2);
  const theirs = JSON.stringify({ nodes: added, edges: [] });
  assert.equal(mergeCanvas(base, ours, theirs), ours);
  assert.equal(mergeCanvas(base, theirs, ours), ours);

  const out = mergeCanvas(base, obsidian([node('a', { x: 1 })]), obsidian([node('a', { y: 2 }), node('b')], [edge('e', 'a', 'b')]));
  assert.equal(out, obsidian([node('a', { x: 1, y: 2 }), node('b')], [edge('e', 'a', 'b')]));
  // Other top-level keys merge like settings.
  const keyed = JSON.parse(mergeCanvas('{"nodes":[],"edges":[],"v":1,"k":{"a":1}}', '{"nodes":[],"edges":[],"v":2,"k":{"a":1}}', '{"nodes":[{"id":"n"}],"edges":[],"v":1,"k":{"a":1,"b":2}}')!);
  assert.deepEqual(keyed, { nodes: [{ id: 'n' }], edges: [], v: 2, k: { a: 1, b: 2 } });
});
