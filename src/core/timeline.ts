import { pool } from './bytes.ts';
import type { SyncConfig } from './config.ts';
import { vaultKey } from './paths.ts';
import type { Repo } from './repo.ts';
import { DAY } from './retention.ts';
import { sameContent, type Commit, type Entry } from './types.ts';

/** A commit seen as a point in time: the vault right after it. */
export interface Moment {
  seq: number;
  time: number;
  device: string;
}

export interface PastVault {
  /** The last commit made at or before the moment asked for; `files` is the vault right after it. */
  commit: Moment;
  files: Map<string, Entry>;
  /** The earliest moment that can still be restored. Cleanup may already have removed data older than it. */
  earliest: Moment;
}

/** A file that no longer exists. `seq`, `time` and `device` are those of the commit that deleted it. */
export interface DeletedFile extends Moment {
  path: string;
  /** Its last version, to restore it from. */
  entry: Entry;
}

export interface CommitSummary extends Moment {
  added: number;
  changed: number;
  deleted: number;
}

export interface RestorePlan {
  write: { path: string; entry: Entry }[];
  remove: string[];
}

/** Refuses a moment before the earliest one that can still be restored. */
export class TooOldError extends Error {
  readonly earliest: Moment;
  constructor(earliest: Moment) {
    super(`The earliest moment that can be restored is ${new Date(earliest.time).toISOString()}`);
    this.earliest = earliest;
  }
}

type Snapshot = { seq: number; modified: number };

/** What cleanup still keeps, as of one moment. */
interface Kept {
  /** The first commit whose vault is still whole. Nothing older is offered, so no walk looks further back for it. */
  from: number;
}

/**
 * Cleanup keeps the data of the newest snapshot older than the retention window and of every commit
 * after it (`collectGarbage`). That snapshot only moves forward as time passes, so the vault at its
 * commit or any later one is whole. An older one may already be missing data.
 */
function kept(snaps: Snapshot[], cfg: SyncConfig, now: number): Kept {
  const cutoff = now - cfg.retentionDays * DAY;
  return { from: snaps.filter((s) => s.modified <= cutoff).pop()?.seq ?? 1 };
}

/** Whether the vault as it stood right after commit `seq` can still be restored. Every moment and version offered passes through here. */
function restorable(k: Kept, seq: number): boolean {
  return seq >= k.from;
}

const moment = (c: Moment): Moment => ({ seq: c.seq, time: c.time, device: c.device });

async function readMoment(repo: Repo, seq: number): Promise<Moment> {
  const c = await repo.readCommit(seq);
  if (!c) throw new Error(`Commit ${seq} cannot be read`);
  return moment(c);
}

/** Commits `lo` to `hi`, in order. */
async function readCommits(repo: Repo, concurrency: number, lo: number, hi: number): Promise<Commit[]> {
  const out: Commit[] = new Array(hi - lo + 1);
  await pool(out, concurrency, async (_, i) => {
    const c = await repo.readCommit(lo + i);
    if (!c) throw new Error(`Commit ${lo + i} cannot be read`);
    out[i] = c;
  });
  return out;
}

/** Commits `lo` to `hi`, in order: one request when they are exactly one snapshot interval and its digest exists. */
async function readRange(repo: Repo, cfg: SyncConfig, lo: number, hi: number): Promise<Commit[]> {
  const n = cfg.snapshotEvery;
  const all = hi % n === 0 && hi - lo + 1 === n ? await repo.readDigest(hi, n) : null;
  return all ?? readCommits(repo, cfg.concurrency, lo, hi);
}

function apply(files: Map<string, Entry>, path: string, entry: Entry | null): void {
  if (entry) files.set(path, entry);
  else files.delete(path);
}

/** Matches the paths in `folder` and its subfolders; every path when `folder` is empty. */
function inFolder(folder: string): (path: string) => boolean {
  const prefix = vaultKey(folder).replace(/\/+$/, '');
  return prefix ? (path) => path.startsWith(`${prefix}/`) : () => true;
}

/**
 * Reads the log newest first: a whole snapshot interval in one request where its digest exists,
 * otherwise a few commits at a time, so a caller that stops early has not read the whole interval.
 */
class Backward {
  private repo: Repo;
  private cfg: SyncConfig;
  private snaps: Set<number>;
  /** Fetched and not yet returned, oldest first. */
  private buf: Commit[] = [];
  /** The newest commit not yet fetched. */
  private hi: number;

  constructor(repo: Repo, cfg: SyncConfig, snaps: Snapshot[], from: number) {
    this.repo = repo;
    this.cfg = cfg;
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
    const n = this.cfg.snapshotEvery;
    const hi = this.hi;
    if (hi % n === 0) {
      const all = await this.repo.readDigest(hi, n);
      if (all) {
        this.buf = all;
        this.hi = hi - n;
        return;
      }
    }
    // Never past the start of the interval, so the interval below can still come from its digest.
    const lo = Math.max(hi - ((hi - 1) % n), hi - this.cfg.concurrency + 1);
    this.buf = await readCommits(this.repo, this.cfg.concurrency, lo, hi);
    this.hi = lo - 1;
  }

  /** Each of `paths` in the vault right after commit `seq` (null when absent): from older commits, or the first snapshot reached. */
  async entries(paths: Iterable<string>): Promise<Map<string, Entry | null>> {
    const open = new Set(paths);
    const out = new Map<string, Entry | null>();
    while (open.size && this.seq > 0) {
      if (this.snaps.has(this.seq)) {
        const files = await this.repo.readSnapshot(this.seq);
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

interface Found {
  commit?: Moment;
  files: Map<string, Entry>;
}

/** From the current table, undoing the commits made after `at`. */
async function backward(repo: Repo, cfg: SyncConfig, snaps: Snapshot[], remote: Map<string, Entry>, lastSeq: number, at: number): Promise<Found> {
  const walk = new Backward(repo, cfg, snaps, lastSeq);
  const later = new Set<string>();
  let c: Commit | undefined;
  while ((c = await walk.peek()) && c.time > at) {
    for (const ch of c.changes) later.add(ch.path);
    await walk.next();
  }
  const files = new Map(remote);
  if (!c) return { files };
  for (const [path, entry] of await walk.entries(later)) apply(files, path, entry);
  return { commit: moment(c), files };
}

/** From the newest kept snapshot taken by `at`, replaying the commits after it. */
async function forward(repo: Repo, cfg: SyncConfig, snaps: Snapshot[], k: Kept, lastSeq: number, at: number): Promise<Found> {
  // Judged by the commit's own time too: the store's clock and the devices' can disagree.
  let base: Moment | undefined;
  for (const s of snaps.filter((x) => x.seq >= k.from && (x.modified <= at || x.seq === k.from)).reverse()) {
    const m = await readMoment(repo, s.seq);
    if (m.time <= at) {
      base = m;
      break;
    }
  }
  // Starting from an empty vault is only sound when no commit's data has been cleaned up.
  if (!base && k.from > 1) return { files: new Map() };
  const n = cfg.snapshotEvery;
  const scan = async () => {
    const out: Commit[] = [];
    for (let lo = (base?.seq ?? 0) + 1; lo <= lastSeq; ) {
      const hi = Math.min(lastSeq, lo - 1 - ((lo - 1) % n) + n);
      for (const c of await readRange(repo, cfg, lo, hi)) {
        if (c.time > at) return out;
        out.push(c);
      }
      lo = hi + 1;
    }
    return out;
  };
  const [files, commits] = await Promise.all([base ? repo.readSnapshot(base.seq) : new Map<string, Entry>(), scan()]);
  if (!files) throw new Error(`Snapshot ${base!.seq} cannot be read`);
  for (const c of commits) for (const { path, entry } of c.changes) apply(files, path, entry);
  const last = commits[commits.length - 1];
  return { commit: last ? moment(last) : base, files };
}

/**
 * The vault as it was at `at`: every file right after the last commit made at or before it.
 * Commit times are taken to rise with their sequence numbers. A moment after the newest snapshot is
 * worked out backward from `remote`, an older one forward from the snapshot before it. Throws
 * TooOldError for a moment before `earliest`, whose files may no longer all be stored.
 */
export async function tableAt(repo: Repo, remote: Map<string, Entry>, lastSeq: number, cfg: SyncConfig, now: number, at: number): Promise<PastVault> {
  if (!lastSeq) throw new Error('Nothing has been synced yet');
  const all = await repo.snapshots();
  const k = kept(all, cfg, now);
  const snaps = all.filter((s) => s.seq <= lastSeq);
  const newest = snaps[snaps.length - 1];
  const [earliest, found] = await Promise.all([
    readMoment(repo, k.from),
    !newest || at >= newest.modified ? backward(repo, cfg, snaps, remote, lastSeq, at) : forward(repo, cfg, snaps, k, lastSeq, at),
  ]);
  if (!found.commit || !restorable(k, found.commit.seq)) throw new TooOldError(earliest);
  return { commit: found.commit, files: found.files, earliest };
}

/**
 * Files deleted while their last version can still be restored, and not re-created since, newest
 * deletion first. With `folder`, only the files in it and its subfolders.
 */
export async function listDeleted(repo: Repo, lastSeq: number, cfg: SyncConfig, now: number, folder = ''): Promise<DeletedFile[]> {
  const snaps = await repo.snapshots();
  const k = kept(snaps, cfg, now);
  const inside = inFolder(folder);
  const walk = new Backward(repo, cfg, snaps, lastSeq);
  const seen = new Set<string>();
  const found = new Map<string, Moment & { path: string; entry?: Entry }>();
  for (let c: Commit | undefined; walk.seq > k.from && (c = await walk.peek()); await walk.next()) {
    // A file's last version is restorable when the vault just before its deletion is.
    const offered = restorable(k, c.seq - 1);
    for (const { path, entry } of c.changes) {
      if (!inside(path)) continue;
      const d = found.get(path);
      if (d) {
        if (!d.entry && entry) d.entry = entry;
      } else if (!seen.has(path)) {
        // The newest change to a path says whether it exists now.
        seen.add(path);
        if (!entry && offered) found.set(path, { path, ...moment(c) });
      }
    }
  }
  const open = [...found.values()].filter((d) => !d.entry).map((d) => d.path);
  for (const [path, entry] of await walk.entries(open)) if (entry) found.get(path)!.entry = entry;
  return [...found.values()].filter((d): d is DeletedFile => !!d.entry);
}

/**
 * The commits whose vault can still be restored, newest first, each with how many files it added,
 * changed and deleted. Stops after `limit` commits, or at the first one made before `since`.
 */
export async function listCommits(repo: Repo, lastSeq: number, cfg: SyncConfig, now: number, opts: { limit?: number; since?: number } = {}): Promise<CommitSummary[]> {
  const { limit = Infinity, since = -Infinity } = opts;
  const snaps = await repo.snapshots();
  const k = kept(snaps, cfg, now);
  const walk = new Backward(repo, cfg, snaps, lastSeq);
  const out: CommitSummary[] = [];
  // Files a listed commit wrote, until an older commit or a snapshot shows whether each existed before it.
  const open = new Map<string, CommitSummary>();
  const settle = (path: string, existed: boolean) => {
    const s = open.get(path);
    if (!s) return;
    if (existed) s.changed++;
    else s.added++;
    open.delete(path);
  };
  for (let c: Commit | undefined; out.length < limit && walk.seq >= k.from && (c = await walk.peek()) && c.time >= since; await walk.next()) {
    for (const { path, entry } of c.changes) settle(path, !!entry);
    if (!restorable(k, c.seq)) continue;
    const s: CommitSummary = { ...moment(c), added: 0, changed: 0, deleted: 0 };
    for (const { path, entry } of c.changes) {
      if (entry) open.set(path, s);
      else s.deleted++;
    }
    out.push(s);
  }
  for (const [path, entry] of await walk.entries(open.keys())) settle(path, !!entry);
  return out;
}

/**
 * What makes the vault, or the files in `folder`, match `target`: versions to write and paths to
 * remove, leaving out files whose content already matches. Apply the removals first: undoing a
 * rename that only changed letter case writes and removes what some file systems treat as one file.
 */
export function planRestore(current: Map<string, Entry>, target: Map<string, Entry>, folder = ''): RestorePlan {
  const inside = inFolder(folder);
  const write: RestorePlan['write'] = [];
  for (const [path, entry] of target) {
    const now = current.get(path);
    if (inside(path) && !(now && sameContent(now, entry))) write.push({ path, entry });
  }
  const remove = [...current.keys()].filter((path) => inside(path) && !target.has(path));
  return { write, remove };
}
