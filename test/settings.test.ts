import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { openWithPassphrase } from '../src/core/crypto.ts';
import {
  cleanupDue,
  decodeSetupCode,
  defaultSettings,
  encodeSetupCode,
  hasStorageAddress,
  isConfigured,
  parseNumberSetting,
  remoteSpec,
  syncConfig,
  type Settings,
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
