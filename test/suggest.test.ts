import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromB64 } from '../src/core/bytes.ts';
import { memberSecret } from '../src/core/members.ts';
import { INBOX, INBOX_OPENED, MAX_SEALED, SUGGEST_MAX_FILE, inboxKey, openSuggestion, parseInboxKey, sealSuggestion } from '../src/core/suggest.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { lossy, memberShare } from './helpers.ts';

const inboxObjects = async (store: RemoteStore) => (await store.list(INBOX)).map((o) => o.key);

/** The owner and a read member, both synced to two notes, and the read member's note changed on its device. */
async function readerWithChange() {
  const share = await memberShare();
  const { owner, join } = share;
  owner.fs.put('plan.md', 'one\ntwo\nthree\n');
  owner.fs.put('board.canvas', '{"nodes":[],"edges":[]}');
  owner.fs.put('photo.png', new Uint8Array([1, 2, 3]));
  await owner.sync();
  const mai = await join('Mai', 'read');
  await mai.sync();
  mai.fs.put('plan.md', 'one\ntwo, with Mai’s words\nthree\n');
  mai.fs.put('new.md', 'a new note\n');
  mai.fs.put('photo.png', new Uint8Array([9, 9]));
  const r = await mai.sync();
  assert.deepEqual(r.unsent, ['new.md', 'photo.png', 'plan.md']);
  return { ...share, mai, unsent: r.unsent };
}

test('a read member sends its changed notes as one sealed suggestion, and only the owner’s devices can open it', async () => {
  const { owner, mai, mem, net, keys, unsent, writer } = await readerWithChange();
  const before = new Set((await mem.list('')).map((o) => o.key));
  const out = await mai.engine.sendSuggestion([...unsent, 'board.canvas']);
  assert.deepEqual(out.sent.map((f) => f.path), ['new.md', 'plan.md']);
  assert.deepEqual(out.skipped, [{ path: 'board.canvas', why: 'same' }, { path: 'photo.png', why: 'kind' }]);
  // A device that only receives wrote exactly one object, its suggestion, and nothing else.
  const added = (await mem.list('')).map((o) => o.key).filter((k) => !before.has(k));
  assert.deepEqual(added, [out.key]);
  assert.deepEqual(parseInboxKey(out.key!), { member: mai.keys!.id, time: mai.clock.now });
  const raw = (await mem.get(out.key!))!;
  assert.ok(!Buffer.from(raw).toString('latin1').includes('two, with'), 'sealed, not readable in storage');

  assert.deepEqual(await owner.engine.inbox(), [out.key]);
  const [waiting] = (await owner.engine.suggestions()).items;
  assert.equal(waiting.member, mai.keys!.id);
  const s = waiting.suggestion!;
  assert.equal(s.device, 'Mai');
  assert.deepEqual(s.files.map((f) => [f.path, f.text, !!f.base]), [['new.md', 'a new note\n', false], ['plan.md', 'one\ntwo, with Mai’s words\nthree\n', true]]);
  // The version it was based on is the one Mai's device synced, which the owner's device can read.
  const base = s.files.find((f) => f.path === 'plan.md')!.base!;
  assert.equal(new TextDecoder().decode(await owner.engine.readVersion(base)), 'one\ntwo\nthree\n');

  // Another member can neither open it nor list it as the owner does.
  const lan = await writer('Lan');
  await lan.sync();
  await assert.rejects(lan.engine.suggestions(), /Only the owner/);
  await assert.rejects(openSuggestion(keys.repo, fromB64(lan.keys!.secret!), out.key!, raw), /damaged, or was not made by the member it names/);
  // Under another member's key, the same suggestion opens as nobody's.
  const forged = inboxKey(lan.keys!.id, 5);
  await net.put(forged, raw);
  const all = (await owner.engine.suggestions()).items;
  assert.deepEqual(all.map((w) => [w.key, !!w.suggestion]), [[out.key, true], [forged, false]]);
});

test('the same text is not sent twice, and what is too large or not text is said, not sent', async () => {
  const { mai, unsent, mem } = await readerWithChange();
  const first = await mai.engine.sendSuggestion(unsent);
  const sent = new Map(first.sent.map((f) => [f.path, f.sum]));
  mai.clock.now += 1000;
  const again = await mai.engine.sendSuggestion(unsent, sent);
  assert.equal(again.key, undefined, 'nothing new: nothing written');
  assert.deepEqual(again.skipped.filter((x) => x.why === 'sent').map((x) => x.path), ['new.md', 'plan.md']);
  mai.fs.put('plan.md', 'changed again\n');
  mai.fs.put('huge.md', 'x'.repeat(SUGGEST_MAX_FILE + 1));
  mai.fs.put('bytes.md', new Uint8Array([0xff, 0xfe, 0x00]));
  const third = await mai.engine.sendSuggestion([...unsent, 'huge.md', 'bytes.md', 'gone.md'], sent);
  assert.deepEqual(third.sent.map((f) => f.path), ['plan.md']);
  assert.deepEqual(third.skipped, [
    { path: 'bytes.md', why: 'binary' },
    { path: 'gone.md', why: 'gone' },
    { path: 'huge.md', why: 'large' },
    { path: 'new.md', why: 'sent' },
    { path: 'photo.png', why: 'kind' },
  ]);
  assert.equal((await inboxObjects(mem)).length, 2);
});

test('storage that refuses the write says so, and nothing else is written', async () => {
  const { mai, mem } = await readerWithChange();
  const store = mai.store;
  const refusing: RemoteStore = {
    get: (k, r) => store.get(k, r),
    list: (p, a) => store.list(p, a),
    delete: (k, o) => store.delete(k, o),
    put: (k, d, o) => (k.startsWith(INBOX) ? Promise.reject(new Error(`S3 PUT ${k} failed with HTTP 403 (AccessDenied)`)) : store.put(k, d, o)),
  };
  mai.store = refusing;
  mai.restart();
  await mai.sync();
  await assert.rejects(mai.engine.sendSuggestion(['plan.md']), /HTTP 403/);
  assert.deepEqual(await inboxObjects(mem), []);
});

test('the owner takes files out of a suggestion one by one, and the suggestion goes once none is left', async () => {
  const { owner, mai, mem, unsent, keys } = await readerWithChange();
  const { key } = await mai.engine.sendSuggestion(unsent);
  await owner.engine.settleSuggestion(key!, 'plan.md');
  const [left] = (await owner.engine.suggestions()).items;
  assert.deepEqual(left.suggestion!.files.map((f) => f.path), ['new.md']);
  // Still sealed for Mai: her device could have made it, and only the owner's can open it.
  const raw = (await mem.get(key!))!;
  const secret = await memberSecret(fromB64(owner.keys!.root!), mai.keys!.id);
  assert.equal((await openSuggestion(keys.repo, secret, key!, raw)).device, 'Mai');
  await owner.engine.settleSuggestion(key!, 'not-in-it.md');
  await owner.engine.settleSuggestion(key!, 'new.md');
  assert.deepEqual(await inboxObjects(mem), []);
  await owner.engine.settleSuggestion(key!, 'new.md');

  mai.clock.now += 1000;
  const second = await mai.engine.sendSuggestion(unsent);
  await assert.rejects(mai.engine.dismissSuggestion(second.key!), /Only the owner/);
  await owner.engine.dismissSuggestion(second.key!);
  assert.deepEqual(await inboxObjects(mem), []);
});

test('a suggestion from a member removed since, or damaged, opens as nobody’s', async () => {
  const { owner, mai, net, unsent, keys } = await readerWithChange();
  const { key } = await mai.engine.sendSuggestion(unsent);
  await net.put(`${INBOX}${mai.keys!.id}-7`, new Uint8Array([1, 2, 3]));
  await net.put(`${INBOX}not a suggestion`, new Uint8Array([1]));
  await net.put(`${INBOX}deeper/${mai.keys!.id}-8`, new Uint8Array([1]));
  const ids = (await owner.engine.members()).map((m) => m.id);
  await owner.engine.removeMember(ids.find((id) => id === mai.keys!.id)!);
  const all = (await owner.engine.suggestions()).items;
  assert.deepEqual(all.map((w) => [w.key, w.member ?? '', !!w.suggestion]), [
    [key, mai.keys!.id, false],
    [`${INBOX}${mai.keys!.id}-7`, mai.keys!.id, false],
    [`${INBOX}not a suggestion`, '', false],
  ]);
  assert.deepEqual(await owner.engine.inbox(), [key, `${INBOX}${mai.keys!.id}-7`], 'only keys that name a member and a time count');
  // Whatever is listed can be dismissed, and nothing else.
  await owner.engine.dismissSuggestion(`${INBOX}not a suggestion`);
  await assert.rejects(owner.engine.dismissSuggestion(`${INBOX}deeper/${mai.keys!.id}-8`), /not a suggestion/);
  await assert.rejects(owner.engine.dismissSuggestion('log/000000000001'), /not a suggestion/);
  assert.deepEqual((await owner.engine.suggestions()).items.map((w) => w.key), [key, `${INBOX}${mai.keys!.id}-7`]);

  // A sealed suggestion that holds a path out of the folder, or a kind no suggestion carries, does not open.
  const secret = await memberSecret(fromB64(owner.keys!.root!), mai.keys!.id);
  for (const path of ['../escape.md', 'a//b.md', 'photo.png']) {
    const k = inboxKey(mai.keys!.id, 9);
    const sealed = await sealSuggestion(keys.repo, secret, { key: k, member: mai.keys!.id, time: 9, device: 'x', files: [{ path, text: 'x' }] });
    await assert.rejects(openSuggestion(keys.repo, secret, k, sealed), /damaged/);
  }
});

test('an object in the inbox too large to be a suggestion is listed for dismissing, without being downloaded', async () => {
  const { owner, mai, net, mem, unsent } = await readerWithChange();
  const key = (await mai.engine.sendSuggestion(unsent)).key!;
  const huge = `${INBOX}${mai.keys!.id}-7`;
  await mem.put(huge, new Uint8Array(MAX_SEALED + 1));
  net.reset();
  const all = (await owner.engine.suggestions()).items;
  assert.deepEqual(all.map((w) => [w.key, !!w.suggestion]), [[key, true], [huge, false]]);
  assert.ok(net.stats.down < MAX_SEALED / 4, `downloaded ${net.stats.down} bytes`);
  // One that grew after it was listed is downloaded only as far as a suggestion goes, and does not open.
  await mem.put(key, new Uint8Array(3 * MAX_SEALED));
  net.reset();
  await assert.rejects(owner.engine.settleSuggestion(key, 'plan.md'), /damaged/);
  assert.ok(net.stats.down <= MAX_SEALED + 1, `downloaded ${net.stats.down} bytes`);
  await owner.engine.dismissSuggestion(huge);
  assert.deepEqual(await owner.engine.inbox(), [key]);
});

test('the owner’s device opens only the newest suggestions, says how many more wait, and shows the rest once those are dealt with', async () => {
  const { owner, mai, mem, unsent } = await readerWithChange();
  const first = (await mai.engine.sendSuggestion(unsent)).key!;
  // A member who may add to the inbox fills it with copies under newer keys, which do not open.
  const raw = (await mem.get(first))!;
  const flood = Array.from({ length: INBOX_OPENED + 9 }, (_, i) => inboxKey(mai.keys!.id, mai.clock.now + 1 + i));
  for (const key of flood) await mem.put(key, raw);

  const store = owner.store;
  const fetched: string[] = [];
  owner.store = {
    get: (k, r) => {
      if (k.startsWith(INBOX)) fetched.push(k);
      return store.get(k, r);
    },
    put: (k, d, o) => store.put(k, d, o),
    list: (p, a) => store.list(p, a),
    delete: (k, o) => store.delete(k, o),
  };
  owner.restart();
  const { items, more } = await owner.engine.suggestions();
  assert.equal(items.length, INBOX_OPENED);
  assert.equal(more, 10);
  assert.equal(items.length + more, (await owner.engine.inbox()).length, 'the count on the share’s row is all of them');
  assert.deepEqual(items.map((w) => w.key), flood.slice(-INBOX_OPENED).reverse(), 'the newest, newest first');
  assert.equal(fetched.length, INBOX_OPENED, 'only those are downloaded');
  assert.ok(!items.some((w) => w.key === first));

  // Once the owner dismissed the ones shown, the rest show, the real one among them.
  for (const w of items) await owner.engine.dismissSuggestion(w.key);
  const rest = await owner.engine.suggestions();
  assert.equal(rest.more, 0);
  assert.equal(rest.items.length, 10);
  assert.equal(rest.items.at(-1)!.key, first);
  assert.equal(rest.items.at(-1)!.suggestion?.device, 'Mai');
});

test('a suggestion key names its member and time, whatever the member id holds', () => {
  assert.deepEqual(parseInboxKey('inbox/abc-def_ghij-1234-1800000000000'), { member: 'abc-def_ghij-1234', time: 1800000000000 });
  assert.equal(parseInboxKey('inbox/short-12'), undefined);
  assert.equal(parseInboxKey('inbox/abcdefghij-'), undefined);
  assert.equal(parseInboxKey('join/abcdefghij-12'), undefined);
  assert.equal(inboxKey('abcdefghij', 5), 'inbox/abcdefghij-5');
});

test('a sync reports the changes other devices made since the last one, by member, and never on a first download', async () => {
  const { owner, writer, join, clock } = await memberShare();
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  const lan = await writer('Lan');
  assert.deepEqual((await lan.sync()).arrived, [], 'a first download is not news');
  lan.fs.put('a.md', 'a, by Lan\n');
  lan.fs.put('b.md', 'b\n');
  await lan.sync();
  lan.fs.put('c.md', 'c\n');
  await lan.sync();
  // Read by another feature first: the next sync still reports it.
  await owner.engine.view();
  clock.now += 1000;
  const r = await owner.sync();
  assert.deepEqual(r.arrived.map((a) => [a.signer, a.name, a.device, a.paths]), [
    [lan.keys!.id, 'Lan', 'Lan', ['a.md', 'b.md']],
    [lan.keys!.id, 'Lan', 'Lan', ['c.md']],
  ]);
  assert.deepEqual((await owner.sync()).arrived, [], 'each change is reported once');
  owner.fs.put('d.md', 'd\n');
  await owner.sync();
  const mai = await join('Mai', 'read');
  await mai.sync();
  lan.fs.put('e.md', 'e\n');
  await lan.sync();
  const got = await mai.sync();
  assert.deepEqual(got.arrived.map((a) => a.paths), [['e.md']], 'member changes and the owner’s own are not files arriving');
  const own = await lan.sync();
  assert.deepEqual(own.arrived, [], 'a device’s own changes never arrive');
});

test('a suggestion whose reply is lost is kept once', async () => {
  let l!: ReturnType<typeof lossy>;
  const { owner, join, mem } = await memberShare({}, (net) => (l = lossy(net)).store);
  owner.fs.put('plan.md', 'one\n');
  await owner.sync();
  const mai = await join('Mai', 'read');
  await mai.sync();
  mai.fs.put('plan.md', 'one, by Mai\n');
  const { unsent } = await mai.sync();
  l.lose((key) => key.startsWith(INBOX));
  const out = await mai.engine.sendSuggestion(unsent);
  assert.ok(!l.armed, 'the reply was lost');
  assert.deepEqual(await inboxObjects(mem), [out.key]);
  assert.equal((await owner.engine.suggestions()).items.length, 1);
});
