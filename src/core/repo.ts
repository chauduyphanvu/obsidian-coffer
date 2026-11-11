import { pool, randomBytes, toB64, toHex, utf8 } from './bytes.ts';
import { cutPoints } from './chunker.ts';
import { deflate, inflate } from './compress.ts';
import { chunkId, createKeys, open, rewrapKeys, seal, unlockKeys, type KeyHeader, type Keys } from './crypto.ts';
import type { ChunkParams, Commit, Entry, RemoteStore } from './types.ts';
import { PackTable, decEntry, encEntry, type WireEntry } from './wire.ts';

const FORMAT = 1;
const HEADER_KEY = 'vault.json';

interface Header {
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
}

function encCommit(c: Commit): WireCommit {
  const pt = new PackTable();
  const changes = c.changes.map((ch): [string, WireEntry | null] => [ch.path, ch.entry && encEntry(ch.entry, pt)]);
  return { d: c.device, t: c.time, p: pt.list, c: changes };
}

function decCommit(seq: number, w: WireCommit): Commit {
  return { seq, device: w.d, time: w.t, changes: w.c.map(([path, e]) => ({ path, entry: e && decEntry(e, w.p) })) };
}

const seqKey = (prefix: string, seq: number) => `${prefix}/${String(seq).padStart(12, '0')}`;
const seqOf = (key: string) => Number(key.slice(key.lastIndexOf('/') + 1));

/**
 * Remote layout:
 *   vault.json   key-wrapping header (the only plaintext object)
 *   log/<seq>    one commit each, written create-if-absent: the sequence number is the lock
 *   snap/<seq>   full file table at that commit, so new devices skip the log
 *   idx/<seq>    the commits of one snapshot interval in a single object, for fast history
 *   pack/<id>    encrypted chunks back to back, addressed by (offset, length)
 * Log objects are never deleted: a missing next key must always mean "nothing newer".
 */
export class Repo {
  readonly id: string;
  private store: RemoteStore;
  private chunk: ChunkParams;
  private keys: Keys;

  private constructor(store: RemoteStore, header: Header, keys: Keys) {
    this.store = store;
    this.id = header.id;
    this.chunk = header.chunk;
    this.keys = keys;
  }

  /** True when the storage already holds a vault, so setup asks for its passphrase rather than a new one. */
  static async exists(store: RemoteStore): Promise<boolean> {
    return (await store.get(HEADER_KEY)) !== null;
  }

  static async open(store: RemoteStore, passphrase: string, create: { kdfIterations: number; chunk: ChunkParams }): Promise<Repo> {
    let raw = await store.get(HEADER_KEY);
    if (!raw) {
      const { header: kdf, keys } = await createKeys(passphrase, create.kdfIterations);
      const header: Header = { format: FORMAT, id: toB64(randomBytes(12)), kdf, chunk: create.chunk };
      if (await store.put(HEADER_KEY, utf8.encode(JSON.stringify(header)), { ifNoneMatch: true })) {
        return new Repo(store, header, keys);
      }
      raw = await store.get(HEADER_KEY);
      if (!raw) throw new Error('Remote vault header vanished while it was being created');
    }
    const header = JSON.parse(new TextDecoder().decode(raw)) as Header;
    if (header.format !== FORMAT) throw new Error(`Remote vault uses format ${header.format}; this version reads format ${FORMAT}`);
    return new Repo(store, header, await unlockKeys(header.kdf, passphrase));
  }

  private async sealJson(key: string, value: unknown): Promise<Uint8Array> {
    return seal(this.keys, await deflate(utf8.encode(JSON.stringify(value))), `${this.id}:${key}`);
  }

  private async openJson<T>(key: string): Promise<T | null> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    const { plain } = await open(this.keys, raw, `${this.id}:${key}`);
    return JSON.parse(new TextDecoder().decode(await inflate(plain))) as T;
  }

  async readCommit(seq: number): Promise<Commit | null> {
    const w = await this.openJson<WireCommit>(seqKey('log', seq));
    return w && decCommit(seq, w);
  }

  /** True when another device has committed past `seq - 1`. Costs one tiny request. */
  async hasCommit(seq: number): Promise<boolean> {
    return (await this.store.get(seqKey('log', seq), { start: 0, end: 1 })) !== null;
  }

  /** False when another device already took this sequence number. */
  async writeCommit(c: Commit): Promise<boolean> {
    const key = seqKey('log', c.seq);
    return this.store.put(key, await this.sealJson(key, encCommit(c)), { ifNoneMatch: true });
  }

  /** The `count` commits ending at `seq` in one object, so history does not fetch them one by one. */
  async writeDigest(seq: number, commits: Commit[]): Promise<void> {
    const key = seqKey('idx', seq);
    await this.store.put(key, await this.sealJson(key, commits.map(encCommit)));
  }

  async readDigest(seq: number, count: number): Promise<Commit[] | null> {
    const w = await this.openJson<WireCommit[]>(seqKey('idx', seq));
    if (!w || w.length !== count) return null;
    return w.map((c, i) => decCommit(seq - count + 1 + i, c));
  }

  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    const raw = await this.store.get(HEADER_KEY);
    if (!raw) throw new Error('Remote vault header is missing');
    const header = JSON.parse(new TextDecoder().decode(raw)) as Header;
    header.kdf = await rewrapKeys(header.kdf, oldPassphrase, newPassphrase);
    await this.store.put(HEADER_KEY, utf8.encode(JSON.stringify(header)));
  }

  async commitSeqsAfter(seq: number): Promise<number[]> {
    return (await this.store.list('log/', seqKey('log', seq))).map((o) => seqOf(o.key));
  }

  async snapshots(): Promise<{ seq: number; modified: number }[]> {
    return (await this.store.list('snap/')).map((o) => ({ seq: seqOf(o.key), modified: o.modified }));
  }

  async readSnapshot(seq: number): Promise<Map<string, Entry> | null> {
    const w = await this.openJson<{ p: string[]; f: WireEntry[] }>(seqKey('snap', seq));
    if (!w) return null;
    const files = new Map<string, Entry>();
    for (const f of w.f) files.set(f[0] as string, decEntry(f, w.p, 1));
    return files;
  }

  async writeSnapshot(seq: number, files: Map<string, Entry>): Promise<void> {
    const pt = new PackTable();
    const f: WireEntry[] = [];
    for (const [path, e] of files) f.push([path, ...encEntry(e, pt)]);
    const key = seqKey('snap', seq);
    await this.store.put(key, await this.sealJson(key, { p: pt.list, f }), { ifNoneMatch: true });
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
    const ids: string[] = new Array(parts.length);
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
    return flag === 1 ? inflate(plain) : plain;
  }
}
