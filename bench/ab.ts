// A/B of a routine sync between two checkouts of this repo, in one process with the calls interleaved, so drift in
// the machine's speed lands on both sides alike. Only the engine comes from each checkout; the vault, the file system,
// storage and the state file are this checkout's, and the same on both sides. Each pair runs every scenario on both
// sides in random order. Reports the median, the median absolute deviation and a paired bootstrap 95% interval of
// B's median over A's.
//   node --expose-gc bench/ab.ts --a=/path/to/baseline/checkout [--b=.] [--notes=10000] [--runs=20] [--json=out.json]
// With --a the same as --b it measures the noise floor.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileState } from '../src/node/nodefs.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS } from '../src/testing/memfs.ts';
import { rng } from '../src/testing/netsim.ts';
import { generateVault } from './gen.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const notes = Number(args.notes ?? 10_000);
const runs = Number(args.runs ?? 20);
const roots = { A: resolve(args.a ?? '.'), B: resolve(args.b ?? '.') };
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');

type Scenario = 'no change, full scan' | 'edit 1 note, full scan' | 'no change, hinted' | 'edit 1 note, hinted';
const SCENARIOS: Scenario[] = ['no change, full scan', 'edit 1 note, full scan', 'no change, hinted', 'edit 1 note, hinted'];

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

const sides = { A: await side(roots.A), B: await side(roots.B) };
const samples: Record<Scenario, Record<'A' | 'B', { cpu: number[]; wall: number[] }>> = Object.fromEntries(
  SCENARIOS.map((s) => [s, { A: { cpu: [], wall: [] }, B: { cpu: [], wall: [] } }]),
) as never;
const coin = rng(Number(args.seed ?? 3));
for (let i = -2; i < runs; i++) {
  for (const s of SCENARIOS) {
    for (const k of coin() < 0.5 ? (['A', 'B'] as const) : (['B', 'A'] as const)) {
      gc();
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

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mad = (xs: number[]) => {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};
/** Paired bootstrap of median(B) / median(A): pairs are resampled together, since they ran side by side. */
function interval(a: number[], b: number[]): [number, number] {
  const r = rng(1);
  const ratios: number[] = [];
  for (let n = 0; n < 4000; n++) {
    const idx = a.map(() => (r() * a.length) | 0);
    ratios.push(median(idx.map((i) => b[i])) / median(idx.map((i) => a[i])));
  }
  ratios.sort((x, y) => x - y);
  return [ratios[Math.floor(0.025 * ratios.length)], ratios[Math.ceil(0.975 * ratios.length) - 1]];
}
const pct = (x: number) => `${x >= 1 ? '+' : '−'}${Math.abs((x - 1) * 100).toFixed(1)}%`;
const verdict = (lo: number, hi: number) => (hi < 1 ? 'B lower' : lo > 1 ? 'B higher' : 'no clear difference');

const report: Record<string, unknown> = { notes, runs, roots };
const table: Record<string, Record<string, string>> = {};
for (const s of SCENARIOS) {
  for (const m of ['cpu', 'wall'] as const) {
    const a = samples[s].A[m];
    const b = samples[s].B[m];
    const [lo, hi] = interval(a, b);
    const ratio = median(b) / median(a);
    report[`${s} ${m}`] = { a, b, ratio, lo, hi };
    table[`${s}: ${m}`] = {
      'A median (MAD)': `${median(a).toFixed(2)} (${mad(a).toFixed(2)})`,
      'B median (MAD)': `${median(b).toFixed(2)} (${mad(b).toFixed(2)})`,
      'B/A': pct(ratio),
      '95% CI': `[${pct(lo)}, ${pct(hi)}]`,
      verdict: verdict(lo, hi),
    };
  }
}
console.log(JSON.stringify({ notes, runs, a: roots.A, b: roots.B }));
console.table(table);
if (args.json) writeFileSync(args.json, JSON.stringify(report));
