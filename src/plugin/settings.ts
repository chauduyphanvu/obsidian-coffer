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
