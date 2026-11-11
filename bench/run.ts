import { resolveConfig, type SyncConfig } from '../src/core/config.ts';
import { SyncEngine } from '../src/core/engine.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { NET, SimStore } from '../src/testing/netsim.ts';
import { generateVault } from './gen.ts';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const num = (k: string, d: number) => (k in args ? Number(args[k]) : d);

export interface Row {
  scenario: string;
  ms: number;
  cpuMs: number;
  writes: number;
  reads: number;
  upKB: number;
  downKB: number;
}

function device(name: string, store: SimStore, config: Partial<SyncConfig>) {
  const fs = new MemFS();
  const state = new MemState();
  const engine = new SyncEngine({ fs, store, stateStore: state, passphrase: 'benchmark', config: resolveConfig({ deviceName: name, ...config }) });
  return { fs, state, engine };
}

export async function run(o: { notes: number; net: string; imageEvery: number; largeFile: number; config: Partial<SyncConfig>; quiet?: boolean }) {
  const mem = new MemoryStore();
  const store = new SimStore(mem, NET[o.net]);
  const a = device('A', store, o.config);
  const b = device('B', store, o.config);
  const vault = generateVault(a.fs, { notes: o.notes, seed: 42, imageEvery: o.imageEvery, largeFile: o.largeFile });
  const rows: Row[] = [];
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 20);

  const measure = async (scenario: string, fn: () => Promise<unknown>) => {
    store.reset();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    await fn();
    const ms = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const s = store.stats;
    rows.push({
      scenario, ms: Math.round(ms), cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      writes: s.put + s.list + s.delete, reads: s.get, upKB: Math.round(s.up / 1024), downKB: Math.round(s.down / 1024),
    });
  };
  const edit = (path: string, i: number) => {
    const text = a.fs.text(path)!;
    const at = text.indexOf('\n\n', text.length >> 1);
    a.fs.put(path, `${text.slice(0, at)}\n\nEdited paragraph ${i}: the quick brown fox jumps over the lazy dog.${text.slice(at)}`);
  };

  await measure('first upload', () => a.engine.sync());
  await measure('new device download', () => b.engine.sync());
  await measure('nothing changed', () => a.engine.sync());

  edit(vault.notes[7], 0);
  await measure('edit 1 note: push', () => a.engine.sync());
  await measure('edit 1 note: pull', () => b.engine.sync());

  const many = Math.min(100, vault.notes.length >> 1);
  for (let i = 0; i < many; i++) edit(vault.notes[i * 2 + 1], i);
  await measure(`edit ${many} notes: push`, () => a.engine.sync());
  await measure(`edit ${many} notes: pull`, () => b.engine.sync());

  const folder = vault.notes[0].slice(0, vault.notes[0].indexOf('/'));
  let moved = 0;
  for (const [path, f] of [...a.fs.files]) {
    if (!path.startsWith(`${folder}/`)) continue;
    a.fs.files.delete(path);
    a.fs.files.set(`Renamed ${path}`, f);
    moved++;
  }
  await measure(`move folder (${moved} files): push`, () => a.engine.sync());
  await measure(`move folder (${moved} files): pull`, () => b.engine.sync());

  const photo = new Uint8Array(2_000_000);
  for (let i = 0; i < photo.length; i += 65536) crypto.getRandomValues(photo.subarray(i, Math.min(photo.length, i + 65536)));
  a.fs.put('Attachments/new photo.jpg', photo);
  await measure('add 2 MB photo: push', () => a.engine.sync());
  await measure('add 2 MB photo: pull', () => b.engine.sync());

  if (o.largeFile) {
    const big = a.fs.files.get('Attachments/recording.mp4')!.data;
    const edited = new Uint8Array(big.length + 100);
    edited.set(big.subarray(0, big.length >> 1));
    edited.set(big.subarray(big.length >> 1), (big.length >> 1) + 100);
    a.fs.put('Attachments/recording.mp4', edited);
    await measure(`insert 100 B into ${Math.round(o.largeFile / 1e6)} MB file: push`, () => a.engine.sync());
    await measure(`insert 100 B into ${Math.round(o.largeFile / 1e6)} MB file: pull`, () => b.engine.sync());
  }
  clearInterval(timer);

  const same = a.fs.files.size === b.fs.files.size + 1 && [...b.fs.files].every(([p, f]) => Buffer.compare(a.fs.files.get(p)!.data, f.data) === 0);
  if (!same) throw new Error('benchmark devices diverged');
  let stored = 0;
  for (const obj of mem.objects.values()) stored += obj.data.length;
  const summary = {
    files: a.fs.files.size, vaultMB: +(vault.bytes / 1e6).toFixed(1), storedMB: +(stored / 1e6).toFixed(1),
    objects: mem.objects.size, stateKB: Math.round((a.state.data?.length ?? 0) / 1024), peakRssMB: Math.round(peak / 1e6),
  };
  if (!o.quiet) {
    console.log(JSON.stringify({ notes: o.notes, net: o.net, ...o.config, ...summary }));
    console.table(Object.fromEntries(rows.map(({ scenario, ...r }) => [scenario, r])));
  }
  return { rows, summary };
}

if (import.meta.main) {
  const config: Partial<SyncConfig> = { kdfIterations: 1000 };
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('c.')) (config as Record<string, unknown>)[k.slice(2)] = v === 'true' ? true : v === 'false' ? false : Number(v);
  }
  if ('chunkAvg' in args) config.chunk = { min: num('chunkAvg', 0) / 4, avg: num('chunkAvg', 0), max: num('chunkAvg', 0) * 4 };
  await run({ notes: num('notes', 2000), net: args.net ?? 'none', imageEvery: num('imageEvery', 50), largeFile: num('largeFile', 20e6), config });
}
