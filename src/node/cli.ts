import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, resolveConfig, type SyncConfig } from '../core/config.ts';
import { heartbeatDue, writeHeartbeat } from '../core/devices.ts';
import { HistoryError, SafetyError, SyncEngine, type SyncResult } from '../core/engine.ts';
import { vaultKey } from '../core/paths.ts';
import { errorText, plural } from '../core/text.ts';
import { TooOldError, listCommits, listDeleted, planRestore, tableAt } from '../core/timeline.ts';
import type { RemoteStore } from '../core/types.ts';
import { applyRestore, countSteps, deleteLimitCrossed, keepOut, restoreSteps } from '../plugin/restore.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import type { S3Config } from '../stores/s3.ts';
import { FileState, FolderStore, NodeFS } from './nodefs.ts';
import { SyncLoop, watchVault } from './watch.ts';

interface CliConfig {
  vault: string;
  remote:
    | ({ type: 's3' } & Omit<S3Config, 'accessKey' | 'secretKey'>)
    | { type: 'webdav'; url: string; username: string }
    | { type: 'folder'; path: string };
  sync?: Partial<SyncConfig>;
}

const USAGE = `Usage: node src/node/cli.ts <command> [--config=selfsync.json]

  sync [--force]         sync the vault once
  watch                  sync, then keep syncing until stopped; --poll=30 seconds between checks for
                         remote changes, --interval=300 seconds between full syncs
  check                  test that the remote storage supports everything sync needs
  history <path>         list stored versions of a file
  restore <path> <seq>   write a stored version back into the vault
  deleted [folder]       list deleted files that can still be restored, newest first
  log [--limit=20]       list the times the vault can be restored to, newest first, each after
                         its number
  restore-at <time> [folder] [--dry-run]
                         bring the vault, or one folder, back to how it was at <time> (ISO 8601,
                         like 2026-11-10T14:30, or a number from log, which names that moment even
                         when device clocks disagree); syncs first, prints what changes, changes it,
                         leaving alone any file with changes that sync could not send, and syncs
                         again to send it, no --force needed for the files it removes
  verify [--deep]        check the stored data end to end without changing it; --deep also
                         downloads and checks everything the current files are stored in
  clean                  delete versions older than the retention window from storage
  change-passphrase      re-protect the vault key with SELFSYNC_NEW_PASSPHRASE
  accept-storage         when sync stops because the history in storage is not the one this device
                         saw (part of it taken back or replaced), carry on from storage as it is now,
                         then sync: nothing is deleted, and where files differ both versions are kept.
                         Right after storage was restored from a backup; wrong if nobody did that on
                         purpose, as then someone else may have changed what is stored

Secrets come from the environment: SELFSYNC_PASSPHRASE, and for S3
SELFSYNC_ACCESS_KEY and SELFSYNC_SECRET_KEY, for WebDAV SELFSYNC_WEBDAV_PASSWORD.`;

const STATE_DIR = '.self-sync';
const ACCEPT_HINT = 'if storage was put back to a backup or an older copy on purpose, run accept-storage to carry on from it as it is now';
const WATCH_SETTLE_MS = 3000;

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

function makeStore(remote: CliConfig['remote']): RemoteStore {
  if (remote.type === 'folder') return new FolderStore(resolve(remote.path));
  if (remote.type === 'webdav') return openRemote({ type: 'webdav', url: remote.url, username: remote.username, password: env('SELFSYNC_WEBDAV_PASSWORD') });
  return openRemote({ ...remote, pathStyle: remote.pathStyle ?? true, prefix: remote.prefix ?? '', accessKey: env('SELFSYNC_ACCESS_KEY'), secretKey: env('SELFSYNC_SECRET_KEY') });
}

const summary = (r: SyncResult) => `sent ${r.pushed}, received ${r.pulled}, deleted ${r.deletedLocal} here and ${r.deletedRemote} remotely, merged ${r.merged}`;

function report(r: SyncResult, at = ''): void {
  console.log(`${at}${summary(r)}`);
  for (const copy of r.conflictCopies) console.log(`${at}both versions kept: ${copy}`);
  for (const path of r.tooLarge) console.error(`${at}not synced, over the size limit: ${path}`);
  for (const e of r.errors) console.error(`${at}failed: ${e.path}: ${e.message}`);
}

const didSomething = (r: SyncResult) =>
  r.pushed + r.pulled + r.deletedLocal + r.deletedRemote + r.merged + r.conflictCopies.length + r.errors.length > 0;

const iso = (time: number) => new Date(time).toISOString();
const STEP = { add: 'bring back', change: 'change', remove: 'remove' } as const;

/**
 * Brings the vault, or `folder`, back to how it was at `when`: a time, or a moment's number as `log` prints it, which
 * names that moment exactly whatever the clocks of the devices said. Removals first. Syncs first, so edits not yet
 * synced are kept in history and the plan matches the files here, and after, to send the result; a file with changes
 * that sync could not send is left as it is (see `applyRestore`). With `dry`, only prints the plan.
 */
async function restoreAt(engine: SyncEngine, fs: NodeFS, when: string, folder: string, dry: boolean): Promise<number> {
  const at = /^\d+$/.test(when) ? { seq: Number(when) } : Date.parse(when);
  if (typeof at === 'number' && Number.isNaN(at)) throw new Error(`"${when}" is not a time; use ISO 8601, like 2026-11-10T14:30, or a number that log prints`);
  if (!dry) {
    const r = await engine.sync();
    report(r, 'synced first: ');
    if (r.errors.length) {
      console.error('not restoring: some files could not sync, and restoring could overwrite their changes');
      return 1;
    }
  }
  const v = await engine.view();
  const past = await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, at).catch((e: unknown) => {
    throw e instanceof TooOldError ? new Error(`${when} is too far back; the earliest time that can be restored is ${iso(e.earliest.time)} (number ${e.earliest.seq})`) : e;
  });
  const { steps } = restoreSteps(planRestore(v.st.remote, past.files, folder), v.st.remote, keepOut(v.cfg.exclude, []));
  const scope = folder ? `${vaultKey(folder).replace(/\/+$/, '')}/` : 'the vault';
  console.log(`${scope} as of ${iso(past.commit.time)}, synced by ${past.commit.device}:`);
  for (const s of steps) console.log(`  ${STEP[s.kind].padEnd(10)}  ${s.path}`);
  const c = countSteps(steps);
  if (!steps.length) {
    console.log('nothing to do: it already matches');
    return 0;
  }
  if (dry) {
    console.log(`dry run: would bring back ${c.add}, change ${c.change} and remove ${c.remove}; nothing changed`);
    return 0;
  }

  const here = new Map((await fs.list()).map((f) => [vaultKey(f.path), f.path]));
  const on = (path: string) => here.get(path) ?? path;
  const synced = new Map([...v.st.synced].map(([key, s]) => [key, { lsize: s.lsize, lmtime: s.lmtime }]));
  const applied = await applyRestore(
    steps,
    synced,
    {
      stat: (path) => fs.stat(on(path)),
      write: async (path, data) => void (await fs.write(on(path), data)),
      remove: (path) => fs.remove(on(path)),
      read: (entry) => engine.readVersion(entry),
    },
    v.cfg.concurrency,
  );
  for (const f of applied.failed) console.error(`failed: ${f.path}: ${f.message}`);
  const done = countSteps(applied.done);
  const removed = applied.done.filter((s) => s.kind === 'remove').map((s) => s.path);
  const failed = applied.failed.length;
  console.log(`restored ${scope} as of ${iso(past.commit.time)}: brought back ${done.add}, changed ${done.change}, removed ${done.remove}`);
  const limit = deleteLimitCrossed(done.add + done.change, done.remove, v.st.synced.size, v.cfg);
  // The removals are deletions the user asked for: they do not count against the guard here, nor on other devices.
  const r = await engine.sync({ allowDeletes: removed });
  report(r, 'then synced: ');
  if (limit !== undefined) {
    console.log(
      `the ${done.remove} files removed went to storage as deletions you asked for, so no --force was needed, and other devices delete them ` +
        `when they next sync; one on an older version, or many syncs behind, stops first, as it does before deleting more than ${limit} files ` +
        'at once in case they vanished by mistake, so sync that one with --force',
    );
  }
  return failed || r.errors.length ? 1 : 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flags = new Map(argv.filter((a) => a.startsWith('--')).map((a): [string, string] => [a.slice(2).split('=')[0], a.split('=')[1] ?? '']));
  const [command, ...rest] = argv.filter((a) => !a.startsWith('--'));
  if (!command) {
    console.log(USAGE);
    return 2;
  }
  const cli = JSON.parse(await readFile(flags.get('config') || 'selfsync.json', 'utf8')) as CliConfig;
  const store = makeStore(cli.remote);

  if (command === 'check') {
    const report = await checkStore(store);
    for (const c of report.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    return report.ok ? 0 : 1;
  }

  const vault = resolve(cli.vault);
  const fs = new NodeFS(vault);
  const engine = new SyncEngine({
    fs,
    store,
    stateStore: new FileState(join(vault, STATE_DIR, 'state.json')),
    passphrase: env('SELFSYNC_PASSPHRASE'),
    config: resolveConfig({
      deviceName: hostname().split('.')[0],
      ...cli.sync,
      // A custom list replaces the defaults, but this device's own state must never sync.
      exclude: [...(cli.sync?.exclude ?? DEFAULT_CONFIG.exclude), `${STATE_DIR}/**`],
    }),
    log: console.error,
  });

  const heartbeat = async () => {
    try {
      const { version } = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8')) as { version: string };
      await writeHeartbeat(await engine.view(), { platform: `CLI on ${process.platform}`, version });
    } catch (e) {
      console.error(`could not record this device's heartbeat: ${errorText(e)}`);
    }
  };

  if (command === 'sync') {
    const r = await engine.sync({ force: flags.has('force') });
    report(r);
    await heartbeat();
    return r.errors.length ? 1 : 0;
  }
  if (command === 'watch') {
    const seconds = (name: string, fallback: number) => {
      const n = flags.has(name) ? Number(flags.get(name)) : fallback;
      if (!(n > 0)) throw new Error(`--${name} must be a number of seconds above 0`);
      return n * 1000;
    };
    const pollMs = seconds('poll', 30);
    const intervalMs = seconds('interval', 300);
    const stamp = () => new Date().toISOString();
    let lastBeat = 0;
    const loop = new SyncLoop({
      sync: async () => {
        const r = await engine.sync();
        if (heartbeatDue(lastBeat, Date.now())) {
          lastBeat = Date.now();
          await heartbeat();
        }
        return r;
      },
      remoteChanged: () => engine.remoteChanged(),
      onResult: (r) => {
        if (didSomething(r)) report(r, `${stamp()} `);
      },
      onFailure: (e, retryMs) => {
        const message = errorText(e);
        console.error(`${stamp()} ${e instanceof SafetyError ? `${message} Not retrying until something changes.` : `sync failed: ${message}; retrying in ${retryMs! / 1000}s`}`);
        if (e instanceof HistoryError) console.error(`${stamp()} ${ACCEPT_HINT}`);
      },
      debounceMs: WATCH_SETTLE_MS,
      pollMs,
      intervalMs,
    });
    // Watching starts before the first sync so that edits made during it are not missed.
    const watcher = watchVault(vault, fs, STATE_DIR, () => loop.changed(), (e) => console.error(`${stamp()} watching failed: ${e.message}; relying on the --interval syncs`));
    const signalled = new Promise<void>((done) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => done());
    });
    loop.start();
    await signalled;
    watcher.close();
    await loop.stop();
    return 0;
  }
  if (command === 'history' && rest[0]) {
    for (const v of await engine.history(vaultKey(rest[0]))) {
      console.log(`${String(v.seq).padStart(6)}  ${new Date(v.time).toISOString()}  ${v.device.padEnd(16)} ${v.entry ? `${v.entry.size} bytes` : 'deleted'}`);
    }
    return 0;
  }
  if (command === 'restore' && rest[1]) {
    const version = (await engine.history(vaultKey(rest[0]))).find((v) => v.seq === Number(rest[1]));
    if (!version?.entry) throw new Error(`No restorable version ${rest[1]} of ${rest[0]}`);
    await new NodeFS(vault).write(rest[0], await engine.readVersion(version.entry));
    console.log(`restored ${rest[0]} as of ${new Date(version.time).toISOString()}; run sync to send it to other devices`);
    return 0;
  }
  if (command === 'deleted') {
    const v = await engine.view();
    for (const d of await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now, rest[0] ?? '')) console.log(`${iso(d.time)}  ${d.device.padEnd(16)} ${d.path}`);
    return 0;
  }
  if (command === 'log') {
    const limit = flags.has('limit') ? Number(flags.get('limit')) : 20;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a whole number above 0');
    const v = await engine.view();
    for (const c of await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now, { limit })) {
      console.log(`${String(c.seq).padStart(6)}  ${iso(c.time)}  ${c.device.padEnd(16)} ${c.added} added, ${c.changed} changed, ${c.deleted} deleted`);
    }
    return 0;
  }
  if (command === 'restore-at' && rest[0]) return restoreAt(engine, fs, rest[0], rest[1] ?? '', flags.has('dry-run'));
  if (command === 'verify') {
    const r = await engine.verify({ deep: flags.has('deep') });
    for (const p of r.problems) {
      console.log(`problem: ${p.message}${p.object ? ` (${p.object})` : ''}`);
      for (const path of p.paths ?? []) console.log(`  affects ${path}`);
    }
    const deep = r.deep ? `, ${plural(r.chunks, 'chunk')} (${(r.bytes / 1e6).toFixed(1)} MB downloaded)` : '';
    console.log(`checked ${plural(r.commits, 'commit')}, ${plural(r.files, 'file')}, ${plural(r.packs, 'pack')}${deep}: ${r.problems.length ? plural(r.problems.length, 'problem') : 'no problems'}`);
    return r.problems.length ? 1 : 0;
  }
  if (command === 'change-passphrase') {
    await engine.changePassphrase(env('SELFSYNC_NEW_PASSPHRASE'));
    console.log('passphrase changed; update it on every device');
    return 0;
  }
  if (command === 'clean') {
    const r = await engine.gc();
    const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
    const deleted = [r.packsDeleted && `${plural(r.packsDeleted, 'pack')} (${mb(r.bytesFreed)})`, r.snapshotsDeleted && plural(r.snapshotsDeleted, 'snapshot')].filter(Boolean);
    if (deleted.length) console.log(`deleted ${deleted.join(' and ')} that no kept version needs`);
    if (r.packsCombined) {
      console.log(
        `copied the data still in use out of ${plural(r.packsCombined, 'small or mostly unused pack')} into ${plural(r.packsWritten, 'new pack')} (${mb(r.bytesMoved)}); ` +
          `a later clean deletes the old ones (${mb(r.bytesFreedLater)}) once no kept version reads them`,
      );
    }
    if (!deleted.length && !r.packsCombined) console.log('nothing to clean: no stored version has expired, and no pack is worth combining');
    return 0;
  }
  if (command === 'accept-storage') {
    await engine.acceptStorage();
    console.log('carrying on from storage as it is now');
    const r = await engine.sync();
    report(r);
    return r.errors.length ? 1 : 0;
  }
  console.log(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(errorText(e));
    if (e instanceof HistoryError) console.error(ACCEPT_HINT);
    process.exit(1);
  },
);
