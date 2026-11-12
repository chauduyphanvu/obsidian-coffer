import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, utimes, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FileStat, LocalFS, LocalFile, ObjectInfo, RemoteStore, StateStore } from '../core/types.ts';

const toStat = (s: { size: number; mtimeMs: number }): FileStat => ({ size: s.size, mtime: Math.floor(s.mtimeMs) });
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const TMP = '.selfsync-tmp';
/** How long after one of its own writes or removals settles a change event there is still taken for its echo. */
const ECHO_MS = 60_000;

/** What one of this FS's own writes or removals left at a path. */
interface Left {
  /** Its stat, null when absent, undefined when the operation failed. */
  stat: Promise<FileStat | null | undefined>;
  /** When the operation, and the stat after it, finished. */
  settled?: number;
}

export class NodeFS implements LocalFS {
  private root: string;
  /**
   * What this FS last left at each path it wrote or removed, and in the folders above, the oldest first. Only kept
   * once a watcher asks (`rememberOwn`), and each only for `ECHO_MS` after it settled.
   */
  private own?: Map<string, Left>;
  constructor(root: string) {
    this.root = root;
  }
  private abs(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  /** From now on remembers what its own writes and removals leave, so `isOwnChange` can tell their echoes from other changes. */
  rememberOwn(): void {
    this.own ??= new Map();
  }

  /** Whether a change event for `path` is the echo of this FS's own latest write or removal, with nothing since by anyone else. */
  async isOwnChange(path: string): Promise<boolean> {
    if (path.endsWith(TMP)) return true;
    const own = this.own;
    // An operation that starts meanwhile, as a removal beside it changing a folder, replaces what to compare with.
    for (;;) {
      const entry = own?.get(path);
      if (!own || !entry) return false;
      const left = await entry.stat;
      const now = left === undefined ? undefined : await this.stat(path);
      if (own.get(path) !== entry) continue;
      const same = left === null ? now === null : !!left && !!now && now.size === left.size && now.mtime === left.mtime;
      const fresh = Date.now() - entry.settled! <= ECHO_MS;
      // Once someone else changed it, a later change back to what this FS left is theirs too.
      if (!same || !fresh) own.delete(path);
      return same && fresh;
    }
  }

  /** Starts remembering what `path` and its folders look like once `done` settles. A watcher can report the effects before the operation returns, so this runs as it starts. */
  private track(path: string, done: Promise<unknown>): void {
    const own = this.own;
    if (!own) return;
    const now = Date.now();
    for (const [p, e] of own) {
      if (e.settled === undefined || now - e.settled <= ECHO_MS) break;
      own.delete(p);
    }
    for (let p = path; p; p = p.slice(0, Math.max(0, p.lastIndexOf('/')))) {
      const entry: Left = { stat: Promise.all([own.get(p)?.stat, done]).then(() => this.stat(p)).catch(() => undefined) };
      void entry.stat.then(() => (entry.settled = Date.now()));
      // Moved to the end, so the oldest stay first.
      own.delete(p);
      own.set(p, entry);
    }
  }

  async list(): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    const walk = async (dir: string, rel: string) => {
      await Promise.all(
        (await readdir(dir, { withFileTypes: true })).map(async (d) => {
          const path = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) await walk(join(dir, d.name), path);
          // A temporary file of a write that was cut short is not a note.
          else if (d.isFile() && !d.name.endsWith(TMP)) out.push({ path, ...toStat(await stat(join(dir, d.name))) });
        }),
      );
    };
    await walk(this.root, '');
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    return readFile(this.abs(path));
  }

  write(path: string, data: Uint8Array, mtime?: number): Promise<FileStat> {
    const done = this.put(path, data, mtime);
    this.track(path, done);
    return done;
  }

  private async put(path: string, data: Uint8Array, mtime?: number): Promise<FileStat> {
    const abs = this.abs(path);
    await mkdir(dirname(abs), { recursive: true });
    // Write beside the target and rename, so a crash never leaves a half-written note.
    const tmp = `${abs}${TMP}`;
    await writeFile(tmp, data);
    if (mtime !== undefined) await utimes(tmp, mtime / 1000, mtime / 1000);
    await rename(tmp, abs);
    return toStat(await stat(abs));
  }

  remove(path: string): Promise<void> {
    const done = this.drop(path);
    this.track(path, done);
    return done;
  }

  private async drop(path: string): Promise<void> {
    const abs = this.abs(path);
    await unlink(abs).catch((e) => {
      if (!missing(e)) throw e;
    });
    for (let dir = dirname(abs); dir.length > this.root.length && dir.startsWith(this.root + sep); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break; // not empty
      }
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      return toStat(await stat(this.abs(path)));
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }
}

export class FileState implements StateStore {
  private file: string;
  constructor(file: string) {
    this.file = file;
  }
  async load(): Promise<string | null> {
    try {
      return await readFile(this.file, 'utf8');
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }
  async save(data: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, data);
    await rename(`${this.file}.tmp`, this.file);
  }
}

/**
 * A plain folder as the remote: a NAS share, an external drive, or a test directory. The folder itself is
 * created only with `create`, and never once it has been seen: a share or drive that is not mounted must fail,
 * not read as empty storage and fill a stand-in folder with commits other devices never see.
 */
export class FolderStore implements RemoteStore {
  private root: string;
  private create: boolean;
  private seen = false;
  constructor(root: string, opts: { create?: boolean } = {}) {
    this.root = resolve(root);
    this.create = opts.create ?? true;
  }
  private abs(key: string): string {
    return join(this.root, ...key.split('/'));
  }

  /** Throws unless the folder exists, creating it first when allowed. */
  private async checkRoot(): Promise<void> {
    try {
      await stat(this.root);
      this.seen = true;
      return;
    } catch (e) {
      if (!missing(e)) throw e;
    }
    if (!this.create || this.seen) throw new Error(`The storage folder ${this.root} is missing; if it is on a drive or a network share, check that it is mounted`);
    await mkdir(this.root, { recursive: true });
    this.seen = true;
  }

  /** Creates `dir` and the folders above it up to the root, which only `checkRoot` creates. */
  private async mkdirIn(dir: string): Promise<void> {
    if (dir === this.root) return this.checkRoot();
    const make = () => mkdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    try {
      await make();
    } catch (e) {
      if (!missing(e)) throw e;
      await this.mkdirIn(dirname(dir));
      await make();
    }
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Uint8Array | null> {
    try {
      if (!range) return await readFile(this.abs(key));
      const fh = await open(this.abs(key), 'r');
      try {
        const buf = new Uint8Array(range.end - range.start);
        const { bytesRead } = await fh.read(buf, 0, buf.length, range.start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (e) {
      if (!missing(e)) throw e;
      await this.checkRoot();
      return null;
    }
  }

  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }): Promise<boolean> {
    const abs = this.abs(key);
    await this.mkdirIn(dirname(abs));
    if (opts?.ifNoneMatch) {
      try {
        await writeFile(abs, data, { flag: 'wx' });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
    }
    await writeFile(`${abs}.tmp`, data);
    await rename(`${abs}.tmp`, abs);
    return true;
  }

  async delete(key: string): Promise<void> {
    await unlink(this.abs(key)).catch(async (e) => {
      if (!missing(e)) throw e;
      await this.checkRoot();
    });
  }

  async list(prefix: string, startAfter = ''): Promise<ObjectInfo[]> {
    const dir = prefix.replace(/\/$/, '');
    let names: string[];
    try {
      names = await readdir(this.abs(dir));
    } catch (e) {
      if (!missing(e)) throw e;
      await this.checkRoot();
      return [];
    }
    const out: ObjectInfo[] = [];
    for (const name of names.sort()) {
      const key = `${dir}/${name}`;
      if (key <= startAfter || name.endsWith('.tmp')) continue;
      const s = await stat(this.abs(key));
      out.push({ key, size: s.size, modified: Math.floor(s.mtimeMs) });
    }
    return out;
  }
}
