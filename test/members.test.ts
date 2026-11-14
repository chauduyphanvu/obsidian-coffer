import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WrongPassphraseError } from '../src/core/crypto.ts';
import { HistoryError, RemovedError, UnverifiedError } from '../src/core/engine.ts';
import {
  changeOf, decodeFollow, decodeInvite, encodeFollow, encodeInvite, MemberBook, openOwnerLink, ownerKeysFrom, ownerLinkFields, parseMemberKeys, sealOwnerLink,
} from '../src/core/members.ts';
import { joinShare, publishJoin } from '../src/core/membership.ts';
import { seqKey } from '../src/core/repo.ts';
import { listVersions } from '../src/core/retention.ts';
import { listActivity, listCommits, listDeleted, tableAt } from '../src/core/timeline.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { DAY, Device, memberShare, rawRepo } from './helpers.ts';

const states = async (d: Device) => (await d.engine.members()).map((m) => [m.name, m.role, m.state]);

test('the owner, a write member and a read member sync a member share, and only signed changes are stored', async () => {
  const { owner, join, clock, keys, net } = await memberShare();
  owner.fs.put('plan.md', 'v1\n');
  await owner.sync();
  const lan = await join('Lan', 'write');
  const mai = await join('Mai', 'read');
  await lan.sync();
  assert.equal(lan.fs.text('plan.md'), 'v1\n');
  assert.deepEqual(await lan.engine.memberStanding(), { role: 'write', mayWrite: false, waiting: true, removed: false, owner: 'Vu' });
  lan.fs.put('lan.md', 'from lan\n');
  assert.deepEqual((await lan.sync()).unsent, ['lan.md'], 'nothing is sent before the owner confirms the join');
  assert.deepEqual(await states(owner), [['Vu', 'owner', 'joined'], ['Lan', 'write', 'confirming'], ['Mai', 'read', 'waiting']]);

  // The owner's next sync confirms it.
  clock.now += 60_000;
  await owner.sync();
  assert.deepEqual(await states(owner), [['Vu', 'owner', 'joined'], ['Lan', 'write', 'joined'], ['Mai', 'read', 'waiting']]);
  assert.equal((await lan.sync()).pushed, 1);
  assert.equal((await lan.engine.memberStanding())!.mayWrite, true);
  await owner.sync();
  assert.equal(owner.fs.text('lan.md'), 'from lan\n');
  await mai.sync();
  assert.deepEqual(mai.snapshot(), owner.snapshot());
  assert.deepEqual(await mai.engine.memberStanding(), { role: 'read', mayWrite: false, waiting: false, removed: false, owner: 'Vu' });
  mai.fs.put('plan.md', 'mai edit\n');
  assert.deepEqual((await mai.sync()).unsent, ['plan.md']);

  const raw = await rawRepo(net, keys);
  const seqs = await raw.commitSeqsAfter(0);
  for (const seq of seqs) {
    const c = (await raw.readCommit(seq))!;
    assert.ok(c.signer && c.sig, `commit ${seq} is signed`);
  }
  assert.deepEqual((await owner.engine.verify({ deep: true })).problems, []);
  assert.deepEqual((await mai.engine.verify({ deep: true })).problems, []);
  const lanRow = (await owner.engine.members()).find((m) => m.name === 'Lan')!;
  assert.equal(lanRow.lastChange, clock.now);
});

test('one invite adds one device: a write invite closes once confirmed, a read invite when it expires', async () => {
  const { owner, invite, net, clock } = await memberShare();
  await owner.sync();
  const link = await invite('Lan', 'write');
  await publishJoin(net, await joinShare(net, link, clock.now));
  await assert.rejects(joinShare(net, link, clock.now), /already used/);
  assert.deepEqual(await owner.engine.confirmJoins(), [link.member]);
  assert.deepEqual(await owner.engine.confirmJoins(), []);
  await assert.rejects(joinShare(net, link, clock.now), /no longer opens/);

  const read = await invite('Mai', 'read', clock.now + DAY);
  await joinShare(net, read, clock.now);
  await joinShare(net, read, clock.now + 1000);
  clock.now += 2 * DAY;
  await assert.rejects(joinShare(net, read, clock.now), /expired/);
  assert.deepEqual((await owner.engine.members()).find((m) => m.name === 'Mai')?.state, 'expired');
  await owner.sync();
  assert.equal(await net.get(`slot/${read.member}`), null, 'the owner’s device removes an expired invite');
});

test('a removed member’s device stops by itself, and what it changed before stays valid for every device', async () => {
  const { owner, writer, join } = await memberShare();
  await owner.sync();
  const lan = await writer('Lan');
  lan.fs.put('lan.md', 'by lan\n');
  await lan.sync();
  await owner.engine.removeMember(lan.keys!.id);
  await assert.rejects(owner.engine.removeMember(lan.keys!.id), /no such member/);
  await assert.rejects(lan.sync(), RemovedError);
  assert.equal((await lan.engine.memberStanding())!.removed, true);
  lan.fs.put('lan.md', 'after removal\n');
  await assert.rejects(lan.sync(), RemovedError);

  const ann = await join('Ann', 'read');
  await ann.sync();
  assert.equal(ann.fs.text('lan.md'), 'by lan\n');
  assert.deepEqual((await owner.engine.members()).map((m) => m.name), ['Vu', 'Ann']);
  assert.deepEqual((await ann.engine.verify()).problems, []);
  // The owner's device, which saw the removal happen, finds the log whole too, and so does its history.
  owner.restart();
  await owner.sync();
  assert.deepEqual((await owner.engine.verify()).problems, []);
  assert.equal((await owner.engine.history('lan.md')).length, 1);
});

/**
 * Lan (write) adds lan.md and deletes old.md, then is removed; Ann (write) joins after that. Both devices end behind the
 * member list they accepted: a sync that brings in only member changes saves that list at once but not the sync state,
 * so after a restart each reads the log by an older state than its list.
 */
async function removedThenJoined() {
  const share = await memberShare();
  const { owner, writer, join, mem } = share;
  owner.fs.put('old.md', 'old\n');
  await owner.sync();
  const lan = await writer('Lan');
  await lan.sync();
  lan.fs.put('lan.md', 'by lan\n');
  lan.fs.files.delete('old.md');
  await lan.sync();
  await owner.sync();
  const beforeRemoval = new Map(mem.objects);
  await owner.engine.removeMember(lan.keys!.id);
  await assert.rejects(lan.sync(), RemovedError);
  const ann = await join('Ann', 'write');
  await ann.sync();
  await owner.engine.confirmJoins();
  await ann.sync();
  const seqIn = (s: Device['state']) => (JSON.parse(s.data!) as { seq: number }).seq;
  for (const d of [ann, lan]) assert.ok(seqIn(d.state) < seqIn(d.position), `${d.name}'s device is behind its member list`);
  return { ...share, lan, ann, beforeRemoval };
}

test('verify and repair find a removed member’s earlier commits valid after a restart, on a device that joined after the removal and on the removed one', async () => {
  const { lan, ann, mem, net, keys, clock, beforeRemoval } = await removedThenJoined();
  for (const d of [ann, lan]) {
    for (const deep of [false, true]) {
      d.restart();
      assert.deepEqual((await d.engine.verify({ deep })).problems, [], `${d.name}, deep ${deep}`);
      d.restart();
      assert.deepEqual(await d.engine.repair({ deep }), { repaired: [], unrepaired: [], historyOnly: [], chunks: 0 }, `${d.name}, deep ${deep}`);
    }
  }

  // Storage really put back to before the removal, and Lan writing on under the list that still names her: a device
  // behind the list it accepted finds storage no longer holds that list's change, and refuses her commit.
  const now = mem.objects;
  mem.objects = new Map(beforeRemoval);
  const raw = await rawRepo(net, keys);
  const seqs = await raw.commitSeqsAfter(0);
  const log = await Promise.all(seqs.map(async (s) => (await raw.readCommit(s))!));
  const changes = log.filter((c) => c.members).map((c) => changeOf(c));
  raw.useMembers(new MemberBook(raw.id, { owner: keys.owner, id: lan.keys!.id, key: lan.keys!.key }), () => ({ changes, through: seqs.at(-1)! }));
  const forged = seqs.at(-1)! + 1;
  assert.ok(await raw.writeCommit({ seq: forged, device: 'Lan', time: clock.now, changes: [{ path: 'old.md', entry: { size: 0, mtime: 1, chunks: [] } }], prev: log.at(-1)!.hash }));
  for (const d of [ann, lan]) {
    d.restart();
    const { problems } = await d.engine.verify();
    assert.ok(problems.some((p) => p.object === seqKey('log', forged) && /may not write/.test(p.message)), `${d.name}: ${JSON.stringify(problems)}`);
  }
  mem.objects = now;

  // Data lost from storage is the only problem reported, and the device that joined after the removal stores it again.
  ann.restart();
  const pack = `pack/${(await ann.engine.view()).st.remote.get('lan.md')!.chunks[0].pack}`;
  mem.objects.delete(pack);
  ann.restart();
  assert.deepEqual((await ann.engine.verify()).problems.map((p) => p.object), [pack]);
  ann.restart();
  assert.deepEqual((await ann.engine.repair({ deep: true })).repaired, ['lan.md']);
  for (const d of [ann, lan]) {
    d.restart();
    assert.deepEqual((await d.engine.verify({ deep: true })).problems, [], d.name);
  }
});

test('history, restore, activity and cleanup read a removed member’s earlier commits on devices restarted behind their member list', async () => {
  const { ann, lan } = await removedThenJoined();
  for (const d of [ann, lan]) {
    // Each read is the first after a restart, as on the command line, through what the plugin and the CLI read by.
    const look = async () => {
      d.restart();
      return d.engine.view();
    };
    d.restart();
    const versions = await d.engine.history('lan.md');
    assert.deepEqual(versions.map((v) => v.device), ['Lan'], d.name);
    const by = versions[0].seq;
    d.restart();
    assert.equal(new TextDecoder().decode(await d.engine.readVersion(versions[0].entry!)), 'by lan\n');
    let v = await look();
    assert.deepEqual((await listVersions(v.repo, v.st.lastSeq, 'lan.md', v.cfg, v.now)).map((x) => x.seq), [by], d.name);
    v = await look();
    assert.deepEqual([...(await tableAt(v.repo, v.st.remote, v.st.lastSeq, v.cfg, v.now, { seq: by })).files.keys()], ['lan.md'], d.name);
    v = await look();
    assert.ok((await listCommits(v.repo, v.st.lastSeq, v.cfg, v.now)).some((c) => c.seq === by), d.name);
    v = await look();
    assert.deepEqual((await listDeleted(v.repo, v.st.lastSeq, v.cfg, v.now)).map((f) => [f.path, f.device]), [['old.md', 'Lan']], d.name);
    v = await look();
    assert.equal((await listActivity(v.repo, v.st.lastSeq, v.cfg)).items.find((a) => a.seq === by)?.signer, lan.keys!.id, d.name);
    d.restart();
    await d.engine.gc();
  }
});

test('a new device starts from a snapshot it verified, and learns every earlier member change from it', async () => {
  const { owner, writer, invite, mem, clock } = await memberShare({ snapshotEvery: 5 });
  const lan = await writer('Lan');
  for (let i = 0; i < 14; i++) {
    const d = i % 2 ? owner : lan;
    d.fs.put(`n${i}.md`, `note ${i}\n`);
    await d.sync();
  }
  await owner.sync();
  const link = await invite('Ann', 'read');
  const got: string[] = [];
  const spy: RemoteStore = { ...mem, get: (key, range) => (got.push(key), mem.get(key, range)), put: mem.put.bind(mem), delete: mem.delete.bind(mem), list: mem.list.bind(mem) };
  const ann = new Device('Ann', spy, clock, { snapshotEvery: 5, readOnly: true }, await joinShare(spy, link, clock.now));
  await ann.sync();
  assert.deepEqual(ann.snapshot(), owner.snapshot());
  const commits = got.filter((k) => k.startsWith('log/')).map((k) => Number(k.slice(4)));
  // Commits 2 and 3 invited and confirmed Lan: member changes, read to know the lists before the snapshot.
  assert.ok(!commits.includes(4) && !commits.includes(9), `read commits ${commits.join(', ')}`);
  assert.ok(commits.includes(2) && commits.includes(3));
  // History before the snapshot is checked against those lists.
  assert.equal((await ann.engine.history('n0.md')).length, 1);
});

test('a digest whose commits are not all signed is not used, and is written again with the signatures', async () => {
  const { owner, keys, net } = await memberShare({ snapshotEvery: 5 });
  for (let i = 0; i < 6; i++) {
    owner.fs.put('a.md', `v${i}\n`);
    await owner.sync();
  }
  const raw = await rawRepo(net, keys);
  const commits = await Promise.all([1, 2, 3, 4, 5].map(async (s) => ({ ...(await raw.readCommit(s))!, signer: undefined, sig: undefined, listSeq: undefined })));
  await raw.writeDigest(5, commits);
  assert.ok((await raw.loadDigest(5, 5)).commits!.every((c) => !c.sig));
  assert.equal((await owner.engine.history('a.md')).length, 6);
  const again = (await raw.loadDigest(5, 5)).commits!;
  assert.ok(again.every((c) => c.signer && c.sig), 'written again from the signed commits');
});

test('cleanup on a member share records how far it went, signed, and every member reads that record', async () => {
  const { owner, writer, clock } = await memberShare({ snapshotEvery: 5, retentionDays: 1 });
  const lan = await writer('Lan', { config: { snapshotEvery: 5, retentionDays: 1 } });
  for (let i = 0; i < 8; i++) {
    owner.fs.put('big.bin', new Uint8Array(30_000).fill(i + 1));
    await owner.sync();
  }
  clock.now += 3 * DAY;
  for (let i = 0; i < 6; i++) {
    owner.fs.put('n.md', `${i}\n`);
    await owner.sync();
  }
  const gc = await owner.engine.gc();
  assert.ok(gc.packsDeleted > 0, `deleted ${gc.packsDeleted} packs`);
  const floor = await (await owner.engine.view()).repo.prunedTo();
  assert.ok(floor > 0);
  assert.equal(await (await lan.engine.view()).repo.prunedTo(), floor);
  await lan.sync();
  assert.deepEqual(lan.snapshot(), owner.snapshot());
  assert.deepEqual((await lan.engine.verify()).problems, []);
  assert.equal((await lan.engine.gc()).packsDeleted, 0, 'a writer cleans up too, and finds nothing more');
});

test('verify and repair work on a member share: data stored again goes in a signed move commit', async () => {
  const { owner, writer, mem } = await memberShare();
  const lan = await writer('Lan');
  owner.fs.put('a.md', 'aaa\n'.repeat(100));
  await owner.sync();
  await lan.sync();
  assert.deepEqual((await lan.engine.verify({ deep: true })).problems, []);
  const pack = [...mem.objects.keys()].find((k) => k.startsWith('pack/'))!;
  mem.objects.delete(pack);
  assert.ok((await lan.engine.verify()).problems.some((p) => p.object === pack));
  const r = await lan.engine.repair();
  assert.deepEqual(r.repaired, ['a.md']);
  await owner.sync();
  assert.deepEqual((await owner.engine.verify({ deep: true })).problems, []);
});

test('an owner link sets up another of the owner’s devices, which writes and invites like the first', async () => {
  const { owner, keys, net, clock } = await memberShare();
  owner.fs.put('a.md', 'x\n');
  await owner.sync();
  const code = await sealOwnerLink({ storageType: 's3', bucket: 'b', ...ownerLinkFields(keys) }, 'owner passphrase', 1000);
  assert.ok(code.startsWith('coffershare2.'));
  await assert.rejects(openOwnerLink(code, 'wrong passphrase'), WrongPassphraseError);
  const payload = await openOwnerLink(code, 'owner passphrase');
  assert.equal(payload.bucket, 'b');
  const opened = ownerKeysFrom(payload)!;
  assert.deepEqual(opened, keys);
  assert.equal(ownerKeysFrom({ bucket: 'b' }), undefined, 'an invite of the older kind');
  assert.deepEqual(parseMemberKeys(JSON.stringify(keys)), keys);
  assert.throws(() => ownerLinkFields({ ...keys, root: undefined }), /owner/);

  const phone = new Device('phone', net, clock, {}, opened);
  await phone.sync();
  assert.equal(phone.fs.text('a.md'), 'x\n');
  phone.fs.put('b.md', 'y\n');
  await phone.sync();
  await owner.sync();
  assert.equal(owner.fs.text('b.md'), 'y\n');
  const grant = await phone.engine.invite({ name: 'Lan', role: 'read', expires: 0 });
  assert.ok(grant.since > 1);
  await phone.engine.changePassphrase('a new owner passphrase');
  assert.ok(ownerKeysFrom(await openOwnerLink(await sealOwnerLink(ownerLinkFields(keys), 'a new owner passphrase', 1000), 'a new owner passphrase')));
});

test('invite and follow links carry what joining needs, and anything else is refused', async () => {
  const { owner } = await memberShare();
  const grant = await owner.engine.invite({ name: 'Lan', role: 'write', expires: 0 });
  const invite = { ...grant, storage: { bucket: 'b', secretKey: 's' }, share: 'Family', folder: 'Family' };
  const link = encodeInvite(invite);
  assert.ok(link.startsWith('coffershare3.') && !/[+/=]/.test(link));
  assert.deepEqual(decodeInvite(`  ${link}\n`), invite);
  assert.ok(!link.includes('"d"'), 'no private key');
  assert.throws(() => decodeInvite(link.slice(0, -10)), /not an invite link|cut short|damaged/);
  assert.throws(() => decodeInvite('coffershare2.abc'), /not an invite link/);
  assert.throws(() => decodeInvite(encodeInvite({ ...invite, role: 'admin' as 'write' })), /damaged/);
  assert.throws(() => decodeInvite(encodeInvite({ ...invite, owner: 'AAAA' })), /damaged/);
  const follow = { ...grant, url: 'https://example.com/family', share: 'Family', folder: 'Family' };
  const { role: _, ...expected } = follow;
  assert.deepEqual(decodeFollow(encodeFollow(follow)), expected);
  assert.throws(() => decodeFollow(encodeFollow({ ...follow, url: 'ftp://x' })), /damaged/);
  assert.throws(() => decodeFollow(link), /not a follow link/);
});

test('a follower reads a member share from storage that cannot list: from the snapshot hint, then commit by commit', async () => {
  const { owner, mem, clock } = await memberShare({ snapshotEvery: 5 });
  for (let i = 0; i < 8; i++) {
    owner.fs.put(`n${i}.md`, `${i}\n`);
    await owner.sync();
  }
  const grant = await owner.engine.invite({ name: 'Web', role: 'read', expires: 0 });
  const link = decodeFollow(encodeFollow({ ...grant, url: 'https://example.com/family', share: 'Family', folder: 'Family' }));
  let lists = 0;
  const refuse = () => Promise.reject(new Error('read only'));
  const publicCopy: RemoteStore = {
    noList: true,
    get: (key, range) => mem.get(key, range),
    put: refuse,
    delete: refuse,
    list: () => {
      lists++;
      return Promise.reject(new Error('cannot list'));
    },
  };
  assert.ok(mem.objects.has('follow'));
  const web = new Device('web', publicCopy, clock, { snapshotEvery: 5, readOnly: true }, await joinShare(publicCopy, link, clock.now));
  await web.sync();
  assert.deepEqual(web.snapshot(), owner.snapshot());
  owner.fs.put('late.md', 'late\n');
  await owner.sync();
  await web.sync();
  assert.equal(web.fs.text('late.md'), 'late\n');
  assert.equal(lists, 0);
  assert.deepEqual((await web.engine.history('n0.md')).length, 1);
});

test('re-key hands each member the keys for its role, signed and numbered, and a device takes only newer ones', async () => {
  const { owner, writer, join, keys, net, clock } = await memberShare();
  await owner.sync();
  const lan = await writer('Lan');
  const mai = await join('Mai', 'read');
  await assert.rejects(owner.engine.writeRekey({ write: { secretKey: 'w2' } }), /read-only key/);
  await assert.rejects(lan.engine.writeRekey({ write: { secretKey: 'w2' }, read: { secretKey: 'r2' } }), /owner/);
  const n = await owner.engine.writeRekey({ write: { secretKey: 'w2' }, read: { secretKey: 'r2' } });
  assert.deepEqual(await lan.engine.rekeyOffer(), { n, storage: { secretKey: 'w2' } });
  assert.deepEqual(await mai.engine.rekeyOffer(), { n, storage: { secretKey: 'r2' } });
  assert.equal(await owner.engine.rekeyOffer(), null, 'the device that wrote them has them');
  const phone = new Device('phone', net, clock, {}, keys);
  assert.deepEqual(await phone.engine.rekeyOffer(), { n, storage: { secretKey: 'w2' } }, 'the owner’s other devices get them too');
  // Until a device has tested and switched, it is offered them again.
  assert.deepEqual(await lan.engine.rekeyOffer(), { n, storage: { secretKey: 'w2' } });
  await lan.engine.acceptRekey(n);
  assert.equal(await lan.engine.rekeyOffer(), null);
  lan.restart();
  assert.equal(await lan.engine.rekeyOffer(), null, 'kept with the member list, apart from the sync state');
  const n2 = await owner.engine.writeRekey({ write: { secretKey: 'w3' }, read: { secretKey: 'r3' } });
  assert.ok(n2 > n);
  assert.deepEqual(await lan.engine.rekeyOffer(), { n: n2, storage: { secretKey: 'w3' } });
});

test('after storage is restored from a backup, devices accept it, keep the member list they had, and the owner puts it back', async () => {
  const { owner, writer, invite, mem, clock } = await memberShare();
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  const lan = await writer('Lan');
  await lan.sync();
  const backup = new Map(mem.objects);
  const ann = await invite('Ann', 'read');
  await lan.sync();
  const annCount = (await lan.engine.members()).length;
  assert.equal(annCount, 3);
  mem.objects = new Map(backup);
  clock.now += 2 * 3_600_000;
  await assert.rejects(owner.sync(), HistoryError);
  await owner.engine.acceptStorage();
  await owner.sync();
  assert.deepEqual((await owner.engine.members()).map((m) => m.name), ['Vu', 'Lan', 'Ann'], 'the owner put the list back');
  await assert.rejects(lan.sync(), HistoryError);
  await lan.engine.acceptStorage();
  await lan.sync();
  assert.deepEqual((await lan.engine.members()).map((m) => m.name), ['Vu', 'Lan', 'Ann']);
  assert.ok(ann.member);
  lan.fs.put('b.md', 'b\n');
  await lan.sync();
  await owner.sync();
  assert.equal(owner.fs.text('b.md'), 'b\n');
});

test('storage put back from a backup holding changes a member made before her removal: the owner keeps them and the changes made after them', async () => {
  const { owner, writer, mem, clock } = await memberShare();
  const lan = await writer('Lan');
  const tom = await writer('Tom');
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  await lan.sync();
  await tom.sync();
  lan.fs.put('lan.md', 'by lan\n');
  await lan.sync();
  await tom.sync();
  tom.fs.put('tom1.md', 'one\n');
  await tom.sync();
  tom.fs.put('tom2.md', 'two\n');
  await tom.sync();
  const backup = new Map(mem.objects);
  await owner.sync();
  await owner.engine.removeMember(lan.keys!.id);
  await tom.sync();

  mem.objects = new Map(backup);
  clock.now += 2 * 3_600_000;
  await assert.rejects(owner.sync(), HistoryError);
  // Lan's change is refused by the member list the owner's device holds, which storage lost.
  await assert.rejects(owner.engine.acceptStorage(), UnverifiedError);
  // Tom, who may still write, built on it: nothing is removed, and the owner's device signs those commits again.
  assert.deepEqual(await owner.engine.removeUnverifiable(), []);
  await owner.sync();
  for (const [path, body] of [['lan.md', 'by lan\n'], ['tom1.md', 'one\n'], ['tom2.md', 'two\n']]) assert.equal(owner.fs.text(path), body);
  clock.now += 60_000;
  await owner.sync();
  assert.deepEqual((await owner.engine.members()).map((m) => m.name), ['Vu', 'Tom'], 'the owner put its list back');
  await assert.rejects(tom.sync(), HistoryError);
  await tom.engine.acceptStorage();
  await tom.sync();
  await owner.sync();
  assert.deepEqual(tom.snapshot(), owner.snapshot());
  assert.deepEqual((await owner.engine.verify()).problems, []);
});

test('after a restart, restoring a moment before a snapshot by a member removed since reads the log instead', async () => {
  const cfg = { snapshotEvery: 5 };
  const { owner, writer } = await memberShare(cfg);
  const mai = await writer('Mai', { config: cfg });
  await mai.sync();
  mai.fs.put('a.md', 'mai 4\n');
  await mai.sync();
  mai.fs.put('a.md', 'mai 5\n');
  await mai.sync();
  mai.fs.put('a.md', 'mai 6\n');
  await mai.sync();
  await owner.sync();
  await owner.engine.removeMember(mai.keys!.id);
  for (let i = 8; i <= 11; i++) {
    owner.fs.put('a.md', `owner ${i}\n`);
    await owner.sync();
  }
  owner.restart();
  await owner.sync();
  const { repo, st, cfg: c, now } = await owner.engine.view();
  const past = await tableAt(repo, st.remote, st.lastSeq, c, now, { seq: 6 });
  assert.equal(new TextDecoder().decode(await owner.engine.readVersion(past.files.get('a.md')!)), 'mai 6\n');
});

test('a request that fails while a new device chooses a snapshot leaves that snapshot in storage', async () => {
  const cfg = { snapshotEvery: 5 };
  const { owner, invite, net, mem, clock } = await memberShare(cfg);
  for (let i = 2; i <= 15; i++) {
    owner.fs.put(`n${i}.md`, `${i}\n`);
    await owner.sync();
  }
  const keys = await joinShare(net, await invite('Lan', 'write'), clock.now);
  await publishJoin(net, keys);
  await owner.engine.confirmJoins();
  let armed = false;
  const flaky: RemoteStore = {
    get: (key, range) => {
      if (key === 'snap/000000000015') armed = true;
      else if (armed && key === 'log/000000000001') {
        armed = false;
        return Promise.reject(new Error('the connection was lost'));
      }
      return net.get(key, range);
    },
    put: (k, d, o) => net.put(k, d, o),
    delete: (k) => net.delete(k),
    list: (p, a) => net.list(p, a),
  };
  // A device that only reads keeps what it found forged for as long as it runs.
  const ann = new Device('Ann', flaky, clock, { ...cfg, readOnly: true }, await joinShare(net, await invite('Ann', 'read'), clock.now));
  await ann.sync();
  assert.deepEqual(ann.snapshot(), owner.snapshot());
  assert.deepEqual([...(await ann.engine.view()).repo.forged], []);
  // One that writes tidies snapshots found forged: it reads them again first.
  const lan = new Device('Lan', flaky, clock, cfg, keys);
  await lan.sync();
  assert.deepEqual(lan.snapshot(), owner.snapshot());
  assert.ok(mem.objects.has('snap/000000000015'));
});

test('joining writes nothing until the keys are kept: the link works again after a stop, and a device that stopped before asking to be confirmed asks at its next sync', async () => {
  const { owner, invite, net, clock } = await memberShare();
  await owner.sync();
  const link = await invite('Lan', 'write');
  const lost = await joinShare(net, link, clock.now);
  assert.equal(await net.get(`join/${link.member}`), null, 'nothing written yet');
  // The app stopped before it kept those keys: the link opens again, for a new key.
  const keys = await joinShare(net, link, clock.now);
  await publishJoin(net, keys);
  await publishJoin(net, keys);
  await assert.rejects(publishJoin(net, lost), /already used/);
  await assert.rejects(joinShare(net, link, clock.now), /already used/);
  assert.deepEqual(await owner.engine.confirmJoins(), [link.member]);

  // Kept its keys, then stopped before asking.
  const annLink = await invite('Ann', 'write');
  const ann = new Device('Ann', net, clock, {}, await joinShare(net, annLink, clock.now));
  await ann.sync();
  assert.ok(await net.get(`join/${annLink.member}`));
  assert.deepEqual(await owner.engine.confirmJoins(), [annLink.member]);
  await ann.sync();
  assert.equal((await ann.engine.memberStanding())!.mayWrite, true);
});

test('a follow link’s member is marked in the signed member list, and a re-key hands it no storage keys', async () => {
  const { owner, writer, keys, net, mem, clock } = await memberShare();
  await owner.sync();
  const lan = await writer('Lan');
  await assert.rejects(owner.engine.invite({ name: 'Web', role: 'write', expires: 0, follow: true }), /only reads/);
  const grant = await owner.engine.invite({ name: 'Web', role: 'read', expires: 0, follow: true });
  const web = new Device('web', net, clock, { readOnly: true }, await joinShare(net, decodeFollow(encodeFollow({ ...grant, url: 'https://example.com/f', share: 'F', folder: 'F' })), clock.now));
  await web.sync();
  const phone = new Device('phone', net, clock, {}, keys);
  await phone.sync();
  for (const d of [owner, phone]) {
    const m = (await d.engine.members()).find((x) => x.name === 'Web')!;
    assert.equal(m.follow, true);
    assert.equal(m.role, 'read');
    assert.equal(m.state, 'waiting', 'its link never expires');
  }
  assert.equal((await owner.engine.members()).find((x) => x.name === 'Lan')!.follow, undefined);
  // Only the follower reads, so no read-only key is needed, and it is handed none.
  const n = await owner.engine.writeRekey({ write: { secretKey: 'w2' } });
  assert.deepEqual(await lan.engine.rekeyOffer(), { n, storage: { secretKey: 'w2' } });
  assert.equal(await web.engine.rekeyOffer(), null);
  assert.ok(![...mem.objects.keys()].includes(`rekey/${grant.member}`));

  // The mark is signed: storage that drops it from the member change makes that change fail to verify.
  const raw = await rawRepo(mem, keys);
  let marked = 0;
  for (const s of await raw.commitSeqsAfter(0)) {
    const c = (await raw.readCommit(s))!;
    if (c.members?.members.some((m) => m.follow)) marked = s;
  }
  assert.ok(marked > 0);
  const real = (await raw.readCommit(marked))!;
  mem.objects.delete(seqKey('log', marked));
  await raw.writeCommit({ ...real, members: { ...real.members!, members: real.members!.members.map(({ follow: _, ...m }) => m) } });
  const tablet = new Device('tablet', net, clock, {}, keys);
  await assert.rejects(tablet.sync(), UnverifiedError);
});

test('a member invited to read and suggest is marked in the signed member list, and a re-key hands it a key of its own', async () => {
  const { owner, join, keys, net, mem, clock } = await memberShare();
  await owner.sync();
  const mai = await join('Mai', 'read');
  await assert.rejects(owner.engine.invite({ name: 'Bo', role: 'write', expires: 0, suggest: true }), /Only a member invited to read/);
  await assert.rejects(owner.engine.invite({ name: 'Web', role: 'read', expires: 0, follow: true, suggest: true }), /Only a member invited to read/);
  const grant = await owner.engine.invite({ name: 'Ann', role: 'read', expires: clock.now + DAY, suggest: true });
  const link = decodeInvite(encodeInvite({ ...grant, storage: { bucket: 'b' }, share: 'F', folder: 'F' }));
  const ann = new Device('Ann', net, clock, { readOnly: true }, await joinShare(net, link, clock.now));
  await ann.sync();
  const phone = new Device('phone', net, clock, {}, keys);
  await phone.sync();
  for (const d of [owner, phone, ann]) {
    const readers = (await d.engine.members()).filter((m) => m.role === 'read');
    assert.deepEqual(readers.map((m) => [m.name, m.suggest ?? false]), [['Mai', false], ['Ann', true]]);
  }

  // Those who only read and those who send suggestions each need their own key, and get only theirs.
  await assert.rejects(owner.engine.writeRekey({ write: { secretKey: 'w2' }, read: { secretKey: 'r2' } }), /read and add suggestions is needed too: Ann/);
  await assert.rejects(owner.engine.writeRekey({ write: { secretKey: 'w2' }, suggest: { secretKey: 's2' } }), /read-only key is needed too: Mai/);
  const n = await owner.engine.writeRekey({ write: { secretKey: 'w2' }, read: { secretKey: 'r2' }, suggest: { secretKey: 's2' } });
  assert.deepEqual(await mai.engine.rekeyOffer(), { n, storage: { secretKey: 'r2' } });
  assert.deepEqual(await ann.engine.rekeyOffer(), { n, storage: { secretKey: 's2' } });
  assert.deepEqual(await phone.engine.rekeyOffer(), { n, storage: { secretKey: 'w2' } });

  // Removing Ann leaves only Mai, who reads: a key for suggestions is needed no more.
  await owner.engine.removeMember(grant.member);
  await owner.engine.writeRekey({ write: { secretKey: 'w3' }, read: { secretKey: 'r3' } });

  // The mark is signed: storage that takes it out of the member change makes that change fail to verify, so a reader
  // who sends suggestions can not be handed the read-only key, nor one who only reads the key for suggestions.
  const raw = await rawRepo(mem, keys);
  let marked = 0;
  for (const s of await raw.commitSeqsAfter(0)) {
    const c = (await raw.readCommit(s))!;
    if (c.members?.members.some((m) => m.suggest)) marked = s;
  }
  assert.ok(marked > 0);
  const real = (await raw.readCommit(marked))!;
  mem.objects.delete(seqKey('log', marked));
  await raw.writeCommit({ ...real, members: { ...real.members!, members: real.members!.members.map(({ suggest: _, ...m }) => m) } });
  const tablet = new Device('tablet', net, clock, {}, keys);
  await assert.rejects(tablet.sync(), UnverifiedError);
});
