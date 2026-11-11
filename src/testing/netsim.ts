import type { ObjectInfo, RemoteStore } from '../core/types.ts';

export interface NetProfile {
  name: string;
  rttMs: number;
  /** Bytes per second. */
  up: number;
  down: number;
}

export const NET: Record<string, NetProfile> = {
  none: { name: 'none', rttMs: 0, up: Infinity, down: Infinity },
  broadband: { name: 'broadband', rttMs: 30, up: 20e6 / 8, down: 100e6 / 8 },
  mobile: { name: 'mobile', rttMs: 120, up: 5e6 / 8, down: 20e6 / 8 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Counts requests and bytes, and optionally delays each request like a real link would:
 * a fixed round trip per request, plus transfer time on a link shared by all concurrent requests.
 */
export class SimStore implements RemoteStore {
  stats = { get: 0, put: 0, list: 0, delete: 0, up: 0, down: 0 };
  private inner: RemoteStore;
  private net: NetProfile;
  private upFree = 0;
  private downFree = 0;

  constructor(inner: RemoteStore, net: NetProfile = NET.none) {
    this.inner = inner;
    this.net = net;
  }

  reset(): void {
    this.stats = { get: 0, put: 0, list: 0, delete: 0, up: 0, down: 0 };
  }

  private async wait(bytes: number, dir: 'up' | 'down'): Promise<void> {
    this.stats[dir] += bytes;
    if (!this.net.rttMs) return;
    const now = performance.now();
    const rate = this.net[dir];
    const free = dir === 'up' ? 'upFree' : 'downFree';
    this[free] = Math.max(now, this[free]) + (bytes / rate) * 1000;
    await sleep(this[free] - now + this.net.rttMs);
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Uint8Array | null> {
    this.stats.get++;
    const data = await this.inner.get(key, range);
    await this.wait(data?.length ?? 0, 'down');
    return data;
  }
  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }): Promise<boolean> {
    this.stats.put++;
    await this.wait(data.length, 'up');
    return this.inner.put(key, data, opts);
  }
  async delete(key: string): Promise<void> {
    this.stats.delete++;
    await this.wait(0, 'up');
    return this.inner.delete(key);
  }
  async list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    this.stats.list++;
    const out = await this.inner.list(prefix, startAfter);
    await this.wait(out.length * 120, 'down');
    return out;
  }
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fails a fraction of requests, half of them after the request already took effect (a lost reply). */
export class FlakyStore implements RemoteStore {
  rate: number;
  private inner: RemoteStore;
  private rand: () => number;

  constructor(inner: RemoteStore, rand: () => number, rate: number) {
    this.inner = inner;
    this.rand = rand;
    this.rate = rate;
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    const roll = this.rand();
    if (roll < this.rate / 2) throw new Error('injected: request lost');
    const out = await fn();
    if (roll < this.rate) throw new Error('injected: reply lost');
    return out;
  }
  get(key: string, range?: { start: number; end: number }) {
    return this.run(() => this.inner.get(key, range));
  }
  put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    return this.run(() => this.inner.put(key, data, opts));
  }
  delete(key: string) {
    return this.run(() => this.inner.delete(key));
  }
  list(prefix: string, startAfter?: string) {
    return this.run(() => this.inner.list(prefix, startAfter));
  }
}
