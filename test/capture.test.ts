import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPTURE_PREFIX, captureProblem, decodeCaptureKey, encodeCaptureKey, numbered, sendCapture, type CaptureKey } from '../src/core/capture.ts';
import { joinShare } from '../src/core/membership.ts';
import { keyPolicy } from '../src/core/policy.ts';
import { LocalState } from '../src/core/state.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { memberShare } from './helpers.ts';

/** Storage as a key that may only add to the inbox sees it: every other request is refused, as a provider refuses it. */
function inboxOnly(inner: RemoteStore): RemoteStore & { calls: string[] } {
  const calls: string[] = [];
  const refuse = (what: string) => {
    calls.push(what);
    return Promise.reject(new Error(`403 ${what}`));
  };
  return {
    calls,
    get: (key) => refuse(`get ${key}`),
    list: (prefix) => refuse(`list ${prefix}`),
    delete: (key) => refuse(`delete ${key}`),
    put: (key, data, opts) => {
      if (!key.startsWith('inbox/')) return refuse(`put ${key}`);
      calls.push(`put ${key}`);
      return inner.put(key, data, opts);
    },
  };
}

async function setup() {
  const s = await memberShare();
  s.owner.fs.put('note.md', 'the owner’s note\n');
  await s.owner.sync();
  const grant = await s.owner.engine.invite({ name: 'Clipper', role: 'read', expires: 0, capture: true });
  const key: CaptureKey = decodeCaptureKey(encodeCaptureKey({ repo: grant.repo, member: grant.member, secret: grant.secret, storage: { bucket: 'b' }, share: 'Family' }));
  return { ...s, grant, key };
}

test('a send-only key adds a note with one write to the inbox and nothing else, and the owner’s device finds it', async () => {
  const { owner, store, key, clock } = await setup();
  const limited = inboxOnly(store);
  const at = await sendCapture(limited, key, [{ path: 'Ideas/call the dentist.md', text: 'Call the dentist\n' }], 'server', clock.now);
  assert.deepEqual(limited.calls, [`put ${at}`], 'no read, no listing');
  assert.match(at, new RegExp(`^inbox/${key.member}-\\d+$`));

  const waiting = await owner.engine.suggestions();
  assert.equal(waiting.items.length, 1);
  const [item] = waiting.items;
  assert.equal(item.name, 'Clipper');
  assert.deepEqual(item.suggestion?.files, [{ path: 'Ideas/call the dentist.md', text: 'Call the dentist\n' }]);
  assert.equal(item.suggestion?.device, 'server');

  const again = await sendCapture(limited, key, [{ path: 'Ideas/call the dentist.md', text: 'Call the dentist\n' }], 'server', clock.now);
  assert.notEqual(again, at, 'sent in the same millisecond, it takes another place and replaces nothing');
  assert.equal((await owner.engine.suggestions()).items.length, 2);
});

test('the key reads nothing: no invite was opened for it, so it unwraps no master key, with full access to storage too', async () => {
  const { owner, store, mem, grant, key, clock } = await setup();
  assert.ok(![...mem.objects.keys()].some((k) => k.startsWith('slot/') && k.includes(key.member)), 'no slot is stored for it');
  await assert.rejects(joinShare(store, { ...grant, storage: {}, share: 'Family', folder: 'Family' } as never, clock.now), /no longer opens the shared folder/);

  const members = await owner.engine.members();
  const m = members.find((x) => x.id === key.member)!;
  assert.deepEqual([m.name, m.role, m.capture, m.follow, m.suggest, m.state], ['Clipper', 'read', true, undefined, undefined, 'joined']);
});

test('the member list with a send-only key verifies for the other members, and a re-key hands that key nothing', async () => {
  const { owner, writer, mem, key } = await setup();
  const ann = await writer('Ann');
  ann.fs.put('ann.md', 'hi\n');
  assert.equal((await ann.sync()).errors.length, 0);
  assert.equal((await owner.sync()).pulled, 1);
  ann.restart();
  assert.equal((await ann.sync()).errors.length, 0, 'from its saved state too');

  await owner.engine.writeRekey({ write: { bucket: 'b2' } });
  assert.ok(![...mem.objects.keys()].includes(`rekey/${key.member}`), 'and no read or suggest key is asked for on its account');
});

test('once the key is removed, what it sends is not opened', async () => {
  const { owner, store, key, clock } = await setup();
  await owner.engine.removeMember(key.member);
  await sendCapture(inboxOnly(store), key, [{ path: 'late.md', text: 'late\n' }], 'server', clock.now);
  const [item] = (await owner.engine.suggestions()).items;
  assert.equal(item.name, undefined);
  assert.equal(item.suggestion, undefined);
});

test('a send-only key carries notes and canvases only, inside the folder, within the size a suggestion holds', async () => {
  const { store, key } = await setup();
  const send = (path: string, text = 'x') => sendCapture(inboxOnly(store), key, [{ path, text }], 'd');
  await assert.rejects(send('photo.png'), /not a note or a canvas/);
  await assert.rejects(send('../outside.md'), /not a path inside the shared folder/);
  await assert.rejects(send('a//b.md'), /not a path inside/);
  await assert.rejects(send('big.md', 'x'.repeat((1 << 20) + 1)), /over 1 MB/);
  await assert.rejects(sendCapture(inboxOnly(store), key, [], 'd'), /nothing to send/);
  await assert.rejects(sendCapture(inboxOnly(store), key, [{ path: 'a.md', text: '1' }, { path: 'a.md', text: '2' }], 'd'), /named twice/);
  assert.equal(captureProblem({ path: 'Board.canvas', text: '{}' }), '');
});

test('a key that was cut short, or is another kind of link, is refused with what it is', () => {
  const good = encodeCaptureKey({ repo: 'r', member: 'abcdefgh1234', secret: 'A'.repeat(43), storage: {}, share: 'S' });
  assert.ok(good.startsWith(CAPTURE_PREFIX));
  assert.equal(decodeCaptureKey(`  ${good}\n`).share, 'S');
  assert.throws(() => decodeCaptureKey('coffershare3.abc'), /not a send-only key/);
  assert.throws(() => decodeCaptureKey(good.slice(0, -9)), /damaged/);
  assert.throws(() => decodeCaptureKey(encodeCaptureKey({ repo: 'r', member: 'short', secret: 'A'.repeat(43), storage: {}, share: 'S' })), /damaged/);
});

test('the names tried for a note beside a file of its name keep its folder and extension', () => {
  assert.equal(numbered('idea.md', 1), 'idea.md');
  assert.equal(numbered('idea.md', 3), 'idea (3).md');
  assert.equal(numbered('Notes/a.b.md', 2), 'Notes/a.b (2).md');
  assert.equal(numbered('noext', 2), 'noext (2)');
  assert.equal(numbered('Notes/.hidden', 2), 'Notes/.hidden (2)');
});

test('more notes than one suggestion holds are refused before anything is sent', async () => {
  const { owner, store, key, clock } = await setup();
  const limited = inboxOnly(store);
  const notes = Array.from({ length: 501 }, (_, i) => ({ path: `n${i}.md`, text: 'x' }));
  await assert.rejects(sendCapture(limited, key, notes, 'server', clock.now), /501 notes: at most 500/);
  assert.deepEqual(limited.calls, []);
  await sendCapture(limited, key, notes.slice(1), 'server', clock.now);
  assert.equal((await owner.engine.suggestions()).items[0].suggestion?.files.length, 500);
});

test('the owner’s device can look at one key’s suggestions alone, leaving out ones it has seen', async () => {
  const { owner, store, net, key, clock } = await setup();
  const mai = await owner.engine.invite({ name: 'Mai', role: 'read', expires: 0, capture: true });
  const other: CaptureKey = { ...key, member: mai.member, secret: mai.secret };
  const a = await sendCapture(store, key, [{ path: 'a.md', text: 'a' }], 'server', clock.now);
  const b = await sendCapture(store, key, [{ path: 'b.md', text: 'b' }], 'server', clock.now + 10);
  await sendCapture(store, other, [{ path: 'c.md', text: 'c' }], 'server', clock.now);
  net.reset();
  const found = await owner.engine.suggestions({ members: new Set([key.member]), skip: new Set([a]) });
  const some = net.stats.get;
  assert.deepEqual(found.items.map((i) => i.key), [b]);
  assert.equal(found.more, 0);
  net.reset();
  assert.equal((await owner.engine.suggestions()).items.length, 3);
  assert.equal(net.stats.get - some, 2, 'the two left out were not downloaded');
});

test('a member list saved by a version before send-only keys shows the key as one after the update', async () => {
  const { owner, grant } = await setup();
  const saved = JSON.parse((await owner.state.load())!) as { m: { members: Record<string, unknown>[] }[] };
  for (const c of saved.m) for (const m of c.members) if (m.capture) Object.assign(m, { follow: true, suggest: true, capture: undefined });
  const st = LocalState.parse(JSON.stringify(saved));
  const m = st.members.at(-1)!.members.find((x) => x.id === grant.member)!;
  assert.deepEqual(m, { id: grant.member, name: 'Clipper', role: 'read', capture: true });
});

test('the storage rule for a send-only key allows adding to the inbox and nothing else, where the provider can', () => {
  const aws = keyPolicy({ provider: 'aws', bucket: 'my-notes', prefix: 'Family' }, 'inboxOnly');
  assert.equal(aws.possible, true);
  const put = { Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::my-notes/Family/inbox/*' };
  assert.deepEqual(JSON.parse(aws.text).Statement, [{ ...put, Condition: { Null: { 's3:if-none-match': 'false' } } }], 'at Amazon, only a write that replaces nothing');
  assert.match(aws.steps, /can not read, list, replace or delete anything/);
  const other = keyPolicy({ provider: 's3', bucket: 'my-notes', prefix: 'Family' }, 'inboxOnly');
  assert.equal(other.text, aws.text, 'the same rule for other S3 services');
  assert.match(other.steps, /If your service refuses this policy, or the key can not add to the inbox, take out the Condition part/);
  const b2 = keyPolicy({ provider: 'b2', bucket: 'my-notes', prefix: 'Family' }, 'inboxOnly');
  assert.equal(b2.possible, true);
  assert.match(b2.text, /Type of access: Write Only\nFile name prefix: Family\/inbox\//);
  for (const provider of ['r2', 'webdav'] as const) {
    const p = keyPolicy({ provider, bucket: 'b', prefix: 'Family' }, 'inboxOnly');
    assert.equal(p.possible, false);
    assert.match(p.steps, /still can not read any note/);
  }
});
