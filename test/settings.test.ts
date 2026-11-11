import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { openWithPassphrase } from '../src/core/crypto.ts';
import {
  cleanupDue,
  decodeSetupCode,
  defaultSettings,
  describeStorage,
  encodeSetupCode,
  folderFor,
  hasStorageAddress,
  isConfigured,
  parseNumberSetting,
  providerOf,
  regionFromEndpoint,
  remoteSpec,
  setupCodeFrom,
  setupLink,
  storageSettings,
  syncConfig,
  type Settings,
  type StorageForm,
} from '../src/plugin/settings.ts';

const secrets: Record<string, string> = { ak: 'AKID', sk: 'SECRET', dp: 'dav pw', pp: 'vault pass' };
const secret = (name: string) => (name && secrets[name]) || '';
const s3 = (over: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(false),
  endpoint: ' https://s3.example.com ',
  region: ' ',
  bucket: 'bkt ',
  prefix: 'my vault',
  accessKeySecret: 'ak',
  secretKeySecret: 'sk',
  passphraseSecret: 'pp',
  ...over,
});
const dav = (over: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(false),
  storageType: 'webdav',
  webdavUrl: ' https://dav.example.com/me/vault ',
  webdavUser: 'me',
  webdavPasswordSecret: 'dp',
  passphraseSecret: 'pp',
  ...over,
});

test('settings: defaults follow the engine and the platform', () => {
  assert.equal(defaultSettings(false).maxFileSizeMB, DEFAULT_CONFIG.maxFileSizeMB);
  assert.equal(defaultSettings(true).maxFileSizeMB, 200);
  assert.equal(defaultSettings(false).conflictStrategy, DEFAULT_CONFIG.conflictStrategy);
});

test('settings: what counts as set up', () => {
  assert.ok(isConfigured(s3(), secret));
  assert.ok(!isConfigured(s3({ secretKeySecret: '' }), secret));
  assert.ok(!isConfigured(s3({ passphraseSecret: 'missing' }), secret));
  assert.ok(isConfigured(dav(), secret));
  assert.ok(!isConfigured(dav({ webdavUser: '' }), secret));
  assert.ok(hasStorageAddress(s3({ accessKeySecret: '' })));
  assert.ok(!hasStorageAddress(s3({ bucket: '' })));
  assert.ok(hasStorageAddress(dav({ webdavUser: '' })));
  assert.ok(!hasStorageAddress(dav({ webdavUrl: '' })));
});

test('settings: storage address and sync config', () => {
  assert.deepEqual(remoteSpec(s3(), secret), {
    type: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'bkt', prefix: 'my vault', pathStyle: true, accessKey: 'AKID', secretKey: 'SECRET',
  });
  assert.deepEqual(remoteSpec(dav(), secret), { type: 'webdav', url: 'https://dav.example.com/me/vault', username: 'me', password: 'dav pw' });

  const c = syncConfig(s3({ exclude: 'Private/\n*.tmp', deviceName: 'laptop', retentionDays: 0 }), '.config', '.config/plugins/self-sync');
  assert.deepEqual(c.exclude, [
    '.self-sync/**', '.config/workspace*.json', '.trash/**', '.git/**', '.DS_Store',
    '.config/plugins/self-sync/state.json', '.config/plugins/self-sync/data.json', 'Private/', '*.tmp',
  ]);
  assert.equal(c.deviceName, 'laptop');
  assert.equal(c.retentionDays, 1);
});

test('settings: automatic cleanup is due after its interval', () => {
  const day = 86_400_000;
  assert.ok(cleanupDue(s3({ autoCleanDays: 7, lastCleanup: 0 }), 8 * day));
  assert.ok(!cleanupDue(s3({ autoCleanDays: 7, lastCleanup: day }), 8 * day));
  assert.ok(!cleanupDue(s3({ autoCleanDays: 0, lastCleanup: 0 }), 8 * day));
});

test('setup codes carry storage settings and keys under the passphrase', async () => {
  const code = await encodeSetupCode(s3(), secret);
  assert.match(code, /^selfsync1\./);
  assert.ok(!code.includes('SECRET'));
  assert.equal(
    await openWithPassphrase(code.slice('selfsync1.'.length), 'vault pass'),
    '{"storageType":"s3","endpoint":" https://s3.example.com ","region":" ","bucket":"bkt ","prefix":"my vault","pathStyle":true,' +
      '"webdavUrl":"","webdavUser":"","accessKey":"AKID","secretKey":"SECRET","webdavPassword":""}',
  );
  const { settings, secrets: stored } = await decodeSetupCode(`  ${code}\n`, 'vault pass');
  assert.deepEqual(settings, {
    storageType: 's3', endpoint: ' https://s3.example.com ', region: ' ', bucket: 'bkt ', prefix: 'my vault', pathStyle: true,
    webdavUrl: '', webdavUser: '',
    accessKeySecret: 'self-sync-access-key', secretKeySecret: 'self-sync-secret-key', webdavPasswordSecret: '', passphraseSecret: 'self-sync-passphrase',
  });
  assert.deepEqual(stored, [['self-sync-access-key', 'AKID'], ['self-sync-secret-key', 'SECRET'], ['self-sync-passphrase', 'vault pass']]);
  await assert.rejects(decodeSetupCode(code, 'wrong'), /Wrong passphrase/);
});

test('settings: a cleared or invalid number field changes nothing', () => {
  assert.equal(parseNumberSetting('', 0), null);
  assert.equal(parseNumberSetting('  ', 0), null);
  assert.equal(parseNumberSetting('abc', 0), null);
  assert.equal(parseNumberSetting('1', 2), null);
  assert.equal(parseNumberSetting('0', 0), 0);
  assert.equal(parseNumberSetting('15', 1), 15);
});

test('setup form: each provider gets the endpoint, region and addressing it needs', () => {
  const form = (over: Partial<StorageForm>): StorageForm => ({ location: '', bucket: 'notes', prefix: 'My-Vault', user: '', region: '', pathStyle: true, ...over });
  assert.deepEqual(storageSettings('r2', form({ location: ' 0123abcd ' })), {
    storageType: 's3', bucket: 'notes', prefix: 'My-Vault', endpoint: 'https://0123abcd.r2.cloudflarestorage.com', region: 'auto', pathStyle: true,
  });
  assert.equal(storageSettings('r2', form({ location: 'https://0123abcd.r2.cloudflarestorage.com/' })).endpoint, 'https://0123abcd.r2.cloudflarestorage.com');
  assert.deepEqual(storageSettings('aws', form({ location: 'EU-West-2' })), {
    storageType: 's3', bucket: 'notes', prefix: 'My-Vault', endpoint: 'https://s3.eu-west-2.amazonaws.com', region: 'eu-west-2', pathStyle: false,
  });
  assert.deepEqual(storageSettings('b2', form({ location: 's3.us-west-004.backblazeb2.com' })), {
    storageType: 's3', bucket: 'notes', prefix: 'My-Vault', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', pathStyle: true,
  });
  assert.equal(storageSettings('s3', form({ location: 'http://nas.local:9000', pathStyle: true })).region, 'us-east-1');
  assert.equal(storageSettings('s3', form({ location: 's3.eu-central-2.wasabisys.com' })).region, 'eu-central-2');
  assert.deepEqual(storageSettings('webdav', form({ location: 'cloud.example.com/remote.php/dav/files/me/vault/', user: ' me ' })), {
    storageType: 'webdav', webdavUrl: 'https://cloud.example.com/remote.php/dav/files/me/vault', webdavUser: 'me',
  });
  assert.throws(() => storageSettings('aws', form({ location: 'Virginia' })), /region shown for the bucket/);
  assert.throws(() => storageSettings('b2', form({ location: 'example.com' })), /endpoint shown on the bucket/);
  assert.throws(() => storageSettings('r2', form({ location: 'abc', bucket: ' ' })), /bucket name/);
  assert.throws(() => storageSettings('webdav', form({ location: 'x' })), /user name/);
});

test('storage is named the way the user knows it', () => {
  assert.equal(regionFromEndpoint('https://s3.ap-southeast-1.amazonaws.com'), 'ap-southeast-1');
  assert.equal(regionFromEndpoint('https://minio.local'), undefined);
  const r2 = s3({ endpoint: 'https://abc.r2.cloudflarestorage.com', bucket: 'notes', prefix: 'vault' });
  assert.equal(providerOf(r2), 'r2');
  assert.equal(describeStorage(r2), 'Cloudflare R2 · notes · vault');
  assert.equal(describeStorage(s3({ endpoint: 'https://minio.local:9000', bucket: 'b', prefix: '' })), 'minio.local:9000 · b');
  assert.equal(describeStorage(dav()), 'WebDAV · dav.example.com');
  assert.equal(folderFor(' My Vault (2026) '), 'My-Vault-2026');
  assert.equal(folderFor('日本'), 'vault');
});

test('a setup link carries the setup code, and either can be pasted', () => {
  const code = 'selfsync1.abc+/=def';
  assert.equal(setupCodeFrom(setupLink(code)), code);
  assert.equal(setupCodeFrom(`  ${code}\n`), code);
  assert.match(setupLink(code), /^obsidian:\/\/self-sync\?setup=selfsync1\.abc%2B%2F%3Ddef$/);
});
