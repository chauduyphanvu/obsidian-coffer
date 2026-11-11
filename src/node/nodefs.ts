import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, utimes, writeFile, open } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { FileStat, LocalFS, LocalFile, ObjectInfo, RemoteStore, StateStore } from '../core/types.ts';

const toStat = (s: { size: number; mtimeMs: number }): FileStat => ({ size: s.size, mtime: Math.floor(s.mtimeMs) });
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

export class NodeFS implements LocalFS {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  private abs(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  async list(): Promise<LocalFile[]> {
    const out: LocalFile[] = [];
    const walk = async (dir: string, rel: string) => {
      await Promise.all(
        (await readdir(dir, { withFileTypes: true })).map(async (d) => {
          const path = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) await walk(join(dir, d.name), path);
          else if (d.isFile()) out.push({ path, ...toStat(await stat(join(dir, d.name))) });
        }),
      );
    };
    await walk(this.root, '');
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    return readFile(this.abs(path));
  }

  async write(path: string, data: Uint8Array, mtime?: number): Promise<FileStat> {
    const abs = this.abs(path);
    await mkdir(dirname(abs), { recursive: true });
    // Write beside the target and rename, so a crash never leaves a half-written note.
    const tmp = `${abs}.selfsync-tmp`;
    await writeFile(tmp, data);
    if (mtime !== undefined) await utimes(tmp, mtime / 1000, mtime / 1000);
    await rename(tmp, abs);
    return toStat(await stat(abs));
  }

  async remove(path: string): Promise<void> {
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

/** A plain folder as the remote: a NAS share, an external drive, or a test directory. */
export class FolderStore implements RemoteStore {
  private root: string;
  constructor(root: string) {
    this.root = root;
  }
  private abs(key: string): string {
    return join(this.root, ...key.split('/'));
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
      if (missing(e)) return null;
      throw e;
    }
  }

  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }): Promise<boolean> {
    const abs = this.abs(key);
    await mkdir(dirname(abs), { recursive: true });
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
    await unlink(this.abs(key)).catch((e) => {
      if (!missing(e)) throw e;
    });
  }

  async list(prefix: string, startAfter = ''): Promise<ObjectInfo[]> {
    const dir = prefix.replace(/\/$/, '');
    let names: string[];
    try {
      names = await readdir(this.abs(dir));
    } catch (e) {
      if (missing(e)) return [];
      throw e;
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
