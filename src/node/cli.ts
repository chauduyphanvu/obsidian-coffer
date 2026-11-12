import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, resolveConfig, type SyncConfig } from '../core/config.ts';
import { SafetyError, SyncEngine, type SyncResult } from '../core/engine.ts';
import { vaultKey } from '../core/paths.ts';
import type { RemoteStore } from '../core/types.ts';
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
  clean                  delete versions older than the retention window from storage
  change-passphrase      re-protect the vault key with SELFSYNC_NEW_PASSPHRASE

Secrets come from the environment: SELFSYNC_PASSPHRASE, and for S3
SELFSYNC_ACCESS_KEY and SELFSYNC_SECRET_KEY, for WebDAV SELFSYNC_WEBDAV_PASSWORD.`;

const STATE_DIR = '.self-sync';
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

  if (command === 'sync') {
    const r = await engine.sync({ force: flags.has('force') });
    report(r);
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
    const loop = new SyncLoop({
      sync: () => engine.sync(),
      remoteChanged: () => engine.remoteChanged(),
      onResult: (r) => {
        if (didSomething(r)) report(r, `${stamp()} `);
      },
      onFailure: (e, retryMs) => {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`${stamp()} ${e instanceof SafetyError ? `${message} Not retrying until something changes.` : `sync failed: ${message}; retrying in ${retryMs! / 1000}s`}`);
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
  if (command === 'change-passphrase') {
    await engine.changePassphrase(env('SELFSYNC_NEW_PASSPHRASE'));
    console.log('passphrase changed; update it on every device');
    return 0;
  }
  if (command === 'clean') {
    const r = await engine.gc();
    console.log(`removed ${r.packsDeleted} objects, ${(r.bytesFreed / 1e6).toFixed(1)} MB`);
    return 0;
  }
  console.log(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
