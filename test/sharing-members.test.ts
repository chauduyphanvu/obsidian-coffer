import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemovedError, UnverifiedError, type MemberStatus, type SyncEngine } from '../src/core/engine.ts';
import { decodeInvite as decodeMemberInvite, encodeInvite, ownerLinkFields, type FollowInvite, type MemberInvite, type MemberKeys } from '../src/core/members.ts';
import { createMemberShare, joinShare } from '../src/core/membership.ts';
import { Repo } from '../src/core/repo.ts';
import type { FolderFS } from '../src/core/scopedfs.ts';
import { ReadOnlyError, type RemoteStore } from '../src/core/types.ts';
import {
  INVITE_DAYS,
  followCaveat,
  followRekey,
  joinWithInvite,
  keysFromPayload,
  keysPayload,
  keysProblem,
  memberError,
  memberLine,
  mustNotWrite,
  noKeys,
  openedLink,
  readKeyProblem,
  REKEY_RETRY_MS,
  rekey,
  rekeyReadersNote,
  rekeySkip,
  rekeySuggestersNote,
  rekeyTest,
  addedLine,
  roleLabel,
  roleOnRow,
  storedKind,
  testKeys,
  withKeys,
  type KeySet,
  type KeyUse,
} from '../src/plugin/members.ts';
import {
  codeKind,
  decodeInvite,
  defaultSettings,
  encodeSetupCode,
  isConfigured,
  isMemberInvite,
  loadSettings,
  positionPath,
  remoteSpec,
  setupCodeFrom,
  setupLink,
  shareWith,
  statePath,
  storageFromPayload,
  storagePayload,
  type Settings,
  type Share,
} from '../src/plugin/settings.ts';
import { makeEngine, memberKeysIn, rejoinNeeds, type EngineHost } from '../src/plugin/shares.ts';
import { describeFailure, keysMissingProblem, resultProblems, shareLine } from '../src/plugin/status.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { DAY, Device, TEST_CONFIG, memberShare } from './helpers.ts';

const PLUGIN_DIR = '.obsidian/plugins/coffer';

/** A vault whose folders exist when they hold a file or were made, as Obsidian has them. */
class VaultFS extends MemFS implements FolderFS {
  folders = new Set<string>();
  async listFolder(folder: string) {
    const files = (await this.list()).filter((f) => f.path.startsWith(`${folder}/`));
    return this.folders.has(folder) || files.length ? files : null;
  }
}

/**
 * One device of the plugin, with a shared folder whose storage is `store`: the engine comes from `makeEngine`, as in
 * the plugin, with its secrets in `secrets` and its saved state and member list in `states`, by path.
 */
function pluginDevice(name: string, store: RemoteStore, share: Share, secrets: Record<string, string>, clock: { now: number }) {
  const settings: Settings = { ...defaultSettings(false), deviceName: name, endpoint: 'https://s3.test', bucket: 'vault', prefix: 'v', shares: [share] };
  const states = new Map<string, MemState>();
  const fs = new VaultFS();
  fs.folders.add(share.folder);
  const host: EngineHost = {
    settings,
    configDir: '.obsidian',
    pluginDir: PLUGIN_DIR,
    files: fs,
    secret: (n) => secrets[n] ?? '',
    openStore: () => store,
    stateStore: (path) => {
      if (!states.has(path)) states.set(path, new MemState());
      return states.get(path)!;
    },
  };
  const engine = () => makeEngine(host, share, { now: () => clock.now }).engine;
  return { settings, states, fs, host, engine, share, secrets };
}

const s3Share = (over: Partial<Share>) => shareWith({ id: 'm1', folder: 'Family', endpoint: 'https://s3.test', bucket: 'b', prefix: 'family', accessKeySecret: 'ak', secretKeySecret: 'sk', ...over });

test('settings saved by 0.3.0 load their shares as folders shared with a passphrase, and a share with members needs its keys, not a passphrase', () => {
  const [old] = loadSettings({ shares: [{ id: 'x1', folder: 'Work', bucket: 'b' } as Share] }, false).shares;
  assert.equal(old.role, '');
  assert.equal(old.memberKeysSecret, '');
  const secrets: Record<string, string> = { ak: 'AK', sk: 'SK', pass: 'share pass', keys: '{}' };
  const lookup = (n: string) => secrets[n] ?? '';
  assert.ok(isConfigured(s3Share({ passphraseSecret: 'pass' }), lookup));
  assert.ok(isConfigured(s3Share({ memberKeysSecret: 'keys', role: 'write' }), lookup), 'a member has no passphrase');
  assert.ok(!isConfigured(s3Share({ memberKeysSecret: 'gone', passphraseSecret: 'pass', role: 'owner' }), lookup), 'the owner’s passphrase does not stand in for its keys');
  assert.notEqual(positionPath(PLUGIN_DIR, 'm1'), statePath(PLUGIN_DIR, 'm1'));
  assert.match(keysMissingProblem({ role: 'write', memberKeysSecret: 'k' }).detail, /its own keys .* join again with a new invite\.$/);
  assert.match(keysMissingProblem({ role: '', memberKeysSecret: '' }).detail, /the passphrase .* join again with the invite link and the passphrase\.$/);
  // Nobody can invite an owner: another of the owner's devices makes the link that brings this one back.
  assert.match(keysMissingProblem({ role: 'owner', memberKeysSecret: 'k' }).detail, /join again with the link for your other devices and its passphrase\.$/);
  // Notes shared by a property have no such link: only a new share brings them back.
  assert.match(keysMissingProblem({ role: 'owner', memberKeysSecret: 'k', property: 'Family' }).detail, /then start a new share and invite people again\.$/);
  assert.equal(rejoinNeeds({ role: 'owner', memberKeysSecret: 'k' }), 'the link for your other devices and its passphrase');
  assert.equal(rejoinNeeds({ role: 'read', memberKeysSecret: 'k' }), 'a new invite');
  // Keys gone from secret storage are said to be gone, in words, not as a JSON error, and damaged ones as damaged.
  const kept = s3Share({ memberKeysSecret: 'keys', role: 'owner' });
  assert.throws(() => memberKeysIn(kept, () => ''), /^Error: This device no longer has its keys to this shared folder\. Sync status says what to do\.$/);
  assert.throws(() => memberKeysIn(kept, () => '{not json'), /are damaged/);
});

test('a member’s invite is told apart from sealed codes, travels in the same obsidian:// link, and its storage reads like a setup code’s', async () => {
  const { owner } = await memberShare();
  await owner.sync();
  const grant = await owner.engine.invite({ name: 'Ann', role: 'write', expires: Date.now() + DAY });
  const share = s3Share({ webdavUser: '' });
  const storage = storagePayload(share, (n) => ({ ak: 'AK', sk: 'SK' })[n] ?? '');
  assert.deepEqual(storage, { storageType: 's3', endpoint: 'https://s3.test', region: 'auto', bucket: 'b', prefix: 'family', pathStyle: true, webdavUrl: '', webdavUser: '', accessKey: 'AK', secretKey: 'SK', webdavPassword: '' });
  const code = encodeInvite({ ...grant, storage, share: 'Family', folder: 'Home/Family' });
  assert.ok(isMemberInvite(code));
  assert.equal(codeKind(code), 'share');
  const link = setupLink(code);
  assert.match(link, /^obsidian:\/\/coffer\?share=coffershare3\./);
  assert.equal(setupCodeFrom(link), code);
  await assert.rejects(decodeInvite(code, 'any', 'V', 'j1'), /not an invite link/, 'never opened as a sealed one');

  const opened = decodeMemberInvite(setupCodeFrom(link));
  const { storage: settings, secrets } = storageFromPayload(opened.storage, (base) => `${base}-j1`);
  assert.deepEqual(settings, {
    storageType: 's3', endpoint: 'https://s3.test', region: 'auto', bucket: 'b', prefix: 'family', pathStyle: true, webdavUrl: '', webdavUser: '',
    accessKeySecret: 'coffer-access-key-j1', secretKeySecret: 'coffer-secret-key-j1', webdavPasswordSecret: '',
  });
  assert.deepEqual(secrets, [['coffer-access-key-j1', 'AK'], ['coffer-secret-key-j1', 'SK']]);
  // Not sealed: whatever is in it is checked to be of the right kind before it reaches settings.
  const odd = storageFromPayload({ storageType: 'ftp', endpoint: 5, pathStyle: 'no', accessKey: 7 }, (b) => b);
  assert.deepEqual([odd.storage.storageType, odd.storage.endpoint, odd.storage.pathStyle, odd.storage.accessKeySecret, odd.secrets], ['s3', '', true, '', []]);
});

test('an owner link is an invite sealed with the passphrase that also carries the owner’s keys; an invite of the older kind carries none', async () => {
  const { keys } = await memberShare();
  const secrets: Record<string, string> = { ak: 'AK', sk: 'SK', pass: 'owner passphrase' };
  const lookup = (n: string) => secrets[n] ?? '';
  const share = s3Share({ passphraseSecret: 'pass', role: 'owner', memberKeysSecret: 'keys' });
  const code = await encodeSetupCode({ ...share, readOnly: false }, lookup, 'Family', 1000, ownerLinkFields(keys));
  assert.ok(code.startsWith('coffershare2.'));
  assert.ok(!isMemberInvite(code));
  const opened = await decodeInvite(code, 'owner passphrase', 'V', 'j2');
  assert.deepEqual(opened.member, keys);
  assert.equal(opened.folder, 'Family');
  assert.equal(opened.storage.passphraseSecret, opened.secrets.at(-1)![0], 'the passphrase is kept, so this device can make the link too');
  const legacy = await decodeInvite(await encodeSetupCode(share, lookup, 'Family', 1000), 'owner passphrase', 'V', 'j3');
  assert.equal(legacy.member, undefined);
  await assert.rejects(encodeSetupCode(share, (n) => (n === 'pass' ? '' : lookup(n)), 'Family', 1000), /passphrase/, 'never sealed with an empty passphrase');
});

test('a shared folder with members syncs through makeEngine with its own keys, and its member list survives its sync state being reset', async () => {
  const clock = { now: 1_800_000_000_000 };
  const store = new MemoryStore(() => clock.now);
  const keys = await createMemberShare(store, { owner: 'Vu', device: 'mac', passphrase: 'owner passphrase', kdfIterations: 1000, chunk: TEST_CONFIG.chunk!, now: clock.now });
  const owner = pluginDevice('mac', store, s3Share({ role: 'owner', memberKeysSecret: 'keys' }), { ak: 'AK', sk: 'SK', keys: JSON.stringify(keys) }, clock);
  owner.fs.put('Family/plan.md', 'v1\n');
  let ownerEngine = owner.engine();
  assert.equal((await ownerEngine.sync()).pushed, 1);
  assert.equal((await ownerEngine.memberStanding())?.role, 'owner');

  const grant = await ownerEngine.invite({ name: 'Mai', role: 'read', expires: clock.now + DAY });
  const invite = decodeMemberInvite(encodeInvite({ ...grant, storage: { bucket: 'b' }, share: 'Family', folder: 'Family' }));
  const secrets: Record<string, string> = { ak: 'RO', sk: 'RO' };
  const mai = pluginDevice('phone', store, s3Share({ id: 'r1', role: 'read', readOnly: true, memberKeysSecret: 'keys' }), secrets, clock);
  await joinWithInvite(store, invite, async (k) => void (secrets.keys = JSON.stringify(k)), clock.now);
  let maiEngine = mai.engine();
  await maiEngine.sync();
  assert.equal(mai.fs.text('Family/plan.md'), 'v1\n');
  assert.deepEqual(await maiEngine.memberStanding(), { role: 'read', mayWrite: false, waiting: false, removed: false, owner: 'Vu' });
  const position = mai.states.get(positionPath(PLUGIN_DIR, 'r1'));
  assert.ok(position?.data, 'the member list it accepted is kept apart from its sync state');
  assert.ok(mai.states.get(statePath(PLUGIN_DIR, 'r1'))?.data);

  await ownerEngine.removeMember(invite.member);
  await assert.rejects(maiEngine.sync(), RemovedError);
  // As "Download again" does: the sync state goes, the member list stays, and the removal with it.
  mai.states.delete(statePath(PLUGIN_DIR, 'r1'));
  maiEngine = mai.engine();
  await assert.rejects(maiEngine.sync(), RemovedError);
  assert.equal((await maiEngine.memberStanding())?.removed, true);
  // And carrying on from storage as it is keeps it too.
  ownerEngine = owner.engine();
  await ownerEngine.acceptStorage();
  await ownerEngine.sync();
  assert.ok(owner.states.get(positionPath(PLUGIN_DIR, 'm1'))?.data);
});

test('the join screen joins only the link opened last, with its own reason to only receive, in the folder it suggests unless one was typed', () => {
  const follow = { url: 'https://public.test/f', folder: 'Blog' } as FollowInvite;
  const member = { role: 'write', folder: 'Family' } as MemberInvite;
  const empty = { storage: {}, secrets: [] as [string, string][] };
  const first = openedLink({ folder: '', suggested: '' }, { invite: empty, follow, readOnly: true, folder: 'Blog' });
  assert.deepEqual(first, { invite: empty, member: undefined, follow, readOnly: true, folder: 'Blog', suggested: 'Blog' });
  // Back, and another link pasted: nothing of the follow link stays.
  const invite = { storage: { bucket: 'b' }, secrets: [] as [string, string][] };
  const second = openedLink(first, { invite, member, readOnly: false, folder: 'Family' });
  assert.deepEqual(second, { invite, member, follow: undefined, readOnly: false, folder: 'Family', suggested: 'Family' });
  // A folder typed on the way stays.
  assert.equal(openedLink({ ...second, folder: 'Shared/Ours' }, { invite: empty, follow, readOnly: true, folder: 'Blog' }).folder, 'Shared/Ours');
});

test('joining keeps the keys before the owner is asked to confirm, and an invite one device used fails for the next', async () => {
  const { owner, invite, net, clock } = await memberShare();
  await owner.sync();
  const link = await invite('Lan', 'write');
  // A device that could not keep the keys leaves nothing behind: the invite still works.
  await assert.rejects(joinWithInvite(net, link, async () => Promise.reject(new Error('disk full')), clock.now), /disk full/);
  assert.equal(await net.get(`join/${link.member}`), null);

  const order: string[] = [];
  const watched: RemoteStore = { ...net, get: net.get.bind(net), list: net.list.bind(net), delete: net.delete.bind(net), put: (k, d, o) => (order.push(`put ${k.split('/')[0]}`), net.put(k, d, o)) };
  const joined = await joinWithInvite(watched, link, async () => void order.push('kept'), clock.now);
  assert.equal(joined.sent, true);
  assert.deepEqual(order, ['kept', 'put join']);
  assert.ok(joined.keys.key, 'a write member’s device makes its own key');
  await assert.rejects(joinWithInvite(net, link, async () => undefined, clock.now), /already used/);

  // Asking fails for now: the keys are kept all the same, and the device's next sync asks again.
  const second = await invite('Ann', 'write');
  const offline: RemoteStore = { ...net, get: net.get.bind(net), list: net.list.bind(net), delete: net.delete.bind(net), put: () => Promise.reject(new Error('fetch failed')) };
  let kept: MemberKeys | undefined;
  const out = await joinWithInvite(offline, second, async (k) => void (kept = k), clock.now);
  assert.equal(out.sent, false);
  assert.ok(kept);
  assert.equal(await net.get(`join/${second.member}`), null);

  const read = await invite('Mai', 'read');
  const r = await joinWithInvite(net, read, async () => undefined, clock.now);
  assert.equal(r.keys.key, undefined);
  assert.equal(await net.get(`join/${read.member}`), null, 'a read member never asks to be confirmed');
});

test('new keys are kept only once they reach the same shared folder, can read it, and write when the device writes', async () => {
  const { owner, net, keys } = await memberShare();
  await owner.sync();
  const o = { repo: keys.repo, write: true, storageType: 's3' as const };
  await testKeys(net, o);
  await testKeys(net, { ...o, write: false });
  await assert.rejects(testKeys(new MemoryStore(), o), /nothing is stored there/);
  await assert.rejects(testKeys(net, { ...o, repo: 'another' }), /another shared folder/);
  const refusing: RemoteStore = { get: () => Promise.reject(new Error('HTTP 403 AccessDenied')), put: () => Promise.reject(new Error('HTTP 403')), delete: async () => undefined, list: async () => [] };
  await assert.rejects(testKeys(refusing, o), /refused these keys/);
  const reading: RemoteStore = { get: net.get.bind(net), list: net.list.bind(net), put: () => Promise.reject(new Error('HTTP 403 AccessDenied')), delete: net.delete.bind(net) };
  await testKeys(reading, { ...o, write: false });
  await assert.rejects(testKeys(reading, o), /refused/, 'a device that writes needs keys that write');
  // Keys the owner hands out to only read may not write anywhere a suggestion does not go, nor be left a test object.
  await assert.rejects(testKeys(net, { ...o, write: false, onlyRead: true }), /can also change and delete/);
  assert.deepEqual(await net.list('doctor/'), []);
  await testKeys(reading, { ...o, write: false, onlyRead: true });
  const suggesting: RemoteStore = { ...reading, put: (key, data, opts) => (key.startsWith('inbox/') ? net.put(key, data, opts) : Promise.reject(new Error('HTTP 403 AccessDenied'))) };
  await testKeys(suggesting, { ...o, write: false, onlyRead: true });
  const flaky: RemoteStore = { ...reading, put: () => Promise.reject(new Error('fetch failed')) };
  await assert.rejects(testKeys(flaky, { ...o, write: false, onlyRead: true }), /Could not check that these keys can only read/);
  // Who must not be handed keys that write: anyone who only reads, except over WebDAV, whose servers often can not limit
  // a user to reading; and one who sends suggestions where the provider can limit writing to the inbox.
  const at = (endpoint: string, storageType: 's3' | 'webdav' = 's3') => s3Share({ endpoint, storageType });
  assert.deepEqual(
    [at('https://s3.us-east-1.amazonaws.com'), at('https://minio.test'), at('https://acct.r2.cloudflarestorage.com'), at('https://s3.us-west-004.backblazeb2.com'), at('', 'webdav')].map((s) => [mustNotWrite(s, false), mustNotWrite(s, true)]),
    [[true, true], [true, true], [true, false], [true, false], [false, false]],
  );
  // A share with a passphrase this device has not synced yet: any shared folder there will do, but not an empty place.
  await testKeys(net, { write: true, storageType: 's3' });
  assert.equal(storedKind(await Repo.header(net)), 'members');
  assert.equal(storedKind(null), 'empty');
  assert.equal(storedKind({ format: 1 }), 'passphrase');
});

test('a re-key is tested before it is written, reaches each member, and a member’s device switches only to keys that work for it', async () => {
  const { owner, writer, join } = await memberShare();
  await owner.sync();
  const lan = await writer('Lan');
  const mai = await join('Mai', 'read');
  await lan.sync();
  await mai.sync();
  const write: KeySet = { ...noKeys(), access: 'NEW-AK', secret: 'NEW-SK' };
  const read: KeySet = { ...noKeys(), access: 'NEW-RO', secret: 'NEW-RS' };
  const readers = (await owner.engine.members()).filter((m) => m.role === 'read').map((m) => m.name);
  assert.deepEqual(readers, ['Mai']);
  const tested: string[] = [];
  const test = async (k: KeySet, use: KeyUse) => void tested.push(`${k.access} ${use}`);

  await assert.rejects(rekey(owner.engine, { type: 's3', write, readers, test }), /read-only keys too: Mai only receives/);
  await assert.rejects(rekey(owner.engine, { type: 's3', write, read: write, readers, test }), /Make keys that can only read/);
  await assert.rejects(rekey(owner.engine, { type: 's3', write: noKeys(), readers: [], test }), /Enter both keys/);
  // The keys in use now were handed to every member invited to edit, the one being cut off too.
  const current: KeySet = { ...noKeys(), access: 'OLD-AK', secret: 'OLD-SK' };
  await assert.rejects(rekey(owner.engine, { type: 's3', write, read: current, readers, current, test }), /keys this device uses now/);
  await assert.rejects(rekey(owner.engine, { type: 's3', write: current, read, readers, current, test }), /keys this device uses now/);
  const dav = (user: string, password: string): KeySet => ({ ...noKeys(), user, password });
  await assert.rejects(
    rekey(owner.engine, { type: 'webdav', write: dav('new', 'new-pw'), read: dav('team', 'team-pw'), readers, current: dav('team', 'team-pw'), test }),
    /keys this device uses now/,
  );
  await assert.rejects(
    rekey(owner.engine, { type: 's3', write, read, readers, test: async (k, use) => (use === 'write' ? undefined : Promise.reject(new Error('These keys reach another shared folder'))) }),
    /another shared folder/,
  );
  assert.equal(await lan.engine.rekeyOffer(), null, 'nothing is handed out before both sets passed');
  const n = await rekey(owner.engine, { type: 's3', write, read, readers, test });
  assert.deepEqual(tested, ['NEW-AK write', 'NEW-RO read']);

  const kept = { ...noKeys(), access: 'OLD-AK', secret: 'OLD-SK' };
  let switched: KeySet | undefined;
  const lanOut = await followRekey(lan.engine, { type: 's3', kept, test: async () => undefined, keep: async (k) => void (switched = k) });
  assert.deepEqual(lanOut, { n, switched: true });
  assert.deepEqual(switched, { ...kept, access: 'NEW-AK', secret: 'NEW-SK' });
  assert.equal(await followRekey(lan.engine, { type: 's3', kept, test: async () => undefined, keep: async () => assert.fail('taken twice') }), undefined);

  const maiOut = await followRekey(mai.engine, { type: 's3', kept, test: async () => Promise.reject(new Error('The storage refused these keys.')), keep: async () => assert.fail('kept keys that failed') });
  assert.deepEqual(maiOut, { n, switched: false, problem: 'The storage refused these keys.' });
  assert.equal(await followRekey(mai.engine, { type: 's3', kept, skip: n, test: async () => assert.fail('tested again'), keep: async () => undefined }), undefined);
  // Mai's re-key carries the read keys, Lan's the write keys.
  assert.deepEqual((await mai.engine.rekeyOffer())?.storage, { accessKey: 'NEW-RO', secretKey: 'NEW-RS' });
  assert.equal(await owner.engine.rekeyOffer(), null, 'the device that handed them out switched already');
});

test('a re-key asks for a separate key for those who send suggestions, and refuses a read-only key that can write wherever an invite would', async () => {
  const { owner, join, net, keys, clock } = await memberShare();
  await owner.sync();
  const mai = await join('Mai', 'read');
  const grant = await owner.engine.invite({ name: 'Ann', role: 'read', expires: clock.now + DAY, suggest: true });
  const annKeys = await joinShare(net, decodeMemberInvite(encodeInvite({ ...grant, storage: {}, share: 'Family', folder: 'Family' })), clock.now);
  const members = await owner.engine.members();
  const readers = members.filter((m) => m.role === 'read' && !m.suggest).map((m) => m.name);
  const suggesters = members.filter((m) => m.suggest).map((m) => m.name);
  assert.deepEqual([readers, suggesters], [['Mai'], ['Ann']]);

  // Keys by their first letter: W write anywhere, R only read, I read and add to the inbox only.
  const reading: RemoteStore = { get: net.get.bind(net), list: net.list.bind(net), put: () => Promise.reject(new Error('HTTP 403 AccessDenied')), delete: net.delete.bind(net) };
  const inboxOnly: RemoteStore = { ...reading, put: (key, data, opts) => (key.startsWith('inbox/') ? net.put(key, data, opts) : Promise.reject(new Error('HTTP 403 AccessDenied'))) };
  const storeOf = (k: KeySet) => ({ W: net, R: reading, I: inboxOnly })[k.access[0] as 'W' | 'R' | 'I'];
  const tested: string[] = [];
  const at = (share: Share) => async (k: KeySet, use: KeyUse) => {
    tested.push(`${k.access} ${use}`);
    await testKeys(storeOf(k), { repo: keys.repo, ...rekeyTest(share, use), storageType: share.storageType });
  };
  const ks = (access: string): KeySet => ({ ...noKeys(), access, secret: `${access}-secret` });
  const aws = s3Share({ endpoint: 'https://s3.us-east-1.amazonaws.com' });
  const b2 = s3Share({ endpoint: 'https://s3.us-west-004.backblazeb2.com' });
  const base = { type: 's3' as const, write: ks('W1'), read: ks('R1'), readers, suggesters };

  await assert.rejects(rekey(owner.engine, { ...base, test: at(aws) }), /Enter keys for suggestions too: Ann sends you suggestions/);
  await assert.rejects(rekey(owner.engine, { ...base, suggest: ks('W1'), test: at(aws) }), /keys for suggestions are the new write keys/);
  await assert.rejects(rekey(owner.engine, { ...base, suggest: ks('R1'), test: at(aws) }), /keys for suggestions are the read-only keys/);
  assert.deepEqual(tested, [], 'nothing is tested before every set is entered and each differs');

  // A read-only key that can write is refused on every provider where an invite refuses one, B2 among them, which
  // before was let through so that suggesting readers kept a key that wrote.
  await assert.rejects(rekey(owner.engine, { ...base, read: ks('W2'), suggest: ks('W3'), test: at(b2) }), /can also change and delete/);
  // On B2 a key for suggestions can only be one that writes, as its rules say; on AWS it may write to the inbox alone.
  await assert.rejects(rekey(owner.engine, { ...base, suggest: ks('W3'), test: at(aws) }), /can also change and delete/);
  assert.equal(await mai.engine.rekeyOffer(), null, 'nothing is handed out before every set passed');
  await rekey(owner.engine, { ...base, suggest: ks('W3'), test: at(b2) });
  tested.length = 0;
  const n = await rekey(owner.engine, { ...base, suggest: ks('I1'), test: at(aws) });
  assert.deepEqual(tested, ['W1 write', 'R1 read', 'I1 suggest']);
  assert.deepEqual((await mai.engine.rekeyOffer())?.storage, { accessKey: 'R1', secretKey: 'R1-secret' });
  const ann = new Device('Ann', net, clock, { readOnly: true }, annKeys);
  assert.deepEqual(await ann.engine.rekeyOffer(), { n, storage: { accessKey: 'I1', secretKey: 'I1-secret' } });

  // The rule by provider: keys for those who only read never write, except over WebDAV, as at an invite.
  const share = (endpoint: string, storageType: 's3' | 'webdav' = 's3') => s3Share({ endpoint, storageType });
  assert.deepEqual(
    [share('https://s3.us-east-1.amazonaws.com'), share('https://minio.test'), share('https://acct.r2.cloudflarestorage.com'), share('https://s3.us-west-004.backblazeb2.com'), share('', 'webdav')].map(
      (s) => [rekeyTest(s, 'write'), rekeyTest(s, 'read').onlyRead, rekeyTest(s, 'suggest').onlyRead],
    ),
    [
      [{ write: true, onlyRead: false }, true, true],
      [{ write: true, onlyRead: false }, true, true],
      [{ write: true, onlyRead: false }, true, false],
      [{ write: true, onlyRead: false }, true, false],
      [{ write: true, onlyRead: false }, false, false],
    ],
  );
});

test('a re-key whose test did not reach storage is tried at the next sync, and one whose keys failed is tried again after a while', async () => {
  const { owner, writer } = await memberShare();
  await owner.sync();
  const lan = await writer('Lan');
  const n = await owner.engine.writeRekey({ write: { accessKey: 'NEW-AK', secretKey: 'NEW-SK' } });
  const kept = { ...noKeys(), access: 'OLD-AK', secret: 'OLD-SK' };
  const failing = (message: string) => ({ type: 's3' as const, kept, test: () => Promise.reject(new Error(message)), keep: async () => assert.fail('kept keys that failed') });
  assert.deepEqual(await followRekey(lan.engine, failing("Can't reach the storage. Check the address and the connection.\nfetch failed")), {
    n, switched: false, problem: "Can't reach the storage. Check the address and the connection.\nfetch failed", transient: true,
  });
  assert.deepEqual(await followRekey(lan.engine, failing('The storage refused these keys.\nS3 GET failed with HTTP 403 (InvalidAccessKeyId)')), {
    n, switched: false, problem: 'The storage refused these keys.\nS3 GET failed with HTTP 403 (InvalidAccessKeyId)',
  });
  const now = 1_800_000_000_000;
  assert.equal(rekeySkip({ n, at: now }, now + REKEY_RETRY_MS - 1), n);
  assert.equal(rekeySkip({ n, at: now }, now + REKEY_RETRY_MS), undefined);
  assert.equal(rekeySkip(undefined, now), undefined);
});

test('keys for a re-key use the names the command-line tool reads, and WebDAV keeps its user name when a re-key gives none', () => {
  const s3: KeySet = { access: ' AK ', secret: ' SK ', user: '', password: '' };
  assert.deepEqual(keysPayload('s3', s3), { accessKey: 'AK', secretKey: 'SK' });
  assert.deepEqual(keysFromPayload('s3', keysPayload('s3', s3), noKeys()), { access: 'AK', secret: 'SK', user: '', password: '' });
  assert.equal(keysFromPayload('s3', { accessKey: 'AK' }, noKeys()), undefined);
  const kept: KeySet = { ...noKeys(), user: 'ann', password: 'old' };
  assert.deepEqual(keysFromPayload('webdav', { webdavPassword: 'new' }, kept), { ...kept, password: 'new' });
  assert.deepEqual(keysFromPayload('webdav', keysPayload('webdav', { ...noKeys(), user: 'bob', password: 'pw' }), kept), { ...kept, user: 'bob', password: 'pw' });
  assert.equal(keysProblem('webdav', { ...noKeys(), user: 'u' }), 'Enter the user name and the password.');
  assert.equal(keysProblem('s3', s3), '');
  const { storage, secret } = withKeys(s3Share({ storageType: 'webdav', webdavUrl: 'https://dav.test/f', webdavUser: 'me', webdavPasswordSecret: 'kept' }), { ...noKeys(), password: 'typed' });
  assert.deepEqual(remoteSpec(storage, secret), { type: 'webdav', url: 'https://dav.test/f', username: 'me', password: 'typed' });
});

test('a read invite’s key that is this device’s own is refused in words that fit the invite', () => {
  const own: KeySet = { ...noKeys(), access: 'AK', secret: 'SK' };
  const typed: KeySet = { ...noKeys(), access: ' AK ', secret: 'other' };
  assert.equal(readKeyProblem('s3', typed, own, false), 'That is the key this device writes with. Make another one that can only read.');
  assert.equal(readKeyProblem('s3', typed, own, true), 'That is the key this device writes with. Make another one that can read and add suggestions.');
  assert.equal(readKeyProblem('s3', { ...typed, access: 'RO' }, own, true), '');
  assert.equal(readKeyProblem('s3', noKeys(), own, false), 'Enter both keys.');
});

test('where new storage keys are said to cut a removed member off, a follow link and suggestions are said too', () => {
  assert.equal(followCaveat([{}, { follow: true }]), 'This folder has a follow link, so its public address still lets someone you removed read everything, now and later. Only a new shared folder stops that.');
  assert.equal(followCaveat([{}, {}]), '');
  assert.equal(followCaveat(undefined), '');
  assert.equal(rekeyReadersNote(['Mai']), 'Mai only reads: make a new key that can only read this folder, too.');
  assert.match(rekeyReadersNote(['Mai', 'Ann']), /^Mai, Ann only read:/);
  assert.equal(rekeySuggestersNote(['Ann']), 'Ann sends you suggestions: make a new key that can read this folder and add suggestions to it, too.');
  assert.match(rekeySuggestersNote(['Ann', 'Bo']), /^Ann, Bo send you suggestions:/);
});

test('the owner’s member list says how each member stands, and when they last changed something', () => {
  const now = 1_800_000_000_000;
  const at = (over: Partial<MemberStatus>): MemberStatus => ({ id: 'x', name: 'Ann', role: 'write', state: 'joined', self: false, ...over });
  assert.equal(memberLine(at({ role: 'owner', self: true }), now), 'This is you');
  assert.match(memberLine(at({ lastChange: now - 60_000 }), now), /^Joined · last change \d/);
  assert.equal(memberLine(at({ state: 'confirming' }), now), 'Joined on a device, waiting for your device to confirm it');
  assert.match(memberLine(at({ state: 'waiting', expires: now + DAY }), now), /^Invited, not joined yet · invite works until /);
  assert.match(memberLine(at({ state: 'waiting', role: 'read', expires: now + DAY }), now), /^Invite works until /);
  assert.equal(memberLine(at({ state: 'expired' }), now), 'Invite expired before anyone joined');
  assert.match(memberLine(at({ state: 'expired', role: 'read' }), now), /Devices that joined before keep receiving/);
  assert.deepEqual(['owner', 'write', 'read', ''].map((r) => roleLabel(r as MemberStatus['role'])), ['Owner', 'Can edit', 'Can only read', '']);
  assert.equal(roleLabel('read', false, true), 'Can read and suggest');
  assert.deepEqual([...INVITE_DAYS], [1, 7, 30]);
});

test('a removed member’s row drops its role, which its status replaces; a member’s first screen says it joined', () => {
  assert.equal(roleOnRow({ role: 'write', followUrl: '' }, { removed: true }), '');
  assert.equal(roleOnRow({ role: 'write', followUrl: '' }, { removed: false }), 'Can edit');
  assert.equal(roleOnRow({ role: 'read', followUrl: 'https://x' }, undefined), 'Follow link');
  assert.equal(addedLine('Team', 'joined', '3 received'), 'You joined “Team”: 3 received.');
  assert.equal(addedLine('Team', 'started', '5 sent'), '“Team” is shared: 5 sent.');
  assert.equal(addedLine('Team', 'added'), '“Team” is on this device too.');
});

test('a share with members that stopped, or a device removed from it, says what happened and what can be done, in its own words', () => {
  const removed = describeFailure(new RemovedError());
  assert.deepEqual([removed.id, removed.severity, removed.action], ['removed', 'critical', 'stop-sharing']);
  assert.match(removed.detail, /files in the folder stay/);
  const stuck = new UnverifiedError(7, 'it is not signed');
  const forOwner = describeFailure(stuck, { owner: true, ownerName: 'Vu' });
  assert.deepEqual([forOwner.id, forOwner.action], ['unverified', 'remove-unverified']);
  assert.match(forOwner.title, /not made by a member who may write to it/);
  const forMember = describeFailure(stuck, { owner: false, ownerName: 'Vu' });
  assert.equal(forMember.action, undefined);
  assert.match(forMember.detail, /Vu's device can remove that change/);
  const legacy = describeFailure(new Error('This storage holds a shared folder with members, which a device joins with an invite link rather than a passphrase'));
  assert.deepEqual([legacy.id, legacy.action], ['members-format', 'stop-sharing']);
  assert.equal(describeFailure(new Error('This storage location holds another shared folder than the one this device joined')).id, 'other-share');
  assert.equal(describeFailure(new Error('Remote chunk ab in pack cd does not match its id: corrupted or tampered with')).id, 'damaged');
  assert.equal(describeFailure(new Error('Remote vault uses format 3; this version reads format 2')).id, 'format');
  assert.match(memberError(stuck), /Remove that change first/);
  assert.match(memberError(new ReadOnlyError()), /only receives changes for this folder/);
  assert.equal(memberError(new Error('There is no such member')), 'There is no such member');
});

test('a member’s device waiting for the owner’s says so on its row, and its unsent files say when they go', () => {
  const waiting = { waiting: true, owner: 'Vu' };
  assert.deepEqual(shareLine([], waiting, 0, false), { text: "Waiting for Vu's device to confirm", tone: 'warning' });
  assert.equal(shareLine([], { waiting: true, owner: '' }, 0, false).text, "Waiting for the owner's device to confirm");
  const critical = describeFailure(new RemovedError());
  assert.equal(shareLine([critical], waiting, 0, false).text, critical.title, 'a problem that stops it comes first');
  assert.match(shareLine([], { waiting: false, owner: 'Vu' }, 0, false).text, /Not synced yet/);
  const r = { errors: [], tooLarge: [], unsent: ['Family/a.md'] };
  assert.match(resultProblems(r, [], 100, 'Vu')[0].detail, /once Vu's device confirms it/);
  assert.match(resultProblems(r, [], 100)[0].detail, /Turn off Only receive changes/);
});

test('a re-key with WebDAV keys reaches a member who switches its password and keeps working', async () => {
  const { owner, writer } = await memberShare();
  await owner.sync();
  const lan = await writer('Lan');
  await lan.sync();
  const n = await rekey(owner.engine as SyncEngine, { type: 'webdav', write: { ...noKeys(), user: 'team', password: 'new pw' }, readers: [], test: async () => undefined });
  let kept: KeySet | undefined;
  const out = await followRekey(lan.engine, { type: 'webdav', kept: { ...noKeys(), user: 'team', password: 'old pw' }, test: async () => undefined, keep: async (k) => void (kept = k) });
  assert.deepEqual(out, { n, switched: true });
  assert.deepEqual(kept, { ...noKeys(), user: 'team', password: 'new pw' });
});
