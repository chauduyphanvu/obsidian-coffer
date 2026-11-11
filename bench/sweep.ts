import type { SyncConfig } from '../src/core/config.ts';
import { run, type Row } from './run.ts';

const base: Partial<SyncConfig> = { kdfIterations: 1000 };
const only = process.argv[2];

async function sweep(title: string, o: { notes: number; net: string; imageEvery?: number; largeFile?: number }, variants: Record<string, Partial<SyncConfig>>, pick: string[]) {
  if (only && !title.startsWith(only)) return;
  console.log(`\n## ${title} (${o.notes} notes, net=${o.net})`);
  const table: Record<string, Record<string, string | number>> = {};
  for (const [name, config] of Object.entries(variants)) {
    const { rows, summary } = await run({ notes: o.notes, net: o.net, imageEvery: o.imageEvery ?? 50, largeFile: o.largeFile ?? 0, config: { ...base, ...config }, quiet: true });
    const line: Record<string, string | number> = {};
    for (const want of pick) {
      const [prefix, field] = want.split('|');
      const row = rows.find((r) => r.scenario.startsWith(prefix));
      if (row) line[`${prefix} ${field}`] = row[field as keyof Row];
    }
    line.storedMB = summary.storedMB;
    line.objects = summary.objects;
    line.stateKB = summary.stateKB;
    table[name] = line;
  }
  console.table(table);
}

const chunk = (avg: number) => ({ chunk: { min: avg / 4, avg, max: avg * 4 } });
const transfer = ['first upload|ms', 'first upload|writes', 'new device|ms', 'new device|reads', 'edit 100 notes: push|ms', 'edit 100 notes: pull|ms'];

for (const net of ['broadband', 'mobile']) {
  await sweep('concurrency', { notes: 1500, net }, Object.fromEntries([1, 2, 4, 6, 8, 12, 16].map((c) => [`concurrency ${c}`, { concurrency: c }])), transfer);
  await sweep('pack size', { notes: 1500, net }, Object.fromEntries([0.25, 1, 2, 4, 8, 16].map((m) => [`pack ${m} MB`, { packTargetBytes: m * (1 << 20) }])), transfer);
  await sweep('pack threshold', { notes: 1500, net }, Object.fromEntries([0, 16, 64, 256, 1024].map((k) => [`solo above ${k} KB`, { packMaxBlobBytes: k << 10 }])), transfer);
}
await sweep('compression', { notes: 1500, net: 'mobile', imageEvery: 0 }, { on: { compression: true }, off: { compression: false } },
  ['first upload|ms', 'first upload|cpuMs', 'first upload|upKB', 'new device|ms', 'new device|cpuMs', 'edit 100 notes: push|upKB']);
await sweep('chunk size', { notes: 200, net: 'none', largeFile: 60e6, imageEvery: 0 },
  Object.fromEntries([128, 256, 512, 1024, 2048, 4096].map((k) => [`avg ${k} KB`, chunk(k << 10)])),
  ['first upload|cpuMs', 'insert 100 B into 60 MB file: push|upKB', 'insert 100 B into 60 MB file: push|cpuMs', 'insert 100 B into 60 MB file: pull|downKB', 'insert 100 B into 60 MB file: pull|reads']);
for (const notes of [1000, 10000, 50000]) {
  await sweep('scale', { notes, net: 'none', imageEvery: 0 }, { default: {} },
    ['first upload|ms', 'first upload|writes', 'new device|ms', 'nothing changed|ms', 'edit 1 note: push|ms', 'edit 1 note: pull|ms', 'move folder|ms']);
}
