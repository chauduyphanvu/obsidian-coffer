import { equalBytes } from './bytes.ts';
import type { MemberList } from './members.ts';

export interface ChunkRef {
  id: string;
  pack: string;
  off: number;
  /** Stored (encrypted) length. */
  len: number;
  /** Plaintext length, so a file can be assembled in place while its chunks are still arriving. */
  size: number;
}

export interface Entry {
  size: number;
  mtime: number;
  chunks: ChunkRef[];
}

export interface Change {
  path: string;
  entry: Entry | null;
}

export interface Commit {
  seq: number;
  device: string;
  time: number;
  changes: Change[];
  /** `hash` of the commit before this one, '' for the first. Absent in commits written before the log was chained. */
  prev?: string;
  /** Digest of this commit as stored. Known for commits read from or written to the log. */
  hash?: string;
  /**
   * Only moves stored data: every entry has the content it had before, at new locations. Not a change
   * anyone made, so it is not a moment or a version in history and does not count as activity.
   */
  moved?: boolean;
  /**
   * Every deletion in it is one the user confirmed on the device that made it, as by restoring an earlier
   * time (`allowDeletes`), never one that device only saw happen. Other devices do not count these
   * deletions toward their guard against mass deletion.
   */
  confirmed?: boolean;
  /** Member shares: the member whose key signed it (`members.ts`), and the signature. */
  signer?: string;
  sig?: string;
  /** Member shares: the member change in force when it was written, 0 before the first. */
  listSeq?: number;
  /**
   * Set on a member change: a commit of the share's owner that changes no file, marked `moved` so history passes
   * over it, and carries the whole member list from here on.
   */
  members?: MemberList;
}

export interface Version {
  seq: number;
  time: number;
  device: string;
  /** Member shares: the member who signed the commit that saved it. */
  signer?: string;
  entry: Entry | null;
}

export interface ObjectInfo {
  key: string;
  size: number;
  modified: number;
}

/** Any object store with read-after-write consistency and an atomic create-if-absent put. */
export interface RemoteStore {
  /** `range.end` is exclusive. Resolves to null when the key does not exist. */
  get(key: string, range?: { start: number; end: number }): Promise<Uint8Array | null>;
  /**
   * With `ifNoneMatch`, resolves to false (and writes nothing) when the key already exists. With `contentType`, a store
   * that serves its objects to browsers records it as the object's type; others ignore it.
   */
  put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean; contentType?: string }): Promise<boolean>;
  /** With `once`, a store that retries failed requests makes a single attempt: for a delete that must not be repeated after it may have taken effect. */
  delete(key: string, opts?: { once?: boolean }): Promise<void>;
  /** Keys under `prefix`, in ascending key order, strictly after `startAfter` when given. */
  list(prefix: string, startAfter?: string): Promise<ObjectInfo[]>;
  /** Set on a store that cannot list, only read by name: the repo then finds the log's end by asking for each commit. */
  readonly noList?: boolean;
}

/** Thrown by a store made with `readOnlyStore` when something tries to write to it. */
export class ReadOnlyError extends Error {
  constructor() {
    super('This device only reads from storage, so nothing was written to it');
  }
}

/** `store` as seen by a device that never writes: reads and listings go through, and a write fails before it is sent. */
export function readOnlyStore(store: RemoteStore): RemoteStore {
  return {
    get: (key, range) => store.get(key, range),
    list: (prefix, startAfter) => store.list(prefix, startAfter),
    put: () => Promise.reject(new ReadOnlyError()),
    delete: () => Promise.reject(new ReadOnlyError()),
    ...(store.noList && { noList: true }),
  };
}

/**
 * Creates `key` with `data` unless it exists, and says whether storage now holds this write. A store that retries sends
 * the request again when a reply is lost, and the second try finds the first one's object: so "already there" is
 * checked against what is there, which is this write when it is these very bytes. Every caller's data is its own: sealed
 * under a random nonce, or holding a random id.
 */
export async function putNew(store: RemoteStore, key: string, data: Uint8Array): Promise<boolean> {
  if (await store.put(key, data, { ifNoneMatch: true })) return true;
  const there = await store.get(key);
  return !!there && equalBytes(there, data);
}

export interface FileStat {
  size: number;
  mtime: number;
}

export interface LocalFile extends FileStat {
  path: string;
}

/**
 * The files a sync engine holds, as synced or as in storage, by key: the size and time it last saw each have here, or
 * storage's for one it never synced here.
 */
export interface Held {
  get(key: string): FileStat | undefined;
  keys(): Iterable<string>;
  /**
   * Names content, where the engine can: `of` the content held at a key, `id` that of some bytes. Equal names, equal
   * content; no storage is asked.
   */
  content?: { of(key: string): string | undefined; id(data: Uint8Array): Promise<string> };
}

export interface LocalFS {
  /**
   * The engine passes what it holds. A file system that chooses which files it shows must show every held file that
   * exists: one left out reads as deleted here.
   */
  list(held?: Held): Promise<LocalFile[]>;
  read(path: string): Promise<Uint8Array>;
  /** Creates parent folders as needed and returns the resulting stat. */
  write(path: string, data: Uint8Array, mtime?: number): Promise<FileStat>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
}

export interface StateStore {
  load(): Promise<string | null>;
  save(data: string): Promise<void>;
}

export interface ChunkParams {
  min: number;
  avg: number;
  max: number;
}

export function sameContent(a: Entry, b: Entry): boolean {
  if (a === b) return true;
  if (a.size !== b.size || a.chunks.length !== b.chunks.length) return false;
  for (let i = 0; i < a.chunks.length; i++) if (a.chunks[i].id !== b.chunks[i].id) return false;
  return true;
}

/** True when `ids` are exactly the chunks of `e`, in order. */
export function hasChunks(e: Entry, ids: string[]): boolean {
  return ids.length === e.chunks.length && ids.every((id, i) => id === e.chunks[i].id);
}
