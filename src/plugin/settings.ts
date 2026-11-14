// The plugin's settings and what they translate into. No Obsidian import, so it runs under plain Node tests.
import { DEFAULT_CONFIG, compileExcludes, resolveConfig, type SyncConfig } from '../core/config.ts';
import { MIN_PASSPHRASE, WrongPassphraseError, openWithPassphrase, sealWithPassphrase } from '../core/crypto.ts';
import { FOLLOW_PREFIX, INVITE_PREFIX, ownerKeysFrom, type MemberKeys, type Role } from '../core/members.ts';
import { vaultKey } from '../core/paths.ts';
import { saysTrue } from '../publish/site.ts';
import { DAY } from '../core/retention.ts';
import { isInside } from '../core/scopedfs.ts';
import type { RemoteSpec } from '../stores/open.ts';

/** Where synced data is kept and the passphrase that opens it: the vault's own, or a shared folder's. */
export interface Storage {
  storageType: 's3' | 'webdav';
  webdavUrl: string;
  webdavUser: string;
  webdavPasswordSecret: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  /** Names of entries in Obsidian's secret storage; the values never touch the vault. */
  accessKeySecret: string;
  secretKeySecret: string;
  passphraseSecret: string;
  /** This device never writes to this storage: what it changes stays here, and files it deletes come back. */
  readOnly: boolean;
}

/**
 * A folder of this vault that syncs with storage of its own, under a passphrase of its own, instead of with the
 * vault: shared with other people, or kept somewhere else. Added on each device separately.
 */
export interface Share extends Storage {
  /** Made on this device when the share is added. Names its state file and its secrets. */
  id: string;
  /** Where it is in this vault, without slashes at either end. */
  folder: string;
  lastSuccess: number;
  lastCleanup: number;
  /** Conflict copies made here that still exist, as paths inside the folder. */
  conflictCopies: string[];
  /** Files a restore removed here, by path inside the folder, until a sync deletes them from storage as confirmed. */
  restored: string[];
  /** The folder went missing. Nothing syncs until the user downloads it again or stops sharing it here. */
  missing: boolean;
  /**
   * The vault's files that were in the folder when it was shared on this device, by vault path. The vault's storage
   * keeps them for devices that did not add the share, and this device's vault sync leaves them alone: see shares.ts.
   */
  vaultCopies: string[];
  /** In a shared folder with members, this device's role, as it joined or started it; '' in one shared with a passphrase. */
  role: '' | Role;
  /** In a shared folder with members, the secret holding this device's keys to it (`MemberKeys`, as JSON); otherwise ''. */
  memberKeysSecret: string;
  /**
   * A shared folder followed with a follow link: the public address it is read from, with no storage keys; otherwise ''.
   * Such a share's storage fields are unused.
   */
  followUrl: string;
  /**
   * This device still owes the vault's storage its offer of the share to the vault's other devices (offers.ts): 'add'
   * once added here, 'update' after its keys changed, which rewrites an offer only where one is still kept.
   */
  offerPending: '' | 'add' | 'update';
  /**
   * A member's device that only reads: the files it sent the owner as a suggestion, by path inside the folder, each with
   * a fingerprint of the text sent, so the same text is not sent again. Kept while the file is still not sent.
   */
  suggested: [string, string][];
  /**
   * Notes shared by a property (byproperty.ts): the name, which its notes carry as `share: <name>`; '' for a shared
   * folder. Such a share's `folder` is '': its files are wherever they are in the vault.
   */
  property: string;
  /** Notes shared by a property: files the sharer took out of it, by vault path; see `PropertyShare`. */
  removed: string[];
  /** Notes shared by a property: attachments the sharer said to share after they waited, by vault path. */
  approved: string[];
  /** Notes shared by a property: attachments that wait for the sharer, brought by a suggestion taken in, by vault path. */
  ask: string[];
}

/** Where this vault's website goes and what it is called. Its location is never the vault's own storage: pages are stored there as they are, readable by anyone. */
export interface SiteSettings {
  storageType: 's3' | 'webdav';
  webdavUrl: string;
  webdavUser: string;
  webdavPasswordSecret: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  /** Names of entries in Obsidian's secret storage. */
  accessKeySecret: string;
  secretKeySecret: string;
  /** Shown at the top of every page. */
  title: string;
  /** Vault path of the note that is the front page; '' for a list of pages only. */
  home: string;
  /** The whole vault is the website: every note is on it unless its properties say `publish: false`. */
  whole: boolean;
  /** Folders and files kept off the website, one pattern a line, written as the vault's own exclusions are. */
  except: string;
  /** The address people open the website at, for the link shown after publishing; '' when not given. */
  url: string;
  /** When a publish last finished here; 0 before the first. */
  lastPublished: number;
}

export interface Settings extends Storage {
  deviceName: string;
  syncOnStart: boolean;
  intervalMinutes: number;
  changeDelaySeconds: number;
  /** How often to ask the storage whether another device has synced. 0 turns it off. */
  pollSeconds: number;
  /** Expired versions are removed this often. 0 leaves it to the manual command. */
  autoCleanDays: number;
  lastCleanup: number;
  syncConfigDir: boolean;
  exclude: string;
  conflictStrategy: 'merge' | 'copy';
  retentionDays: number;
  maxFileSizeMB: number;
  /** Files larger than this stay in storage until asked for, here and in every shared folder. 0 downloads everything. */
  deferAboveMB: number;
  concurrency: number;
  compression: boolean;
  /** When a sync last finished without failing; 0 before the first one. */
  lastSuccess: number;
  /** Conflict copies made here that still exist, so they stay on the problem list until dealt with. */
  conflictCopies: string[];
  /**
   * Files a restore removed here, until a sync deletes them from storage as deletions the user confirmed (`allowDeletes`):
   * kept across restarts, so a restart before that sync does not send them as deletions nobody confirmed.
   */
  restored: string[];
  shares: Share[];
  /** Shared folders offered by the vault's other devices (offers.ts) that this device has announced, by share id. */
  offersTold: string[];
  /** Offers the user chose not to add on this device, by share id. */
  offersHidden: string[];
  site: SiteSettings;
}

const SITE_DEFAULTS: SiteSettings = {
  storageType: 's3',
  webdavUrl: '',
  webdavUser: '',
  webdavPasswordSecret: '',
  endpoint: '',
  region: 'auto',
  bucket: '',
  prefix: '',
  pathStyle: true,
  accessKeySecret: '',
  secretKeySecret: '',
  title: '',
  home: '',
  whole: false,
  except: '',
  url: '',
  lastPublished: 0,
};

export function defaultSettings(isMobile: boolean): Settings {
  return {
    storageType: 's3',
    webdavUrl: '',
    webdavUser: '',
    webdavPasswordSecret: '',
    endpoint: '',
    region: 'auto',
    bucket: '',
    prefix: 'vault',
    pathStyle: true,
    accessKeySecret: '',
    secretKeySecret: '',
    passphraseSecret: '',
    readOnly: false,
    deviceName: '',
    syncOnStart: true,
    intervalMinutes: 5,
    changeDelaySeconds: 5,
    pollSeconds: 30,
    autoCleanDays: 7,
    lastCleanup: 0,
    syncConfigDir: true,
    exclude: '',
    conflictStrategy: DEFAULT_CONFIG.conflictStrategy,
    retentionDays: DEFAULT_CONFIG.retentionDays,
    maxFileSizeMB: isMobile ? 200 : DEFAULT_CONFIG.maxFileSizeMB,
    deferAboveMB: DEFAULT_CONFIG.deferAboveMB,
    concurrency: DEFAULT_CONFIG.concurrency,
    compression: DEFAULT_CONFIG.compression,
    lastSuccess: 0,
    conflictCopies: [],
    restored: [],
    shares: [],
    offersTold: [],
    offersHidden: [],
    site: { ...SITE_DEFAULTS },
  };
}

const STORAGE_DEFAULTS: Storage = {
  storageType: 's3',
  webdavUrl: '',
  webdavUser: '',
  webdavPasswordSecret: '',
  endpoint: '',
  region: 'auto',
  bucket: '',
  prefix: '',
  pathStyle: true,
  accessKeySecret: '',
  secretKeySecret: '',
  passphraseSecret: '',
  readOnly: false,
};

/** A share with every field present, as saved by any version. */
export function shareWith(fields: Partial<Share> & Pick<Share, 'id' | 'folder'>): Share {
  return {
    ...STORAGE_DEFAULTS, lastSuccess: 0, lastCleanup: 0, conflictCopies: [], restored: [], missing: false, vaultCopies: [], role: '', memberKeysSecret: '', followUrl: '', offerPending: '', suggested: [],
    property: '', removed: [], approved: [], ask: [],
    ...fields,
  };
}

/** The settings as saved, with defaults for whatever an older version did not save. */
export function loadSettings(saved: Partial<Settings> | null, isMobile: boolean): Settings {
  const s = { ...defaultSettings(isMobile), ...saved };
  s.shares = (saved?.shares ?? []).map(shareWith);
  s.site = { ...SITE_DEFAULTS, ...saved?.site };
  return s;
}

/** Whether `s` shares notes by a property rather than a folder. */
export const byProperty = (s: Pick<Share, 'property'>) => !!s.property;

/** The shares that are folders of this vault, which take their folder out of the vault's sync. */
export const folderShares = (shares: Share[]) => shares.filter((x) => !x.property);

/** What a share is called on screen: its folder, or for notes shared by a property, its name. */
export const labelOf = (s: Pick<Share, 'property' | 'folder'>) => s.property || s.folder;

/** Reads a secret by the name a setting holds; '' when unset. */
export type SecretLookup = (name: string) => string;

/** Storage as a shared folder has it, which may be a public address it follows instead (`Share.followUrl`). */
type Place = Storage & { followUrl?: string };

/** Storage, its credentials and what opens it are all there: the passphrase, or in a shared folder with members its keys. */
export function isConfigured(s: Place & { memberKeysSecret?: string }, secret: SecretLookup): boolean {
  if (s.followUrl) return !!secret(s.memberKeysSecret ?? '');
  const storage =
    s.storageType === 'webdav'
      ? s.webdavUrl && s.webdavUser && secret(s.webdavPasswordSecret)
      : s.endpoint && s.bucket && secret(s.accessKeySecret) && secret(s.secretKeySecret);
  return !!(storage && secret(s.memberKeysSecret || s.passphraseSecret));
}

/** Enough to try a connection. */
export function hasStorageAddress(s: Place): boolean {
  if (s.followUrl) return true;
  return !(s.storageType === 'webdav' ? !s.webdavUrl : !s.endpoint || !s.bucket);
}

export function remoteSpec(s: Place, secret: SecretLookup): RemoteSpec {
  if (s.followUrl) return { type: 'follow', url: s.followUrl.trim() };
  if (s.storageType === 'webdav') {
    return { type: 'webdav', url: s.webdavUrl.trim(), username: s.webdavUser, password: secret(s.webdavPasswordSecret) };
  }
  return {
    type: 's3',
    endpoint: s.endpoint.trim(),
    region: s.region.trim() || 'auto',
    bucket: s.bucket.trim(),
    prefix: s.prefix,
    pathStyle: s.pathStyle,
    accessKey: secret(s.accessKeySecret),
    secretKey: secret(s.secretKeySecret),
  };
}

/** The website's location, its credentials and an address for them are all there. */
export function siteConfigured(site: SiteSettings, secret: SecretLookup): boolean {
  if (site.storageType === 'webdav') return !!(site.webdavUrl.trim() && site.webdavUser.trim() && secret(site.webdavPasswordSecret));
  return !!(site.endpoint.trim() && site.bucket.trim() && secret(site.accessKeySecret) && secret(site.secretKeySecret));
}

/** How to reach the website's location, in the form every store opens. */
export function siteSpec(site: SiteSettings, secret: SecretLookup): RemoteSpec {
  return remoteSpec({ ...STORAGE_DEFAULTS, ...site }, secret);
}

/** An address with its scheme and host in lower case and no slash at the end, so two spellings of one address compare equal. */
function addressOf(url: string): string {
  const u = withScheme(url);
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}${p.search}`.replace(/\/+$/, '');
  } catch {
    return u;
  }
}

const trimmedPath = (path: string) => path.replace(/^[\s/]+|[\s/]+$/g, '');

/** Whether one of two paths is the other or a folder inside it; the empty path is the top, which holds everything. */
const overlaps = (a: string, b: string) => a === b || !a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Whether one of `a` and `b` is the other's place or a folder inside it: an address that is not filled in is no place. */
function overlappingLocation(a: Storage | SiteSettings, b: Storage | SiteSettings): boolean {
  if (a.storageType !== b.storageType) return false;
  if (a.storageType === 'webdav') return !!(a.webdavUrl.trim() && b.webdavUrl.trim()) && overlaps(addressOf(a.webdavUrl), addressOf(b.webdavUrl));
  return !!(a.endpoint.trim() && a.bucket.trim()) && addressOf(a.endpoint) === addressOf(b.endpoint) && a.bucket.trim() === b.bucket.trim() && overlaps(trimmedPath(a.prefix), trimmedPath(b.prefix));
}

/**
 * The website's location is where the vault or a shared folder is stored, or a folder inside that, or one that holds it:
 * pages must not land among synced data, and a location made public must not hold any.
 */
export function siteAtVaultStorage(site: SiteSettings, s: Settings): boolean {
  return overlappingLocation(site, s) || s.shares.some((x) => !x.followUrl && overlappingLocation(site, x));
}

/** Whether the website's own exclusions (`SiteSettings.except`) keep a vault path off it. */
export const siteExcept = (site: SiteSettings): ((key: string) => boolean) => compileExcludes(site.except.split('\n'));

/**
 * Whether a note is on the website by what Obsidian has read of its properties: it says `publish: true`, or the whole
 * vault is published and it has no `publish` property saying otherwise.
 */
export function onWebsite(site: SiteSettings, properties: Record<string, unknown>): boolean {
  const keys = Object.keys(properties).filter((k) => k.toLowerCase() === 'publish');
  if (!keys.length) return site.whole;
  return keys.length === 1 && saysTrue(properties[keys[0]]);
}

/** The website's public address with one slash at the end, or '' when none is given or it is not an http or https address. */
export function siteLink(site: SiteSettings): string {
  const url = site.url.trim();
  return /^https?:\/\/[^\s/]/i.test(url) ? `${url.replace(/\/+$/, '')}/` : '';
}

/** Where an engine keeps this device's sync state, inside the plugin's own folder: the vault's, or share `id`'s. */
export const statePath = (pluginDir: string, id = '') => `${pluginDir}/${id ? `state-${id}` : 'state'}.json`;

/**
 * Where a shared folder with members keeps the newest member list this device accepted: apart from its sync state,
 * which carrying on from storage or downloading again resets, and this must survive.
 */
export const positionPath = (pluginDir: string, id: string) => `${pluginDir}/members-${id}.json`;

const tuning = (s: Settings) => ({
  conflictStrategy: s.conflictStrategy,
  retentionDays: s.retentionDays,
  maxFileSizeMB: s.maxFileSizeMB,
  deferAboveMB: s.deferAboveMB,
  concurrency: s.concurrency,
  compression: s.compression,
});

/**
 * What this device's sync can not see, and so leaves out: what Obsidian's file list leaves out, files and folders
 * whose name starts with a dot, except the settings folder, which is read from disk (without its node_modules folders)
 * when it syncs. A file the sync downloaded and then could not see would look deleted, and the next sync would delete
 * it everywhere; left out, such files are neither downloaded nor deleted here, wherever other devices sync them.
 */
function unlisted(configDir: string, withConfig: boolean): string[] {
  const top = withConfig && configDir.startsWith('.') ? `.!(${configDir.slice(1)})/` : '.*/';
  return ['.*', '*/**/.*/', top, ...(withConfig ? [`${configDir}/**/node_modules/`] : [`${configDir}/`])];
}

/**
 * The vault's own sync. Shared folders sync with their own storage, so the vault leaves them out, and with them the
 * vault's own files that were in them when they were shared here, wherever they have moved since (see shares.ts).
 */
export function syncConfig(s: Settings, configDir: string, pluginDir: string): SyncConfig {
  return resolveConfig({
    deviceName: s.deviceName,
    configDir,
    exclude: [
      ...DEFAULT_CONFIG.exclude.map((p) => p.replace(/^\.obsidian\//, `${configDir}/`)),
      ...unlisted(configDir, s.syncConfigDir),
      // Device-specific. The plugin's code itself does sync, so an update reaches every device.
      statePath(pluginDir),
      `${pluginDir}/data.json`,
      // A state file's copy while it is saved, or left by an app stopped then (statefile.ts).
      `${pluginDir}/*.json.tmp`,
      ...s.exclude.split('\n'),
      // Notes shared by a property stay in the vault's sync: only their share's own files are left out.
      ...s.shares.flatMap((x) => [
        ...(x.property ? [] : [`${vaultKey(x.folder)}/`, ...x.vaultCopies.filter((key) => !isInside(x.folder, key))]),
        statePath(pluginDir, x.id),
        positionPath(pluginDir, x.id),
      ]),
    ],
    ...tuning(s),
    readOnly: s.readOnly,
  });
}

/**
 * Notes shared by a property, with vault paths: never more than the vault's own sync reaches here (shared folders and
 * what is left out included), and never the settings folder or a name starting with a dot, even when the vault syncs them.
 */
export function propertyConfig(s: Settings, configDir: string, pluginDir: string): SyncConfig {
  const vault = syncConfig(s, configDir, pluginDir);
  return resolveConfig({ ...vault, exclude: [...vault.exclude, `${configDir}/`, '.*', '**/.*/'], readOnly: false });
}

/**
 * A shared folder's sync, with paths inside the folder. Of the vault's patterns it keeps those for file names, which
 * apply anywhere, and those written for paths inside the folder, made relative to it; a pattern like `Shared/*.tmp`
 * then also matches deeper down, as `*.tmp` does. Shared folders inside this one are left to their own sync.
 */
export function shareConfig(s: Settings, share: Share, configDir: string): SyncConfig {
  const at = `${vaultKey(share.folder)}/`;
  const exclude: string[] = [];
  for (const raw of [...DEFAULT_CONFIG.exclude, ...s.exclude.split('\n')]) {
    const p = vaultKey(raw.trim());
    if (!p) continue;
    if (!p.includes('/') || p.startsWith('**/')) exclude.push(p);
    else if (p.startsWith(at) && p.length > at.length) exclude.push(p.slice(at.length));
  }
  for (const other of folderShares(s.shares)) if (isInside(share.folder, other.folder)) exclude.push(`${vaultKey(other.folder).slice(at.length)}/`);
  // Obsidian's file list has no name starting with a dot, at any depth of a shared folder: see `unlisted`.
  exclude.push('.*', '**/.*/');
  return resolveConfig({ deviceName: s.deviceName, configDir, exclude, ...tuning(s), readOnly: share.readOnly });
}

/** A folder path as settings keep it: forward slashes, none doubled or at either end. */
export const normalFolder = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');

const folded = (path: string) => vaultKey(path).toLowerCase();

/**
 * Why `folder` cannot be a shared folder in this vault, or '' when it can. Folders are compared ignoring case, as
 * some file systems do. `id` is a share being changed, which does not count against itself. `byProperty` are the files
 * notes shared by a property hold here: a shared folder would freeze them there, so it may not hold any.
 */
export function folderProblem(s: Settings, folder: string, configDir: string, pluginDir: string, id = '', byProperty: Iterable<string> = []): string {
  if (!folder) return 'A shared folder is a folder inside the vault. The whole vault can not be one.';
  if (folder !== normalFolder(folder) || folder.split('/').some((p) => p === '.' || p === '..')) return 'That is not a folder name.';
  if (/[*?"<>:|]/.test(folder)) return 'Folder names can not contain * ? " < > : or |.';
  if (folded(folder) === folded(configDir) || isInside(folded(configDir), folded(folder))) return `The settings folder (${configDir}) can not be shared.`;
  if (folder.split('/').some((p) => p.startsWith('.'))) return 'Obsidian does not show folders whose name starts with a dot, so they can not be shared.';
  for (const other of folderShares(s.shares)) {
    if (other.id === id) continue;
    const [a, b] = [folded(folder), folded(other.folder)];
    if (a === b) return `“${other.folder}” is already a shared folder.`;
    if (isInside(b, a)) return `That is inside the shared folder “${other.folder}”. Shared folders can not be inside each other.`;
    if (isInside(a, b)) return `The shared folder “${other.folder}” is inside it. Shared folders can not be inside each other.`;
  }
  const excluded = compileExcludes(syncConfig({ ...s, shares: [] }, configDir, pluginDir).exclude);
  if (excluded(`${vaultKey(folder)}/`)) return `“${folder}” is left out of sync on this device (What to sync → Leave out), so it can not be shared.`;
  const inside = [...byProperty].filter((key) => isInside(folded(folder), folded(key))).length;
  const property = s.shares.find((x) => x.property);
  if (inside && property) {
    return `“${folder}” holds ${inside === 1 ? 'a file' : `${inside.toLocaleString()} files`} shared in “${property.property}”. Remove ${inside === 1 ? 'it' : 'them'} from “${property.property}” first, or choose another folder.`;
  }
  return '';
}

/** Where `s` keeps its data: the same text for any two settings that reach the same place. */
export function storageLocation(s: Place): string {
  if (s.followUrl) return `follow ${withScheme(s.followUrl).toLowerCase()}`;
  if (s.storageType === 'webdav') return `webdav ${withScheme(s.webdavUrl).toLowerCase()}`;
  return `s3 ${withScheme(s.endpoint).toLowerCase()} ${s.bucket.trim()} ${s.prefix.replace(/^\/+|\/+$/g, '')}`;
}

/** Why a share cannot sync with `storage`, or '' when it can. `id` is a share being changed. */
export function storageProblem(s: Settings, storage: Place, id = ''): string {
  const here = storageLocation(storage);
  if (hasStorageAddress(s) && storageLocation(s) === here) return 'That is where this vault itself syncs. A shared folder needs a location of its own.';
  const other = s.shares.find((x) => x.id !== id && storageLocation(x) === here);
  return other ? `${other.property ? 'The shared notes' : 'The shared folder'} “${labelOf(other)}” already ${other.property ? 'sync' : 'syncs'} with that location.` : '';
}

const origin = (url: string) => {
  try {
    return new URL(withScheme(url)).origin.toLowerCase();
  } catch {
    return url;
  }
};

/** `a` reaches the bucket or server of `b` with the same keys, so whoever holds one could change the other. */
export function sameKeys(a: Place, b: Place, secret: SecretLookup): boolean {
  if (a.followUrl || b.followUrl) return false;
  if (a.storageType !== b.storageType || !hasStorageAddress(a) || !hasStorageAddress(b)) return false;
  if (a.storageType === 'webdav') return origin(a.webdavUrl) === origin(b.webdavUrl) && a.webdavUser.trim() === b.webdavUser.trim();
  return withScheme(a.endpoint).toLowerCase() === withScheme(b.endpoint).toLowerCase() && a.bucket.trim() === b.bucket.trim() && secret(a.accessKeySecret) === secret(b.accessKeySecret);
}

/** The vault's storage at a new place inside the vault's own location, for a share named `name`; `tag` makes it unique. */
export function besideVault(s: Storage, name: string, tag: string): Storage {
  const storage: Storage = { ...STORAGE_DEFAULTS };
  for (const k of Object.keys(STORAGE_DEFAULTS) as (keyof Storage)[]) (storage as unknown as Record<string, unknown>)[k] = s[k];
  storage.readOnly = false;
  const place = `shared-${folderFor(name)}-${tag}`;
  if (s.storageType === 'webdav') storage.webdavUrl = `${s.webdavUrl.trim().replace(/\/+$/, '')}/${place}`;
  else storage.prefix = [s.prefix.replace(/^\/+|\/+$/g, ''), place].filter(Boolean).join('/');
  return storage;
}

/** The value a number field holds, or null when it is empty, not a number, or below `min`. */
export function parseNumberSetting(text: string, min: number): number | null {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) || n < min ? null : n;
}

/**
 * Cleanup is due every `autoCleanDays`, and, with `fragmented` (storage holds many small packs, see `compactionDue`),
 * after a day. It never runs when automatic cleanup is off.
 */
export function cleanupDue(s: Pick<Settings, 'autoCleanDays' | 'lastCleanup'>, now: number, fragmented = false): boolean {
  if (s.autoCleanDays <= 0) return false;
  const since = now - s.lastCleanup;
  return since > s.autoCleanDays * DAY || (fragmented && since > DAY);
}

// A setup code carries these settings, then these credentials, in this order.
const SETUP_FIELDS = ['storageType', 'endpoint', 'region', 'bucket', 'prefix', 'pathStyle', 'webdavUrl', 'webdavUser'] as const;
/** Field in the code, setting that names the secret, secret name used on the receiving device. */
const SETUP_SECRETS = [
  ['accessKey', 'accessKeySecret', 'coffer-access-key'],
  ['secretKey', 'secretKeySecret', 'coffer-secret-key'],
  ['webdavPassword', 'webdavPasswordSecret', 'coffer-webdav-password'],
] as const;

const VAULT_CODE = 'coffer2.';
const SHARE_CODE = 'coffershare2.';
/** Version 1 (0.1 and 0.2) sealed at a fixed 200,000 iterations and left the count out. */
const CODE = /^coffer(share)?([12])\./;

/** What a code is: a vault's setup code, an invite to a shared folder (with a passphrase, a member's, or a follow link), or neither. */
export function codeKind(code: string): 'vault' | 'share' | undefined {
  if (isMemberInvite(code) || isFollowLink(code)) return 'share';
  const m = CODE.exec(code.trim());
  return m ? (m[1] ? 'share' : 'vault') : undefined;
}

/** An invite of a member to a shared folder with members, which needs no passphrase: the link is all it takes. */
export const isMemberInvite = (code: string) => code.trim().startsWith(INVITE_PREFIX);

/** A follow link, which reads a public copy of a shared folder with members: no passphrase and no storage keys. */
export const isFollowLink = (code: string) => code.trim().startsWith(FOLLOW_PREFIX);

/** A link that opens with nothing typed: a member's invite or a follow link. */
export const opensAlone = (code: string) => isMemberInvite(code) || isFollowLink(code);

/** The PBKDF2 cost a link is sealed at: the vault's own, and never less than a new vault gets. */
export function codeIterations(vault?: number): number {
  return Math.max(DEFAULT_CONFIG.kdfIterations, vault ?? 0);
}

/**
 * Where `s` is stored and the keys that reach it, as a setup code and a member's invite carry them. The same fields in
 * both, so whatever reads one reads the other.
 */
export function storagePayload(s: Storage, secret: SecretLookup): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of SETUP_FIELDS) payload[f] = s[f];
  for (const [field, setting] of SETUP_SECRETS) payload[field] = secret(s[setting]);
  return payload;
}

/**
 * The storage settings a payload of `storagePayload` describes, and its keys as secrets to store first, named by
 * `name`. A member's invite is not sealed, so every field is checked to be what it should be.
 */
export function storageFromPayload(p: Record<string, unknown>, name: (base: string) => string): { storage: Partial<Storage>; secrets: [string, string][] } {
  const storage: Record<string, unknown> = { storageType: p.storageType === 'webdav' ? 'webdav' : 's3' };
  for (const f of SETUP_FIELDS) {
    if (f === 'storageType') continue;
    if (f === 'pathStyle') storage[f] = p[f] !== false;
    else storage[f] = typeof p[f] === 'string' ? p[f] : '';
  }
  const secrets: [string, string][] = [];
  for (const [field, setting, base] of SETUP_SECRETS) {
    const value = p[field];
    storage[setting] = typeof value === 'string' && value ? name(base) : '';
    if (storage[setting]) secrets.push([storage[setting] as string, value as string]);
  }
  return { storage, secrets };
}

/**
 * Storage settings and keys, encrypted under the passphrase, for pasting into another device. With `folder`, an
 * invite to a shared folder, which suggests that folder name to whoever joins and, from a place that only receives,
 * turns that on for them. A vault's link leaves it to the device that joins. `extra` adds to what it carries, as an
 * owner link adds the owner's keys.
 */
export async function encodeSetupCode(s: Storage, secret: SecretLookup, folder?: string, iterations = codeIterations(), extra: Record<string, unknown> = {}): Promise<string> {
  const payload = { ...storagePayload(s, secret), ...extra };
  if (folder !== undefined) {
    if (s.readOnly) payload.readOnly = true;
    payload.folder = folder;
  }
  const passphrase = secret(s.passphraseSecret);
  if (!passphrase) throw new Error('This device does not have the passphrase that seals the link');
  return `${folder === undefined ? VAULT_CODE : SHARE_CODE}${await sealWithPassphrase(JSON.stringify(payload), passphrase, iterations)}`;
}

/**
 * The name a vault keeps one of its secrets under. A phone has one keychain for every vault, so a fixed name would let
 * setting up a second vault replace the first one's keys and passphrase. Names may hold a-z, 0-9 and -, up to 64.
 */
export function secretName(base: string, vault: string): string {
  let h = 0x811c9dc5;
  for (const ch of vault) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193);
  const tag = (h >>> 0).toString(36);
  const slug = vault
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64 - base.length - tag.length - 2)
    .replace(/-+$/, '');
  return [base, slug, tag].filter(Boolean).join('-');
}

/** The name share `id` of `vault` keeps one of its secrets under, apart from the vault's and every other share's. */
export const shareSecretName = (base: string, vault: string, id: string) => secretName(base, `${vault} ${id}`);

/**
 * A prefixed code opens as its own version. Without a prefix it is tried as the new layout, which fails before any key
 * is made unless its first four bytes read as a plausible count, and then as the old.
 */
async function openSealed(code: string, passphrase: string): Promise<string> {
  const sealed = code.replace(CODE, '');
  const version = CODE.exec(code)?.[2];
  if (version) return openWithPassphrase(sealed, passphrase, version !== '2');
  return openWithPassphrase(sealed, passphrase).catch(() => openWithPassphrase(sealed, passphrase, true));
}

async function openCode(code: string, passphrase: string, name: (base: string) => string) {
  const p = JSON.parse(await openSealed(code.trim(), passphrase)) as Record<string, unknown>;
  const { storage, secrets } = storageFromPayload(p, name);
  const settings: Record<string, unknown> = { ...storage };
  const invite = typeof p.folder === 'string';
  if (invite && p.readOnly === true) settings.readOnly = true;
  settings.passphraseSecret = passphrase ? name('coffer-passphrase') : '';
  if (passphrase) secrets.push([settings.passphraseSecret as string, passphrase]);
  return { settings, secrets, folder: invite ? (p.folder as string) : '', member: ownerKeysFrom(p) };
}

/** The settings a setup code fills in, and the secrets to store first, in order, named for `vault`. */
export async function decodeSetupCode(code: string, passphrase: string, vault: string): Promise<{ settings: Partial<Settings>; secrets: [string, string][] }> {
  if (codeKind(code) === 'share') throw new Error('This is an invite link to a shared folder. Add it under Shared folders in the Coffer settings.');
  const { settings, secrets } = await openCode(code, passphrase, (base) => secretName(base, vault));
  return { settings, secrets };
}

/**
 * An invite's storage settings and the secrets to store first, named for share `id` of `vault`, and the name of the
 * folder it was shared from. The name comes from someone else, so only its last part is kept, to be checked like any.
 * An owner link, which sets up another of the owner's devices for a shared folder with members, also gives the
 * owner's keys (`member`).
 */
export async function decodeInvite(
  code: string,
  passphrase: string,
  vault: string,
  id: string,
): Promise<{ storage: Partial<Storage>; secrets: [string, string][]; folder: string; member?: MemberKeys }> {
  const kind = codeKind(code);
  if (kind !== 'share' || opensAlone(code)) throw new Error(kind === 'vault' ? 'This is a setup link for a whole vault, not an invite to a shared folder.' : 'That is not an invite link.');
  const { settings, secrets, folder, member } = await openCode(code, passphrase, (base) => shareSecretName(base, vault, id));
  return { storage: settings, secrets, folder: lastPart(folder), ...(member && { member }) };
}

/** The last part of a folder name someone else suggests, to be checked like any. */
export const lastPart = (folder: string) => normalFolder(folder).split('/').pop() ?? '';

export type Provider = 'r2' | 'b2' | 'aws' | 's3' | 'webdav';

export const PROVIDERS: { id: Provider; name: string; hint: string }[] = [
  { id: 'r2', name: 'Cloudflare R2', hint: 'Free up to 10 GB. You need the account ID, a bucket and an R2 API token.' },
  { id: 'b2', name: 'Backblaze B2', hint: "Free up to 10 GB. You need the bucket's endpoint and an application key." },
  { id: 'aws', name: 'Amazon S3', hint: "You need the bucket's region and an access key." },
  { id: 's3', name: 'Other S3-compatible', hint: 'MinIO, Wasabi, Garage, DigitalOcean Spaces and others.' },
  { id: 'webdav', name: 'WebDAV', hint: 'Nextcloud, ownCloud, a NAS or any WebDAV server.' },
];

/** What the setup form asks for. `location` is the account ID (R2), endpoint (B2, other), region (AWS) or folder address (WebDAV). */
export interface StorageForm {
  location: string;
  bucket: string;
  prefix: string;
  user: string;
  region: string;
  pathStyle: boolean;
}

const withScheme = (url: string) => {
  const u = url.trim();
  return (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, '');
};

/** The region an S3 endpoint names, for the providers that put it in the host name. */
export function regionFromEndpoint(endpoint: string): string | undefined {
  return /\bs3[.-]([a-z]{2}-[a-z]+-\d{1,3})\.(?:amazonaws\.com|backblazeb2\.com|wasabisys\.com)/i.exec(endpoint)?.[1]?.toLowerCase();
}

/** Turns the setup form into storage settings, or explains what is missing. */
export function storageSettings(provider: Provider, f: StorageForm): Partial<Settings> {
  const location = f.location.trim();
  const need = (ok: unknown, what: string) => {
    if (!ok) throw new Error(what);
  };
  if (provider === 'webdav') {
    need(location, 'Enter the folder address.');
    need(f.user.trim(), 'Enter the user name.');
    return { storageType: 'webdav', webdavUrl: withScheme(location), webdavUser: f.user.trim() };
  }
  need(f.bucket.trim(), 'Enter the bucket name.');
  const base = { storageType: 's3' as const, bucket: f.bucket.trim(), prefix: f.prefix.trim() };
  if (provider === 'r2') {
    need(location, 'Enter the account ID, or the S3 API address shown for the bucket.');
    const endpoint = /[./]/.test(location) ? withScheme(location) : `https://${location}.r2.cloudflarestorage.com`;
    return { ...base, endpoint, region: 'auto', pathStyle: true };
  }
  if (provider === 'aws') {
    need(/^[a-z]{2}-[a-z]+-\d{1,3}$/.test(location.toLowerCase()), 'Enter the region shown for the bucket, like us-east-1.');
    return { ...base, endpoint: `https://s3.${location.toLowerCase()}.amazonaws.com`, region: location.toLowerCase(), pathStyle: false };
  }
  need(location, 'Enter the endpoint address.');
  const endpoint = withScheme(location);
  if (provider === 'b2') {
    const region = regionFromEndpoint(endpoint);
    need(region, "Enter the endpoint shown on the bucket's page, like s3.us-west-004.backblazeb2.com.");
    return { ...base, endpoint, region, pathStyle: true };
  }
  return { ...base, endpoint, region: f.region.trim() || regionFromEndpoint(endpoint) || 'us-east-1', pathStyle: f.pathStyle };
}

export function providerOf(s: Storage): Provider {
  if (s.storageType === 'webdav') return 'webdav';
  if (/r2\.cloudflarestorage\.com/i.test(s.endpoint)) return 'r2';
  if (/backblazeb2\.com/i.test(s.endpoint)) return 'b2';
  if (/amazonaws\.com/i.test(s.endpoint)) return 'aws';
  return 's3';
}

/** One line naming where this vault, or a shared folder, syncs to. */
export function describeStorage(s: Place): string {
  if (s.followUrl) {
    try {
      return `Public copy · ${new URL(s.followUrl.trim()).host}`;
    } catch {
      return 'Public copy';
    }
  }
  if (s.storageType === 'webdav') {
    try {
      return `WebDAV · ${new URL(withScheme(s.webdavUrl)).host}`;
    } catch {
      return 'WebDAV';
    }
  }
  const name = PROVIDERS.find((p) => p.id === providerOf(s))!.name;
  return [providerOf(s) === 's3' ? s.endpoint.replace(/^https?:\/\//, '') : name, s.bucket, s.prefix].filter(Boolean).join(' · ');
}

/** A folder name for this vault inside a shared bucket. */
export const folderFor = (vaultName: string) => vaultName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'vault';

/** A link that opens Obsidian on the other device with the setup code, or the invite, filled in. */
export const setupLink = (code: string) => `obsidian://coffer?${codeKind(code) === 'share' ? 'share' : 'setup'}=${encodeURIComponent(code)}`;

/** The code inside whatever was pasted: the code itself, a setup link or an invite link. */
export function setupCodeFrom(text: string): string {
  const t = text.trim();
  const m = /[?&](?:setup|share)=([^&\s]+)/.exec(t);
  if (!m) return t;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // Cut inside an escape: what is left reads as the damaged code it is.
    return m[1];
  }
}

/** Why a link did not open, in a few words. A link cut short fails as a wrong passphrase does: encryption cannot tell them apart. */
export function linkProblem(e: unknown, what: 'setup' | 'invite'): string {
  if (e instanceof WrongPassphraseError) return `That passphrase does not open this ${what} link. If it is right, copy the link again: one cut short fails the same way.`;
  return `That is not a valid or complete ${what} link. Copy it again${what === 'setup' ? ' on the other device' : ''}.`;
}

/** Why `passphrase` cannot be chosen for a vault or shared folder, or '' when it can. One only being entered opens whatever its length. */
export function passphraseProblem(passphrase: string, repeat: string, entering = false): string {
  if (!passphrase) return 'Enter the passphrase.';
  if (entering) return '';
  if (passphrase.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters.`;
  return passphrase === repeat ? '' : 'The two entries do not match.';
}
