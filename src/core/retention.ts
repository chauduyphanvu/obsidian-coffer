import { pool } from './bytes.ts';
import type { SyncConfig } from './config.ts';
import type { Repo } from './repo.ts';
import type { LocalState } from './state.ts';
import type { Commit, Entry, Version } from './types.ts';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
const WEEK = 7 * DAY;
const GC_GRACE = DAY;
/**
 * Cleanup decides what to keep as if it were this much earlier. What is kept only shrinks as time
 * passes, so a device whose clock is up to this far behind the one that cleaned up still finds every
 * moment and version it offers whole. One further behind may offer some that are no longer stored.
 */
const GC_SKEW = DAY;

export type Snapshot = { seq: number; modified: number };

/** The newest snapshot stored before the retention window began, by the storage's clock, which every device reads alike. */
export function floorSnapshot<T extends Snapshot>(snaps: T[], cfg: SyncConfig, now: number): T | undefined {
  const cutoff = now - cfg.retentionDays * DAY;
  return snaps.filter((s) => s.modified <= cutoff).pop();
}

/**
 * The snapshots, and the floor history is offered from: this device's own, or the furthest any cleanup has
 * used (`Repo.prunedTo`) when that is later. Retention is a setting of each device, so cleanup on one that keeps
 * fewer days removes what another would still offer by its own floor. 0 for no floor. One list and one small
 * read, in parallel.
 */
export async function historyFloor(repo: Repo, cfg: SyncConfig, now: number, lastSeq: number): Promise<{ snaps: Snapshot[]; floor: number }> {
  const [snaps, pruned] = await Promise.all([repo.snapshots(), repo.prunedTo()]);
  return { snaps, floor: Math.min(lastSeq, Math.max(floorSnapshot(snaps, cfg, now)?.seq ?? 0, pruned)) };
}

/** True when the next user commit, made at `next` (none: undefined), falls on another UTC day than `time`. */
export function endsDay(time: number, next: number | undefined): boolean {
  return next === undefined || Math.floor(time / DAY) !== Math.floor(next / DAY);
}

/**
 * Thinning: whether the vault right after a user commit made at `time` is kept, given the time of the
 * next user commit (`next`, undefined for the newest). Commits that only move data do not count either
 * way. Every state younger than a day is kept, then the last one of each hour back to a week, then the
 * last one of each day. Buckets are UTC hours and days, so every device draws them alike.
 *
 * Commit times are device clocks, and the rule needs no agreement between them to be safe: a state only
 * goes from kept to thinned (as `now` moves on, or when a next commit arrives), never back, so nothing
 * cleanup let go is offered again. Skew only shapes which states are kept: a commit from a clock that runs
 * fast or slow sits in the bucket its own time names, closes the run of commits before it, and ages by
 * its own time, so a clock running a day fast keeps its commits a day longer.
 */
export function keptState(time: number, next: number | undefined, now: number): boolean {
  if (next === undefined || now - time < DAY || endsDay(time, next)) return true;
  return now - time < WEEK && Math.floor(time / HOUR) !== Math.floor(next / HOUR);
}

/**
 * Fed the log newest first, says which commits are kept moments: kept states from the earliest one on.
 * The earliest is the last state at or before the floor snapshot that ends its day. That one stays kept,
 * and the floor only moves forward (`historyFloor`), so the earliest moment only moves forward too and is
 * always whole: it was a kept moment at every earlier cleanup. With no floor, or no day ending at or before it, every
 * kept state back to the first commit is a moment. The one skew this does not survive is a clock behind
 * by about the whole retention window: its commit, dated into the earliest moment's day while that is
 * still the newest, makes that day end later, and the earliest moment falls back to one cleanup may
 * already have emptied. Current files are never affected.
 */
export class Thinning {
  /** The earliest moment has been seen: nothing older is one. */
  done = false;
  private floor: number;
  private now: number;
  private next: number | undefined;

  /** `next`: the time of the first user commit after where the walk starts, if it starts before the newest. */
  constructor(floor: number, now: number, next?: number) {
    this.floor = floor;
    this.now = now;
    this.next = next;
  }

  see(c: Commit): boolean {
    if (c.moved) return false;
    const next = this.next;
    this.next = c.time;
    if (this.done) return false;
    if (c.seq <= this.floor && endsDay(c.time, next)) this.done = true;
    return this.done || keptState(c.time, next, this.now);
  }
}

/** The log as one operation reads it: each commit, digest and snapshot is fetched at most once. */
export class Reads {
  readonly repo: Repo;
  readonly cfg: SyncConfig;
  private commits = new Map<number, Promise<Commit | null>>();
  private digests = new Map<number, Promise<Commit[] | null>>();
  private snaps = new Map<number, Promise<Map<string, Entry> | null>>();
  /** Commits read from the log itself. */
  private read = new Map<number, Commit>();
  /** Intervals, by their last commit, whose digest is missing or lost the commits' flags. See `mend`. */
  private stale = new Set<number>();

  constructor(repo: Repo, cfg: SyncConfig) {
    this.repo = repo;
    this.cfg = cfg;
  }

  commit(seq: number): Promise<Commit | null> {
    let p = this.commits.get(seq);
    if (!p) {
      p = this.repo.readCommit(seq).then((c) => {
        if (c) this.read.set(seq, c);
        return c;
      });
      this.commits.set(seq, p);
    }
    return p;
  }

  /** The snapshot interval ending at `hi` in one request, when its digest exists. */
  digest(hi: number): Promise<Commit[] | null> {
    let p = this.digests.get(hi);
    if (!p) {
      p = this.repo.loadDigest(hi, this.cfg.snapshotEvery).then(({ commits, stale }) => {
        if (stale) this.stale.add(hi);
        for (const c of commits ?? []) if (!this.commits.has(c.seq)) this.commits.set(c.seq, Promise.resolve(c));
        return commits;
      });
      this.digests.set(hi, p);
    }
    return p;
  }

  /**
   * Writes the digest of each stale interval this operation now holds every commit of, in the current form,
   * so the next reader needs one request for it rather than one per commit. Best effort: the commits are
   * already read. Two readers writing it at once write the same; a version from before the flags may write it
   * its own way again, and the next reader here writes it again.
   */
  private async mend(): Promise<void> {
    const n = this.cfg.snapshotEvery;
    for (const hi of this.stale) {
      const all: Commit[] = [];
      for (let s = hi - n + 1; s <= hi && this.read.has(s); s++) all.push(this.read.get(s)!);
      if (all.length < n) continue;
      this.stale.delete(hi);
      await this.repo.writeDigest(hi, all).catch(() => undefined);
    }
  }

  /** One commit; through its interval's digest when it ends one, which a walk is likely to want next. */
  async get(seq: number): Promise<Commit> {
    if (!this.commits.has(seq) && seq % this.cfg.snapshotEvery === 0) await this.digest(seq);
    const c = await this.commit(seq);
    if (!c) throw new Error(`Commit ${seq} cannot be read`);
    return c;
  }

  snapshot(seq: number): Promise<Map<string, Entry> | null> {
    let p = this.snaps.get(seq);
    if (!p) this.snaps.set(seq, (p = this.repo.readSnapshot(seq)));
    return p;
  }

  /** Commits `lo` to `hi`, in order. */
  async range(lo: number, hi: number): Promise<Commit[]> {
    const out: Commit[] = new Array<Commit>(hi - lo + 1);
    await pool(out, this.cfg.concurrency, async (_, i) => {
      out[i] = await this.get(lo + i);
    });
    if (this.stale.size) await this.mend();
    return out;
  }
}

/** Commits `lo` to `hi`, in order, all at once: a request per snapshot interval where its digest exists. */
async function readAll(reads: Reads, lo: number, hi: number): Promise<Commit[]> {
  const n = reads.cfg.snapshotEvery;
  const parts: Promise<Commit[]>[] = [];
  for (let b = lo - 1; b < hi; ) {
    const a = b + 1;
    b = Math.min(hi, b - (b % n) + n);
    const end = b;
    parts.push((end - a + 1 === n ? reads.digest(end) : Promise.resolve(null)).then((all) => all ?? reads.range(a, end)));
  }
  return (await Promise.all(parts)).flat();
}

/**
 * Reads the log newest first: a whole snapshot interval in one request where its digest exists,
 * otherwise a few commits at a time, so a caller that stops early has not read the whole interval.
 */
export class Backward {
  private reads: Reads;
  private snaps: Set<number>;
  /** Fetched and not yet returned, oldest first. */
  private buf: Commit[] = [];
  /** The newest commit not yet fetched. */
  private hi: number;

  constructor(reads: Reads, snaps: Snapshot[], from: number) {
    this.reads = reads;
    this.snaps = new Set(snaps.map((s) => s.seq));
    this.hi = from;
  }

  /** The commit `next` returns; 0 once the log is exhausted. */
  get seq(): number {
    return this.buf.length ? this.buf[this.buf.length - 1].seq : this.hi;
  }

  async peek(): Promise<Commit | undefined> {
    if (!this.buf.length && this.hi > 0) await this.fill();
    return this.buf[this.buf.length - 1];
  }

  async next(): Promise<Commit | undefined> {
    const c = await this.peek();
    this.buf.pop();
    return c;
  }

  private async fill(): Promise<void> {
    const n = this.reads.cfg.snapshotEvery;
    const hi = this.hi;
    if (hi % n === 0) {
      const all = await this.reads.digest(hi);
      if (all) {
        this.buf = [...all];
        this.hi = hi - n;
        return;
      }
    }
    // Never past the start of the interval, so the interval below can still come from its digest.
    const lo = Math.max(hi - ((hi - 1) % n), hi - this.reads.cfg.concurrency + 1);
    this.buf = await this.reads.range(lo, hi);
    this.hi = lo - 1;
  }

  /** Each of `paths` in the vault right after commit `seq` (null when absent): from older commits, or the first snapshot reached. */
  async entries(paths: Iterable<string>): Promise<Map<string, Entry | null>> {
    const open = new Set(paths);
    const out = new Map<string, Entry | null>();
    while (open.size && this.seq > 0) {
      if (this.snaps.has(this.seq)) {
        const files = await this.reads.snapshot(this.seq);
        if (files) {
          for (const p of open) out.set(p, files.get(p) ?? null);
          return out;
        }
      }
      const c = (await this.next())!;
      for (const { path, entry } of c.changes) if (open.delete(path)) out.set(path, entry);
    }
    for (const p of open) out.set(p, null);
    return out;
  }
}

/** Reads the log oldest first from `from` to `last`: whole intervals where a digest exists, otherwise a few commits at a time. */
export class Forward {
  private reads: Reads;
  private buf: Commit[] = [];
  private lo: number;
  private last: number;

  constructor(reads: Reads, from: number, last: number) {
    this.reads = reads;
    this.lo = from;
    this.last = last;
  }

  async next(): Promise<Commit | undefined> {
    if (!this.buf.length && this.lo <= this.last) await this.fill();
    return this.buf.shift();
  }

  private async fill(): Promise<void> {
    const n = this.reads.cfg.snapshotEvery;
    const lo = this.lo;
    const end = lo - 1 - ((lo - 1) % n) + n;
    if (lo === end - n + 1 && end <= this.last) {
      const all = await this.reads.digest(end);
      if (all) {
        this.buf = [...all];
        this.lo = end + 1;
        return;
      }
    }
    const hi = Math.min(this.last, end, lo + this.reads.cfg.concurrency - 1);
    this.buf = await this.reads.range(lo, hi);
    this.lo = hi + 1;
  }
}

/** Every kept version of one file, newest first: those current at a kept moment, and the current one. */
export async function listVersions(repo: Repo, lastSeq: number, path: string, cfg: SyncConfig, now: number): Promise<Version[]> {
  const { snaps, floor } = await historyFloor(repo, cfg, now, lastSeq);
  const walk = new Backward(new Reads(repo, cfg), snaps, lastSeq);
  const thin = new Thinning(floor, now);
  const out: Version[] = [];
  // The version at the walk's position: whether a kept moment holds it, and where that moment finds
  // its data (undefined until the next change going back says so).
  let kept = true;
  let entry: Entry | null | undefined;
  // Where moves made since the last user commit seen put it. A moment is the vault just before the next
  // user commit, so those moves belong to the moment of the user commit before them.
  let moved: Entry | undefined;
  for (let c: Commit | undefined; (c = await walk.next()); ) {
    const ch = c.changes.find((x) => x.path === path);
    if (c.moved) {
      if (ch?.entry) {
        if (kept && entry === undefined) entry = ch.entry;
        moved ??= ch.entry;
      }
      continue;
    }
    if (thin.see(c) && !kept) {
      kept = true;
      entry = moved;
    }
    moved = undefined;
    if (ch) {
      if (kept) out.push({ seq: c.seq, time: c.time, device: c.device, entry: entry === undefined ? ch.entry : entry });
      kept = false;
      entry = undefined;
    }
    if (thin.done && !kept) break;
  }
  return out;
}

export interface CleanupResult {
  packsDeleted: number;
  bytesFreed: number;
  snapshotsDeleted: number;
}

/**
 * Deletes packs that no kept version uses, and snapshots no longer needed to rebuild the earliest
 * moment. A version is kept when it was current at a kept moment (`Thinning`), or is current now. Packs
 * younger than a day are kept: a device may still be about to commit them. Returns what is left.
 *
 * The floor it uses is recorded (`Repo.prunedTo`) before anything is deleted, and every device offers
 * history from no earlier than the record, whatever retention it keeps itself. A device that read the record
 * before a cleanup moved it may still offer, for as long as it holds on to what it read, what that cleanup
 * then removes, when the cleanup's device keeps fewer days than it does (one that keeps as many or more
 * removes nothing such a device offers for a day after: see GC_SKEW). Storage cannot write only if unchanged,
 * so two cleanups at once could put the record back: each reads it again just before writing it and once more
 * after deleting, and writes it again if it is behind its own floor.
 */
export async function collectGarbage(
  repo: Repo,
  st: LocalState,
  cfg: SyncConfig,
  now: number,
): Promise<{ result: CleanupResult; packs: { id: string; size: number; modified: number }[] }> {
  const at = now - GC_SKEW;
  const reads = new Reads(repo, cfg);
  const [snaps, pruned] = await Promise.all([repo.snapshots(), repo.prunedTo()]);
  const floor = Math.min(st.lastSeq, Math.max(floorSnapshot(snaps, cfg, at)?.seq ?? 0, pruned));
  const after = await readAll(reads, floor + 1, st.lastSeq);

  // Back from the floor to the earliest moment, then on to the snapshot the replay starts from.
  const older: Commit[] = [];
  let earliest: Commit | undefined;
  let base = 0;
  if (floor) {
    const thin = new Thinning(floor, at, after.find((c) => !c.moved)?.time);
    const walk = new Backward(reads, snaps, floor);
    for (let c: Commit | undefined; !thin.done && (c = await walk.next()); ) {
      older.push(c);
      thin.see(c);
      if (thin.done) earliest = c;
    }
    if (earliest) {
      base = snaps.filter((s) => s.seq <= earliest!.seq).pop()?.seq ?? 0;
      for (let c: Commit | undefined; walk.seq > base && (c = await walk.next()); ) older.push(c);
    }
  }
  const commits = older.reverse().filter((c) => c.seq > base).concat(after);
  const files = base ? await reads.snapshot(base) : new Map<string, Entry>();
  if (!files) throw new Error(`Snapshot ${base} cannot be read`);

  // Replay, marking each entry that was current at the end of a kept moment: just before the next user
  // commit, so moves made in between are part of it. An entry is current from `since` until replaced.
  const live = new Set<string>();
  const mark = (e: Entry) => e.chunks.forEach((c) => live.add(c.pack));
  const table = new Map<string, { entry: Entry; since: number }>();
  for (const [path, entry] of files) table.set(path, { entry, since: base });
  const from = earliest?.seq ?? 0;
  let prev = earliest && earliest.seq === base ? earliest : undefined;
  let keptEnd = -1;
  for (const c of commits) {
    if (!c.moved) {
      if (prev && prev.seq >= from && keptState(prev.time, c.time, at)) keptEnd = c.seq - 1;
      prev = c;
    }
    for (const { path, entry } of c.changes) {
      const old = table.get(path);
      if (old && old.since <= keptEnd) mark(old.entry);
      if (entry) table.set(path, { entry, since: c.seq });
      else table.delete(path);
    }
  }
  for (const { entry } of table.values()) mark(entry);
  for (const e of st.remote.values()) mark(e);

  const result: CleanupResult = { packsDeleted: 0, bytesFreed: 0, snapshotsDeleted: 0 };
  const advance = async () => {
    if (floor > pruned && (await repo.prunedTo()) < floor) await repo.setPrunedTo(floor);
  };
  await advance();
  const listing = await repo.listPacks();
  const dead = listing.filter((o) => !live.has(o.id) && o.modified < now - GC_GRACE);
  await pool(dead, cfg.concurrency, async (o) => {
    await repo.deletePack(o.id);
    result.packsDeleted++;
    result.bytesFreed += o.size;
  });
  for (const s of snaps) {
    if (s.seq >= base) break;
    await repo.deleteSnapshot(s.seq);
    result.snapshotsDeleted++;
  }
  await advance();
  const gone = new Set(dead.map((o) => o.id));
  return { result, packs: listing.filter((o) => !gone.has(o.id)) };
}
