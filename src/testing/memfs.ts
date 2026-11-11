import type { FileStat, LocalFS, LocalFile, StateStore } from '../core/types.ts';

/** In-memory vault for tests and benchmarks. Every write gets a later mtime, like a real clock. */
export class MemFS implements LocalFS {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  clock = 1_700_000_000_000;

  async list(): Promise<LocalFile[]> {
    return [...this.files].map(([path, f]) => ({ path, size: f.data.length, mtime: f.mtime }));
  }
  async read(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT ${path}`);
    return f.data;
  }
  async write(path: string, data: Uint8Array, mtime?: number): Promise<FileStat> {
    if (mtime === undefined) mtime = this.clock += 1000;
    else this.clock = Math.max(this.clock, mtime);
    this.files.set(path, { data, mtime });
    return { size: data.length, mtime };
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async stat(path: string): Promise<FileStat | null> {
    const f = this.files.get(path);
    return f ? { size: f.data.length, mtime: f.mtime } : null;
  }

  put(path: string, text: string | Uint8Array): void {
    this.files.set(path, { data: typeof text === 'string' ? new TextEncoder().encode(text) : text, mtime: (this.clock += 1000) });
  }
  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f && new TextDecoder().decode(f.data);
  }
}

export class MemState implements StateStore {
  data: string | null = null;
  async load() {
    return this.data;
  }
  async save(data: string) {
    this.data = data;
  }
}
