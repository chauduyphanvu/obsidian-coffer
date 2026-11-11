// The plugin's settings and what they translate into. No Obsidian import, so it runs under plain Node tests.
import { DEFAULT_CONFIG, resolveConfig, type SyncConfig } from '../core/config.ts';
import { openWithPassphrase, sealWithPassphrase } from '../core/crypto.ts';
import { DAY } from '../core/retention.ts';
import type { RemoteSpec } from '../stores/open.ts';

export interface Settings {
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
  };
}

/** Reads a secret by the name a setting holds; '' when unset. */
export type SecretLookup = (name: string) => string;

/** Storage, its credentials and the passphrase are all there. */
export function isConfigured(s: Settings, secret: SecretLookup): boolean {
  const storage =
    s.storageType === 'webdav'
      ? s.webdavUrl && s.webdavUser && secret(s.webdavPasswordSecret)
      : s.endpoint && s.bucket && secret(s.accessKeySecret) && secret(s.secretKeySecret);
  return !!(storage && secret(s.passphraseSecret));
}

/** Enough to try a connection. */
export function hasStorageAddress(s: Settings): boolean {
  return !(s.storageType === 'webdav' ? !s.webdavUrl : !s.endpoint || !s.bucket);
}

export function remoteSpec(s: Settings, secret: SecretLookup): RemoteSpec {
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

/** Where the engine keeps this device's sync state, inside the plugin's own folder. */
export const statePath = (pluginDir: string) => `${pluginDir}/state.json`;

export function syncConfig(s: Settings, configDir: string, pluginDir: string): SyncConfig {
  return resolveConfig({
    deviceName: s.deviceName,
    exclude: [
      ...DEFAULT_CONFIG.exclude.map((p) => p.replace(/^\.obsidian\//, `${configDir}/`)),
      // Device-specific. The plugin's code itself does sync, so an update reaches every device.
      statePath(pluginDir),
      `${pluginDir}/data.json`,
      ...s.exclude.split('\n'),
    ],
    conflictStrategy: s.conflictStrategy,
    retentionDays: s.retentionDays,
    maxFileSizeMB: s.maxFileSizeMB,
    concurrency: s.concurrency,
    compression: s.compression,
  });
}

/** The value a number field holds, or null when it is empty, not a number, or below `min`. */
export function parseNumberSetting(text: string, min: number): number | null {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) || n < min ? null : n;
}

export function cleanupDue(s: Settings, now: number): boolean {
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

/** Storage settings and keys, encrypted under the vault passphrase, for pasting into another device. */
export async function encodeSetupCode(s: Settings, secret: SecretLookup): Promise<string> {
  const payload: Record<string, unknown> = {};
  for (const f of SETUP_FIELDS) payload[f] = s[f];
  for (const [field, setting] of SETUP_SECRETS) payload[field] = secret(s[setting]);
  return `selfsync1.${await sealWithPassphrase(JSON.stringify(payload), secret(s.passphraseSecret))}`;
}

/** The settings a setup code fills in, and the secrets to store first, in order. */
export async function decodeSetupCode(code: string, passphrase: string): Promise<{ settings: Partial<Settings>; secrets: [string, string][] }> {
  const body = code.trim().replace(/^selfsync1\./, '');
  const p = JSON.parse(await openWithPassphrase(body, passphrase)) as Record<string, string | boolean>;
  const settings: Record<string, unknown> = { storageType: p.storageType === 'webdav' ? 'webdav' : 's3' };
  for (const f of SETUP_FIELDS) if (f !== 'storageType') settings[f] = p[f];
  const secrets: [string, string][] = [];
  const keep = (id: string, value: string | boolean) => {
    if (value) secrets.push([id, String(value)]);
    return value ? id : '';
  };
  for (const [field, setting, id] of SETUP_SECRETS) settings[setting] = keep(id, p[field]);
  settings.passphraseSecret = keep('self-sync-passphrase', passphrase);
  return { settings: settings as Partial<Settings>, secrets };
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

export function providerOf(s: Settings): Provider {
  if (s.storageType === 'webdav') return 'webdav';
  if (/r2\.cloudflarestorage\.com/i.test(s.endpoint)) return 'r2';
  if (/backblazeb2\.com/i.test(s.endpoint)) return 'b2';
  if (/amazonaws\.com/i.test(s.endpoint)) return 'aws';
  return 's3';
}

/** One line naming where this vault syncs to. */
export function describeStorage(s: Settings): string {
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

/** A link that opens Obsidian on the other device with the setup code filled in. */
export const setupLink = (code: string) => `obsidian://self-sync?setup=${encodeURIComponent(code)}`;

/** The setup code inside whatever was pasted: the code itself, or a setup link. */
export function setupCodeFrom(text: string): string {
  const t = text.trim();
  const m = /[?&]setup=([^&\s]+)/.exec(t);
  return m ? decodeURIComponent(m[1]) : t;
}
