import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { WrongPassphraseError, openWithPassphrase } from '../src/core/crypto.ts';
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
  linkProblem,
  loadSettings,
  normalFolder,
  parseNumberSetting,
  passphraseProblem,
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

  const c = syncConfig(s3({ exclude: 'Private/\n*.tmp', deviceName: 'laptop', retentionDays: 0 }), '.config', '.config/plugins/coffer');
  assert.deepEqual(c.exclude, [
    '.coffer/**', '.config/workspace*.json', '.trash/**', '.git/**', '.DS_Store',
    '.*', '*/**/.*/', '.!(config)/', '.config/**/node_modules/',
    '.config/plugins/coffer/state.json', '.config/plugins/coffer/data.json', 'Private/', '*.tmp',
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

test('settings: fragmented storage brings automatic cleanup forward to a day after the last, and never past the setting that turns it off', () => {
  const day = 86_400_000;
  assert.ok(!cleanupDue(s3({ autoCleanDays: 7, lastCleanup: 6 * day }), 8 * day), 'not fragmented: the interval stands');
  assert.ok(cleanupDue(s3({ autoCleanDays: 7, lastCleanup: 6 * day }), 8 * day, true));
  assert.ok(!cleanupDue(s3({ autoCleanDays: 7, lastCleanup: 7 * day }), 8 * day, true), 'not more than once a day');
  assert.ok(cleanupDue(s3({ autoCleanDays: 7, lastCleanup: 7 * day - 1 }), 8 * day, true));
  assert.ok(cleanupDue(s3({ autoCleanDays: 7, lastCleanup: 0 }), 8 * day, true));
  assert.ok(!cleanupDue(s3({ autoCleanDays: 0, lastCleanup: 0 }), 8 * day, true));
});

test('setup codes carry storage settings and keys under the passphrase', async () => {
  const code = await encodeSetupCode(s3(), secret, undefined, 1000);
  assert.match(code, /^coffer2\./);
  assert.ok(!code.includes('SECRET'));
  assert.equal(
    await openWithPassphrase(code.slice('coffer2.'.length), 'vault pass'),
    '{"storageType":"s3","endpoint":" https://s3.example.com ","region":" ","bucket":"bkt ","prefix":"my vault","pathStyle":true,' +
      '"webdavUrl":"","webdavUser":"","accessKey":"AKID","secretKey":"SECRET","webdavPassword":""}',
  );
  const { settings, secrets: stored } = await decodeSetupCode(`  ${code}\n`, 'vault pass', 'My Notes');
  const id = (base: string) => secretName(base, 'My Notes');
  assert.deepEqual(settings, {
    storageType: 's3', endpoint: ' https://s3.example.com ', region: ' ', bucket: 'bkt ', prefix: 'my vault', pathStyle: true,
    webdavUrl: '', webdavUser: '',
    accessKeySecret: id('coffer-access-key'), secretKeySecret: id('coffer-secret-key'), webdavPasswordSecret: '', passphraseSecret: id('coffer-passphrase'),
  });
  assert.deepEqual(stored, [[id('coffer-access-key'), 'AKID'], [id('coffer-secret-key'), 'SECRET'], [id('coffer-passphrase'), 'vault pass']]);
  await assert.rejects(decodeSetupCode(code, 'wrong', 'My Notes'), /Wrong passphrase/);
});

test('each vault gets its own secret names, because a phone keeps one keychain for every vault', async () => {
  const secret = (name: string) => ({ k: 'AKID', s: 'SECRET', p: 'vault pass' })[name] ?? '';
  const code = await encodeSetupCode({ ...defaultSettings(true), endpoint: 'https://s3.example.com', bucket: 'b', accessKeySecret: 'k', secretKeySecret: 's', passphraseSecret: 'p' }, secret, undefined, 1000);
  const vaults = ['Coffer Test', 'Coffer Test 2', '日記', 'メモ', 'coffer test', 'A'.repeat(200)];
  const ids = [];
  for (const vault of vaults) {
    const { settings, secrets } = await decodeSetupCode(code, 'vault pass', vault);
    assert.deepEqual(secrets.map(([name]) => name), [settings.accessKeySecret, settings.secretKeySecret, settings.passphraseSecret]);
    for (const [name] of secrets) assert.match(name, /^[a-z0-9-]{1,64}$/, `${vault}: ${name}`);
    ids.push(...secrets.map(([name]) => name));
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.match(secretName('coffer-passphrase', 'Coffer Test'), /^coffer-passphrase-coffer-test-[a-z0-9]+$/);
  assert.equal(secretName('coffer-passphrase', 'Coffer Test'), secretName('coffer-passphrase', 'Coffer Test'));
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
  const code = 'coffer1.abc+/=def';
  assert.equal(setupCodeFrom(setupLink(code)), code);
  assert.equal(setupCodeFrom(`  ${code}\n`), code);
  assert.match(setupLink(code), /^obsidian:\/\/coffer\?setup=coffer1\.abc%2B%2F%3Ddef$/);
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
  const c = syncConfig(s, '.obsidian', '.obsidian/plugins/coffer');
  assert.deepEqual(c.exclude.slice(-4), ['Work/', '.obsidian/plugins/coffer/state-w1.json', 'Café/Notes/', '.obsidian/plugins/coffer/state-n2.json']);
  const vault = compileExcludes(c.exclude);
  assert.ok(vault('Work/a.md') && vault('Work/deep/b.md') && vault('Café/Notes/c.md'));
  assert.ok(!vault('Work notes/a.md') && !vault('Workshop.md') && !vault('Café/other.md'), 'a sibling whose name starts the same still syncs');
  assert.ok(vault('Café/Notes/c.md'.normalize('NFC')));
  assert.equal(statePath('p'), 'p/state.json');
  assert.equal(statePath('p', 'w1'), 'p/state-w1.json');

  const w = shareConfig(s, s.shares[0], '.obsidian');
  assert.deepEqual(w.exclude, ['.DS_Store', '*.tmp', 'drafts/', '*.bak', '**/cache/', '.*', '**/.*/']);
  assert.equal(w.deviceName, s.deviceName);
  const inside = compileExcludes(w.exclude);
  assert.ok(inside('drafts/a.md') && inside('x.tmp') && inside('a/cache/b') && !inside('a.md') && !inside('x.md'));
  assert.ok(!inside('mycache/b'), '**/ stands for whole folders');
  // A share moved inside another leaves the inner one to its own sync.
  const nested = s3({ shares: [share({ id: 'o', folder: 'Outer' }), share({ id: 'i', folder: 'Outer/Inner' })] });
  assert.deepEqual(shareConfig(nested, nested.shares[0], '.obsidian').exclude, ['.DS_Store', 'Inner/', '.*', '**/.*/']);
});

test('what Obsidian does not list is left out: names starting with a dot, except the settings folder when it syncs, without its node_modules', () => {
  const vault = compileExcludes(syncConfig(s3(), '.obsidian', '.obsidian/plugins/coffer').exclude);
  for (const path of ['.gitignore', '.vscode/settings.json', 'notes/.keep', 'notes/.cache/x.json', 'a/b/.c/d.md', '.obsidianx/a', '.obsidian/plugins/p/.hotreload', '.obsidian/plugins/p/node_modules/m/i.js', '.obsidian/plugins/p/.git/HEAD']) {
    assert.ok(vault(path), path);
  }
  for (const path of ['notes/n.md', 'v1.2.md', 'notes/a.b/c.md', 'a/b.c/.d', '.obsidian/app.json', '.obsidian/plugins/p/main.js', '.obsidian/snippets/x.css']) {
    assert.equal(vault(path), path === 'a/b.c/.d', path);
  }
  const without = compileExcludes(syncConfig(s3({ syncConfigDir: false }), '.obsidian', '.obsidian/plugins/coffer').exclude);
  assert.ok(without('.obsidian/app.json') && without('.obsidian/plugins/p/main.js') && !without('notes/n.md'));
  const shared = compileExcludes(shareConfig(s3(), share({ id: 'w', folder: 'Work' }), '.obsidian').exclude);
  for (const path of ['.keep', '.hidden/a.md', 'sub/.hidden/a.md', 'sub/.keep']) assert.ok(shared(path), path);
  for (const path of ['a.md', 'sub/v1.2/a.md', 'sub.d/a.md']) assert.ok(!shared(path), path);
});

test('settings: the size above which files wait in storage reaches the vault and every shared folder, and only receiving is per place', () => {
  const vault = s3({ deferAboveMB: 5, readOnly: true });
  const work = share({ id: 'w', folder: 'Work', readOnly: false });
  const rest = share({ id: 'r', folder: 'Rest', readOnly: true });
  assert.equal(syncConfig(vault, '.obsidian', '.obsidian/plugins/coffer').deferAboveMB, 5);
  assert.equal(shareConfig(vault, work, '.obsidian').deferAboveMB, 5);
  assert.deepEqual([syncConfig(vault, '.obsidian', '.obsidian/plugins/coffer').readOnly, shareConfig(vault, work, '.obsidian').readOnly, shareConfig(vault, rest, '.obsidian').readOnly], [true, false, true]);
  assert.deepEqual([defaultSettings(false).deferAboveMB, defaultSettings(false).readOnly, DEFAULT_CONFIG.deferAboveMB, DEFAULT_CONFIG.readOnly], [0, false, 0, false]);
  const saved = loadSettings({ shares: [{ id: 'old', folder: 'Old' } as Share] }, false);
  assert.deepEqual([saved.deferAboveMB, saved.readOnly, saved.shares[0].readOnly], [0, false, false], 'what an older version saved reads as before');
  assert.equal(besideVault(s3({ readOnly: true }), 'Notes', 'x1').readOnly, false, 'a folder kept beside a vault that only receives does not inherit that');
});

test('a shared folder must be a real folder of the vault, outside the others, the settings folder and what is left out', () => {
  const s = s3({ exclude: 'Private/\n*.tmp', shares: [share({ id: 'w', folder: 'Work' }), share({ id: 'f', folder: 'Family/Photos' })] });
  const problem = (folder: string, id = '') => folderProblem(s, folder, '.obsidian', '.obsidian/plugins/coffer', id);
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
  const cafe = s3({ shares: [share({ id: 'c', folder: 'Café'.normalize('NFD') })] });
  assert.equal(folderProblem(cafe, 'Café'.normalize('NFC'), '.obsidian', '.obsidian/plugins/coffer'), `“${'Café'.normalize('NFD')}” is already a shared folder.`, 'either Unicode form names the same folder');
  assert.match(folderProblem(cafe, `${'Café'.normalize('NFC')}/Sub`, '.obsidian', '.obsidian/plugins/coffer'), /inside the shared folder/);
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
  const invite = await encodeSetupCode(work, lookup, 'Work', 1000);
  const vault = await encodeSetupCode(s3(), lookup, undefined, 1000);
  assert.equal(codeKind(invite), 'share');
  assert.equal(codeKind(` ${vault}`), 'vault');
  assert.equal(codeKind('hello'), undefined);
  assert.ok(!invite.includes('SECRET'));
  assert.match(setupLink(invite), /^obsidian:\/\/coffer\?share=coffershare2\./);
  assert.equal(setupCodeFrom(setupLink(invite)), invite);
  assert.match(setupLink(vault), /\?setup=/);

  const { storage, secrets, folder } = await decodeInvite(`${invite}\n`, 'share pass', 'My Notes', 'j9');
  const id = (base: string) => shareSecretName(base, 'My Notes', 'j9');
  assert.equal(folder, 'Work');
  assert.deepEqual([storage.endpoint, storage.bucket, storage.prefix, storage.accessKeySecret, storage.passphraseSecret], ['https://s3.example.com', 'bkt', 'team', id('coffer-access-key'), id('coffer-passphrase')]);
  assert.deepEqual(secrets, [[id('coffer-access-key'), 'AKID'], [id('coffer-secret-key'), 'SECRET'], [id('coffer-passphrase'), 'share pass']]);
  for (const [name] of secrets) assert.match(name, /^[a-z0-9-]{1,64}$/);
  assert.notEqual(id('coffer-passphrase'), secretName('coffer-passphrase', 'My Notes'), "a share's secrets never replace the vault's");
  assert.notEqual(id('coffer-passphrase'), shareSecretName('coffer-passphrase', 'My Notes', 'k1'));

  await assert.rejects(decodeInvite(invite, 'vault pass', 'My Notes', 'j9'), /Wrong passphrase/);
  await assert.rejects(decodeInvite(vault, 'vault pass', 'My Notes', 'j9'), /setup link for a whole vault/);
  await assert.rejects(decodeSetupCode(invite, 'share pass', 'My Notes'), /invite link to a shared folder/);
  const sneaky = await encodeSetupCode(work, lookup, '../../.obsidian/x', 1000);
  assert.equal((await decodeInvite(sneaky, 'share pass', 'V', 'q')).folder, 'x', "only the last part of the sender's folder name is used");
});

test('a new passphrase needs the length the setup wizard asks for, wherever it is chosen; one being entered opens whatever its length', () => {
  assert.equal(passphraseProblem('', ''), 'Enter the passphrase.');
  assert.equal(passphraseProblem('abc', 'abc'), 'Use at least 8 characters.');
  assert.equal(passphraseProblem('1234567', '1234567'), 'Use at least 8 characters.');
  assert.equal(passphraseProblem('12345678', '1234567'), 'The two entries do not match.');
  assert.equal(passphraseProblem('12345678', '12345678'), '');
  assert.equal(passphraseProblem('abc', '', true), '', 'a passphrase chosen before this minimum still opens its vault');
  assert.equal(passphraseProblem('', '', true), 'Enter the passphrase.');
});

test('a link that did not open says what can be told: the passphrase, or that the link is not whole', async () => {
  const code = await encodeSetupCode({ ...defaultSettings(false), endpoint: 'https://s3.example.com', bucket: 'bkt', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'pp' }, secret, undefined, 1000);
  const tried = async (text: string, pass = 'vault pass') => linkProblem(await decodeSetupCode(text, pass, 'V').then(() => undefined, (e) => e), 'setup');
  const notWhole = 'That is not a valid or complete setup link. Copy it again on the other device.';
  assert.equal(await tried(code.slice(0, 20)), notWhole, 'too short to hold what a link holds');
  assert.equal(await tried('coffer2.not a code!'), notWhole, 'not base64');
  assert.equal(await tried('coffer2.AAAAAA' + 'A'.repeat(80)), notWhole, 'a count of nothing');
  assert.equal(await tried('hello'), notWhole);
  const wrong = await tried(code, 'not it');
  assert.match(wrong, /^That passphrase does not open this setup link\./);
  assert.equal(await tried(code.slice(0, -3)), wrong, 'cut short but long enough, it reads as a wrong passphrase, so that text says it may be the link');
  assert.match(wrong, /copy the link again/);
  assert.equal(linkProblem(new Error('x'), 'invite'), 'That is not a valid or complete invite link. Copy it again.');
  assert.match(linkProblem(new WrongPassphraseError(), 'invite'), /^That passphrase does not open this invite link\./);
});

test('a link cut inside a percent escape is a damaged code, not a crash', () => {
  assert.equal(setupCodeFrom('obsidian://coffer?setup=coffer2.AAk%E0%A4%A'), 'coffer2.AAk%E0%A4%A');
  assert.equal(setupCodeFrom('obsidian://coffer?setup=coffer2.AAk%41'), 'coffer2.AAkA');
});
