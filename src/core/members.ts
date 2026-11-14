// Shared folders with members: who may change one, proved by signatures every device checks before it applies a change.
// No Obsidian import, so it runs under plain Node tests.
import { fromB64, randomBytes, toB64, utf8 } from './bytes.ts';
import {
  hkdf, importSigningKey, importVerifyKey, openWithKey, openWithPassphrase, publicKeyOf, sealWithKey, sealWithPassphrase, signWith,
  unwrapMaster, verifyWith, wrapMaster, type KeyHeader, type SigningKey,
} from './crypto.ts';
import type { Commit, Entry, RemoteStore } from './types.ts';

export type Role = 'owner' | 'write' | 'read';

export interface Member {
  /** Random, so the plaintext keys that name it (`slot/<id>`) tell nothing about who it is. */
  id: string;
  name: string;
  role: Role;
  /**
   * The public key of the one device that signs for this member: the owner's, or a write member's own once the owner's
   * device has confirmed its join. A write member without one may not write yet.
   */
  pub?: string;
  /** A write member not confirmed yet: when its invite stops opening, 0 for never. */
  expires?: number;
  /**
   * A read member made for a follow link, which anyone may hold: re-keys hand it no storage keys, which could reach
   * more than the public copy does.
   */
  follow?: true;
  /**
   * A read member invited to send suggestions too: re-keys hand it a key that may also add to the inbox, apart from the
   * one for members who only read. Unset in lists made before the mark existed, which read as not sending them.
   */
  suggest?: true;
}

/** What a member change carries: the whole list from then on, its generation, and where every earlier change is. */
export interface MemberList {
  /** Counts up with every change, so a device can tell an older list from a newer one wherever the log puts them. */
  gen: number;
  members: Member[];
  /** The sequence numbers of every earlier member change, oldest first, so a device that starts from a snapshot finds them all. */
  earlier: number[];
}

/** A member change as this device keeps it. */
export interface MemberChange {
  seq: number;
  gen: number;
  members: Member[];
  /** Its commit's digest as stored. */
  hash?: string;
}

/**
 * What a device holds of a member share, kept in its secret storage. Base64url strings, so it stores as JSON. A joined
 * device never needs the share's passphrase or its invite again.
 */
export interface MemberKeys {
  /** The id in the share's `vault.json`: a header with another id is refused. */
  repo: string;
  /** This device's member id; on the owner's devices, the owner's. */
  id: string;
  /** The master key itself. */
  master: string;
  /** The owner's public key, pinned from the link: only it signs member changes and re-key documents. */
  owner: string;
  /** The private key this device signs with: the owner's on the owner's devices, its own on a write member's. */
  key?: SigningKey;
  /** The owner's devices: the root every member's secret is derived from. */
  root?: string;
  /** A member's devices: that member's secret. */
  secret?: string;
  /** The member change the link was made at. The oldest member list this device starts from. */
  since?: number;
}

/**
 * The newest member list this device has accepted, kept apart from its sync state so that it survives a reset of that
 * state, as after accepting storage: storage that later shows an older list grants no one more than this one does.
 */
export interface Position {
  gen: number;
  seq: number;
  /** The digest of that member change's commit, which tells whether storage still holds it. */
  hash?: string;
  members: Member[];
  /** The number of the newest re-key document this device switched to. */
  rekey: number;
}

/** A snapshot as stored, with what signs it. */
export interface SignedSnapshot {
  files: Map<string, Entry>;
  /** The digest of the commit it was taken at. */
  head?: string;
  signer?: string;
  sig?: string;
  /** The member change in force at its commit. */
  listSeq?: number;
}

/** Storage holds a change no member who may write made, or garbage past the log's end. Sync stops before it and applies nothing from it on. */
export class UnverifiedError extends Error {
  readonly seq: number;
  constructor(seq: number, why: string) {
    super(`Commit ${seq} in storage was not made by a member who may write to this shared folder: ${why}`);
    this.seq = seq;
  }
}

/** This device's member is no longer on the share's member list. */
export class RemovedError extends Error {
  constructor() {
    super('This device was removed from the shared folder, so it no longer syncs it');
  }
}

export const isMemberId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
export const newMemberId = (): string => toB64(randomBytes(12));

const writes = (m: Member | undefined): m is Member & { pub: string } => !!m?.pub && (m.role === 'write' || m.role === 'owner');

// Signatures cover a fixed-order tuple rebuilt from decoded fields, never stored bytes: digests store commits again in
// their own encoding. Each kind of object has its own tag, so a signature on one can never pass for another.
const entryTuple = (e: Entry) => [e.size, e.mtime, e.chunks.map((c) => [c.id, c.pack, c.off, c.len, c.size])];
// The follow and suggest marks are signed only where they are set, so lists signed before them still verify.
const memberTuple = (m: Member) => [m.id, m.name, m.role, m.pub ?? '', m.expires ?? 0, ...(m.follow ? [1] : []), ...(m.suggest ? ['suggest'] : [])];
const tupleBytes = (t: unknown[]) => utf8.encode(JSON.stringify(t));

function commitBytes(repo: string, c: Commit): Uint8Array {
  return tupleBytes([
    'coffer/commit', repo, c.seq, c.prev ?? '', c.device, c.time, c.moved ? 1 : 0, c.confirmed ? 1 : 0, c.signer ?? '', c.listSeq ?? 0,
    c.changes.map((ch) => [ch.path, ch.entry && entryTuple(ch.entry)]),
    c.members ? [c.members.gen, c.members.members.map(memberTuple), c.members.earlier] : 0,
  ]);
}

const snapshotBytes = (repo: string, seq: number, s: SignedSnapshot) =>
  tupleBytes(['coffer/snapshot', repo, seq, s.head ?? '', s.signer ?? '', s.listSeq ?? 0, [...s.files].map(([path, e]) => [path, entryTuple(e)])]);

const prunedBytes = (repo: string, floor: number, signer: string) => tupleBytes(['coffer/pruned', repo, floor, signer]);

// Each commit's own signature covers all of it, so a digest's binds the commits by theirs.
const digestBytes = (repo: string, seq: number, signer: string, commits: Commit[]) =>
  tupleBytes(['coffer/digest', repo, seq, signer, commits.map((c) => [c.seq, c.sig ?? ''])]);

const storageTuple = (s: Record<string, unknown>) => Object.keys(s).sort().map((k) => [k, s[k] ?? null]);
const rekeyBytes = (repo: string, target: string, n: number, storage: Record<string, unknown>) =>
  tupleBytes(['coffer/rekey', repo, target, n, storageTuple(storage)]);

const sameSeqs = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export const changeOf = (c: Commit): MemberChange => ({ seq: c.seq, gen: c.members!.gen, members: c.members!.members, ...(c.hash && { hash: c.hash }) });

/**
 * Checks and makes the signatures of one member share. A commit at seq N is valid when its signer may write under the
 * member list in force just before N (member changes: only the owner, with the key pinned from the link), and it
 * names that list. The lists come from the log itself (`changes`, every member change the caller holds, complete up to
 * the point it says). While the log no longer holds the newest member change this device accepted (`floor`), as when
 * storage was rolled back, a list older than that one grants no one more than it does: a member removed since cannot
 * write into the rolled-back log. A log that still holds it is the one the device saw, up to it, by the hash chain.
 */
export class MemberBook {
  readonly repo: string;
  /** The owner's public key. */
  readonly owner: string;
  /** This device's member id. */
  readonly self: string;
  /** This device's public key, when it holds a private one. */
  readonly selfPub?: string;
  floor: Position;
  /** `floor` changed since it was last saved. */
  dirty = false;
  /**
   * For a reader not yet as far as `floor.seq`: whether storage's commit there is something else than the member change
   * accepted. Until the engine has looked, it is taken to be.
   */
  floorGone = true;
  private signer?: Promise<CryptoKey>;
  private ownerKey: Promise<CryptoKey>;
  private keys = new Map<string, Promise<CryptoKey>>();
  private checked = new WeakSet<Commit>();

  constructor(repo: string, keys: Pick<MemberKeys, 'owner' | 'id' | 'key'>, floor?: Position) {
    this.repo = repo;
    this.owner = keys.owner;
    this.self = keys.id;
    this.floor = floor ?? { gen: 0, seq: 0, members: [], rekey: 0 };
    this.ownerKey = this.keyOf(keys.owner);
    if (keys.key) {
      this.selfPub = publicKeyOf(keys.key);
      this.signer = importSigningKey(keys.key);
      // A key that cannot be imported fails the first signature, not this constructor.
      this.signer.catch(() => undefined);
    }
  }

  /** True on the owner's devices. */
  get isOwner(): boolean {
    return this.selfPub === this.owner;
  }

  private keyOf(pub: string): Promise<CryptoKey> {
    let k = this.keys.get(pub);
    if (!k) {
      this.keys.set(pub, (k = importVerifyKey(pub)));
      k.catch(() => undefined);
    }
    return k;
  }

  private async verify(pub: string | Promise<CryptoKey>, sig: string, data: Uint8Array): Promise<boolean> {
    try {
      return await verifyWith(await (typeof pub === 'string' ? this.keyOf(pub) : pub), sig, data);
    } catch {
      return false;
    }
  }

  private async signingKey(): Promise<CryptoKey> {
    if (!this.signer) throw new Error('This device holds no key to sign changes to this shared folder');
    return this.signer;
  }

  /** The member change in force for a commit at `seq`: the newest before it. */
  static before(changes: MemberChange[], seq: number): MemberChange | undefined {
    for (let i = changes.length - 1; i >= 0; i--) if (changes[i].seq < seq) return changes[i];
    return undefined;
  }

  /** The member change in force right after commit `seq`. */
  static atOrBefore(changes: MemberChange[], seq: number): MemberChange | undefined {
    return MemberBook.before(changes, seq + 1);
  }

  /** The member list this device goes by now: the log's newest, unless that is older than the one it accepted. */
  current(changes: MemberChange[]): Member[] {
    const last = changes.at(-1);
    return last && last.gen >= this.floor.gen ? last.members : this.floor.members;
  }

  /** This device's member as `current` has it. */
  me(changes: MemberChange[]): Member | undefined {
    return this.current(changes).find((m) => m.id === this.self);
  }

  /** True when this device may commit: its member writes, and the key on the list is this device's. */
  mayWrite(changes: MemberChange[]): boolean {
    const m = this.me(changes);
    return !!this.signer && writes(m) && m.pub === this.selfPub;
  }

  /** True when a member list is known and does not name this device's member. */
  removed(changes: MemberChange[]): boolean {
    return (changes.length > 0 || this.floor.gen > 0) && !this.me(changes);
  }

  /**
   * True when lists older than `floor` are capped by it: the log read, complete up to `through`, does not hold that
   * member change. `gone` says so for a reader not as far as it yet.
   */
  private capped(changes: MemberChange[], through: number, gone = this.floorGone): boolean {
    const f = this.floor;
    if (!f.gen) return false;
    if (through < f.seq) return gone;
    return !changes.some((x) => x.seq === f.seq && x.gen === f.gen && x.hash === f.hash);
  }

  /** True when member `id` may write under the list this device goes by now (`current`), with key `pub` when given. */
  writesNow(changes: MemberChange[], id: string, pub?: string): boolean {
    const m = this.current(changes).find((x) => x.id === id);
    return writes(m) && (pub === undefined || m.pub === pub);
  }

  /** The member `id` as `list` grants it, when it may write. With `capped`, an older list than the accepted one grants it only if that one does too. */
  private grant(list: MemberChange | undefined, id: string, capped: boolean): (Member & { pub: string }) | undefined {
    const m = list?.members.find((x) => x.id === id);
    if (!list || !writes(m)) return undefined;
    if (capped && list.gen < this.floor.gen) {
      const f = this.floor.members.find((x) => x.id === id);
      if (!writes(f) || f.pub !== m.pub) return undefined;
    }
    return m;
  }

  /** What is wrong with member change `c`, read after `before`, if anything. `earlier` is every member change before it. */
  private badChange(c: Commit, before: MemberChange | undefined, earlier?: number[]): string | undefined {
    const l = c.members!;
    if (c.changes.length || !c.moved) return 'a member change that also changes files';
    const owners = l.members.filter((m) => m.role === 'owner');
    const ownerId = before?.members.find((m) => m.role === 'owner')?.id ?? c.signer;
    if (owners.length !== 1 || owners[0].pub !== this.owner || owners[0].id !== c.signer || c.signer !== ownerId) return 'a member change not made by the owner';
    if (new Set(l.members.map((m) => m.id)).size !== l.members.length) return 'a member list that names someone twice';
    if (!Number.isInteger(l.gen) || l.gen <= (before?.gen ?? 0)) return 'a member list no newer than the one before it';
    if (earlier && !sameSeqs(l.earlier, earlier)) return 'a member change that leaves out earlier ones';
    return undefined;
  }

  /**
   * Throws an UnverifiedError unless `c` verifies. `changes` holds every member change up to `through`, which reaches
   * at least `c.seq - 1`. Whether a commit already taken is the one taken is for the hash chain to say. With
   * `uncapped`, lists older than the accepted one are taken as they are (see `capped`), for telling a commit refused
   * only because storage was rolled back from one no member made.
   */
  async checkCommit(c: Commit, changes: MemberChange[], through: number, o: { cache?: boolean; floorGone?: boolean; uncapped?: boolean } = {}): Promise<void> {
    const cache = o.cache ?? true;
    if (cache && this.checked.has(c)) return;
    if (c.seq - 1 > through) throw new Error(`Commit ${c.seq} cannot be checked before the commits ahead of it`);
    const fail = (why: string): never => {
      throw new UnverifiedError(c.seq, why);
    };
    const before = MemberBook.before(changes, c.seq);
    if (!c.signer || !c.sig) fail('it is not signed');
    if ((c.listSeq ?? -1) !== (before?.seq ?? 0)) fail('it names another member list than the one in force');
    let key: string | Promise<CryptoKey>;
    if (c.members) {
      const why = this.badChange(c, before, changes.filter((x) => x.seq < c.seq).map((x) => x.seq));
      if (why) fail(why);
      key = this.ownerKey;
    } else {
      const m = this.grant(before, c.signer!, !o.uncapped && this.capped(changes, through, o.floorGone));
      key = m ? m.pub : fail(before?.members.some((x) => x.id === c.signer) ? 'its member may not write' : 'its signer is not a member');
    }
    if (!(await this.verify(key, c.sig!, commitBytes(this.repo, c)))) fail('its signature does not match');
    if (cache) this.checked.add(c);
  }

  /**
   * Checks a member change with only the owner's key, before the commits around it are known: with `chain`, the member
   * changes before it, oldest first, as a snapshot's list leads back through them; without, on its own, as the one a
   * link was made at.
   */
  async checkChange(c: Commit, chain?: MemberChange[]): Promise<MemberChange> {
    const fail = (why: string): never => {
      throw new UnverifiedError(c.seq, why);
    };
    if (!c.members) fail('it is not a member change');
    if (!c.signer || !c.sig) fail('it is not signed');
    const before = chain?.at(-1);
    const why = this.badChange(c, before, chain?.map((x) => x.seq));
    if (why) fail(why);
    if (chain && (c.listSeq ?? -1) !== (before?.seq ?? 0)) fail('it names another member list than the one in force');
    if (!(await this.verify(this.ownerKey, c.sig!, commitBytes(this.repo, c)))) fail('its signature does not match');
    return changeOf(c);
  }

  /**
   * Throws unless snapshot `seq` was signed by a member who may write under the list in force at its commit, names that
   * list, and may still write under the list this device goes by now. `changes` holds every member change up to `seq`.
   * Unlike a commit, a snapshot is not in the chain of commits: one for an old commit may have been written at any time
   * since, as by a member removed meanwhile, who could put any files in it. A device that takes one before it knows
   * the newest list checks its signer again once it does.
   */
  async checkSnapshot(seq: number, s: SignedSnapshot, changes: MemberChange[], floorGone?: boolean): Promise<void> {
    const fail = (why: string): never => {
      throw new Error(`Snapshot ${seq} in storage was not written by a member who may write to this shared folder: ${why}`);
    };
    const at = MemberBook.atOrBefore(changes, seq);
    if (!s.signer || !s.sig) fail('it is not signed');
    if ((s.listSeq ?? -1) !== (at?.seq ?? 0)) fail('it names another member list than the one in force');
    const m = this.grant(at, s.signer!, this.capped(changes, seq, floorGone)) ?? fail('its signer may not write');
    if (!this.writesNow(changes, m.id, m.pub)) fail('its signer may no longer write');
    if (!(await this.verify(m.pub, s.sig!, snapshotBytes(this.repo, seq, s)))) fail('its signature does not match');
  }

  /**
   * True when the digest of the commits ending at `seq` was signed by a member who may write now: like a snapshot, a
   * digest is not in the chain of commits, and nothing else ties the commits in it to the log's.
   */
  async checkDigest(seq: number, commits: Commit[], k: unknown, s: unknown, changes: MemberChange[]): Promise<boolean> {
    if (typeof k !== 'string' || typeof s !== 'string') return false;
    const m = this.current(changes).find((x) => x.id === k);
    return writes(m) && this.verify(m.pub, s, digestBytes(this.repo, seq, k, commits));
  }

  async signDigest(seq: number, commits: Commit[]): Promise<{ k: string; s: string }> {
    return { k: this.self, s: await signWith(await this.signingKey(), digestBytes(this.repo, seq, this.self, commits)) };
  }

  /** True when `pruned` was signed by a member who may write now. */
  async checkPruned(p: { floor: number; k?: string; s?: string }, changes: MemberChange[]): Promise<boolean> {
    if (!p.k || !p.s || !Number.isInteger(p.floor)) return false;
    const m = this.current(changes).find((x) => x.id === p.k);
    return writes(m) && this.verify(m.pub, p.s, prunedBytes(this.repo, p.floor, p.k));
  }

  /** Signs `c` in place, for the list in force before it, from `changes` (complete up to `c.seq - 1`). */
  async signCommit(c: Commit, changes: MemberChange[]): Promise<void> {
    const key = await this.signingKey();
    c.signer = this.self;
    c.listSeq = MemberBook.before(changes, c.seq)?.seq ?? 0;
    c.sig = await signWith(key, commitBytes(this.repo, c));
  }

  async signSnapshot(seq: number, s: SignedSnapshot, changes: MemberChange[]): Promise<void> {
    const key = await this.signingKey();
    s.signer = this.self;
    s.listSeq = MemberBook.atOrBefore(changes, seq)?.seq ?? 0;
    s.sig = await signWith(key, snapshotBytes(this.repo, seq, s));
  }

  async signPruned(floor: number): Promise<{ k: string; s: string }> {
    return { k: this.self, s: await signWith(await this.signingKey(), prunedBytes(this.repo, floor, this.self)) };
  }

  async signRekey(target: string, n: number, storage: Record<string, unknown>): Promise<string> {
    if (!this.isOwner) throw new Error('Only the owner can change the storage keys of a shared folder');
    return signWith(await this.signingKey(), rekeyBytes(this.repo, target, n, storage));
  }

  checkRekey(target: string, n: number, storage: Record<string, unknown>, sig: string): Promise<boolean> {
    return this.verify(this.ownerKey, sig, rekeyBytes(this.repo, target, n, storage));
  }

  /** Takes `ch` as the newest member list this device has accepted, when it is newer than the one it holds. */
  accept(ch: MemberChange | undefined): void {
    if (!ch || ch.gen <= this.floor.gen) return;
    this.floor = { gen: ch.gen, seq: ch.seq, ...(ch.hash && { hash: ch.hash }), members: ch.members, rekey: this.floor.rekey };
    this.dirty = true;
  }
}

/** Checks a whole log in order, apart from what this device holds: for `verify`. */
export class MemberReplay {
  private book: MemberBook;
  /** Whether the log read lacks the member change this device accepted: see `MemberBook`. */
  private floorGone: boolean;
  changes: MemberChange[] = [];
  private through = 0;

  constructor(book: MemberBook, floorGone: boolean) {
    this.book = book;
    this.floorGone = floorGone;
  }

  /** What is wrong with `c`, if anything. Takes it either way: a member change that fails is not applied. */
  async commit(c: Commit): Promise<string | undefined> {
    try {
      await this.book.checkCommit(c, this.changes, this.through, { cache: false, floorGone: this.floorGone });
      if (c.members) this.changes.push(changeOf(c));
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      this.through = c.seq;
    }
  }

  /** A commit that could not be read. */
  skip(seq: number): void {
    this.through = seq;
  }

  async snapshot(seq: number, s: SignedSnapshot): Promise<string | undefined> {
    try {
      await this.book.checkSnapshot(seq, s, this.changes, this.floorGone);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}

/** A saved position, unless it is missing or belongs to another share (`repo`). */
export function parsePosition(text: string | null, repo: string): Position | undefined {
  if (!text) return undefined;
  const p = JSON.parse(text) as Partial<Position> & { repo?: string };
  if (p.repo !== repo) return undefined;
  if (!Number.isInteger(p.gen) || !Number.isInteger(p.seq) || !Array.isArray(p.members)) throw new Error('The saved member list of this shared folder is damaged');
  return { gen: p.gen!, seq: p.seq!, ...(typeof p.hash === 'string' && { hash: p.hash }), members: p.members, rekey: p.rekey ?? 0 };
}

export const serializePosition = (repo: string, p: Position): string => JSON.stringify({ repo, ...p });

// Invites, joins and re-key documents. Each is sealed under a key derived from one member's secret, so only that member
// and the owner (who derives every secret from the root) can open it, and other members cannot read each other's.

/** Low: the secret is 256 random bits, not a passphrase. */
const SLOT_ITERATIONS = 1000;
const slotKey = (id: string) => `slot/${id}`;
const joinKey = (id: string) => `join/${id}`;
const rekeyKey = (target: string) => `rekey/${target}`;
/** Binds the expiry: storage that moves it later opens nothing. */
const slotAad = (repo: string, id: string, expires: number) => `${repo}:slot/${id}:${expires}`;
const decode = (raw: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(raw));

/** A member's secret, which the owner can always derive again. */
export function memberSecret(root: Uint8Array, id: string): Promise<Uint8Array> {
  return hkdf(root, `coffer/member/${id}`);
}

/** The invite's slot: the master key wrapped under the member's secret, until `expires` (0: never). Plaintext otherwise. */
export async function writeSlot(store: RemoteStore, repo: string, id: string, master: Uint8Array, secret: Uint8Array, expires: number): Promise<void> {
  const kdf = await wrapMaster(master, toB64(secret), SLOT_ITERATIONS, slotAad(repo, id, expires));
  await store.put(slotKey(id), utf8.encode(JSON.stringify({ kdf, expires })));
}

/** When the slot of `id` stops opening (0: never), or null when there is none. */
export async function slotExpiry(store: RemoteStore, id: string): Promise<number | null> {
  const raw = await store.get(slotKey(id));
  if (!raw) return null;
  try {
    const e = (decode(raw) as { expires?: unknown }).expires;
    return typeof e === 'number' ? e : 0;
  } catch {
    return 0;
  }
}

/** The master key from the slot of `id`. Refuses a slot that is missing, has expired, or is not this member's. */
export async function openSlot(store: RemoteStore, repo: string, id: string, secret: Uint8Array, now: number): Promise<Uint8Array> {
  const raw = await store.get(slotKey(id));
  if (!raw) throw new Error('This invite no longer opens the shared folder: it was used already, the owner removed it, or it expired');
  let slot: { kdf: KeyHeader; expires: number };
  try {
    slot = decode(raw) as typeof slot;
  } catch {
    throw new Error('This invite does not open this shared folder');
  }
  if (typeof slot.expires !== 'number') throw new Error('This invite does not open this shared folder');
  if (slot.expires && now > slot.expires) throw new Error('This invite has expired. Ask for a new one.');
  try {
    return await unwrapMaster(slot.kdf, toB64(secret), slotAad(repo, id, slot.expires));
  } catch {
    throw new Error('This invite does not open this shared folder');
  }
}

export async function deleteSlot(store: RemoteStore, id: string): Promise<void> {
  await store.delete(slotKey(id));
}

/**
 * Records a joining device's public key, for the owner's device to confirm. False when the invite was used already by
 * another key; true again for the same key, so a device that did not hear back can try again. When it was made is
 * storage's to say (`confirmJoins`), not the joining device's.
 */
export async function writeJoin(store: RemoteStore, repo: string, id: string, secret: Uint8Array, pub: string): Promise<boolean> {
  const key = await hkdf(secret, 'coffer/join');
  if (await store.put(joinKey(id), await sealWithKey(key, utf8.encode(JSON.stringify({ pub })), `${repo}:${joinKey(id)}`), { ifNoneMatch: true })) return true;
  const there = await readJoin(store, repo, id, secret);
  return there !== null && there !== 'bad' && there.pub === pub;
}

/** The join of `id`: null when there is none, 'bad' when it does not open with that member's secret. */
export async function readJoin(store: RemoteStore, repo: string, id: string, secret: Uint8Array): Promise<{ pub: string } | null | 'bad'> {
  const raw = await store.get(joinKey(id));
  if (!raw) return null;
  try {
    const j = decode(await openWithKey(await hkdf(secret, 'coffer/join'), raw, `${repo}:${joinKey(id)}`)) as { pub?: unknown };
    if (typeof j.pub !== 'string') return 'bad';
    await importVerifyKey(j.pub);
    return { pub: j.pub };
  } catch {
    return 'bad';
  }
}

export async function deleteJoin(store: RemoteStore, id: string): Promise<void> {
  await store.delete(joinKey(id));
}

/** Storage keys handed to one member (or to the owner's devices: target `owner`) by a re-key, numbered so a device takes only newer ones. */
export interface RekeyOffer {
  n: number;
  storage: Record<string, unknown>;
}

/** Writes the re-key document for `target`, sealed under `secret` (the member's, or the root for `owner`) and signed by the owner. */
export async function writeRekey(store: RemoteStore, book: MemberBook, target: string, secret: Uint8Array, offer: RekeyOffer): Promise<void> {
  const s = await book.signRekey(target, offer.n, offer.storage);
  const key = await hkdf(secret, 'coffer/rekey');
  await store.put(rekeyKey(target), await sealWithKey(key, utf8.encode(JSON.stringify({ ...offer, s })), `${book.repo}:${rekeyKey(target)}`));
}

/** The re-key document for `target`, when there is one that opens with `secret` and carries the owner's signature. */
export async function readRekey(store: RemoteStore, book: MemberBook, target: string, secret: Uint8Array): Promise<RekeyOffer | null> {
  const raw = await store.get(rekeyKey(target));
  if (!raw) return null;
  try {
    const d = decode(await openWithKey(await hkdf(secret, 'coffer/rekey'), raw, `${book.repo}:${rekeyKey(target)}`)) as { n?: unknown; storage?: unknown; s?: unknown };
    if (!Number.isInteger(d.n) || typeof d.s !== 'string' || !d.storage || typeof d.storage !== 'object') return null;
    const offer = { n: d.n as number, storage: d.storage as Record<string, unknown> };
    return (await book.checkRekey(target, offer.n, offer.storage, d.s)) ? offer : null;
  } catch {
    return null;
  }
}

export async function deleteRekey(store: RemoteStore, target: string): Promise<void> {
  await store.delete(rekeyKey(target));
}

// Links. Encoding only: what a link is shown as (an obsidian:// address, a QR code) is up to whoever shows it.

export const INVITE_PREFIX = 'coffershare3.';
export const FOLLOW_PREFIX = 'cofferfollow1.';
/** An owner link is an invite of the older kind, sealed under a passphrase, that also carries `member`. */
export const OWNER_LINK_PREFIX = 'coffershare2.';

/** What makes one person a member, as `invite` returns it: the share's own part of an invite link. */
export interface MemberGrant {
  repo: string;
  member: string;
  /** The member's secret, base64url. */
  secret: string;
  role: 'write' | 'read';
  owner: string;
  /** The member change that added this member. */
  since: number;
}

/** A member invite: the grant, plus where the share is stored and the keys for the role, and the share's name. No private signing key. */
export interface MemberInvite extends MemberGrant {
  /** Storage address and credentials for the role, as the app that makes the link names them. */
  storage: Record<string, unknown>;
  share: string;
  /** The folder name to suggest. */
  folder: string;
}

/** A follow link: a read member that reads a public copy over plain HTTPS, with no credentials. */
export interface FollowInvite extends Omit<MemberGrant, 'role'> {
  url: string;
  share: string;
  folder: string;
}

const encodePayload = (prefix: string, payload: object) => prefix + toB64(utf8.encode(JSON.stringify(payload)));

function decodePayload(link: string, prefix: string, what: string): Record<string, unknown> {
  const text = link.trim();
  if (!text.startsWith(prefix)) throw new Error(`That is not ${what}`);
  try {
    const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromB64(text.slice(prefix.length)))) as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new Error(`That is not ${what}, or it was cut short when it was copied`);
}

const isKey = (s: unknown, n: number): s is string => {
  try {
    return typeof s === 'string' && fromB64(s).length === n;
  } catch {
    return false;
  }
};
const isPub = (s: unknown): s is string => isKey(s, 65) && fromB64(s)[0] === 4;
const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

function grantProblem(p: Record<string, unknown>): boolean {
  return typeof p.repo !== 'string' || !p.repo || !isMemberId(p.member) || !isKey(p.secret, 32) || !isPub(p.owner) || !isCount(p.since) ||
    typeof p.share !== 'string' || typeof p.folder !== 'string';
}

export function encodeInvite(i: MemberInvite): string {
  const { repo, member, secret, role, owner, since, storage, share, folder } = i;
  return encodePayload(INVITE_PREFIX, { v: 3, repo, member, secret, role, owner, since, storage, share, folder });
}

export function decodeInvite(link: string): MemberInvite {
  const p = decodePayload(link, INVITE_PREFIX, 'an invite link to a shared folder');
  if (p.v !== 3 || grantProblem(p) || (p.role !== 'write' && p.role !== 'read') || !p.storage || typeof p.storage !== 'object') {
    throw new Error('That invite link is damaged, or comes from a newer version of Coffer');
  }
  const { repo, member, secret, role, owner, since, storage, share, folder } = p as unknown as MemberInvite;
  return { repo, member, secret, role, owner, since, storage, share, folder };
}

export function encodeFollow(f: FollowInvite): string {
  const { repo, member, secret, owner, since, url, share, folder } = f;
  return encodePayload(FOLLOW_PREFIX, { v: 1, repo, member, secret, owner, since, url, share, folder });
}

export function decodeFollow(link: string): FollowInvite {
  const p = decodePayload(link, FOLLOW_PREFIX, 'a follow link');
  if (p.v !== 1 || grantProblem(p) || typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) {
    throw new Error('That follow link is damaged, or comes from a newer version of Coffer');
  }
  const { repo, member, secret, owner, since, url, share, folder } = p as unknown as FollowInvite;
  return { repo, member, secret, owner, since, url, share, folder };
}

/** `value`, or what the JSON in it holds; null when that is not JSON. */
function jsonOf(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

/** Checks keys read back from secret storage or from a link. */
export function parseMemberKeys(value: unknown): MemberKeys {
  const k = jsonOf(value) as Partial<MemberKeys> | null;
  const key = k?.key;
  const ok =
    !!k && typeof k.repo === 'string' && !!k.repo && isMemberId(k.id) && isKey(k.master, 32) && isPub(k.owner) &&
    (k.root === undefined || isKey(k.root, 32)) && (k.secret === undefined || isKey(k.secret, 32)) &&
    (k.since === undefined || isCount(k.since)) &&
    (key === undefined || (key.kty === 'EC' && key.crv === 'P-256' && isKey(key.x, 32) && isKey(key.y, 32) && isKey(key.d, 32)));
  if (!ok) throw new Error('The keys kept for this shared folder are damaged');
  const out: MemberKeys = { repo: k.repo!, id: k.id!, master: k.master!, owner: k.owner! };
  if (key) out.key = { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, d: key.d };
  if (k.root) out.root = k.root;
  if (k.secret) out.secret = k.secret;
  if (k.since) out.since = k.since;
  return out;
}

/**
 * What an owner link adds to the payload of an invite of the older kind (`coffershare2.`), under `member`: everything an
 * owner's device holds. A version before members ignores the field and then stops at the share's format.
 */
export function ownerLinkFields(keys: MemberKeys): { member: MemberKeys } {
  if (!keys.root || !keys.key || publicKeyOf(keys.key) !== keys.owner) throw new Error('Only the owner’s devices can make a link for another of the owner’s devices');
  return { member: parseMemberKeys(keys) };
}

/** The owner's keys from an opened owner link's payload, or undefined for an invite of the older kind. */
export function ownerKeysFrom(payload: Record<string, unknown>): MemberKeys | undefined {
  if (payload.member === undefined) return undefined;
  const keys = parseMemberKeys(payload.member);
  if (!keys.root || !keys.key || publicKeyOf(keys.key) !== keys.owner) throw new Error('That owner link is damaged');
  return keys;
}

/** An owner link: `payload` (storage settings and `ownerLinkFields`) sealed under a passphrase. */
export async function sealOwnerLink(payload: Record<string, unknown>, passphrase: string, iterations: number): Promise<string> {
  return OWNER_LINK_PREFIX + (await sealWithPassphrase(JSON.stringify(payload), passphrase, iterations));
}

export async function openOwnerLink(code: string, passphrase: string): Promise<Record<string, unknown>> {
  const text = code.trim();
  if (!text.startsWith(OWNER_LINK_PREFIX)) throw new Error('That is not an owner link');
  return JSON.parse(await openWithPassphrase(text.slice(OWNER_LINK_PREFIX.length), passphrase)) as Record<string, unknown>;
}
