import type { ChunkParams } from './types.ts';

export interface SyncConfig {
  deviceName: string;
  /** Glob patterns. A pattern without `/` matches a file name in any folder. */
  exclude: string[];
  /** Files larger than this are left alone. 0 means no limit. */
  maxFileSizeMB: number;
  /** The app's settings folder. Its files are merged when two devices change them, never copied. */
  configDir: string;
  /** `merge`: three-way text merge, conflict copy when edits overlap. `copy`: always keep both. */
  conflictStrategy: 'merge' | 'copy';
  mergeExtensions: string[];
  compression: boolean;
  packTargetBytes: number;
  /** Chunks at least this large are stored as their own object instead of being packed with others. */
  packMaxBlobBytes: number;
  /** Parallel network requests, and files prepared in parallel. */
  concurrency: number;
  /** Uploads are committed in batches of about this many bytes, so an interrupted sync loses at most one batch. */
  commitBatchBytes: number;
  /** Chunks of one pack closer together than this are fetched in one request. */
  rangeGapBytes: number;
  snapshotEvery: number;
  /** How long old versions stay restorable. At least 1. */
  retentionDays: number;
  /** A sync that would delete more than both of these is refused unless forced. */
  maxDeleteCount: number;
  maxDeleteFraction: number;
  /** Used only when a new remote vault is created. */
  kdfIterations: number;
  chunk: ChunkParams;
}

export const DEFAULT_CONFIG: SyncConfig = {
  deviceName: 'device',
  exclude: ['.self-sync/**', '.obsidian/workspace*.json', '.trash/**', '.git/**', '.DS_Store'],
  configDir: '.obsidian',
  maxFileSizeMB: 500,
  conflictStrategy: 'merge',
  mergeExtensions: ['md', 'markdown', 'txt'],
  compression: true,
  packTargetBytes: 4 << 20,
  packMaxBlobBytes: 64 << 10,
  concurrency: 6,
  commitBatchBytes: 32 << 20,
  rangeGapBytes: 128 << 10,
  snapshotEvery: 100,
  retentionDays: 30,
  maxDeleteCount: 10,
  maxDeleteFraction: 0.5,
  kdfIterations: 600_000,
  chunk: { min: 64 << 10, avg: 256 << 10, max: 1 << 20 },
};

export function resolveConfig(partial: Partial<SyncConfig> = {}): SyncConfig {
  const c = { ...DEFAULT_CONFIG, ...partial };
  c.retentionDays = Math.max(1, c.retentionDays);
  c.concurrency = Math.max(1, c.concurrency);
  return c;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function compileExcludes(patterns: string[]): (path: string) => boolean {
  const full: RegExp[] = [];
  const base: RegExp[] = [];
  for (let p of patterns) {
    p = p.trim();
    if (!p) continue;
    if (p.endsWith('/')) p += '**';
    (p.includes('/') ? full : base).push(globToRegExp(p));
  }
  return (path) => {
    if (full.some((r) => r.test(path))) return true;
    if (!base.length) return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    return base.some((r) => r.test(name));
  };
}
