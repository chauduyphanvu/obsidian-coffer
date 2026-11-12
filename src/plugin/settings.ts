// The plugin's settings and what they translate into. No Obsidian import, so it runs under plain Node tests.
import { DEFAULT_CONFIG, compileExcludes, resolveConfig, type SyncConfig } from '../core/config.ts';
import { openWithPassphrase, sealWithPassphrase } from '../core/crypto.ts';
import { vaultKey } from '../core/paths.ts';
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
  /** The folder went missing. Nothing syncs until the user downloads it again or stops sharing it here. */
  missing: boolean;
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
  concurrency: number;
  compression: boolean;
  /** When a sync last finished without failing; 0 before the first one. */
  lastSuccess: number;
  /** Conflict copies made here that still exist, so they stay on the problem list until dealt with. */
  conflictCopies: string[];
  shares: Share[];
}

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
    concurrency: DEFAULT_CONFIG.concurrency,
    compression: DEFAULT_CONFIG.compression,
    lastSuccess: 0,
    conflictCopies: [],
    shares: [],
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
};

/** A share with every field present, as saved by any version. */
export function shareWith(fields: Partial<Share> & Pick<Share, 'id' | 'folder'>): Share {
  return { ...STORAGE_DEFAULTS, lastSuccess: 0, lastCleanup: 0, conflictCopies: [], missing: false, ...fields };
}

/** The settings as saved, with defaults for whatever an older version did not save. */
export function loadSettings(saved: Partial<Settings> | null, isMobile: boolean): Settings {
  const s = { ...defaultSettings(isMobile), ...saved };
  s.shares = (saved?.shares ?? []).map(shareWith);
  return s;
}

/** Reads a secret by the name a setting holds; '' when unset. */
export type SecretLookup = (name: string) => string;

/** Storage, its credentials and the passphrase are all there. */
export function isConfigured(s: Storage, secret: SecretLookup): boolean {
  const storage =
    s.storageType === 'webdav'
      ? s.webdavUrl && s.webdavUser && secret(s.webdavPasswordSecret)
      : s.endpoint && s.bucket && secret(s.accessKeySecret) && secret(s.secretKeySecret);
  return !!(storage && secret(s.passphraseSecret));
}

/** Enough to try a connection. */
export function hasStorageAddress(s: Storage): boolean {
  return !(s.storageType === 'webdav' ? !s.webdavUrl : !s.endpoint || !s.bucket);
}

export function remoteSpec(s: Storage, secret: SecretLookup): RemoteSpec {
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

/** Where an engine keeps this device's sync state, inside the plugin's own folder: the vault's, or share `id`'s. */
export const statePath = (pluginDir: string, id = '') => `${pluginDir}/${id ? `state-${id}` : 'state'}.json`;

const tuning = (s: Settings) => ({
  conflictStrategy: s.conflictStrategy,
  retentionDays: s.retentionDays,
  maxFileSizeMB: s.maxFileSizeMB,
  concurrency: s.concurrency,
  compression: s.compression,
});

/** The vault's own sync. Shared folders sync with their own storage, so the vault leaves them out. */
export function syncConfig(s: Settings, configDir: string, pluginDir: string): SyncConfig {
  return resolveConfig({
    deviceName: s.deviceName,
    configDir,
    exclude: [
      ...DEFAULT_CONFIG.exclude.map((p) => p.replace(/^\.obsidian\//, `${configDir}/`)),
      // Device-specific. The plugin's code itself does sync, so an update reaches every device.
      statePath(pluginDir),
      `${pluginDir}/data.json`,
      ...s.exclude.split('\n'),
      ...s.shares.flatMap((x) => [`${vaultKey(x.folder)}/`, statePath(pluginDir, x.id)]),
    ],
    ...tuning(s),
  });
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
  for (const other of s.shares) if (isInside(share.folder, other.folder)) exclude.push(`${vaultKey(other.folder).slice(at.length)}/`);
  return resolveConfig({ deviceName: s.deviceName, configDir, exclude, ...tuning(s) });
}

/** A folder path as settings keep it: forward slashes, none doubled or at either end. */
export const normalFolder = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');

const folded = (path: string) => vaultKey(path).toLowerCase();

/**
 * Why `folder` cannot be a shared folder in this vault, or '' when it can. Folders are compared ignoring case, as
 * some file systems do. `id` is a share being changed, which does not count against itself.
 */
export function folderProblem(s: Settings, folder: string, configDir: string, pluginDir: string, id = ''): string {
  if (!folder) return 'A shared folder is a folder inside the vault. The whole vault can not be one.';
  if (folder !== normalFolder(folder) || folder.split('/').some((p) => p === '.' || p === '..')) return 'That is not a folder name.';
  if (/[*?"<>:|]/.test(folder)) return 'Folder names can not contain * ? " < > : or |.';
  if (folded(folder) === folded(configDir) || isInside(folded(configDir), folded(folder))) return `The settings folder (${configDir}) can not be shared.`;
  if (folder.split('/').some((p) => p.startsWith('.'))) return 'Obsidian does not show folders whose name starts with a dot, so they can not be shared.';
  for (const other of s.shares) {
    if (other.id === id) continue;
    const [a, b] = [folded(folder), folded(other.folder)];
    if (a === b) return `“${other.folder}” is already a shared folder.`;
    if (isInside(b, a)) return `That is inside the shared folder “${other.folder}”. Shared folders can not be inside each other.`;
    if (isInside(a, b)) return `The shared folder “${other.folder}” is inside it. Shared folders can not be inside each other.`;
  }
  const excluded = compileExcludes(syncConfig({ ...s, shares: [] }, configDir, pluginDir).exclude);
  if (excluded(`${vaultKey(folder)}/`)) return `“${folder}” is left out of sync on this device (What to sync → Leave out), so it can not be shared.`;
  return '';
}

/** Where `s` keeps its data: the same text for any two settings that reach the same place. */
export function storageLocation(s: Storage): string {
  if (s.storageType === 'webdav') return `webdav ${withScheme(s.webdavUrl).toLowerCase()}`;
  return `s3 ${withScheme(s.endpoint).toLowerCase()} ${s.bucket.trim()} ${s.prefix.replace(/^\/+|\/+$/g, '')}`;
}

/** Why a share cannot sync with `storage`, or '' when it can. `id` is a share being changed. */
export function storageProblem(s: Settings, storage: Storage, id = ''): string {
  const here = storageLocation(storage);
  if (hasStorageAddress(s) && storageLocation(s) === here) return 'That is where this vault itself syncs. A shared folder needs a location of its own.';
  const other = s.shares.find((x) => x.id !== id && storageLocation(x) === here);
  return other ? `The shared folder “${other.folder}” already syncs with that location.` : '';
}

const origin = (url: string) => {
  try {
    return new URL(withScheme(url)).origin.toLowerCase();
  } catch {
    return url;
  }
};

/** `a` reaches the bucket or server of `b` with the same keys, so whoever holds one could change the other. */
export function sameKeys(a: Storage, b: Storage, secret: SecretLookup): boolean {
  if (a.storageType !== b.storageType || !hasStorageAddress(a) || !hasStorageAddress(b)) return false;
  if (a.storageType === 'webdav') return origin(a.webdavUrl) === origin(b.webdavUrl) && a.webdavUser.trim() === b.webdavUser.trim();
  return withScheme(a.endpoint).toLowerCase() === withScheme(b.endpoint).toLowerCase() && a.bucket.trim() === b.bucket.trim() && secret(a.accessKeySecret) === secret(b.accessKeySecret);
}

/** The vault's storage at a new place inside the vault's own location, for a share named `name`; `tag` makes it unique. */
export function besideVault(s: Storage, name: string, tag: string): Storage {
  const storage: Storage = { ...STORAGE_DEFAULTS };
  for (const k of Object.keys(STORAGE_DEFAULTS) as (keyof Storage)[]) (storage as unknown as Record<string, unknown>)[k] = s[k];
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

export function cleanupDue(s: Pick<Settings, 'autoCleanDays' | 'lastCleanup'>, now: number): boolean {
  return s.autoCleanDays > 0 && now - s.lastCleanup > s.autoCleanDays * DAY;
}

// A setup code carries these settings, then these credentials, in this order.
const SETUP_FIELDS = ['storageType', 'endpoint', 'region', 'bucket', 'prefix', 'pathStyle', 'webdavUrl', 'webdavUser'] as const;
/** Field in the code, setting that names the secret, secret name used on the receiving device. */
const SETUP_SECRETS = [
  ['accessKey', 'accessKeySecret', 'self-sync-access-key'],
  ['secretKey', 'secretKeySecret', 'self-sync-secret-key'],
  ['webdavPassword', 'webdavPasswordSecret', 'self-sync-webdav-password'],
] as const;

const VAULT_CODE = 'selfsync1.';
const SHARE_CODE = 'selfshare1.';

/** What a code is: a vault's setup code, an invite to a shared folder, or neither. */
export function codeKind(code: string): 'vault' | 'share' | undefined {
  const c = code.trim();
  return c.startsWith(VAULT_CODE) ? 'vault' : c.startsWith(SHARE_CODE) ? 'share' : undefined;
}

/**
 * Storage settings and keys, encrypted under the passphrase, for pasting into another device. With `folder`, an
 * invite to a shared folder, which suggests that folder name to whoever joins.
 */
export async function encodeSetupCode(s: Storage, secret: SecretLookup, folder?: string): Promise<string> {
  const payload: Record<string, unknown> = {};
  for (const f of SETUP_FIELDS) payload[f] = s[f];
  for (const [field, setting] of SETUP_SECRETS) payload[field] = secret(s[setting]);
  if (folder !== undefined) payload.folder = folder;
  return `${folder === undefined ? VAULT_CODE : SHARE_CODE}${await sealWithPassphrase(JSON.stringify(payload), secret(s.passphraseSecret))}`;
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

async function openCode(code: string, passphrase: string, name: (base: string) => string) {
  const body = code.trim().replace(/^selfs(?:ync|hare)1\./, '');
  const p = JSON.parse(await openWithPassphrase(body, passphrase)) as Record<string, string | boolean>;
  const settings: Record<string, unknown> = { storageType: p.storageType === 'webdav' ? 'webdav' : 's3' };
  for (const f of SETUP_FIELDS) if (f !== 'storageType') settings[f] = p[f];
  const secrets: [string, string][] = [];
  const keep = (base: string, value: string | boolean) => {
    const id = name(base);
    if (value) secrets.push([id, String(value)]);
    return value ? id : '';
  };
  for (const [field, setting, id] of SETUP_SECRETS) settings[setting] = keep(id, p[field]);
  settings.passphraseSecret = keep('self-sync-passphrase', passphrase);
  return { settings, secrets, folder: typeof p.folder === 'string' ? p.folder : '' };
}

/** The settings a setup code fills in, and the secrets to store first, in order, named for `vault`. */
export async function decodeSetupCode(code: string, passphrase: string, vault: string): Promise<{ settings: Partial<Settings>; secrets: [string, string][] }> {
  if (codeKind(code) === 'share') throw new Error('This is an invite link to a shared folder. Add it under Shared folders in the Self Sync settings.');
  const { settings, secrets } = await openCode(code, passphrase, (base) => secretName(base, vault));
  return { settings: settings as Partial<Settings>, secrets };
}

/**
 * An invite's storage settings and the secrets to store first, named for share `id` of `vault`, and the name of the
 * folder it was shared from. The name comes from someone else, so only its last part is kept, to be checked like any.
 */
export async function decodeInvite(code: string, passphrase: string, vault: string, id: string): Promise<{ storage: Partial<Storage>; secrets: [string, string][]; folder: string }> {
  const kind = codeKind(code);
  if (kind !== 'share') throw new Error(kind === 'vault' ? 'This is a setup link for a whole vault, not an invite to a shared folder.' : 'That is not an invite link.');
  const { settings, secrets, folder } = await openCode(code, passphrase, (base) => shareSecretName(base, vault, id));
  return { storage: settings as Partial<Storage>, secrets, folder: normalFolder(folder).split('/').pop() ?? '' };
}

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
export function describeStorage(s: Storage): string {
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
export const setupLink = (code: string) => `obsidian://self-sync?${codeKind(code) === 'share' ? 'share' : 'setup'}=${encodeURIComponent(code)}`;

/** The code inside whatever was pasted: the code itself, a setup link or an invite link. */
export function setupCodeFrom(text: string): string {
  const t = text.trim();
  const m = /[?&](?:setup|share)=([^&\s]+)/.exec(t);
  return m ? decodeURIComponent(m[1]) : t;
}
