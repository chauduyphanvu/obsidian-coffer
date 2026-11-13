const MAX_D = 2000;

/** For each index of `x`, the index in `y` it is matched to in a longest common subsequence, or -1. Null when the inputs differ too much. */
function lcsMatch(x: Int32Array, y: Int32Array): Int32Array | null {
  const n = x.length;
  const m = y.length;
  const match = new Int32Array(n).fill(-1);
  let pre = 0;
  while (pre < n && pre < m && x[pre] === y[pre]) {
    match[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (suf < n - pre && suf < m - pre && x[n - 1 - suf] === y[m - 1 - suf]) {
    match[n - 1 - suf] = m - 1 - suf;
    suf++;
  }
  const N = n - pre - suf;
  const M = m - pre - suf;
  if (N === 0 || M === 0) return match;

  // Myers O(ND), keeping the frontier of every step for the walk back.
  const max = Math.min(N + M, MAX_D);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let xx = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let yy = xx - k;
      while (xx < N && yy < M && x[pre + xx] === y[pre + yy]) {
        xx++;
        yy++;
      }
      v[off + k] = xx;
      if (xx >= N && yy >= M) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) return null;

  let xx = N;
  let yy = M;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const o = d + 1;
    const k = xx - yy;
    const pk = k === -d || (k !== d && vv[o + k - 1] < vv[o + k + 1]) ? k + 1 : k - 1;
    const px = vv[o + pk];
    const snakeStart = pk === k + 1 ? px : px + 1;
    while (xx > snakeStart) {
      xx--;
      yy--;
      match[pre + xx] = pre + yy;
    }
    xx = px;
    yy = px - pk;
  }
  while (xx > 0) {
    xx--;
    yy--;
    match[pre + xx] = pre + yy;
  }
  return match;
}

function sliceEq(a: Int32Array, a0: number, a1: number, b: Int32Array, b0: number, b1: number): boolean {
  if (a1 - a0 !== b1 - b0) return false;
  for (let i = 0; i < a1 - a0; i++) if (a[a0 + i] !== b[b0 + i]) return false;
  return true;
}

/**
 * `s` cut after each newline, which stays at the end of its line; '' gives ['']. What `s.split(/(?<=\n)/)` returns,
 * without a lookbehind: iOS before 16.4 cannot run one.
 */
export function splitLines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let nl = s.indexOf('\n'); nl !== -1; nl = s.indexOf('\n', start)) {
    out.push(s.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < s.length || !out.length) out.push(s.slice(start));
  return out;
}

/**
 * Three-way merge of token sequences. A base token matched on both sides is an anchor unless `weak` says so; whatever
 * lies between two anchors is one region. A region both sides changed differently goes to `inner`, and without it
 * (or when it gives up) the whole merge is null.
 */
function mergeTokens(
  O: string[],
  A: string[],
  B: string[],
  weak?: (token: string) => boolean,
  inner?: (base: string, ours: string, theirs: string) => string | null,
): string | null {
  const ids = new Map<string, number>();
  const intern = (ts: string[]) => Int32Array.from(ts, (t) => ids.get(t) ?? (ids.set(t, ids.size), ids.size - 1));
  const o = intern(O);
  const a = intern(A);
  const b = intern(B);
  const ma = lcsMatch(o, a);
  const mb = lcsMatch(o, b);
  if (!ma || !mb) return null;

  const out: string[] = [];
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (let i = 0; i <= o.length; i++) {
    const anchor = i < o.length && ma[i] >= 0 && mb[i] >= 0 && !weak?.(O[i]);
    if (!anchor && i < o.length) continue;
    const ea = anchor ? ma[i] : a.length;
    const eb = anchor ? mb[i] : b.length;
    if (sliceEq(a, ia, ea, o, io, i)) out.push(B.slice(ib, eb).join(''));
    else if (sliceEq(b, ib, eb, o, io, i) || sliceEq(a, ia, ea, b, ib, eb)) out.push(A.slice(ia, ea).join(''));
    else {
      const both = inner?.(O.slice(io, i).join(''), A.slice(ia, ea).join(''), B.slice(ib, eb).join(''));
      if (both == null) return null;
      out.push(both);
    }
    if (anchor) out.push(A[ea]);
    io = i + 1;
    ia = ea + 1;
    ib = eb + 1;
  }
  return out.join('');
}

// Scripts written without spaces split into single characters; a lookahead rather than a lookbehind, for iOS before 16.4.
const UNSPACED = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}';
const WORDS = new RegExp(`\\r?\\n|\\r|[^\\S\\r\\n]+|[${UNSPACED}]|(?:(?![${UNSPACED}])\\S)+`, 'gu');
export const words = (s: string) => s.match(WORDS) ?? [];
const isSpace = (token: string) => /^\s/.test(token);

/**
 * Words of a region both sides changed. Whitespace never anchors, so two edits merge only with an unchanged word
 * between them: "I like cats" edited to "I love cats" and "I like dogs" must not quietly become "I love dogs".
 */
const mergeWords = (base: string, ours: string, theirs: string) => mergeTokens(words(base), words(ours), words(theirs), isSpace);

/**
 * Three-way merge by lines; a line both sides changed is merged by words. Returns null when both sides changed the
 * same words differently.
 */
export function merge3(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  return mergeTokens(splitLines(base), splitLines(ours), splitLines(theirs), undefined, mergeWords);
}

interface Front {
  open: string;
  props: string;
  close: string;
  body: string;
}

/** The properties block at the top of a note: from a first line of exactly `---` to the next such line. */
function frontmatter(text: string): Front | undefined {
  const lines = splitLines(text);
  if (!/^---\r?\n$/.test(lines[0])) return undefined;
  const end = lines.findIndex((l, i) => i > 0 && /^---\r?\n?$/.test(l));
  if (end < 0) return undefined;
  return { open: lines[0], props: lines.slice(1, end).join(''), close: lines[end], body: lines.slice(end + 1).join('') };
}

// A key is quoted or plain, at column 0, and followed by `:` and a space or the end of the line.
const KEY = /^(?:"((?:[^"\\\r\n]|\\.)+)"|'((?:[^'\r\n]|'')+)'|([^\s"'#\-[\]{}&*!|>%@`,?:][^\r\n:]*))[ \t]*:(?=[ \t\r\n]|$)/;
// What belongs to the key above it: indented lines, `- item` lines, comments and blank lines.
const CONTINUES = /^(?:[ \t#\r\n]|-(?:[ \t\r\n]|$))/;

/** The top-level entries of a properties block by key, each with its lines; '' holds what precedes the first key. Undefined when a line fits nowhere or a key repeats. */
function entries(props: string): Map<string, string> | undefined {
  const out = new Map<string, string>();
  let key = '';
  let text = '';
  for (const line of props ? splitLines(props) : []) {
    if (CONTINUES.test(line)) {
      text += line;
      continue;
    }
    const m = KEY.exec(line);
    if (!m) return undefined;
    if (text) out.set(key, text);
    key = m[1] ?? m[2] ?? m[3].trimEnd();
    if (out.has(key)) return undefined;
    text = line;
  }
  if (text) out.set(key, text);
  return out;
}

interface SimpleList {
  items: string[];
  /** The entry holding `items`, in its own style or else as a block: whichever reads back as exactly these items. Undefined when neither does. */
  render: (items: string[]) => string | undefined;
}

/** True when `text` is a simple list of exactly `items`. */
function readsAs(text: string, items: string[]): boolean {
  const read = simpleList(text)?.items;
  return !!read && read.length === items.length && read.every((x, i) => x === items[i]);
}

/** An entry that is only a list of plain values, inline (`[a, b]`) or one `- a` line each, and how to write another in its style. */
function simpleList(entry: string): SimpleList | undefined {
  const lines = splitLines(entry);
  const head = KEY.exec(lines[0])?.[0];
  if (head === undefined) return undefined;
  const rest = lines[0].slice(head.length).replace(/\r?\n$/, '');
  const eol = /\r?\n$/.exec(lines[0])?.[0] ?? '';
  const block = (xs: string[], first: string, indent: string) => first + xs.map((x) => `${indent}- ${x}${eol}`).join('');
  const inline = lines.length === 1 ? /^([ \t]*)\[([^[\]'"{}#:]*)\][ \t]*$/.exec(rest) : null;
  if (inline) {
    const items = inline[2].split(',').map((x) => x.trim()).filter(Boolean);
    // A comma, bracket, `#` or quote in an item changes what an inline list means.
    return { items, render: (xs) => [`${head}${inline[1]}[${xs.join(', ')}]${eol}`, block(xs, head + eol, '  ')].find((text) => readsAs(text, xs)) };
  }
  if (rest.trim()) return undefined;
  let indent: string | undefined;
  const items: string[] = [];
  for (const line of lines.slice(1)) {
    const m = /^([ \t]*)-[ \t]+([^\s[{|>&*!%@#][^\r\n]*?)[ \t]*\r?\n$/.exec(line);
    if (!m || /:([ \t]|$)/.test(m[2]) || (indent ??= m[1]) !== m[1]) return undefined;
    items.push(m[2]);
  }
  return {
    items,
    render: (xs) => {
      const text = block(xs, lines[0], indent ?? '  ');
      return readsAs(text, xs) ? text : undefined;
    },
  };
}

/** One entry's three versions, undefined being absent: null when both sides changed it in a way that cannot be combined. */
function mergeEntry(base: string | undefined, ours: string | undefined, theirs: string | undefined): string | undefined | null {
  if (ours === theirs || base === ours) return theirs;
  if (base === theirs) return ours;
  // Deleted on one side and edited on the other: the edit stays, as with files.
  if (ours === undefined || theirs === undefined) return ours ?? theirs;
  const o = simpleList(ours);
  const t = simpleList(theirs);
  const b = base === undefined ? { items: [] as string[] } : simpleList(base);
  if (o && t && b) {
    // Lists of plain values are sets, as in settings: keep both sides' additions and removals.
    const items = t.items.filter((x) => o.items.includes(x) || !b.items.includes(x));
    for (const x of o.items) if (!items.includes(x) && !b.items.includes(x)) items.push(x);
    const text = t.render(items);
    if (text !== undefined) return text;
  }
  return merge3(base ?? '', ours, theirs);
}

function mergeProperties(base: string, ours: string, theirs: string): string | null {
  const b = entries(base);
  const o = entries(ours);
  const t = entries(theirs);
  if (!b || !o || !t) return merge3(base, ours, theirs);
  let out = '';
  // Theirs' keys in their order, then what only ours added; what precedes the first key stays first.
  for (const key of new Set(['', ...t.keys(), ...o.keys()])) {
    const merged = mergeEntry(b.get(key), o.get(key), t.get(key));
    if (merged === null) return null;
    out += merged ?? '';
  }
  return out;
}

/**
 * Three-way merge of a note: the properties block key by key, the text below it as `merge3`. A side with no
 * properties block merges the whole text as one.
 */
export function mergeNote(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  const o = frontmatter(ours);
  const t = frontmatter(theirs);
  if (!o || !t) return merge3(base, ours, theirs);
  const b = frontmatter(base) ?? { props: '', body: base };
  const props = mergeProperties(b.props, o.props, t.props);
  const body = merge3(b.body, o.body, t.body);
  if (props === null || body === null) return null;
  // Theirs may end right after its closing line, and text below it needs a line of its own.
  const close = body && !t.close.endsWith('\n') ? t.close + (/\r?\n$/.exec(o.close)?.[0] ?? '\n') : t.close;
  return t.open + props + close + body;
}

/** Lines both texts share; `aStart`/`bStart` are where they begin in each, counting lines from 0. */
export interface SameLines {
  kind: 'same';
  lines: string[];
  aStart: number;
  bStart: number;
}

/** Where the first text has the lines `a` the second has `b`; one of them may be empty. */
export interface ChangedLines {
  kind: 'change';
  a: string[];
  b: string[];
  aStart: number;
  bStart: number;
}

export type DiffRegion = SameLines | ChangedLines;

/**
 * Line diff from `a` to `b` in reading order, shared runs and changes alternating. Lines keep their endings, so one
 * side's lines joined give that text back byte for byte. Null when the texts differ too much, as for `merge3`.
 */
export function lineDiff(a: string, b: string): DiffRegion[] | null {
  const lines = (s: string) => (s ? splitLines(s) : []);
  const ids = new Map<string, number>();
  const intern = (ls: string[]) => Int32Array.from(ls, (l) => ids.get(l) ?? (ids.set(l, ids.size), ids.size - 1));
  const A = lines(a);
  const B = lines(b);
  const match = lcsMatch(intern(A), intern(B));
  if (!match) return null;
  const out: DiffRegion[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    const i0 = i;
    const j0 = j;
    while (i < A.length && match[i] === j) {
      i++;
      j++;
    }
    if (i > i0) out.push({ kind: 'same', lines: A.slice(i0, i), aStart: i0, bStart: j0 });
    const i1 = i;
    const j1 = j;
    while (i < A.length && match[i] < 0) i++;
    j = i < A.length ? match[i] : B.length;
    if (i > i1 || j > j1) out.push({ kind: 'change', a: A.slice(i1, i), b: B.slice(j1, j), aStart: i1, bStart: j1 });
  }
  return out;
}

/** Lines removed from `a` and added in `b`, over how many changes. */
export function diffCounts(regions: DiffRegion[]): { changes: number; removed: number; added: number } {
  const out = { changes: 0, removed: 0, added: 0 };
  for (const r of regions) {
    if (r.kind === 'same') continue;
    out.changes++;
    out.removed += r.a.length;
    out.added += r.b.length;
  }
  return out;
}

/** A change with up to `context` shared lines either side of it, for showing it on its own. */
export interface Hunk {
  change: ChangedLines;
  before: string[];
  after: string[];
}

export function hunks(regions: DiffRegion[], context: number): Hunk[] {
  const out: Hunk[] = [];
  regions.forEach((r, i) => {
    if (r.kind === 'same') return;
    const prev = regions[i - 1];
    const next = regions[i + 1];
    out.push({
      change: r,
      before: prev?.kind === 'same' ? prev.lines.slice(Math.max(0, prev.lines.length - context)) : [],
      after: next?.kind === 'same' ? next.lines.slice(0, context) : [],
    });
  });
  return out;
}

/** At one change: `a`'s lines (mine), `b`'s (theirs), or `a`'s followed by `b`'s (both). */
export type Choice = 'mine' | 'theirs' | 'both';

/** The text `regions` make with `choices[k]` taken at the k-th change. All 'mine' gives `a` back exactly, all 'theirs' `b`. */
export function applyChoices(regions: DiffRegion[], choices: readonly Choice[]): string {
  const { changes } = diffCounts(regions);
  if (choices.length !== changes) throw new Error(`${choices.length} choices for ${changes} changes`);
  const ending = () => (regions.flatMap((r) => (r.kind === 'same' ? r.lines : [...r.a, ...r.b])).find((l) => l.endsWith('\n'))?.endsWith('\r\n') ? '\r\n' : '\n');
  const out: string[] = [];
  let k = 0;
  for (const r of regions) {
    if (r.kind === 'same') {
      out.push(...r.lines);
      continue;
    }
    const a = r.a.join('');
    const b = r.b.join('');
    const c = choices[k++];
    if (c === 'mine') out.push(a);
    else if (c === 'theirs') out.push(b);
    // Only a text's last line can lack an ending; without one, `a`'s last line would run into `b`'s first.
    else out.push(a, a && b && !a.endsWith('\n') ? ending() : '', b);
  }
  return out.join('');
}

const isObject =(v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isList = (v: unknown): v is (string | number | boolean | null)[] => Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object');
/** Own keys only, so a key named `__proto__` or `constructor` reads as plain data. */
const get = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

/** `undefined` is an absent key. A value both sides changed differently goes to `theirs`. */
function mergeValue(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (equal(ours, theirs) || equal(base, ours)) return theirs;
  if (equal(base, theirs)) return ours;
  if (isObject(ours) && isObject(theirs)) {
    const b = isObject(base) ? base : {};
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
      const v = mergeValue(get(b, k), get(ours, k), get(theirs, k));
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  // Lists of plain values (enabled plugins, snippets) are sets: keep both sides' additions and removals.
  if (isList(ours) && isList(theirs) && (base === undefined || isList(base))) {
    const b = base ?? [];
    const out = theirs.filter((x) => ours.includes(x) || !b.includes(x));
    for (const x of ours) if (!out.includes(x) && !b.includes(x)) out.push(x);
    return out;
  }
  return theirs;
}

/**
 * Three-way merge of a JSON settings file, key by key. `base` is the last version both sides had, if known.
 * Returns null when either side is not valid JSON.
 */
export function mergeJson(base: string | undefined, ours: string, theirs: string): string | null {
  let o: unknown;
  let t: unknown;
  try {
    o = JSON.parse(ours);
    t = JSON.parse(theirs);
  } catch {
    return null;
  }
  let b: unknown;
  try {
    b = base === undefined ? undefined : JSON.parse(base);
  } catch {
    b = undefined;
  }
  const merged = mergeValue(b, o, t);
  if (equal(merged, t)) return theirs;
  if (equal(merged, o)) return ours;
  // Obsidian writes its settings with two-space indentation.
  return JSON.stringify(merged, null, 2);
}

type Item = Record<string, unknown>;

interface Canvas {
  nodes: Item[];
  edges: Item[];
  other: Item;
}

/** A canvas: an object whose `nodes` and `edges` (empty when missing) hold objects with unique string ids. */
function parseCanvas(text: string): Canvas | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(v)) return undefined;
  const { nodes = [], edges = [], ...other } = v;
  const items = (xs: unknown): xs is Item[] =>
    Array.isArray(xs) && xs.every(isObject) && xs.every((x) => typeof x.id === 'string') && new Set(xs.map((x) => x.id)).size === xs.length;
  return items(nodes) && items(edges) ? { nodes, edges, other } : undefined;
}

/** A node or edge on both sides: key by key, a text by `merge3`, and for any other key both changed, theirs. Null when a text cannot be merged. */
function mergeItem(base: Item | undefined, ours: Item, theirs: Item): Item | null {
  const out = Object.create(null) as Item;
  for (const k of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
    const b = base && get(base, k);
    const o = get(ours, k);
    const t = get(theirs, k);
    let v = t;
    if (equal(b, t)) v = o;
    else if (!equal(b, o) && !equal(o, t) && (k === 'text' || k === 'label') && typeof o === 'string' && typeof t === 'string') {
      const text = merge3(typeof b === 'string' ? b : '', o, t);
      if (text === null) return null;
      v = text;
    }
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Nodes or edges by id: theirs' order, then what only ours has. One side deleting what the other edited keeps the edit. */
function mergeById(base: Item[], ours: Item[], theirs: Item[]): Item[] | null {
  const byId = (xs: Item[]) => new Map(xs.map((x) => [x.id as string, x]));
  const [b, o, t] = [base, ours, theirs].map(byId);
  const out: Item[] = [];
  for (const id of new Set([...t.keys(), ...o.keys()])) {
    const [bv, ov, tv] = [b.get(id), o.get(id), t.get(id)];
    let v: Item | null | undefined;
    if (equal(ov, tv) || equal(bv, ov)) v = tv;
    else if (equal(bv, tv)) v = ov;
    else if (!ov || !tv) v = ov ?? tv;
    else v = mergeItem(bv, ov, tv);
    if (v === null) return null;
    if (v) out.push(v);
  }
  return out;
}

/**
 * Three-way merge of a canvas: its nodes and edges by id, so a node moved on one device and reworded on another
 * keeps both. Returns null when either side is not a canvas or a text cannot be merged.
 */
export function mergeCanvas(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  const o = parseCanvas(ours);
  const t = parseCanvas(theirs);
  if (!o || !t) return null;
  const b = parseCanvas(base) ?? { nodes: [], edges: [], other: {} };
  const nodes = mergeById(b.nodes, o.nodes, t.nodes);
  const edges = mergeById(b.edges, o.edges, t.edges);
  if (!nodes || !edges) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const merged: Canvas = {
    nodes,
    // An edge whose node one device deleted would point at nothing.
    edges: edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)),
    other: mergeValue(b.other, o.other, t.other) as Item,
  };
  const same = (c: Canvas) => equal(merged.nodes, c.nodes) && equal(merged.edges, c.edges) && equal(merged.other, c.other);
  if (same(t)) return theirs;
  if (same(o)) return ours;
  // Obsidian's layout: tabs, and one node or edge to a line.
  const list = (key: string, xs: Item[]) => (xs.length ? `\t"${key}":[\n${xs.map((x) => `\t\t${JSON.stringify(x)}`).join(',\n')}\n\t]` : `\t"${key}":[]`);
  const rest = Object.entries(merged.other).map(([k, v]) => `\t${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `{\n${[list('nodes', nodes), list('edges', merged.edges), ...rest].join(',\n')}\n}`;
}
