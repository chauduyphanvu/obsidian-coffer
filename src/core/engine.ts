import { fromB64, pool, toB64 } from './bytes.ts';
import { digest } from './crypto.ts';
import { worthCompressing } from './compress.ts';
import { copyChunks, fragmented, placeKey, planCompaction } from './compact.ts';
import { compileExcludes, type SyncConfig } from './config.ts';
import { merge3, mergeCanvas, mergeJson, mergeNote } from './merge.ts';
import { Packer, packRanges } from './packer.ts';
import { conflictCopyName, ext, vaultKey } from './paths.ts';
import { nothingToDo, planChanges, type Local, type Plan } from './plan.ts';
import {
  MemberBook, RemovedError, UnverifiedError, changeOf, deleteJoin, deleteRekey, deleteSlot, isMemberId, memberSecret, newMemberId, parsePosition,
  readJoin, readRekey, serializePosition, slotExpiry, writeJoin, writeRekey, writeSlot, type Member, type MemberChange, type MemberGrant, type MemberKeys,
  type RekeyOffer, type Role,
} from './members.ts';
import { findDamage, repairReport, storeAgain, type RepairOptions, type RepairReport } from './repair.ts';
import { Repo } from './repo.ts';
import { INBOX, INBOX_OPENED, MAX_SEALED, SUGGEST_MAX_FILE, SUGGEST_MAX_TOTAL, inboxKey, openSuggestion, parseInboxKey, sealSuggestion, suggestKind, type SuggestedFile, type Suggestion } from './suggest.ts';
import { collectGarbage, listVersions, type CleanupResult } from './retention.ts';
import { LocalState } from './state.ts';
import { errorText } from './text.ts';
import { ReadOnlyError, hasChunks, readOnlyStore, sameContent, type Change, type ChunkRef, type Commit, type Entry, type FileStat, type Held, type LocalFS, type RemoteStore, type StateStore, type Version } from './types.ts';
import { affectedBy, verifyRepo, type VerifyOptions, type VerifyReport } from './verify.ts';

export type { VerifyOptions, VerifyProblem, VerifyReport } from './verify.ts';
export type { RepairOptions, RepairReport } from './repair.ts';
export { RemovedError, UnverifiedError } from './members.ts';

/** What a device of a shared folder with members holds (`members.ts`). */
export interface MemberOptions {
  /** From `createMemberShare`, `joinShare` or an owner link, kept in secret storage. */
  keys: MemberKeys;
  /**
   * Where this device keeps the newest member list it accepted. Apart from `stateStore`, because that state is reset
   * when storage is accepted as it is, and this must not be: storage that shows an older list must not win.
   */
  position: StateStore;
}

export interface EngineOptions {
  fs: LocalFS;
  store: RemoteStore;
  stateStore: StateStore;
  /** Unused for a shared folder with members, which `member` opens. */
  passphrase: string;
  config: SyncConfig;
  /** Set for a shared folder with members: then every change is signed and checked. Without it, nothing changes. */
  member?: MemberOptions;
  /**
   * Only the keys it accepts sync, asked anew at every plan: any other is left alone as an excluded one is, neither
   * sent, deleted, downloaded nor removed here, whatever it was before.
   */
  only?: (key: string) => boolean;
  /**
   * The files here are the only source of what storage holds, and nothing is ever written to or removed from `fs`.
   * Where storage differs from a file here, the file here is sent again, also over a deletion in storage; what only
   * storage has stays there; a file deleted here that storage changed since is deleted there.
   */
  sendOnly?: boolean;
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
  /**
   * Vault paths of files left in storage (`SyncResult.deferred`) to download in this sync, which then sync like any
   * other file. A path that is not such a file is ignored, and a file over the size limit stays out.
   */
  fetch?: Iterable<string>;
  /**
   * A member's device that sends suggestions (`sendSuggestion`): what it sent, as fingerprints by path (`SuggestOutcome.sent`).
   * A file here that still holds what was sent takes the version the owner's device commits for it, with no conflict
   * copy: what it held reached the owner. A file changed since is kept as any change here is.
   */
  suggested?: ReadonlyMap<string, string>;
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
  /** Files left in storage until asked for (`SyncOptions.fetch`): over `deferAboveMB`, and not on this device under any path. */
  deferred: string[];
  /** Files changed on a device that only reads, and not sent. Empty for a device that writes. */
  unsent: string[];
  /**
   * Changes other devices made that came in since the last sync that finished, oldest first: by any read of the remote,
   * this sync's or one before it. Never those a first download brings in.
   */
  arrived: Arrival[];
  errors: { path: string; message: string }[];
  commits: number;
  rounds: number;
}

/** A commit another device made, as it came in: who made it and which files it changed. */
export interface Arrival {
  seq: number;
  time: number;
  device: string;
  /** In a shared folder with members: the member who signed it, and that member's name in the list then in force. */
  signer?: string;
  name?: string;
  paths: string[];
}

/** What sending a suggestion (`SyncEngine.sendSuggestion`) did with each file it was asked to send. */
export interface SuggestOutcome {
  /** Where it was kept in storage; undefined when nothing was sent. */
  key?: string;
  /** The files sent, each with a fingerprint of the text sent, which tells later whether a file changed since. */
  sent: { path: string; sum: string }[];
  /**
   * The files not sent, and why: not a note or canvas, over the size limit for one file, not text, the same as this
   * device last synced, the same as already sent (by `sum`), gone, or past what one suggestion holds.
   */
  skipped: { path: string; why: 'kind' | 'large' | 'binary' | 'same' | 'sent' | 'gone' | 'full' }[];
}

/** A suggestion waiting in storage, as the owner's device finds it. */
export interface WaitingSuggestion {
  key: string;
  /** Who it names and when it was sent, from its key; undefined for a key that names nobody. */
  member?: string;
  time?: number;
  /** That member's name, while it is on the member list. */
  name?: string;
  /** Opened with the secret of the member it names, who is on the member list now; undefined when it could not be. */
  suggestion?: Suggestion;
}

/** The suggestions the owner's device opened, and how many more wait behind them. */
export interface WaitingSuggestions {
  items: WaitingSuggestion[];
  more: number;
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

/** What this device is in a shared folder with members. */
export interface MemberStanding {
  /** Its member's role; undefined once removed, or before any member list is known. */
  role?: Role;
  /** It may send changes: its member writes and the key on the list is this device's. */
  mayWrite: boolean;
  /** A write member whose join the owner's device has not confirmed yet: it only receives until then. */
  waiting: boolean;
  /** The owner removed its member: it no longer syncs. */
  removed: boolean;
  /** The owner's name, as members see it. */
  owner: string;
}

/**
 * One member as the owner's device sees it. `waiting`: a write member's invite still opens and no device has used it; a
 * read member's invite still opens (read members never report back, so some may have joined). `confirming`: a device
 * joined and waits for the owner's device. `joined`: the owner, or a write member whose device is confirmed.
 * `expired`: the invite no longer opens (devices of a read member that joined before keep receiving).
 */
export interface MemberStatus {
  id: string;
  name: string;
  role: Role;
  state: 'joined' | 'waiting' | 'confirming' | 'expired';
  /** When the invite stops opening, if it does. */
  expires?: number;
  /** When this member's newest change this device has seen was made. */
  lastChange?: number;
  /** This device's own member. */
  self: boolean;
  /** A read member made for a follow link. */
  follow?: true;
  /** A read member invited to send suggestions too. */
  suggest?: true;
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
/** Arrivals kept for the next sync to report, at most. */
const MAX_ARRIVALS = 1000;
/** Snapshots a member share's new device tries, newest first, before it reads the log from its start. */
const SNAPSHOT_TRIES = 4;
/** How often the owner's devices look for joins and expired invites, and other writing devices for expired invites. */
const OWNER_CHORES_EVERY = 60_000;
const CHORES_EVERY = 3_600_000;
const ORPHAN_SLOT_AGE = 3_600_000;
/** For reads checked otherwise: in order (`Repo.checkInOrder`), or only by their digest. */
const UNCHECKED = { unchecked: true };
const PULL_BATCH = 32 << 20;
const MAX_RANGE = 8 << 20;
const MOVE_CACHE = 64 << 20;
const OPTIMISTIC_BYTES = 256 << 10;
const OPEN_PARALLEL = 4;
const HEAD_CHECK_EVERY = 3_600_000;
/** More paths than this to look at, and asking for each costs more than listing the vault. */
const MAX_LOOKED_UP = 256;

const contentKey = (e: Entry) => e.chunks.map((c) => c.id).join(',');
/** An object directly in `inbox/`: what the owner's device lists and may delete there, whatever it holds. */
const inInbox = (key: string) => key.startsWith(INBOX) && !/[/\\]/.test(key.slice(INBOX.length)) && !['', '.', '..'].includes(key.slice(INBOX.length));

/** The file still has the size and time the scan saw, or is still absent. */
/** What `st` holds, as a listing is given it (`LocalFS.list`): synced files with their size and time here, files only storage has with theirs there. */
function heldIn(st: LocalState, repo?: Repo): Held {
  return {
    get: (key) => {
      const s = st.synced.get(key);
      if (s) return { size: s.lsize, mtime: s.lmtime };
      const r = st.remote.get(key);
      return r && { size: r.size, mtime: r.mtime };
    },
    *keys() {
      yield* st.synced.keys();
      for (const key of st.remote.keys()) if (!st.synced.has(key)) yield key;
    },
    ...(repo && {
      content: {
        of: (key: string) => {
          const e = st.synced.get(key)?.entry ?? st.remote.get(key);
          return e && contentKey(e);
        },
        id: async (data: Uint8Array) => (await repo.split(data)).ids.join(','),
      },
    }),
  };
}

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
  /** The files to download although they are deferred, by key. */
  fetch: Set<string>;
  /** The paths the caller says may have changed, by key, with their names on disk. Undefined: list the vault. */
  hint?: Map<string, string>;
  known: Known;
  /** Paths the next sync must look at although nothing may name them: changed while this one worked on them, or written by it and not yet synced. */
  unsettled: Set<string>;
  /** See `SyncOptions.suggested`, by key. */
  suggested?: Map<string, string>;
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
  /** A shared folder with members: its checks and signatures. */
  private book?: MemberBook;
  /** Member shares: storage holds a change no member who may write made, so syncing stops until that changes. */
  private stuck = false;
  /** When this device last looked for joins and expired invites. */
  private choresDone = -Infinity;
  /** The state for which storage was asked whether it still holds the member change this device accepted. */
  private floorAskedFor?: LocalState;
  /**
   * Member shares: a snapshot taken into `st` before the list in force now was known, whose signer is checked against
   * that list once the commits after it are in (`MemberBook.checkSnapshot`), with what `st` held before it. Until then
   * `st` is not saved.
   */
  private adopted?: { st: LocalState; seq: number; signer: string; prior: Pick<LocalState, 'remote' | 'lastSeq' | 'head' | 'members' | 'confirmed' | 'lastBy'> };
  /** A write member's device waiting to be confirmed has made sure its join is in storage (`publishJoin`). */
  private joinSent = false;
  /** Commits of other devices read since the last sync that finished: `SyncResult.arrived`. */
  private arrived: Arrival[] = [];

  constructor(options: EngineOptions) {
    this.o = options;
    this.cfg = options.config;
    const excluded = compileExcludes(this.cfg.exclude);
    const only = options.only;
    this.excluded = only ? (key) => excluded(key) || !only(key) : excluded;
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
    const repo = this.repo!;
    const st = this.st!;
    await this.askFloor(repo, st);
    return { repo, st };
  }

  /**
   * A member share whose state is behind the member change this device accepted, as after a restart when the last sync
   * brought in only member changes (which save the list at once, not the state), or after accepting storage: whether
   * storage still holds that change says whether older lists may grant more than it does (`MemberBook.floorGone`).
   * Asked once for each state, before anything reads the log by it: until then every older list is capped, and a
   * removed member's own earlier commits read as not allowed.
   */
  private async askFloor(repo: Repo, st: LocalState): Promise<void> {
    const book = this.book;
    if (!book || st.lastSeq >= book.floor.seq || this.floorAskedFor === st) return;
    book.floorGone = (await repo.storedHash(book.floor.seq)) !== book.floor.hash;
    this.floorAskedFor = st;
  }

  private async load(): Promise<void> {
    if (!this.repo) {
      const { readOnly, kdfIterations, chunk } = this.cfg;
      if (this.o.member) this.repo = await this.openMember();
      else {
        // A device that only reads never creates the vault: the key it would make is not worth deriving.
        this.repo = await Repo.open(readOnly ? readOnlyStore(this.o.store) : this.o.store, this.o.passphrase, { kdfIterations: readOnly ? 1 : kdfIterations, chunk }).catch((e: unknown) => {
          // Only creating vault.json writes while opening.
          throw e instanceof ReadOnlyError ? new Error('Storage holds no synced vault yet, and this device only reads from it') : e;
        });
      }
    }
    if (!this.st) {
      const st = LocalState.parse(await this.o.stateStore.load());
      if (st.vaultId !== this.repo.id) {
        // A different remote vault than last time: nothing recorded about the old one applies.
        if (st.vaultId) this.log('Remote vault changed; starting from a clean local state');
        this.st = new LocalState();
        this.st.vaultId = this.repo.id;
      } else this.st = st;
      this.book?.accept(this.st.members.at(-1));
    }
  }

  /**
   * A member share opens with the master key this device holds, never creates anything, and starts from the member
   * list it accepted last, or on its first open from the one its link was made at.
   */
  private async openMember(): Promise<Repo> {
    const { keys, position } = this.o.member!;
    const store = this.cfg.readOnly ? readOnlyStore(this.o.store) : this.o.store;
    const repo = await Repo.openMember(store, { repo: keys.repo, master: fromB64(keys.master) });
    const book = (this.book = new MemberBook(repo.id, keys, parsePosition(await position.load(), repo.id)));
    if (!book.floor.gen && keys.since) {
      const c = await repo.readCommit(keys.since, UNCHECKED);
      if (!c) throw new Error(`Storage is missing commit ${keys.since}, the member list this device was invited with`);
      await this.accepted(await book.checkChange(c));
    }
    repo.useMembers(book, () => ({ changes: this.st?.members ?? [], through: this.st?.lastSeq ?? 0 }));
    return repo;
  }

  /** Saves the state if it changed since it was last saved, and a member list newer than the one saved. */
  private async save(): Promise<void> {
    if (this.book?.dirty) await this.savePosition();
    if (!this.unsaved || this.adopted?.st === this.st) return;
    await this.o.stateStore.save(this.st!.serialize());
    this.unsaved = false;
  }

  /**
   * Takes `ch` as the newest member list this device accepted, if it is newer, and saves that at once, before the state
   * it belongs to: a sync that brings in nothing else saves no state, and a restart must not forget a removal.
   */
  private async accepted(ch: MemberChange | undefined): Promise<void> {
    this.book!.accept(ch);
    if (this.book!.dirty) await this.savePosition();
  }

  private async savePosition(): Promise<void> {
    const book = this.book!;
    book.dirty = false;
    try {
      await this.o.member!.position.save(serializePosition(book.repo, book.floor));
    } catch (e) {
      book.dirty = true;
      throw e;
    }
  }

  /** True when this device sends nothing: it is set to only receive, or its member may not write to a member share. */
  private readOnly(): boolean {
    return this.cfg.readOnly || (!!this.book && !this.book.mayWrite(this.st?.members ?? []));
  }

  /**
   * Brings the cached remote file table up to the newest commit. Returns the paths that changed. Each is
   * put in `recheck` as it enters the table, so a request that fails later loses none of them.
   */
  private async fetchRemote(): Promise<Set<string>> {
    const { repo, st } = await this.open();
    const book = this.book;
    // A first download brings in what others made long ago, not news.
    const fresh = st.lastSeq > 0;
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
        // In a member share, a commit no member who may write made is garbage the owner can remove, wherever it points.
        await repo.checkInOrder(c);
        const message = `Remote commit ${c.seq} does not follow the commit before it as this device saw it: the log was tampered with or forked`;
        // Only on this path: storage's own commit before it says whether storage holds another one than this
        // device saw, or the link between two stored commits is broken.
        throw (await repo.readCommit(c.seq - 1, UNCHECKED))?.hash === c.prev ? new HistoryError(message) : new Error(message);
      }
      // Nothing from a commit that does not verify is applied, nor anything after it.
      await repo.checkInOrder(c);
      // A move changes no content, so work prepared against the file before it is still valid. It
      // moves this device's merge base too, whose old place goes once no kept version records it.
      for (const { path, entry } of c.changes) {
        const was = st.remote.get(path);
        if (!c.moved || !entry || !was || !sameContent(was, entry)) touch(path);
        const s = c.moved && entry && st.synced.get(path);
        if (s && sameContent(s.entry, entry)) s.entry = entry;
      }
      if (fresh && !c.moved && c.changes.length) this.arrive(c, st);
      st.apply(c);
      if (c.members) await this.accepted(changeOf(c));
      this.headSeen = this.now();
    };
    const loadSnapshot = async () => {
      let found: { seq: number; files: Map<string, Entry>; head?: string; changes?: MemberChange[]; signer?: string } | undefined;
      if (this.book) found = await this.memberSnapshot(repo, st.lastSeq);
      else {
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
        found = { seq: latest.seq, files: snap.files, head: at.hash };
      }
      if (!found) return;
      if (found.signer) {
        const prior = { remote: st.remote, lastSeq: st.lastSeq, head: st.head, members: st.members, confirmed: new Set(st.confirmed), lastBy: new Map(st.lastBy) };
        this.adopted = { st, seq: found.seq, signer: found.signer, prior };
      }
      for (const p of st.remote.keys()) touch(p);
      for (const p of found.files.keys()) touch(p);
      st.remote = found.files;
      st.lastSeq = found.seq;
      st.head = found.head;
      if (found.changes) {
        st.members = found.changes;
        await this.accepted(found.changes.at(-1));
      }
      // Which deletions in the skipped commits were confirmed is not known: they all count.
      st.confirmed.clear();
      this.headSeen = this.now();
    };
    /**
     * Once the commits storage holds are in (as far as a gap, past which lies garbage), the signer of a snapshot taken
     * meanwhile is checked against the newest list. False when it is not on it: `st` is then as before the snapshot.
     */
    const settle = (complete: boolean): boolean => {
      const a = this.adopted;
      if (!book || a?.st !== st) return true;
      if (book.writesNow(st.members, a.signer)) {
        if (complete) this.adopted = undefined;
        return true;
      }
      // Removed since: the snapshot may have been written after that, with any files in it.
      this.log(`Skipped snapshot ${a.seq}: it was written by a member who may no longer write`);
      this.adopted = undefined;
      Object.assign(st, a.prior);
      repo.forged.add(a.seq);
      return false;
    };
    const again = async () => {
      for (const p of await this.fetchRemote()) touched.add(p);
      return touched;
    };

    if (st.lastSeq === 0) await loadSnapshot();
    else {
      // The common cases cost one or two cheap GETs: nothing new, or exactly one new commit.
      // Two probes at once: "nothing new" and "exactly one new commit" both finish in a single round trip.
      // "Nothing new" cannot tell a quiet log from one cut back under this device, so at start and then
      // hourly a third read in the same round trip checks that this device's newest commit is still there.
      const checkHead = this.headDue(st);
      const [first, second, head] = await Promise.all([
        repo.readCommit(st.lastSeq + 1, UNCHECKED),
        repo.readCommit(st.lastSeq + 2, UNCHECKED),
        checkHead ? repo.readCommit(st.lastSeq, UNCHECKED) : undefined,
      ]);
      if (head !== undefined) this.checkHead(st, head, first ?? second);
      if (!first) return settle(true) ? touched : again();
      await add(first);
      if (!second) return settle(true) ? touched : again();
      await add(second);
    }
    let seqs = await repo.commitSeqsAfter(st.lastSeq);
    if (seqs.length > this.cfg.snapshotEvery) {
      await loadSnapshot();
      seqs = seqs.filter((s) => s > st.lastSeq);
    }
    // In a member share, what lies past a gap is garbage the owner can remove (`removeUnverifiable`): it is not even
    // read, and the commits before it are taken.
    const gap = this.book ? seqs.findIndex((s, i) => s !== st.lastSeq + 1 + i) : -1;
    const past = gap < 0 ? undefined : seqs[gap];
    if (gap >= 0) seqs = seqs.slice(0, gap);
    const commits: Commit[] = new Array<Commit>(seqs.length);
    await pool(seqs, this.cfg.concurrency, async (seq, i) => {
      const c = await repo.readCommit(seq, UNCHECKED);
      if (!c) throw new Error(`Commit ${seq} is listed but cannot be read`);
      commits[i] = c;
    });
    for (const c of commits) {
      if (c.seq !== st.lastSeq + 1) throw new Error(`Remote log has a gap before commit ${c.seq}`);
      await add(c);
    }
    if (!settle(past === undefined)) return again();
    if (past !== undefined) throw new UnverifiedError(past, `there is a gap before it, after commit ${st.lastSeq}`);
    this.headSeen = this.now();
    return touched;
  }

  private arrive(c: Commit, st: LocalState): void {
    const name = c.signer ? MemberBook.before(st.members, c.seq)?.members.find((m) => m.id === c.signer)?.name : undefined;
    this.arrived.push({ seq: c.seq, time: c.time, device: c.device, ...(c.signer && { signer: c.signer }), ...(name !== undefined && { name }), paths: c.changes.map((ch) => ch.path) });
    if (this.arrived.length > MAX_ARRIVALS) this.arrived.splice(0, this.arrived.length - MAX_ARRIVALS);
  }

  /** The arrivals since the last sync that finished, each commit once: one taken back and read again (`settle`) counts once. */
  private takeArrived(): Arrival[] {
    const bySeq = new Map(this.arrived.map((a) => [a.seq, a]));
    this.arrived = [];
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * A member share's newest snapshot after `after` that verifies, with the member changes up to it: tried newest first,
   * since storage may hold ones that do not (squatted far ahead, or written by someone who may not write). Undefined
   * when none does, and the log is then read from its start. A snapshot is taken only when it was signed by a member
   * who may write under the list in force at its commit, names that list, and its commit verifies and names it too;
   * whether its signer still may write is known once the commits after it are in (`fetchRemote`). Only a snapshot found
   * not to verify is remembered as forged, not one passed over because a request failed.
   */
  private async memberSnapshot(repo: Repo, after: number): Promise<{ seq: number; files: Map<string, Entry>; head: string; changes: MemberChange[]; signer: string } | undefined> {
    const book = this.book!;
    const snaps = (await repo.snapshots()).filter((s) => s.seq > after);
    for (const { seq } of snaps.slice(-SNAPSHOT_TRIES).reverse()) {
      const skip = (e: unknown, forged: boolean) => {
        if (forged) repo.forged.add(seq);
        this.log(`Skipped snapshot ${seq}: ${errorText(e)}`);
      };
      let snap, at;
      try {
        [snap, at] = await Promise.all([repo.readSnapshotWithHead(seq, UNCHECKED), repo.readCommit(seq, UNCHECKED)]);
      } catch (e) {
        skip(e, false);
        continue;
      }
      // No commit: a snapshot squatted past the log's end.
      if (!snap || !at) continue;
      const listSeq = snap.listSeq ?? 0;
      if (!snap.head || snap.head !== at.hash) {
        skip(new Error('it was taken at another commit than storage holds'), true);
        continue;
      }
      if (at.members ? listSeq !== seq : at.listSeq !== listSeq) {
        skip(new Error('it names another member list than its commit'), true);
        continue;
      }
      let chain: (Commit | null)[];
      try {
        const head = at.members ? at : await repo.readCommit(listSeq, UNCHECKED);
        if (!head?.members) throw new Error(`commit ${listSeq} is not a member change`);
        chain = [...(await Promise.all(head.members.earlier.map((s) => repo.readCommit(s, UNCHECKED)))), head];
      } catch (e) {
        skip(e, false);
        continue;
      }
      if (chain.includes(null)) {
        skip(new Error('a member change it leads back to is missing'), false);
        continue;
      }
      try {
        const changes: MemberChange[] = [];
        for (const c of chain) changes.push(await book.checkChange(c!, changes));
        await book.checkCommit(at, changes, seq - 1, { cache: false });
        await book.checkSnapshot(seq, snap, changes);
        return { seq, files: snap.files, head: at.hash, changes, signer: snap.signer! };
      } catch (e) {
        skip(e, true);
      }
    }
    return undefined;
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

  private deferLimit(): number {
    return this.cfg.deferAboveMB * (1 << 20) || Infinity;
  }

  /**
   * Whether a remote file is left in storage: over the deferral limit, not asked for, and not content this device
   * already holds under another path, which a move or copy reuses. Undefined when nothing is deferred. The
   * contents held are listed on first use, once for as long as the predicate lives.
   */
  private deferral(st: LocalState, run?: Run): ((key: string, r: Entry) => boolean) | undefined {
    const limit = this.deferLimit();
    if (limit === Infinity) return undefined;
    let held: Set<string> | undefined;
    return (key, r) => {
      if (r.size <= limit || run?.fetch.has(key)) return false;
      if (!held) {
        held = new Set();
        for (const s of st.synced.values()) if (s.entry.size > limit) held.add(contentKey(s.entry));
      }
      return !held.has(contentKey(r));
    };
  }

  private async scan(run: Run, st: LocalState): Promise<LocalView> {
    const maxSize = this.maxSize();
    const local = new Map<string, Local>();
    const tooLarge = new Set<string>();
    const paths = new Map<string, string>();
    for (const f of await this.o.fs.list(heldIn(st, this.repo))) {
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
    return this.scan(run, st);
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

  /** Files in storage that this device leaves there until asked for: see `deferral`, within the size limit, and not here. */
  private deferredKeys(st: LocalState, v: LocalView, defer?: (key: string, r: Entry) => boolean): string[] {
    const maxSize = this.maxSize();
    const out: string[] = [];
    if (defer) {
      for (const [key, r] of st.remote) {
        if (r.size <= maxSize && !st.synced.has(key) && !v.local.has(key) && !v.tooLarge.has(key) && !this.excluded(key) && defer(key, r)) out.push(key);
      }
    }
    return out.sort();
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
      conflictCopies: [], skipped: 0, tooLarge: [], deferred: [], unsent: [], arrived: [], errors: [], commits: 0, rounds: 0,
    };
    const { st } = await this.open();
    const allow = new Set([...(opts.allowDeletes ?? [])].map(vaultKey));
    const known = this.known;
    const fetch = new Set([...(opts.fetch ?? [])].map(vaultKey));
    const suggested = opts.suggested && new Map([...opts.suggested].map(([path, sum]) => [vaultKey(path), sum]));
    const run: Run = { force: !!opts.force, allow, fetch, known: known ?? { tooLarge: new Set(), paths: new Map() }, unsettled: new Set(), suggested };
    if (opts.changed && known) {
      run.hint = new Map();
      for (const p of opts.changed) run.hint.set(vaultKey(p), p);
      for (const k of [...allow, ...fetch]) if (!run.hint.has(k)) run.hint.set(k, known.paths.get(k) ?? k);
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
      res.arrived = this.takeArrived();
      if (!again) {
        this.known = run.known;
        this.recheck = new Set([...res.errors.map((e) => e.path), ...run.unsettled]);
        this.unplanned = false;
      }
      this.stuck = false;
      if (this.book) {
        await this.sendJoin();
        await this.chores();
      }
    } catch (e) {
      if (e instanceof UnverifiedError) this.stuck = true;
      throw e;
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
    if (this.book?.removed(st.members)) throw new RemovedError();
    const maxSize = this.maxSize();
    const defer = this.deferral(st, run);
    let v = await this.look(run, st);
    let p = planChanges(v.local, st, this.excluded, maxSize, v.tooLarge, v.keys, defer);
    // A small local edit is committed without first asking whether the remote moved: the commit
    // itself fails if it did, and the next pass sorts it out. Saves a round trip on the common case.
    // The commit also checks that storage still holds the commit before it (`put`), so it need not wait for the hourly check.
    const optimistic =
      first && st.lastSeq > 0 && st.head !== undefined && this.adopted?.st !== st &&
      p.pushes.length + p.pushDeletes.length > 0 && !p.pulls.length && !p.pullDeletes.length && !p.conflicts.length &&
      p.pushes.reduce((n, f) => n + f.size, 0) <= OPTIMISTIC_BYTES && !this.readOnly();
    if (!optimistic && (await this.fetchRemote()).size) {
      if (v.keys) v = await this.look(run, st, v);
      p = planChanges(v.local, st, this.excluded, maxSize, v.tooLarge, v.keys, defer);
    }
    if (this.book?.removed(st.members)) throw new RemovedError();
    res.tooLarge = this.tooLarge(st, v.tooLarge);
    res.deferred = this.deferredKeys(st, v, defer);

    if (nothingToDo(p)) return false;
    if (this.o.sendOnly) this.sendAgain(p, v.local, st, run);
    this.checkDeletes(p, st, run);
    const unsent = await this.keepLocal(p, run, res);

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
    unsent.push(...(await this.keepLocal(p, run, res)));
    if (unsent.length) {
      res.unsent = [...new Set([...res.unsent, ...unsent])].sort();
      for (const key of unsent) run.unsettled.add(key);
    }

    const commitsBefore = res.commits;
    let again = false;
    if (p.pushes.length || p.pushDeletes.length) again = await this.push(p.pushes, p.pushDeletes, run, res);
    await this.save();
    // An optimistic pass that ended up committing nothing has not looked at the remote at all yet.
    return again || (optimistic && res.commits === commitsBefore);
  }

  /**
   * A place that only sends (`EngineOptions.sendOnly`) writes and removes nothing here. What storage changed or deleted
   * is sent again from here; a file deleted here is deleted there, however storage changed it; and a file this device
   * never synced that only storage has stays there, unless its deletion was confirmed (`allowDeletes`).
   */
  private sendAgain(p: Plan, local: Map<string, Local>, st: LocalState, run: Run): void {
    for (const key of [...p.pulls, ...p.pullDeletes]) {
      const l = local.get(key);
      if (l) {
        // Unchanged since the version both last agreed on, which storage no longer has: sent as new.
        st.synced.delete(key);
        this.unsaved = true;
        p.pushes.push(l);
      } else if (st.synced.has(key) || run.allow.has(key)) p.pushDeletes.push(key);
    }
    p.pulls = [];
    p.pullDeletes = [];
  }

  /** Moves delete and re-create, so net shrinkage is what counts. See `deleteLimit`. */
  private checkDeletes(p: Plan, st: LocalState, run: Run): void {
    if (run.force) return;
    const limit = deleteLimit(st.synced.size, this.cfg);
    const here = p.pullDeletes.filter((k) => !st.confirmed.has(k)).length;
    // A device that only reads never deletes in storage: what it deleted comes back (see `keepLocal`).
    const there = this.readOnly() ? 0 : p.pushDeletes.filter((k) => !run.allow.has(k)).length;
    if (here - p.pulls.length > limit || there - p.pushes.length > limit) throw new SafetyError(here, there);
  }

  /**
   * What a device that only reads does with what the plan would send: nothing is sent, the files stay as they are,
   * and a file deleted here comes back from storage, so that it is not left missing files every other device has.
   * A file touched without changing its content, as by a tool that syncs files, is not a change. Empties the plan's
   * pushes and returns the files left unsent; for any other device, does nothing.
   */
  private async keepLocal(p: Plan, run: Run, res: SyncResult): Promise<string[]> {
    if (!this.readOnly()) return [];
    const { repo, st } = await this.open();
    const fs = this.o.fs;
    const unsent: string[] = [];
    await pool(p.pushes, this.cfg.concurrency, async (f) => {
      try {
        const base = st.synced.get(f.key)?.entry;
        if (base && st.remote.get(f.key)) {
          const data = await fs.read(f.path);
          if (!unchanged(await fs.stat(f.path), f)) {
            this.skip(run, res, f.key);
            return;
          }
          if (hasChunks(base, (await repo.split(data)).ids)) {
            st.synced.set(f.key, { entry: base, lsize: f.size, lmtime: f.mtime });
            this.unsaved = true;
            return;
          }
        }
      } catch (e) {
        recordError(res, f.key, e);
      }
      unsent.push(f.key);
    });
    p.pulls.push(...p.pushDeletes);
    p.pushes = [];
    p.pushDeletes = [];
    return unsent;
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
    // Sent to the owner as a suggestion and unchanged since: the owner's version stands for it (`SyncOptions.suggested`).
    const sent = run.suggested?.get(key);
    if (sent && sent === (await digest(mine))) {
      await this.writeRemote(pass, key, r, await this.readVersion(r));
      return;
    }
    // Only this side's version is kept, sent as new: see `sendAgain`.
    if (this.o.sendOnly) {
      st.synced.delete(key);
      this.unsaved = true;
      return l;
    }

    // A copy in the settings folder would never be read or shown, so settings are always combined.
    const settings = key.startsWith(`${this.cfg.configDir}/`);
    const merged = settings
      ? await this.mergeSettings(key, base, mine, r)
      : this.cfg.conflictStrategy === 'merge' && base && this.cfg.mergeExtensions.includes(ext(key))
        ? await this.tryMerge(key, base, mine, r)
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
      // A device that only reads keeps its own file, listed as unsent: a copy here would never be seen.
      if (this.readOnly()) return l;
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
    if (ext(key) !== 'json') return base ? this.tryMerge(key, base, mine, remote) : null;
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

  private async tryMerge(key: string, base: Entry, mine: Uint8Array, remote: Entry): Promise<Uint8Array | null> {
    try {
      const text = (data: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(data);
      const [theirBase, theirs] = await Promise.all([this.readVersion(base), this.readVersion(remote)]);
      const kind = ext(key);
      const merge = kind === 'canvas' ? mergeCanvas : kind === 'md' || kind === 'markdown' ? mergeNote : merge3;
      const merged = merge(text(theirBase), text(mine), text(theirs));
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
          const plain = await repo.openChunk(ref.id, data.subarray(at, at + ref.len));
          // Whoever holds the vault key can seal other content under a chunk's id: only its content proves it.
          if ((await repo.chunkId(plain)) !== ref.id) throw new Error(`Remote chunk ${ref.id} in pack ${range.pack} does not match its id: corrupted or tampered with`);
          sink(ref, plain);
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
      const prepared: (Prepared | undefined)[] = new Array<Prepared | undefined>(batch.length);
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

  /**
   * Writes a commit and, in the same round trip, reads the one before it: a log cut back or replaced under this
   * device would take this commit all the same. Then it is taken back at once, since left beyond a gap or on a
   * broken link it would stop every device that reads the log, and `acceptStorage` would find it again. Only a read
   * that finds the commit missing or different counts. Resolves to the commit's digest, or null when another
   * device took its number.
   */
  private async put(c: Commit): Promise<string | null> {
    const { repo, st } = await this.open();
    const [hash, before] = await Promise.all([
      repo.writeCommit(c),
      c.seq > 1 ? repo.readCommit(c.seq - 1, UNCHECKED).catch(() => undefined) : undefined,
    ]);
    if (!hash || before === undefined) return hash;
    try {
      this.checkHead(st, before, null);
    } catch (e) {
      await repo.retractCommit(c.seq, hash).catch((x) => this.log(`Could not take back commit ${c.seq}: ${errorText(x)}`));
      throw e;
    }
    return hash;
  }

  /** Returns true when another device committed first and some of these changes must be re-planned. */
  private async commit(prepared: Prepared[], deletes: string[], res: SyncResult, confirmed = false): Promise<boolean> {
    const { repo, st } = await this.open();
    let contended = false;
    while (prepared.length || deletes.length) {
      if (this.book && !this.book.mayWrite(st.members)) {
        if (this.book.removed(st.members)) throw new RemovedError();
        // No longer allowed to write, as learned from the commit that won: the next pass keeps these changes here.
        return true;
      }
      const changes: Change[] = [
        ...prepared.map((p) => ({ path: p.file.key, entry: p.entry })),
        ...deletes.map((path) => ({ path, entry: null })),
      ];
      const c: Commit = { seq: st.lastSeq + 1, device: this.cfg.deviceName, time: this.now(), changes, prev: st.head, ...(confirmed && { confirmed }) };
      const hash = await this.put(c);
      if (hash) {
        st.apply({ ...c, hash });
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
      const commits: Commit[] = new Array<Commit>(n);
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
      const run: Run = { force: false, allow: new Set(), fetch: new Set(), known: { tooLarge: new Set(), paths: new Map() }, unsettled: new Set() };
      const { local, tooLarge } = await this.scan(run, st);
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
   * Files left in storage until asked for, with their sizes: those over `deferAboveMB` that this device does not
   * have, under that path or another. Pass their paths to `sync` as `fetch` to download them.
   */
  deferred(): Promise<{ path: string; size: number }[]> {
    return this.exclusive(async () => {
      const { st } = await this.refresh();
      const defer = this.deferral(st);
      const maxSize = this.maxSize();
      const out: { path: string; size: number }[] = [];
      const candidates = defer ? [...st.remote].filter(([key, r]) => r.size <= maxSize && !st.synced.has(key) && !this.excluded(key) && defer(key, r)) : [];
      await pool(candidates, this.cfg.concurrency, async ([key, r]) => {
        if (!(await this.o.fs.stat(this.known?.paths.get(key) ?? key))) out.push({ path: key, size: r.size });
      });
      return out.sort((a, b) => (a.path < b.path ? -1 : 1));
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
    // Stuck before a change no member made: asking again would only find it again. A sync still tries.
    if (this.stuck) return false;
    if (this.unplanned && !this.syncing) return true;
    return repo.hasCommit(st.lastSeq + 1);
  }

  /**
   * Re-encrypts only the key header. Other devices keep working until restarted, then need the new passphrase. A member
   * share's storage holds nothing sealed with the owner's passphrase, so there is nothing to change there: owner links
   * made from now on are sealed with the new one.
   */
  changePassphrase(newPassphrase: string): Promise<void> {
    return this.exclusive(async () => {
      const { repo } = await this.open();
      if (this.o.member) {
        this.ownerKeys();
        return;
      }
      await repo.changePassphrase(this.o.passphrase, newPassphrase, this.cfg.kdfIterations);
      this.o.passphrase = newPassphrase;
    });
  }

  /** The PBKDF2 cost the vault's passphrase is wrapped with, which a setup link made here is sealed with at least. */
  async kdfIterations(): Promise<number> {
    return (await this.open()).repo.kdfIterations;
  }

  /** What this device holds, as its last sync left it: what a listing is given (`LocalFS.list`). Asks storage nothing. */
  async held(): Promise<Held> {
    return this.st ? heldIn(this.st, this.repo) : heldIn(LocalState.parse(await this.o.stateStore.load()));
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
      ...opts, concurrency: this.cfg.concurrency, rangeGapBytes: this.cfg.rangeGapBytes, seen: { seq: st.lastSeq, head: st.head }, history: { cfg: this.cfg, now: this.now() },
    });
  }

  /**
   * Stores again, from the files on this device, the data the current files keep in packs that are missing or too
   * short (and with `deep`, chunks that cannot be read), and points them at the new places in a commit marked as a
   * move. A file this device does not have, or has under another content, is stored again as far as its chunks
   * are here: the rest is reported. Earlier versions that share chunks with a current file become readable again;
   * the others are reported. Writes nothing when this device has none of the data.
   */
  repair(opts: RepairOptions = {}): Promise<RepairReport> {
    return this.exclusive(async () => {
      const { repo, st, cfg, now } = await this.refresh();
      const found = await findDamage(repo, st.remote, cfg, opts);
      const affected = affectedBy(st.remote, found.damaged);
      const files = affected.filter((k) => !this.excluded(k)).map((k): [string, string] => [k, this.known?.paths.get(k) ?? k]);
      const { moved, chunks } = await storeAgain(repo, this.o.fs, st.remote, files, found.damaged, cfg);
      if (moved.size) await this.relocate(moved);
      return repairReport(repo, st, cfg, now, found, affected, chunks);
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

  /** True when the current files are spread over so many small packs that cleanup would save a new device many requests. */
  async compactionDue(): Promise<boolean> {
    const { st } = await this.open();
    return fragmented(st.remote, this.cfg);
  }

  /**
   * Deletes stored data that no kept version needs, then copies the current data of small or mostly
   * dead packs into fuller ones, at most `compactMaxBytes` a run. Every version keeps reading its data
   * where it was recorded, so the packs it came from stay until no kept moment reads them: no reader,
   * older plugin versions included, has to know about the move.
   */
  gc(): Promise<GcResult> {
    return this.exclusive(async () => {
      const none = { packsDeleted: 0, bytesFreed: 0, snapshotsDeleted: 0, packsCombined: 0, packsWritten: 0, bytesMoved: 0, bytesFreedLater: 0 };
      if (this.cfg.readOnly) return none;
      const { repo, st, cfg, now } = await this.refresh();
      if (this.readOnly()) return none;
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
    const { st } = await this.open();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (this.book && !this.book.mayWrite(st.members)) return false;
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
      const hash = await this.put({ seq, device: this.cfg.deviceName, time: this.now(), changes, prev: st.head, moved: true });
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
      this.stuck = false;
      this.arrived = [];
      // The member list this device accepted stays (`MemberOptions.position`): storage that shows an older one grants no more.
      await this.fetchRemote();
      this.unsaved = true;
      await this.save();
    });
  }

  // Shared folders with members (`MemberOptions`). Each of these throws for any other storage.

  private memberBook(): MemberBook {
    if (!this.book) throw new Error('This storage is not a shared folder with members');
    return this.book;
  }

  /** What only the owner's devices hold, or an error on any other device. */
  private ownerKeys(): { book: MemberBook; master: Uint8Array; root: Uint8Array } {
    const book = this.memberBook();
    const k = this.o.member!.keys;
    if (!book.isOwner || !k.root) throw new Error('Only the owner’s devices can do this');
    return { book, master: fromB64(k.master), root: fromB64(k.root) };
  }

  /** What this device is in its shared folder with members, as of its last sync; undefined for any other storage. */
  async memberStanding(): Promise<MemberStanding | undefined> {
    if (!this.o.member) return undefined;
    const { st } = await this.open();
    const book = this.memberBook();
    const me = book.me(st.members);
    return {
      role: me?.role,
      mayWrite: book.mayWrite(st.members),
      waiting: me?.role === 'write' && !me.pub,
      removed: book.removed(st.members),
      owner: book.current(st.members).find((m) => m.role === 'owner')?.name ?? '',
    };
  }

  /**
   * Brings the remote table up to date as far as it verifies: the owner's devices act on members and storage keys while
   * the share is stuck too, which is when cutting someone off matters most.
   */
  private async fetchVerified(): Promise<void> {
    try {
      await this.fetchRemote();
    } catch (e) {
      if (!(e instanceof UnverifiedError)) throw e;
    }
  }

  /** Every member, with storage brought up to date. Only the owner's devices see how invites stand; others see who has joined. */
  members(): Promise<MemberStatus[]> {
    return this.exclusive(async () => {
      const { repo, st } = await this.open();
      await this.fetchVerified();
      const book = this.memberBook();
      const now = this.now();
      const list = book.current(st.members);
      const slots = new Map<string, number>();
      const joins = new Set<string>();
      if (book.isOwner) {
        const [s, j] = await Promise.all([repo.objects.list('slot/'), repo.objects.list('join/')]);
        for (const o of j) joins.add(o.key.slice(5));
        const ids = s.map((o) => o.key.slice(5)).filter((id) => list.some((m) => m.id === id));
        await pool(ids, this.cfg.concurrency, async (id) => {
          const e = await slotExpiry(repo.objects, id);
          if (e !== null) slots.set(id, e);
        });
      }
      return list.map((m): MemberStatus => {
        const expires = m.expires || slots.get(m.id) || undefined;
        const opens = slots.has(m.id) && !(expires && now > expires);
        let state: MemberStatus['state'];
        if (m.role === 'owner' || (m.role === 'write' && m.pub)) state = 'joined';
        else if (!book.isOwner) state = 'waiting';
        else if (m.role === 'write' && joins.has(m.id)) state = 'confirming';
        else state = opens ? 'waiting' : 'expired';
        const last = st.lastBy.get(m.id);
        return {
          id: m.id, name: m.name, role: m.role, state, self: m.id === book.self,
          ...(expires && state !== 'joined' && { expires }), ...(last && { lastChange: last }), ...(m.follow && { follow: true as const }),
          ...(m.suggest && { suggest: true as const }),
        };
      });
    });
  }

  /**
   * Owner: adds a member and opens an invite for one device of it, which stops opening at `expires` (a time; 0 never, as
   * for a follow link). A write member's device only receives until the owner's device confirms its join. Returns the
   * member's part of the link (`MemberInvite`): add the storage keys for the role, the share's name and the folder.
   * `follow` makes a read member for a follow link (`FollowInvite`), which re-keys hand no storage keys. `suggest`
   * marks a read member who sends suggestions too, whom re-keys hand keys that may add to the inbox.
   */
  invite(o: { name: string; role: 'write' | 'read'; expires: number; follow?: boolean; suggest?: boolean }): Promise<MemberGrant> {
    return this.exclusive(async () => {
      const { repo } = await this.open();
      const { book, master, root } = this.ownerKeys();
      const name = o.name.trim();
      if (!name) throw new Error('A member needs a name');
      if (o.follow && o.role !== 'read') throw new Error('A follow link only reads');
      if (o.suggest && (o.role !== 'read' || o.follow)) throw new Error('Only a member invited to read sends suggestions');
      const id = newMemberId();
      const secret = await memberSecret(root, id);
      await writeSlot(repo.objects, repo.id, id, master, secret, o.expires);
      let since: number | undefined;
      try {
        since = await this.changeMembers((list) => [
          ...list,
          { id, name, role: o.role, ...(o.role === 'write' && o.expires ? { expires: o.expires } : {}), ...(o.follow && { follow: true as const }), ...(o.suggest && { suggest: true as const }) },
        ]);
      } catch (e) {
        await deleteSlot(repo.objects, id).catch(() => undefined);
        throw e;
      }
      return { repo: repo.id, member: id, secret: toB64(secret), role: o.role, owner: book.owner, since: since! };
    });
  }

  /** Owner: lets every device that joined with a write invite since write, and closes its invite. Returns their member ids. Syncs do this too. */
  confirmJoins(): Promise<string[]> {
    return this.exclusive(() => this.confirmHeld());
  }

  private async confirmHeld(): Promise<string[]> {
    const { repo, st } = await this.open();
    const { root } = this.ownerKeys();
    const book = this.memberBook();
    const store = repo.objects;
    // When each join was made, by storage's clock: whoever holds a leaked link can say any time it likes in the join.
    const made = new Map((await store.list('join/')).map((o) => [o.key.slice(5), o.modified]));
    const ids = [...made.keys()].filter(isMemberId);
    if (!ids.length) return [];
    await this.fetchRemote();
    const list = book.current(st.members);
    const grants = new Map<string, string>();
    for (const id of ids) {
      const m = list.find((x) => x.id === id);
      // Confirmed already, removed, or never a write member: a join replayed or left over.
      if (!m || m.role !== 'write' || m.pub) {
        await deleteJoin(store, id);
        continue;
      }
      const j = await readJoin(store, repo.id, id, await memberSecret(root, id));
      if (j === null) continue;
      if (j === 'bad' || (m.expires && made.get(id)! > m.expires)) {
        await deleteJoin(store, id);
        continue;
      }
      grants.set(id, j.pub);
    }
    if (!grants.size) return [];
    await this.changeMembers((cur) => {
      let any = false;
      const next = cur.map((m) => {
        const pub = grants.get(m.id);
        if (!pub || m.role !== 'write' || m.pub) return m;
        any = true;
        return { id: m.id, name: m.name, role: m.role, pub };
      });
      return any ? next : null;
    });
    for (const id of grants.keys()) {
      // The invite opens nothing from now on: one invite, one device.
      await deleteSlot(store, id);
      await deleteJoin(store, id);
    }
    return [...grants.keys()];
  }

  /**
   * Owner: removes a member. Its devices stop at their next sync; what it changed before stays. Its invite stops
   * opening. A member removed already whose invite, join or re-key is still in storage, as when taking those out failed
   * the first time, has them taken out again.
   */
  removeMember(id: string): Promise<void> {
    return this.exclusive(async () => {
      const { repo } = await this.open();
      this.ownerKeys();
      const seq = await this.changeMembers((list) => (list.some((m) => m.id === id && m.role !== 'owner') ? list.filter((m) => m.id !== id) : null));
      const store = repo.objects;
      if (seq === undefined) {
        const left = isMemberId(id) ? await Promise.all(['slot/', 'join/', 'rekey/'].map((p) => store.get(p + id, { start: 0, end: 1 }))) : [];
        if (!left.some(Boolean)) throw new Error('There is no such member');
      }
      await Promise.all([deleteSlot(store, id), deleteJoin(store, id), deleteRekey(store, id)]);
    });
  }

  /**
   * Owner: commits the list `edit` makes of the current one as a member change, on top of the newest commit. Undefined,
   * with nothing written, when `edit` returns null.
   */
  private async changeMembers(edit: (list: Member[]) => Member[] | null): Promise<number | undefined> {
    const { st } = await this.open();
    const { book } = this.ownerKeys();
    await this.fetchRemote();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const members = edit(book.current(st.members).map((m) => ({ ...m })));
      if (!members) return undefined;
      const c: Commit = {
        seq: st.lastSeq + 1, device: this.cfg.deviceName, time: this.now(), changes: [], prev: st.head, moved: true,
        members: { gen: Math.max(st.members.at(-1)?.gen ?? 0, book.floor.gen) + 1, members, earlier: st.members.map((x) => x.seq) },
      };
      const hash = await this.put(c);
      if (hash) {
        st.apply({ ...c, hash });
        await this.accepted(changeOf({ ...c, hash }));
        await this.committed(c.seq, hash);
        return c.seq;
      }
      await this.fetchRemote();
    }
    throw new Error('Could not change the members: other devices kept committing first. Try again.');
  }

  /**
   * Owner: makes storage's log end with what members made, so that syncing goes on. Removes from its end every commit
   * from the first one no member who may write made (or that cannot be opened), and whatever lies past a gap, with the
   * snapshots past them. Honest devices never commit past such a commit, so nothing a member made is lost.
   *
   * After storage was put back from an older copy (a backup), a commit made before a removal by the member removed
   * fails too, only because this device holds a newer member list than storage does (`MemberBook`). Such commits that
   * a member who may still write made a commit after are kept: this device signs them again in place, with the same
   * changes, and the commits after them too. Such commits with none after them are removed, as a removed member writing
   * into the old copy makes them. Returns the commits removed; none when the log verifies.
   */
  removeUnverifiable(): Promise<number[]> {
    return this.exclusive(async () => {
      const { repo, st } = await this.open();
      const { book } = this.ownerKeys();
      let failed: UnverifiedError | undefined;
      let tail: number[] = [];
      for (let round = 0; round < MAX_ROUNDS; round++) {
        failed = undefined;
        try {
          await this.fetchRemote();
        } catch (e) {
          if (!(e instanceof UnverifiedError)) throw e;
          failed = e;
        }
        tail = await repo.commitSeqsAfter(st.lastSeq);
        // A commit right after the end, after a fetch that went through, was made meanwhile: take it first. Anything
        // else past the end lies past a gap, which a device that is up to date never lists.
        if (failed || !tail.length || tail[0] !== st.lastSeq + 1) break;
      }
      if (failed && failed.seq <= st.lastSeq) {
        throw new Error(`Commit ${failed.seq}, which this device already had, has changed in storage or can no longer be read, so nothing was removed. Check storage for damage.`);
      }
      if (!tail.length || (!failed && tail[0] === st.lastSeq + 1)) return [];

      // Each commit after this device's end, in order, read afresh: whether it verifies, and whether only with lists
      // older than the accepted one taken as they are.
      const walked: { c: Commit; capOnly: boolean }[] = [];
      const changes = [...st.members];
      let head = st.head;
      let stands = st.lastSeq;
      const judge = async (seq: number) => {
        const c = await repo.readCommit(seq, UNCHECKED).catch((e: unknown) => {
          if (e instanceof UnverifiedError) return null;
          throw e;
        });
        if (!c || (c.prev !== undefined && head !== undefined && c.prev !== head)) return undefined;
        const passes = (uncapped: boolean) => book.checkCommit(c, changes, seq - 1, { cache: false, uncapped }).then(() => true, () => false);
        if (!(await passes(true))) return undefined;
        return { c, capOnly: !(await passes(false)) };
      };
      for (const seq of tail) {
        if (seq !== st.lastSeq + 1 + walked.length) break;
        // Judged twice before it counts as garbage: one read damaged in transit must not remove a good commit.
        const j = (await judge(seq)) ?? (await judge(seq));
        if (!j) break;
        walked.push(j);
        if (j.c.members) changes.push(changeOf(j.c));
        head = j.c.hash;
        if (!j.capOnly) stands = seq;
      }
      const removed = tail.filter((s) => s > stands);
      const kept = walked.filter((w) => w.c.seq <= stands);
      const from = kept.findIndex((w) => w.capOnly);
      const again = from < 0 ? [] : kept.slice(from).map((w) => w.c);
      if (!removed.length && !again.length) return [];
      const end = again.length ? again[0].seq - 1 : stands;
      // From the end back, so that an interrupted removal leaves no gap.
      for (const seq of [...removed, ...again.map((c) => c.seq)].sort((a, b) => b - a)) await repo.removeCommit(seq);
      const snaps = (await repo.snapshots()).map((s) => s.seq);
      for (const seq of new Set([...snaps, ...repo.forged])) {
        if (seq <= end) continue;
        await repo.deleteSnapshot(seq);
        repo.forged.delete(seq);
      }
      await repo.writeFollowHint(snaps.filter((s) => s <= end).at(-1) ?? 0);
      this.stuck = false;
      for (const c of again) {
        // Another device committed meanwhile: the rest stays removed, and the devices that made it send it again.
        if (st.lastSeq !== c.seq - 1) break;
        const n: Commit = {
          seq: c.seq, device: c.device, time: c.time, changes: c.changes, prev: st.head,
          ...(c.moved && { moved: true }), ...(c.confirmed && { confirmed: true }), ...(c.members && { members: c.members }),
        };
        const hash = await this.put(n);
        if (!hash) break;
        for (const { path } of n.changes) this.recheck.add(path);
        this.unplanned = true;
        st.apply({ ...n, hash });
        if (n.members) await this.accepted(changeOf({ ...n, hash }));
        await this.committed(n.seq, hash);
      }
      this.unsaved = true;
      await this.save();
      return removed;
    });
  }

  /**
   * Owner: hands new storage keys to every member and to the owner's other devices, each in a document only it can
   * open, signed and numbered. Test the keys before: a device switches only to keys that work for it. `read` is needed
   * while some read members only read, and `suggest` while some are marked to send suggestions, who get it instead. A
   * follow link's member gets none: anyone may hold that link, and it reads the public copy, which new keys do not
   * change. Nor does a write invite that expired before any device joined with it: its link, which may have leaked,
   * would read them with the old keys it carries. Returns the document's number.
   */
  writeRekey(storage: { write: Record<string, unknown>; read?: Record<string, unknown>; suggest?: Record<string, unknown> }): Promise<number> {
    return this.exclusive(async () => {
      const { repo, st } = await this.open();
      const { book, root } = this.ownerKeys();
      await this.fetchVerified();
      const store = repo.objects;
      const now = this.now();
      const all = book.current(st.members).filter((m) => m.role !== 'owner' && !m.follow);
      const lapsed = all.filter((m) => m.role === 'write' && !m.pub && !!m.expires && m.expires <= now);
      // A join made before the invite expired is still confirmed at the owner's next sync (`confirmHeld`), by storage's clock.
      const made = lapsed.length ? new Map((await store.list('join/')).map((o) => [o.key.slice(5), o.modified])) : new Map<string, number>();
      const unused = new Set(lapsed.filter((m) => !(made.has(m.id) && made.get(m.id)! <= m.expires!)).map((m) => m.id));
      const list = all.filter((m) => !unused.has(m.id));
      const readers = list.filter((m) => m.role === 'read' && !m.suggest);
      const suggesters = list.filter((m) => m.role === 'read' && m.suggest);
      const names = (ms: Member[]) => ms.map((m) => m.name).join(', ');
      if (readers.length && !storage.read) throw new Error(`A read-only key is needed too: ${names(readers)} only receive changes`);
      if (suggesters.length && !storage.suggest) throw new Error(`A key that can read and add suggestions is needed too: ${names(suggesters)} send suggestions`);
      const n = Math.max(this.now(), ((await readRekey(store, book, 'owner', root))?.n ?? 0) + 1);
      for (const m of list) {
        const keys = m.role === 'write' ? storage.write : m.suggest ? storage.suggest! : storage.read!;
        await writeRekey(store, book, m.id, await memberSecret(root, m.id), { n, storage: keys });
      }
      await writeRekey(store, book, 'owner', root, { n, storage: storage.write });
      book.floor = { ...book.floor, rekey: n };
      await this.savePosition();
      return n;
    });
  }

  /**
   * New storage keys the owner handed this device, newer than the ones it switched to last; null when there are none.
   * Test them against this share, switch, then call `acceptRekey`.
   */
  async rekeyOffer(): Promise<RekeyOffer | null> {
    const { repo } = await this.open();
    const book = this.memberBook();
    const k = this.o.member!.keys;
    const secret = book.isOwner ? k.root : k.secret;
    if (!secret) return null;
    const offer = await readRekey(repo.objects, book, book.isOwner ? 'owner' : book.self, fromB64(secret));
    return offer && offer.n > book.floor.rekey ? offer : null;
  }

  /** Records that this device switched to the keys of re-key `n`: from now on it takes only newer ones. */
  acceptRekey(n: number): Promise<void> {
    return this.exclusive(async () => {
      await this.open();
      const book = this.memberBook();
      if (n <= book.floor.rekey) return;
      book.floor = { ...book.floor, rekey: n };
      await this.savePosition();
    });
  }

  /**
   * A member's device: sends the files at `paths` (as `SyncResult.unsent` names them) to the owner as one suggestion
   * (`suggest.ts`): each note or canvas changed here, with the version it was changed from. `sent` holds the fingerprint
   * of what was sent before for each path, so the same text is not sent twice. Writes nothing when nothing is left to
   * send. A device that only receives writes this one object all the same, under a new key of its own, straight to the
   * store it was given, past the wrapper that keeps every other write from it: a key that may not write there is refused
   * by storage, and that refusal is thrown.
   */
  sendSuggestion(paths: Iterable<string>, sent: ReadonlyMap<string, string> = new Map()): Promise<SuggestOutcome> {
    return this.exclusive(async () => {
      const { repo, st } = await this.open();
      const k = this.o.member?.keys;
      if (!this.book || !k?.secret) throw new Error('Only a member’s device can send a suggestion to the owner of a shared folder');
      const out: SuggestOutcome = { sent: [], skipped: [] };
      const files: SuggestedFile[] = [];
      let total = 0;
      for (const path of [...new Set([...paths].map(vaultKey))].sort()) {
        const skip = (why: SuggestOutcome['skipped'][number]['why']) => out.skipped.push({ path, why });
        if (!suggestKind(path) || this.excluded(path)) {
          skip('kind');
          continue;
        }
        const disk = this.known?.paths.get(path) ?? path;
        const stat = await this.o.fs.stat(disk);
        if (!stat) {
          skip('gone');
          continue;
        }
        if (stat.size > SUGGEST_MAX_FILE) {
          skip('large');
          continue;
        }
        const data = await this.o.fs.read(disk);
        let text: string;
        try {
          // A byte order mark stays, so the owner's device compares and writes the text byte for byte.
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        } catch {
          skip('binary');
          continue;
        }
        const base = st.synced.get(path)?.entry;
        if (base && hasChunks(base, (await repo.split(data)).ids)) {
          skip('same');
          continue;
        }
        const sum = await digest(data);
        if (sent.get(path) === sum) {
          skip('sent');
          continue;
        }
        if (total + data.length > SUGGEST_MAX_TOTAL) {
          skip('full');
          continue;
        }
        total += data.length;
        files.push({ path, text, ...(base && { base }) });
        out.sent.push({ path, sum });
      }
      if (!files.length) return out;
      const secret = fromB64(k.secret);
      // Another of this member's devices may send in the same millisecond: each suggestion takes a key no other has.
      for (let time = this.now(), tries = 0; tries < 5; time++, tries++) {
        const key = inboxKey(k.id, time);
        const sealed = await sealSuggestion(repo.id, secret, { key, member: k.id, time, device: this.cfg.deviceName, files });
        if (await this.o.store.put(key, sealed, { ifNoneMatch: true })) return { ...out, key };
      }
      throw new Error('Could not find a free place in storage for the suggestion. Try again.');
    });
  }

  /** Owner: the keys of the suggestions waiting in storage, without opening them: one listing. */
  async inbox(): Promise<string[]> {
    const { repo } = await this.open();
    this.ownerKeys();
    return (await repo.objects.list(INBOX)).map((o) => o.key).filter((key) => !!parseInboxKey(key));
  }

  /**
   * Owner: the newest `INBOX_OPENED` suggestions waiting in storage, newest first by the time their keys name, each
   * opened with the secret of the member its key names, and how many more wait. One whose member is not on the member
   * list now, or that does not open, comes without its content; an object whose key names no time comes last.
   */
  suggestions(): Promise<WaitingSuggestions> {
    return this.exclusive(async () => {
      const { repo, st } = await this.open();
      const { book, root } = this.ownerKeys();
      await this.fetchVerified();
      const list = book.current(st.members);
      const listed = (await repo.objects.list(INBOX))
        .filter((o) => inInbox(o.key))
        .map((o) => ({ ...o, at: parseInboxKey(o.key) }))
        .sort((a, b) => (b.at?.time ?? -1) - (a.at?.time ?? -1) || (a.key < b.key ? -1 : 1));
      const opened = listed.slice(0, INBOX_OPENED);
      const out: (WaitingSuggestion | undefined)[] = [];
      await pool(opened, this.cfg.concurrency, async ({ key, size, at }, i) => {
        const member = at && list.find((m) => m.id === at.member && m.role !== 'owner');
        const item: WaitingSuggestion = { key, ...at, ...(member && { name: member.name }) };
        // A member who may add to the inbox can store anything there: what no suggestion fits in is not downloaded.
        if (at && member && size <= MAX_SEALED) {
          const raw = await repo.objects.get(key, { start: 0, end: MAX_SEALED + 1 });
          if (!raw) return;
          item.suggestion = await openSuggestion(repo.id, await memberSecret(root, at.member), key, raw).catch(() => undefined);
        }
        out[i] = item;
      });
      return { items: out.filter((w) => w !== undefined), more: listed.length - opened.length };
    });
  }

  /**
   * Owner: one file of suggestion `key` was dealt with, taken into the folder or not: it is taken out of the suggestion,
   * and the suggestion out of storage once no file is left in it. Nothing happens to a suggestion already gone.
   */
  settleSuggestion(key: string, path: string): Promise<void> {
    return this.exclusive(async () => {
      const { repo } = await this.open();
      const { root } = this.ownerKeys();
      const at = parseInboxKey(key);
      if (!at) throw new Error('That is not a suggestion');
      const raw = await repo.objects.get(key, { start: 0, end: MAX_SEALED + 1 });
      if (!raw) return;
      const secret = await memberSecret(root, at.member);
      const s = await openSuggestion(repo.id, secret, key, raw);
      const files = s.files.filter((f) => f.path !== vaultKey(path));
      if (!files.length) await repo.objects.delete(key);
      else if (files.length < s.files.length) await repo.objects.put(key, await sealSuggestion(repo.id, secret, { ...s, files }));
    });
  }

  /** Owner: takes suggestion `key` out of storage whole, as when it can not be opened or none of it is wanted; any object `suggestions` lists. */
  async dismissSuggestion(key: string): Promise<void> {
    const { repo } = await this.open();
    this.ownerKeys();
    if (!inInbox(key)) throw new Error('That is not a suggestion');
    await repo.objects.delete(key);
  }

  /**
   * A write member's device the owner's has not confirmed yet: makes sure, once per engine, that its join is in storage,
   * as when the app stopped after keeping its keys and before `publishJoin`. Best effort.
   */
  private async sendJoin(): Promise<void> {
    const { repo, st } = await this.open();
    const book = this.memberBook();
    const k = this.o.member!.keys;
    const me = book.me(st.members);
    if (this.joinSent || this.cfg.readOnly || !k.key || !k.secret || me?.role !== 'write' || me.pub) return;
    this.joinSent = true;
    try {
      const pub = book.selfPub!;
      if (!(await writeJoin(repo.objects, repo.id, k.id, fromB64(k.secret), pub))) this.log('Another device used this invite first');
    } catch (e) {
      this.joinSent = false;
      this.log(`Could not ask the owner's device to confirm this one: ${errorText(e)}`);
    }
  }

  /**
   * After a sync, on a device that may write, at most every minute on the owner's and hourly on others: the owner's
   * confirm joins and put back a member list storage lost (as after a restore from a backup); each drops expired
   * invites and snapshots found forged. Best effort.
   */
  private async chores(): Promise<void> {
    const book = this.memberBook();
    const { repo, st } = await this.open();
    const now = this.now();
    if (this.cfg.readOnly || !book.mayWrite(st.members) || now - this.choresDone < (book.isOwner ? OWNER_CHORES_EVERY : CHORES_EVERY)) return;
    this.choresDone = now;
    try {
      if (book.isOwner) {
        await this.confirmHeld();
        if ((st.members.at(-1)?.gen ?? 0) < book.floor.gen) await this.changeMembers((list) => list);
      }
      const store = repo.objects;
      const listed = book.isOwner ? new Set(book.current(st.members).map((m) => m.id)) : undefined;
      for (const o of await store.list('slot/')) {
        const id = o.key.slice(5);
        // The invite of someone no longer a member, left when a removal could not take it out. An invite made on another
        // of the owner's devices writes its slot just before the member: it is given an hour to land.
        if (listed && !listed.has(id) && now - o.modified > ORPHAN_SLOT_AGE) {
          await deleteSlot(store, id);
          continue;
        }
        const e = await slotExpiry(store, id);
        if (e && now > e) await deleteSlot(store, id);
      }
      for (const seq of [...repo.forged]) {
        // Read again first: one read that came back damaged in transit must not delete a good snapshot.
        repo.forged.delete(seq);
        await repo.readSnapshotWithHead(seq);
        if (!repo.forged.has(seq)) continue;
        await repo.deleteSnapshot(seq);
        repo.forged.delete(seq);
      }
    } catch (e) {
      this.log(`Could not tidy the shared folder's invites: ${errorText(e)}`);
    }
  }
}
