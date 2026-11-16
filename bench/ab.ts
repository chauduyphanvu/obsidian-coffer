// A/B of a routine sync between two checkouts of this repo. Only the engine comes from each checkout; the vault, the
// file system, storage and the state file are this checkout's, and the same on both sides. Each process sets up both
// sides and runs every scenario on both in random order within each pair, so drift in the machine's speed lands on both
// alike. A process can also settle fast or slow as a whole (how its code was compiled and laid out), so several fresh
// processes run one after another, alternating which side is set up first, and the 95% interval of B's median over A's
// comes from resampling processes and then pairs within them.
//   node bench/ab.ts --a=/path/to/baseline/checkout [--b=.] [--notes=10000] [--procs=6] [--runs=50] [--gc=false] [--json=out.json]
// With --a the same as --b it measures the noise floor. Each call starts after a full garbage collection, as a sync does
// after the app sat idle; --gc=false leaves collection to the engine's own allocations.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileState } from '../src/node/nodefs.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS } from '../src/testing/memfs.ts';
import { rng } from '../src/testing/netsim.ts';
import { generateVault } from './gen.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const notes = Number(args.notes ?? 10_000);
const runs = Number(args.runs ?? 50);
const procs = Number(args.procs ?? 6);
const seed = Number(args.seed ?? 3);
const forceGc = args.gc !== 'false';
const roots = { A: resolve(args.a ?? '.'), B: resolve(args.b ?? '.') };

type Scenario = 'no change, full scan' | 'edit 1 note, full scan' | 'no change, hinted' | 'edit 1 note, hinted';
const SCENARIOS: Scenario[] = ['no change, full scan', 'edit 1 note, full scan', 'no change, hinted', 'edit 1 note, hinted'];
type Side = 'A' | 'B';
type Samples = Record<Scenario, Record<Side, { cpu: number[]; wall: number[] }>>;

async function side(root: string) {
  const { SyncEngine } = await import(pathToFileURL(join(root, 'src/core/engine.ts')).href);
  const { resolveConfig } = await import(pathToFileURL(join(root, 'src/core/config.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'coffer-ab-'));
  const fs = new MemFS();
  const engine = new SyncEngine({
    fs, store: new MemoryStore(), stateStore: new FileState(join(dir, 'state.json')), passphrase: 'benchmark',
    config: resolveConfig({ deviceName: 'A', kdfIterations: 1000 }),
  });
  const vault = generateVault(fs, { notes, seed: 42, imageEvery: 50, largeFile: 0 });
  await engine.sync();
  const rand = rng(7);
  const edit = () => {
    const path = vault.notes[(rand() * vault.notes.length) | 0];
    fs.put(path, `${fs.text(path)}\nEdited ${rand()}.\n`);
    return path;
  };
  const sync = (changed?: string[]) => engine.sync(changed ? { changed } : {});
  const run: Record<Scenario, () => Promise<unknown>> = {
    'no change, full scan': () => sync(),
    'edit 1 note, full scan': () => (edit(), sync()),
    'no change, hinted': () => sync([]),
    'edit 1 note, hinted': () => sync([edit()]),
  };
  return { run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function child(n: number): Promise<Samples> {
  const gc = (globalThis as { gc?: () => void }).gc!;
  const order: Side[] = n % 2 ? ['B', 'A'] : ['A', 'B'];
  const sides = {} as Record<Side, Awaited<ReturnType<typeof side>>>;
  for (const k of order) sides[k] = await side(roots[k]);
  const samples = Object.fromEntries(SCENARIOS.map((s) => [s, { A: { cpu: [], wall: [] }, B: { cpu: [], wall: [] } }])) as unknown as Samples;
  const coin = rng(seed * 1000 + n);
  for (let i = -2; i < runs; i++) {
    for (const s of SCENARIOS) {
      for (const k of coin() < 0.5 ? (['A', 'B'] as const) : (['B', 'A'] as const)) {
        if (forceGc) gc();
        const cpu0 = process.cpuUsage();
        const t0 = performance.now();
        await sides[k].run[s]();
        const wall = performance.now() - t0;
        const cpu = process.cpuUsage(cpu0);
        if (i < 0) continue; // warm-up
        samples[s][k].cpu.push((cpu.user + cpu.system) / 1000);
        samples[s][k].wall.push(wall);
      }
    }
  }
  sides.A.done();
  sides.B.done();
  return samples;
}

if (args.child !== undefined) {
  process.stdout.write(JSON.stringify(await child(Number(args.child))));
} else {
  const perProc: Samples[] = [];
  for (let n = 0; n < procs; n++) {
    const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), ...process.argv.slice(2), `--child=${n}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`child ${n} failed:\n${r.stderr}`);
    perProc.push(JSON.parse(r.stdout));
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mad = (xs: number[]) => {
    const m = median(xs);
    return median(xs.map((x) => Math.abs(x - m)));
  };
  /** Resamples processes, then pairs within each (kept together, since they ran side by side). */
  function interval(a: number[][], b: number[][]): [number, number] {
    const r = rng(1);
    const ratios: number[] = [];
    for (let n = 0; n < 2000; n++) {
      const ra: number[] = [];
      const rb: number[] = [];
      for (let p = 0; p < a.length; p++) {
        const q = (r() * a.length) | 0;
        for (let i = 0; i < a[q].length; i++) {
          const j = (r() * a[q].length) | 0;
          ra.push(a[q][j]);
          rb.push(b[q][j]);
        }
      }
      ratios.push(median(rb) / median(ra));
    }
    ratios.sort((x, y) => x - y);
    return [ratios[Math.floor(0.025 * ratios.length)], ratios[Math.ceil(0.975 * ratios.length) - 1]];
  }
  const pct = (x: number) => `${x >= 1 ? '+' : '−'}${Math.abs((x - 1) * 100).toFixed(1)}%`;
  const verdict = (lo: number, hi: number) => (hi < 1 ? 'B lower' : lo > 1 ? 'B higher' : 'no clear difference');

  const report: Record<string, unknown> = { notes, runs, procs, forceGc, roots };
  const table: Record<string, Record<string, string>> = {};
  for (const s of SCENARIOS) {
    for (const m of ['cpu', 'wall'] as const) {
      const a = perProc.map((p) => p[s].A[m]);
      const b = perProc.map((p) => p[s].B[m]);
      const [lo, hi] = interval(a, b);
      const ratio = median(b.flat()) / median(a.flat());
      report[`${s} ${m}`] = { a, b, ratio, lo, hi };
      table[`${s}: ${m}`] = {
        'A median (MAD)': `${median(a.flat()).toFixed(2)} (${mad(a.flat()).toFixed(2)})`,
        'B median (MAD)': `${median(b.flat()).toFixed(2)} (${mad(b.flat()).toFixed(2)})`,
        'B/A': pct(ratio),
        '95% CI': `[${pct(lo)}, ${pct(hi)}]`,
        'per process': b.map((x, p) => pct(median(x) / median(a[p]))).join(' '),
        verdict: verdict(lo, hi),
      };
    }
  }
  console.log(JSON.stringify({ notes, runs, procs, forceGc, a: roots.A, b: roots.B }));
  console.table(table);
  if (args.json) writeFileSync(args.json, JSON.stringify(report));
}
