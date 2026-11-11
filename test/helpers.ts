import { resolveConfig, type SyncConfig } from '../src/core/config.ts';
import { SyncEngine } from '../src/core/engine.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';

export const TEST_CONFIG: Partial<SyncConfig> = {
  kdfIterations: 1000,
  chunk: { min: 4096, avg: 16384, max: 65536 },
  packTargetBytes: 256 << 10,
};

export class Device {
  fs = new MemFS();
  state = new MemState();
  engine!: SyncEngine;
  name: string;
  store: RemoteStore;
  config: SyncConfig;
  clock: { now: number };

  constructor(name: string, store: RemoteStore, clock: { now: number }, config: Partial<SyncConfig> = {}) {
    this.name = name;
    this.store = store;
    this.clock = clock;
    this.config = resolveConfig({ ...TEST_CONFIG, deviceName: name, ...config });
    this.restart();
  }

  /** A fresh engine over the same files and saved state, as after an app restart or crash. */
  restart(): void {
    this.engine = new SyncEngine({
      fs: this.fs,
      store: this.store,
      stateStore: this.state,
      passphrase: 'test passphrase',
      config: this.config,
      now: () => this.clock.now,
    });
  }

  sync(force = false) {
    return this.engine.sync({ force });
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, f] of [...this.fs.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[path] = Buffer.from(f.data).toString('base64');
    }
    return out;
  }
}
