// One test per attack in the design review of member shares: someone who holds the master key and can write to storage
// (a read member over WebDAV, a removed member before re-key, the storage provider) must get nothing accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromB64, utf8 } from '../src/core/bytes.ts';
import { deflate, inflate } from '../src/core/compress.ts';
import { hkdf, keysFromMaster, newSigningKey, seal, sealWithKey, unwrapMaster, type KeyHeader, type SigningKey } from '../src/core/crypto.ts';
import { HistoryError, RemovedError, SyncEngine, UnverifiedError } from '../src/core/engine.ts';
import { MemberBook, readRekey, writeRekey, type MemberChange, type MemberKeys } from '../src/core/members.ts';
import { createMemberShare, joinShare, publishJoin } from '../src/core/membership.ts';
import { Repo, seqKey } from '../src/core/repo.ts';
import { tableAt } from '../src/core/timeline.ts';
import type { Commit, Entry, RemoteStore } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { DAY, Device, memberShare, rawRepo } from './helpers.ts';

const HOUR = 3_600_000;
const text = (u: Uint8Array) => new TextDecoder().decode(u);
const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

/** The member changes in storage's log, and its last commit, as anyone with the master key reads them. */
async function logOf(raw: Repo): Promise<{ changes: MemberChange[]; last: number; head: string }> {
  const seqs = await raw.commitSeqsAfter(0);
  const changes: MemberChange[] = [];
  let head = '';
  for (const seq of seqs) {
    const c = (await raw.readCommit(seq))!;
    if (c.members) changes.push({ seq, gen: c.members.gen, members: c.members.members, hash: c.hash });
    head = c.hash!;
  }
  return { changes, last: seqs.at(-1) ?? 0, head };
}

/**
 * Appends a commit as a modified client would: with `as` it is signed with that key under that member id, naming the
 * member list `changes` ends with; without, it is not signed at all.
 */
async function forge(store: RemoteStore, keys: MemberKeys, c: Partial<Commit>, as?: { id: string; key: SigningKey; changes?: MemberChange[] }): Promise<number> {
  const raw = await rawRepo(store, keys);
  const log = await logOf(raw);
  if (as) raw.useMembers(new MemberBook(raw.id, { owner: keys.owner, id: as.id, key: as.key }), () => ({ changes: as.changes ?? log.changes, through: log.last }));
  const seq = log.last + 1;
  assert.ok(await raw.writeCommit({ seq, device: 'forged', time: 1, changes: [], prev: log.head, ...c }));
  return seq;
}

test('content sealed under a valid chunk id by someone who holds the vault key is refused when downloaded, in every kind of vault', async () => {
  for (const kind of ['members', 'passphrase']) {
    let writer: Device, reader: Device, raw: Repo, mem: MemoryStore;
    if (kind === 'members') {
      const s = await memberShare();
      ({ mem } = s);
      writer = s.owner;
      reader = await s.join('Mai', 'read');
      raw = await rawRepo(s.net, s.keys);
    } else {
      const clock = { now: 1_800_000_000_000 };
      mem = new MemoryStore(() => clock.now);
      const net = new SimStore(mem);
      writer = new Device('A', net, clock);
      reader = new Device('B', net, clock);
      await writer.sync();
      raw = await Repo.open(net, 'test passphrase', { kdfIterations: 1000, chunk: writer.config.chunk });
    }
    writer.fs.put('budget.bin', random(20_000, 1));
    await writer.sync();
    const ref = (await writer.engine.view()).st.remote.get('budget.bin')!.chunks[0];
    const fake = await raw.sealChunk(ref.id, random(ref.size, 2), false);
    assert.equal(fake.length, ref.len, 'the same length, so only the content tells');
    const pack = (await mem.get(`pack/${ref.pack}`))!;
    pack.set(fake, ref.off);
    await mem.put(`pack/${ref.pack}`, pack);
    const r = await reader.sync();
    assert.deepEqual(r.errors.map((e) => e.path), ['budget.bin'], kind);
    assert.match(r.errors[0].message, /does not match its id/);
    assert.equal(reader.fs.files.has('budget.bin'), false);
    await assert.rejects(reader.engine.readVersion((await writer.engine.view()).st.remote.get('budget.bin')!), /does not match its id/);
  }
});

test('a header rewritten to the format without members is refused, so the checks cannot be turned off', async () => {
  const { owner, writer, mem, keys, net } = await memberShare();
  const lan = await writer('Lan');
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  await lan.sync();
  const raw = await rawRepo(net, keys);
  const { ids } = await raw.split(utf8.encode('forged\n'));
  const sealed = await raw.sealChunk(ids[0], utf8.encode('forged\n'), false);
  await raw.putPack('forged', sealed);
  await forge(net, keys, { changes: [{ path: 'a.md', entry: { size: 7, mtime: 1, chunks: [{ id: ids[0], pack: 'forged', off: 0, len: sealed.length, size: 7 }] } }] });
  const header = JSON.parse(text(mem.objects.get('vault.json')!.data)) as { format: number };
  header.format = 1;
  await mem.put('vault.json', utf8.encode(JSON.stringify(header)));
  // A running engine never reads the header again, and refuses the unsigned commit.
  await assert.rejects(lan.sync(), UnverifiedError);
  // One started afresh refuses the header itself.
  for (const d of [owner, lan]) {
    d.restart();
    await assert.rejects(d.sync(), /no members \(format 1\).*tampered with/);
    assert.equal(d.fs.text('a.md'), 'a\n');
  }
  // A device set up with a passphrase, as for a shared folder of the older kind, does not open a member share.
  header.format = 2;
  await mem.put('vault.json', utf8.encode(JSON.stringify(header)));
  await assert.rejects(Repo.open(net, 'owner passphrase', { kdfIterations: 1000, chunk: owner.config.chunk }), /invite link/);
});

test('the key file anyone who reads the folder can fetch is sealed with no passphrase, so guessing one gets nobody the master key', async () => {
  const { owner, mem } = await memberShare();
  const header = () => JSON.parse(text(mem.objects.get('vault.json')!.data)) as { kdf: KeyHeader };
  await assert.rejects(unwrapMaster(header().kdf, 'owner passphrase'));
  await owner.engine.changePassphrase('a new owner passphrase');
  await assert.rejects(unwrapMaster(header().kdf, 'a new owner passphrase'));
});

test('a forged digest, snapshot or cleanup record is not used: history and restore show only what members wrote', async () => {
  const cfg = { snapshotEvery: 5 };
  const { owner, join, keys, net, mem, clock } = await memberShare(cfg);
  const mai = await join('Mai', 'read', { config: cfg });
  for (let i = 0; i < 9; i++) {
    owner.fs.put('budget.md', `budget v${i}\n`);
    await owner.sync();
  }
  await mai.sync();
  const raw = await rawRepo(net, keys);
  const { changes, last, head } = await logOf(raw);
  assert.equal(last, 11);
  // Mai stores her own content under a valid chunk id: she holds the id key too.
  const evil = utf8.encode('pay Mai\n');
  const { ids } = await raw.split(evil);
  const sealed = await raw.sealChunk(ids[0], evil, false);
  await raw.putPack('evil', sealed);
  const evilEntry: Entry = { size: evil.length, mtime: 1, chunks: [{ id: ids[0], pack: 'evil', off: 0, len: sealed.length, size: evil.length }] };
  const point = (c: Commit): Commit => ({ ...c, changes: c.changes.map((ch) => (ch.path === 'budget.md' ? { path: ch.path, entry: evilEntry } : ch)) });

  // A digest of commits 6-10 pointing budget.md at it, signed with a key of her own under her id.
  const { key } = await newSigningKey();
  const maiBook = new MemberBook(raw.id, { owner: keys.owner, id: mai.keys!.id, key });
  const forged: Commit[] = [];
  for (const seq of [6, 7, 8, 9, 10]) {
    const c = point((await raw.readCommit(seq))!);
    await maiBook.signCommit(c, changes);
    forged.push(c);
  }
  await raw.writeDigest(10, forged);
  // A snapshot at 10 that says the same, and a cleanup record that would move the floor to the end.
  const snap = (await raw.readSnapshotWithHead(10, { unchecked: true }))!;
  snap.files.set('budget.md', evilEntry);
  mem.objects.delete(seqKey('snap', 10));
  const evilRepo = await rawRepo(net, keys);
  evilRepo.useMembers(maiBook, () => ({ changes, through: last }));
  await evilRepo.writeSnapshot(10, snap.files, snap.head);
  await raw.setPrunedTo(last);

  for (const v of await owner.engine.history('budget.md')) assert.notEqual(v.entry?.chunks[0].pack, 'evil');
  const { repo, st, cfg: c, now } = await owner.engine.view();
  assert.equal(await repo.prunedTo(), 0, 'an unsigned cleanup record counts for nothing');
  for (const seq of [8, 10, 11]) {
    const past = await tableAt(repo, st.remote, st.lastSeq, c, now, { seq });
    assert.equal(text(await owner.engine.readVersion(past.files.get('budget.md')!)), `budget v${seq - 3}\n`);
  }
  // The digest was written again from the commits.
  assert.ok((await raw.loadDigest(10, 5)).commits!.every((x) => x.signer === keys.id));
  // A new device passes over the forged snapshot and reads the log.
  const ann = await join('Ann', 'read', { config: cfg });
  await ann.sync();
  assert.equal(ann.fs.text('budget.md'), 'budget v8\n');
  assert.ok((await owner.engine.verify()).problems.some((p) => p.object === seqKey('snap', 10)));
  // The owner's device drops the forged snapshot once it has found it.
  assert.equal(await repo.readSnapshot(10), null);
  clock.now += 60_000;
  await owner.sync();
  assert.equal(mem.objects.has(seqKey('snap', 10)), false);
  void head;
});

test('a commit overwritten in the middle of the log is refused by history, by a new device and by verify', async () => {
  const { owner, join, keys, mem } = await memberShare();
  for (let i = 0; i < 4; i++) {
    owner.fs.put('a.md', `v${i}\n`);
    await owner.sync();
  }
  const raw = await rawRepo(mem, keys);
  const real = (await raw.readCommit(3))!;
  // Storage holds the whole commit object; an unsigned one in its place, naming the same commit before it.
  mem.objects.delete(seqKey('log', 3));
  await raw.writeCommit({ ...real, signer: undefined, sig: undefined, listSeq: undefined });
  await assert.rejects(owner.engine.history('a.md'), UnverifiedError);
  assert.ok((await owner.engine.verify()).problems.some((p) => p.object === seqKey('log', 3)));
  const ann = await join('Ann', 'read');
  await assert.rejects(ann.sync(), UnverifiedError);
  assert.equal(ann.fs.files.size, 0);
});

test('a snapshot that does not verify is replaced when its number comes round', async () => {
  const cfg = { snapshotEvery: 5 };
  const { owner, join, keys, net, mem } = await memberShare(cfg);
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  // Squatted ahead at the next snapshot's number, unsigned.
  const raw = await rawRepo(net, keys);
  await raw.writeSnapshot(5, new Map(), 'nothing');
  const squatted = mem.objects.get(seqKey('snap', 5))!.data;
  for (let i = 0; i < 4; i++) {
    owner.fs.put('a.md', `${i}\n`);
    await owner.sync();
  }
  assert.notDeepEqual(mem.objects.get(seqKey('snap', 5))!.data, squatted);
  const got: string[] = [];
  const spy: RemoteStore = { get: (k, r) => (got.push(k), mem.get(k, r)), put: mem.put.bind(mem), delete: mem.delete.bind(mem), list: mem.list.bind(mem) };
  const ann = await join('Ann', 'read', { config: cfg });
  const annSpy = new Device('Ann', spy, ann.clock, ann.config, ann.keys);
  await annSpy.sync();
  assert.equal(annSpy.fs.text('a.md'), '3\n');
  assert.ok(!got.includes(seqKey('log', 3)), 'it started from the snapshot');
});

test('removal race: a change that took its number before the removal stands; one after it stops everyone until the owner removes it', async () => {
  const { owner, writer, keys, net } = await memberShare();
  const lan = await writer('Lan');
  const tom = await writer('Tom');
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  await lan.sync();
  await tom.sync();
  lan.fs.put('lan1.md', 'one\n');
  await lan.sync();
  const before = (await logOf(await rawRepo(net, keys))).changes;
  await owner.engine.removeMember(lan.keys!.id);
  await tom.sync();
  assert.equal(tom.fs.text('lan1.md'), 'one\n', 'made before the removal: valid');
  // Lan's device has not seen the removal: its commit loses the race for the number, and it stops.
  lan.fs.put('lan2.md', 'two\n');
  await assert.rejects(lan.sync(), RemovedError);
  const end = (await logOf(await rawRepo(net, keys))).last;
  assert.equal(await net.get(seqKey('log', end + 1)), null);

  // A modified client keeps writing with Lan's key, naming the list before the removal, then the one after it.
  for (const changes of [before, undefined]) {
    const seq = await forge(net, keys, { changes: [{ path: 'evil.md', entry: { size: 0, mtime: 1, chunks: [] } }] }, { id: lan.keys!.id, key: lan.keys!.key!, changes });
    await assert.rejects(tom.sync(), UnverifiedError);
    assert.equal(tom.fs.files.has('evil.md'), false);
    assert.equal(await tom.engine.remoteChanged(), false, 'paused while stuck');
    // Honest devices never commit past it.
    tom.fs.put('tom.md', `${seq}\n`);
    await assert.rejects(tom.sync(), UnverifiedError);
    assert.equal(await net.get(seqKey('log', seq + 1)), null);
    await assert.rejects(lan.engine.removeUnverifiable(), /owner/);
    assert.deepEqual(await owner.engine.removeUnverifiable(), [seq]);
    assert.deepEqual(await owner.engine.removeUnverifiable(), []);
    await tom.sync();
    await owner.sync();
    assert.equal(owner.fs.text('tom.md'), `${seq}\n`);
    assert.equal(owner.fs.files.has('evil.md'), false);
  }
});

test('a read member gets no change accepted: its device keeps changes here, and commits it makes by hand stop nobody for good', async () => {
  const { owner, join, writer, keys, net } = await memberShare();
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  const lan = await writer('Lan');
  // "Only receive changes" switched off on a read member's device.
  const mai = await join('Mai', 'read', { config: { readOnly: false } });
  await mai.sync();
  mai.fs.put('a.md', 'mai\n');
  const r = await mai.sync();
  assert.deepEqual([r.unsent, r.commits], [['a.md'], 0]);
  assert.equal((await mai.engine.gc()).packsDeleted, 0);

  const maiKey = (await newSigningKey()).key;
  const entry = { size: 0, mtime: 1, chunks: [] };
  const attempts: [string, Partial<Commit>, Parameters<typeof forge>[3]][] = [
    ['not signed', { changes: [{ path: 'a.md', entry }] }, undefined],
    ['its member may not write', { changes: [{ path: 'a.md', entry }] }, { id: mai.keys!.id, key: maiKey }],
    ['its signer is not a member', { changes: [{ path: 'a.md', entry }] }, { id: 'AAAAAAAAAAAAAAAA', key: maiKey }],
    ['not made by the owner', { moved: true, members: { gen: 99, members: [{ id: mai.keys!.id, name: 'Mai', role: 'owner', pub: keys.owner }], earlier: [] } }, { id: mai.keys!.id, key: maiKey }],
    // A write member is not the owner either.
    ['not made by the owner', { moved: true, members: { gen: 99, members: [{ id: lan.keys!.id, name: 'Lan', role: 'owner', pub: keys.owner }], earlier: [] } }, { id: lan.keys!.id, key: lan.keys!.key! }],
  ];
  for (const [why, c, as] of attempts) {
    const seq = await forge(net, keys, c, as);
    await assert.rejects(owner.sync(), (e: unknown) => e instanceof UnverifiedError && e.seq === seq && e.message.includes(why === 'not signed' ? 'is not signed' : why));
    const report = await owner.engine.verify();
    assert.ok(report.problems.some((p) => p.object === seqKey('log', seq)), why);
    await assert.rejects(lan.sync(), UnverifiedError);
    assert.deepEqual(await owner.engine.removeUnverifiable(), [seq]);
  }
  await owner.sync();
  await lan.sync();
  assert.equal(lan.fs.text('a.md'), 'a\n');
  assert.deepEqual((await owner.engine.verify()).problems, []);
});

test('a snapshot squatted far ahead is passed over, and a log key far ahead is garbage the owner removes', async () => {
  const cfg = { snapshotEvery: 5 };
  const { owner, join, keys, net, mem } = await memberShare(cfg);
  for (let i = 0; i < 7; i++) {
    owner.fs.put(`n${i}.md`, `${i}\n`);
    await owner.sync();
  }
  const raw = await rawRepo(net, keys);
  await mem.put(seqKey('snap', 999_999), random(200, 3));
  await raw.writeSnapshot(999_998, new Map(), 'nothing');
  const ann = await join('Ann', 'read', { config: cfg });
  await ann.sync();
  assert.deepEqual(ann.snapshot(), owner.snapshot());

  await mem.put(seqKey('log', 999_999), random(200, 4));
  const ben = await join('Ben', 'read', { config: cfg });
  await assert.rejects(ben.sync(), UnverifiedError);
  // A device up to date finds the next commit by asking for it, and goes on without listing.
  owner.fs.put('late.md', 'late\n');
  await owner.sync();
  owner.fs.put('later.md', 'later\n');
  await owner.sync();
  // One more than a commit behind lists the log, and stops at the gap until the owner removes what lies past it.
  await assert.rejects(ann.sync(), UnverifiedError);
  assert.equal(ann.fs.files.has('late.md'), false);
  assert.deepEqual(await owner.engine.removeUnverifiable(), [999_999]);
  await ann.sync();
  assert.equal(ann.fs.text('later.md'), 'later\n');
  assert.equal(mem.objects.has(seqKey('snap', 999_999)), false);
  assert.equal(mem.objects.has(seqKey('snap', 999_998)), false);
  await ben.sync();
  assert.deepEqual(ben.snapshot(), owner.snapshot());
});

test('storage rolled back to before a removal does not let the removed member back in on devices that saw the removal', async () => {
  const { owner, writer, invite, keys, mem, net, clock } = await memberShare();
  const lan = await writer('Lan');
  const xan = await writer('Xan');
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  await lan.sync();
  await xan.sync();
  // What Xan copied of storage while she could.
  const old = new Map(mem.objects);
  await owner.engine.removeMember(xan.keys!.id);
  await lan.sync();
  const ann = await invite('Ann', 'read');

  // Xan puts storage back as it was and writes on with her key, under the list that still names her.
  mem.objects = new Map(old);
  const forged: number[] = [];
  for (let i = 0; i < 3; i++) {
    forged.push(await forge(net, keys, { changes: [{ path: 'a.md', entry: { size: 0, mtime: 1, chunks: [] } }] }, { id: xan.keys!.id, key: xan.keys!.key! }));
  }
  clock.now += 2 * HOUR;
  await assert.rejects(lan.sync(), HistoryError);
  // Accepting storage as it is keeps the member list this device accepted, and Xan's commits do not pass.
  await assert.rejects(lan.engine.acceptStorage(), UnverifiedError);
  await assert.rejects(lan.sync(), UnverifiedError);
  assert.equal(lan.fs.text('a.md'), 'a\n');
  // The same after a restart: the list is kept apart from the sync state.
  lan.restart();
  await assert.rejects(lan.sync(), UnverifiedError);
  // An invite made after the removal does not open the old storage.
  await assert.rejects(joinShare(net, ann, clock.now), /no longer opens/);

  await assert.rejects(owner.sync(), HistoryError);
  await assert.rejects(owner.engine.acceptStorage(), UnverifiedError);
  assert.deepEqual(await owner.engine.removeUnverifiable(), forged);
  clock.now += 60_000;
  await owner.sync();
  assert.deepEqual((await owner.engine.members()).map((m) => m.name), ['Vu', 'Lan', 'Ann'], 'the owner put back the list it had');
  await lan.sync();
  assert.deepEqual((await lan.engine.members()).map((m) => m.name), ['Vu', 'Lan', 'Ann']);
  lan.fs.put('b.md', 'b\n');
  await lan.sync();
  await owner.sync();
  assert.equal(owner.fs.text('b.md'), 'b\n');
  assert.equal(owner.fs.text('a.md'), 'a\n');
});

test('a re-key document the owner did not sign, one sealed for someone else, or one older than the last taken, is ignored', async () => {
  const { owner, writer, join, keys, net } = await memberShare();
  const lan = await writer('Lan');
  const mai = await join('Mai', 'read');
  // Mai knows her own secret, so she can seal a document for herself, but not sign it as the owner.
  const fake = await newSigningKey();
  const maiBook = new MemberBook(keys.repo, { owner: fake.pub, id: mai.keys!.id, key: fake.key });
  await writeRekey(net, maiBook, mai.keys!.id, fromB64(mai.keys!.secret!), { n: 1e15, storage: { secretKey: 'evil' } });
  assert.equal(await mai.engine.rekeyOffer(), null);
  // Put where Lan's goes, it does not open with Lan's secret.
  await writeRekey(net, maiBook, lan.keys!.id, fromB64(mai.keys!.secret!), { n: 1e15, storage: { secretKey: 'evil' } });
  assert.equal(await lan.engine.rekeyOffer(), null);
  // Nor does Lan's real one open with Mai's secret.
  const n1 = await owner.engine.writeRekey({ write: { secretKey: 'w1' }, read: { secretKey: 'r1' } });
  await net.put(`rekey/${mai.keys!.id}`, (await net.get(`rekey/${lan.keys!.id}`))!);
  assert.equal(await mai.engine.rekeyOffer(), null);
  assert.deepEqual(await lan.engine.rekeyOffer(), { n: n1, storage: { secretKey: 'w1' } });
  const older = (await net.get(`rekey/${lan.keys!.id}`))!;
  const n2 = await owner.engine.writeRekey({ write: { secretKey: 'w2' }, read: { secretKey: 'r2' } });
  assert.ok(n2 > n1);
  await lan.engine.acceptRekey(n2);
  await net.put(`rekey/${lan.keys!.id}`, older);
  assert.equal(await lan.engine.rekeyOffer(), null, 'not newer than the one taken');
  // A document whose keys were changed in storage fails to open.
  const real = (await net.get(`rekey/${mai.keys!.id}`))!;
  real[real.length - 1] ^= 1;
  await net.put(`rekey/${mai.keys!.id}`, real);
  assert.equal(await mai.engine.rekeyOffer(), null);
});

test('an expired invite opens nothing, even when storage moves its expiry later, and a join made after it is not confirmed', async () => {
  const { owner, invite, net, clock } = await memberShare();
  await owner.sync();
  const link = await invite('Lan', 'write', clock.now + DAY);
  clock.now += 2 * DAY;
  await assert.rejects(joinShare(net, link, clock.now), /expired/);
  const slot = JSON.parse(text((await net.get(`slot/${link.member}`))!)) as { expires: number };
  slot.expires = clock.now + 10 * DAY;
  await net.put(`slot/${link.member}`, utf8.encode(JSON.stringify(slot)));
  await assert.rejects(joinShare(net, link, clock.now), /does not open/);
  assert.equal((await owner.engine.members()).find((m) => m.name === 'Lan')!.state, 'expired');
  // Whoever has the link writes a join anyway, saying it was made long before the invite expired: only storage's clock counts.
  const joinAt = await hkdf(fromB64(link.secret), 'coffer/join');
  const said = { pub: (await newSigningKey()).pub, time: 1 };
  await net.put(`join/${link.member}`, await sealWithKey(joinAt, utf8.encode(JSON.stringify(said)), `${link.repo}:join/${link.member}`));
  assert.deepEqual(await owner.engine.confirmJoins(), []);
  assert.equal(await net.get(`join/${link.member}`), null);
  assert.equal((await owner.engine.members()).find((m) => m.name === 'Lan')!.state, 'expired');
});

test('a re-key hands no keys to a write invite that expired before any device joined with it, and does to one joined in time', async () => {
  const { owner, invite, net, clock, keys } = await memberShare();
  await owner.sync();
  const bob = await invite('Bob', 'write', clock.now + DAY);
  const ann = await invite('Ann', 'write', clock.now + DAY);
  // Ann's device joined before her invite expired; the owner's device has not synced since to confirm it.
  await publishJoin(net, await joinShare(net, ann, clock.now));
  clock.now += 3 * DAY;
  const n = await owner.engine.writeRekey({ write: { secretKey: 'w2' } });
  // What whoever holds each link reads, with the old keys it carries.
  const offer = (link: typeof bob) => readRekey(net, new MemberBook(keys.repo, { owner: keys.owner, id: link.member }), link.member, fromB64(link.secret));
  assert.equal(await offer(bob), null);
  assert.deepEqual(await offer(ann), { n, storage: { secretKey: 'w2' } });
});

test('a removal whose clean-up failed can be run again, and the owner’s next sync closes the removed member’s invite anyway', async () => {
  const { owner, invite, net, clock } = await memberShare();
  await owner.sync();
  const del = net.delete.bind(net);
  const failing = (link: { member: string }) => {
    net.delete = async (key: string) => (key === `slot/${link.member}` ? Promise.reject(new Error('S3 DELETE failed with HTTP 503')) : del(key));
  };
  const mai = await invite('Mai', 'read', clock.now + 30 * DAY);
  failing(mai);
  await assert.rejects(owner.engine.removeMember(mai.member), /503/);
  net.delete = del;
  await owner.engine.removeMember(mai.member);
  await assert.rejects(joinShare(net, mai, clock.now), /no longer opens/);
  await assert.rejects(owner.engine.removeMember(mai.member), /no such member/);
  // The owner's devices' re-key is no member's.
  await owner.engine.writeRekey({ write: { secretKey: 'w2' } });
  await assert.rejects(owner.engine.removeMember('owner'), /no such member/);
  assert.ok(await net.get('rekey/owner'));

  // Left as it is, the owner's next sync after an hour takes the invite out.
  const ann = await invite('Ann', 'read', clock.now + 30 * DAY);
  failing(ann);
  await assert.rejects(owner.engine.removeMember(ann.member), /503/);
  net.delete = del;
  await owner.sync();
  assert.ok(await net.get(`slot/${ann.member}`), 'not at once: an invite another owner device makes writes its slot first');
  clock.now += 2 * 3_600_000;
  await owner.sync();
  assert.equal(await net.get(`slot/${ann.member}`), null);
  await assert.rejects(joinShare(net, ann, clock.now), /no longer opens/);
});

test('a join replayed after it was confirmed, or moved to another member, confirms nothing', async () => {
  const { owner, invite, net, clock } = await memberShare();
  await owner.sync();
  const lanLink = await invite('Lan', 'write');
  const lanKeys = await joinShare(net, lanLink, clock.now);
  await publishJoin(net, lanKeys);
  const lanJoin = (await net.get(`join/${lanLink.member}`))!;
  assert.deepEqual(await owner.engine.confirmJoins(), [lanLink.member]);
  const annLink = await invite('Ann', 'write');
  const seq = (await owner.engine.view()).st.lastSeq;
  await net.put(`join/${lanLink.member}`, lanJoin);
  await net.put(`join/${annLink.member}`, lanJoin);
  assert.deepEqual(await owner.engine.confirmJoins(), []);
  assert.equal((await owner.engine.view()).st.lastSeq, seq, 'no member change');
  assert.equal(await net.get(`join/${lanLink.member}`), null);
  assert.equal(await net.get(`join/${annLink.member}`), null);
  assert.deepEqual((await owner.engine.members()).map((m) => [m.name, m.state]), [['Vu', 'joined'], ['Lan', 'joined'], ['Ann', 'waiting']]);
  const lan = new Device('Lan', net, clock, {}, lanKeys);
  assert.equal((await lan.engine.memberStanding())!.mayWrite, false, 'as of its last sync: none yet');
  await lan.sync();
  assert.equal((await lan.engine.memberStanding())!.mayWrite, true);
  // Ann still joins with her own link.
  await publishJoin(net, await joinShare(net, annLink, clock.now));
  assert.deepEqual(await owner.engine.confirmJoins(), [annLink.member]);
});

test('a device that holds no member keys behaves as before: the passphrase engine opens only the older format', async () => {
  const clock = { now: 1_800_000_000_000 };
  const net = new SimStore(new MemoryStore(() => clock.now));
  const a = new Device('A', net, clock);
  a.fs.put('a.md', 'a\n');
  await a.sync();
  const raw = await Repo.open(net, 'test passphrase', { kdfIterations: 1000, chunk: a.config.chunk });
  const c = (await raw.readCommit(2)) ?? (await raw.readCommit(1))!;
  assert.equal(c.signer, undefined);
  assert.equal(c.sig, undefined);
  assert.equal(await net.get('follow'), null);
  assert.equal(await a.engine.memberStanding(), undefined);
  await assert.rejects(a.engine.members(), /not a shared folder with members/);
  assert.ok(a.engine instanceof SyncEngine);
});

/** Content of the caller's choosing, stored as someone who holds the vault key can, under a valid chunk id. */
async function storeContent(raw: Repo, content: string): Promise<Entry> {
  const data = utf8.encode(content);
  const { ids } = await raw.split(data);
  const sealed = await raw.sealChunk(ids[0], data, false);
  const pack = raw.newPackId();
  await raw.putPack(pack, sealed);
  return { size: data.length, mtime: 1, chunks: [{ id: ids[0], pack, off: 0, len: sealed.length, size: data.length }] };
}

/** The share's storage as a member who was removed sees it: she still holds the master key and her own signing key. */
async function asMember(store: RemoteStore, keys: MemberKeys, member: MemberKeys, changes: MemberChange[], through: number): Promise<Repo> {
  const raw = await rawRepo(store, keys);
  raw.useMembers(new MemberBook(raw.id, { owner: keys.owner, id: member.id, key: member.key }), () => ({ changes, through }));
  return raw;
}

test('a snapshot a removed member writes for a commit from before her removal is taken by no device, and history passes over it', async () => {
  const cfg = { snapshotEvery: 5 };
  const { owner, writer, join, invite, keys, net, mem, clock } = await memberShare(cfg);
  const lan = await writer('Lan', { config: cfg });
  owner.fs.put('budget.md', 'real budget\n');
  await owner.sync();
  await lan.sync();
  lan.fs.put('lan.md', 'by lan\n');
  await lan.sync();
  assert.ok(mem.objects.has(seqKey('snap', 5)), 'Lan’s device wrote snapshot 5');
  // A link made before the removal, used after it: the device starts from a list that still names Lan.
  const early = await invite('Ben', 'read');
  await owner.engine.removeMember(lan.keys!.id);
  owner.fs.put('after.md', 'after\n');
  await owner.sync();

  // Lan, removed but still able to write to storage, puts her own table in snapshot 5, signed as the member she was then.
  const raw = await rawRepo(net, keys);
  const { changes } = await logOf(raw);
  const snap = (await raw.readSnapshotWithHead(5, { unchecked: true }))!;
  snap.files.set('budget.md', await storeContent(raw, 'pay Lan\n'));
  mem.objects.delete(seqKey('snap', 5));
  await (await asMember(net, keys, lan.keys!, changes.filter((c) => c.seq <= 5), 5)).writeSnapshot(5, snap.files, snap.head);
  // Checked by a device that holds every member change, where storage still holds the newest (so no list is capped).
  const book = new MemberBook(raw.id, keys);
  book.accept(changes.at(-1));
  await assert.rejects(book.checkSnapshot(5, (await raw.readSnapshotWithHead(5, { unchecked: true }))!, changes, false), /may no longer write/);

  const ann = await join('Ann', 'read', { config: cfg });
  await ann.sync();
  assert.equal(ann.fs.text('budget.md'), 'real budget\n', 'a device whose link names the list without Lan');
  const ben = new Device('Ben', net, clock, { ...cfg, readOnly: true }, await joinShare(net, early, clock.now));
  await ben.sync();
  assert.equal(ben.fs.text('budget.md'), 'real budget\n', 'a device that learns of the removal from the commits after the snapshot');
  ben.restart();
  await ben.sync();
  assert.equal(ben.fs.text('budget.md'), 'real budget\n');
  assert.deepEqual(ben.snapshot(), owner.snapshot());

  // History on the owner's device, restarted as after an app restart, reads the log rather than her snapshot.
  owner.restart();
  await owner.sync();
  const { repo, st, cfg: c, now } = await owner.engine.view();
  const past = await tableAt(repo, st.remote, st.lastSeq, c, now, { seq: 5 });
  assert.equal(text(await owner.engine.readVersion(past.files.get('budget.md')!)), 'real budget\n');
  assert.ok((await owner.engine.verify()).problems.some((p) => p.object === seqKey('snap', 5)));
  clock.now += 60_000;
  await owner.sync();
  assert.equal(mem.objects.has(seqKey('snap', 5)), false, 'the owner’s device drops it');
});

test('a digest a removed member writes for commits from before her removal is not used, and is written again', async () => {
  const cfg = { snapshotEvery: 5 };
  const { owner, writer, keys, net } = await memberShare(cfg);
  const lan = await writer('Lan', { config: cfg });
  owner.fs.put('budget.md', 'real budget\n');
  await owner.sync();
  await lan.sync();
  lan.fs.put('lan.md', 'by lan\n');
  await lan.sync();
  await owner.engine.removeMember(lan.keys!.id);
  owner.fs.put('budget.md', 'later budget\n');
  await owner.sync();

  // Lan rewrites the digest of commits 1-5: her own commit 5 now also points budget.md at her content, signed by her
  // key as the member she was then, and the digest as a whole too.
  const raw = await rawRepo(net, keys);
  const { changes } = await logOf(raw);
  const evil = await storeContent(raw, 'pay Lan\n');
  const commits = await Promise.all([1, 2, 3, 4, 5].map(async (s) => (await raw.readCommit(s))!));
  const lanBook = new MemberBook(raw.id, { owner: keys.owner, id: lan.keys!.id, key: lan.keys!.key });
  commits[4] = { ...commits[4], changes: [...commits[4].changes, { path: 'budget.md', entry: evil }] };
  await lanBook.signCommit(commits[4], changes);
  await (await asMember(net, keys, lan.keys!, changes, 5)).writeDigest(5, commits);

  owner.restart();
  for (const v of await owner.engine.history('budget.md')) assert.notEqual(v.entry?.chunks[0].pack, evil.chunks[0].pack);
  const again = (await raw.loadDigest(5, 5)).commits!;
  assert.ok(!again[4].changes.some((ch) => ch.path === 'budget.md'), 'written again from the log');
  assert.equal(again[4].signer, lan.keys!.id, 'her real commit 5 stays hers');
});

test('garbage at the end of the log, or a commit no member signed that does not follow the one before, stops syncing until the owner removes it', async () => {
  const { owner, writer, keys, net, mem } = await memberShare();
  const tom = await writer('Tom');
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  await tom.sync();
  for (const kind of ['bytes', 'unchained']) {
    const { last } = await logOf(await rawRepo(net, keys));
    if (kind === 'bytes') await mem.put(seqKey('log', last + 1), random(300, 7));
    else await forge(net, keys, { changes: [{ path: 'a.md', entry: null }], prev: 'not the commit before it' });
    for (const d of [tom, owner]) {
      await assert.rejects(d.sync(), (e: unknown) => e instanceof UnverifiedError && e.seq === last + 1, kind);
      assert.equal(await d.engine.remoteChanged(), false, 'paused while stuck');
    }
    // The owner can still act on members while it is stuck.
    assert.deepEqual((await owner.engine.members()).map((m) => m.name), ['Vu', 'Tom']);
    assert.deepEqual(await owner.engine.removeUnverifiable(), [last + 1], kind);
    tom.fs.put(`${kind}.md`, `${kind}\n`);
    await tom.sync();
    await owner.sync();
    assert.equal(owner.fs.text(`${kind}.md`), `${kind}\n`);
    assert.equal(owner.fs.text('a.md'), 'a\n');
  }
  // A commit a member who may write signed, but that does not follow the commit before it, is a fork: not removed as garbage.
  const { last, changes } = await logOf(await rawRepo(net, keys));
  await forge(net, keys, { changes: [], prev: 'not the commit before it' }, { id: tom.keys!.id, key: tom.keys!.key!, changes });
  await assert.rejects(owner.sync(), (e: unknown) => !(e instanceof UnverifiedError) && /does not follow/.test(String(e)));
  await assert.rejects(owner.engine.removeUnverifiable(), /does not follow/);
  assert.ok(await net.get(seqKey('log', last + 1)));
});

/** `mib` MiB of zeros, deflated as a document is before it is sealed: about a thousandth of that. */
async function zerosDeflated(mib: number): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  const zero = new Uint8Array(1 << 20);
  void (async () => {
    for (let i = 0; i < mib; i++) await w.write(zero);
    await w.close();
  })();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

test('an object at the end of the log that unpacks to hundreds of megabytes is given up on early, and the owner removes it', async () => {
  const MB = 1 << 20;
  const { owner, writer, keys, net, mem } = await memberShare();
  const tom = await writer('Tom');
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  await tom.sync();
  const { last } = await logOf(await rawRepo(net, keys));
  const bomb = await zerosDeflated(320);
  assert.ok(bomb.length < MB);
  // Sealed as a commit with the master key every member holds, by someone who can also write to storage.
  const key = seqKey('log', last + 1);
  await mem.put(key, await seal(await keysFromMaster(fromB64(keys.master)), bomb, `${keys.repo}:${key}`));
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 2);
  try {
    for (const d of [tom, owner]) await assert.rejects(d.sync(), (e: unknown) => e instanceof UnverifiedError && e.seq === last + 1);
    assert.deepEqual(await owner.engine.removeUnverifiable(), [last + 1]);
  } finally {
    clearInterval(timer);
  }
  assert.ok(peak - before < 200 * MB, `memory grew by ${Math.round((peak - before) / MB)} MiB`);
  await assert.rejects(inflate(bomb, 64 * MB), /more than/);
  assert.equal((await inflate(await deflate(new Uint8Array(1000)), 1000)).length, 1000);
  tom.fs.put('b.md', 'b\n');
  await tom.sync();
  await owner.sync();
  assert.equal(owner.fs.text('b.md'), 'b\n');
});

test('a key file whose chunk sizes no device would use is refused, rather than cutting files forever', async () => {
  const { owner, mem, net } = await memberShare();
  owner.fs.put('a.md', 'a\n');
  await owner.sync();
  const header = JSON.parse(text(mem.objects.get('vault.json')!.data)) as { chunk: unknown };
  const good = header.chunk;
  for (const chunk of [{ min: 0, avg: 0, max: 0 }, { min: 1, avg: 2, max: 3 }, { min: 8192, avg: 4096, max: 65536 }, { min: 4096, avg: 16384, max: 2 ** 40 }, { min: 4096.5, avg: 16384, max: 65536 }, null]) {
    header.chunk = chunk;
    await mem.put('vault.json', utf8.encode(JSON.stringify(header)));
    owner.restart();
    await assert.rejects(owner.sync(), /chunk sizes/, JSON.stringify(chunk));
  }
  header.chunk = good;
  await mem.put('vault.json', utf8.encode(JSON.stringify(header)));
  owner.restart();
  await owner.sync();
  await assert.rejects(
    createMemberShare(new MemoryStore(), { owner: 'Vu', device: 'mac', passphrase: 'owner passphrase', kdfIterations: 1000, chunk: { min: 0, avg: 0, max: 0 } }),
    /chunk sizes are not/,
  );
  void net;
});

test('an object at pruned or in idx/ that cannot be opened breaks neither history nor cleanup, and is written again', async () => {
  const cfg = { snapshotEvery: 5, retentionDays: 1 };
  const { owner, keys, net, mem, clock } = await memberShare(cfg);
  for (let i = 0; i < 7; i++) {
    owner.fs.put('a.md', `v${i}\n`);
    await owner.sync();
  }
  await mem.put('pruned', random(100, 8));
  await mem.put(seqKey('idx', 5), random(100, 9));
  assert.equal((await owner.engine.history('a.md')).length, 7);
  assert.equal(await (await owner.engine.view()).repo.prunedTo(), 0);
  assert.ok((await (await rawRepo(net, keys)).loadDigest(5, 5)).commits!.every((c) => c.sig), 'the digest was written again');
  clock.now += 3 * DAY;
  owner.fs.put('a.md', 'late\n');
  await owner.sync();
  await owner.engine.gc();
  assert.ok((await (await owner.engine.view()).repo.prunedTo()) > 0, 'cleanup wrote the record again');
});
