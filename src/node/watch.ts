import { watch, type FSWatcher } from 'node:fs';
import { basename, sep } from 'node:path';
import { SafetyError, type SyncResult } from '../core/engine.ts';
import type { NodeFS } from './nodefs.ts';

const BACKOFF_START = 5_000;
const BACKOFF_CAP = 5 * 60_000;

export interface LoopOptions {
  sync: () => Promise<SyncResult>;
  remoteChanged: () => Promise<boolean>;
  onResult: (r: SyncResult) => void;
  /** `retryMs` is when it will be tried again; undefined when it waits for a change instead. */
  onFailure: (e: unknown, retryMs?: number) => void;
  /** How long local changes must stop before they are synced. */
  debounceMs: number;
  pollMs: number;
  /** A full sync this often, for changes the watcher missed. */
  intervalMs: number;
}

/** Decides when to sync: once at the start, then after local changes settle, when the remote moves, and on a slow timer. */
export class SyncLoop {
  private o: LoopOptions;
  private running = false;
  private current?: Promise<void>;
  /** A change arrived during the sync, so one more is due after it. */
  private again = false;
  /** A sync refused to delete many files; nothing is retried until a local change. */
  private blocked = false;
  private failures = 0;
  private stopped = false;
  private polling = false;
  private poller?: NodeJS.Timeout;
  private full?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;

  constructor(options: LoopOptions) {
    this.o = options;
  }

  start(): void {
    this.poller = setInterval(() => void this.poll(), this.o.pollMs);
    this.full = setInterval(() => this.request(), this.o.intervalMs);
    this.request();
  }

  /** A file in the vault changed. */
  changed(): void {
    if (this.stopped) return;
    this.blocked = false;
    if (this.running) this.again = true;
    else this.settle();
  }

  /** Stops scheduling and resolves once a sync in progress has finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.poller);
    clearInterval(this.full);
    clearTimeout(this.debounce);
    clearTimeout(this.retry);
    await this.current;
  }

  private settle(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.request(), this.o.debounceMs);
  }

  /** Never two syncs at once, and none while waiting out a failure or a refusal. */
  private request(): void {
    if (this.stopped || this.running || this.blocked || this.retry) return;
    this.running = true;
    this.current = this.run();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.running || this.polling || this.blocked || this.retry) return;
    this.polling = true;
    try {
      if (await this.o.remoteChanged()) this.request();
    } catch {
      // Offline: the next sync reports it.
    } finally {
      this.polling = false;
    }
  }

  private async run(): Promise<void> {
    clearTimeout(this.debounce);
    this.again = false;
    try {
      const r = await this.o.sync();
      this.failures = 0;
      this.o.onResult(r);
    } catch (e) {
      if (e instanceof SafetyError) {
        this.failures = 0;
        this.blocked = true;
        this.o.onFailure(e);
      } else {
        const ms = Math.min(BACKOFF_START * 2 ** this.failures++, BACKOFF_CAP);
        this.o.onFailure(e, ms);
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.request();
        }, ms);
      }
    }
    this.running = false;
    if (this.again && !this.stopped) {
      this.blocked = false;
      this.settle();
    }
  }
}

/** Reports each change in the vault except in the state folder and the echoes of `fs`'s own writes. A path of '' is a change of unknown location. */
export function watchVault(root: string, fs: NodeFS, stateDir: string, onChange: (path: string) => void, onError: (e: Error) => void): FSWatcher {
  const self = basename(root);
  const changed = async (path: string) => {
    if (path === stateDir || path.startsWith(`${stateDir}/`)) return;
    // macOS reports the folder itself, by its own name, whenever something directly inside it changes; that thing has its own event.
    if (path === self && !(await fs.stat(path))) return;
    if (!path || !(await fs.isOwnChange(path))) onChange(path);
  };
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    void changed(name?.split(sep).join('/') ?? '').catch(() => onChange(''));
  });
  watcher.on('error', onError);
  return watcher;
}
