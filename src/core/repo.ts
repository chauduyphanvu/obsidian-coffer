import { pool, randomBytes, toB64, toHex, utf8 } from './bytes.ts';
import { cutPoints } from './chunker.ts';
import { deflate, inflate } from './compress.ts';
import { chunkId, createKeys, digest, keysFromMaster, open, rewrapKeys, seal, unlockKeys, wrapMaster, type KeyHeader, type Keys } from './crypto.ts';
import { MemberBook, MemberReplay, UnverifiedError, type Member, type MemberChange, type SignedSnapshot } from './members.ts';
import { putNew, type ChunkParams, type Commit, type Entry, type RemoteStore } from './types.ts';
import { PackTable, decEntry, encEntry, type WireEntry } from './wire.ts';

const FORMAT = 1;
/** A shared folder with members, whose every change is signed (`members.ts`). A version that reads only format 1 refuses it. */
export const MEMBER_FORMAT = 2;
const HEADER_KEY = 'vault.json';
const PRUNED_KEY = 'pruned';
/** A member share's plaintext hint for a reader that cannot list: the newest snapshot. Only a hint: the snapshot itself is checked. */
const FOLLOW_KEY = 'follow';
const RESERVED = /^(log|snap|idx|pack|slot|join|rekey|inbox)\//;
const reserved = (key: string) => key === HEADER_KEY || key === PRUNED_KEY || key === FOLLOW_KEY || RESERVED.test(key);
/** Commits asked for at once by a reader that cannot list, until one is missing. */
const PROBE_WINDOW = 6;

/** A new passphrase was sent to storage and the connection failed before storage could say whether it took. */
export class PassphraseUnknownError extends Error {
  constructor(cause: unknown) {
    super(`Could not tell whether storage took the new passphrase: the connection failed (${cause instanceof Error ? cause.message : String(cause)})`);
  }
}

export interface Header {
  format: number;
  id: string;
  kdf: KeyHeader;
  chunk: ChunkParams;
}

interface WireCommit {
  d: string;
  t: number;
  p: string[];
  c: [string, WireEntry | null][];
  /** Older versions ignore it in a commit, so adding it needed no format change. */
  h?: string;
  /** Set on a commit that only moves data (`Commit.moved`). Older versions ignore it in a commit and see entries with unchanged content; in a digest, see `f`. */
  m?: 1;
  /** Set on a commit whose deletions the user confirmed (`Commit.confirmed`). Older versions ignore it in a commit and count them like any deletion; in a digest, see `f`. */
  a?: 1;
  /**
   * Set on every commit of a digest whose writer keeps `m` and `a`. A version from before them writes the
   * digest from commits it decoded without them, so without this a move would read as a user commit.
   */
  f?: 1;
  /** Member shares only: `Commit.signer`, `sig` and `listSeq`. */
  k?: string;
  s?: string;
  g?: number;
  /** A member change: `Commit.members`. */
  l?: { n: number; m: WireMember[]; e: number[] };
}

interface WireMember {
  i: string;
  n: string;
  r: Member['role'];
  p?: string;
  x?: number;
  f?: 1;
  /** `Member.suggest`. */
  s?: 1;
}

/** A member share's digest: its commits, signed as a whole (`MemberBook.checkDigest`). Other vaults store the commits alone. */
interface WireDigest {
  c: WireCommit[];
  k?: string;
  s?: string;
}

interface WireSnapshot {
  p: string[];
  f: WireEntry[];
  h?: string;
  k?: string;
  s?: string;
  g?: number;
}

/** Every member change a device holds, complete up to `through`: what checks a member share's commits. */
export interface MemberLog {
  changes: MemberChange[];
  through: number;
}

/** Beyond this, a chunk is larger than any device should hold in memory at once. */
const MAX_CHUNK = 64 << 20;
/** The most a member share's commit, snapshot or other document may unpack to: far more than any vault's needs. */
const MAX_DOC = 64 << 20;

/**
 * False for chunk sizes no device should cut by. Every device of a member share cuts content by its header's, which
 * anyone who can write to storage can change: sizes of zero would cut forever, tiny ones into countless chunks.
 */
export function saneChunks(p: ChunkParams | undefined): boolean {
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1024 && (n as number) <= MAX_CHUNK;
  return !!p && ok(p.min) && ok(p.avg) && ok(p.max) && p.min <= p.avg && p.avg <= p.max;
}

/**
 * A header made beside the commits and packs of a vault whose own is gone would lock every device out, so that is
 * refused before anything is written. Only a missing header gets here: a normal open lists nothing.
 */
async function refuseOrphans(store: RemoteStore): Promise<void> {
  for (const prefix of ['log/', 'snap/', 'pack/']) {
    if ((await store.list(prefix)).length) {
      throw new Error(
        `The vault key file, vault.json, is missing from storage, though it still holds ${prefix} data. Put it back from a backup or from bucket versioning; ` +
          'nothing was written, so no new vault was started beside the old data.',
      );
    }
  }
}

const encMember = (m: Member): WireMember => ({ i: m.id, n: m.name, r: m.role, ...(m.pub && { p: m.pub }), ...(m.expires && { x: m.expires }), ...(m.follow && { f: 1 as const }), ...(m.suggest && { s: 1 as const }) });
const decMember = (w: WireMember): Member => ({ id: w.i, name: w.n, role: w.r, ...(w.p && { pub: w.p }), ...(w.x && { expires: w.x }), ...(w.f === 1 && { follow: true as const }), ...(w.s === 1 && { suggest: true as const }) });

function encCommit(c: Commit): WireCommit {
  const pt = new PackTable();
  const changes = c.changes.map((ch): [string, WireEntry | null] => [ch.path, ch.entry && encEntry(ch.entry, pt)]);
  return {
    d: c.device, t: c.time, p: pt.list, c: changes, h: c.prev, ...(c.moved && { m: 1 as const }), ...(c.confirmed && { a: 1 as const }),
    ...(c.signer !== undefined && { k: c.signer, s: c.sig, g: c.listSeq }),
    ...(c.members && { l: { n: c.members.gen, m: c.members.members.map(encMember), e: c.members.earlier } }),
  };
}

function decCommit(seq: number, w: WireCommit, hash?: string): Commit {
  const c: Commit = { seq, device: w.d, time: w.t, changes: w.c.map(([path, e]) => ({ path, entry: e && decEntry(e, w.p) })), prev: w.h, hash };
  if (w.m) c.moved = true;
  if (w.a) c.confirmed = true;
  if (typeof w.k === 'string') {
    c.signer = w.k;
    c.sig = w.s;
    c.listSeq = w.g;
  }
  if (w.l) c.members = { gen: w.l.n, members: w.l.m.map(decMember), earlier: w.l.e };
  return c;
}

export const seqKey = (prefix: 'log' | 'snap' | 'idx', seq: number) => `${prefix}/${String(seq).padStart(12, '0')}`;
const seqOf = (key: string) => Number(key.slice(key.lastIndexOf('/') + 1));

/**
 * Remote layout:
 *   vault.json   key-wrapping header (plaintext)
 *   log/<seq>    one commit each, written create-if-absent: the sequence number is the lock.
 *                Each names the digest of the one before it, so a log cut short or forked shows.
 *   snap/<seq>   full file table at that commit, and that commit's digest, so new devices skip the log
 *   idx/<seq>    the commits of one snapshot interval in a single object, for fast history
 *   pack/<id>    encrypted chunks back to back, addressed by (offset, length)
 *   pruned       how far back cleanup has removed history (`prunedTo`), so no device offers what is gone
 *   dev/<id>     one device's heartbeat, an encrypted document
 *   any other    encrypted documents outside the log (readDoc, writeDoc)
 * A shared folder with members (format 2) also has, each sealed for one member or plaintext as said (`members.ts`):
 *   slot/<id>    an invite: the master key wrapped under that member's secret, and when it expires (plaintext)
 *   join/<id>    a joining device's public key, for the owner's device to confirm
 *   rekey/<id>   new storage keys for that member, signed by the owner; `rekey/owner` for the owner's devices
 *   inbox/<id>-<time>  a member's suggestion for the owner's devices (`suggest.ts`)
 *   follow       the newest snapshot, for a reader that cannot list (plaintext)
 * Log objects are never deleted, except a commit its own writer takes back at once: a missing next key must always
 * mean "nothing newer". The owner of a member share may also remove commits no member made from the log's end.
 */
export class Repo {
  readonly id: string;
  private store: RemoteStore;
  private chunk: ChunkParams;
  private keys: Keys;
  private iter: number;
  /** Only a member share caps what a document unpacks to: in a vault or a share of the older kind, only key holders write. */
  private docCap: number;
  private members?: { book: MemberBook; log: () => MemberLog };
  /** Commits a reader that cannot list has fetched while finding the log's end, until they are read. */
  private probed = new Map<number, Uint8Array>();
  /** Member shares: snapshots found not to verify, left out of `snapshots()`. A device that writes deletes them. */
  readonly forged = new Set<number>();

  private constructor(store: RemoteStore, header: Header, keys: Keys) {
    this.store = store;
    this.id = header.id;
    this.chunk = header.chunk;
    this.keys = keys;
    this.iter = header.kdf.iter;
    this.docCap = header.format === MEMBER_FORMAT ? MAX_DOC : Infinity;
  }

  /** The PBKDF2 cost of the passphrase that wraps this vault's key. */
  get kdfIterations(): number {
    return this.iter;
  }

  /** The store, for a member share's invites, joins and re-key documents (`members.ts`). */
  get objects(): RemoteStore {
    return this.store;
  }

  /**
   * True when the storage already holds a vault, so setup asks for its passphrase rather than a new one. Throws when it
   * holds a vault's objects without the header (see `refuseOrphans`).
   */
  static async exists(store: RemoteStore): Promise<boolean> {
    if ((await store.get(HEADER_KEY)) !== null) return true;
    await refuseOrphans(store);
    return false;
  }

  /** The plaintext header, or null when storage holds none. */
  static async header(store: RemoteStore): Promise<Header | null> {
    const raw = await store.get(HEADER_KEY);
    if (!raw) return null;
    try {
      const h = JSON.parse(new TextDecoder().decode(raw)) as Header;
      if (h && typeof h === 'object') return h;
    } catch {
      // reported below
    }
    throw new Error('The vault key file in storage, vault.json, is damaged');
  }

  static async open(store: RemoteStore, passphrase: string, create: { kdfIterations: number; chunk: ChunkParams }): Promise<Repo> {
    let raw = await store.get(HEADER_KEY);
    if (!raw) {
      await refuseOrphans(store);
      const { header: kdf, keys } = await createKeys(passphrase, create.kdfIterations);
      const header: Header = { format: FORMAT, id: toB64(randomBytes(12)), kdf, chunk: create.chunk };
      if (await store.put(HEADER_KEY, utf8.encode(JSON.stringify(header)), { ifNoneMatch: true })) {
        return new Repo(store, header, keys);
      }
      raw = await store.get(HEADER_KEY);
      if (!raw) throw new Error('Remote vault header vanished while it was being created');
    }
    const header = JSON.parse(new TextDecoder().decode(raw)) as Header;
    if (header.format === MEMBER_FORMAT) throw new Error('This storage holds a shared folder with members, which a device joins with an invite link rather than a passphrase');
    if (header.format !== FORMAT) throw new Error(`Remote vault uses format ${header.format}; this version reads format ${MEMBER_FORMAT}`);
    return new Repo(store, header, await unlockKeys(header.kdf, passphrase));
  }

  /**
   * Starts a member share in empty storage: a header of format 2. Writes nothing beside data that is already there, and
   * nothing over a header. Its `kdf` wraps the master key under a random secret that is thrown away: anyone who can read
   * the header (every member, the public behind a follow link) could otherwise guess a passphrase that opens it offline.
   */
  static async createMember(store: RemoteStore, master: Uint8Array, o: { kdfIterations: number; chunk: ChunkParams }): Promise<Repo> {
    if (await Repo.exists(store)) throw new Error('This storage location already holds a vault or a shared folder. Choose an empty one.');
    const kdf = await wrapMaster(master, toB64(randomBytes(32)), o.kdfIterations);
    const header: Header = { format: MEMBER_FORMAT, id: toB64(randomBytes(12)), kdf, chunk: o.chunk };
    if (!(await putNew(store, HEADER_KEY, utf8.encode(JSON.stringify(header))))) {
      throw new Error('This storage location already holds a vault or a shared folder. Choose an empty one.');
    }
    return new Repo(store, header, await keysFromMaster(master));
  }

  /**
   * Opens a member share with the master key a joined device holds. Refuses a header of a lower format, which would
   * turn every check off, and one with another id. Never creates anything: an empty location is an error.
   */
  static async openMember(store: RemoteStore, keys: { repo: string; master: Uint8Array }): Promise<Repo> {
    const header = await Repo.header(store);
    if (!header) throw new Error('The shared folder is missing from storage: its key file, vault.json, is gone');
    if (header.format < MEMBER_FORMAT) {
      throw new Error(`Storage now says this shared folder has no members (format ${header.format}), which the owner never does: it was tampered with, so nothing was synced`);
    }
    if (header.format !== MEMBER_FORMAT) throw new Error(`Remote vault uses format ${header.format}; this version reads format ${MEMBER_FORMAT}`);
    if (header.id !== keys.repo) throw new Error('This storage location holds another shared folder than the one this device joined');
    if (!saneChunks(header.chunk)) {
      throw new Error('The chunk sizes in the shared folder’s key file, vault.json, are not ones Coffer uses: it was damaged or tampered with, so nothing was synced');
    }
    return new Repo(store, header, await keysFromMaster(keys.master));
  }

  /** Makes this repo a member share's: commits, snapshots and the cleanup record are signed when written and checked when read. */
  useMembers(book: MemberBook, log: () => MemberLog): void {
    this.members = { book, log };
  }

  /** For checking a whole member share's log in order, apart from this device's state. */
  async memberReplay(): Promise<MemberReplay | undefined> {
    if (!this.members) return undefined;
    const { floor } = this.members.book;
    return new MemberReplay(this.members.book, floor.gen > 0 && (await this.storedHash(floor.seq)) !== floor.hash);
  }

  private async sealJson(key: string, value: unknown): Promise<Uint8Array> {
    return seal(this.keys, await deflate(utf8.encode(JSON.stringify(value))), `${this.id}:${key}`);
  }

  private async decodeJson<T>(key: string, raw: Uint8Array): Promise<T> {
    const { plain } = await open(this.keys, raw, `${this.id}:${key}`);
    return JSON.parse(new TextDecoder().decode(await inflate(plain, this.docCap))) as T;
  }

  private async openJson<T>(key: string): Promise<T | null> {
    const raw = await this.store.get(key);
    return raw && this.decodeJson<T>(key, raw);
  }

  /**
   * As `openJson`, but in a member share, where anyone who can write to storage can put anything anywhere, an object
   * that cannot be opened reads as `bad` rather than throwing. A failed request still throws.
   */
  private async openMemberJson<T>(key: string): Promise<T | null | 'bad'> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    try {
      return await this.decodeJson<T>(key, raw);
    } catch (e) {
      if (!this.members) throw e;
      return 'bad';
    }
  }

  /**
   * In a member share, a commit this device's member changes cover (all up to the one before it) is checked as it is
   * read, and throws an UnverifiedError unless it verifies. One further on is left to the reader that takes the log in
   * order (`checkInOrder`), as is any read with `unchecked`: for a caller that checks in order, or only compares digests.
   */
  private async check(c: Commit): Promise<void> {
    if (!this.members) return;
    const { changes, through } = this.members.log();
    if (c.seq - 1 <= through) await this.members.book.checkCommit(c, changes, through);
  }

  /** Member shares: throws unless `c`, the commit right after `log.through`, verifies. */
  async checkInOrder(c: Commit): Promise<void> {
    if (!this.members) return;
    const { changes, through } = this.members.log();
    await this.members.book.checkCommit(c, changes, through);
  }

  async readCommit(seq: number, opts: { unchecked?: boolean } = {}): Promise<Commit | null> {
    const key = seqKey('log', seq);
    const held = this.probed.get(seq);
    this.probed.delete(seq);
    const raw = held ?? (await this.store.get(key));
    if (!raw) return null;
    let c: Commit;
    try {
      const [w, hash] = await Promise.all([this.decodeJson<WireCommit>(key, raw), digest(raw)]);
      c = decCommit(seq, w, hash);
    } catch (e) {
      // Anyone who can write to storage can put anything at a log position: what cannot be opened, no member made.
      if (this.members) throw new UnverifiedError(seq, 'it cannot be opened');
      throw e;
    }
    if (!opts.unchecked) await this.check(c);
    return c;
  }

  /** The digest of commit `seq` as stored, without reading what it holds; null when there is none. */
  async storedHash(seq: number): Promise<string | null> {
    const raw = await this.store.get(seqKey('log', seq));
    return raw && digest(raw);
  }

  /** True when another device has committed past `seq - 1`. Costs one tiny request. */
  async hasCommit(seq: number): Promise<boolean> {
    return (await this.store.get(seqKey('log', seq), { start: 0, end: 1 })) !== null;
  }

  /**
   * The digest of the commit as stored, or null when another device already took this sequence number. In a member
   * share, signs `c` in place first, for the member list in force before it.
   */
  async writeCommit(c: Commit): Promise<string | null> {
    if (this.members) await this.members.book.signCommit(c, this.members.log().changes);
    const key = seqKey('log', c.seq);
    const sealed = await this.sealJson(key, encCommit(c));
    const hash = await digest(sealed);
    return (await putNew(this.store, key, sealed)) ? hash : null;
  }

  /**
   * Takes back the commit this device just wrote (`hash` is what `writeCommit` returned), which turned out to sit on a
   * log that is not the one it saw. Only while storage still holds that commit, and in one attempt: a delete sent again
   * after its reply was lost would remove whatever another device committed at this number since.
   */
  async retractCommit(seq: number, hash: string): Promise<void> {
    const key = seqKey('log', seq);
    const raw = await this.store.get(key);
    if (!raw) return;
    if ((await digest(raw)) !== hash) throw new Error(`commit ${seq} in storage is not the one this device wrote`);
    await this.store.delete(key, { once: true });
  }

  /** Member shares: removes a commit from the log's end that no member who may write made, for the owner. */
  async removeCommit(seq: number): Promise<void> {
    await this.store.delete(seqKey('log', seq));
  }

  /** The `count` commits ending at `seq` in one object, so history does not fetch them one by one. In a member share, signed. */
  async writeDigest(seq: number, commits: Commit[]): Promise<void> {
    const key = seqKey('idx', seq);
    const c = commits.map((x) => ({ ...encCommit(x), f: 1 as const }));
    const body: WireCommit[] | WireDigest = this.members ? { c, ...(await this.members.book.signDigest(seq, commits)) } : c;
    await this.store.put(key, await this.sealJson(key, body));
  }

  /** Null when there is none, or its writer lost the commits' flags (see `WireCommit.f`): then only the commits tell. */
  async readDigest(seq: number, count: number): Promise<Commit[] | null> {
    return (await this.loadDigest(seq, count)).commits;
  }

  /**
   * As `readDigest`, and whether a reader holding the commits should write it again: when there is none, or
   * it lost the flags. Whether a digest without them holds a move or a confirmed commit cannot be told from
   * it, since its writer dropped every field it did not know, so it is never trusted. In a member share, one
   * that cannot be opened, is not signed by a member who may write now, or whose commits do not all verify is stale
   * too; one past what this device's member changes cover is not used.
   */
  async loadDigest(seq: number, count: number): Promise<{ commits: Commit[] | null; stale: boolean }> {
    const body = await this.openMemberJson<WireCommit[] | WireDigest>(seqKey('idx', seq));
    const stale = { commits: null, stale: true };
    const other = { commits: null, stale: false };
    if (!body || body === 'bad') return stale;
    const w = Array.isArray(body) ? body : body.c;
    if (!Array.isArray(w)) return stale;
    const decode = () => w.map((c, i) => decCommit(seq - count + 1 + i, c));
    if (!this.members) {
      if (w.length !== count) return other;
      if (!w.every((c) => c.f)) return stale;
      return { commits: decode(), stale: false };
    }
    const { changes, through } = this.members.log();
    if (seq > through) return other;
    try {
      if (Array.isArray(body)) return stale;
      if (w.length !== count) return other;
      if (!w.every((c) => c.f)) return stale;
      const commits = decode();
      if (!(await this.members.book.checkDigest(seq, commits, body.k, body.s, changes))) return stale;
      for (const c of commits) await this.check(c);
      return { commits, stale: false };
    } catch {
      return stale;
    }
  }

  /**
   * The furthest floor snapshot any cleanup has used, 0 before the first: history from before the earliest
   * moment it gives is no longer whole, whatever retention the device reading it keeps. In a member share, a record
   * that a member who may write did not sign, or that cannot be opened, counts for nothing, and cleanup writes it again.
   */
  async prunedTo(): Promise<number> {
    const p = await this.openMemberJson<{ floor: number; k?: string; s?: string }>(PRUNED_KEY);
    if (!p || p === 'bad' || typeof p !== 'object') return 0;
    if (this.members && !(await this.members.book.checkPruned(p, this.members.log().changes))) return 0;
    return p.floor ?? 0;
  }

  async setPrunedTo(floor: number): Promise<void> {
    const body = this.members ? { floor, ...(await this.members.book.signPruned(floor)) } : { floor };
    await this.store.put(PRUNED_KEY, await this.sealJson(PRUNED_KEY, body));
  }

  /**
   * When the write fails, the key file is read back, since a write whose reply was lost may have landed: it took when
   * it holds the key just wrapped (a fresh salt, so no other), and did not when it holds another. Throws a
   * PassphraseUnknownError when not even that can be read.
   */
  async changePassphrase(oldPassphrase: string, newPassphrase: string, iterations: number): Promise<void> {
    const raw = await this.store.get(HEADER_KEY);
    if (!raw) throw new Error('Remote vault header is missing');
    const header = JSON.parse(new TextDecoder().decode(raw)) as Header;
    header.kdf = await rewrapKeys(header.kdf, oldPassphrase, newPassphrase, iterations);
    try {
      await this.store.put(HEADER_KEY, utf8.encode(JSON.stringify(header)));
    } catch (e) {
      const there = await Repo.header(this.store).catch(() => {
        throw new PassphraseUnknownError(e);
      });
      if (JSON.stringify(there?.kdf) !== JSON.stringify(header.kdf)) throw e;
    }
    this.iter = header.kdf.iter;
  }

  /** Sequence numbers of the commits after `seq`. A store that cannot list is asked for each in turn until one is missing. */
  async commitSeqsAfter(seq: number): Promise<number[]> {
    if (this.store.noList) return this.probeLog(seq);
    return (await this.store.list('log/', seqKey('log', seq))).map((o) => seqOf(o.key));
  }

  /** Keys are dense, so the first missing one is the end. Fetched in small windows, and kept for `readCommit`. */
  private async probeLog(seq: number): Promise<number[]> {
    this.probed.clear();
    const out: number[] = [];
    for (let next = seq + 1; ; next += PROBE_WINDOW) {
      const got = await Promise.all(Array.from({ length: PROBE_WINDOW }, (_, i) => this.store.get(seqKey('log', next + i))));
      for (let i = 0; i < got.length; i++) {
        const raw = got[i];
        if (!raw) return out;
        this.probed.set(next + i, raw);
        out.push(next + i);
      }
    }
  }

  async snapshots(): Promise<{ seq: number; modified: number }[]> {
    if (this.store.noList) {
      const snap = await this.followHint();
      return snap ? [{ seq: snap, modified: 0 }] : [];
    }
    const all = (await this.store.list('snap/')).map((o) => ({ seq: seqOf(o.key), modified: o.modified }));
    return this.forged.size ? all.filter((s) => !this.forged.has(s.seq)) : all;
  }

  private async followHint(): Promise<number> {
    const raw = await this.store.get(FOLLOW_KEY);
    if (!raw) return 0;
    try {
      const snap = (JSON.parse(new TextDecoder().decode(raw)) as { snap?: unknown }).snap;
      return Number.isInteger(snap) && (snap as number) > 0 ? (snap as number) : 0;
    } catch {
      return 0;
    }
  }

  /** Member shares: points a reader that cannot list at snapshot `seq` (0: none). */
  async writeFollowHint(seq: number): Promise<void> {
    await this.store.put(FOLLOW_KEY, utf8.encode(JSON.stringify({ snap: seq })));
  }

  async readSnapshot(seq: number): Promise<Map<string, Entry> | null> {
    return (await this.readSnapshotWithHead(seq))?.files ?? null;
  }

  /**
   * `head` is the digest of commit `seq`; absent in snapshots written before the log was chained. In a member share, a
   * snapshot that does not verify, or cannot be opened, reads as missing and is remembered in `forged`; one this device
   * cannot check yet reads as missing. With `unchecked`, one that opens is returned as stored, for a caller that checks
   * it itself.
   */
  async readSnapshotWithHead(seq: number, opts: { unchecked?: boolean } = {}): Promise<SignedSnapshot | null> {
    const w = await this.openMemberJson<WireSnapshot>(seqKey('snap', seq));
    if (!w) return null;
    let files: Map<string, Entry> | undefined;
    if (w !== 'bad') {
      try {
        files = new Map(w.f.map((f) => [f[0] as string, decEntry(f, w.p, 1)]));
      } catch (e) {
        if (!this.members) throw e;
      }
    }
    if (w === 'bad' || !files) {
      this.forged.add(seq);
      return null;
    }
    const snap: SignedSnapshot = { files, head: w.h };
    if (typeof w.k === 'string') Object.assign(snap, { signer: w.k, sig: w.s, listSeq: w.g });
    if (this.members && !opts.unchecked) {
      const { changes, through } = this.members.log();
      if (seq > through) return null;
      try {
        await this.members.book.checkSnapshot(seq, snap, changes);
      } catch {
        this.forged.add(seq);
        return null;
      }
    }
    return snap;
  }

  /**
   * In a member share, signed, and the hint for readers that cannot list moves to it. A snapshot already there that
   * does not verify, or was taken at another commit, is replaced: left, it would make every new device skip it.
   */
  async writeSnapshot(seq: number, files: Map<string, Entry>, head?: string): Promise<void> {
    const pt = new PackTable();
    const f: WireEntry[] = [];
    for (const [path, e] of files) f.push([path, ...encEntry(e, pt)]);
    const key = seqKey('snap', seq);
    if (!this.members) {
      await this.store.put(key, await this.sealJson(key, { p: pt.list, f, h: head }), { ifNoneMatch: true });
      return;
    }
    const signed: SignedSnapshot = { files, head };
    await this.members.book.signSnapshot(seq, signed, this.members.log().changes);
    const sealed = await this.sealJson(key, { p: pt.list, f, h: head, k: signed.signer, s: signed.sig, g: signed.listSeq });
    if (!(await this.store.put(key, sealed, { ifNoneMatch: true }))) {
      const there = await this.readSnapshotWithHead(seq).catch(() => null);
      if (there && there.head === head) return;
      await this.store.put(key, sealed);
      this.forged.delete(seq);
    }
    await this.writeFollowHint(seq);
  }

  newPackId(): string {
    return toHex(randomBytes(16));
  }

  async putPack(id: string, data: Uint8Array): Promise<void> {
    await this.store.put(`pack/${id}`, data);
  }

  getPackRange(id: string, start: number, end: number): Promise<Uint8Array | null> {
    return this.store.get(`pack/${id}`, { start, end });
  }

  async listPacks(): Promise<{ id: string; size: number; modified: number }[]> {
    return (await this.store.list('pack/')).map((o) => ({ id: o.key.slice(5), size: o.size, modified: o.modified }));
  }

  deletePack(id: string): Promise<void> {
    return this.store.delete(`pack/${id}`);
  }

  deleteSnapshot(seq: number): Promise<void> {
    return this.store.delete(seqKey('snap', seq));
  }

  /** Cuts content where every device cuts it and names each piece by a hash keyed with the vault key. */
  async split(data: Uint8Array): Promise<{ parts: Uint8Array[]; ids: string[] }> {
    const cuts = cutPoints(data, this.chunk);
    const parts = cuts.map((end, i) => data.subarray(i ? cuts[i - 1] : 0, end));
    // WebCrypto copies its input, so hashing every chunk of a big file at once would double its memory.
    const ids: string[] = new Array<string>(parts.length);
    await pool(parts, 4, async (part, i) => {
      ids[i] = await chunkId(this.keys, part);
    });
    return { parts, ids };
  }

  async sealChunk(id: string, data: Uint8Array, compress: boolean): Promise<Uint8Array> {
    if (compress) {
      const small = await deflate(data);
      if (small.length < data.length * 0.9) return seal(this.keys, small, id, 1);
    }
    return seal(this.keys, data, id, 0);
  }

  /** The chunk id is bound into the authentication tag, so a swapped or altered blob cannot decrypt. */
  async openChunk(id: string, sealed: Uint8Array): Promise<Uint8Array> {
    const { plain, flag } = await open(this.keys, sealed, id);
    return flag === 1 ? inflate(plain, Math.max(this.chunk.max, MAX_CHUNK)) : plain;
  }

  /** The id this content is stored under, to check a downloaded chunk against the id it was filed as. */
  chunkId(plain: Uint8Array): Promise<string> {
    return chunkId(this.keys, plain);
  }

  private docKey(key: string): string {
    if (!key || reserved(key)) throw new Error(`"${key}" is not a document key`);
    return key;
  }

  /** An encrypted JSON document outside the log, or null when there is none under `key`. */
  async readDoc<T>(key: string): Promise<T | null> {
    return this.openJson<T>(this.docKey(key));
  }

  async writeDoc(key: string, value: unknown): Promise<void> {
    await this.store.put(this.docKey(key), await this.sealJson(key, value));
  }

  async listDocs(prefix: string): Promise<{ key: string; modified: number }[]> {
    const found = await this.store.list(this.docKey(prefix));
    return found.filter((o) => !reserved(o.key)).map((o) => ({ key: o.key, modified: o.modified }));
  }

  async deleteDoc(key: string): Promise<void> {
    await this.store.delete(this.docKey(key));
  }
}
