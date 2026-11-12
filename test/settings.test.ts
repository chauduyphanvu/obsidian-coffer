import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { openWithPassphrase } from '../src/core/crypto.ts';
import { compileExcludes } from '../src/core/config.ts';
import {
  besideVault,
  cleanupDue,
  codeKind,
  decodeInvite,
  decodeSetupCode,
  defaultSettings,
  describeStorage,
  encodeSetupCode,
  folderFor,
  folderProblem,
  hasStorageAddress,
  isConfigured,
  loadSettings,
  normalFolder,
  parseNumberSetting,
  providerOf,
  regionFromEndpoint,
  remoteSpec,
  sameKeys,
  secretName,
  setupCodeFrom,
  setupLink,
  shareConfig,
  shareSecretName,
  shareWith,
  statePath,
  storageLocation,
  storageProblem,
  storageSettings,
  syncConfig,
  type Settings,
  type Share,
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
  assert.equal(c.configDir, '.config');
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
  const { settings, secrets: stored } = await decodeSetupCode(`  ${code}\n`, 'vault pass', 'My Notes');
  const id = (base: string) => secretName(base, 'My Notes');
  assert.deepEqual(settings, {
    storageType: 's3', endpoint: ' https://s3.example.com ', region: ' ', bucket: 'bkt ', prefix: 'my vault', pathStyle: true,
    webdavUrl: '', webdavUser: '',
    accessKeySecret: id('self-sync-access-key'), secretKeySecret: id('self-sync-secret-key'), webdavPasswordSecret: '', passphraseSecret: id('self-sync-passphrase'),
  });
  assert.deepEqual(stored, [[id('self-sync-access-key'), 'AKID'], [id('self-sync-secret-key'), 'SECRET'], [id('self-sync-passphrase'), 'vault pass']]);
  await assert.rejects(decodeSetupCode(code, 'wrong', 'My Notes'), /Wrong passphrase/);
});

test('each vault gets its own secret names, because a phone keeps one keychain for every vault', async () => {
  const secret = (name: string) => ({ k: 'AKID', s: 'SECRET', p: 'vault pass' })[name] ?? '';
  const code = await encodeSetupCode({ ...defaultSettings(true), endpoint: 'https://s3.example.com', bucket: 'b', accessKeySecret: 'k', secretKeySecret: 's', passphraseSecret: 'p' }, secret);
  const vaults = ['Self Sync Test', 'Self Sync Test 2', '日記', 'メモ', 'self sync test', 'A'.repeat(200)];
  const ids = [];
  for (const vault of vaults) {
    const { settings, secrets } = await decodeSetupCode(code, 'vault pass', vault);
    assert.deepEqual(secrets.map(([name]) => name), [settings.accessKeySecret, settings.secretKeySecret, settings.passphraseSecret]);
    for (const [name] of secrets) assert.match(name, /^[a-z0-9-]{1,64}$/, `${vault}: ${name}`);
    ids.push(...secrets.map(([name]) => name));
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.match(secretName('self-sync-passphrase', 'Self Sync Test'), /^self-sync-passphrase-self-sync-test-[a-z0-9]+$/);
  assert.equal(secretName('self-sync-passphrase', 'Self Sync Test'), secretName('self-sync-passphrase', 'Self Sync Test'));
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

const share = (over: Partial<Share> & Pick<Share, 'id' | 'folder'>): Share =>
  shareWith({ endpoint: 'https://s3.example.com', bucket: 'bkt', prefix: `team-${over.id}`, accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'pp', ...over });

test('settings saved before shared folders load unchanged, and a saved share gets every field', () => {
  const old = { ...s3(), deviceName: 'laptop', exclude: 'Private/', lastSuccess: 5 } as Partial<Settings>;
  delete old.shares;
  const loaded = loadSettings(JSON.parse(JSON.stringify(old)), false);
  assert.deepEqual(loaded, { ...old, shares: [] });
  assert.deepEqual(loadSettings(null, true), defaultSettings(true));
  const [s] = loadSettings({ shares: [{ id: 'x1', folder: 'Work', bucket: 'b' } as Share] }, false).shares;
  assert.deepEqual(s, { ...shareWith({ id: 'x1', folder: 'Work' }), bucket: 'b' });
  assert.deepEqual([s.lastSuccess, s.lastCleanup, s.conflictCopies, s.missing, s.storageType, s.region], [0, 0, [], false, 's3', 'auto']);
  assert.notEqual(loadSettings(null, false).shares, loadSettings(null, false).shares, 'no two loads share one list');
});

test('the vault leaves out every shared folder and its state, and a shared folder never holds the settings folder', () => {
  const s = s3({ exclude: 'Private/\n*.tmp\nWork/drafts/\nWork/*.bak\n**/cache/\nOther/x.md', shares: [share({ id: 'w1', folder: 'Work' }), share({ id: 'n2', folder: 'Café/Notes' })] });
  const c = syncConfig(s, '.obsidian', '.obsidian/plugins/self-sync');
  assert.deepEqual(c.exclude.slice(-4), ['Work/', '.obsidian/plugins/self-sync/state-w1.json', 'Café/Notes/', '.obsidian/plugins/self-sync/state-n2.json']);
  const vault = compileExcludes(c.exclude);
  assert.ok(vault('Work/a.md') && vault('Work/deep/b.md') && vault('Café/Notes/c.md'));
  assert.ok(!vault('Work notes/a.md') && !vault('Workshop.md') && !vault('Café/other.md'), 'a sibling whose name starts the same still syncs');
  assert.ok(vault('Café/Notes/c.md'.normalize('NFC')));
  assert.equal(statePath('p'), 'p/state.json');
  assert.equal(statePath('p', 'w1'), 'p/state-w1.json');

  const w = shareConfig(s, s.shares[0], '.obsidian');
  assert.deepEqual(w.exclude, ['.DS_Store', '*.tmp', 'drafts/', '*.bak', '**/cache/']);
  assert.equal(w.deviceName, s.deviceName);
  const inside = compileExcludes(w.exclude);
  assert.ok(inside('drafts/a.md') && inside('x.tmp') && inside('a/cache/b') && !inside('a.md') && !inside('x.md'));
  // A share moved inside another leaves the inner one to its own sync.
  const nested = s3({ shares: [share({ id: 'o', folder: 'Outer' }), share({ id: 'i', folder: 'Outer/Inner' })] });
  assert.deepEqual(shareConfig(nested, nested.shares[0], '.obsidian').exclude, ['.DS_Store', 'Inner/']);
});

test('a shared folder must be a real folder of the vault, outside the others, the settings folder and what is left out', () => {
  const s = s3({ exclude: 'Private/\n*.tmp', shares: [share({ id: 'w', folder: 'Work' }), share({ id: 'f', folder: 'Family/Photos' })] });
  const problem = (folder: string, id = '') => folderProblem(s, folder, '.obsidian', '.obsidian/plugins/self-sync', id);
  assert.equal(problem('Notes'), '');
  assert.equal(problem('Work notes'), '', 'only starts like a shared folder');
  assert.equal(problem('Family'), 'The shared folder “Family/Photos” is inside it. Shared folders can not be inside each other.');
  assert.equal(problem('Work/Sub'), 'That is inside the shared folder “Work”. Shared folders can not be inside each other.');
  assert.equal(problem('Work'), '“Work” is already a shared folder.');
  assert.equal(problem('work'), '“Work” is already a shared folder.', 'case does not tell folders apart everywhere');
  assert.equal(problem('Work', 'w'), '', 'a share does not stand in its own way');
  assert.match(problem(''), /whole vault/);
  assert.match(problem('.obsidian'), /settings folder/);
  assert.match(problem('.obsidian/plugins'), /settings folder/);
  assert.match(problem('.hidden'), /dot/);
  assert.match(problem('Private'), /left out of sync/);
  assert.match(problem('Private/Sub'), /left out of sync/);
  assert.match(problem('a/../b'), /not a folder name/);
  assert.match(problem('/Notes'), /not a folder name/);
  assert.match(problem('What?'), /can not contain/);
  assert.equal(normalFolder(' /Notes//Sub/ '), 'Notes/Sub');
  assert.equal(normalFolder('Notes\\Sub'), 'Notes/Sub');
});

test('a storage location is used once: not where the vault syncs, and not by two shared folders', () => {
  const s = s3({ prefix: 'vault', shares: [share({ id: 'w', folder: 'Work', prefix: 'team' })] });
  assert.match(storageProblem(s, share({ id: 'n', folder: 'N', endpoint: 'https://S3.example.com/', prefix: '/vault/' })), /where this vault itself syncs/);
  assert.match(storageProblem(s, share({ id: 'n', folder: 'N', prefix: 'team' })), /“Work” already syncs with that location/);
  assert.equal(storageProblem(s, share({ id: 'w', folder: 'Work', prefix: 'team' }), 'w'), '');
  assert.equal(storageProblem(s, share({ id: 'n', folder: 'N', prefix: 'vault/shared-n' })), '');
  assert.equal(storageProblem(s, share({ id: 'n', folder: 'N', bucket: 'other', prefix: 'team' })), '');
  assert.notEqual(storageLocation(dav()), storageLocation({ ...dav(), webdavUrl: 'https://dav.example.com/me/other' }));
});

test('"same storage as this vault" is a new place inside the vault\'s own, and invites for it are told apart', () => {
  const s = s3({ prefix: '/vault/' });
  const beside = besideVault(s, 'My Work', 'x7k2q9');
  assert.deepEqual([beside.endpoint, beside.bucket, beside.prefix, beside.accessKeySecret], [s.endpoint, s.bucket, 'vault/shared-My-Work-x7k2q9', 'ak']);
  assert.ok(!('deviceName' in beside), 'only storage settings come along');
  assert.equal(besideVault(s3({ prefix: '' }), 'W', 't').prefix, 'shared-W-t');
  assert.equal(besideVault(dav({ webdavUrl: 'https://dav.example.com/me/vault/' }), 'W', 't').webdavUrl, 'https://dav.example.com/me/vault/shared-W-t');
  assert.notEqual(storageLocation(beside), storageLocation(s));

  const keys: Record<string, string> = { ak: 'AKID', other: 'AKID2' };
  const look = (n: string) => keys[n] ?? '';
  assert.ok(sameKeys(beside, s, look));
  assert.ok(!sameKeys({ ...beside, accessKeySecret: 'other' }, s, look), 'keys of their own');
  assert.ok(!sameKeys({ ...beside, bucket: 'elsewhere' }, s, look));
  assert.ok(sameKeys(dav({ webdavUrl: 'https://DAV.example.com/x' }), dav(), look));
  assert.ok(!sameKeys(dav({ webdavUser: 'friend' }), dav(), look));
});

test('an invite to a shared folder is a setup code of its own kind, opened with the share\'s passphrase', async () => {
  const lookup = (n: string) => ({ ak: 'AKID', sk: 'SECRET', sp: 'share pass', pp: 'vault pass' })[n] ?? '';
  const work = share({ id: 'w1', folder: 'Projects/Work', prefix: 'team', passphraseSecret: 'sp' });
  const invite = await encodeSetupCode(work, lookup, 'Work');
  const vault = await encodeSetupCode(s3(), lookup);
  assert.equal(codeKind(invite), 'share');
  assert.equal(codeKind(` ${vault}`), 'vault');
  assert.equal(codeKind('hello'), undefined);
  assert.ok(!invite.includes('SECRET'));
  assert.match(setupLink(invite), /^obsidian:\/\/self-sync\?share=selfshare1\./);
  assert.equal(setupCodeFrom(setupLink(invite)), invite);
  assert.match(setupLink(vault), /\?setup=/);

  const { storage, secrets, folder } = await decodeInvite(`${invite}\n`, 'share pass', 'My Notes', 'j9');
  const id = (base: string) => shareSecretName(base, 'My Notes', 'j9');
  assert.equal(folder, 'Work');
  assert.deepEqual([storage.endpoint, storage.bucket, storage.prefix, storage.accessKeySecret, storage.passphraseSecret], ['https://s3.example.com', 'bkt', 'team', id('self-sync-access-key'), id('self-sync-passphrase')]);
  assert.deepEqual(secrets, [[id('self-sync-access-key'), 'AKID'], [id('self-sync-secret-key'), 'SECRET'], [id('self-sync-passphrase'), 'share pass']]);
  for (const [name] of secrets) assert.match(name, /^[a-z0-9-]{1,64}$/);
  assert.notEqual(id('self-sync-passphrase'), secretName('self-sync-passphrase', 'My Notes'), "a share's secrets never replace the vault's");
  assert.notEqual(id('self-sync-passphrase'), shareSecretName('self-sync-passphrase', 'My Notes', 'k1'));

  await assert.rejects(decodeInvite(invite, 'vault pass', 'My Notes', 'j9'), /Wrong passphrase/);
  await assert.rejects(decodeInvite(vault, 'vault pass', 'My Notes', 'j9'), /setup link for a whole vault/);
  await assert.rejects(decodeSetupCode(invite, 'share pass', 'My Notes'), /invite link to a shared folder/);
  const sneaky = await encodeSetupCode(work, lookup, '../../.obsidian/x');
  assert.equal((await decodeInvite(sneaky, 'share pass', 'V', 'q')).folder, 'x', "only the last part of the sender's folder name is used");
});
