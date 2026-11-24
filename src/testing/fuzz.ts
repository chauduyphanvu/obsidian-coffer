import { resolveConfig } from '../core/config.ts';
import { BranchClosedError, SyncEngine } from '../core/engine.ts';
import type { Branch } from '../core/lines.ts';
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
  /**
   * Chance per step that a device changes which large files it wants and evicts the rest. With it, files of 2 KB and
   * more stay in storage unless wanted, and the quiet period wants them all.
   */
  evictRate?: number;
  /**
   * Chance per step that a device starts a branch, switches line (with whatever it has not sent), merges, or merges and
   * closes one. The quiet period merges every branch into the main line and puts every device back on it.
   */
  branchRate?: number;
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
  cleanups: number;
  /** Packs whose current data cleanups copied into fuller ones. */
  packsCombined: number;
  /** Syncs told exactly which paths the device changed, and of those, the ones that did not list the vault. */
  hinted: number;
  unlisted: number;
  /** Files removed from a device that storage kept (`evictRate`). */
  evicted: number;
  /** Branches started, switches of line, merges applied and branches closed (`branchRate`). */
  branches: number;
  switches: number;
  lineMerges: number;
  closed: number;
}

/**
 * Random edits, deletes, moves, syncs, cleanups (thinning old versions and compacting packs, some
 * racing other devices' syncs) and jumps of hours or days, with injected network failures and crashes,
 * then a quiet period. Half the syncs are told exactly which paths their device changed since its last
 * one, and some race reads of the same device's state. Afterwards every device and a brand-new device must hold the same vault, a deep
 * verify must find nothing wrong, and every line anyone wrote must still exist somewhere unless a
 * device that had seen that line deleted it.
 */
const TRACE = process.env.FUZZ_TRACE ?? '';
const traced: string[] = [];
const tlog = (...parts: unknown[]) => void traced.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
export const takeTrace = () => traced.splice(0);

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
      retentionDays: 2,
      compactMaxBytes: 24 << 10,
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
      /** Paths changed on this device since its last sync was called. */
      touched: new Set<string>(),
      lists: 0,
      /** The large files this device wants, by name; all of them once `wantAll`. */
      wanted: new Set<string>(),
      wantAll: false,
      restart() {
        d.engine = new SyncEngine({
          fs, store, stateStore: state, passphrase: 'pw', now: () => clock.now,
          config: o.evictRate ? { ...config(d.name), deferAboveMB: 2048 / (1 << 20) } : config(d.name),
          ...(o.evictRate && { keep: (key: string) => d.wantAll || d.wanted.has(key) }),
        });
      },
    };
    const list = fs.list.bind(fs);
    fs.list = () => {
      d.lists++;
      return list();
    };
    state.save = async (data) => {
      if (rand() < d.crash) throw new Error('injected: crash before state was saved');
      return save(data);
    };
    d.restart();
    return d;
  });

  if (o.branchRate) {
    const first = devices[0];
    const rate = first.store.rate;
    const crash = first.crash;
    first.store.rate = 0;
    first.crash = 0;
    await first.engine.upgrade();
    first.store.rate = rate;
    first.crash = crash;
  }

  let nextToken = 0;
  const allowedLost = new Set<string>();
  const report: FuzzReport = {
    seed, ok: true, problems: [], syncs: 0, failedSyncs: 0, merges: 0, conflictCopies: 0, files: 0, tokens: 0, cleanups: 0, packsCombined: 0,
    hinted: 0, unlisted: 0, evicted: 0, branches: 0, switches: 0, lineMerges: 0, closed: 0,
  };
  const bins = new Set<string>();
  /** A sync, told what changed or not. A log the device itself saw out of order is damage, never a fault. */
  const sync = async (x: (typeof devices)[number], hinted: boolean) => {
    const changed = x.touched;
    x.touched = new Set();
    const lists = x.lists;
    const r = await x.engine.sync(hinted ? { changed } : {});
    if (hinted) {
      report.hinted++;
      if (x.lists === lists) report.unlisted++;
    }
    return r;
  };
  const damage = (e: unknown) => e instanceof Error && /tampered|forked|does not follow/.test(e.message);
  const cleanup = async (x: (typeof devices)[number]) => {
    report.cleanups++;
    try {
      report.packsCombined += (await x.engine.gc()).packsCombined;
    } catch {
      x.restart();
    }
  };
  type Dev = (typeof devices)[number];
  const openBranches = async (x: Dev): Promise<Branch[]> => (await x.engine.branches()).branches.filter((b) => !b.closed);
  /** Merges `b` with the main line on `x`, which is on one of the two. True when nothing was left out. */
  const mergeLine = async (x: Dev, b: Branch): Promise<boolean> => {
    const draft = await x.engine.mergePlan(b);
    if (TRACE) tlog('  merge plan', b.id.slice(0, 4), 'into', draft.into.slice(0, 4) || 'main', JSON.stringify({ take: draft.take.map((t) => [t.path, !!t.entry, !!t.expect]), merged: draft.merged.map((m) => m.path), copies: draft.copies.map((c) => c.path) }));
    const res = await x.engine.mergeApply(draft);
    if (TRACE) tlog('  merge applied', JSON.stringify(res));
    report.lineMerges++;
    report.conflictCopies += res.copies.length;
    return res.skipped.length === 0;
  };
  /** One random thing a device does with branches. A failure is a fault or a branch found closed: the device starts over. */
  const branchStep = async (x: Dev) => {
    try {
      if (TRACE) tlog('  branchStep', x.name, 'on', x.engine.lineId().slice(0, 4) || 'main');
      const open = await openBranches(x);
      const on = x.engine.lineId();
      const what = pick(8);
      if (what === 0 && !on && open.length < 2) {
        await x.engine.startBranch(`b${report.branches++}`);
        if (TRACE) tlog('  started');
      } else if (what < 4) {
        const to = pick(open.length + 1);
        await x.engine.switchLine(open[to]);
        if (TRACE) tlog('  switched to', open[to]?.id.slice(0, 4) ?? 'main');
        report.switches++;
      } else if (what < 7 && open.length) {
        const b = on ? open.find((o) => o.id === on) : open[pick(open.length)];
        if (b) await mergeLine(x, b);
      } else if (!on && open.length) {
        // Closed only once all of it is on the main line, and nothing else runs in between.
        const b = open[pick(open.length)];
        if (await mergeLine(x, b)) {
          await x.engine.closeBranch(b);
          report.closed++;
        }
      }
    } catch (e) {
      if (TRACE) tlog('  branchStep failed', (e as Error).message);
      if (damage(e)) report.problems.push(`${x.name}: ${(e as Error).message}`);
      x.restart();
    }
  };
  const seenAt = new Map<string, string>();
  const lineOn = (x: Dev) => /"l":\{"id":"(\w{4})/.exec(x.state.data ?? '')?.[1] ?? 'main';
  const dump = (x: Dev, what: string) => {
    if (TRACE) tlog(`  ${what} ${x.name}@${lineOn(x)} files: ${[...x.fs.files].filter(([p]) => p.endsWith('.md')).map(([p, f]) => `${p}=[${tokensIn(new TextDecoder().decode(f.data)).join(',')}]`).join(' ')}`);
  };
  // Ended with a mark, so that no token is the start of another: a line that only starts like another line reads to
  // `mergeAdded` as that line carried on, which would make this run's own tokens stand in for each other.
  const token = () => `tok${nextToken++};`;
  const tokensIn = (text: string) => text.match(/tok\d+/g) ?? [];
  const paths = Array.from({ length: 10 }, (_, i) => `${['', 'dir/', 'dir/sub/'][i % 3]}n${i}.md`);

  for (let step = 0; step < o.steps; step++) {
    clock.now += 1000 + pick(60_000);
    // Now and then hours or days pass, so versions age into thinning and out of the window.
    if (pick(40) === 0) clock.now += pick(2) ? pick(30) * 3_600_000 : pick(4) * 86_400_000;
    const d = devices[pick(devices.length)];
    const existing = [...d.fs.files.keys()].filter((p) => p.endsWith('.md'));
    const op = pick(10);
    if (op < 3) {
      // Often several devices sync at the same moment, so they race for the same commit number.
      const group = pick(3) ? [d] : devices.filter((x) => x === d || pick(2));
      await Promise.all(
        group.map(async (x) => {
          if (pick(8) === 0) return cleanup(x);
          report.syncs++;
          const hinted = pick(2) === 0;
          // A watch loop keeps its engine after a failure; the plugin starts a new one.
          const keep = pick(2) === 0;
          const reads = pick(6) === 0 ? [x.engine.view(), x.engine.remoteChanged(), x.engine.history(paths[pick(paths.length)])] : [];
          for (const read of reads) {
            read.catch((e: unknown) => {
              if (damage(e)) report.problems.push(`${x.name}: a read alongside a sync: ${(e as Error).message}`);
            });
          }
          try {
            const r = await sync(x, hinted);
            if (TRACE) tlog('  sync', x.name, x.engine.lineId().slice(0, 4) || 'main', JSON.stringify({ pushed: r.pushed, pulled: r.pulled, dl: r.deletedLocal, dr: r.deletedRemote, merged: r.merged, copies: r.conflictCopies, errors: r.errors.length }));
            report.merges += r.merged;
            report.conflictCopies += r.conflictCopies.length;
          } catch (e) {
            if (damage(e)) report.problems.push(`${x.name}: ${(e as Error).message}`);
            if (TRACE) tlog('  sync failed', x.name, (e as Error).message.slice(0, 80));
            report.failedSyncs++;
            if (!keep) x.restart();
            // What the user does when told the branch was closed. What the device had not sent goes with it.
            if (e instanceof BranchClosedError) await x.engine.switchLine().catch(() => x.restart());
          }
          await Promise.allSettled(reads);
        }),
      );
    } else if (op < 5 || !existing.length) {
      const path = paths[pick(paths.length)];
      if (!d.fs.files.has(path)) {
        d.fs.put(path, `${token()}\n${token()}\n${token()}\n`);
        d.touched.add(path);
      }
    } else {
      const path = existing[pick(existing.length)];
      const lines = d.fs.text(path)!.split('\n').filter(Boolean);
      d.touched.add(path);
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
          d.touched.add(to);
        }
      }
    }
    if (pick(25) === 0) {
      const bin = `bin${pick(3)}.dat`;
      d.fs.put(bin, Uint8Array.from({ length: 500 + pick(20_000) }, () => pick(256)));
      d.touched.add(bin);
      bins.add(bin);
    }
    if (o.branchRate && rand() < o.branchRate) await branchStep(d);
    if (TRACE) {
      tlog(step, d.name, 'op', op, devices.map((x) => `${x.name}@${lineOn(x)}`).join(' '));
      if (process.env.FUZZ_PATH) tlog('   ', devices.map((x) => `${x.name}:${[...x.fs.files].filter(([p]) => p.includes(process.env.FUZZ_PATH!)).map(([p, f]) => `${p}=[${f.data.length > 400 ? 'bin' : tokensIn(new TextDecoder().decode(f.data)).join(',')}]`).join(' ') || '-'}`).join(' | '));
      for (const x of devices) for (const [p, f] of x.fs.files) if (p.endsWith('.md')) for (const t of tokensIn(new TextDecoder().decode(f.data))) seenAt.set(t, `step ${step} ${x.name}@${lineOn(x)} ${p}`);
    }
    if (o.evictRate && rand() < o.evictRate) {
      const bin = `bin${pick(3)}.dat`;
      if (!d.wanted.delete(bin)) d.wanted.add(bin);
      try {
        const out = await d.engine.evict();
        report.evicted += out.evicted.length;
        for (const p of out.evicted) if (pick(2)) d.touched.add(p);
      } catch {
        d.restart();
      }
    }
  }

  // Quiet period: no faults; a cleanup a few days on, then sync until a full pass over all devices changes nothing.
  for (const d of devices) {
    d.store.rate = 0;
    d.crash = 0;
    d.wantAll = true;
    d.restart();
  }
  if (o.branchRate) {
    // Every device sends what it has to the line it is on, then goes to the main line, which takes every branch.
    for (const d of devices) {
      dump(d, 'quiet start');
      try {
        const r = await sync(d, false);
        if (TRACE) tlog('  quiet sync', d.name, JSON.stringify({ pushed: r.pushed, pulled: r.pulled, dl: r.deletedLocal, dr: r.deletedRemote, merged: r.merged, copies: r.conflictCopies, errors: r.errors }));
      } catch (e) {
        if (TRACE) tlog('  quiet sync failed', d.name, (e as Error).message.slice(0, 60));
        if (!(e instanceof BranchClosedError)) report.problems.push(`${d.name}: ${(e as Error).message}`);
      }
      const sw = await d.engine.switchLine();
      const r = await sync(d, false);
      if (TRACE) tlog('  quiet switch', d.name, sw.changed, JSON.stringify({ pushed: r.pushed, pulled: r.pulled, dl: r.deletedLocal, dr: r.deletedRemote, merged: r.merged, copies: r.conflictCopies, errors: r.errors }));
      dump(d, 'quiet after');
    }
    const d = devices[0];
    for (const b of await openBranches(d)) {
      let whole = false;
      for (let i = 0; i < 4 && !whole; i++) {
        // Closing one was cut short after its log was ended: it was merged whole just before.
        whole = await mergeLine(d, b).catch((e: unknown) => {
          if (e instanceof BranchClosedError) return true;
          throw e;
        });
        await sync(d, false);
      }
      if (!whole) report.problems.push(`branch ${b.name} never merged whole`);
    }
  }
  clock.now += 3 * 86_400_000;
  await cleanup(devices[pick(devices.length)]);
  let settled = false;
  for (let pass = 0; pass < 12 && !settled; pass++) {
    settled = true;
    for (const d of devices) {
      const r = await sync(d, pick(2) === 0);
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

  const problems = (await devices[0].engine.verify({ deep: true })).problems;
  for (const p of problems.slice(0, 3)) report.problems.push(`verify: ${p.message}`);

  const fresh = new MemFS();
  await new SyncEngine({ fs: fresh, store: mem, stateStore: new MemState(), passphrase: 'pw', config: config('fresh'), now: () => clock.now }).sync();
  if (view(fresh) !== reference) report.problems.push('a new device does not get the same vault');

  // Nothing in the run deletes these, so one that is gone was deleted by a device that only stopped keeping it.
  for (const bin of bins) if (!devices[0].fs.files.has(bin)) report.problems.push(`lost ${bin}`);

  const everything = [...devices[0].fs.files.values()].map((f) => new TextDecoder().decode(f.data)).join('\n');
  const present = new Set(tokensIn(everything));
  for (let i = 0; i < nextToken; i++) {
    if (!present.has(`tok${i}`) && !allowedLost.has(`tok${i}`)) report.problems.push(`lost tok${i}${TRACE ? ` last seen ${seenAt.get(`tok${i}`)}` : ''}`);
  }
  report.files = devices[0].fs.files.size;
  report.tokens = nextToken;
  report.ok = report.problems.length === 0;
  return report;
}
