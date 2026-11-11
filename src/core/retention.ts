import { pool } from './bytes.ts';
import type { SyncConfig } from './config.ts';
import type { Repo } from './repo.ts';
import type { LocalState } from './state.ts';
import type { Commit, Entry, Version } from './types.ts';

export const DAY = 86_400_000;
const GC_GRACE = DAY;

/** Every version of one file still within the retention window, newest first. */
export async function listVersions(repo: Repo, lastSeq: number, path: string, cfg: SyncConfig, now: number): Promise<Version[]> {
  const cutoff = now - cfg.retentionDays * DAY;
  const n = cfg.snapshotEvery;
  const out: Version[] = [];
  // Walk back one snapshot interval at a time: a whole interval is one request when its digest exists.
  for (let hi = lastSeq; hi > 0; ) {
    const lo = hi % n === 0 ? hi - n + 1 : hi - (hi % n) + 1;
    let commits = hi % n === 0 ? await repo.readDigest(hi, n) : null;
    if (!commits) {
      const block: (Commit | null)[] = new Array(hi - lo + 1);
      await pool(block, cfg.concurrency, async (_, i) => {
        block[i] = await repo.readCommit(lo + i);
      });
      commits = block.filter((c): c is Commit => !!c);
    }
    let expired = false;
    for (const c of commits.reverse()) {
      const ch = c.changes.find((x) => x.path === path);
      if (!ch) continue;
      out.push({ seq: c.seq, time: c.time, device: c.device, entry: ch.entry });
      // Older versions may already have been cleaned up. This one was current when the window
      // began, which cleanup keeps, so it is the last one listed.
      if (c.time < cutoff) {
        expired = true;
        break;
      }
    }
    if (expired) break;
    hi = lo - 1;
  }
  return out;
}

/**
 * Deletes packs that no version inside the retention window refers to, and snapshots older
 * than that window. Packs younger than a day are kept: a device may still be about to commit them.
 */
export async function collectGarbage(repo: Repo, st: LocalState, cfg: SyncConfig, now: number): Promise<{ packsDeleted: number; bytesFreed: number; snapshotsDeleted: number }> {
  const cutoff = now - cfg.retentionDays * DAY;
  const snaps = await repo.snapshots();
  const floor = snaps.filter((s) => s.modified <= cutoff).pop();
  const live = new Set<string>();
  const mark = (e: Entry | null) => e?.chunks.forEach((c) => live.add(c.pack));
  for (const e of st.remote.values()) mark(e);
  if (floor) {
    const files = await repo.readSnapshot(floor.seq);
    if (!files) throw new Error(`Snapshot ${floor.seq} cannot be read`);
    for (const e of files.values()) mark(e);
  }
  const seqs = Array.from({ length: st.lastSeq - (floor?.seq ?? 0) }, (_, i) => (floor?.seq ?? 0) + 1 + i);
  await pool(seqs, cfg.concurrency, async (seq) => {
    const c = await repo.readCommit(seq);
    if (!c) throw new Error(`Commit ${seq} cannot be read`);
    for (const ch of c.changes) mark(ch.entry);
  });

  const result = { packsDeleted: 0, bytesFreed: 0, snapshotsDeleted: 0 };
  const dead = (await repo.listPacks()).filter((o) => !live.has(o.id) && o.modified < now - GC_GRACE);
  await pool(dead, cfg.concurrency, async (o) => {
    await repo.deletePack(o.id);
    result.packsDeleted++;
    result.bytesFreed += o.size;
  });
  if (floor) {
    for (const s of snaps) {
      if (s.seq >= floor.seq) break;
      await repo.deleteSnapshot(s.seq);
      result.snapshotsDeleted++;
    }
  }
  return result;
}
