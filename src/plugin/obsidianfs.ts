import { requestUrl, type App } from 'obsidian';
import type { FileStat, LocalFS, LocalFile, StateStore } from '../core/types.ts';
import type { Http } from '../stores/s3.ts';

const CONFIG_RESCAN_MS = 5 * 60_000;

const toBuffer = (u: Uint8Array): ArrayBuffer =>
  (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)) as ArrayBuffer;

/** `requestUrl` goes through the app's native side, so it works on mobile where `fetch` is blocked by CORS. */
export const obsidianHttp: Http = async (req) => {
  const r = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body && toBuffer(req.body),
    contentType: 'application/octet-stream',
    throw: false,
  });
  return { status: r.status, body: new Uint8Array(r.arrayBuffer) };
};

export class ObsidianFS implements LocalFS {
  private app: App;
  private includeConfig: boolean;
  private configFiles?: { at: number; files: LocalFile[] };

  constructor(app: App, includeConfig: boolean) {
    this.app = app;
    this.includeConfig = includeConfig;
  }

  /** The settings folder is walked file by file, which is slow on phones, so its listing is reused for a few minutes. */
  forgetConfigListing(): void {
    this.configFiles = undefined;
  }

  async list(): Promise<LocalFile[]> {
    const out: LocalFile[] = this.app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
    if (!this.includeConfig) return out;
    if (!this.configFiles || Date.now() - this.configFiles.at > CONFIG_RESCAN_MS) {
      const files: LocalFile[] = [];
      const adapter = this.app.vault.adapter;
      const walk = async (dir: string) => {
        const listing = await adapter.list(dir);
        for (const path of listing.files) {
          const s = await adapter.stat(path);
          if (s?.type === 'file') files.push({ path, size: s.size, mtime: s.mtime });
        }
        for (const folder of listing.folders) {
          if (!folder.endsWith('/node_modules')) await walk(folder);
        }
      };
      await walk(this.app.vault.configDir);
      this.configFiles = { at: Date.now(), files };
    }
    return out.concat(this.configFiles.files);
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.app.vault.adapter.readBinary(path));
  }

  async write(path: string, data: Uint8Array, mtime?: number): Promise<FileStat> {
    const adapter = this.app.vault.adapter;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    }
    await adapter.writeBinary(path, toBuffer(data), mtime === undefined ? undefined : { mtime });
    const s = await adapter.stat(path);
    if (!s) throw new Error(`Could not write ${path}`);
    return { size: s.size, mtime: s.mtime };
  }

  async remove(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const file = this.app.vault.getAbstractFileByPath(path);
    // Goes wherever the user's "Deleted files" setting says: system trash, the vault's .trash, or gone.
    if (file) await this.app.fileManager.trashFile(file);
    else if (await adapter.exists(path)) await adapter.remove(path);
    // Tidy up folders this left empty, so a folder moved elsewhere does not linger as a husk.
    try {
      for (let dir = path.slice(0, path.lastIndexOf('/')); dir; dir = dir.slice(0, dir.lastIndexOf('/'))) {
        const listing = await adapter.list(dir);
        if (listing.files.length || listing.folders.length) break;
        // Non-recursive rmdir fails with EISDIR on desktop; the folder was just checked to be empty.
        await adapter.rmdir(dir, true);
      }
    } catch {
      // The file is gone, which is what matters.
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    const s = await this.app.vault.adapter.stat(path);
    return s?.type === 'file' ? { size: s.size, mtime: s.mtime } : null;
  }
}

export class PluginState implements StateStore {
  private app: App;
  private path: string;
  constructor(app: App, path: string) {
    this.app = app;
    this.path = path;
  }
  async load(): Promise<string | null> {
    const adapter = this.app.vault.adapter;
    return (await adapter.exists(this.path)) ? adapter.read(this.path) : null;
  }
  async save(data: string): Promise<void> {
    await this.app.vault.adapter.write(this.path, data);
  }
}
