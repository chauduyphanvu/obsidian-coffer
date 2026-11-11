import { resolveConfig } from '../core/config.ts';
import { SyncEngine } from '../core/engine.ts';
import { MemoryStore } from '../stores/memory.ts';
import { MemFS, MemState } from './memfs.ts';
import { FlakyStore, rng } from './netsim.ts';

export interface FuzzOptions {
  devices: number;
  steps: number;
  /** Fraction of remote requests that fail, half of them after taking effect. */
  faultRate: number;
  /** Fraction of local state saves that fail, as if the app died before writing. */
  crashRate: number;
}

export interface FuzzReport {
  seed: number;
  ok: boolean;
  problems: string[];
  syncs: number;
  failedSyncs: number;
  merges: number;
  conflictCopies: number;
  files: number;
  tokens: number;
}

/**
 * Random edits, deletes, moves and syncs on several devices, with injected network failures and
 * crashes, then a quiet period. Afterwards every device and a brand-new device must hold the same
 * vault, and every line anyone wrote must still exist somewhere unless a device that had seen that
 * line deleted it.
 */
export async function fuzz(seed: number, o: FuzzOptions): Promise<FuzzReport> {
  const rand = rng(seed);
  const pick = (n: number) => (rand() * n) | 0;
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const config = (name: string) =>
    resolveConfig({
      deviceName: name,
      kdfIterations: 1000,
      chunk: { min: 2048, avg: 8192, max: 32768 },
      packTargetBytes: 16 << 10,
      packMaxBlobBytes: 6 << 10,
      snapshotEvery: 7,
      maxDeleteFraction: 2,
      maxDeleteCount: 1e9,
    });

  const devices = Array.from({ length: o.devices }, (_, i) => {
    const fs = new MemFS();
    fs.clock += i * 137; // devices do not share a clock
    const state = new MemState();
    const store = new FlakyStore(mem, rand, o.faultRate);
    const save = state.save.bind(state);
    const d = {
      name: `D${i}`, fs, state, store, crash: o.crashRate,
      engine: undefined as unknown as SyncEngine,
      restart() {
        d.engine = new SyncEngine({ fs, store, stateStore: state, passphrase: 'pw', config: config(d.name), now: () => clock.now });
      },
    };
    state.save = async (data) => {
      if (rand() < d.crash) throw new Error('injected: crash before state was saved');
      return save(data);
    };
    d.restart();
    return d;
  });

  let nextToken = 0;
  const allowedLost = new Set<string>();
  const report: FuzzReport = { seed, ok: true, problems: [], syncs: 0, failedSyncs: 0, merges: 0, conflictCopies: 0, files: 0, tokens: 0 };
  const token = () => `tok${nextToken++}`;
  const tokensIn = (text: string) => text.match(/tok\d+/g) ?? [];
  const paths = Array.from({ length: 10 }, (_, i) => `${['', 'dir/', 'dir/sub/'][i % 3]}n${i}.md`);

  for (let step = 0; step < o.steps; step++) {
    clock.now += 1000 + pick(60_000);
    const d = devices[pick(devices.length)];
    const existing = [...d.fs.files.keys()].filter((p) => p.endsWith('.md'));
    const op = pick(10);
    if (op < 3) {
      // Often several devices sync at the same moment, so they race for the same commit number.
      const group = pick(3) ? [d] : devices.filter((x) => x === d || pick(2));
      await Promise.all(
        group.map(async (x) => {
          report.syncs++;
          try {
            const r = await x.engine.sync();
            report.merges += r.merged;
            report.conflictCopies += r.conflictCopies.length;
          } catch {
            report.failedSyncs++;
            x.restart();
          }
        }),
      );
    } else if (op < 5 || !existing.length) {
      const path = paths[pick(paths.length)];
      if (!d.fs.files.has(path)) d.fs.put(path, `${token()}\n${token()}\n${token()}\n`);
    } else {
      const path = existing[pick(existing.length)];
      const lines = d.fs.text(path)!.split('\n').filter(Boolean);
      if (op < 8) {
        lines.splice(pick(lines.length + 1), 0, token());
        d.fs.put(path, lines.map((l) => `${l}\n`).join(''));
      } else if (op === 8 && lines.length) {
        for (const t of tokensIn(lines.splice(pick(lines.length), 1)[0])) allowedLost.add(t);
        d.fs.put(path, lines.map((l) => `${l}\n`).join(''));
      } else if (pick(2)) {
        for (const t of tokensIn(d.fs.text(path)!)) allowedLost.add(t);
        d.fs.files.delete(path);
      } else {
        const to = paths[pick(paths.length)];
        if (!d.fs.files.has(to)) {
          d.fs.put(to, d.fs.files.get(path)!.data);
          d.fs.files.delete(path);
        }
      }
    }
    if (pick(25) === 0) d.fs.put(`bin${pick(3)}.dat`, Uint8Array.from({ length: 500 + pick(20_000) }, () => pick(256)));
  }

  // Quiet period: no faults, sync until a full pass over all devices changes nothing.
  for (const d of devices) {
    d.store.rate = 0;
    d.crash = 0;
    d.restart();
  }
  let settled = false;
  for (let pass = 0; pass < 12 && !settled; pass++) {
    settled = true;
    for (const d of devices) {
      const r = await d.engine.sync();
      report.merges += r.merged;
      report.conflictCopies += r.conflictCopies.length;
      if (r.errors.length) report.problems.push(`${d.name}: ${r.errors[0].path}: ${r.errors[0].message}`);
      if (r.pushed + r.pulled + r.deletedLocal + r.deletedRemote + r.merged + r.skipped) settled = false;
    }
  }
  if (!settled) report.problems.push('devices never settled');

  const view = (fs: MemFS) =>
    JSON.stringify([...fs.files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => [p.normalize('NFC'), Buffer.from(f.data).toString('base64')]));
  const reference = view(devices[0].fs);
  for (const d of devices.slice(1)) if (view(d.fs) !== reference) report.problems.push(`${d.name} differs from D0`);

  const fresh = new MemFS();
  await new SyncEngine({ fs: fresh, store: mem, stateStore: new MemState(), passphrase: 'pw', config: config('fresh'), now: () => clock.now }).sync();
  if (view(fresh) !== reference) report.problems.push('a new device does not get the same vault');

  const everything = [...devices[0].fs.files.values()].map((f) => new TextDecoder().decode(f.data)).join('\n');
  const present = new Set(tokensIn(everything));
  for (let i = 0; i < nextToken; i++) {
    if (!present.has(`tok${i}`) && !allowedLost.has(`tok${i}`)) report.problems.push(`lost tok${i}`);
  }
  report.files = devices[0].fs.files.size;
  report.tokens = nextToken;
  report.ok = report.problems.length === 0;
  return report;
}
