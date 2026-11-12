// One folder of a vault seen as a vault of its own, which is how a shared folder's engine sees it. With folder '',
// the whole vault without its shared folders, which is how the vault's own engine sees it.
import { vaultKey } from './paths.ts';
import type { FileStat, LocalFS, LocalFile } from './types.ts';

/** A file system that can list one folder alone and say when there is no such folder. */
export interface FolderFS extends LocalFS {
  /** The files under `folder`, at any depth, with their full paths; null when the folder does not exist. */
  listFolder(folder: string): Promise<LocalFile[] | null>;
}

/**
 * The folder is not there. Listing it as empty would make every file in it look deleted, and the sync would
 * delete them from storage for everyone else, so the sync stops instead.
 */
export class MissingFolderError extends Error {
  readonly folder: string;
  constructor(folder: string) {
    super(`The folder "${folder}" is missing`);
    this.folder = folder;
  }
}

/** `path` is inside `folder`, compared in NFC like every vault path. */
export const isInside = (folder: string, path: string) => vaultKey(path).startsWith(`${vaultKey(folder)}/`);

/** Inside regardless of case: some file systems ignore it, so a write there would land in the folder. */
const isInsideAnyCase = (folder: string, path: string) => vaultKey(path).toLowerCase().startsWith(`${vaultKey(folder).toLowerCase()}/`);

export class ScopedFS implements LocalFS {
  private inner: FolderFS;
  private at: () => string;
  private mounts: () => string[];

  /**
   * `folder` is read on every call, so a folder renamed while a sync runs is followed at once. `mounts` are all the
   * shared folders; those inside this scope belong to other engines and are neither listed nor written.
   */
  constructor(inner: FolderFS, folder: () => string, mounts: () => string[] = () => []) {
    this.inner = inner;
    this.at = folder;
    this.mounts = mounts;
  }

  get folder(): string {
    return this.at();
  }

  private nested(): string[] {
    const folder = this.folder;
    return this.mounts().filter((m) => m !== folder && (!folder || isInside(folder, m)));
  }

  /** The vault path of `path` in this scope. Refuses a path that would leave it, or enter a shared folder nested in it. */
  pathOf(path: string): string {
    if (path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) throw new Error(`"${path}" is not a path inside the folder`);
    const full = this.folder ? `${this.folder}/${path}` : path;
    const other = this.nested().find((m) => isInsideAnyCase(m, full));
    if (other) throw new Error(`"${path}" is inside the shared folder "${other}"`);
    return full;
  }

  async list(): Promise<LocalFile[]> {
    const folder = this.folder;
    const files = folder ? await this.inner.listFolder(folder) : await this.inner.list();
    if (!files) throw new MissingFolderError(folder);
    const nested = this.nested().map((m) => `${vaultKey(m)}/`);
    if (!folder && !nested.length) return files;
    const start = folder ? `${folder}/` : '';
    const out: LocalFile[] = [];
    for (const f of files) {
      if (!f.path.startsWith(start)) continue;
      if (nested.length) {
        const key = vaultKey(f.path);
        if (nested.some((m) => key.startsWith(m))) continue;
      }
      out.push({ ...f, path: f.path.slice(start.length) });
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    return this.inner.read(this.pathOf(path));
  }

  async write(path: string, data: Uint8Array, mtime?: number): Promise<FileStat> {
    return this.inner.write(this.pathOf(path), data, mtime);
  }

  async remove(path: string): Promise<void> {
    return this.inner.remove(this.pathOf(path));
  }

  async stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(this.pathOf(path));
  }
}
