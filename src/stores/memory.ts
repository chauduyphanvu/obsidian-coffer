import type { ObjectInfo, RemoteStore } from '../core/types.ts';

export class MemoryStore implements RemoteStore {
  objects = new Map<string, { data: Uint8Array; modified: number }>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Uint8Array | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return range ? o.data.slice(range.start, range.end) : o.data.slice();
  }

  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }): Promise<boolean> {
    if (opts?.ifNoneMatch && this.objects.has(key)) return false;
    this.objects.set(key, { data: data.slice(), modified: this.now() });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string, startAfter = ''): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    for (const [key, o] of this.objects) {
      if (key.startsWith(prefix) && key > startAfter) out.push({ key, size: o.data.length, modified: o.modified });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
