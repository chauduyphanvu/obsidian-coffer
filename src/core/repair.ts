import { pool } from './bytes.ts';
import { placeKey } from './compact.ts';
import { worthCompressing } from './compress.ts';
import type { SyncConfig } from './config.ts';
import { Packer } from './packer.ts';
import type { Repo } from './repo.ts';
import type { LocalState } from './state.ts';
import type { ChunkRef, Entry, LocalFS } from './types.ts';
import { affectedBy, damagedChunks, lostInHistory, type VerifyOptions } from './verify.ts';

export interface RepairOptions {
  /** Also download every chunk the current files use, to find those that are damaged rather than missing. */
  deep?: boolean;
  onProgress?: VerifyOptions['onProgress'];
}

export interface RepairReport {
  /** Files whose current version was damaged in storage and is whole again. */
  repaired: string[];
  /** Files whose current version is still damaged: nothing on this device could store it again. */
  unrepaired: string[];
  /** Files whose current version is fine but an earlier version that history offers can no longer be restored. */
  historyOnly: string[];
  /** Chunks stored again from this device's files. */
  chunks: number;
}

type Listing = { id: string; size: number }[];

/** One listing of the packs, and the chunks the current files keep in places that cannot be read. */
export async function findDamage(
  repo: Repo, files: Map<string, Entry>, cfg: SyncConfig, o: RepairOptions,
): Promise<{ listing: Listing; damaged: Map<string, ChunkRef> }> {
  const listing = await repo.listPacks();
  const damaged = await damagedChunks(repo, files, listing, { concurrency: cfg.concurrency, rangeGapBytes: cfg.rangeGapBytes, ...o });
  return { listing, damaged };
}

/**
 * Stores the damaged chunks again and returns where each now is, by the place it was. A chunk some current file
 * also keeps where it can be read is pointed there. The rest are cut from `files`, [key, name on disk] pairs of
 * this device: a chunk's id is a hash of its content, so any part of any of them with that id is the chunk, even
 * in a file edited since. A file that cannot be read here, or is over the size limit, gives nothing.
 */
export async function storeAgain(
  repo: Repo, fs: LocalFS, table: Map<string, Entry>, files: [string, string][], damaged: Map<string, ChunkRef>, cfg: SyncConfig,
): Promise<{ moved: Map<string, ChunkRef>; chunks: number }> {
  const whole = new Map<string, ChunkRef>();
  for (const e of table.values()) for (const c of e.chunks) if (!damaged.has(placeKey(c))) whole.set(c.id, c);
  const moved = new Map<string, ChunkRef>();
  const wanted = new Set<string>();
  for (const [place, ref] of damaged) {
    const to = whole.get(ref.id);
    if (to) moved.set(place, to);
    else wanted.add(ref.id);
  }
  if (!wanted.size) return { moved, chunks: 0 };

  const maxSize = cfg.maxFileSizeMB * (1 << 20) || Infinity;
  const packer = new Packer(repo, cfg.packTargetBytes, cfg.packMaxBlobBytes, cfg.concurrency);
  const stored = new Map<string, ChunkRef>();
  await pool(files, cfg.concurrency, async ([key, path]) => {
    let data: Uint8Array;
    try {
      const stat = await fs.stat(path);
      if (!stat || stat.size > maxSize) return;
      data = await fs.read(path);
    } catch {
      return;
    }
    const { parts, ids } = await repo.split(data);
    const compress = cfg.compression && worthCompressing(key, data.length);
    for (let i = 0; i < parts.length; i++) {
      if (!wanted.has(ids[i]) || stored.has(ids[i])) continue;
      const sealed = await repo.sealChunk(ids[i], parts[i], compress);
      if (stored.has(ids[i])) continue;
      stored.set(ids[i], packer.add(ids[i], sealed, parts[i].length));
      await packer.backpressure();
    }
  });
  await packer.flush();
  for (const [place, ref] of damaged) {
    const to = stored.get(ref.id);
    if (to) moved.set(place, to);
  }
  return { moved, chunks: stored.size };
}

/**
 * What a repair came to, from the table after it: a file is repaired when it was damaged and no longer touches a
 * damaged place, whether its chunks moved or an edit since replaced them.
 */
export async function repairReport(
  repo: Repo, st: LocalState, cfg: SyncConfig, now: number,
  found: { listing: Listing; damaged: Map<string, ChunkRef> }, affected: string[], chunks: number,
): Promise<RepairReport> {
  const unrepaired = new Set(affectedBy(st.remote, found.damaged));
  const repaired = affected.filter((path) => st.remote.has(path) && !unrepaired.has(path)).sort();
  // A log that cannot be read is damage a check reports; it must not hide what this repair did.
  const lost = await lostInHistory(repo, st, cfg, now, found.listing, found.damaged, unrepaired).catch(() => new Map<string, { paths: Set<string> }>());
  const historyOnly = [...new Set([...lost.values()].flatMap((n) => [...n.paths]))].sort();
  return { repaired, unrepaired: [...unrepaired].sort(), historyOnly, chunks };
}
