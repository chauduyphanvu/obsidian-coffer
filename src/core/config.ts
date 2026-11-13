import type { ChunkParams } from './types.ts';

export interface SyncConfig {
  deviceName: string;
  /** Glob patterns. A pattern without `/` matches a file name in any folder. */
  exclude: string[];
  /** Files larger than this are left alone. 0 means no limit. */
  maxFileSizeMB: number;
  /** Files larger than this stay in storage until asked for with `SyncOptions.fetch`. 0 downloads everything. */
  deferAboveMB: number;
  /** Never writes to storage: local changes stay on this device. See `SyncResult.unsent`. */
  readOnly: boolean;
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
  /** Cleanup copies at most this many bytes of live data into fuller packs per run. */
  compactMaxBytes: number;
  /** A sync that would delete more than both of these is refused unless forced. */
  maxDeleteCount: number;
  maxDeleteFraction: number;
  /** PBKDF2 iterations for a new remote vault, and the least a passphrase change re-wraps its key with. */
  kdfIterations: number;
  chunk: ChunkParams;
}

export const DEFAULT_CONFIG: SyncConfig = {
  deviceName: 'device',
  exclude: ['.coffer/**', '.obsidian/workspace*.json', '.trash/**', '.git/**', '.DS_Store'],
  configDir: '.obsidian',
  maxFileSizeMB: 500,
  deferAboveMB: 0,
  readOnly: false,
  conflictStrategy: 'merge',
  mergeExtensions: ['md', 'markdown', 'txt', 'canvas'],
  compression: true,
  packTargetBytes: 4 << 20,
  packMaxBlobBytes: 64 << 10,
  concurrency: 6,
  commitBatchBytes: 32 << 20,
  rangeGapBytes: 128 << 10,
  snapshotEvery: 100,
  retentionDays: 30,
  compactMaxBytes: 8 << 20,
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

/**
 * `*` matches within a folder name, `?` one character of it, `**` across folders (`**` then `/`: none or any number of
 * whole folders), and `!(a|b)` the rest of a name when that is neither `a` nor `b`.
 */
function globSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const close = ch === '!' && glob[i + 1] === '(' ? glob.indexOf(')', i) : -1;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          re += '(?:.*/)?';
          i++;
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (close > 0) {
      re += `(?!(?:${glob.slice(i + 2, close).split('|').map(globSource).join('|')})(?:/|$))[^/]*`;
      i = close;
    } else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

const globToRegExp = (glob: string) => new RegExp(`^${globSource(glob)}$`);

export function compileExcludes(patterns: string[]): (path: string) => boolean {
  const full: RegExp[] = [];
  const base: RegExp[] = [];
  // Whole paths without wildcards, which can come by the thousand, are looked up rather than matched one by one, also
  // untrimmed: a file name may end with a space.
  const exact = new Set<string>();
  for (const raw of patterns) {
    let p = raw.trim();
    if (!p) continue;
    if (p.endsWith('/')) p += '**';
    if (p.includes('/') && !/[*?]|!\(/.test(p)) exact.add(p).add(raw);
    else (p.includes('/') ? full : base).push(globToRegExp(p));
  }
  return (path) => {
    if (exact.has(path) || full.some((r) => r.test(path))) return true;
    if (!base.length) return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    return base.some((r) => r.test(name));
  };
}
