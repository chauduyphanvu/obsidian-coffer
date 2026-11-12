// The fixed cost of a small sync on a large vault: nothing changed, or one note edited, each with and
// without the hint of which paths changed, on a fast local store and over a simulated mobile link.
// The state file goes to disk, as on a device.
//   node --expose-gc bench/incremental.ts [--notes=10000] [--runs=15] [--net=none,mobile] [--out=file.json]
//   node bench/incremental.ts --compare=before.json,after.json
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/core/config.ts';
import { SyncEngine } from '../src/core/engine.ts';
import type { ObjectInfo, RemoteStore } from '../src/core/types.ts';
import { FileState } from '../src/node/nodefs.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS } from '../src/testing/memfs.ts';
import { NET, SimStore, rng } from '../src/testing/netsim.ts';
import { generateVault } from './gen.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));

type Samples = Record<string, { cpu: number[]; wall: number[] }>;

/** Storage that can be pointed elsewhere, so the vault is set up fast and measured over the slow link. */
class Via implements RemoteStore {
  target: RemoteStore;
  constructor(target: RemoteStore) {
    this.target = target;
  }
  get(key: string, range?: { start: number; end: number }) {
    return this.target.get(key, range);
  }
  put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }) {
    return this.target.put(key, data, opts);
  }
  delete(key: string) {
    return this.target.delete(key);
  }
  list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    return this.target.list(prefix, startAfter);
  }
}

const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});

async function measure(notes: number, runs: number, net: string): Promise<Samples> {
  const mem = new MemoryStore();
  const via = new Via(mem);
  const dir = mkdtempSync(join(tmpdir(), 'coffer-bench-'));
  const fs = new MemFS();
  const engine = new SyncEngine({
    fs, store: via, stateStore: new FileState(join(dir, 'state.json')), passphrase: 'benchmark',
    config: resolveConfig({ deviceName: 'A', kdfIterations: 1000 }),
  });
  const vault = generateVault(fs, { notes, seed: 42, imageEvery: 50, largeFile: 0 });
  await engine.sync();
  via.target = new SimStore(mem, NET[net]);
  const rand = rng(7);
  const edit = () => {
    const path = vault.notes[(rand() * vault.notes.length) | 0];
    fs.put(path, `${fs.text(path)}\nEdited ${rand()}.\n`);
    return path;
  };
  const sync = (changed?: string[]) => (engine.sync as (o: object) => Promise<unknown>)(changed ? { changed } : {});
  const scenarios: Record<string, () => Promise<unknown>> = {
    'no change, full scan': () => sync(),
    'no change, hinted': () => sync([]),
    'edit 1 note, full scan': () => (edit(), sync()),
    'edit 1 note, hinted': () => sync([edit()]),
  };
  const out: Samples = {};
  for (const name of Object.keys(scenarios)) out[name] = { cpu: [], wall: [] };
  for (let i = -2; i < runs; i++) {
    for (const [name, run] of Object.entries(scenarios)) {
      gc();
      const cpu0 = process.cpuUsage();
      const t0 = performance.now();
      await run();
      const wall = performance.now() - t0;
      const cpu = process.cpuUsage(cpu0);
      if (i < 0) continue; // warm-up
      out[name].cpu.push((cpu.user + cpu.system) / 1000);
      out[name].wall.push(wall);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  return s[Math.floor(at)] + (s[Math.ceil(at)] - s[Math.floor(at)]) * (at - Math.floor(at));
};
const median = (xs: number[]) => quantile(xs, 0.5);
const f1 = (x: number) => x.toFixed(1);

/** 95% bootstrap interval of the relative change in the median from `a` to `b`. */
function change(a: number[], b: number[]): string {
  const r = rng(1);
  const resample = (xs: number[]) => xs.map(() => xs[(r() * xs.length) | 0]);
  const ratios: number[] = [];
  for (let i = 0; i < 2000; i++) ratios.push(median(resample(b)) / median(resample(a)) - 1);
  const pct = (x: number) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  return `${pct(median(b) / median(a) - 1)} [${pct(quantile(ratios, 0.025))}, ${pct(quantile(ratios, 0.975))}]`;
}

if (args.compare) {
  const [before, after] = args.compare.split(',').map((f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, Samples>);
  const table: Record<string, Record<string, string>> = {};
  for (const net of Object.keys(after)) {
    for (const name of Object.keys(after[net])) {
      const b = after[net][name];
      // The code before the hint existed ignores it, so a hinted run there is a full scan.
      const a = before[net]?.[name] ?? before[net]?.[name.replace('hinted', 'full scan')];
      if (!a) continue;
      table[`${net}: ${name}`] = {
        'cpu ms before': `${f1(median(a.cpu))} (${f1(quantile(a.cpu, 0.25))}–${f1(quantile(a.cpu, 0.75))})`,
        'cpu ms after': `${f1(median(b.cpu))} (${f1(quantile(b.cpu, 0.25))}–${f1(quantile(b.cpu, 0.75))})`,
        'cpu change': change(a.cpu, b.cpu),
        'wall ms before': `${f1(median(a.wall))} (${f1(quantile(a.wall, 0.25))}–${f1(quantile(a.wall, 0.75))})`,
        'wall ms after': `${f1(median(b.wall))} (${f1(quantile(b.wall, 0.25))}–${f1(quantile(b.wall, 0.75))})`,
        'wall change': change(a.wall, b.wall),
      };
    }
  }
  console.table(table);
} else {
  const notes = Number(args.notes ?? 10_000);
  const runs = Number(args.runs ?? 15);
  const all: Record<string, Samples> = {};
  for (const net of (args.net ?? 'none,mobile').split(',')) {
    all[net] = await measure(notes, runs, net);
    const table: Record<string, Record<string, string>> = {};
    for (const [name, s] of Object.entries(all[net])) {
      table[name] = {
        'cpu ms median (IQR)': `${f1(median(s.cpu))} (${f1(quantile(s.cpu, 0.25))}–${f1(quantile(s.cpu, 0.75))})`,
        'wall ms median (IQR)': `${f1(median(s.wall))} (${f1(quantile(s.wall, 0.25))}–${f1(quantile(s.wall, 0.75))})`,
      };
    }
    console.log(JSON.stringify({ notes, runs, net }));
    console.table(table);
  }
  if (args.out) writeFileSync(args.out, JSON.stringify(all));
}
