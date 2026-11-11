import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfig, type SyncConfig } from '../core/config.ts';
import { SyncEngine } from '../core/engine.ts';
import type { RemoteStore } from '../core/types.ts';
import { checkStore } from '../stores/doctor.ts';
import { withRetry } from '../stores/retry.ts';
import { S3Store, type S3Config } from '../stores/s3.ts';
import { WebDavStore } from '../stores/webdav.ts';
import { FileState, FolderStore, NodeFS } from './nodefs.ts';

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
  check                  test that the remote storage supports everything sync needs
  history <path>         list stored versions of a file
  restore <path> <seq>   write a stored version back into the vault
  clean                  delete versions older than the retention window from storage
  change-passphrase      re-protect the vault key with SELFSYNC_NEW_PASSPHRASE

Secrets come from the environment: SELFSYNC_PASSPHRASE, and for S3
SELFSYNC_ACCESS_KEY and SELFSYNC_SECRET_KEY, for WebDAV SELFSYNC_WEBDAV_PASSWORD.`;

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

function makeStore(remote: CliConfig['remote']): RemoteStore {
  if (remote.type === 'folder') return new FolderStore(resolve(remote.path));
  if (remote.type === 'webdav') return withRetry(new WebDavStore({ url: remote.url, username: remote.username, password: env('SELFSYNC_WEBDAV_PASSWORD') }));
  return withRetry(new S3Store({ ...remote, pathStyle: remote.pathStyle ?? true, prefix: remote.prefix ?? '', accessKey: env('SELFSYNC_ACCESS_KEY'), secretKey: env('SELFSYNC_SECRET_KEY') }));
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
  const engine = new SyncEngine({
    fs: new NodeFS(vault),
    store,
    stateStore: new FileState(join(vault, '.self-sync', 'state.json')),
    passphrase: env('SELFSYNC_PASSPHRASE'),
    config: resolveConfig({ deviceName: hostname().split('.')[0], ...cli.sync }),
    log: console.error,
  });

  if (command === 'sync') {
    const r = await engine.sync({ force: flags.has('force') });
    console.log(`sent ${r.pushed}, received ${r.pulled}, deleted ${r.deletedLocal} here and ${r.deletedRemote} remotely, merged ${r.merged}`);
    for (const copy of r.conflictCopies) console.log(`both versions kept: ${copy}`);
    for (const e of r.errors) console.error(`failed: ${e.path}: ${e.message}`);
    return r.errors.length ? 1 : 0;
  }
  if (command === 'history' && rest[0]) {
    for (const v of await engine.history(rest[0])) {
      console.log(`${String(v.seq).padStart(6)}  ${new Date(v.time).toISOString()}  ${v.device.padEnd(16)} ${v.entry ? `${v.entry.size} bytes` : 'deleted'}`);
    }
    return 0;
  }
  if (command === 'restore' && rest[1]) {
    const version = (await engine.history(rest[0])).find((v) => v.seq === Number(rest[1]));
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
