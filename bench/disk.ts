// Real files on a real disk, in a fresh process, to measure what the in-memory benchmark cannot:
// scan time over a real folder tree and the engine's own peak memory.
//   node --expose-gc bench/disk.ts --dir=/some/scratch/dir [--notes=10000] [--largeFile=200000000]
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveConfig, type SyncConfig } from '../src/core/config.ts';
import { SyncEngine } from '../src/core/engine.ts';
import { FileState, FolderStore, NodeFS } from '../src/node/nodefs.ts';
import { MemFS } from '../src/testing/memfs.ts';
import { generateVault } from './gen.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const root = args.dir;
if (!root) throw new Error('--dir is required');
const config: Partial<SyncConfig> = { kdfIterations: 1000 };
for (const [k, v] of Object.entries(args)) if (k.startsWith('c.')) (config as Record<string, unknown>)[k.slice(2)] = Number(v);

await rm(root, { recursive: true, force: true });
{
  const mem = new MemFS();
  const v = generateVault(mem, { notes: Number(args.notes ?? 10000), seed: 42, imageEvery: 50, largeFile: Number(args.largeFile ?? 200e6) });
  for (const [path, f] of mem.files) {
    await mkdir(dirname(join(root, 'a', path)), { recursive: true });
    await writeFile(join(root, 'a', path), f.data);
  }
  console.log(`vault on disk: ${mem.files.size} files, ${(v.bytes / 1e6).toFixed(0)} MB`);
}
await mkdir(join(root, 'b'));
(globalThis as { gc?: () => void }).gc?.();

const store = new FolderStore(join(root, 'remote'));
const engine = (name: string) =>
  new SyncEngine({ fs: new NodeFS(join(root, name)), store, stateStore: new FileState(join(root, `${name}-state.json`)), passphrase: 'bench', config: resolveConfig({ deviceName: name, ...config }) });
const a = engine('a');
const b = engine('b');

async function measure(label: string, fn: () => Promise<unknown>) {
  (globalThis as { gc?: () => void }).gc?.();
  // ArrayBuffer memory is where file contents live; RSS also counts garbage not yet collected.
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 5);
  const t = performance.now();
  await fn();
  clearInterval(timer);
  console.log(`${label.padEnd(22)} ${String(Math.round(performance.now() - t)).padStart(6)} ms   peak buffer memory +${Math.round((peak - base) / 1e6)} MB`);
}

await measure('first upload', () => a.sync());
await measure('new device download', () => b.sync());
await measure('nothing changed', () => a.sync());
await measure('nothing changed (2nd)', () => a.sync());
await rm(root, { recursive: true, force: true });
