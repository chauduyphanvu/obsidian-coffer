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

/** Line-based three-way merge. Returns null when both sides changed the same region differently. */
export function merge3(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;

  const ids = new Map<string, number>();
  const lines = (s: string) => s.split(/(?<=\n)/);
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
