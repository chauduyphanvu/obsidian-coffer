import { concat } from './bytes.ts';
import type { Repo } from './repo.ts';
import type { ChunkRef } from './types.ts';

export class Packer {
  private repo: Repo;
  private target: number;
  private solo: number;
  private limit: number;
  private parts: Uint8Array[] = [];
  private size = 0;
  private id: string;
  private inflight = new Set<Promise<void>>();
  private failure: unknown;

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
        this.failure ??= e;
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
