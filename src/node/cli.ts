import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pool } from '../core/bytes.ts';
import { DEFAULT_CONFIG, compileExcludes, resolveConfig, type SyncConfig } from '../core/config.ts';
import { MIN_PASSPHRASE, WrongPassphraseError } from '../core/crypto.ts';
import { agoText, heartbeatDue, listDevices, statusText, writeHeartbeat, type Beat } from '../core/devices.ts';
import { HistoryError, NoVaultError, PassphraseUnknownError, RemovedError, SafetyError, StorageGoneError, SyncEngine, UnverifiedError, type RepoView, type SyncOptions, type SyncResult } from '../core/engine.ts';
import { conflictOriginal, ext, vaultKey } from '../core/paths.ts';
import { Repo } from '../core/repo.ts';
import { listVersions } from '../core/retention.ts';
import { errorText, plural } from '../core/text.ts';
import { TooOldError, listActivity, listCommits, listDeleted, operationAt, planRestore, planUndo, tableAt, type Activity, type PastVault } from '../core/timeline.ts';
import type { Entry, RemoteStore } from '../core/types.ts';
import { changesOf, preparePublish, publishPrepared, summaryLines, type Prepared } from '../publish/publish.ts';
import { activityRows, whoLabel, type Self } from '../plugin/activity.ts';
import { applyRestore, countSteps, deleteLimitCrossed, keepDeferred, keepOut, leftNote, operationLabel, restoreSteps, sizeLabel, skippedNote, undoSteps, unsent, type Step } from '../plugin/restore.ts';
import { checkStore } from '../stores/doctor.ts';
import { MemoryStore } from '../stores/memory.ts';
import { openRemote } from '../stores/open.ts';
import type { S3Config } from '../stores/s3.ts';
import { KEYS_FILE, POSITION_FILE, STATE_FILE, credentialsFrom, joinWithLink, loadKeyFile, saveKeyFile, storageProblem, type Credentials, type KeyFile, type MemberRemote } from './member.ts';
import { FileState, FolderStore, NodeFS } from './nodefs.ts';
import { SyncLoop, watchVault } from './watch.ts';

/** Set at build time in dist/coffer.js; undefined when this file runs from source. */
declare const COFFER_VERSION: string | undefined;

/** Where a vault is stored or a website goes, with the secrets left out: they come from the environment. */
type SiteRemote = ({ type: 's3' } & Omit<S3Config, 'accessKey' | 'secretKey'>) | { type: 'webdav'; url: string; username: string } | { type: 'folder'; path: string };

/** Where `publish` puts the website: the notes marked to be published, as pages anyone with the address can read. `home` is the note that is the front page. */
interface SiteConfig {
  remote: SiteRemote;
  title?: string;
  home?: string;
  whole?: boolean;
  exclude?: string[];
}

interface CliConfig {
  vault: string;
  remote: SiteRemote | { type: 'follow'; url: string };
  /** Set by `join`: the name of a shared folder with members, whose keys are in the state folder's keys file. */
  share?: string;
  sync?: Partial<SyncConfig>;
  site?: SiteConfig;
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
  watch [--publish]      sync, then keep syncing until stopped; --poll=30 seconds between checks for
                         remote changes, --interval=300 seconds between full syncs. --publish also publishes
                         the website, as publish does, after the first sync and after each one that sends or
                         receives something, with no preview to check first: a note goes public as soon as
                         it syncs. A publish that fails is said and tried again after the next sync
  check                  test that the remote storage supports everything sync needs
  status [--json]        say, without syncing or writing anything to storage, whether storage can be reached,
                         its newest change, how each device keeps up, the files left in storage and the
                         conflict copies among synced files; exits 1 if storage cannot be reached or read, a
                         device disagrees about the sync history, or conflict copies are there. --json prints
                         the same as one JSON object, whose "ok" says whether all is well
  history <path>         list stored versions of a file
  restore <path> <seq>   write a stored version back into the vault
  deleted [folder]       list deleted files that can still be restored, newest first
  log [--limit=20]       list the times the vault can be restored to, newest first, each after
                         its number
  activity [--limit=20] [folder]
                         list the latest changes, newest first, each after its number: when, who made each (the
                         device, or in a shared folder with members the member) and the files it added, changed
                         and deleted, and who was invited, joined or was removed; with a folder, only the
                         changes to files in it
  undo <number> [--dry-run]
                         take one change back out, keeping everything done since: <number> is one that activity
                         prints, and what its device sent together with it is undone as one. A file untouched
                         since goes back to what it was, a note edited since keeps those edits, a moved file
                         goes back to its old name; what cannot be undone safely is left as it is and named.
                         Syncs first and again after, as restore-at does
  restore-at <time> [folder] [--dry-run]
                         bring the vault, or one folder, back to how it was at <time> (ISO 8601,
                         like 2026-11-10T14:30, or a number from log, which names that moment even
                         when device clocks disagree); syncs first, prints what changes, changes it,
                         leaving alone any file with changes that sync could not send, and syncs
                         again to send it, no --force needed for the files it removes
  export <dir> [folder] [--at=<time>]
                         write every file in storage, or those in one folder, decrypted into <dir> at its path in
                         the vault and with its modified time, including the files sync.deferAboveMB leaves in
                         storage; --at takes a time or a number as restore-at does, and writes the files as
                         they were then. <dir> must be outside the vault and new or empty. Writes nothing to
                         storage or the vault; exits 1 if some files could not be read, after writing the rest
  verify [--deep]        check the stored data end to end without changing it, including that the data of the
                         earlier versions history offers is still stored; --deep also downloads and checks
                         everything the current files are stored in
  repair [--deep]        store again, from the files in this vault, the data a verify finds missing
                         or damaged, so other devices can download those files; --deep also finds
                         damaged data inside packs that are there. Exits 1 if some files could not
                         be repaired, as when this vault does not have them: run it where they are
  clean                  delete versions older than the retention window from storage, and list the files whose
                         data is missing from storage; exits 1 if the current version of one is: run repair on a
                         device that has those files
  change-passphrase      re-protect the vault key with COFFER_NEW_PASSPHRASE (8 characters or more), at the
                         cost sync.kdfIterations sets in coffer.json if that is higher than the vault's now
  accept-storage         when sync stops because the history in storage is not the one this device
                         saw (part of it taken back or replaced), carry on from storage as it is now,
                         then sync: nothing is deleted, and where files differ both versions are kept.
                         Right after storage was restored from a backup; wrong if nobody did that on
                         purpose, as then someone else may have changed what is stored
  publish [--dry-run]    publish the notes whose properties say publish: true as a website, with the pictures, sound,
                         video and PDF files they show, to the location "site" gives in coffer.json: a "remote" of
                         type s3, webdav or folder (plain files, to host anywhere), set as the vault's remote is, with
                         "title" and "home" (the note that is the front page) if you want them. With "whole": true
                         every note of the vault is published except those that say publish: false, and "exclude"
                         lists folders and files to keep off it, written as sync.exclude is. The pages are NOT
                         encrypted: anyone with the address can read them. Only the vault folder is read, so no
                         passphrase is needed, a device that only receives may publish, and sync's own files are left
                         alone. Prints what is new, changed, removed and left out, then uploads what changed and
                         deletes the pages taken off; --dry-run stops after printing, and writes nothing

Secrets come from the environment: COFFER_PASSPHRASE, and for S3
COFFER_ACCESS_KEY and COFFER_SECRET_KEY, for WebDAV COFFER_WEBDAV_PASSWORD. A shared folder joined with a link keeps
its keys in .coffer/keys.json instead, and the environment is not read for it. The website's location has keys of
its own, never the vault's: COFFER_SITE_ACCESS_KEY and COFFER_SITE_SECRET_KEY for S3, COFFER_SITE_WEBDAV_PASSWORD for
WebDAV; a folder needs none.`;

/** The options that take a value, as `--name=value` or `--name value`; every other option takes none. */
const VALUED = ['config', 'poll', 'interval', 'limit', 'vault', 'at'];

/** Each command's options besides --config (and --help and --version, which stop any command). */
const OPTIONS: Record<string, string[]> = {
  join: ['vault'],
  sync: ['force'],
  fetch: [],
  watch: ['poll', 'interval', 'publish'],
  check: [],
  status: ['json'],
  history: [],
  restore: [],
  deleted: [],
  log: ['limit'],
  activity: ['limit'],
  'restore-at': ['dry-run'],
  undo: ['dry-run'],
  export: ['at'],
  verify: ['deep'],
  repair: ['deep'],
  clean: [],
  'change-passphrase': [],
  'accept-storage': [],
  publish: ['dry-run'],
};

/** What a device with sync.readOnly cannot do, as each command's reason: they write to storage, or to files it would never send. */
const WRITES: Record<string, string> = {
  clean: 'it does not clean up storage',
  repair: 'it cannot store data in storage again',
  restore: 'a restored file would never be sent',
  'restore-at': 'a restore would never be sent',
  undo: 'an undo would never be sent',
  'change-passphrase': 'it cannot change the passphrase in storage',
};

/** What only reads storage and must never write to it, not even the key file of a new vault where storage holds none yet. */
const LOOKS = new Set(['export', 'status']);

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
/** Export holds each file whole while it writes it: files above this size one at a time, the others a few at a time. */
const EXPORT_ALONE = 16 << 20;
/** Changes read at a time when activity lists only those in one folder, which may be far apart. */
const ACTIVITY_PAGE = 100;
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

/** The website's location, with keys of its own from the environment: `create` makes a folder that is not there yet. */
function makeSiteStore(remote: SiteRemote, create: boolean): RemoteStore {
  if (remote.type === 'folder') return new FolderStore(resolve(remote.path), { create });
  if (remote.type === 'webdav') return openRemote({ type: 'webdav', url: remote.url, username: remote.username, password: env('COFFER_SITE_WEBDAV_PASSWORD') });
  return openRemote({ ...remote, pathStyle: remote.pathStyle ?? true, prefix: remote.prefix ?? '', accessKey: env('COFFER_SITE_ACCESS_KEY'), secretKey: env('COFFER_SITE_SECRET_KEY') });
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
  const { vault, remote, sync, share, site } = c as Record<string, unknown>;
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
  const problem = remoteProblem(remote, 'remote', 'saying where the vault is stored', true);
  if (problem || site === undefined) return problem;
  if (typeof site !== 'object' || site === null || Array.isArray(site)) return 'needs "site" to be a JSON object';
  const { remote: where, title, home, whole, exclude } = site as Record<string, unknown>;
  return (
    remoteProblem(where, 'site.remote', 'saying where the website goes', false) ??
    (title !== undefined && typeof title !== 'string' ? 'needs "site.title" to be a text' : undefined) ??
    (home !== undefined && typeof home !== 'string' ? 'needs "site.home" to be a text' : undefined) ??
    (whole !== undefined && typeof whole !== 'boolean' ? 'needs "site.whole" to be true or false' : undefined) ??
    (exclude !== undefined && !(Array.isArray(exclude) && exclude.every((x) => typeof x === 'string')) ? 'needs "site.exclude" to be a list of texts' : undefined)
  );
}

/** Why `remote`, found at `at` in the config file, cannot say where things go, in words that follow "config file <path>". A vault's remote may also be a followed folder; a website's may not. */
function remoteProblem(remote: unknown, at: string, says: string, follow: boolean): string | undefined {
  if (typeof remote !== 'object' || remote === null) return `needs "${at}", ${says}`;
  const { type } = remote as Record<string, unknown>;
  const fields = typeof type === 'string' && Object.hasOwn(REMOTE_FIELDS, type) && (follow || type !== 'follow') ? REMOTE_FIELDS[type] : undefined;
  if (!fields) return `needs "${at}.type" to be s3, webdav or folder`;
  const missing = fields.find((f) => typeof (remote as Record<string, unknown>)[f] !== 'string');
  return missing && `needs "${at}.${missing}"`;
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

/** A moment as restore-at and export take it: a number that log prints, or a time in ISO 8601. */
function momentOf(when: string): number | { seq: number } {
  const at = /^\d+$/.test(when) ? { seq: Number(when) } : Date.parse(when);
  if (typeof at === 'number' && Number.isNaN(at)) throw new Error(`"${when}" is not a time; use ISO 8601, like 2026-11-10T14:30, or a number that log prints`);
  return at;
}

/** The files in storage at `at`, which `when` was read as. */
function vaultAt(v: RepoView, at: number | { seq: number }, when: string): Promise<PastVault> {
  return tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, at).catch((e: unknown) => {
    throw e instanceof TooOldError ? new Error(`${when} is too far back; the earliest time storage still holds is ${iso(e.earliest.time)} (number ${e.earliest.seq})`) : e;
  });
}

/** The folder `folder` as a prefix of the paths in it, or '' for the whole vault. */
const prefixOf = (folder: string) => (folder ? `${vaultKey(folder).replace(/\/+$/, '')}/` : '');

/** Applies a restore's or an undo's `steps` to the vault folder, made against `v`, and names the files it had to leave. */
async function applySteps(engine: SyncEngine, fs: NodeFS, v: RepoView, steps: Step[]) {
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
  for (const f of applied.failed) {
    const gone = /^Remote pack \S+ is missing/.test(f.message);
    console.error(`failed: ${f.path}: ${gone ? `the version to put back is no longer in storage, so the file is left as it is (${f.message})` : f.message}`);
  }
  return applied;
}

type Sync = (options?: SyncOptions) => Promise<SyncResult>;

/** Where the removals of a restore or an undo wait when the sync that sends them failed. */
const askedFile = (vault: string) => join(vault, STATE_DIR, 'asked-deletions.json');

async function askedDeletions(vault: string): Promise<string[]> {
  try {
    const paths: unknown = JSON.parse(await readFile(askedFile(vault), 'utf8'));
    return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The sync that sends what a restore or an undo changed, its removals as deletions the user asked for, so they do not
 * count against the guard here, nor on other devices. Undefined when it fails: the files stay changed here, and the
 * removals are kept for the next sync, which would otherwise take them for files that vanished and stop.
 */
async function sendResult(sync: Sync, vault: string, removed: string[]): Promise<SyncResult | undefined> {
  try {
    const r = await sync({ allowDeletes: removed });
    report(r, 'then synced: ');
    return r;
  } catch (e) {
    if (removed.length) await writeFile(askedFile(vault), JSON.stringify([...new Set([...(await askedDeletions(vault)), ...removed])]));
    console.error(`the files are changed here, but that could not be sent: ${errorText(e)}`);
    console.error('run sync to send it');
    return undefined;
  }
}

/**
 * Takes the operation commit `which` belongs to back out of the vault, keeping what was done since (`planUndo`). Syncs
 * first and after, as `restoreAt` does; a file it cannot undo safely is left as it is and named. With `dry`, only prints the plan.
 */
async function undo(engine: SyncEngine, sync: Sync, vault: string, fs: NodeFS, which: string, dry: boolean): Promise<number> {
  if (!/^\d+$/.test(which)) throw new Error(`"${which}" is not a number that activity prints`);
  if (!dry) {
    const r = await sync();
    report(r, 'synced first: ');
    if (r.errors.length) {
      console.error('not undoing: some files could not sync, and undoing could overwrite their changes');
      return 1;
    }
  }
  const v = await engine.view();
  const op = await operationAt(v.repo, v.st.lastSeq, v.cfg, Number(which));
  const kept = await keepDeferred(keepOut(v.cfg.exclude, []), engine);
  const mergeable = (path: string) => v.cfg.mergeExtensions.includes(ext(path));
  const { steps, skipped, left } = await undoSteps(planUndo(op.changes, v.st.remote), v.st.remote, kept, (e) => engine.readVersion(e), mergeable, v.cfg.concurrency);
  console.log(`what ${op.device} sent at ${iso(op.time)} (${operationLabel(op)}), taken back out:`);
  for (const s of steps) console.log(`  ${STEP[s.kind].padEnd(10)}  ${s.path}`);
  for (const s of skipped) console.log(`  left as it is  ${skippedNote(s)}`);
  if (left) console.log(leftNote(left));
  const c = countSteps(steps);
  if (!steps.length) {
    console.log(skipped.length ? 'nothing was undone' : 'nothing to do: no file is as that change left it');
    return skipped.length ? 1 : 0;
  }
  if (dry) {
    console.log(`dry run: would bring back ${c.add}, change ${c.change} and remove ${c.remove}; nothing changed`);
    return 0;
  }
  const applied = await applySteps(engine, fs, v, steps);
  const done = countSteps(applied.done);
  console.log(`undone: brought back ${done.add}, changed ${done.change}, removed ${done.remove}`);
  const r = await sendResult(sync, vault, applied.done.filter((s) => s.kind === 'remove').map((s) => s.path));
  return !r || applied.failed.length || skipped.length || r.errors.length ? 1 : 0;
}

/**
 * Brings the vault, or `folder`, back to how it was at `when`: a time, or a moment's number as `log` prints it, which
 * names that moment exactly whatever the clocks of the devices said. Removals first. Syncs first, so edits not yet
 * synced are kept in history and the plan matches the files here, and after, to send the result; a file with changes
 * that sync could not send is left as it is (see `applyRestore`). With `dry`, only prints the plan.
 */
async function restoreAt(engine: SyncEngine, sync: Sync, vault: string, fs: NodeFS, when: string, folder: string, dry: boolean): Promise<number> {
  const at = momentOf(when);
  if (!dry) {
    const r = await sync();
    report(r, 'synced first: ');
    if (r.errors.length) {
      console.error('not restoring: some files could not sync, and restoring could overwrite their changes');
      return 1;
    }
  }
  const v = await engine.view();
  const past = await vaultAt(v, at, when);
  const kept = await keepDeferred(keepOut(v.cfg.exclude, []), engine);
  const { steps, left } = restoreSteps(planRestore(v.st.remote, past.files, folder), v.st.remote, kept);
  const scope = prefixOf(folder) || 'the vault';
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

  const applied = await applySteps(engine, fs, v, steps);
  const done = countSteps(applied.done);
  const removed = applied.done.filter((s) => s.kind === 'remove').map((s) => s.path);
  const failed = applied.failed.length;
  console.log(`restored ${scope} as of ${iso(past.commit.time)}: brought back ${done.add}, changed ${done.change}, removed ${done.remove}`);
  const limit = deleteLimitCrossed(done.add + done.change, done.remove, v.st.synced.size, v.cfg);
  const r = await sendResult(sync, vault, removed);
  if (!r) return 1;
  if (limit !== undefined) {
    console.log(
      `the ${done.remove} files removed went to storage as deletions you asked for, so no --force was needed, and other devices delete them ` +
        `when they next sync; one on an older version, or many syncs behind, stops first, as it does before deleting more than ${limit} files ` +
        'at once in case they vanished by mistake, so sync that one with --force',
    );
  }
  return failed || r.errors.length ? 1 : 0;
}

/** Where `path` really is, so two folders can be compared: the part that exists is resolved through links, and what is not made yet is added after it. */
async function realPath(path: string): Promise<string> {
  const abs = resolve(path);
  try {
    return await realpath(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    const up = dirname(abs);
    return up === abs ? abs : join(await realPath(up), basename(abs));
  }
}

const within = (inner: string, outer: string) => {
  const way = relative(outer, inner);
  return way === '' || (way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way));
};

/** How the folder `there` stands to the vault `here`, both as `realPath` gives them: that it is the vault, holds it or is inside it, or '' when it is apart. */
const againstVault = (there: string, here: string) =>
  within(here, there) ? (there === here ? 'is the vault' : `holds the vault (${here})`) : within(there, here) ? `is inside the vault (${here})` : '';

/**
 * Where the website goes, once it is shown to be somewhere it may: not the vault's folder, nor one that holds it or is
 * inside it, nor where the vault is stored. `dry` never makes a folder that is not there yet.
 */
async function siteLocation(cli: CliConfig, vault: string, configFile: string, dry: boolean): Promise<{ site: SiteConfig; store: RemoteStore }> {
  const { site } = cli;
  if (!site) throw new Error(`config file ${resolve(configFile)} has no "site", which says where the website goes`);
  if (site.remote.type === 'folder') {
    const [there, here] = await Promise.all([realPath(site.remote.path), realPath(vault)]);
    const how = againstVault(there, here);
    if (how) throw new Error(`the website's folder must be outside the vault, so nothing was published: ${there} ${how}`);
  }
  // Before the vault's first sync its storage holds no vault.json yet, which is what the upload would refuse it by.
  const sync = cli.remote;
  const sameBucket = site.remote.type === 's3' && sync.type === 's3' && site.remote.endpoint === sync.endpoint && site.remote.bucket === sync.bucket && (site.remote.prefix ?? '') === (sync.prefix ?? '');
  const sameDav = site.remote.type === 'webdav' && sync.type === 'webdav' && site.remote.url === sync.url;
  const sameFolder = site.remote.type === 'folder' && sync.type === 'folder' && (await realPath(site.remote.path)) === (await realPath(sync.path));
  if (sameBucket || sameDav || sameFolder) throw new Error('the website must go somewhere other than where the vault is stored, so nothing was published');
  // A folder reads as a location with nothing in it when it is not there yet, and only a real run makes it.
  const store = dry && site.remote.type === 'folder' && !existsSync(resolve(site.remote.path)) ? new MemoryStore() : makeSiteStore(site.remote, !dry);
  return { site, store };
}

/** Builds the website from the vault folder and compares it with what `store` holds. Writes nothing. */
function prepareSite(cli: CliConfig, site: SiteConfig, vault: string, store: RemoteStore): Promise<Prepared> {
  const fs = new NodeFS(vault);
  const configDir = cli.sync?.configDir ?? DEFAULT_CONFIG.configDir;
  return preparePublish({ list: async () => (await fs.list()).map((f) => f.path), read: (path) => fs.read(path) }, store, {
    title: site.title ?? '',
    home: site.home ?? '',
    whole: site.whole ?? false,
    excluded: compileExcludes([...(cli.sync?.exclude ?? DEFAULT_CONFIG.exclude), ...(site.exclude ?? []), `${STATE_DIR}/**`, `${configDir}/**`]),
  });
}

/**
 * Publishes the notes that say publish: true to the location `cli.site` gives, as the plugin does: shows what would change
 * and, unless `dry`, uploads and deletes as shown. Reads only the vault folder and writes only the location, so no sync key
 * or state is needed or touched, and a folder for a website is never made by a dry run.
 */
async function publish(cli: CliConfig, vault: string, configFile: string, dry: boolean): Promise<number> {
  const { site, store } = await siteLocation(cli, vault, configFile, dry);
  const prepared = await prepareSite(cli, site, vault, store);
  for (const line of summaryLines(prepared)) console.log(line);
  if (dry) {
    console.log('dry run: nothing was uploaded or deleted');
    return 0;
  }
  if (changesOf(prepared).nothing) return 0;
  await publishPrepared(store, prepared);
  console.log(`published to ${describeRemote(site.remote)}`);
  return 0;
}

/**
 * Writes the files in storage, or those in `folder`, decrypted into `dir` at their paths in the vault, each with its
 * modified time: as storage holds them now, or with `when`, as they were then. Only into a new or empty folder apart from
 * the vault, so nothing there or anywhere else is overwritten. Memory holds a few small files or one large one at a time
 * (`EXPORT_ALONE`); one that cannot be read is named, and the others are written all the same.
 */
async function exportTo(engine: SyncEngine, vault: string, dir: string, folder: string, when: string | undefined): Promise<number> {
  const asked = when === undefined ? undefined : { when, at: momentOf(when) };
  const [there, here] = await Promise.all([realPath(dir), realPath(vault)]);
  const how = againstVault(there, here);
  if (how) throw new Error(`the folder to export to must be outside the vault, so nothing was exported: ${there} ${how}`);
  const held = await readdir(there).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  if (held.length) throw new Error(`${there} is not empty, so nothing was exported: export writes only into a new or empty folder`);
  const v = await engine.view();
  const past = asked && (await vaultAt(v, asked.at, asked.when));
  const prefix = prefixOf(folder);
  const files = [...(past ? past.files : v.st.remote)].filter(([path]) => path.startsWith(prefix));
  const asOf = past ? ` as of ${iso(past.commit.time)}` : '';
  if (prefix && !files.length) throw new Error(`no file in storage is in ${prefix}${asOf}, so nothing was exported`);
  await mkdir(there, { recursive: true });
  const out = new NodeFS(there);
  const failed: { path: string; message: string }[] = [];
  let bytes = 0;
  const one = async ([path, entry]: [string, Entry]) => {
    try {
      // The paths come from storage: one that would lead out of the folder is never written.
      if (path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) throw new Error('not a path inside the folder');
      const data = await engine.readVersion(entry);
      await out.write(path, data, entry.mtime);
      bytes += data.length;
    } catch (e) {
      failed.push({ path, message: errorText(e) });
    }
  };
  await pool(files.filter(([, e]) => e.size <= EXPORT_ALONE), v.cfg.concurrency, one);
  for (const [path, entry] of files) if (entry.size > EXPORT_ALONE) await one([path, entry]);
  for (const f of failed.sort((a, b) => (a.path < b.path ? -1 : 1))) console.error(`failed: ${f.path}: ${f.message}`);
  console.log(`exported ${plural(files.length - failed.length, 'file')} (${sizeLabel(bytes)}) of ${prefix || 'the vault'}${asOf} to ${there}`);
  return failed.length ? 1 : 0;
}

/** Who made a change, as history, log, deleted and status say it: where it is signed, as the plugin names people; elsewhere its device. */
const namer = (self: Self) => (c: { seq: number; device: string; signer?: string }) => (c.signer ? whoLabel(c, self) : c.device);

/** Why storage that answered could not be read, as status names it in JSON and says it after "but"; undefined when it may not have answered. */
function unreadable(e: unknown): { problem: string; but: string } | undefined {
  if (e instanceof WrongPassphraseError) return { problem: 'passphrase', but: 'the passphrase is wrong' };
  if (e instanceof HistoryError) return { problem: 'history', but: `its history is not the one this device saw: ${errorText(e)}\n${ACCEPT_HINT}` };
  if (e instanceof NoVaultError) return { problem: 'empty', but: 'it holds no synced vault yet' };
  if (e instanceof StorageGoneError) return { problem: 'gone', but: `the vault is gone from it: ${errorText(e)}` };
  return undefined;
}

/**
 * What an unattended device needs watched, without syncing or writing anything to storage: whether storage can be read,
 * its newest change, how each device keeps up (as the plugin's Devices list says it, unless `noDevices` says why not),
 * the files left in storage, and the conflict copies among the files sync sees. 1 when storage cannot be read, a device disagrees
 * about the sync history, or conflict copies are there; one that is behind or quiet is only reported, as a phone that
 * is switched off often is. Storage that answers but cannot be read says why: the passphrase, its history, no vault, or what else it answered with.
 */
async function status(
  engine: SyncEngine,
  fs: NodeFS,
  where: string,
  noDevices: string,
  selfOf: (v: RepoView) => Self,
  json: boolean,
  answers: () => Promise<boolean>,
): Promise<number> {
  let read;
  try {
    const v = await engine.view();
    const [newest] = v.st.lastSeq ? await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now, { limit: 1 }) : [];
    read = { v, newest, devices: noDevices ? undefined : await listDevices(v), left: await engine.deferred({ refresh: false }) };
  } catch (e) {
    const error = errorText(e);
    // Anything else, such as a log with a hole or a member list that does not verify, is told apart from storage that
    // never answered by asking it once more.
    const why = unreadable(e) ?? ((await answers()) ? { problem: 'unreadable', but: `it could not be read: ${error}` } : undefined);
    if (json) console.log(JSON.stringify({ ok: false, storage: { reachable: !!why, where, problem: why?.problem ?? 'unreachable', error } }, null, 2));
    else console.log(why ? `storage: reachable, ${where}, but ${why.but}` : `storage: not reachable, ${where}: ${error}`);
    return 1;
  }
  const { v, newest, devices, left } = read;
  const by = newest && namer(selfOf(v))(newest);
  // Only those sync would look at: a copy deleted to Obsidian's .trash is done with.
  const copies = (await fs.list()).map((f) => f.path).filter((path) => conflictOriginal(path) !== path && !engine.ignores(path)).sort();
  const problems = [
    ...(devices ?? []).filter((d) => d.state === 'diverged').map((d) => `${d.name} disagrees about the sync history`),
    ...(copies.length ? [plural(copies.length, 'conflict copy', 'conflict copies')] : []),
  ];
  if (json) {
    const report = {
      ok: !problems.length,
      storage: { reachable: true, where },
      newest: newest ? { seq: newest.seq, time: iso(newest.time), by } : null,
      devices:
        devices?.map((d) => ({
          name: d.name,
          thisDevice: d.isSelf,
          platform: d.platform,
          version: d.version,
          state: d.state,
          status: statusText(d, v.now),
          lastSeen: iso(d.lastSeen),
          ago: agoText(v.now - d.lastSeen),
          behind: d.behind,
        })) ?? null,
      ...(noDevices && { devicesNote: noDevices }),
      leftInStorage: left,
      conflictCopies: copies.map((path) => ({ path, of: conflictOriginal(path) })),
    };
    console.log(JSON.stringify(report, null, 2));
    return problems.length ? 1 : 0;
  }
  console.log(`storage: reachable, ${where}`);
  console.log(`newest change: ${newest ? `number ${newest.seq}, ${iso(newest.time)}, by ${by}` : 'none yet'}`);
  if (!devices) console.log(`devices: ${noDevices}`);
  else if (!devices.length) console.log('devices: none has reported yet; each appears after its next sync');
  else console.log('devices:');
  for (const d of devices ?? []) {
    const about = [d.platform, d.version && `v${d.version}`].filter(Boolean).join(' ');
    console.log(`  ${d.name}${d.isSelf ? ' (this device)' : ''}${about ? `, ${about}` : ''}, last synced ${agoText(v.now - d.lastSeen)}: ${statusText(d, v.now)}`);
  }
  console.log(`files left in storage: ${left.length ? `${left.length}, which fetch downloads` : 'none'}`);
  for (const f of left) console.log(`  ${f.path} (${sizeLabel(f.size)})`);
  console.log(`conflict copies: ${copies.length || 'none'}`);
  for (const path of copies) console.log(`  ${path}`);
  console.log(problems.length ? `needs attention: ${problems.join(', ')}` : 'all is well');
  return problems.length ? 1 : 0;
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
  // Before anything that needs the vault's keys, state or passphrase: publishing has no use for them, and none of it may be made or changed here.
  if (command === 'publish') return publish(cli, vault, configFile, flags.has('dry-run'));
  // Watching that publishes goes only where publish would, which is known before the first sync.
  const site = command === 'watch' && flags.has('publish') ? await siteLocation(cli, vault, configFile, false) : undefined;
  const looks = LOOKS.has(command);
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
  // restore-at and undo with --dry-run only read, so a device that only receives may look at what they would do.
  const looksOnly = (command === 'restore-at' || command === 'undo') && flags.has('dry-run');
  if (receivesOnly && WRITES[command] && !looksOnly) {
    console.error(`this device only receives changes, so ${WRITES[command]}; run ${command} from a device that sends them`);
    return 1;
  }
  let store = makeStore(cli.remote, !existsSync(stateFile) && !looks, member?.storage);

  if (command === 'check') {
    const report = await checkStore(store, receivesOnly);
    for (const c of report.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    return report.ok ? 0 : 1;
  }

  const passphrase = member ? '' : env('COFFER_PASSPHRASE');
  // Opening empty storage makes a vault, so a short passphrase is refused there. Only a short one pays the request to look.
  if (passphrase.length < MIN_PASSPHRASE && !member && !receivesOnly && !looks && !(await Repo.exists(store))) {
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
        ...(looks && { readOnly: true }),
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
    // Removals a restore or an undo made and could not send: still deletions the user asked for.
    const asked = await askedDeletions(vault);
    const r = await engine.sync({ ...options, allowDeletes: [...(options?.allowDeletes ?? []), ...asked] });
    if (asked.length) await rm(askedFile(vault), { force: true });
    await noteStanding();
    return r;
  };
  // Trying new storage keys writes to storage, which looking never does.
  if (command !== 'watch' && !looks) await switchKeys();
  // A writing device the owner has not confirmed yet, or has removed, sends nothing: what would write, or would never be sent, is refused as on a device set to only receive.
  if (member?.member.key && WRITES[command] && !looksOnly) {
    const standing = await engine.memberStanding();
    if (standing?.removed) throw new RemovedError();
    if (standing?.role && !standing.mayWrite) {
      const why = standing.waiting ? `this device only receives until ${standing.owner || 'the owner'}'s device confirms it` : 'this device may not send changes to this shared folder';
      console.error(`${why}, so ${WRITES[command]}; run ${command} once it may send them`);
      return 1;
    }
  }

  /** Who this device is in the history, to name people as the plugin does: its member in a shared folder with members, and its name. */
  const selfOf = (v: RepoView): Self => ({ member: member?.member.id, device: v.cfg.deviceName, changes: v.st.members });
  const limitOf = () => {
    const limit = flags.has('limit') ? Number(flags.get('limit')) : 20;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a whole number above 0');
    return limit;
  };

  /** Resolves to the newest commit the heartbeat gave, undefined when none was written. */
  const heartbeat = async (): Promise<number | undefined> => {
    // Nothing is written into a shared folder with members that other people read, as in the plugin.
    if (receivesOnly || member) return undefined;
    try {
      return await writeHeartbeat(await engine.view(), { platform: `CLI on ${SYSTEMS[process.platform] ?? process.platform}`, version: await version() });
    } catch (e) {
      console.error(`could not record this device's heartbeat: ${errorText(e)}`);
      return undefined;
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
    let lastBeat: Beat | undefined;
    let lastLeft = new Set<string>();
    let removed = false;
    let leave = () => {};
    // Whether the next sync publishes even if it changes nothing: the first does, and the one after a publish failed.
    let publishDue = true;
    // What the publish after a sync said, to print after that sync's own lines; `error` lines go to standard error.
    let published: { line: string; error?: boolean }[] = [];
    const publishNow = async (to: { site: SiteConfig; store: RemoteStore }) => {
      try {
        const prepared = await prepareSite(cli, to.site, vault, to.store);
        if (!changesOf(prepared).nothing) {
          published = summaryLines(prepared).map((line) => ({ line }));
          await publishPrepared(to.store, prepared);
          published.push({ line: `published to ${describeRemote(to.site.remote)}` });
        }
        publishDue = false;
      } catch (e) {
        published.push({ line: `publishing failed: ${errorText(e)}; trying again after the next sync`, error: true });
        publishDue = true;
      }
    };
    const loop = new SyncLoop({
      sync: async () => {
        await switchKeys();
        const r = await syncNow();
        const seq = engine.position();
        if (heartbeatDue(lastBeat, Date.now(), seq)) lastBeat = { time: Date.now(), seq: (await heartbeat()) ?? seq };
        // Here, not after: the loop never starts a sync before this returns, so a publish overlaps neither a sync nor another publish.
        if (site && (publishDue || didSomething(r))) await publishNow(site);
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
        for (const { line, error } of published) (error ? console.error : console.log)(`${stamp()} ${line}`);
        published = [];
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
    if (site) {
      console.log(
        `${stamp()} publishing the website to ${describeRemote(site.site.remote)} after the first sync and after each one that changes something, with no preview to check first: ` +
          (site.site.whole ? 'the whole vault is published, so every note, a new one too, goes public unless it says publish: false' : 'every note that says publish: true goes public'),
      );
    }
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
  if (command === 'status') {
    const noDevices =
      cli.remote.type === 'follow'
        ? 'not listed for a followed folder, which cannot be listed'
        : member
          ? 'not listed for a shared folder with members, where devices do not record how far they have got'
          : '';
    return status(engine, fs, describeRemote(cli.remote), noDevices, selfOf, flags.has('json'), () => Repo.answers(store));
  }
  if (command === 'export' && rest[0]) return exportTo(engine, vault, rest[0], rest[1] ?? '', flags.get('at'));
  if (command === 'activity') {
    const limit = limitOf();
    const v = await engine.view();
    const prefix = prefixOf(rest[0] ?? '');
    const inside = (path: string) => path.startsWith(prefix);
    // With a folder, only the changes to files in it, each with those files alone: pages are read until there are enough.
    const items: Activity[] = [];
    for (let beforeSeq: number | undefined; items.length < limit; ) {
      const page = await listActivity(v.repo, v.st.lastSeq, v.cfg, { limit: prefix ? Math.max(limit, ACTIVITY_PAGE) : limit, beforeSeq });
      for (const a of page.items) {
        const only = { ...a, added: a.added.filter(inside), changed: a.changed.filter(inside), deleted: a.deleted.filter(inside) };
        if (!prefix || only.added.length + only.changed.length + only.deleted.length) items.push(only);
      }
      if (page.next === undefined) break;
      beforeSeq = page.next;
    }
    if (!items.length) console.error(`no changes ${prefix ? `to ${prefix} ` : ''}in the history storage keeps`);
    for (const r of activityRows(items.slice(0, limit), selfOf(v))) {
      if (!r.who) {
        console.log(`${String(r.seq).padStart(6)}  ${iso(r.time)}  ${r.text}`);
        continue;
      }
      console.log(`${String(r.seq).padStart(6)}  ${iso(r.time)}  ${r.who.padEnd(16)} ${r.text}`);
      for (const f of r.files) console.log(`  ${f.kind.padEnd(7)}  ${f.path}`);
    }
    return 0;
  }
  if (command === 'history' && rest[0]) {
    const view = await engine.view();
    const versions = await listVersions(view.repo, view.st.lastSeq, vaultKey(rest[0]), view.cfg, view.now);
    if (!versions.length) {
      console.error(`no stored versions of ${rest[0]}`);
      return 1;
    }
    const by = namer(selfOf(view));
    for (const v of versions) {
      console.log(`${String(v.seq).padStart(6)}  ${new Date(v.time).toISOString()}  ${by(v).padEnd(16)} ${v.entry ? `${v.entry.size} bytes` : 'deleted'}`);
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
    const by = namer(selfOf(v));
    for (const d of await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now, rest[0] ?? '')) console.log(`${iso(d.time)}  ${by(d).padEnd(16)} ${d.path}`);
    return 0;
  }
  if (command === 'log') {
    const limit = limitOf();
    const v = await engine.view();
    const by = namer(selfOf(v));
    for (const c of await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now, { limit })) {
      console.log(`${String(c.seq).padStart(6)}  ${iso(c.time)}  ${by(c).padEnd(16)} ${c.added} added, ${c.changed} changed, ${c.deleted} deleted`);
    }
    return 0;
  }
  if (command === 'restore-at' && rest[0]) return restoreAt(engine, syncNow, vault, fs, rest[0], rest[1] ?? '', flags.has('dry-run'));
  if (command === 'undo' && rest[0]) return undo(engine, syncNow, vault, fs, rest[0], flags.has('dry-run'));
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
    try {
      await engine.changePassphrase(next);
    } catch (e) {
      if (!(e instanceof PassphraseUnknownError)) {
        // The reason and any hint follow from the shared error handling below.
        console.error('the passphrase was not changed');
        throw e;
      }
      console.error(`${errorText(e)}. If a sync then says the passphrase is wrong, storage took the new one: use COFFER_NEW_PASSPHRASE as COFFER_PASSPHRASE from now on`);
      return 1;
    }
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
    if (!r.missing) {
      console.error('could not tell this time whether storage still holds all the data the files need: run clean again later');
      return 0;
    }
    for (const path of r.missing) console.error(`missing from storage: ${path}`);
    for (const path of r.missingEarlier) console.log(`earlier versions of ${path} cannot be restored`);
    if (!r.missing.length) return 0;
    console.error(`run repair on a device that has ${r.missing.length === 1 ? 'this file' : 'these files'}, to store ${r.missing.length === 1 ? 'its' : 'their'} data again`);
    return 1;
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
