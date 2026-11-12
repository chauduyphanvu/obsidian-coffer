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
}

export interface Version {
  seq: number;
  time: number;
  device: string;
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
  /** With `ifNoneMatch`, resolves to false (and writes nothing) when the key already exists. */
  put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix`, in ascending key order, strictly after `startAfter` when given. */
  list(prefix: string, startAfter?: string): Promise<ObjectInfo[]>;
}

export interface FileStat {
  size: number;
  mtime: number;
}

export interface LocalFile extends FileStat {
  path: string;
}

export interface LocalFS {
  list(): Promise<LocalFile[]>;
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
