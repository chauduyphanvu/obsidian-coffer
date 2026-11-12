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

/** Line-based three-way merge. Returns null when both sides changed the same region differently. */
export function merge3(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;

  const ids = new Map<string, number>();
  const lines = splitLines;
  const intern = (ls: string[]) => Int32Array.from(ls, (l) => ids.get(l) ?? (ids.set(l, ids.size), ids.size - 1));
  const A = lines(ours);
  const B = lines(theirs);
  const o = intern(lines(base));
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
    // A base line present on both sides is an anchor; whatever lies between two anchors is one region.
    const anchor = i < o.length && ma[i] >= 0 && mb[i] >= 0;
    if (!anchor && i < o.length) continue;
    const ea = anchor ? ma[i] : a.length;
    const eb = anchor ? mb[i] : b.length;
    if (sliceEq(a, ia, ea, o, io, i)) out.push(...B.slice(ib, eb));
    else if (sliceEq(b, ib, eb, o, io, i) || sliceEq(a, ia, ea, b, ib, eb)) out.push(...A.slice(ia, ea));
    else return null;
    if (anchor) out.push(A[ea]);
    io = i + 1;
    ia = ea + 1;
    ib = eb + 1;
  }
  return out.join('');
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
