import type { SyncConfig } from './config.ts';
import type { Member } from './members.ts';
import { vaultKey } from './paths.ts';
import type { Repo } from './repo.ts';
import { Backward, Forward, HOUR, Reads, Thinning, historyFloor, keptState, type Snapshot } from './retention.ts';
import { sameContent, type Commit, type Entry } from './types.ts';

/** A commit seen as a point in time: the vault right after it. */
export interface Moment {
  seq: number;
  time: number;
  device: string;
}

export interface PastVault {
  /**
   * The kept moment used: the one asked for, or for a time, the newest one stamped at or before it.
   * States between kept moments are thinned away (see `keptState`), so a time inside such a stretch gets
   * the kept moment before it. `files` is the vault at that moment.
   */
  commit: Moment;
  files: Map<string, Entry>;
  /** The earliest moment that can still be restored. Cleanup may already have removed data older than it. */
  earliest: Moment;
}

/** A file that no longer exists. `seq`, `time` and `device` are those of the commit that deleted it. */
export interface DeletedFile extends Moment {
  path: string;
  /** Its last kept version, to restore it from. */
  entry: Entry;
}

export interface CommitSummary extends Moment {
  /** Files added, changed and deleted since the kept moment before this one (for the earliest, by its own commit). */
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

/** What cleanup keeps, as of one moment: the same rule `collectGarbage` applies. */
interface Kept {
  /** Cleanup's floor snapshot, 0 for none. */
  floor: number;
  now: number;
}

/** The snapshots, and what cleanup keeps as of `now`, from this device's retention and how far cleanup has gone. */
async function kept(repo: Repo, cfg: SyncConfig, now: number, lastSeq: number): Promise<{ snaps: Snapshot[]; k: Kept }> {
  const { snaps, floor } = await historyFloor(repo, cfg, now, lastSeq);
  return { snaps, k: { floor, now } };
}

/**
 * Says, for commits seen newest first, which are kept moments. Every moment and version offered passes
 * through here. `next`: the time of the first user commit after where the walk starts, if not the newest.
 */
function restorable(k: Kept, next?: number): Thinning {
  return new Thinning(k.floor, k.now, next);
}

const moment = (c: Moment): Moment => ({ seq: c.seq, time: c.time, device: c.device });

function apply(files: Map<string, Entry>, path: string, entry: Entry | null): void {
  if (entry) files.set(path, entry);
  else files.delete(path);
}

/** Matches the paths in `folder` and its subfolders; every path when `folder` is empty. */
function inFolder(folder: string): (path: string) => boolean {
  const prefix = vaultKey(folder).replace(/\/+$/, '');
  return prefix ? (path) => path.startsWith(`${prefix}/`) : () => true;
}

/** The first user commit after `seq`, if any. */
async function userAfter(reads: Reads, seq: number, lastSeq: number): Promise<Commit | undefined> {
  const fwd = new Forward(reads, seq + 1, lastSeq);
  for (let c: Commit | undefined; (c = await fwd.next()); ) if (!c.moved) return c;
  return undefined;
}

/** The earliest kept moment: back from the floor to the last commit that ends its day, or the first kept state of the log. */
async function earliestMoment(reads: Reads, snaps: Snapshot[], k: Kept, lastSeq: number): Promise<Moment> {
  if (k.floor) {
    const thin = restorable(k, (await userAfter(reads, k.floor, lastSeq))?.time);
    const walk = new Backward(reads, snaps, k.floor);
    for (let c: Commit | undefined; (c = await walk.next()); ) {
      thin.see(c);
      if (thin.done) return moment(c);
    }
  }
  let prev: Commit | undefined;
  const fwd = new Forward(reads, 1, lastSeq);
  for (let c: Commit | undefined; (c = await fwd.next()); ) {
    if (c.moved) continue;
    if (prev && keptState(prev.time, c.time, k.now)) return moment(prev);
    prev = c;
  }
  if (!prev) throw new Error('Nothing has been synced yet');
  return moment(prev);
}

/** Refuses a sequence number that names no moment `listCommits` offers. */
async function checkMoment(reads: Reads, k: Kept, earliest: Moment, lastSeq: number, seq: number): Promise<void> {
  const no = (why: string) => new Error(`Commit ${seq} is not a kept moment: ${why}`);
  if (seq < 1 || seq > lastSeq) throw no('there is no such commit');
  if (seq < earliest.seq) throw new TooOldError(earliest);
  const c = await reads.get(seq);
  if (c.moved) throw no('it only moved stored data');
  if (seq > earliest.seq && !keptState(c.time, (await userAfter(reads, seq, lastSeq))?.time, k.now)) throw no('it has been thinned out of history');
}

interface Found {
  commit: Moment;
  files: Map<string, Entry>;
}

/** The moment to find: the newest kept one that `upTo` accepts. */
interface Want {
  upTo: (c: Commit) => boolean;
  /** True for a user commit from which on `upTo` accepts nothing, where a replay stops. */
  past: (c: Commit) => boolean;
}

/**
 * From the current table, undoing the commits made after the moment. The vault at a moment is the
 * vault just before the next user commit: moves made in between belong to it.
 */
async function backward(reads: Reads, snaps: Snapshot[], k: Kept, remote: Map<string, Entry>, lastSeq: number, want: Want): Promise<Found | undefined> {
  const walk = new Backward(reads, snaps, lastSeq);
  const thin = restorable(k);
  const later = new Set<string>();
  let moved = new Map<string, Entry | null>();
  for (let c: Commit | undefined; (c = await walk.peek()); await walk.next()) {
    if (c.moved) {
      for (const ch of c.changes) if (!moved.has(ch.path)) moved.set(ch.path, ch.entry);
      continue;
    }
    if (thin.see(c) && want.upTo(c)) {
      const files = new Map(remote);
      const open = [...later].filter((p) => !moved.has(p));
      for (const [path, entry] of moved) if (later.has(path)) apply(files, path, entry);
      for (const [path, entry] of await walk.entries(open)) apply(files, path, entry);
      return { commit: moment(c), files };
    }
    if (thin.done) return undefined;
    for (const path of moved.keys()) later.add(path);
    for (const ch of c.changes) later.add(ch.path);
    moved = new Map();
  }
  return undefined;
}

/**
 * From snapshot `base` (0: an empty vault), replaying commits up to the moment wanted. Undefined when
 * no kept moment from `from` on that it wants falls after `base`; null when the snapshot reads as missing, as one
 * found not to verify in a shared folder with members does.
 */
async function replay(reads: Reads, k: Kept, from: number, base: number, lastSeq: number, want: Want): Promise<Found | undefined | null> {
  const seen: Commit[] = [];
  let prev: Commit | undefined = base ? await reads.get(base) : undefined;
  if (prev?.moved) prev = undefined;
  let best: { c: Commit; end: number } | undefined;
  const consider = (u: Commit, next: Commit | undefined, end: number) => {
    if (u.seq >= from && want.upTo(u) && keptState(u.time, next?.time, k.now)) best = { c: u, end };
  };
  let stopped = false;
  const fwd = new Forward(reads, base + 1, lastSeq);
  for (let c: Commit | undefined; (c = await fwd.next()); ) {
    if (!c.moved) {
      if (prev) consider(prev, c, c.seq - 1);
      if (want.past(c)) {
        stopped = true;
        break;
      }
      prev = c;
    }
    seen.push(c);
  }
  if (!stopped && prev) consider(prev, undefined, lastSeq);
  if (!best) return undefined;
  const snap = base ? await reads.snapshot(base) : new Map<string, Entry>();
  if (!snap) return null;
  const files = new Map(snap);
  for (const c of seen) {
    if (c.seq > best.end) break;
    for (const { path, entry } of c.changes) apply(files, path, entry);
  }
  return { commit: moment(best.c), files };
}

/** From the newest of `bases`, or an older one when no kept moment wanted follows it. */
async function forward(reads: Reads, bases: Snapshot[], k: Kept, from: number, lastSeq: number, want: Want): Promise<Found | undefined> {
  for (let i = bases.length - 1; ; i--) {
    const base = i >= 0 ? bases[i].seq : 0;
    const found = await replay(reads, k, from, base, lastSeq, want);
    if (found === null) continue;
    if (found || base <= from) return found;
  }
}

/**
 * The vault at a kept moment: the one `at` names by its commit's sequence number, as `listCommits` lists
 * it, or for a time, the newest one stamped at or before it. Commit times come from device clocks, so a
 * moment made later may be stamped earlier, and two may share a millisecond: only the sequence number
 * names each moment. A time is resolved alike whether worked out backward from `remote` (a moment after
 * the newest snapshot) or forward from a snapshot before it, provided no clock runs more than an hour
 * behind the storage's. Throws TooOldError for a moment before `earliest`, or a time before its stamp,
 * whose files may no longer all be stored, and an Error for a sequence number that names no kept moment.
 */
export async function tableAt(
  repo: Repo,
  remote: Map<string, Entry>,
  lastSeq: number,
  cfg: SyncConfig,
  now: number,
  at: number | { seq: number },
): Promise<PastVault> {
  if (!lastSeq) throw new Error('Nothing has been synced yet');
  const { snaps: all, k } = await kept(repo, cfg, now, lastSeq);
  const snaps = all.filter((s) => s.seq <= lastSeq);
  const reads = new Reads(repo, cfg);
  const earliest = await earliestMoment(reads, snaps, k, lastSeq);
  const newest = snaps[snaps.length - 1];
  let want: Want, recent: boolean, bases: Snapshot[];
  if (typeof at === 'number') {
    if (at < earliest.time) throw new TooOldError(earliest);
    // Stored an hour after `at`, so commits from it on were stamped after `at` even by a clock that runs behind the storage's.
    const end = snaps.find((s) => s.modified >= at + HOUR)?.seq ?? Infinity;
    want = { upTo: (c) => c.time <= at, past: (c) => c.seq >= end };
    recent = !newest || at >= newest.modified;
    bases = snaps.filter((s) => s.modified <= at);
  } else {
    const { seq } = at;
    await checkMoment(reads, k, earliest, lastSeq, seq);
    want = { upTo: (c) => c.seq <= seq, past: (c) => c.seq > seq };
    recent = !newest || seq >= newest.seq;
    bases = snaps.filter((s) => s.seq <= seq);
  }
  const found = recent ? await backward(reads, snaps, k, remote, lastSeq, want) : await forward(reads, bases, k, earliest.seq, lastSeq, want);
  if (!found || found.commit.seq < earliest.seq) throw new TooOldError(earliest);
  return { commit: found.commit, files: found.files, earliest };
}

/**
 * Files deleted whose last version before the deletion is kept, and not re-created since, newest
 * deletion first. With `folder`, only the files in it and its subfolders.
 */
export async function listDeleted(repo: Repo, lastSeq: number, cfg: SyncConfig, now: number, folder = ''): Promise<DeletedFile[]> {
  const { snaps, k } = await kept(repo, cfg, now, lastSeq);
  const thin = restorable(k);
  const inside = inFolder(folder);
  const walk = new Backward(new Reads(repo, cfg), snaps, lastSeq);
  const seen = new Set<string>();
  // A deleted file waits for a kept moment between its last version and its deletion ('moment'),
  // then for the entry that moment holds ('entry').
  const found = new Map<string, Moment & { path: string; entry?: Entry; wait?: 'moment' | 'entry' }>();
  let moved = new Map<string, Entry>();
  for (let c: Commit | undefined; (c = await walk.peek()); await walk.next()) {
    if (c.moved) {
      for (const { path, entry } of c.changes) {
        if (!inside(path) || !entry) continue;
        const d = found.get(path);
        if (d?.wait === 'entry') {
          d.entry = entry;
          d.wait = undefined;
        }
        if (!moved.has(path)) moved.set(path, entry);
        seen.add(path);
      }
      continue;
    }
    if (thin.see(c)) {
      for (const d of found.values()) {
        if (d.wait !== 'moment') continue;
        d.entry = moved.get(d.path);
        d.wait = d.entry ? undefined : 'entry';
      }
    }
    moved = new Map();
    for (const { path, entry } of c.changes) {
      if (!inside(path)) continue;
      const d = found.get(path);
      if (d?.wait === 'entry') {
        if (entry) d.entry = entry;
        d.wait = undefined;
      } else if (d?.wait === 'moment') {
        found.delete(path); // its last version was never current at a kept moment
      } else if (!d && !seen.has(path)) {
        // The newest change to a path says whether it exists now.
        seen.add(path);
        if (!entry) found.set(path, { path, ...moment(c), wait: 'moment' });
      }
    }
    if (thin.done) break;
  }
  const open = [...found.values()].filter((d) => d.wait === 'entry').map((d) => d.path);
  for (const [path, entry] of await walk.entries(open)) {
    const d = found.get(path)!;
    if (entry) d.entry = entry;
  }
  const out: DeletedFile[] = [];
  for (const { wait, entry, ...d } of found.values()) if (entry && wait !== 'moment') out.push({ ...d, entry });
  return out;
}

/**
 * The kept moments, newest first, each with how many files were added, changed and deleted since the
 * kept moment before it. Stops after `limit` moments, or at the first one made before `since`. With
 * `before`, starts at the newest moment made before then, reading from a snapshot near it rather than
 * from the newest commit. With `beforeSeq`, starts at the newest moment before that commit: the `seq`
 * of a page's last moment gives exactly the page after it, which a time cannot when two moments share
 * a millisecond or a later one is stamped earlier. Moments come in the order they were made, whatever
 * their stamps say.
 */
export async function listCommits(
  repo: Repo,
  lastSeq: number,
  cfg: SyncConfig,
  now: number,
  opts: { limit?: number; since?: number; before?: number; beforeSeq?: number } = {},
): Promise<CommitSummary[]> {
  const { limit = Infinity, since = -Infinity, before = Infinity, beforeSeq = Infinity } = opts;
  const { snaps, k } = await kept(repo, cfg, now, lastSeq);
  const reads = new Reads(repo, cfg);
  let from = Math.max(0, Math.min(lastSeq, beforeSeq - 1));
  let next = from < lastSeq ? (await userAfter(reads, from, lastSeq))?.time : undefined;
  if (before !== Infinity) {
    // Stored an hour after `before`, so commits after it were made after `before` even by a clock that runs behind the storage's.
    const start = snaps.find((s) => s.seq <= from && s.modified >= before + HOUR);
    if (start) {
      from = start.seq;
      next = (await userAfter(reads, from, lastSeq))?.time;
    }
  }
  const walk = new Backward(reads, snaps, from);
  const thin = restorable(k, next);
  const out: CommitSummary[] = [];
  // Files a listed moment changed, with their entry then, until an older commit or a snapshot shows
  // what they were at the moment before it.
  const open = new Map<string, { s: CommitSummary; after: Entry | null }>();
  const settle = (path: string, was: Entry | null) => {
    const o = open.get(path);
    if (!o) return;
    open.delete(path);
    if (o.after && !was) o.s.added++;
    else if (!o.after && was) o.s.deleted++;
    else if (o.after && was && !sameContent(o.after, was)) o.s.changed++;
  };
  let cur: CommitSummary | undefined;
  for (let c: Commit | undefined; (c = await walk.peek()); await walk.next()) {
    if (thin.see(c)) {
      if (out.length >= limit || c.time < since) break;
      cur = c.time < before ? { ...moment(c), added: 0, changed: 0, deleted: 0 } : undefined;
      if (cur) out.push(cur);
    }
    for (const { path, entry } of c.changes) {
      const o = open.get(path);
      if (o && o.s !== cur) settle(path, entry);
      if (cur && !open.has(path)) open.set(path, { s: cur, after: entry });
    }
    if (thin.done) {
      await walk.next();
      break;
    }
  }
  for (const [path, entry] of await walk.entries([...open.keys()])) settle(path, entry);
  return out;
}

/** One change to the files, or to the members of a shared folder, as `listActivity` lists it. */
export interface Activity extends Moment {
  /** In a shared folder with members: the member who signed it. */
  signer?: string;
  /** The files it added, changed and deleted, by path, each list sorted. */
  added: string[];
  changed: string[];
  deleted: string[];
  /** A change to the members: the member list before it (empty for the first) and after it. It changes no file. */
  members?: { before: Member[]; after: Member[] };
}

/**
 * Every commit that changed files or members, newest first, each with the files it added, changed and deleted. Commits
 * that only moved stored data are left out; unlike `listCommits`, nothing is thinned, and every commit the log holds
 * counts. Stops after `limit` of them; `beforeSeq` starts at the newest before that commit. `next` is the `beforeSeq`
 * of the page after this one, undefined once the log's start is reached.
 */
export async function listActivity(
  repo: Repo,
  lastSeq: number,
  cfg: SyncConfig,
  opts: { limit?: number; beforeSeq?: number } = {},
): Promise<{ items: Activity[]; next?: number }> {
  const { limit = Infinity, beforeSeq = Infinity } = opts;
  const snaps = (await repo.snapshots()).filter((s) => s.seq <= lastSeq);
  const reads = new Reads(repo, cfg);
  const walk = new Backward(reads, snaps, Math.max(0, Math.min(lastSeq, beforeSeq - 1)));
  const items: Activity[] = [];
  // Files a listed commit changed, with their entry then, until an older commit or a snapshot shows what they were before it.
  const open = new Map<string, { a: Activity; after: Entry | null }>();
  const settle = (path: string, was: Entry | null) => {
    const o = open.get(path);
    if (!o) return;
    open.delete(path);
    if (!o.after) o.a.deleted.push(path);
    else if (!was) o.a.added.push(path);
    else if (!sameContent(o.after, was)) o.a.changed.push(path);
  };
  let next: number | undefined;
  for (let c: Commit | undefined; (c = await walk.peek()); await walk.next()) {
    const listed = !c.moved || !!c.members;
    if (listed && items.length >= limit) {
      next = c.seq + 1;
      break;
    }
    for (const { path, entry } of c.changes) settle(path, entry);
    if (!listed) continue;
    const a: Activity = { ...moment(c), ...(c.signer && { signer: c.signer }), added: [], changed: [], deleted: [] };
    if (c.members) {
      const prev = c.members.earlier.at(-1);
      a.members = { before: prev ? ((await reads.get(prev)).members?.members ?? []) : [], after: c.members.members };
    }
    items.push(a);
    for (const { path, entry } of c.changes) open.set(path, { a, after: entry });
  }
  for (const [path, entry] of await walk.entries([...open.keys()])) settle(path, entry);
  for (const a of items) for (const list of [a.added, a.changed, a.deleted]) list.sort();
  return { items, ...(next !== undefined && { next }) };
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
