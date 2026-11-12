import { pool } from './bytes.ts';
import type { SyncConfig } from './config.ts';
import { Packer } from './packer.ts';
import type { Repo } from './repo.ts';
import { DAY } from './retention.ts';
import type { ChunkRef, Entry } from './types.ts';

/** A pack smaller than this share of the target size is worth combining with others. */
const SMALL = 1 / 4;
/** A pack whose current data is at most this share of it is worth emptying. */
const LIVE = 1 / 2;
/** What one more object costs a new device, in bytes it could have downloaded instead. Ranks small packs. */
const REQUEST_BYTES = 64 << 10;
const MAX_RANGE = 8 << 20;
/** Packs this young are left alone: their notes are likely still being edited. */
const MIN_AGE = DAY;

export interface Compaction {
  /** Packs whose current data is copied out. */
  packs: { id: string; size: number }[];
  /** The chunks to copy, each once, in the order they are written. */
  chunks: ChunkRef[];
}

/** Where a chunk is stored, which identifies it more narrowly than its id. */
export const placeKey = (c: ChunkRef) => `${c.pack}:${c.off}`;

/**
 * Picks packs whose current data is worth copying into new, full packs: small ones, and ones mostly
 * holding data no current file uses. Most valuable first (bytes that will be freed, plus a request
 * saved per object, per byte copied), up to `compactMaxBytes`. Leaves alone packs near full size and
 * mostly current, packs younger than a day, and packs holding a chunk large enough to be stored alone.
 * Null when nothing is worth doing, as when the only candidate is one small pack.
 */
export function planCompaction(packs: { id: string; size: number; modified: number }[], current: Map<string, Entry>, cfg: SyncConfig, now: number): Compaction | null {
  const byPack = new Map<string, Map<number, ChunkRef>>();
  for (const e of current.values()) {
    for (const c of e.chunks) {
      let m = byPack.get(c.pack);
      if (!m) byPack.set(c.pack, (m = new Map()));
      m.set(c.off, c);
    }
  }
  const candidates: { id: string; size: number; refs: ChunkRef[]; live: number; wasteful: boolean; value: number }[] = [];
  for (const p of packs) {
    const refs = byPack.get(p.id);
    if (!refs || p.modified > now - MIN_AGE) continue;
    let live = 0;
    let keep = false;
    for (const r of refs.values()) {
      live += r.len;
      if (r.len >= cfg.packMaxBlobBytes || r.off + r.len > p.size) keep = true;
    }
    const wasteful = live <= p.size * LIVE;
    if (keep || (!wasteful && p.size >= cfg.packTargetBytes * SMALL)) continue;
    candidates.push({ id: p.id, size: p.size, refs: [...refs.values()].sort((a, b) => a.off - b.off), live, wasteful, value: (p.size - live + REQUEST_BYTES) / live });
  }
  candidates.sort((a, b) => b.value - a.value);
  const chosen: typeof candidates = [];
  let bytes = 0;
  for (const c of candidates) {
    if (bytes + c.live > cfg.compactMaxBytes) continue;
    chosen.push(c);
    bytes += c.live;
  }
  if (!chosen.length || (chosen.length === 1 && !chosen[0].wasteful)) return null;
  return { packs: chosen.map(({ id, size }) => ({ id, size })), chunks: chosen.flatMap((c) => c.refs) };
}

/**
 * Copies the chosen chunks into new packs as they are stored: a chunk is sealed to its id, not its
 * place, so it needs no decrypting. Returns each copied chunk's new place by its old one; a chunk
 * whose pack could not be read whole is left out.
 */
export async function copyChunks(repo: Repo, plan: Compaction, cfg: SyncConfig): Promise<Map<string, ChunkRef>> {
  const ranges: { pack: string; start: number; end: number; refs: ChunkRef[] }[] = [];
  let cur: (typeof ranges)[number] | undefined;
  for (const ref of plan.chunks) {
    if (cur && cur.pack === ref.pack && ref.off - cur.end <= cfg.rangeGapBytes && ref.off + ref.len - cur.start <= MAX_RANGE) {
      cur.end = ref.off + ref.len;
      cur.refs.push(ref);
    } else ranges.push((cur = { pack: ref.pack, start: ref.off, end: ref.off + ref.len, refs: [ref] }));
  }
  const data: (Uint8Array | null)[] = new Array(ranges.length);
  await pool(ranges, cfg.concurrency, async (r, i) => {
    const got = await repo.getPackRange(r.pack, r.start, r.end);
    data[i] = got && got.length === r.end - r.start ? got : null;
  });
  const failed = new Set(ranges.filter((_, i) => !data[i]).map((r) => r.pack));
  const packer = new Packer(repo, cfg.packTargetBytes, cfg.packMaxBlobBytes, cfg.concurrency);
  const moved = new Map<string, ChunkRef>();
  for (const [i, r] of ranges.entries()) {
    if (failed.has(r.pack)) continue;
    for (const ref of r.refs) {
      const at = ref.off - r.start;
      moved.set(placeKey(ref), packer.add(ref.id, data[i]!.subarray(at, at + ref.len), ref.size));
    }
  }
  await packer.flush();
  return moved;
}
