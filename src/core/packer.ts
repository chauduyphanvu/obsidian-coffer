import { concat } from './bytes.ts';
import type { Repo } from './repo.ts';
import type { ChunkRef } from './types.ts';

/** A stretch of one pack to fetch with one request, and the chunks stored in it. */
export interface PackRange {
  pack: string;
  start: number;
  end: number;
  refs: ChunkRef[];
}

/**
 * Coalesces chunk references into ranges of their packs: references at most `gap` bytes apart share a
 * range while it spans at most `max` bytes, which bounds the memory a range takes; one larger chunk
 * gets a range of its own. Packs come in the order of their first reference, ranges within a pack by offset.
 */
export function packRanges(refs: ChunkRef[], gap: number, max: number): PackRange[] {
  const byPack = new Map<string, ChunkRef[]>();
  for (const ref of refs) {
    let list = byPack.get(ref.pack);
    if (!list) byPack.set(ref.pack, (list = []));
    list.push(ref);
  }
  const out: PackRange[] = [];
  for (const [pack, list] of byPack) {
    list.sort((a, b) => a.off - b.off);
    let cur: PackRange | undefined;
    for (const ref of list) {
      const end = ref.off + ref.len;
      if (cur && ref.off - cur.end <= gap && end - cur.start <= max) {
        // A reference inside the one before, as in a damaged table, must not cut the range short.
        cur.end = Math.max(cur.end, end);
        cur.refs.push(ref);
      } else out.push((cur = { pack, start: ref.off, end, refs: [ref] }));
    }
  }
  return out;
}

export class Packer {
  private repo: Repo;
  private target: number;
  private solo: number;
  private limit: number;
  private parts: Uint8Array[] = [];
  private size = 0;
  private id: string;
  private inflight = new Set<Promise<void>>();
  private failure: Error | undefined;

  constructor(repo: Repo, target: number, solo: number, limit: number) {
    this.repo = repo;
    this.target = target;
    this.solo = solo;
    this.limit = limit;
    this.id = repo.newPackId();
  }

  /** Synchronous so that two files racing on the same chunk cannot both add it. */
  add(id: string, sealed: Uint8Array, size: number): ChunkRef {
    // Large chunks get an object of their own, so deleting a big file frees its space
    // without waiting for every small note that shared a pack with it to die too.
    if (sealed.length >= this.solo) {
      const pack = this.repo.newPackId();
      this.upload(pack, sealed);
      return { id, pack, off: 0, len: sealed.length, size };
    }
    const ref = { id, pack: this.id, off: this.size, len: sealed.length, size };
    this.parts.push(sealed);
    this.size += sealed.length;
    if (this.size >= this.target) this.rotate();
    return ref;
  }

  private rotate(): void {
    this.upload(this.id, concat(this.parts));
    this.parts = [];
    this.size = 0;
    this.id = this.repo.newPackId();
  }

  private upload(id: string, data: Uint8Array): void {
    const p: Promise<void> = this.repo
      .putPack(id, data)
      .catch((e) => {
        this.failure ??= e instanceof Error ? e : new Error(String(e));
      })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  async backpressure(): Promise<void> {
    while (this.inflight.size >= this.limit) await Promise.race(this.inflight);
  }

  async flush(): Promise<void> {
    if (this.size) this.rotate();
    await Promise.all(this.inflight);
    if (this.failure) throw this.failure;
  }
}
