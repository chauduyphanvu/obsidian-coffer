import type { ChunkParams } from './types.ts';

// Fixed table: every device must cut the same content at the same places.
const GEAR = (() => {
  const t = new Uint32Array(256);
  let s = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    t[i] = (x ^ (x >>> 14)) >>> 0;
  }
  return t;
})();

/**
 * Content-defined chunking (FastCDC-style): returns the end offset of each chunk.
 * An insertion in a large file shifts only the chunks around it, so the rest are not re-uploaded.
 */
export function cutPoints(data: Uint8Array, p: ChunkParams): number[] {
  const n = data.length;
  const cuts: number[] = [];
  const bits = Math.round(Math.log2(p.avg));
  // The top bits of the rolling hash depend on the last 32 bytes. Harder test before `avg`, easier after.
  const hard = 32 - (bits + 1);
  const easy = 32 - (bits - 1);
  let start = 0;
  while (n - start > p.min) {
    const normal = Math.min(start + p.avg, n);
    const end = Math.min(start + p.max, n);
    let cut = end;
    let h = 0;
    let i = start + p.min;
    for (; i < normal; i++) {
      h = ((h << 1) + GEAR[data[i]]) | 0;
      if (h >>> hard === 0) break;
    }
    if (i === normal) {
      for (; i < end; i++) {
        h = ((h << 1) + GEAR[data[i]]) | 0;
        if (h >>> easy === 0) break;
      }
    }
    if (i < end) cut = i + 1;
    cuts.push(cut);
    start = cut;
  }
  if (start < n) cuts.push(n);
  return cuts;
}
