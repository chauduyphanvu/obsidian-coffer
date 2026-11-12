import { pool } from './bytes.ts';
import { worthCompressing } from './compress.ts';
import { copyChunks, placeKey, planCompaction } from './compact.ts';
import { compileExcludes, type SyncConfig } from './config.ts';
import { merge3, mergeJson } from './merge.ts';
import { Packer, packRanges } from './packer.ts';
import { conflictCopyName, ext, vaultKey } from './paths.ts';
import { nothingToDo, planChanges, type Local, type Plan } from './plan.ts';
import { Repo } from './repo.ts';
import { collectGarbage, listVersions, type CleanupResult } from './retention.ts';
import { LocalState } from './state.ts';
import { errorText } from './text.ts';
import { hasChunks, sameContent, type Change, type ChunkRef, type Commit, type Entry, type FileStat, type LocalFS, type RemoteStore, type StateStore, type Version } from './types.ts';
import { verifyRepo, type VerifyOptions, type VerifyReport } from './verify.ts';

export type { VerifyOptions, VerifyProblem, VerifyReport } from './verify.ts';

export interface EngineOptions {
  fs: LocalFS;
  store: RemoteStore;
  stateStore: StateStore;
  passphrase: string;
  config: SyncConfig;
  now?: () => number;
  log?: (message: string) => void;
  onProgress?: (progress: { phase: 'upload' | 'download'; done: number; total: number }) => void;
}

export interface SyncOptions {
  /** Waives the guard against mass deletion for this sync. */
  force?: boolean;
  /**
   * Vault paths that may have changed on this device since the previous call to `sync` on this engine:
   * each file created, modified or deleted, and both the old and the new path of a file renamed, in any
   * Unicode form. With it the vault is not listed: the sync looks only at these paths, at what the remote
   * changed, and at what an earlier sync could not finish. Collect from the moment of the previous call, so
   * a change made while a sync runs belongs to the next one; after a call that failed, start afresh, since
   * the next sync lists the vault anyway. Files the engine writes itself (received, merged, conflict copies)
   * need not be named. A path that did not change, is excluded or names nothing costs one stat and changes
   * nothing.
   *
   * Pass undefined, so that the vault is listed, whenever the set may be incomplete:
   * - files in the settings folder (`configDir`) may have changed: they fire no vault events, so pass
   *   undefined when settings should be looked at, as on a manual sync and every few minutes;
   * - a folder was renamed, moved or deleted and the paths of its files are not all included. Leave out a
   *   folder that was created: files put in it come as their own changes, and on some file systems a
   *   folder's stat looks like a file's;
   * - changes may have gone unseen, as while nothing was listening.
   *
   * Ignored, and the vault listed, on the first sync of an engine, after a sync that failed or could not
   * finish, and after `keepAllFiles` or `acceptStorage`, so a wrong set never outlives the engine. The vault
   * is also listed when a path names a folder this device knows files in, when a new name differs only by
   * letter case from another file's (a file system that ignores case answers for either), when the file
   * system fails to stat one of them, and when the paths to look at number in the hundreds. Paths are as the
   * engine's `fs` names them: for a file system scoped to a folder, relative to that folder.
   */
  changed?: Iterable<string>;
  /**
   * Vault paths whose deletion the user has just confirmed, as when restoring an earlier time. Deleting
   * them from storage does not count toward the guard against mass deletion; every other deletion does,
   * those other devices commit meanwhile included. The commit that deletes them is marked `confirmed`, so
   * other devices do not count them either. Only deletions this sync finds and that are named here are
   * marked; a path that still exists is not deleted.
   */
  allowDeletes?: Iterable<string>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  deletedLocal: number;
  deletedRemote: number;
  merged: number;
  conflictCopies: string[];
  skipped: number;
  /** Files not synced on this device because they are over the size limit. */
  tooLarge: string[];
  errors: { path: string; message: string }[];
  commits: number;
  rounds: number;
}

/** The repo with the remote file table brought up to date, for features that only read. */
export interface RepoView {
  repo: Repo;
  /**
   * This device's state, live. Read it; changing it changes what the next sync does. A sync called
   * meanwhile starts once the caller next awaits something, and may change it from then on, so copy what
   * must stay as it was.
   */
  st: LocalState;
  cfg: SyncConfig;
  now: number;
}

export interface GcResult extends CleanupResult {
  /** Packs whose current data was copied into fewer, fuller ones. */
  packsCombined: number;
  /** New packs that data went into. */
  packsWritten: number;
  bytesMoved: number;
  /**
   * The size of the packs combined. Older moments still read them, so a later cleanup frees them once
   * no kept moment does: at the latest when the moments before the move have left the retention window.
   */
  bytesFreedLater: number;
}

/**
 * Thrown instead of syncing when a sync would delete a suspiciously large share of the vault. The counts
 * leave out deletions the user confirmed.
 */
export class SafetyError extends Error {
  readonly localDeletes: number;
  readonly remoteDeletes: number;
  constructor(localDeletes: number, remoteDeletes: number) {
    super(
      `Refusing to sync: it would delete ${localDeletes} local and ${remoteDeletes} remote files. ` +
        'If that is intended, run a forced sync.',
    );
    this.localDeletes = localDeletes;
    this.remoteDeletes = remoteDeletes;
  }
}

/**
 * The log in storage, or the commit it is anchored on, is not the one this device saw: cut back under it, or
 * holding other commits where it saw its own, as after storage was restored from a backup or replaced. Storage
 * is consistent in itself as far as this device checked, so `acceptStorage` carries on from it. Damage within
 * storage (a gap, a link between two stored commits that does not hold, a snapshot that disagrees with its
 * commit) is a plain Error: accepting storage would only find it again.
 */
export class HistoryError extends Error {}

/**
 * The guard against a vault that looks empty for the wrong reason (unmounted folder, wrong path, files
 * evicted by another tool): unless forced, a sync is refused when either side would end up with more than
 * this many fewer files, counting deletions minus files added, so a move counts for nothing. `synced` is
 * how many files this device last synced. Deletions the user confirmed do not count (`allowDeletes`).
 */
export function deleteLimit(synced: number, cfg: Pick<SyncConfig, 'maxDeleteCount' | 'maxDeleteFraction'>): number {
  return Math.max(cfg.maxDeleteCount, synced * cfg.maxDeleteFraction);
}

interface Prepared {
  file: Local;
  entry: Entry;
}

const MAX_ROUNDS = 5;
const PULL_BATCH = 32 << 20;
const MAX_RANGE = 8 << 20;
const MOVE_CACHE = 64 << 20;
const OPTIMISTIC_BYTES = 256 << 10;
const OPEN_PARALLEL = 4;
const HEAD_CHECK_EVERY = 3_600_000;
/** More paths than this to look at, and asking for each costs more than listing the vault. */
const MAX_LOOKED_UP = 256;

const contentKey = (e: Entry) => e.chunks.map((c) => c.id).join(',');

/** The file still has the size and time the scan saw, or is still absent. */
const unchanged = (cur: FileStat | null, l: Local | undefined) => (l ? !!cur && cur.size === l.size && cur.mtime === l.mtime : !cur);

const recordError = (res: SyncResult, path: string, e: unknown) => {
  const message = errorText(e);
  // A later pass of the same sync may try the file again; it is still one failed file.
  const earlier = res.errors.find((x) => x.path === path);
  if (earlier) earlier.message = message;
  else res.errors.push({ path, message });
};

/** What this engine knows of the local files that its state does not say, from its last listing and the syncs since. */
interface Known {
  /** Files over the size limit, by key. */
  tooLarge: Set<string>;
  /** Names on disk in another Unicode form than their key, by key. */
  paths: Map<string, string>;
}

/** One sync: what it was asked, and what it learns as it goes. */
interface Run {
  force: boolean;
  allow: Set<string>;
  /** The paths the caller says may have changed, by key, with their names on disk. Undefined: list the vault. */
  hint?: Map<string, string>;
  known: Known;
  /** Paths the next sync must look at although nothing may name them: changed while this one worked on them, or written by it and not yet synced. */
  unsettled: Set<string>;
}

/** The local files a pass works with. */
interface LocalView {
  local: Map<string, Local>;
  tooLarge: Set<string>;
  /** The only paths it covers, when it did not come from listing the vault. */
  keys?: Set<string>;
}

/** What one pass works with, shared by its steps. */
interface Pass {
  repo: Repo;
  st: LocalState;
  local: Map<string, Local>;
  keys?: Set<string>;
  /** Local keys by lower-case name, so a pull cannot create a second file that differs only by case. Built by `lower` when first needed. */
  byLower?: Map<string, string>;
  run: Run;
  res: SyncResult;
  /** What download progress counts toward: planned pulls, plus conflicts, which may download the remote side. */
  pulls: number;
  downloaded: number;
}

export class SyncEngine {
  private o: EngineOptions;
  private cfg: SyncConfig;
  private excluded: (path: string) => boolean;
  private now: () => number;
  private repo?: Repo;
  private st?: LocalState;
  private opening?: Promise<void>;
  /** The last operation that changes this device's state, which the next one waits for. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Chunks a commit may refer to without uploading them, by id. See `reusable`. */
  private dedup = new Map<string, ChunkRef>();
  /** Chunks this sync uploaded, by id. */
  private uploaded = new Map<string, ChunkRef>();
  /** When the log was last seen to continue from this device's newest commit. */
  private headSeen = -Infinity;
  /** Undefined until a sync of this engine has listed the vault and finished, and again after one fails. */
  private known?: Known;
  /** Paths the next sync looks at even when told only of others: changed remotely since a sync planned them, or left unfinished. */
  private recheck = new Set<string>();
  /** Commits were read that no finished sync has planned: outside a sync, or by one that failed. */
  private unplanned = false;
  private syncing = false;
  /** The state has changes not yet saved. */
  private unsaved = false;

  constructor(options: EngineOptions) {
    this.o = options;
    this.cfg = options.config;
    this.excluded = compileExcludes(this.cfg.exclude);
    this.now = options.now ?? Date.now;
  }

  private log(message: string): void {
    this.o.log?.(message);
  }

  /**
   * Runs `task` once every operation called before it has finished. Everything that brings the remote
   * table up to date or changes this device's state goes through here: applying a commit twice, or
   * planning against a table that moves underneath, would corrupt it.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async open(): Promise<{ repo: Repo; st: LocalState }> {
    if (!this.repo || !this.st) {
      // Shared, so that callers that do not wait for each other still end up with one state.
      this.opening ??= this.load().finally(() => (this.opening = undefined));
      await this.opening;
    }
    return { repo: this.repo!, st: this.st! };
  }

  private async load(): Promise<void> {
    if (!this.repo) {
      this.repo = await Repo.open(this.o.store, this.o.passphrase, { kdfIterations: this.cfg.kdfIterations, chunk: this.cfg.chunk });
    }
    if (!this.st) {
      const st = LocalState.parse(await this.o.stateStore.load());
      if (st.vaultId !== this.repo.id) {
        // A different remote vault than last time: nothing recorded about the old one applies.
        if (st.vaultId) this.log('Remote vault changed; starting from a clean local state');
        this.st = new LocalState();
        this.st.vaultId = this.repo.id;
      } else this.st = st;
    }
  }

  /** Saves the state if it changed since it was last saved. */
  private async save(): Promise<void> {
    if (!this.unsaved) return;
    await this.o.stateStore.save(this.st!.serialize());
    this.unsaved = false;
  }

  /**
   * Brings the cached remote file table up to the newest commit. Returns the paths that changed. Each is
   * put in `recheck` as it enters the table, so a request that fails later loses none of them.
   */
  private async fetchRemote(): Promise<Set<string>> {
    const { repo, st } = await this.open();
    const touched = new Set<string>();
    const touch = (p: string) => {
      touched.add(p);
      this.recheck.add(p);
      this.unplanned = true;
    };
    const add = async (c: Commit) => {
      // A commit without `prev` comes from a version that did not chain the log. It is taken as it
      // is, and the chain restarts from it: the next chained commit names its digest like any other.
      if (c.prev !== undefined && st.head !== undefined && c.prev !== st.head) {
        const message = `Remote commit ${c.seq} does not follow the commit before it as this device saw it: the log was tampered with or forked`;
        // Only on this path: storage's own commit before it says whether storage holds another one than this
        // device saw, or the link between two stored commits is broken.
        throw (await repo.readCommit(c.seq - 1))?.hash === c.prev ? new HistoryError(message) : new Error(message);
      }
      // A move changes no content, so work prepared against the file before it is still valid. It
      // moves this device's merge base too, whose old place goes once no kept version records it.
      for (const { path, entry } of c.changes) {
        const was = st.remote.get(path);
        if (!c.moved || !entry || !was || !sameContent(was, entry)) touch(path);
        const s = c.moved && entry && st.synced.get(path);
        if (s && sameContent(s.entry, entry)) s.entry = entry;
      }
      st.apply(c);
      this.headSeen = this.now();
    };
    const loadSnapshot = async () => {
      const snaps = await repo.snapshots();
      const latest = snaps[snaps.length - 1];
      if (!latest || latest.seq <= st.lastSeq) return;
      // The chain goes on from the commit the snapshot was taken at, read in the same round trip.
      const [snap, at] = await Promise.all([repo.readSnapshotWithHead(latest.seq), repo.readCommit(latest.seq)]);
      if (!snap) return;
      if (!at) throw new Error(`Remote commit ${latest.seq} is missing, though a snapshot was taken at it`);
      if (snap.head !== undefined && snap.head !== at.hash) {
        throw new Error(`Remote snapshot ${latest.seq} was taken at a different commit ${latest.seq} than storage holds: the log was tampered with or forked`);
      }
      for (const p of st.remote.keys()) touch(p);
      for (const p of snap.files.keys()) touch(p);
      st.remote = snap.files;
      st.lastSeq = latest.seq;
      st.head = at.hash;
      // Which deletions in the skipped commits were confirmed is not known: they all count.
      st.confirmed.clear();
      this.headSeen = this.now();
    };

    if (st.lastSeq === 0) await loadSnapshot();
    else {
      // The common cases cost one or two cheap GETs: nothing new, or exactly one new commit.
      // Two probes at once: "nothing new" and "exactly one new commit" both finish in a single round trip.
      // "Nothing new" cannot tell a quiet log from one cut back under this device, so at start and then
      // hourly a third read in the same round trip checks that this device's newest commit is still there.
      const checkHead = this.headDue(st);
      const [first, second, head] = await Promise.all([
        repo.readCommit(st.lastSeq + 1),
        repo.readCommit(st.lastSeq + 2),
        checkHead ? repo.readCommit(st.lastSeq) : undefined,
      ]);
      if (head !== undefined) this.checkHead(st, head, first ?? second);
      if (!first) return touched;
      await add(first);
      if (!second) return touched;
      await add(second);
    }
    let seqs = await repo.commitSeqsAfter(st.lastSeq);
    if (seqs.length > this.cfg.snapshotEvery) {
      await loadSnapshot();
      seqs = seqs.filter((s) => s > st.lastSeq);
    }
    const commits: Commit[] = new Array(seqs.length);
    await pool(seqs, this.cfg.concurrency, async (seq, i) => {
      const c = await repo.readCommit(seq);
      if (!c) throw new Error(`Commit ${seq} is listed but cannot be read`);
      commits[i] = c;
    });
    for (const c of commits) {
      if (c.seq !== st.lastSeq + 1) throw new Error(`Remote log has a gap before commit ${c.seq}`);
      await add(c);
    }
    this.headSeen = this.now();
    return touched;
  }

  private headDue(st: LocalState): boolean {
    return st.head === undefined || this.now() - this.headSeen >= HEAD_CHECK_EVERY;
  }

  /** `head` is storage's commit `st.lastSeq`, and `later` one it holds after it, if any. */
  private checkHead(st: LocalState, head: Commit | null, later: Commit | null): void {
    if (!head) {
      const message = `Remote commit ${st.lastSeq}, the newest this device has seen, is missing: the log was rolled back or tampered with`;
      // With a later commit stored, the log has a hole rather than an end before it.
      throw later ? new Error(message) : new HistoryError(message);
    }
    if (st.head !== undefined && head.hash !== st.head) {
      throw new HistoryError(`Remote commit ${st.lastSeq} is not the one this device saw: the log was tampered with or forked`);
    }
    st.head = head.hash;
    this.headSeen = this.now();
  }

  private maxSize(): number {
    return this.cfg.maxFileSizeMB * (1 << 20) || Infinity;
  }

  private async scan(run: Run): Promise<LocalView> {
    const maxSize = this.maxSize();
    const local = new Map<string, Local>();
    const tooLarge = new Set<string>();
    const paths = new Map<string, string>();
    for (const f of await this.o.fs.list()) {
      const key = vaultKey(f.path);
      if (this.excluded(key) || local.has(key)) continue;
      if (f.path !== key) paths.set(key, f.path);
      if (f.size > maxSize) tooLarge.add(key);
      else local.set(key, { ...f, key });
    }
    run.known = { tooLarge, paths };
    return { local, tooLarge };
  }

  /**
   * The local files a pass plans over: every one, from a listing, or with a hint, those the hint names
   * and those in `recheck`, each asked for by name. Lists after all when a name alone cannot tell: see
   * `SyncOptions.changed`. `view`, from earlier in the pass, is extended by the paths it lacks.
   */
  private async look(run: Run, st: LocalState, view?: LocalView): Promise<LocalView> {
    const hint = run.hint;
    if (hint) {
      const keys = new Set([...hint.keys(), ...this.recheck]);
      if (keys.size <= MAX_LOOKED_UP) {
        const { tooLarge, paths } = run.known;
        const v: LocalView = view?.keys ? view : { local: new Map(), tooLarge, keys: new Set() };
        const maxSize = this.maxSize();
        const fresh = [...keys].filter((k) => !v.keys!.has(k));
        for (const k of fresh) v.keys!.add(k);
        let unasked = false;
        await pool(fresh, this.cfg.concurrency, async (key) => {
          if (this.excluded(key)) return;
          const path = hint.get(key) ?? paths.get(key) ?? key;
          let s: FileStat | null;
          try {
            s = await this.o.fs.stat(path);
          } catch {
            unasked = true;
            return;
          }
          v.local.delete(key);
          tooLarge.delete(key);
          paths.delete(key);
          if (!s) return;
          if (path !== key) paths.set(key, path);
          if (s.size > maxSize) tooLarge.add(key);
          else v.local.set(key, { path, size: s.size, mtime: s.mtime, key });
        });
        // A path the file system will not answer for, as one outside its scope, is left to a listing.
        if (!unasked && !this.needsListing(st, v, hint)) return v;
      }
      run.hint = undefined;
    }
    return this.scan(run);
  }

  /**
   * True when a hinted path names a folder this device knows files in, or a file found by name may be
   * another one's: a new name that shares its lower-case form with another file's.
   */
  private needsListing(st: LocalState, v: LocalView, hint: Map<string, string>): boolean {
    const keys = v.keys!;
    // Only a name that is not a file now can be a folder.
    const gone = new Set([...hint.keys()].filter((k) => !st.synced.has(k) && !v.local.has(k) && !v.tooLarge.has(k) && !this.excluded(k)));
    if (gone.size) {
      for (const list of [st.synced.keys(), v.tooLarge, keys]) {
        for (const k of list) {
          for (let i = k.lastIndexOf('/'); i > 0; i = k.lastIndexOf('/', i - 1)) if (gone.has(k.slice(0, i))) return true;
        }
      }
    }
    if (![...v.local.keys()].some((k) => !st.synced.has(k))) return false;
    const lower = new Map<string, string>();
    for (const key of st.synced.keys()) if (!keys.has(key)) lower.set(key.toLowerCase(), key);
    for (const key of v.local.keys()) {
      const lc = key.toLowerCase();
      const other = lower.get(lc);
      if (other !== undefined && other !== key && (!st.synced.has(key) || !st.synced.has(other))) return true;
      lower.set(lc, key);
    }
    return false;
  }

  /** Local keys by lower-case name; without a listing, the files this device last synced stand in for those it did not look at. */
  private lower(pass: Pass): Map<string, string> {
    if (!pass.byLower) {
      const m = (pass.byLower = new Map());
      if (pass.keys) {
        for (const key of pass.st.synced.keys()) {
          if (!pass.keys.has(key) && !pass.run.known.tooLarge.has(key) && !this.excluded(key)) m.set(key.toLowerCase(), key);
        }
      }
      for (const key of pass.local.keys()) m.set(key.toLowerCase(), key);
    }
    return pass.byLower;
  }

  /** Every path not synced here for its size, on this device or remotely; what a plan over all paths reports. */
  private tooLarge(st: LocalState, here: Set<string>): string[] {
    const maxSize = this.maxSize();
    const out = new Set([...here].filter((k) => !this.excluded(k)));
    if (maxSize < Infinity) for (const [key, r] of st.remote) if (r.size > maxSize && !this.excluded(key)) out.add(key);
    return [...out].sort();
  }

  /**
   * Brings this device and the remote in step. A sync called while another operation runs starts once
   * that one has finished. See `SyncOptions`.
   */
  sync(opts: SyncOptions = {}): Promise<SyncResult> {
    return this.exclusive(() => this.syncHeld(opts));
  }

  private async syncHeld(opts: SyncOptions): Promise<SyncResult> {
    const res: SyncResult = {
      pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0,
      conflictCopies: [], skipped: 0, tooLarge: [], errors: [], commits: 0, rounds: 0,
    };
    const { st } = await this.open();
    const allow = new Set([...(opts.allowDeletes ?? [])].map(vaultKey));
    const known = this.known;
    const run: Run = { force: !!opts.force, allow, known: known ?? { tooLarge: new Set(), paths: new Map() }, unsettled: new Set() };
    if (opts.changed && known) {
      run.hint = new Map();
      for (const p of opts.changed) run.hint.set(vaultKey(p), p);
      for (const k of allow) if (!run.hint.has(k)) run.hint.set(k, known.paths.get(k) ?? k);
    }
    // Until this sync finishes, nothing it has seen is to be trusted by the next.
    this.known = undefined;
    this.uploaded = new Map();
    this.syncing = true;
    try {
      let again = true;
      for (let round = 0; round < MAX_ROUNDS && again; round++) {
        res.rounds++;
        again = await this.round(res, run, round === 0);
      }
      for (const p of st.confirmed) if (!st.synced.has(p) || st.remote.has(p)) st.confirmed.delete(p);
      if (!again) {
        this.known = run.known;
        this.recheck = new Set([...res.errors.map((e) => e.path), ...run.unsettled]);
        this.unplanned = false;
      }
    } finally {
      this.syncing = false;
      this.dedup = new Map();
      this.uploaded = new Map();
    }
    return res;
  }

  /** One pass of scan, plan, apply. Returns true when another pass is needed. */
  private async round(res: SyncResult, run: Run, first: boolean): Promise<boolean> {
    const { repo, st } = await this.open();
    const maxSize = this.maxSize();
    let v = await this.look(run, st);
    let p = planChanges(v.local, st, this.excluded, maxSize, v.tooLarge, v.keys);
    // A small local edit is committed without first asking whether the remote moved: the commit
    // itself fails if it did, and the next pass sorts it out. Saves a round trip on the common case.
    // Not when the head check is due: a commit on top of a log cut back under this device would succeed.
    const optimistic =
      first && st.lastSeq > 0 && !this.headDue(st) &&
      p.pushes.length + p.pushDeletes.length > 0 && !p.pulls.length && !p.pullDeletes.length && !p.conflicts.length &&
      p.pushes.reduce((n, f) => n + f.size, 0) <= OPTIMISTIC_BYTES;
    if (!optimistic && (await this.fetchRemote()).size) {
      if (v.keys) v = await this.look(run, st, v);
      p = planChanges(v.local, st, this.excluded, maxSize, v.tooLarge, v.keys);
    }
    res.tooLarge = this.tooLarge(st, v.tooLarge);

    if (nothingToDo(p)) return false;
    this.checkDeletes(p, st, run);

    const pass: Pass = { repo, st, local: v.local, keys: v.keys, run, res, pulls: p.pulls.length + p.conflicts.length, downloaded: 0 };
    const moved = await this.deleteLocal(pass, p);
    await this.pull(pass, p.pulls, moved);
    await this.save();

    for (const key of p.conflicts) {
      try {
        const extra = await this.resolve(pass, key, v.local.get(key)!);
        if (extra) p.pushes.push(extra);
      } catch (e) {
        recordError(res, key, e);
      }
    }

    const commitsBefore = res.commits;
    let again = false;
    if (p.pushes.length || p.pushDeletes.length) again = await this.push(p.pushes, p.pushDeletes, run, res);
    await this.save();
    // An optimistic pass that ended up committing nothing has not looked at the remote at all yet.
    return again || (optimistic && res.commits === commitsBefore);
  }

  /** Moves delete and re-create, so net shrinkage is what counts. See `deleteLimit`. */
  private checkDeletes(p: Plan, st: LocalState, run: Run): void {
    if (run.force) return;
    const limit = deleteLimit(st.synced.size, this.cfg);
    const here = p.pullDeletes.filter((k) => !st.confirmed.has(k)).length;
    const there = p.pushDeletes.filter((k) => !run.allow.has(k)).length;
    if (here - p.pulls.length > limit || there - p.pushes.length > limit) throw new SafetyError(here, there);
  }

  private skip(run: Run, res: SyncResult, key: string): void {
    res.skipped++;
    run.unsettled.add(key);
  }

  /**
   * Removes local files deleted elsewhere. A file moved on another device arrives as a delete plus
   * a create with the same content, so the bytes a pull wants are kept: a move downloads nothing.
   */
  private async deleteLocal(pass: Pass, p: Plan): Promise<Map<string, Uint8Array>> {
    const { st, local, run, res } = pass;
    const fs = this.o.fs;
    const wanted = new Set<string>();
    if (p.pullDeletes.length) for (const key of p.pulls) wanted.add(contentKey(st.remote.get(key)!));
    const moved = new Map<string, Uint8Array>();
    let movedBytes = 0;

    for (const key of p.pullDeletes) {
      const l = local.get(key)!;
      try {
        if (!unchanged(await fs.stat(l.path), l)) {
          this.skip(run, res, key);
          continue;
        }
        const ck = contentKey(st.synced.get(key)!.entry);
        if (wanted.has(ck) && !moved.has(ck) && movedBytes + l.size <= MOVE_CACHE) {
          moved.set(ck, await fs.read(l.path));
          movedBytes += l.size;
        }
        await fs.remove(l.path);
        st.synced.delete(key);
        this.unsaved = true;
        local.delete(key);
        run.known.paths.delete(key);
        pass.byLower?.delete(key.toLowerCase());
        res.deletedLocal++;
      } catch (e) {
        recordError(res, key, e);
      }
    }
    return moved;
  }

  /** Writes a remote version into the vault, unless the local file changed since the scan. */
  private async writeRemote(pass: Pass, key: string, entry: Entry, data: Uint8Array): Promise<void> {
    const { st, local, run, res } = pass;
    const fs = this.o.fs;
    const l = local.get(key);
    if (!l) {
      const other = this.lower(pass).get(key.toLowerCase());
      if (other && other !== key) throw new Error(`Name differs only by case from "${other}"`);
    }
    const path = l?.path ?? key;
    if (!unchanged(await fs.stat(path), l)) {
      this.skip(run, res, key);
      return;
    }
    const stat = await fs.write(path, data, entry.mtime);
    st.synced.set(key, { entry, lsize: stat.size, lmtime: stat.mtime });
    this.unsaved = true;
    if (!l) run.known.paths.delete(key);
    pass.byLower?.set(key.toLowerCase(), key);
    res.pulled++;
    this.o.onProgress?.({ phase: 'download', done: ++pass.downloaded, total: pass.pulls });
  }

  /** Downloads remote changes in batches. `moved` holds the bytes of files a move already has here. */
  private async pull(pass: Pass, pulls: string[], moved: Map<string, Uint8Array>): Promise<void> {
    const { repo, st, local, res } = pass;
    const fs = this.o.fs;
    for (let i = 0; i < pulls.length; ) {
      const batch: string[] = [];
      for (let bytes = 0; i < pulls.length && (bytes < PULL_BATCH || !batch.length); i++) {
        batch.push(pulls[i]);
        bytes += st.remote.get(pulls[i])!.size;
      }
      // Each file is assembled in a buffer of its final size as chunks arrive, so a large file
      // costs its own size in memory, not several copies of it.
      const files = new Map<string, Uint8Array>();
      const slots = new Map<string, { buf: Uint8Array; at: number }[]>();
      const need: ChunkRef[] = [];
      for (const key of batch) {
        const e = st.remote.get(key)!;
        const whole = moved.get(contentKey(e));
        if (whole) {
          files.set(key, whole);
          continue;
        }
        const buf = new Uint8Array(e.size);
        files.set(key, buf);
        let at = 0;
        for (const c of e.chunks) {
          let list = slots.get(c.id);
          if (!list) {
            slots.set(c.id, (list = []));
            need.push(c);
          }
          list.push({ buf, at });
          at += c.size;
        }
        if (at !== e.size) throw new Error(`Remote entry for ${key} is inconsistent`);
      }
      const place = (id: string, plain: Uint8Array) => {
        for (const { buf, at } of slots.get(id) ?? []) buf.set(plain, at);
        slots.delete(id);
      };
      for (const key of batch) {
        // A large file that changed in one place: the unchanged chunks are already on this device.
        const e = st.remote.get(key)!;
        const l = local.get(key);
        const old = st.synced.get(key)?.entry;
        if (!l || !old || e.chunks.length < 2 || !old.chunks.some((c) => slots.has(c.id))) continue;
        try {
          const { parts, ids } = await repo.split(await fs.read(l.path));
          ids.forEach((id, n) => place(id, parts[n]));
        } catch {
          // unreadable: download everything
        }
      }
      // Damage in storage fails the files that need it, not the whole sync.
      const failed = new Map<string, unknown>();
      await this.fetchChunks(
        need.filter((c) => slots.has(c.id)),
        (ref, plain) => {
          if (plain.length !== ref.size) throw new Error(`Remote chunk ${ref.id} has the wrong size`);
          place(ref.id, plain);
        },
        (ref, e) => failed.set(ref.id, e),
      );
      // What `place` did not fill is missing from those buffers.
      const incomplete = new Map<Uint8Array, unknown>();
      for (const [id, list] of slots) for (const { buf } of list) incomplete.set(buf, failed.get(id));
      await pool(batch, this.cfg.concurrency, async (key) => {
        try {
          const data = files.get(key)!;
          if (incomplete.has(data)) throw incomplete.get(data);
          await this.writeRemote(pass, key, st.remote.get(key)!, data);
        } catch (err) {
          recordError(res, key, err);
        }
      });
    }
  }

  /** Both sides changed the same file. Returns a local file that now needs pushing, if any. */
  private async resolve(pass: Pass, key: string, l: Local): Promise<Local | undefined> {
    const { repo, st, run, res } = pass;
    const fs = this.o.fs;
    const r = st.remote.get(key)!;
    const base = st.synced.get(key)?.entry;
    const mine = await fs.read(l.path);
    if (!unchanged(await fs.stat(l.path), l)) {
      this.skip(run, res, key);
      return;
    }
    const { ids } = await repo.split(mine);
    if (hasChunks(r, ids)) {
      st.synced.set(key, { entry: r, lsize: l.size, lmtime: l.mtime });
      this.unsaved = true;
      return;
    }

    // A copy in the settings folder would never be read or shown, so settings are always combined.
    const settings = key.startsWith(`${this.cfg.configDir}/`);
    const merged = settings
      ? await this.mergeSettings(key, base, mine, r)
      : this.cfg.conflictStrategy === 'merge' && base && this.cfg.mergeExtensions.includes(ext(key))
        ? await this.tryMerge(base, mine, r)
        : null;
    if (merged) {
      // Fetching the other versions took a moment; do not write over an edit made meanwhile.
      if (!unchanged(await fs.stat(l.path), l)) {
        this.skip(run, res, key);
        return;
      }
      const stat = await fs.write(l.path, merged);
      // Recorded as "agrees with remote, then edited", so the merge result is pushed like any local edit.
      st.synced.set(key, { entry: r, lsize: -1, lmtime: -1 });
      this.unsaved = true;
      res.merged++;
      return { key, path: l.path, ...stat };
    }
    if (settings) {
      // Not mergeable (plugin code, a theme, unreadable JSON): the version synced first stays, like any setting both changed.
      await this.writeRemote(pass, key, r, await this.readVersion(r));
      return;
    }

    // Keep both: this device's version moves aside, the remote version takes the original name. Downloaded first:
    // a copy made for a version that cannot be read would be made again at every sync.
    const theirs = await this.readVersion(r);
    const at = new Date(this.now());
    let copy = conflictCopyName(key, this.cfg.deviceName, at);
    for (let n = 2; await fs.stat(copy); n++) copy = conflictCopyName(key, this.cfg.deviceName, at, n);
    const copyStat = await fs.write(copy, mine, l.mtime);
    run.unsettled.add(copy);
    await this.writeRemote(pass, key, r, theirs);
    res.conflictCopies.push(copy);
    return { key: copy, path: copy, ...copyStat };
  }

  /** JSON settings merge key by key, even with no common version (two devices set up apart); other text line by line. */
  private async mergeSettings(key: string, base: Entry | undefined, mine: Uint8Array, remote: Entry): Promise<Uint8Array | null> {
    if (ext(key) !== 'json') return base ? this.tryMerge(base, mine, remote) : null;
    try {
      const text = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(data);
      const theirs = text(await this.readVersion(remote));
      // A common version past the retention window only loses the three-way view, not the merge.
      const ancestor = base ? await this.readVersion(base).then(text, () => undefined) : undefined;
      const merged = mergeJson(ancestor, text(mine), theirs);
      return merged === null ? null : new TextEncoder().encode(merged);
    } catch {
      return null;
    }
  }

  private async tryMerge(base: Entry, mine: Uint8Array, remote: Entry): Promise<Uint8Array | null> {
    try {
      const text = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(data);
      const [theirBase, theirs] = await Promise.all([this.readVersion(base), this.readVersion(remote)]);
      const merged = merge3(text(theirBase), text(mine), text(theirs));
      return merged === null ? null : new TextEncoder().encode(merged);
    } catch {
      // Not text, or the base version is no longer stored: fall back to keeping both.
      return null;
    }
  }

  /**
   * Downloads and decrypts chunks, fetching neighbours in one pack with one request. `sink` gets each chunk once.
   * With `failed`, a chunk whose pack is missing or that cannot be opened goes there instead of failing them all;
   * a request that fails still does.
   */
  private async fetchChunks(refs: ChunkRef[], sink: (ref: ChunkRef, plain: Uint8Array) => void, failed?: (ref: ChunkRef, e: unknown) => void): Promise<void> {
    const { repo } = await this.open();
    const once = new Map<string, ChunkRef>();
    for (const ref of refs) if (!once.has(ref.id)) once.set(ref.id, ref);
    await pool(packRanges([...once.values()], this.cfg.rangeGapBytes, MAX_RANGE), this.cfg.concurrency, async (range) => {
      const data = await repo.getPackRange(range.pack, range.start, range.end);
      if (!data) {
        const e = new Error(`Remote pack ${range.pack} is missing`);
        if (!failed) throw e;
        for (const ref of range.refs) failed(ref, e);
        return;
      }
      // Decrypting and inflating run off the main thread, so one range's chunks need not queue behind each other.
      await pool(range.refs, OPEN_PARALLEL, async (ref) => {
        const at = ref.off - range.start;
        try {
          sink(ref, await repo.openChunk(ref.id, data.subarray(at, at + ref.len)));
        } catch (e) {
          if (!failed) throw e;
          failed(ref, e);
        }
      });
    });
  }

  /**
   * Chunks a commit may refer to without uploading them again: those of the file table it is
   * written on top of, and those this sync uploaded. Cleanup keeps the data of every kept version
   * (current at a kept moment, or now) and every recent pack, but nothing else: a chunk known only from
   * a table that went out of date, as on a device that was away, may be in a pack deleted because its
   * version was thinned or left the window. That table is replaced before anything is committed on it.
   */
  private reusable(st: LocalState): Map<string, ChunkRef> {
    const m = new Map(this.uploaded);
    for (const e of st.remote.values()) for (const c of e.chunks) m.set(c.id, c);
    return m;
  }

  /** Points a prepared entry at chunks it may still refer to. False when one of them must be uploaded again. */
  private rebase(e: Entry): boolean {
    for (let i = 0; i < e.chunks.length; i++) {
      const ref = this.dedup.get(e.chunks[i].id);
      if (!ref) return false;
      e.chunks[i] = ref;
    }
    return true;
  }

  /**
   * Uploads local changes in batches, one commit per batch, and the deletions the user confirmed in a
   * commit of their own, marked as such. Returns true when a later pass must look again.
   */
  private async push(files: Local[], deletes: string[], run: Run, res: SyncResult): Promise<boolean> {
    const { repo, st } = await this.open();
    // An optimistic pass has not checked that this table is current. If it is not, the commit fails
    // and `commit` rebases what was prepared onto the table it fetches then.
    this.dedup = this.reusable(st);
    const packer = new Packer(repo, this.cfg.packTargetBytes, this.cfg.packMaxBlobBytes, this.cfg.concurrency);
    let again = false;

    const prepare = async (f: Local): Promise<Prepared | undefined> => {
      const data = await this.o.fs.read(f.path);
      if (!unchanged(await this.o.fs.stat(f.path), f) || data.length !== f.size) {
        this.skip(run, res, f.key); // being written right now; the next sync picks it up
        return;
      }
      const { parts, ids } = await repo.split(data);
      const base = st.synced.get(f.key)?.entry;
      if (base && st.remote.get(f.key) && hasChunks(base, ids)) {
        st.synced.set(f.key, { entry: base, lsize: f.size, lmtime: f.mtime }); // touched, not changed
        this.unsaved = true;
        return;
      }
      const compress = this.cfg.compression && worthCompressing(f.key, f.size);
      const chunks: ChunkRef[] = [];
      for (let i = 0; i < parts.length; i++) {
        let ref = this.dedup.get(ids[i]);
        if (!ref) {
          const sealed = await repo.sealChunk(ids[i], parts[i], compress);
          ref = this.dedup.get(ids[i]);
          if (!ref) {
            ref = packer.add(ids[i], sealed, parts[i].length);
            this.dedup.set(ids[i], ref);
            this.uploaded.set(ids[i], ref);
            await packer.backpressure();
          }
        }
        chunks.push(ref);
      }
      return { file: f, entry: { size: f.size, mtime: f.mtime, chunks } };
    };

    const confirmed = deletes.filter((k) => run.allow.has(k));
    if (confirmed.length && (await this.commit([], confirmed, res, true))) again = true;
    let done = 0;
    let pendingDeletes = deletes.filter((k) => !run.allow.has(k));
    for (let i = 0; i < files.length || pendingDeletes.length; ) {
      const batch: Local[] = [];
      for (let bytes = 0; i < files.length && (bytes < this.cfg.commitBatchBytes || !batch.length); i++) {
        batch.push(files[i]);
        bytes += files[i].size;
      }
      // In the batch's order, whichever finishes first, so the same changes always make the same commit.
      const prepared: (Prepared | undefined)[] = new Array(batch.length);
      await pool(batch, this.cfg.concurrency, async (f, n) => {
        try {
          prepared[n] = await prepare(f);
          this.o.onProgress?.({ phase: 'upload', done: ++done, total: files.length });
        } catch (e) {
          recordError(res, f.key, e);
        }
      });
      await packer.flush();
      if (await this.commit(prepared.filter((p) => p !== undefined), pendingDeletes, res)) again = true;
      pendingDeletes = [];
    }
    return again;
  }

  /** Returns true when another device committed first and some of these changes must be re-planned. */
  private async commit(prepared: Prepared[], deletes: string[], res: SyncResult, confirmed = false): Promise<boolean> {
    const { repo, st } = await this.open();
    let contended = false;
    while (prepared.length || deletes.length) {
      const changes: Change[] = [
        ...prepared.map((p) => ({ path: p.file.key, entry: p.entry })),
        ...deletes.map((path) => ({ path, entry: null })),
      ];
      const c: Commit = { seq: st.lastSeq + 1, device: this.cfg.deviceName, time: this.now(), changes, prev: st.head, ...(confirmed && { confirmed }) };
      const hash = await repo.writeCommit(c);
      if (hash) {
        st.apply({ ...c, time: 0, hash });
        for (const p of prepared) st.synced.set(p.file.key, { entry: p.entry, lsize: p.file.size, lmtime: p.file.mtime });
        for (const path of deletes) st.synced.delete(path);
        res.pushed += prepared.length;
        res.deletedRemote += deletes.length;
        res.commits++;
        await this.committed(c.seq, hash);
        return contended;
      }
      // Lost the race for this sequence number. Changes to files the winner did not touch are
      // still valid and go into the next number, unless they use chunks the new table no longer
      // has (see `reusable`); the rest go back through planning.
      contended = true;
      const touched = await this.fetchRemote();
      this.dedup = this.reusable(st);
      prepared = prepared.filter((p) => !touched.has(p.file.key) && this.rebase(p.entry));
      deletes = deletes.filter((path) => !touched.has(path));
    }
    return contended;
  }

  /** Writes the snapshot and digest that are due after commit `seq`, and saves the state. */
  private async committed(seq: number, hash: string): Promise<void> {
    const { repo, st } = await this.open();
    if (seq % this.cfg.snapshotEvery === 0) {
      await repo.writeSnapshot(seq, st.remote, hash);
      await this.writeDigest(seq);
    }
    this.unsaved = true;
    await this.save();
  }

  /** Best effort: history works without a digest, only slower. */
  private async writeDigest(seq: number): Promise<void> {
    const { repo } = await this.open();
    const n = this.cfg.snapshotEvery;
    try {
      const commits: Commit[] = new Array(n);
      await pool(commits, this.cfg.concurrency, async (_, i) => {
        const c = await repo.readCommit(seq - n + 1 + i);
        if (!c) throw new Error('missing commit');
        commits[i] = c;
      });
      await repo.writeDigest(seq, commits);
    } catch (e) {
      this.log(`Could not write the history index for commit ${seq}: ${errorText(e)}`);
    }
  }

  /**
   * The safe answer to a paused mass delete: every file present on only one side is copied back to
   * the other on the next sync, instead of being deleted. Returns how many files that covers.
   */
  keepAllFiles(): Promise<number> {
    return this.exclusive(async () => {
      const { st } = await this.open();
      await this.fetchRemote();
      const run: Run = { force: false, allow: new Set(), known: { tooLarge: new Set(), paths: new Map() }, unsettled: new Set() };
      const { local, tooLarge } = await this.scan(run);
      let kept = 0;
      for (const key of [...st.synced.keys()]) {
        if (this.excluded(key) || tooLarge.has(key) || local.has(key) === st.remote.has(key)) continue;
        st.synced.delete(key);
        kept++;
      }
      // Files present on one side only are now new to the next sync, which must see them all.
      this.known = undefined;
      this.unsaved = true;
      await this.save();
      return kept;
    });
  }

  /**
   * True when the remote has changes this device has not synced: another device committed since, or
   * commits were read that no sync has finished with (by `view`, `history`, a cleanup, or a sync that
   * failed). One tiny request, no local scan, and no waiting for a sync in progress, which may already be
   * bringing the changes in.
   */
  async remoteChanged(): Promise<boolean> {
    const { repo, st } = await this.open();
    if (this.unplanned && !this.syncing) return true;
    return repo.hasCommit(st.lastSeq + 1);
  }

  /** Re-encrypts only the key header. Other devices keep working until restarted, then need the new passphrase. */
  changePassphrase(newPassphrase: string): Promise<void> {
    return this.exclusive(async () => {
      const { repo } = await this.open();
      await repo.changePassphrase(this.o.passphrase, newPassphrase);
      this.o.passphrase = newPassphrase;
    });
  }

  /** Opens the repo and brings the remote file table up to date, for features that only read. Waits for a sync in progress. */
  view(): Promise<RepoView> {
    return this.exclusive(() => this.refresh());
  }

  private async refresh(): Promise<RepoView> {
    const { repo, st } = await this.open();
    await this.fetchRemote();
    return { repo, st, cfg: this.cfg, now: this.now() };
  }

  /** Checks the remote end to end, without changing it or this device's state. Runs alongside syncs. */
  async verify(opts: VerifyOptions = {}): Promise<VerifyReport> {
    const { repo, st } = await this.open();
    return verifyRepo(repo, {
      ...opts, concurrency: this.cfg.concurrency, rangeGapBytes: this.cfg.rangeGapBytes, seen: { seq: st.lastSeq, head: st.head },
    });
  }

  /**
   * Every kept version of one file, newest first: those current at a kept moment, and the current one.
   * Waits for a sync in progress only to bring the table up to date, not while it reads the log.
   */
  async history(path: string): Promise<Version[]> {
    const { repo, lastSeq, now } = await this.exclusive(async () => {
      const v = await this.refresh();
      return { repo: v.repo, lastSeq: v.st.lastSeq, now: v.now };
    });
    return listVersions(repo, lastSeq, path, this.cfg, now);
  }

  /**
   * A version's content. Each chunk is read where the current files keep it, if they use it, since
   * cleanup may have moved it there: the place recorded with an old version, like a merge base saved
   * before the move, stays readable only while some kept version still records it. Runs alongside syncs.
   */
  async readVersion(entry: Entry): Promise<Uint8Array> {
    const { st } = await this.open();
    const here = this.placed(st);
    const chunks = entry.chunks.map((c) => here.get(c.id) ?? c);
    const out = new Uint8Array(entry.size);
    const at = new Map<string, number[]>();
    let pos = 0;
    for (const c of chunks) {
      at.set(c.id, [...(at.get(c.id) ?? []), pos]);
      pos += c.size;
    }
    await this.fetchChunks(chunks, (ref, plain) => {
      for (const p of at.get(ref.id)!) out.set(plain, p);
    });
    return out;
  }

  private placedFor?: { seq: number; remote: Map<string, Entry>; refs: Map<string, ChunkRef> };

  /** Where the current files keep each chunk, by id. */
  private placed(st: LocalState): Map<string, ChunkRef> {
    const p = this.placedFor;
    if (p && p.seq === st.lastSeq && p.remote === st.remote) return p.refs;
    const refs = new Map<string, ChunkRef>();
    for (const e of st.remote.values()) for (const c of e.chunks) refs.set(c.id, c);
    this.placedFor = { seq: st.lastSeq, remote: st.remote, refs };
    return refs;
  }

  /**
   * Deletes stored data that no kept version needs, then copies the current data of small or mostly
   * dead packs into fuller ones, at most `compactMaxBytes` a run. Every version keeps reading its data
   * where it was recorded, so the packs it came from stay until no kept moment reads them: no reader,
   * older plugin versions included, has to know about the move.
   */
  gc(): Promise<GcResult> {
    return this.exclusive(async () => {
      const { repo, st, cfg, now } = await this.refresh();
      const { result, packs } = await collectGarbage(repo, st, cfg, now);
      const out: GcResult = { ...result, packsCombined: 0, packsWritten: 0, bytesMoved: 0, bytesFreedLater: 0 };
      const plan = planCompaction(packs, st.remote, cfg, now);
      if (!plan) return out;
      const moved = await copyChunks(repo, plan, cfg);
      if (!moved.size || !(await this.relocate(moved))) return out;
      const used = new Set<string>();
      for (const e of st.remote.values()) for (const c of e.chunks) used.add(c.pack);
      const written = new Set<string>();
      for (const ref of moved.values()) {
        if (!used.has(ref.pack) || written.has(ref.pack)) continue;
        written.add(ref.pack);
        out.packsWritten++;
      }
      for (const p of plan.packs) {
        if (used.has(p.id)) continue;
        out.packsCombined++;
        out.bytesFreedLater += p.size;
      }
      for (const c of plan.chunks) if (used.has(moved.get(placeKey(c))?.pack ?? '')) out.bytesMoved += c.len;
      return out;
    });
  }

  /**
   * Commits copied chunks' new places, marked as a move. Against whatever table is current when the
   * commit goes in: after losing a race it looks again, and only rewrites references that still point
   * at a place it copied from. False when nothing was committed; the copies are then left to cleanup.
   */
  private async relocate(moved: Map<string, ChunkRef>): Promise<boolean> {
    const { repo, st } = await this.open();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const changes: Change[] = [];
      for (const [path, e] of st.remote) {
        let hit = false;
        const chunks = e.chunks.map((c) => {
          const to = moved.get(placeKey(c));
          if (!to || to.id !== c.id) return c;
          hit = true;
          return to;
        });
        if (hit) changes.push({ path, entry: { size: e.size, mtime: e.mtime, chunks } });
      }
      if (!changes.length) return false;
      const seq = st.lastSeq + 1;
      const hash = await repo.writeCommit({ seq, device: this.cfg.deviceName, time: this.now(), changes, prev: st.head, moved: true });
      if (hash) {
        st.apply({ seq, device: this.cfg.deviceName, time: 0, changes, hash, moved: true });
        for (const { path, entry } of changes) {
          const s = st.synced.get(path);
          if (s && sameContent(s.entry, entry!)) s.entry = entry!;
        }
        await this.committed(seq, hash);
        return true;
      }
      await this.fetchRemote();
    }
    return false;
  }

  /**
   * Accepts storage as it is now, for when this device found the log cut back or replaced (`HistoryError`),
   * as after the bucket was restored from a backup. Forgets what it knew of storage and anchors on the log as
   * stored. The next sync then treats every file that differs between this device and storage as
   * changed on both sides: nothing is deleted or overwritten, differing files are merged or kept as
   * conflict copies, and identical ones are matched up.
   */
  acceptStorage(): Promise<void> {
    return this.exclusive(async () => {
      const { repo } = await this.open();
      const st = new LocalState();
      st.vaultId = repo.id;
      this.st = st;
      this.headSeen = -Infinity;
      this.known = undefined;
      this.recheck = new Set();
      await this.fetchRemote();
      this.unsaved = true;
      await this.save();
    });
  }
}
