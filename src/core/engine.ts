import { pool } from './bytes.ts';
import { worthCompressing } from './compress.ts';
import { compileExcludes, type SyncConfig } from './config.ts';
import { merge3 } from './merge.ts';
import { Packer } from './packer.ts';
import { conflictCopyName, ext, vaultKey } from './paths.ts';
import { Repo } from './repo.ts';
import { collectGarbage, listVersions } from './retention.ts';
import { LocalState } from './state.ts';
import {
  hasChunks,
  sameContent,
  type Change,
  type ChunkRef,
  type Commit,
  type Entry,
  type FileStat,
  type LocalFS,
  type LocalFile,
  type RemoteStore,
  type StateStore,
  type Version,
} from './types.ts';

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

export interface SyncResult {
  pushed: number;
  pulled: number;
  deletedLocal: number;
  deletedRemote: number;
  merged: number;
  conflictCopies: string[];
  skipped: number;
  errors: { path: string; message: string }[];
  commits: number;
  rounds: number;
}

/** Thrown instead of syncing when a sync would delete a suspiciously large share of the vault. */
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

interface Local extends LocalFile {
  key: string;
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

const contentKey = (e: Entry) => e.chunks.map((c) => c.id).join(',');

export class SyncEngine {
  private o: EngineOptions;
  private cfg: SyncConfig;
  private excluded: (path: string) => boolean;
  private now: () => number;
  private repo?: Repo;
  private st?: LocalState;
  private dedup?: Map<string, ChunkRef>;

  constructor(options: EngineOptions) {
    this.o = options;
    this.cfg = options.config;
    this.excluded = compileExcludes(this.cfg.exclude);
    this.now = options.now ?? Date.now;
  }

  private log(message: string): void {
    this.o.log?.(message);
  }

  private async open(): Promise<{ repo: Repo; st: LocalState }> {
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
    return { repo: this.repo, st: this.st };
  }

  private async save(): Promise<void> {
    await this.o.stateStore.save(this.st!.serialize());
  }

  /** Brings the cached remote file table up to the newest commit. Returns the paths that changed. */
  private async fetchRemote(): Promise<Set<string>> {
    const { repo, st } = await this.open();
    const touched = new Set<string>();
    const add = (c: Commit) => st.apply(c).forEach((p) => touched.add(p));
    const loadSnapshot = async () => {
      const snaps = await repo.snapshots();
      const latest = snaps[snaps.length - 1];
      if (!latest || latest.seq <= st.lastSeq) return;
      const files = await repo.readSnapshot(latest.seq);
      if (!files) return;
      for (const p of st.remote.keys()) touched.add(p);
      for (const p of files.keys()) touched.add(p);
      st.remote = files;
      st.lastSeq = latest.seq;
    };

    if (st.lastSeq === 0) await loadSnapshot();
    else {
      // The common cases cost one or two cheap GETs: nothing new, or exactly one new commit.
      // Two probes at once: "nothing new" and "exactly one new commit" both finish in a single round trip.
      const [first, second] = await Promise.all([repo.readCommit(st.lastSeq + 1), repo.readCommit(st.lastSeq + 2)]);
      if (!first) return touched;
      add(first);
      if (!second) return touched;
      add(second);
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
      add(c);
    }
    return touched;
  }

  private async scan(): Promise<Map<string, Local>> {
    const maxSize = this.cfg.maxFileSizeMB * (1 << 20) || Infinity;
    const local = new Map<string, Local>();
    for (const f of await this.o.fs.list()) {
      const key = vaultKey(f.path);
      if (this.excluded(key) || f.size > maxSize || local.has(key)) continue;
      local.set(key, { ...f, key });
    }
    return local;
  }

  async sync(opts: { force?: boolean } = {}): Promise<SyncResult> {
    const res: SyncResult = {
      pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0,
      conflictCopies: [], skipped: 0, errors: [], commits: 0, rounds: 0,
    };
    await this.open();
    this.dedup = undefined;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        res.rounds++;
        if (!(await this.round(res, !!opts.force, round === 0))) break;
      }
    } finally {
      this.dedup = undefined;
    }
    return res;
  }

  /** One pass of scan, plan, apply. Returns true when another pass is needed. */
  private async round(res: SyncResult, force: boolean, first: boolean): Promise<boolean> {
    const { repo, st } = await this.open();
    const fs = this.o.fs;
    const maxSize = this.cfg.maxFileSizeMB * (1 << 20) || Infinity;
    const local = await this.scan();

    const pushes: Local[] = [];
    const pushDeletes: string[] = [];
    const pulls: string[] = [];
    const pullDeletes: string[] = [];
    const conflicts: string[] = [];

    const plan = (key: string) => {
      if (this.excluded(key)) return;
      const l = local.get(key);
      const s = st.synced.get(key);
      const r = st.remote.get(key);
      if (r && r.size > maxSize) return;
      const base = s?.entry;
      const localTouched = l ? !s || s.lsize !== l.size || s.lmtime !== l.mtime : !!s;
      const remoteChanged = base ? !r || !sameContent(r, base) : !!r;
      if (!remoteChanged) {
        if (s && r) s.entry = r;
        if (!localTouched) return;
        if (l) pushes.push(l);
        else pushDeletes.push(key);
      } else if (!localTouched) {
        if (r) pulls.push(key);
        else pullDeletes.push(key);
      } else if (!l && !r) st.synced.delete(key);
      else if (!l) pulls.push(key); // deleted here, edited elsewhere: the edit wins
      else if (!r) pushes.push(l); // edited here, deleted elsewhere: the edit wins
      else conflicts.push(key);
    };
    const planAll = () => {
      pushes.length = pushDeletes.length = pulls.length = pullDeletes.length = conflicts.length = 0;
      for (const key of local.keys()) plan(key);
      for (const key of st.synced.keys()) if (!local.has(key)) plan(key);
      for (const key of st.remote.keys()) if (!local.has(key) && !st.synced.has(key)) plan(key);
    };
    planAll();
    // A small local edit is committed without first asking whether the remote moved: the commit
    // itself fails if it did, and the next pass sorts it out. Saves a round trip on the common case.
    const optimistic =
      first && st.lastSeq > 0 && pushes.length + pushDeletes.length > 0 && !pulls.length && !pullDeletes.length && !conflicts.length &&
      pushes.reduce((n, f) => n + f.size, 0) <= OPTIMISTIC_BYTES;
    if (!optimistic && (await this.fetchRemote()).size) planAll();

    if (!pushes.length && !pushDeletes.length && !pulls.length && !pullDeletes.length && !conflicts.length) return false;

    // Guards against a vault that looks empty for the wrong reason (unmounted folder, wrong path,
    // files evicted by another tool). Moves delete and re-create, so net shrinkage is what counts.
    const limit = Math.max(this.cfg.maxDeleteCount, st.synced.size * this.cfg.maxDeleteFraction);
    const localShrink = pullDeletes.length - pulls.length;
    const remoteShrink = pushDeletes.length - pushes.length;
    if (!force && (localShrink > limit || remoteShrink > limit)) throw new SafetyError(pullDeletes.length, pushDeletes.length);

    const fail = (path: string, e: unknown) => {
      res.errors.push({ path, message: e instanceof Error ? e.message : String(e) });
    };
    const unchanged = (cur: FileStat | null, l: Local | undefined) =>
      l ? !!cur && cur.size === l.size && cur.mtime === l.mtime : !cur;
    const byLower = new Map<string, string>();
    for (const key of local.keys()) byLower.set(key.toLowerCase(), key);

    // A file moved on another device arrives as a delete plus a create with the same content.
    // Keep the bytes of files about to be deleted that a pull wants, so a move downloads nothing.
    const wanted = new Set<string>();
    if (pullDeletes.length) for (const key of pulls) wanted.add(contentKey(st.remote.get(key)!));
    const moved = new Map<string, Uint8Array>();
    let movedBytes = 0;

    for (const key of pullDeletes) {
      const l = local.get(key)!;
      try {
        if (!unchanged(await fs.stat(l.path), l)) {
          res.skipped++;
          continue;
        }
        const ck = contentKey(st.synced.get(key)!.entry);
        if (wanted.has(ck) && !moved.has(ck) && movedBytes + l.size <= MOVE_CACHE) {
          moved.set(ck, await fs.read(l.path));
          movedBytes += l.size;
        }
        await fs.remove(l.path);
        st.synced.delete(key);
        local.delete(key);
        byLower.delete(key.toLowerCase());
        res.deletedLocal++;
      } catch (e) {
        fail(key, e);
      }
    }

    const writeRemote = async (key: string, entry: Entry, data: Uint8Array) => {
      const l = local.get(key);
      const other = byLower.get(key.toLowerCase());
      if (!l && other && other !== key) throw new Error(`Name differs only by case from "${other}"`);
      const path = l?.path ?? key;
      if (!unchanged(await fs.stat(path), l)) {
        res.skipped++;
        return;
      }
      const stat = await fs.write(path, data, entry.mtime);
      st.synced.set(key, { entry, lsize: stat.size, lmtime: stat.mtime });
      byLower.set(key.toLowerCase(), key);
      res.pulled++;
      this.o.onProgress?.({ phase: 'download', done: res.pulled, total: pulls.length });
    };

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
      await this.fetchChunks(need.filter((c) => slots.has(c.id)), (ref, plain) => {
        if (plain.length !== ref.size) throw new Error(`Remote chunk ${ref.id} has the wrong size`);
        place(ref.id, plain);
      });
      await pool(batch, this.cfg.concurrency, async (key) => {
        try {
          await writeRemote(key, st.remote.get(key)!, files.get(key)!);
        } catch (err) {
          fail(key, err);
        }
      });
    }
    if (res.pulled || res.deletedLocal) await this.save();

    for (const key of conflicts) {
      try {
        const extra = await this.resolve(key, local.get(key)!, res, writeRemote);
        if (extra) pushes.push(extra);
      } catch (e) {
        fail(key, e);
      }
    }

    const commitsBefore = res.commits;
    let again = false;
    if (pushes.length || pushDeletes.length) again = await this.push(pushes, pushDeletes, res);
    await this.save();
    // An optimistic pass that ended up committing nothing has not looked at the remote at all yet.
    return again || (optimistic && res.commits === commitsBefore);
  }

  /** Both sides changed the same file. Returns a local file that now needs pushing, if any. */
  private async resolve(
    key: string,
    l: Local,
    res: SyncResult,
    writeRemote: (key: string, entry: Entry, data: Uint8Array) => Promise<void>,
  ): Promise<Local | undefined> {
    const { repo, st } = await this.open();
    const fs = this.o.fs;
    const r = st.remote.get(key)!;
    const base = st.synced.get(key)?.entry;
    const mine = await fs.read(l.path);
    const cur = await fs.stat(l.path);
    if (!cur || cur.size !== l.size || cur.mtime !== l.mtime) {
      res.skipped++;
      return;
    }
    const { ids } = await repo.split(mine);
    if (hasChunks(r, ids)) {
      st.synced.set(key, { entry: r, lsize: l.size, lmtime: l.mtime });
      return;
    }

    if (this.cfg.conflictStrategy === 'merge' && base && this.cfg.mergeExtensions.includes(ext(key))) {
      const merged = await this.tryMerge(base, mine, r);
      if (merged) {
        // Fetching the other versions took a moment; do not write over an edit made meanwhile.
        const now = await fs.stat(l.path);
        if (!now || now.size !== l.size || now.mtime !== l.mtime) {
          res.skipped++;
          return;
        }
        const stat = await fs.write(l.path, merged);
        // Recorded as "agrees with remote, then edited", so the merge result is pushed like any local edit.
        st.synced.set(key, { entry: r, lsize: -1, lmtime: -1 });
        res.merged++;
        return { key, path: l.path, ...stat };
      }
    }

    // Keep both: this device's version moves aside, the remote version takes the original name.
    const at = new Date(this.now());
    let copy = conflictCopyName(key, this.cfg.deviceName, at);
    for (let n = 2; await fs.stat(copy); n++) copy = conflictCopyName(key, this.cfg.deviceName, at, n);
    const copyStat = await fs.write(copy, mine, l.mtime);
    await writeRemote(key, r, await this.readVersion(r));
    res.conflictCopies.push(copy);
    return { key: copy, path: copy, ...copyStat };
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

  /** Downloads and decrypts chunks, fetching neighbours in one pack with one request. `sink` gets each chunk once. */
  private async fetchChunks(refs: ChunkRef[], sink: (ref: ChunkRef, plain: Uint8Array) => void): Promise<void> {
    const { repo } = await this.open();
    const byPack = new Map<string, ChunkRef[]>();
    const seen = new Set<string>();
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      let list = byPack.get(ref.pack);
      if (!list) byPack.set(ref.pack, (list = []));
      list.push(ref);
    }
    const ranges: { pack: string; start: number; end: number; refs: ChunkRef[] }[] = [];
    for (const [pack, list] of byPack) {
      list.sort((a, b) => a.off - b.off);
      let cur: (typeof ranges)[number] | undefined;
      for (const ref of list) {
        if (cur && ref.off - cur.end <= this.cfg.rangeGapBytes && ref.off + ref.len - cur.start <= MAX_RANGE) {
          cur.end = ref.off + ref.len;
          cur.refs.push(ref);
        } else ranges.push((cur = { pack, start: ref.off, end: ref.off + ref.len, refs: [ref] }));
      }
    }
    await pool(ranges, this.cfg.concurrency, async (range) => {
      const data = await repo.getPackRange(range.pack, range.start, range.end);
      if (!data) throw new Error(`Remote pack ${range.pack} is missing`);
      for (const ref of range.refs) {
        const at = ref.off - range.start;
        sink(ref, await repo.openChunk(ref.id, data.subarray(at, at + ref.len)));
      }
    });
  }

  /** Uploads local changes in batches, one commit per batch. Returns true when a later pass must look again. */
  private async push(files: Local[], deletes: string[], res: SyncResult): Promise<boolean> {
    const { repo, st } = await this.open();
    if (!this.dedup) {
      this.dedup = new Map();
      for (const e of st.remote.values()) for (const c of e.chunks) this.dedup.set(c.id, c);
    }
    const dedup = this.dedup;
    const packer = new Packer(repo, this.cfg.packTargetBytes, this.cfg.packMaxBlobBytes, this.cfg.concurrency);
    let again = false;

    const prepare = async (f: Local): Promise<Prepared | undefined> => {
      const data = await this.o.fs.read(f.path);
      const cur = await this.o.fs.stat(f.path);
      if (!cur || cur.size !== f.size || cur.mtime !== f.mtime || data.length !== f.size) {
        res.skipped++; // being written right now; the next sync picks it up
        return;
      }
      const { parts, ids } = await repo.split(data);
      const base = st.synced.get(f.key)?.entry;
      if (base && st.remote.get(f.key) && hasChunks(base, ids)) {
        st.synced.set(f.key, { entry: base, lsize: f.size, lmtime: f.mtime }); // touched, not changed
        return;
      }
      const compress = this.cfg.compression && worthCompressing(f.key, f.size);
      const chunks: ChunkRef[] = [];
      for (let i = 0; i < parts.length; i++) {
        let ref = dedup.get(ids[i]);
        if (!ref) {
          const sealed = await repo.sealChunk(ids[i], parts[i], compress);
          ref = dedup.get(ids[i]);
          if (!ref) {
            ref = packer.add(ids[i], sealed, parts[i].length);
            dedup.set(ids[i], ref);
            await packer.backpressure();
          }
        }
        chunks.push(ref);
      }
      return { file: f, entry: { size: f.size, mtime: f.mtime, chunks } };
    };

    let done = 0;
    let pendingDeletes = deletes;
    for (let i = 0; i < files.length || pendingDeletes.length; ) {
      const batch: Local[] = [];
      for (let bytes = 0; i < files.length && (bytes < this.cfg.commitBatchBytes || !batch.length); i++) {
        batch.push(files[i]);
        bytes += files[i].size;
      }
      const prepared: Prepared[] = [];
      await pool(batch, this.cfg.concurrency, async (f) => {
        try {
          const p = await prepare(f);
          if (p) prepared.push(p);
          this.o.onProgress?.({ phase: 'upload', done: ++done, total: files.length });
        } catch (e) {
          res.errors.push({ path: f.key, message: e instanceof Error ? e.message : String(e) });
        }
      });
      await packer.flush();
      if (await this.commit(prepared, pendingDeletes, res)) again = true;
      pendingDeletes = [];
    }
    return again;
  }

  /** Returns true when another device committed first and some of these changes must be re-planned. */
  private async commit(prepared: Prepared[], deletes: string[], res: SyncResult): Promise<boolean> {
    const { repo, st } = await this.open();
    let contended = false;
    while (prepared.length || deletes.length) {
      const changes: Change[] = [
        ...prepared.map((p) => ({ path: p.file.key, entry: p.entry })),
        ...deletes.map((path) => ({ path, entry: null })),
      ];
      const seq = st.lastSeq + 1;
      if (await repo.writeCommit({ seq, device: this.cfg.deviceName, time: this.now(), changes })) {
        st.apply({ seq, device: this.cfg.deviceName, time: 0, changes });
        for (const p of prepared) st.synced.set(p.file.key, { entry: p.entry, lsize: p.file.size, lmtime: p.file.mtime });
        for (const path of deletes) st.synced.delete(path);
        res.pushed += prepared.length;
        res.deletedRemote += deletes.length;
        res.commits++;
        if (seq % this.cfg.snapshotEvery === 0) {
          await repo.writeSnapshot(seq, st.remote);
          await this.writeDigest(seq);
        }
        await this.save();
        return contended;
      }
      // Lost the race for this sequence number. Changes to files the winner did not touch are
      // still valid and go into the next number; the rest go back through planning.
      contended = true;
      const touched = await this.fetchRemote();
      prepared = prepared.filter((p) => !touched.has(p.file.key));
      deletes = deletes.filter((path) => !touched.has(path));
    }
    return contended;
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
      this.log(`Could not write the history index for commit ${seq}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** True when another device has committed since this one last synced. One tiny request, no local scan. */
  async remoteChanged(): Promise<boolean> {
    const { repo, st } = await this.open();
    return repo.hasCommit(st.lastSeq + 1);
  }

  /** Re-encrypts only the key header. Other devices keep working until restarted, then need the new passphrase. */
  async changePassphrase(newPassphrase: string): Promise<void> {
    const { repo } = await this.open();
    await repo.changePassphrase(this.o.passphrase, newPassphrase);
    this.o.passphrase = newPassphrase;
  }

  /** Every version of one file still within the retention window, newest first. */
  async history(path: string): Promise<Version[]> {
    const { repo, st } = await this.open();
    await this.fetchRemote();
    return listVersions(repo, st.lastSeq, path, this.cfg, this.now());
  }

  async readVersion(entry: Entry): Promise<Uint8Array> {
    const out = new Uint8Array(entry.size);
    const at = new Map<string, number[]>();
    let pos = 0;
    for (const c of entry.chunks) {
      at.set(c.id, [...(at.get(c.id) ?? []), pos]);
      pos += c.size;
    }
    await this.fetchChunks(entry.chunks, (ref, plain) => {
      for (const p of at.get(ref.id)!) out.set(plain, p);
    });
    return out;
  }

  /** Deletes stored data that no version inside the retention window needs. */
  async gc(): Promise<{ packsDeleted: number; bytesFreed: number; snapshotsDeleted: number }> {
    const { repo, st } = await this.open();
    await this.fetchRemote();
    return collectGarbage(repo, st, this.cfg, this.now());
  }
}
