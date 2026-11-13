import { pool } from './bytes.ts';
import type { SyncConfig } from './config.ts';
import { Packer, packRanges } from './packer.ts';
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
/**
 * Packs of one size class the current files keep data in that make a new device's first download worth cleaning up
 * for: each is about one more request, so this many are about 0.6 s of round trips on a phone at six requests in parallel.
 */
const FRAGMENTED = 32;
/**
 * Size classes by where a pack's current data ends: before this, and before a quarter of the target size. A cleanup
 * that fragmentation asks for combines only the classes that are crowded, so what an earlier cleanup combined is not
 * copied again for being small: copying a pack is worth a request it saves only while it is a small part of what one
 * is worth, and every copy stays in storage until no kept moment reads the pack it came from.
 */
const FRESH = REQUEST_BYTES / 4;

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
 * Null when nothing is worth doing, as when the only candidate is one small pack. When the current files are
 * fragmented (see `fragmented`), small packs are combined only in the size classes that are crowded; big packs
 * mostly holding dead data are emptied as ever.
 */
export function planCompaction(packs: { id: string; size: number; modified: number }[], current: Map<string, Entry>, cfg: SyncConfig, now: number): Compaction | null {
  const byPack = new Map<string, Map<number, ChunkRef>>();
  for (const e of current.values()) {
    for (const c of e.chunks) {
      let m = byPack.get(c.pack);
      if (!m) byPack.set(c.pack, (m = new Map<number, ChunkRef>()));
      m.set(c.off, c);
    }
  }
  const candidates: { id: string; size: number; refs: ChunkRef[]; live: number; wasteful: boolean; value: number }[] = [];
  const crowded = crowdedClasses(current, cfg);
  for (const p of packs) {
    const refs = byPack.get(p.id);
    if (!refs || p.modified > now - MIN_AGE) continue;
    let live = 0;
    let end = 0;
    let keep = false;
    for (const r of refs.values()) {
      live += r.len;
      end = Math.max(end, r.off + r.len);
      if (r.len >= cfg.packMaxBlobBytes || r.off + r.len > p.size) keep = true;
    }
    const cls = sizeClass(end, cfg);
    if (crowded.size && cls < 2 && !crowded.has(cls)) continue;
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

/** 0 for a pack whose current data ends before `FRESH`, 1 for one that ends before a quarter of the target size, 2 for the rest. */
function sizeClass(end: number, cfg: SyncConfig): number {
  const small = cfg.packTargetBytes * SMALL;
  return end < Math.min(FRESH, small) ? 0 : end < small ? 1 : 2;
}

/**
 * The size classes with `FRAGMENTED` or more packs the current files keep data in, none of them holding a chunk stored
 * alone. The furthest chunk of a pack is all the file table says of its size.
 */
function crowdedClasses(current: Map<string, Entry>, cfg: SyncConfig): Set<number> {
  const end = new Map<string, number>();
  const solo = new Set<string>();
  for (const e of current.values()) {
    for (const c of e.chunks) {
      end.set(c.pack, Math.max(end.get(c.pack) ?? 0, c.off + c.len));
      if (c.len >= cfg.packMaxBlobBytes) solo.add(c.pack);
    }
  }
  const count = [0, 0, 0];
  for (const [pack, last] of end) if (!solo.has(pack)) count[sizeClass(last, cfg)]++;
  return new Set([0, 1].filter((c) => count[c] >= FRAGMENTED));
}

/**
 * True when so many small packs hold the current files' data that cleanup would save a new device many requests: a
 * size class (see `FRESH`) with `FRAGMENTED` or more of them. Never touches the network. Cleanup then combines
 * those classes only, so what it combined before is not copied again until packs of its size are crowded in turn.
 */
export function fragmented(current: Map<string, Entry>, cfg: SyncConfig): boolean {
  return crowdedClasses(current, cfg).size > 0;
}

/**
 * Copies the chosen chunks into new packs as they are stored: a chunk is sealed to its id, not its
 * place, so it needs no decrypting. Returns each copied chunk's new place by its old one; a chunk
 * whose pack could not be read whole is left out.
 */
export async function copyChunks(repo: Repo, plan: Compaction, cfg: SyncConfig): Promise<Map<string, ChunkRef>> {
  const ranges = packRanges(plan.chunks, cfg.rangeGapBytes, MAX_RANGE);
  const data: (Uint8Array | null)[] = new Array<Uint8Array | null>(ranges.length);
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
