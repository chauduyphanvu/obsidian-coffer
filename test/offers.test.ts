// Shared folders that follow the user's own devices (src/plugin/offers.ts): what an offer carries for each kind of
// shared folder, how the vault's other devices find it at little cost, and that adding one gives a working device.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listDevices } from '../src/core/devices.ts';
import { ReadOnlyError, type RemoteStore } from '../src/core/types.ts';
import type { FolderFS } from '../src/core/scopedfs.ts';
import { MEMBER_KEYS, standingHere } from '../src/plugin/members.ts';
import {
  forgetGone,
  isOffered,
  lookForOffers,
  offerKey,
  offerOf,
  offersDue,
  offersHere,
  offersOf,
  parseOffer,
  publishOffer,
  shareFromOffer,
  withdrawOffers,
  OFFERS_EVERY,
  type Offer,
  type OfferCache,
} from '../src/plugin/offers.ts';
import { defaultSettings, isConfigured, loadSettings, shareSecretName, shareWith, type Settings, type Share } from '../src/plugin/settings.ts';
import { makeEngine, type EngineHost } from '../src/plugin/shares.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { SimStore } from '../src/testing/netsim.ts';
import { Device, memberShare } from './helpers.ts';

const lookupOf = (secrets: Record<string, string>) => (n: string) => secrets[n] ?? '';
const s3Share = (over: Partial<Share>) => shareWith({ id: 'f4m1ly00', folder: 'Family', endpoint: 'https://s3.test', bucket: 'b', prefix: 'family', accessKeySecret: 'ak', secretKeySecret: 'sk', ...over });
const roundTrip = (o: Offer) => parseOffer(JSON.parse(JSON.stringify(o)));

class VaultFS extends MemFS implements FolderFS {
  folders = new Set<string>();
  async listFolder(folder: string) {
    const files = (await this.list()).filter((f) => f.path.startsWith(`${folder}/`));
    return this.folders.has(folder) || files.length ? files : null;
  }
}

/** A device of the plugin with one shared folder added as `share`, its secrets in `secrets`, syncing with `store`. */
function pluginDevice(name: string, store: RemoteStore, share: Share, secrets: [string, string][], clock: { now: number }) {
  const values = new Map(secrets);
  const settings: Settings = { ...defaultSettings(false), deviceName: name, endpoint: 'https://vault.test', bucket: 'vault', shares: [share] };
  const states = new Map<string, MemState>();
  const fs = new VaultFS();
  fs.folders.add(share.folder);
  const host: EngineHost = {
    settings,
    configDir: '.obsidian',
    pluginDir: '.obsidian/plugins/coffer',
    files: fs,
    secret: (n) => values.get(n) ?? '',
    openStore: () => store,
    stateStore: (path) => {
      if (!states.has(path)) states.set(path, new MemState());
      return states.get(path)!;
    },
  };
  return { fs, settings, secret: host.secret, engine: () => makeEngine(host, share, { now: () => clock.now }).engine };
}

test('an offer of a folder shared with a passphrase carries its storage, keys and passphrase, and adds it under the same id and secret names of this vault', () => {
  const share = s3Share({ passphraseSecret: 'pass', readOnly: true });
  const secret = lookupOf({ ak: 'AK', sk: 'SK', pass: 'share passphrase' });
  const offer = offerOf(share, secret, 'Mac', 7);
  assert.deepEqual(offer, {
    v: 1, id: 'f4m1ly00', folder: 'Family', by: 'Mac', time: 7, role: '', readOnly: true, passphrase: 'share passphrase',
    storage: { storageType: 's3', endpoint: 'https://s3.test', region: 'auto', bucket: 'b', prefix: 'family', pathStyle: true, webdavUrl: '', webdavUser: '', accessKey: 'AK', secretKey: 'SK', webdavPassword: '' },
  });
  assert.deepEqual(roundTrip(offer), offer);

  const { share: added, secrets } = shareFromOffer(offer, 'Notes');
  const name = (base: string) => shareSecretName(base, 'Notes', 'f4m1ly00');
  assert.deepEqual(secrets, [[name('coffer-access-key'), 'AK'], [name('coffer-secret-key'), 'SK'], [name('coffer-passphrase'), 'share passphrase']]);
  assert.deepEqual(
    [added.id, added.folder, added.endpoint, added.bucket, added.prefix, added.readOnly, added.role, added.memberKeysSecret, added.followUrl, added.offerPending],
    ['f4m1ly00', 'Family', 'https://s3.test', 'b', 'family', true, '', '', '', ''],
  );
  assert.ok(isConfigured(added, lookupOf(Object.fromEntries(secrets))));
});

test('an offer of a shared folder with members makes another owner’s device, or one that only reads: a write member’s private key never leaves its device', async () => {
  const { keys, writer, join } = await memberShare();
  const secret = lookupOf({ ak: 'AK', sk: 'SK', pass: 'owner passphrase', mk: JSON.stringify(keys) });
  const owner = offerOf(s3Share({ role: 'owner', memberKeysSecret: 'mk', passphraseSecret: 'pass' }), secret, 'Mac', 1);
  assert.equal(owner.role, 'owner');
  assert.deepEqual(owner.member, keys, 'the owner’s keys whole, root and signing key with them');
  assert.equal(owner.passphrase, 'owner passphrase', 'so that device can make the link for the owner’s other devices too');
  assert.deepEqual(roundTrip(owner), owner);
  const { share: ownerHere, secrets } = shareFromOffer(owner, 'Notes');
  assert.equal(ownerHere.role, 'owner');
  assert.equal(ownerHere.memberKeysSecret, shareSecretName(MEMBER_KEYS, 'Notes', 'f4m1ly00'));
  assert.deepEqual(JSON.parse(secrets.find(([n]) => n === ownerHere.memberKeysSecret)![1]), keys);

  const lan = (await writer('Lan')).keys!;
  assert.ok(lan.key);
  const edits = offerOf(s3Share({ role: 'write', memberKeysSecret: 'mk' }), lookupOf({ ak: 'AK', sk: 'SK', mk: JSON.stringify(lan) }), 'Lan’s laptop', 1);
  assert.deepEqual([edits.role, edits.readOnly, edits.edits, edits.member?.key], ['read', true, true, undefined]);
  assert.ok(!JSON.stringify(edits).includes(lan.key.d));
  assert.deepEqual(roundTrip(edits), edits);
  const { share: lanHere } = shareFromOffer(edits, 'Notes');
  assert.deepEqual([lanHere.role, lanHere.readOnly], ['read', true]);

  const mai = (await join('Mai', 'read')).keys!;
  const reads = offerOf(s3Share({ role: 'read', readOnly: true, memberKeysSecret: 'mk' }), lookupOf({ ak: 'RO', sk: 'RO', mk: JSON.stringify(mai) }), 'Mai’s phone', 1);
  assert.deepEqual([reads.role, reads.edits, reads.member], ['read', undefined, mai]);

  const follow = offerOf(shareWith({ id: 'w3b00000', folder: 'Blog', role: 'read', readOnly: true, memberKeysSecret: 'mk', followUrl: 'https://pub.example.com/blog' }), lookupOf({ mk: JSON.stringify(mai) }), 'Mac', 1);
  assert.deepEqual([follow.followUrl, follow.storage, follow.role], ['https://pub.example.com/blog', {}, 'read']);
  const { share: followHere, secrets: followSecrets } = shareFromOffer(follow, 'Notes');
  assert.deepEqual([followHere.followUrl, followHere.readOnly, followSecrets.length], ['https://pub.example.com/blog', true, 1], 'no storage keys: only its member keys');
  assert.ok(isConfigured(followHere, lookupOf(Object.fromEntries(followSecrets))));
});

test('an offer that does not hold what its kind needs is not shown', async () => {
  const { keys } = await memberShare();
  const { key: _, ...noKey } = keys;
  const base = { v: 1, id: 'a1b2c3d4', folder: 'Family', by: 'Mac', time: 1, readOnly: false, storage: {} };
  assert.ok(parseOffer({ ...base, role: '', passphrase: 'p' }));
  for (const bad of [
    null, [], 'x', { ...base, v: 2, role: '', passphrase: 'p' },
    { ...base, role: '' },
    { ...base, role: '', passphrase: 'p', member: keys },
    { ...base, role: '', passphrase: 'p', followUrl: 'https://x.test' },
    { ...base, role: 'owner', member: noKey },
    { ...base, role: 'read', member: keys },
    { ...base, role: 'read', member: { ...noKey, master: 'short' } },
    { ...base, role: 'admin', member: noKey },
    { ...base, role: 'read', member: noKey, followUrl: 'ftp://x.test' },
    { ...base, id: '../vault', role: '', passphrase: 'p' },
    { ...base, folder: '/', role: '', passphrase: 'p' },
    { ...base, storage: [], role: '', passphrase: 'p' },
  ]) {
    assert.equal(parseOffer(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(parseOffer({ ...base, role: 'read', member: noKey, readOnly: false })?.readOnly, true, 'a device that only reads is set to');
});

test('offers shown here leave out what is added here, under its id or at its storage location, what was hidden, and the lesser of two for one location', () => {
  const offer = (id: string, over: Partial<Offer> = {}): Offer => ({
    v: 1, id, folder: id, by: 'Mac', time: 1, role: '', readOnly: false, passphrase: 'p',
    storage: { storageType: 's3', endpoint: 'https://s3.test', bucket: 'b', prefix: id }, ...over,
  });
  const s = loadSettings({ shares: [s3Share({ id: 'here0001', prefix: 'mine' })], offersHidden: ['hid00001'] }, false);
  const shown = offersHere(
    [
      offer('here0001'),
      offer('other001', { storage: { storageType: 's3', endpoint: 'HTTPS://S3.TEST', bucket: 'b', prefix: '/mine/' } }),
      offer('hid00001'),
      offer('zz000001', { folder: 'Zed' }),
      offer('dup00001', { storage: { storageType: 's3', endpoint: 'https://s3.test', bucket: 'b', prefix: 'same' }, time: 5 }),
      offer('dup00002', { storage: { storageType: 's3', endpoint: 'https://s3.test', bucket: 'b', prefix: 'same' }, time: 9 }),
      offer('dup00003', { storage: { storageType: 's3', endpoint: 'https://s3.test', bucket: 'b', prefix: 'two' }, time: 9, role: 'read', passphrase: undefined }),
      offer('dup00004', { storage: { storageType: 's3', endpoint: 'https://s3.test', bucket: 'b', prefix: 'two' }, time: 1, role: 'owner', passphrase: undefined }),
    ],
    s,
  );
  assert.deepEqual(shown.map((o) => o.id), ['dup00002', 'dup00004', 'zz000001']);
});

test('offers go through the vault’s storage sealed with its key: one list per look, and a read only of what is new or changed', async () => {
  const clock = { now: 1_800_000_000_000 };
  const net = new SimStore(new MemoryStore(() => clock.now));
  const [mac, phone] = [new Device('mac', net, clock), new Device('phone', net, clock)];
  const watcher = new Device('watch', net, clock, { readOnly: true });
  mac.fs.put('a.md', 'a\n');
  await mac.sync();
  await phone.sync();
  const share = s3Share({ passphraseSecret: 'pass', offerPending: 'add' });
  const secret = lookupOf({ ak: 'AK', sk: 'SK', pass: 'share passphrase' });
  const macDocs = (await mac.engine.view()).repo;
  await publishOffer(macDocs, share, secret, 'mac', clock.now);
  const raw = await net.get(offerKey(share.id));
  assert.ok(raw && !new TextDecoder().decode(raw).includes('share passphrase'), 'sealed');

  const cache: OfferCache = new Map();
  const phoneDocs = (await phone.engine.view()).repo;
  net.reset();
  const [found] = await lookForOffers(phoneDocs, cache);
  assert.deepEqual([net.stats.list, net.stats.get], [1, 1]);
  assert.deepEqual(found, offerOf(share, secret, 'mac', clock.now));
  net.reset();
  await lookForOffers(phoneDocs, cache);
  assert.deepEqual([net.stats.list, net.stats.get, net.stats.put], [1, 0, 0], 'nothing new: nothing read');

  // New keys on the device that offered it: the offer is written again, and read again once.
  clock.now += 1000;
  await publishOffer(macDocs, { ...share, offerPending: 'update' }, lookupOf({ ak: 'AK2', sk: 'SK2', pass: 'share passphrase' }), 'mac', clock.now);
  net.reset();
  const [updated] = await lookForOffers(phoneDocs, cache);
  assert.deepEqual([net.stats.list, net.stats.get], [1, 1]);
  assert.equal(updated.storage.accessKey, 'AK2');
  assert.ok(isOffered(share, cache));

  // Stopping with "stop offering": gone for every device, and an update made afterwards does not bring it back.
  await withdrawOffers(macDocs, share, cache);
  assert.equal(await net.get(offerKey(share.id)), null);
  await publishOffer(macDocs, { ...share, offerPending: 'update' }, secret, 'mac', clock.now);
  assert.deepEqual(await lookForOffers(phoneDocs, cache), []);
  assert.ok(!isOffered(share, cache));

  // A device that only receives the vault's changes reads offers, and can not write one.
  await publishOffer(macDocs, share, secret, 'mac', clock.now);
  const watchDocs = (await watcher.engine.view()).repo;
  assert.equal((await lookForOffers(watchDocs, new Map())).length, 1);
  await assert.rejects(publishOffer(watchDocs, { ...share, id: 'w4tch000' }, secret, 'watch', clock.now), ReadOnlyError);
});

test('withdrawing an offer takes every offer of that storage location, made under any id', async () => {
  const clock = { now: 1_800_000_000_000 };
  const net = new SimStore(new MemoryStore(() => clock.now));
  const mac = new Device('mac', net, clock);
  await mac.sync();
  const docs = (await mac.engine.view()).repo;
  const secret = lookupOf({ ak: 'AK', sk: 'SK', pass: 'p' });
  const share = s3Share({ passphraseSecret: 'pass' });
  await publishOffer(docs, share, secret, 'mac', 1);
  await publishOffer(docs, { ...share, id: 'phone001' }, secret, 'phone', 2);
  await publishOffer(docs, { ...share, id: 'other001', prefix: 'other' }, secret, 'phone', 3);
  const cache: OfferCache = new Map();
  assert.equal((await lookForOffers(docs, cache)).length, 3);
  assert.deepEqual(offersOf(share, cache).sort(), ['f4m1ly00', 'phone001']);
  await withdrawOffers(docs, share, cache);
  assert.deepEqual((await lookForOffers(docs, cache)).map((o) => o.id), ['other001']);
});

test('a vault that holds offers syncs, cleans up, checks and repairs as before: nothing there lists or touches them', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const [mac, phone] = [new Device('mac', mem, clock), new Device('phone', mem, clock)];
  mac.fs.put('a.md', 'a\n');
  await mac.sync();
  await publishOffer((await mac.engine.view()).repo, s3Share({ passphraseSecret: 'pass' }), lookupOf({ pass: 'p' }), 'mac', 1);
  const before = mem.objects.get(offerKey('f4m1ly00'));
  await phone.sync();
  phone.fs.put('a.md', 'b\n');
  await phone.sync();
  await mac.sync();
  clock.now += 400 * 86_400_000;
  await mac.engine.gc();
  const report = await mac.engine.verify();
  assert.deepEqual(report.problems, []);
  await mac.engine.repair();
  assert.deepEqual((await listDevices(await mac.engine.view())).map((d) => d.name), []);
  assert.equal(mem.objects.get(offerKey('f4m1ly00')), before);
  assert.equal(mac.fs.text('a.md'), 'b\n');
});

test('a device added from an offer works: the owner’s other device invites, and a write member’s other device receives without writing or waiting', async () => {
  const { keys, owner, writer, mem, clock } = await memberShare();
  owner.fs.put('plan.md', 'v1\n');
  await owner.sync();
  const store = new SimStore(mem);

  const ownerOffer = offerOf(s3Share({ role: 'owner', memberKeysSecret: 'mk', passphraseSecret: 'pass' }), lookupOf({ ak: 'AK', sk: 'SK', pass: 'owner passphrase', mk: JSON.stringify(keys) }), 'mac', 1);
  const fromOwner = shareFromOffer(ownerOffer, 'Notes');
  const ipad = pluginDevice('ipad', store, fromOwner.share, fromOwner.secrets, clock);
  const ipadEngine = ipad.engine();
  await ipadEngine.sync();
  assert.equal(ipad.fs.text('Family/plan.md'), 'v1\n');
  assert.equal((await ipadEngine.memberStanding())?.role, 'owner');
  await ipadEngine.invite({ name: 'Bo', role: 'read', expires: clock.now + 86_400_000 });
  assert.ok((await owner.engine.members()).some((m) => m.name === 'Bo'));

  const lan = await writer('Lan');
  lan.fs.put('lan.md', 'from Lan\n');
  await lan.sync();
  const lanOffer = offerOf(s3Share({ role: 'write', memberKeysSecret: 'mk' }), lookupOf({ ak: 'AK', sk: 'SK', mk: JSON.stringify(lan.keys) }), 'Lan’s laptop', 1);
  const fromLan = shareFromOffer(lanOffer, 'Notes');
  const phone = pluginDevice('lan-phone', store, fromLan.share, fromLan.secrets, clock);
  phone.fs.put('Family/mine.md', 'typed on the phone\n');
  const phoneEngine = phone.engine();
  store.reset();
  const r = await phoneEngine.sync();
  assert.equal(store.stats.put + store.stats.delete, 0, 'it never writes');
  assert.deepEqual(r.unsent, ['mine.md']);
  assert.equal(phone.fs.text('Family/lan.md'), 'from Lan\n');
  const standing = standingHere(fromLan.share, await phoneEngine.memberStanding());
  assert.deepEqual([standing?.role, standing?.mayWrite, standing?.waiting], ['write', false, false]);
  assert.deepEqual((await owner.engine.members()).map((m) => [m.name, m.state]), [['Vu', 'joined'], ['Bo', 'waiting'], ['Lan', 'joined']]);
});

test('offers are looked for at the first sync of a session and every 30 minutes after; what is kept of them is trimmed to what storage holds', () => {
  assert.equal(offersDue(0, 5), true);
  assert.equal(offersDue(1000, 1000 + OFFERS_EVERY), false);
  assert.equal(offersDue(1000, 1001 + OFFERS_EVERY), true);
  const s = loadSettings({ offersTold: ['a', 'b'], offersHidden: ['b', 'c'] }, false);
  forgetGone(s, new Map([[offerKey('b'), { modified: 1 }], [offerKey('c'), { modified: Number.NaN }]]));
  assert.deepEqual([s.offersTold, s.offersHidden], [['b'], ['b', 'c']], 'one that could not be read this time is still there');
});

test('settings saved by 0.3.0 load with no offers told or hidden, and shares that are neither followed nor owe an offer', () => {
  const s = loadSettings({ deviceName: 'mac', shares: [{ id: 'x1', folder: 'Work', bucket: 'b', passphraseSecret: 'p' } as Share] }, false);
  assert.deepEqual([s.offersTold, s.offersHidden], [[], []]);
  assert.deepEqual([s.shares[0].followUrl, s.shares[0].offerPending], ['', '']);
  assert.deepEqual(loadSettings(null, false).offersTold, []);
});
