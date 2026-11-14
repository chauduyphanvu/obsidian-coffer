// Follow links in the plugin (a followed folder in settings, checking the public address, following it end to end) and
// the access rules shown where the owner makes keys for others.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFollow, encodeFollow } from '../src/core/members.ts';
import { joinShare } from '../src/core/membership.ts';
import type { FolderFS } from '../src/core/scopedfs.ts';
import type { MemberStatus } from '../src/core/engine.ts';
import { checkFollowAddress, memberLine, publicAddressGuess, roleLabel, sharePolicy, standingHere } from '../src/plugin/members.ts';
import {
  codeKind,
  decodeInvite,
  defaultSettings,
  describeStorage,
  hasStorageAddress,
  isConfigured,
  isFollowLink,
  opensAlone,
  remoteSpec,
  sameKeys,
  setupCodeFrom,
  setupLink,
  shareWith,
  storageLocation,
  storageProblem,
  type Settings,
  type Share,
} from '../src/plugin/settings.ts';
import { makeEngine, targetsOf, type EngineHost } from '../src/plugin/shares.ts';
import type { Http } from '../src/stores/http.ts';
import type { MemoryStore } from '../src/stores/memory.ts';
import { FollowStore } from '../src/stores/follow.ts';
import { openRemote } from '../src/stores/open.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { memberShare } from './helpers.ts';

const BASE = 'https://pub.example.com/family';

/** The public copy of `mem` at BASE, read with GET only, as a web server or a public bucket serves it. Counts every request. */
function publicCopy(mem: MemoryStore, up = true) {
  const seen: string[] = [];
  const http: Http = async (req) => {
    seen.push(`${req.method} ${req.url}`);
    if (!up) return { status: 503, body: new Uint8Array(0) };
    if (req.method !== 'GET' || !req.url.startsWith(`${BASE}/`)) return { status: 403, body: new Uint8Array(0) };
    const key = decodeURIComponent(req.url.slice(BASE.length + 1));
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const body = await mem.get(key, m ? { start: Number(m[1]), end: Number(m[2]) + 1 } : undefined);
    return body ? { status: m ? 206 : 200, body } : { status: 404, body: new Uint8Array(0) };
  };
  return { http, seen };
}

const followed = (over: Partial<Share> = {}) => shareWith({ id: 'w3b00001', folder: 'Blog', role: 'read', readOnly: true, memberKeysSecret: 'mk', followUrl: BASE, ...over });

test('a followed folder has no storage keys: it is set up by its member keys and public address alone', () => {
  const share = followed();
  const secret = (n: string) => (n === 'mk' ? '{}' : '');
  assert.ok(isConfigured(share, secret));
  assert.ok(!isConfigured(share, () => ''));
  assert.ok(hasStorageAddress(share));
  assert.deepEqual(remoteSpec(share, secret), { type: 'follow', url: BASE });
  assert.equal(storageLocation(share), `follow ${BASE}`);
  assert.equal(describeStorage(share), 'Public copy · pub.example.com');
  const vault: Settings = { ...defaultSettings(false), endpoint: 'https://s3.test', bucket: 'b', accessKeySecret: 'ak' };
  assert.ok(!sameKeys(share, vault, secret));
  vault.shares = [share];
  assert.match(storageProblem(vault, followed({ id: 'other001', followUrl: 'HTTPS://PUB.EXAMPLE.COM/family/' })), /already syncs with that location/);
  assert.equal(storageProblem(vault, followed({ id: 'other001', followUrl: 'https://pub.example.com/other' })), '');
  assert.deepEqual(targetsOf(vault, secret), [undefined, share]);
});

test('a follow link travels in the same obsidian:// link as an invite, opens with nothing typed, and is never taken for a passphrase invite', async () => {
  const { owner } = await memberShare();
  const grant = await owner.engine.invite({ name: 'Web', role: 'read', expires: 0, follow: true });
  const code = encodeFollow({ ...grant, url: BASE, share: 'Blog', folder: 'Blog' });
  assert.ok(isFollowLink(code) && opensAlone(code));
  assert.equal(codeKind(code), 'share');
  const link = setupLink(code);
  assert.match(link, /^obsidian:\/\/coffer\?share=cofferfollow1\./);
  assert.equal(setupCodeFrom(link), code);
  await assert.rejects(decodeInvite(code, 'any', 'V', 'j1'), /not an invite link/);
});

test('the public address is checked to serve this shared folder before a follow link is made', async () => {
  const { owner, mem, keys } = await memberShare();
  await owner.sync();
  await checkFollowAddress(new FollowStore({ url: BASE }, publicCopy(mem).http), keys.repo);
  await assert.rejects(checkFollowAddress(new FollowStore({ url: BASE }, publicCopy(mem).http), 'another'), /another shared folder/);
  await assert.rejects(checkFollowAddress(new FollowStore({ url: `${BASE}/wrong` }, publicCopy(mem).http), keys.repo), /vault\.json could not be read/);
  await assert.rejects(checkFollowAddress(new FollowStore({ url: BASE }, publicCopy(mem, false).http), keys.repo), /did not answer/);
});

test('a followed folder syncs read-only over its public address, by name only, and gets no storage keys at a re-key', async () => {
  const { owner, mem, clock } = await memberShare();
  owner.fs.put('post.md', 'hello\n');
  await owner.sync();
  const grant = await owner.engine.invite({ name: 'Web', role: 'read', expires: 0, follow: true });
  const invite = decodeFollow(encodeFollow({ ...grant, url: BASE, share: 'Blog', folder: 'Blog' }));
  const { http, seen } = publicCopy(mem);
  const keys = await joinShare(openRemote({ type: 'follow', url: invite.url }, http), invite, clock.now);
  assert.equal(keys.key, undefined);

  const share = followed();
  const secrets: Record<string, string> = { mk: JSON.stringify(keys) };
  const files = new (class extends MemFS implements FolderFS {
    async listFolder(folder: string) {
      return (await this.list()).filter((f) => f.path.startsWith(`${folder}/`));
    }
  })();
  const host: EngineHost = {
    settings: { ...defaultSettings(false), endpoint: 'https://vault.test', bucket: 'v', shares: [share] },
    configDir: '.obsidian',
    pluginDir: '.obsidian/plugins/coffer',
    files,
    secret: (n) => secrets[n] ?? '',
    openStore: (spec) => openRemote(spec, http),
    stateStore: () => new MemState(),
  };
  const engine = makeEngine(host, share, { now: () => clock.now }).engine;
  files.put('Blog/draft.md', 'mine\n');
  const r = await engine.sync();
  assert.equal(files.text('Blog/post.md'), 'hello\n');
  assert.deepEqual(r.unsent, ['draft.md']);
  owner.fs.put('post2.md', 'more\n');
  await owner.sync();
  await engine.sync();
  assert.equal(files.text('Blog/post2.md'), 'more\n');
  assert.ok(seen.every((s) => s.startsWith('GET ')), 'never anything but a read');
  const standing = standingHere(share, await engine.memberStanding());
  assert.deepEqual([standing?.role, standing?.mayWrite, standing?.waiting], ['read', false, false]);
  await owner.engine.writeRekey({ write: { accessKey: 'new', secretKey: 'new' } });
  assert.equal(await engine.rekeyOffer(), null);
});

test('a follow link’s member reads as such in the member list', () => {
  const m: MemberStatus = { id: 'x', name: 'Blog readers', role: 'read', state: 'waiting', self: false, follow: true };
  assert.equal(roleLabel(m.role, true), 'Follow link');
  assert.equal(roleLabel('read'), 'Can only read');
  assert.equal(memberLine(m, 0), 'Anyone with the link can read');
  assert.match(memberLine({ ...m, state: 'expired' }, 0), /opens nothing new/);
});

test('the public address is guessed where the storage settings tell it, and left to the owner where they do not', () => {
  const s3 = (over: Partial<Share>) => shareWith({ id: 'a', folder: 'F', bucket: 'notes', prefix: '/shared-family/', ...over });
  assert.equal(publicAddressGuess(s3({ endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1' })), 'https://notes.s3.eu-west-1.amazonaws.com/shared-family');
  assert.equal(publicAddressGuess(s3({ endpoint: 's3.us-west-004.backblazeb2.com' })), 'https://s3.us-west-004.backblazeb2.com/notes/shared-family');
  assert.equal(publicAddressGuess(s3({ endpoint: 'https://minio.home:9000/', prefix: '' })), 'https://minio.home:9000/notes');
  assert.equal(publicAddressGuess(s3({ endpoint: 'https://acc.r2.cloudflarestorage.com' })), '');
  assert.equal(publicAddressGuess(s3({ storageType: 'webdav', webdavUrl: 'https://dav.test/f' })), '');
});

test('the access rules shown for a key follow the provider of the shared folder’s storage', () => {
  const at = (endpoint: string, prefix = 'family') => shareWith({ id: 'a', folder: 'F', endpoint, bucket: 'b', prefix });
  const aws = sharePolicy(at('https://s3.us-east-1.amazonaws.com'), 'readOnly');
  assert.ok(aws.possible);
  assert.match(aws.text, /arn:aws:s3:::b\/family\/\*/);
  assert.ok(!sharePolicy(at('https://acc.r2.cloudflarestorage.com'), 'readOnly').possible, 'R2 keys reach a whole bucket');
  assert.ok(sharePolicy(at('https://acc.r2.cloudflarestorage.com', ''), 'readOnly').possible);
  assert.ok(!sharePolicy(at('https://s3.us-west-004.backblazeb2.com'), 'publicRead').possible);
  assert.equal(sharePolicy(shareWith({ id: 'a', folder: 'F', storageType: 'webdav', webdavUrl: 'https://dav.test/x' }), 'readWrite').kind, 'readWrite');
  assert.match(sharePolicy(at('https://minio.test'), 'readWrite').steps, /S3|bucket/i);
});
