// A vault that grew one small edit at a time, each its own commit and its own small pack: what a new
// device's first download costs, and what storage holds, before cleanup, after it, and after weekly
// cleanups until the packs the moved data came from have left the retention window. With --autoClean the
// device also cleans up as the plugin does while it grows: weekly, and after a day when a sync that sent
// something finds storage fragmented.
//   node bench/grown.ts [--commits=600] [--net=mobile] [--autoClean=true]
import { resolveConfig, type SyncConfig } from '../src/core/config.ts';
import { SyncEngine } from '../src/core/engine.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { cleanupDue } from '../src/plugin/settings.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { NET, SimStore, rng } from '../src/testing/netsim.ts';
import { generateVault } from './gen.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface GrownRow {
  stage: string;
  packs: number;
  objects: number;
  storedKB: number;
  /** A new device's first sync over the simulated link. */
  downloadRequests: number;
  /** Of those, the commits after the newest snapshot, which it reads one by one: each cleanup adds one. */
  logTail: number;
  downloadMs: number;
  /** Requests the cleanup before this row made. */
  cleanupRequests: number;
  packsDeleted: number;
  packsCombined: number;
  movedKB: number;
}

export async function grown(o: { commits: number; net: string; config: Partial<SyncConfig>; autoClean?: boolean; quiet?: boolean }): Promise<GrownRow[]> {
  const clock = { now: Date.UTC(2026, 0, 1) };
  const mem = new MemoryStore(() => clock.now);
  const fast = new SimStore(mem);
  const link = new SimStore(mem, NET[o.net]);
  const config = (name: string) => resolveConfig({ kdfIterations: 1000, deviceName: name, ...o.config });
  const engine = (name: string, fs: MemFS, store: SimStore) =>
    new SyncEngine({ fs, store, stateStore: new MemState(), passphrase: 'benchmark', config: config(name), now: () => clock.now });

  const source = new MemFS();
  const notes = generateVault(source, { notes: o.commits >> 1, seed: 42, imageEvery: 0, largeFile: 0 }).notes;
  const fs = new MemFS();
  const a = engine('A', fs, fast);
  const rand = rng(7);
  // Half the commits add a note, the other half append a line to one: two months, one commit at a time.
  const step = (60 * DAY) / o.commits;
  let lastCleanup = clock.now;
  const auto = { cleanups: 0, requests: 0 };
  for (let i = 0; i < o.commits; i++) {
    if (i < notes.length) fs.put(notes[i], source.files.get(notes[i])!.data);
    else {
      const path = notes[(rand() * notes.length) | 0];
      fs.put(path, `${fs.text(path)}\n- Added later, item ${i}.\n`);
    }
    const synced = await a.sync();
    if (o.autoClean && cleanupDue({ autoCleanDays: 7, lastCleanup }, clock.now, synced.commits > 0 && (await a.compactionDue()))) {
      fast.reset();
      await a.gc();
      lastCleanup = clock.now;
      auto.cleanups++;
      auto.requests += fast.stats.get + fast.stats.put + fast.stats.list + fast.stats.delete;
    }
    clock.now += step;
  }

  const rows: GrownRow[] = [];
  const cleanup = async () => {
    fast.reset();
    const r = await a.gc();
    return { ...r, requests: fast.stats.get + fast.stats.put + fast.stats.list + fast.stats.delete };
  };
  const measure = async (stage: string, r?: { packsDeleted: number; packsCombined?: number; bytesMoved?: number; requests: number }) => {
    const d = new MemFS();
    link.reset();
    const t = performance.now();
    await engine('N', d, link).sync();
    const ms = performance.now() - t;
    if (d.files.size !== fs.files.size || [...fs.files].some(([p, f]) => Buffer.compare(d.files.get(p)!.data, f.data) !== 0)) throw new Error('new device diverged');
    let stored = 0;
    for (const obj of mem.objects.values()) stored += obj.data.length;
    const lastSeq = (prefix: string) => Math.max(0, ...[...mem.objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => Number(k.slice(prefix.length))));
    rows.push({
      stage, packs: [...mem.objects.keys()].filter((k) => k.startsWith('pack/')).length, objects: mem.objects.size, storedKB: Math.round(stored / 1024),
      downloadRequests: link.stats.get + link.stats.list, logTail: lastSeq('log/') - lastSeq('snap/'), downloadMs: Math.round(ms), cleanupRequests: r?.requests ?? 0,
      packsDeleted: r?.packsDeleted ?? 0, packsCombined: r?.packsCombined ?? 0, movedKB: Math.round((r?.bytesMoved ?? 0) / 1024),
    });
  };
  await measure('before cleanup');
  clock.now += DAY;
  await measure('first cleanup', await cleanup());
  for (let week = 1; week <= 6; week++) {
    clock.now += 7 * DAY;
    await measure(`cleanup, week ${week}`, await cleanup());
  }
  if (!o.quiet) {
    console.log(JSON.stringify({ scenario: 'grown one edit at a time', commits: o.commits, net: o.net, files: fs.files.size, autoClean: !!o.autoClean, ...(o.autoClean && { automaticCleanups: auto.cleanups, automaticCleanupRequests: auto.requests }) }));
    console.table(Object.fromEntries(rows.map(({ stage, ...r }) => [stage, r])));
  }
  return rows;
}

if (import.meta.main) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  await grown({ commits: Number(args.commits ?? 600), net: args.net ?? 'mobile', config: {}, autoClean: args.autoClean === 'true' });
}
