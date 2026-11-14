import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG, resolveConfig, type SyncConfig } from '../core/config.ts';
import { MIN_PASSPHRASE } from '../core/crypto.ts';
import { heartbeatDue, writeHeartbeat } from '../core/devices.ts';
import { HistoryError, RemovedError, SafetyError, SyncEngine, UnverifiedError, type SyncOptions, type SyncResult } from '../core/engine.ts';
import { vaultKey } from '../core/paths.ts';
import { Repo } from '../core/repo.ts';
import { errorText, plural } from '../core/text.ts';
import { TooOldError, listCommits, listDeleted, planRestore, tableAt } from '../core/timeline.ts';
import type { RemoteStore } from '../core/types.ts';
import { applyRestore, countSteps, deleteLimitCrossed, keepDeferred, keepOut, leftNote, restoreSteps, sizeLabel, unsent } from '../plugin/restore.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import type { S3Config } from '../stores/s3.ts';
import { KEYS_FILE, POSITION_FILE, STATE_FILE, credentialsFrom, joinWithLink, loadKeyFile, saveKeyFile, storageProblem, type Credentials, type KeyFile, type MemberRemote } from './member.ts';
import { FileState, FolderStore, NodeFS } from './nodefs.ts';
import { SyncLoop, watchVault } from './watch.ts';

/** Set at build time in dist/coffer.js; undefined when this file runs from source. */
declare const COFFER_VERSION: string | undefined;

interface CliConfig {
  vault: string;
  remote:
    | ({ type: 's3' } & Omit<S3Config, 'accessKey' | 'secretKey'>)
    | { type: 'webdav'; url: string; username: string }
    | { type: 'folder'; path: string }
    | { type: 'follow'; url: string };
  /** Set by `join`: the name of a shared folder with members, whose keys are in the state folder's keys file. */
  share?: string;
  sync?: Partial<SyncConfig>;
}

const USAGE = `Usage: node coffer.js <command> [--config=coffer.json]
       node coffer.js --help | --version

  join - [--vault=<folder>]
                         join a shared folder with members from its invite link (coffershare3.…), or follow a
                         public copy of one from a follow link (cofferfollow1.…), read from standard input, or
                         from COFFER_LINK when there is no -. The link alone opens the folder: given as an
                         argument instead (join <link>), other users of this computer can see it, and it stays
                         in shell history. Writes the config file given by --config, which must not exist yet, and keeps the keys
                         in <folder>/.coffer/keys.json, readable by you alone. The folder is --vault, or the name
                         the link suggests, here. The other commands then work on it: a writing member sends
                         changes once the owner's device has confirmed it, a reading one and a follower only
                         receive
  sync [--force]         sync the vault once
  fetch <path>...        download files that sync.deferAboveMB leaves in storage: set it under "sync" in
                         coffer.json to a size in MB above which files are not downloaded (0, the default,
                         downloads everything); sync lists the ones left, and one fetched syncs like any other
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
  verify [--deep]        check the stored data end to end without changing it, including that the data of the
                         earlier versions history offers is still stored; --deep also downloads and checks
                         everything the current files are stored in
  repair [--deep]        store again, from the files in this vault, the data a verify finds missing
                         or damaged, so other devices can download those files; --deep also finds
                         damaged data inside packs that are there. Exits 1 if some files could not
                         be repaired, as when this vault does not have them: run it where they are
  clean                  delete versions older than the retention window from storage
  change-passphrase      re-protect the vault key with COFFER_NEW_PASSPHRASE (8 characters or more), at the
                         cost sync.kdfIterations sets in coffer.json if that is higher than the vault's now
  accept-storage         when sync stops because the history in storage is not the one this device
                         saw (part of it taken back or replaced), carry on from storage as it is now,
                         then sync: nothing is deleted, and where files differ both versions are kept.
                         Right after storage was restored from a backup; wrong if nobody did that on
                         purpose, as then someone else may have changed what is stored

Secrets come from the environment: COFFER_PASSPHRASE, and for S3
COFFER_ACCESS_KEY and COFFER_SECRET_KEY, for WebDAV COFFER_WEBDAV_PASSWORD. A shared folder joined with a link keeps
its keys in .coffer/keys.json instead, and the environment is not read for it.`;

/** The options that take a value, as `--name=value` or `--name value`; every other option takes none. */
const VALUED = ['config', 'poll', 'interval', 'limit', 'vault'];

/** Each command's options besides --config (and --help and --version, which stop any command). */
const OPTIONS: Record<string, string[]> = {
  join: ['vault'],
  sync: ['force'],
  fetch: [],
  watch: ['poll', 'interval'],
  check: [],
  history: [],
  restore: [],
  deleted: [],
  log: ['limit'],
  'restore-at': ['dry-run'],
  verify: ['deep'],
  repair: ['deep'],
  clean: [],
  'change-passphrase': [],
  'accept-storage': [],
};

/** What a device with sync.readOnly cannot do, as each command's reason: they write to storage, or to files it would never send. */
const WRITES: Record<string, string> = {
  clean: 'it does not clean up storage',
  repair: 'it cannot store data in storage again',
  restore: 'a restored file would never be sent',
  'restore-at': 'a restore would never be sent',
  'change-passphrase': 'it cannot change the passphrase in storage',
};

/** What a device that is a member of a shared folder cannot do, as each command's reason. */
const NOT_FOR_MEMBERS: Record<string, string> = {
  'change-passphrase': 'a device joins it with the keys of an invite and has no passphrase to change',
};

/** What a followed folder cannot do: it is read over a public address, by name. */
const NOT_FOR_FOLLOWERS: Record<string, string> = {
  check: 'it is read over its public address, which cannot be listed or written to',
  verify: 'it is read over its public address, which cannot be listed',
};

const STATE_DIR = '.coffer';
const FORCE_HINT = 'to delete them anyway, run sync --force';
const READ_ONLY_HINT = 'if these keys may only read, set "readOnly": true under "sync" in the config file, so this device only receives';
const ACCEPT_HINT = 'if storage was put back to a backup or an older copy on purpose, run accept-storage to carry on from it as it is now';
const WATCH_SETTLE_MS = 3000;
/** Node's names for systems, as the devices list shows them. */
const SYSTEMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** Set once the config is read: a refusal to write only suggests `readOnly` to a device that does write. */
let receivesOnly = false;
/** Set for a shared folder with members: its name, and what its last sync said about this device, if anything. */
let shareName = '';
let memberNote: string | undefined;
/** What a device that lost its shared folder does to join it again, and with which link: set with the config, as it names its files. */
let newLink = 'invite';
let rejoin = '';
const refusedWriting = (e: unknown) => !receivesOnly && !shareName && /HTTP 403\b|AccessDenied/.test(errorText(e));

/** What to do about a sync that stopped for a reason of a shared folder with members. */
function memberHint(e: unknown): string | undefined {
  if (e instanceof RemovedError) return `“${shareName}” is not synced here any more; to join it again, ask its owner for a new ${newLink}, ${rejoin}`;
  if (e instanceof UnverifiedError) {
    return `“${shareName}” stays as it was here: this device applies nothing from that change on, and syncs again once the owner has removed it from storage`;
  }
  if (shareName && /HTTP 40[13]\b|AccessDenied/.test(errorText(e))) {
    return `the storage refused the keys this device holds for “${shareName}”; if the owner gave everyone new storage keys since this device last synced, those no longer work, so ask for a new ${newLink}, ${rejoin}`;
  }
  return undefined;
}

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/**
 * `firstRun`: this device has not synced yet, so a missing storage folder is created rather than taken for one not mounted.
 * `creds`: the keys a shared folder with members was joined with, which are used instead of the environment's.
 */
function makeStore(remote: CliConfig['remote'] | MemberRemote, firstRun: boolean, creds?: Credentials): RemoteStore {
  const key = (field: keyof Credentials, name: string) => (creds ? creds[field] || fail(`the keys kept for this shared folder lack ${field}`) : env(name));
  if (remote.type === 'folder') return new FolderStore(resolve(remote.path), { create: firstRun });
  if (remote.type === 'follow') return openRemote({ type: 'follow', url: remote.url });
  if (remote.type === 'webdav') {
    return openRemote({ type: 'webdav', url: remote.url, username: creds?.webdavUser ?? remote.username, password: key('webdavPassword', 'COFFER_WEBDAV_PASSWORD') });
  }
  return openRemote({ ...remote, pathStyle: remote.pathStyle ?? true, prefix: remote.prefix ?? '', accessKey: key('accessKey', 'COFFER_ACCESS_KEY'), secretKey: key('secretKey', 'COFFER_SECRET_KEY') });
}

const fail = (message: string): never => {
  throw new Error(message);
};

const version = async () =>
  typeof COFFER_VERSION === 'string' ? COFFER_VERSION : (JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8')) as { version: string }).version;

const REMOTE_FIELDS: Record<string, string[]> = { s3: ['endpoint', 'bucket'], webdav: ['url', 'username'], folder: ['path'], follow: ['url'] };

/** Why `c`, parsed from the config file, cannot be a config, in words that follow "config file <path>". */
function configProblem(c: unknown): string | undefined {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return 'must hold a JSON object';
  const { vault, remote, sync, share } = c as Record<string, unknown>;
  if (typeof vault !== 'string' || !vault) return 'needs "vault", the path of the folder to sync';
  if (share !== undefined && typeof share !== 'string') return 'needs "share" to be the name of the shared folder, as join writes it';
  if (sync !== undefined) {
    if (typeof sync !== 'object' || sync === null || Array.isArray(sync)) return 'needs "sync" to be a JSON object';
    // A misspelt key would otherwise be dropped in silence: "readonly" would leave a device sending its changes.
    for (const [key, value] of Object.entries(sync)) {
      if (!Object.hasOwn(DEFAULT_CONFIG, key)) return `has "sync.${key}", which is not a setting`;
      const like = DEFAULT_CONFIG[key as keyof SyncConfig];
      const fits = Array.isArray(like)
        ? Array.isArray(value) && value.every((v) => typeof v === 'string')
        : typeof like === 'number'
          ? typeof value === 'number' && Number.isFinite(value) && value >= 0
          : typeof value === typeof like && value !== null && !Array.isArray(value);
      if (!fits) return `needs "sync.${key}" to be ${Array.isArray(like) ? 'a list of texts' : typeof like === 'number' ? 'a number, 0 or more' : typeof like === 'boolean' ? 'true or false' : typeof like === 'string' ? 'a text' : 'a JSON object'}`;
    }
  }
  if (typeof remote !== 'object' || remote === null) return 'needs "remote", saying where the vault is stored';
  const { type } = remote as Record<string, unknown>;
  const fields = typeof type === 'string' && Object.hasOwn(REMOTE_FIELDS, type) ? REMOTE_FIELDS[type] : undefined;
  if (!fields) return 'needs "remote.type" to be s3, webdav or folder';
  const missing = fields.find((f) => typeof (remote as Record<string, unknown>)[f] !== 'string');
  return missing && `needs "remote.${missing}"`;
}

/** The storage, for a line that says what is being watched. */
function describeRemote(remote: CliConfig['remote']): string {
  if (remote.type === 'folder') return `folder ${resolve(remote.path)}`;
  if (remote.type === 'webdav') return `WebDAV ${remote.url}`;
  if (remote.type === 'follow') return `followed folder ${remote.url}`;
  return `S3 bucket ${remote.bucket}${remote.prefix ? `/${remote.prefix}` : ''} at ${remote.endpoint}`;
}

/** `--name[=value]` options and the words around them. A value option may take its value as the next word. */
function parseArgs(argv: string[]): { flags: Map<string, string | undefined>; words: string[]; error?: string } {
  const flags = new Map<string, string | undefined>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    let value = eq < 0 ? undefined : arg.slice(eq + 1);
    if (flags.has(name)) return { flags, words, error: `--${name} is given twice` };
    if (VALUED.includes(name)) {
      value ??= argv[++i];
      if (!value || value.startsWith('--')) return { flags, words, error: `--${name} needs a value, as --${name}=<value>` };
    }
    flags.set(name, value);
  }
  return { flags, words };
}

const summary = (r: SyncResult) => `sent ${r.pushed}, received ${r.pulled}, deleted ${r.deletedLocal} here and ${r.deletedRemote} remotely, merged ${r.merged}`;

/** What a sync left alone, as the lines that say so. */
const leftAlone = (r: SyncResult) => [
  ...r.tooLarge.map((path) => `not synced, over the size limit: ${path}`),
  ...r.unsent.map((path) => `not sent, this device only receives: ${path}`),
  ...r.deferred.map((path) => `not downloaded, over sync.deferAboveMB (run fetch to download): ${path}`),
  ...(memberNote ? [memberNote] : []),
];

/** `notes` is which of the lines about what the sync left alone to print: all, unless the caller says them only once. */
function report(r: SyncResult, at = '', notes = leftAlone(r)): void {
  console.log(`${at}${summary(r)}`);
  for (const copy of r.conflictCopies) console.log(`${at}both versions kept: ${copy}`);
  for (const line of notes) console.error(`${at}${line}`);
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
  const kept = await keepDeferred(keepOut(v.cfg.exclude, []), engine);
  const { steps, left } = restoreSteps(planRestore(v.st.remote, past.files, folder), v.st.remote, kept);
  const scope = folder ? `${vaultKey(folder).replace(/\/+$/, '')}/` : 'the vault';
  console.log(`${scope} as of ${iso(past.commit.time)}, synced by ${past.commit.device}:`);
  for (const s of steps) console.log(`  ${STEP[s.kind].padEnd(10)}  ${s.path}`);
  if (left) console.log(leftNote(left));
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

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of process.stdin) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

async function main(): Promise<number> {
  const { flags, words, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    return 2;
  }
  const [command, ...rest] = words;
  if (flags.has('help') || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (flags.has('version')) {
    console.log(await version());
    return 0;
  }
  if (!command) {
    console.log(USAGE);
    return 2;
  }
  if (!Object.hasOwn(OPTIONS, command)) {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  // An option that is ignored can make a command do more than asked, as a mistyped --dry-run.
  const unknown = [...flags.keys()].filter((f) => f !== 'config' && !OPTIONS[command].includes(f));
  if (unknown.length) {
    console.error(`unknown option for ${command}: ${unknown.map((f) => `--${f}`).join(', ')}`);
    return 2;
  }
  const stray = [...flags].find(([name, value]) => value !== undefined && !VALUED.includes(name));
  if (stray) {
    console.error(`--${stray[0]} takes no value`);
    return 2;
  }
  const configFile = flags.get('config') ?? 'coffer.json';
  if (command === 'join') {
    const link = rest.length > 1 ? '' : rest[0] === '-' ? await readStdin() : (rest[0] ?? process.env.COFFER_LINK ?? '');
    if (!link.trim()) {
      console.error('join takes the link to join with on standard input: join - [--vault=<folder>], or in COFFER_LINK');
      return 2;
    }
    const j = await joinWithLink(link, { config: configFile, vault: flags.get('vault'), stateDir: STATE_DIR, open: (remote, creds) => makeStore(remote, false, creds) });
    console.log(`joined “${j.share}” ${j.role === 'follow' ? 'as a follower' : `as a member who ${j.role === 'write' ? 'writes' : 'reads'}`}`);
    console.log(`  folder  ${j.vault}`);
    console.log(`  config  ${j.config}`);
    console.log(`  keys    ${j.keys}, readable by you alone; it holds what opens the shared folder, so keep it private`);
    if (j.late) console.error(`could not tell the owner's device about this one yet (${j.late}); sync tries again`);
    console.log(
      j.role === 'write'
        ? 'this device only receives until the owner\'s device confirms it, which sync tells you about; then it sends changes'
        : 'this device only receives',
    );
    console.log(`next: sync --config=${j.config}`);
    return 0;
  }
  const cli = await readFile(configFile, 'utf8').then(
    (text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`config file ${resolve(configFile)} is not valid JSON: ${errorText(e)}`);
      }
      const problem = configProblem(parsed);
      if (problem) throw new Error(`config file ${resolve(configFile)} ${problem}`);
      return parsed as CliConfig;
    },
    (e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT' ? new Error(`config file ${resolve(configFile)} not found; pass --config=<file>`) : e;
    },
  );
  const vault = resolve(cli.vault);
  const stateFile = join(vault, STATE_DIR, STATE_FILE);
  const keysFile = join(vault, STATE_DIR, KEYS_FILE);
  // A shared folder with members: its keys are in a file of their own. A device without a signing key (a reader, a follower) only receives.
  let member: KeyFile | undefined = cli.share === undefined ? undefined : await loadKeyFile(keysFile);
  shareName = cli.share ?? '';
  newLink = cli.remote.type === 'follow' ? 'follow link' : 'invite';
  rejoin = `delete ${resolve(configFile)} and ${join(vault, STATE_DIR)} (the files in the folder stay) and run join with it`;
  receivesOnly = !!cli.sync?.readOnly || (!!member && !member.member.key);
  if (member && NOT_FOR_MEMBERS[command]) {
    console.error(`${command} does not work on a shared folder with members: ${NOT_FOR_MEMBERS[command]}`);
    return 1;
  }
  if (cli.remote.type === 'follow' && NOT_FOR_FOLLOWERS[command]) {
    console.error(`${command} does not work on a followed folder: ${NOT_FOR_FOLLOWERS[command]}`);
    return 1;
  }
  // restore-at --dry-run only reads, so a device that only receives may look at what a restore would do.
  if (receivesOnly && WRITES[command] && !(command === 'restore-at' && flags.has('dry-run'))) {
    console.error(`this device only receives changes, so ${WRITES[command]}; run ${command} from a device that sends them`);
    return 1;
  }
  let store = makeStore(cli.remote, !existsSync(stateFile), member?.storage);

  if (command === 'check') {
    const report = await checkStore(store, receivesOnly);
    for (const c of report.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    return report.ok ? 0 : 1;
  }

  const passphrase = member ? '' : env('COFFER_PASSPHRASE');
  // Opening empty storage makes a vault, so a short passphrase is refused there. Only a short one pays the request to look.
  if (passphrase.length < MIN_PASSPHRASE && !member && !receivesOnly && !(await Repo.exists(store))) {
    throw new Error(`a new vault needs a passphrase of at least ${MIN_PASSPHRASE} characters, and COFFER_PASSPHRASE has ${passphrase.length}`);
  }
  const fs = new NodeFS(vault);
  const build = (remote: RemoteStore) =>
    new SyncEngine({
      fs,
      store: remote,
      stateStore: new FileState(stateFile),
      passphrase,
      config: resolveConfig({
        deviceName: hostname().split('.')[0],
        ...cli.sync,
        ...(member && { readOnly: receivesOnly }),
        // A custom list replaces the defaults, but this device's own state must never sync.
        exclude: [...(cli.sync?.exclude ?? DEFAULT_CONFIG.exclude), `${STATE_DIR}/**`],
      }),
      log: console.error,
      // Its member list lives apart from the sync state, which accepting storage resets.
      ...(member && { member: { keys: member.member, position: new FileState(join(vault, STATE_DIR, POSITION_FILE)) } }),
    });
  let engine = build(store);

  // New storage keys from the owner: used once they are shown to work for this device on this share, else the old ones stay.
  let toldRekey = 0;
  const switchKeys = async () => {
    if (!member || cli.remote.type === 'follow') return;
    const offer = await engine.rekeyOffer();
    if (!offer) return;
    const creds = credentialsFrom(member.storage, offer.storage);
    let next: RemoteStore | undefined;
    let problem = 'it holds no keys this version can use';
    if (creds) {
      try {
        next = makeStore(cli.remote, false, creds);
        problem = (await storageProblem(next, member.member)) ?? '';
      } catch (e) {
        problem = errorText(e);
      }
    }
    if (!creds || !next || problem) {
      if (toldRekey !== offer.n) console.error(`the owner sent new storage keys, but they do not work here (${problem}); this device keeps the ones it has`);
      toldRekey = offer.n;
      return;
    }
    member = { member: member.member, storage: creds };
    await saveKeyFile(keysFile, member);
    await engine.acceptRekey(offer.n);
    store = next;
    engine = build(store);
    console.error('the owner sent new storage keys, and this device now uses them');
  };
  const noteStanding = async () => {
    const standing = member && (await engine.memberStanding());
    memberNote = standing?.waiting ? `waiting for ${standing.owner || 'the owner'}'s device to confirm this device; until then it only receives` : undefined;
  };
  const syncNow = async (options?: SyncOptions) => {
    const r = await engine.sync(options);
    await noteStanding();
    return r;
  };
  if (command !== 'watch') await switchKeys();
  // A writing device the owner has not confirmed yet, or has removed, sends nothing: what would write, or would never be sent, is refused as on a device set to only receive.
  if (member?.member.key && WRITES[command] && !(command === 'restore-at' && flags.has('dry-run'))) {
    const standing = await engine.memberStanding();
    if (standing?.removed) throw new RemovedError();
    if (standing?.role && !standing.mayWrite) {
      const why = standing.waiting ? `this device only receives until ${standing.owner || 'the owner'}'s device confirms it` : 'this device may not send changes to this shared folder';
      console.error(`${why}, so ${WRITES[command]}; run ${command} once it may send them`);
      return 1;
    }
  }

  const heartbeat = async () => {
    // Nothing is written into a shared folder with members that other people read, as in the plugin.
    if (receivesOnly || member) return;
    try {
      await writeHeartbeat(await engine.view(), { platform: `CLI on ${SYSTEMS[process.platform] ?? process.platform}`, version: await version() });
    } catch (e) {
      console.error(`could not record this device's heartbeat: ${errorText(e)}`);
    }
  };

  if (command === 'sync') {
    const r = await syncNow({ force: flags.has('force') });
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
    let lastLeft = new Set<string>();
    let removed = false;
    let leave = () => {};
    const loop = new SyncLoop({
      sync: async () => {
        await switchKeys();
        const r = await syncNow();
        if (heartbeatDue(lastBeat, Date.now())) {
          lastBeat = Date.now();
          await heartbeat();
        }
        return r;
      },
      remoteChanged: () => engine.remoteChanged(),
      onResult: (r) => {
        // A file left alone is said once, when it first is, not at every sync that leaves it alone again.
        const left = leftAlone(r);
        const fresh = left.filter((line) => !lastLeft.has(line));
        lastLeft = new Set(left);
        if (didSomething(r)) report(r, `${stamp()} `, fresh);
        else for (const line of fresh) console.error(`${stamp()} ${line}`);
      },
      onFailure: (e, retryMs) => {
        const message = errorText(e);
        const why = e instanceof SafetyError ? `${message} Not retrying until something changes.` : e instanceof RemovedError ? `${message}. Not watching any more.` : `sync failed: ${message}; retrying in ${retryMs! / 1000}s`;
        console.error(`${stamp()} ${why}`);
        if (e instanceof SafetyError) console.error(`${stamp()} ${FORCE_HINT}`);
        if (e instanceof HistoryError) console.error(`${stamp()} ${ACCEPT_HINT}`);
        if (refusedWriting(e)) console.error(`${stamp()} ${READ_ONLY_HINT}`);
        const hint = memberHint(e);
        if (hint) console.error(`${stamp()} ${hint}`);
        // Nothing a removed device does is ever accepted again.
        if (e instanceof RemovedError) {
          removed = true;
          leave();
        }
      },
      debounceMs: WATCH_SETTLE_MS,
      pollMs,
      intervalMs,
    });
    // Watching starts before the first sync so that edits made during it are not missed.
    const watcher = watchVault(vault, fs, STATE_DIR, () => loop.changed(), (e) => console.error(`${stamp()} watching failed: ${e.message}; relying on the --interval syncs`));
    const signalled = new Promise<void>((done) => {
      leave = done;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => done());
    });
    console.log(
      `${stamp()} watching ${vault} against ${describeRemote(cli.remote)}${receivesOnly ? ', receive only' : ''}; ` +
        `checking for changes every ${pollMs / 1000}s and syncing everything every ${intervalMs / 1000}s`,
    );
    loop.start();
    await signalled;
    watcher.close();
    await loop.stop();
    return removed ? 1 : 0;
  }
  if (command === 'fetch' && rest.length) {
    const left = new Set((await engine.deferred()).map((f) => f.path));
    const not = rest.filter((path) => !left.has(vaultKey(path)));
    if (not.length) {
      console.error(`cannot fetch ${not.join(', ')}: not a file left in storage by sync.deferAboveMB; nothing was downloaded`);
      return 1;
    }
    const r = await syncNow({ fetch: rest });
    report(r);
    return r.errors.length ? 1 : 0;
  }
  if (command === 'history' && rest[0]) {
    const versions = await engine.history(vaultKey(rest[0]));
    if (!versions.length) {
      console.error(`no stored versions of ${rest[0]}`);
      return 1;
    }
    for (const v of versions) {
      console.log(`${String(v.seq).padStart(6)}  ${new Date(v.time).toISOString()}  ${v.device.padEnd(16)} ${v.entry ? `${v.entry.size} bytes` : 'deleted'}`);
    }
    return 0;
  }
  if (command === 'restore' && rest[1]) {
    const key = vaultKey(rest[0]);
    const version = (await engine.history(key)).find((v) => v.seq === Number(rest[1]));
    if (!version?.entry) throw new Error(`No restorable version ${rest[1]} of ${rest[0]}`);
    const data = await engine.readVersion(version.entry);
    const { st } = await engine.view();
    if (unsent(await fs.stat(rest[0]), st.synced.get(key))) {
      throw new Error(`${rest[0]} has changes on this device that are not synced yet; run sync first, so they are kept as a version, then restore`);
    }
    await fs.write(rest[0], data);
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
      for (const path of p.earlier ?? []) console.log(`  earlier versions of ${path} cannot be restored`);
    }
    const deep = r.deep ? `, ${plural(r.chunks, 'chunk')} (${(r.bytes / 1e6).toFixed(1)} MB downloaded)` : '';
    console.log(`checked ${plural(r.commits, 'commit')}, ${plural(r.files, 'file')}, ${plural(r.packs, 'pack')}${deep}: ${r.problems.length ? plural(r.problems.length, 'problem') : 'no problems'}`);
    return r.problems.length ? 1 : 0;
  }
  if (command === 'repair') {
    const deep = flags.has('deep');
    const r = await engine.repair({ deep });
    for (const path of r.repaired) console.log(`repaired: ${path}`);
    for (const path of r.unrepaired) console.error(`still missing: ${path}`);
    for (const path of r.historyOnly) console.log(`earlier versions cannot be restored: ${path}`);
    const lost = r.historyOnly.length ? `, ${plural(r.historyOnly.length, 'file')} with earlier versions that cannot be restored` : '';
    console.log(
      r.repaired.length || r.unrepaired.length || r.historyOnly.length
        ? `repaired ${plural(r.repaired.length, 'file')} (${plural(r.chunks, 'chunk')} stored again), ${r.unrepaired.length} still missing${lost}`
        : `nothing to repair: every stored object is present and whole in size${deep ? ', and the contents the current files use were read and are intact' : ' (repair --deep reads their contents)'}`,
    );
    return r.unrepaired.length ? 1 : 0;
  }
  if (command === 'change-passphrase') {
    const next = env('COFFER_NEW_PASSPHRASE');
    if (next.length < MIN_PASSPHRASE) throw new Error(`a new passphrase needs at least ${MIN_PASSPHRASE} characters, and COFFER_NEW_PASSPHRASE has ${next.length}`);
    await engine.changePassphrase(next);
    console.log('passphrase changed; update it on every device');
    return 0;
  }
  if (command === 'clean') {
    const r = await engine.gc();
    const deleted = [r.packsDeleted && `${plural(r.packsDeleted, 'pack')} (${sizeLabel(r.bytesFreed)})`, r.snapshotsDeleted && plural(r.snapshotsDeleted, 'snapshot')].filter(Boolean);
    if (deleted.length) console.log(`deleted ${deleted.join(' and ')} that no kept version needs`);
    if (r.packsCombined) {
      console.log(
        `copied the data still in use out of ${plural(r.packsCombined, 'small or mostly unused pack')} into ${plural(r.packsWritten, 'new pack')} (${sizeLabel(r.bytesMoved)}); ` +
          `a later clean deletes the old ones (${sizeLabel(r.bytesFreedLater)}) once no kept version reads them`,
      );
    }
    if (!deleted.length && !r.packsCombined) console.log('nothing to clean: no stored version has expired, and no pack is worth combining');
    return 0;
  }
  if (command === 'accept-storage') {
    await engine.acceptStorage();
    console.log('carrying on from storage as it is now');
    const r = await syncNow();
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
    if (e instanceof SafetyError) console.error(FORCE_HINT);
    if (refusedWriting(e)) console.error(READ_ONLY_HINT);
    const hint = memberHint(e);
    if (hint) console.error(hint);
    process.exit(1);
  },
);
