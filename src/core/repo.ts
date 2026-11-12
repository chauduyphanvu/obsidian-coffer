import { pool, randomBytes, toB64, toHex, utf8 } from './bytes.ts';
import { cutPoints } from './chunker.ts';
import { deflate, inflate } from './compress.ts';
import { chunkId, createKeys, digest, open, rewrapKeys, seal, unlockKeys, type KeyHeader, type Keys } from './crypto.ts';
import type { ChunkParams, Commit, Entry, RemoteStore } from './types.ts';
import { PackTable, decEntry, encEntry, type WireEntry } from './wire.ts';

const FORMAT = 1;
const HEADER_KEY = 'vault.json';
const RESERVED = /^(log|snap|idx|pack)\//;

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
  /** Older versions ignore it, so adding it needed no format change. */
  h?: string;
}

function encCommit(c: Commit): WireCommit {
  const pt = new PackTable();
  const changes = c.changes.map((ch): [string, WireEntry | null] => [ch.path, ch.entry && encEntry(ch.entry, pt)]);
  return { d: c.device, t: c.time, p: pt.list, c: changes, h: c.prev };
}

function decCommit(seq: number, w: WireCommit, hash?: string): Commit {
  return { seq, device: w.d, time: w.t, changes: w.c.map(([path, e]) => ({ path, entry: e && decEntry(e, w.p) })), prev: w.h, hash };
}

export const seqKey = (prefix: 'log' | 'snap' | 'idx', seq: number) => `${prefix}/${String(seq).padStart(12, '0')}`;
const seqOf = (key: string) => Number(key.slice(key.lastIndexOf('/') + 1));

/**
 * Remote layout:
 *   vault.json   key-wrapping header (the only plaintext object)
 *   log/<seq>    one commit each, written create-if-absent: the sequence number is the lock.
 *                Each names the digest of the one before it, so a log cut short or forked shows.
 *   snap/<seq>   full file table at that commit, and that commit's digest, so new devices skip the log
 *   idx/<seq>    the commits of one snapshot interval in a single object, for fast history
 *   pack/<id>    encrypted chunks back to back, addressed by (offset, length)
 *   dev/<id>     one device's heartbeat, an encrypted document
 *   any other    encrypted documents outside the log (readDoc, writeDoc)
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

  private async decodeJson<T>(key: string, raw: Uint8Array): Promise<T> {
    const { plain } = await open(this.keys, raw, `${this.id}:${key}`);
    return JSON.parse(new TextDecoder().decode(await inflate(plain))) as T;
  }

  private async openJson<T>(key: string): Promise<T | null> {
    const raw = await this.store.get(key);
    return raw && this.decodeJson<T>(key, raw);
  }

  async readCommit(seq: number): Promise<Commit | null> {
    const key = seqKey('log', seq);
    const raw = await this.store.get(key);
    if (!raw) return null;
    const [w, hash] = await Promise.all([this.decodeJson<WireCommit>(key, raw), digest(raw)]);
    return decCommit(seq, w, hash);
  }

  /** True when another device has committed past `seq - 1`. Costs one tiny request. */
  async hasCommit(seq: number): Promise<boolean> {
    return (await this.store.get(seqKey('log', seq), { start: 0, end: 1 })) !== null;
  }

  /** The digest of the commit as stored, or null when another device already took this sequence number. */
  async writeCommit(c: Commit): Promise<string | null> {
    const key = seqKey('log', c.seq);
    const sealed = await this.sealJson(key, encCommit(c));
    const hash = await digest(sealed);
    return (await this.store.put(key, sealed, { ifNoneMatch: true })) ? hash : null;
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
    return (await this.readSnapshotWithHead(seq))?.files ?? null;
  }

  /** `head` is the digest of commit `seq`; absent in snapshots written before the log was chained. */
  async readSnapshotWithHead(seq: number): Promise<{ files: Map<string, Entry>; head?: string } | null> {
    const w = await this.openJson<{ p: string[]; f: WireEntry[]; h?: string }>(seqKey('snap', seq));
    if (!w) return null;
    const files = new Map<string, Entry>();
    for (const f of w.f) files.set(f[0] as string, decEntry(f, w.p, 1));
    return { files, head: w.h };
  }

  async writeSnapshot(seq: number, files: Map<string, Entry>, head?: string): Promise<void> {
    const pt = new PackTable();
    const f: WireEntry[] = [];
    for (const [path, e] of files) f.push([path, ...encEntry(e, pt)]);
    const key = seqKey('snap', seq);
    await this.store.put(key, await this.sealJson(key, { p: pt.list, f, h: head }), { ifNoneMatch: true });
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

  /** The id this content is stored under, to check a downloaded chunk against the id it was filed as. */
  chunkId(plain: Uint8Array): Promise<string> {
    return chunkId(this.keys, plain);
  }

  private docKey(key: string): string {
    if (!key || key === HEADER_KEY || RESERVED.test(key)) throw new Error(`"${key}" is not a document key`);
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
    return found.filter((o) => o.key !== HEADER_KEY && !RESERVED.test(o.key)).map((o) => ({ key: o.key, modified: o.modified }));
  }

  async deleteDoc(key: string): Promise<void> {
    await this.store.delete(this.docKey(key));
  }
}
