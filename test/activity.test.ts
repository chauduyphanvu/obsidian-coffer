import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repo } from '../src/core/repo.ts';
import { LocalState } from '../src/core/state.ts';
import { listActivity, type Activity } from '../src/core/timeline.ts';
import { sameContent, type Entry } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { SimStore } from '../src/testing/netsim.ts';
import { ActivityPages, activityRows, arrivalLine, memberEvents, memberName, savedBy, whoLabel, type Self } from '../src/plugin/activity.ts';
import type { Member, MemberChange } from '../src/core/members.ts';
import type { Arrival } from '../src/core/engine.ts';
import { Device, TEST_CONFIG, memberShare } from './helpers.ts';

const files = (a: Activity) => [a.seq, a.device, a.added, a.changed, a.deleted];

/** What each commit did, the slow obvious way: the vault before and after it, by replaying the log. */
async function truth(repo: Repo, last: number): Promise<Map<number, [string[], string[], string[]]>> {
  const out = new Map<number, [string[], string[], string[]]>();
  const st = new LocalState();
  for (let seq = 1; seq <= last; seq++) {
    const c = (await repo.readCommit(seq))!;
    const before = new Map<string, Entry>(st.remote);
    st.apply(c);
    if (c.moved) continue;
    const added: string[] = [];
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const { path, entry } of c.changes) {
      const was = before.get(path);
      if (!entry) deleted.push(path);
      else if (!was) added.push(path);
      else if (!sameContent(was, entry)) changed.push(path);
    }
    out.set(seq, [added.sort(), changed.sort(), deleted.sort()]);
  }
  return out;
}

test('activity lists every commit newest first with the files it added, changed and deleted, leaves out moves, and pages', async () => {
  const clock = { now: 1_800_000_000_000 };
  const net = new SimStore(new MemoryStore(() => clock.now));
  // Snapshots and digests every 4 commits, so pages start inside intervals and settle across them.
  const [a, b] = ['A', 'B'].map((n) => new Device(n, net, clock, { snapshotEvery: 4 }));
  const step = async (d: Device, edit: () => void) => {
    clock.now += 60_000;
    edit();
    await d.sync();
  };
  await step(a, () => (a.fs.put('one.md', '1\n'), a.fs.put('two.md', '2\n')));
  await b.sync();
  await step(b, () => b.fs.put('one.md', '1 by B\n'));
  await a.sync();
  await step(a, () => (a.fs.remove('two.md'), a.fs.put('three.md', '3\n')));
  for (let i = 0; i < 6; i++) {
    const d = i % 2 ? a : b;
    await step(d, () => d.fs.put(i === 4 ? 'four.md' : 'one.md', `edit ${i}\n`));
  }
  await a.sync();
  const repo = await Repo.open(net, 'test passphrase', { kdfIterations: TEST_CONFIG.kdfIterations!, chunk: TEST_CONFIG.chunk! });
  const st = LocalState.parse(await a.state.load());
  // A commit that only moves stored data is not activity.
  await repo.writeCommit({ seq: st.lastSeq + 1, device: 'A', time: clock.now, changes: [{ path: 'three.md', entry: st.remote.get('three.md')! }], prev: st.head, moved: true });
  const last = st.lastSeq + 1;
  const cfg = a.config;

  const all = await listActivity(repo, last, cfg);
  assert.equal(all.next, undefined);
  const expected = await truth(repo, last);
  assert.deepEqual(all.items.map((x) => x.seq), [...expected.keys()].reverse());
  for (const x of all.items) assert.deepEqual([x.added, x.changed, x.deleted], expected.get(x.seq), `commit ${x.seq}`);
  assert.deepEqual(files(all.items.at(-1)!), [1, 'A', ['one.md', 'two.md'], [], []]);
  assert.deepEqual(files(all.items.at(-3)!), [3, 'A', ['three.md'], [], ['two.md']]);

  // Pages of three, each continuing where the last stopped, list every commit once and alike.
  const paged: Activity[] = [];
  for (let before: number | undefined = Infinity; before !== undefined; ) {
    const page = await listActivity(repo, last, cfg, { limit: 3, beforeSeq: before });
    assert.ok(page.items.length <= 3);
    paged.push(...page.items);
    before = page.next;
  }
  assert.deepEqual(paged, all.items);
});

test('in a shared folder with members, activity names each change’s member, and the member changes with the lists before and after', async () => {
  const { owner, writer, join, keys } = await memberShare();
  owner.fs.put('plan.md', 'v1\n');
  await owner.sync();
  const lan = await writer('Lan');
  await lan.sync();
  lan.fs.put('plan.md', 'v2\n');
  await lan.sync();
  const tom = await join('Tom', 'read');
  await tom.sync();
  await owner.engine.removeMember(tom.keys!.id);
  await owner.sync();
  const { repo, st } = await owner.engine.view();
  const { items } = await listActivity(repo, st.lastSeq, owner.config);
  const names = (list: { name: string; pub?: string }[]) => list.map((m) => `${m.name}${m.pub ? '+' : ''}`);
  assert.deepEqual(
    items.map((x) => (x.members ? ['members', names(x.members.before), names(x.members.after)] : [x.signer, x.added, x.changed])),
    [
      ['members', ['Vu+', 'Lan+', 'Tom'], ['Vu+', 'Lan+']],
      ['members', ['Vu+', 'Lan+'], ['Vu+', 'Lan+', 'Tom']],
      [lan.keys!.id, [], ['plan.md']],
      ['members', ['Vu+', 'Lan'], ['Vu+', 'Lan+']],
      ['members', ['Vu+'], ['Vu+', 'Lan']],
      [keys.id, ['plan.md'], []],
      ['members', [], ['Vu+']],
    ],
  );
});

const m = (id: string, name: string, role: Member['role'], o: Partial<Member> = {}): Member => ({ id, name, role, ...o });

test('member changes read as who started the folder, was invited, joined or was removed', () => {
  const vu = m('vuvuvuvu', 'Vu', 'owner', { pub: 'p' });
  assert.deepEqual(memberEvents([], [vu]), ['Vu started sharing this folder']);
  const lan = m('lanlanla', 'Lan', 'write');
  const mai = m('maimaima', 'Mai', 'read');
  const pub = m('pubpubpu', 'Public readers', 'read', { follow: true });
  assert.deepEqual(memberEvents([vu], [vu, lan, mai, pub]), ['Lan was invited to edit', 'Mai was invited to read', 'A follow link, “Public readers”, was made']);
  assert.deepEqual(memberEvents([vu, lan], [vu, { ...lan, pub: 'q' }]), ['Lan joined']);
  assert.deepEqual(memberEvents([vu, lan, pub], [vu]), ['Lan was removed', 'The follow link “Public readers” was removed']);
  assert.deepEqual(memberEvents([vu, lan], [vu, lan]), [], 'a list put back as it was says nothing');
});

test('who made a change: a member by the name it had then, this device’s own member as you, a device in a folder shared with a passphrase', () => {
  const changes: MemberChange[] = [
    { seq: 1, gen: 1, members: [m('vuvuvuvu', 'Vu', 'owner', { pub: 'p' })] },
    { seq: 3, gen: 2, members: [m('vuvuvuvu', 'Vu', 'owner', { pub: 'p' }), m('tomtomto', 'Tom', 'write', { pub: 't' })] },
    { seq: 9, gen: 3, members: [m('vuvuvuvu', 'Vu', 'owner', { pub: 'p' })] },
  ];
  const self: Self = { member: 'vuvuvuvu', device: 'mac', changes };
  assert.equal(memberName(changes, 'tomtomto', 5), 'Tom');
  assert.equal(memberName(changes, 'tomtomto', 12), 'Tom', 'removed since: the name it had');
  assert.equal(memberName(changes, 'nobodyyy', 5), undefined);
  assert.equal(whoLabel({ seq: 5, device: 'tom-phone', signer: 'tomtomto' }, self), 'Tom');
  assert.equal(whoLabel({ seq: 5, device: 'mac', signer: 'vuvuvuvu' }, self), 'You');
  assert.equal(whoLabel({ seq: 5, device: 'iphone', signer: 'vuvuvuvu' }, self), 'You, on iphone');
  assert.equal(whoLabel({ seq: 5, device: 'odd', signer: 'nobodyyy' }, self), 'odd');
  const legacy: Self = { device: 'mac', changes: [] };
  assert.equal(whoLabel({ seq: 5, device: 'mac' }, legacy), 'This device');
  assert.equal(whoLabel({ seq: 5, device: 'desktop-ab12' }, legacy), 'desktop-ab12');
});

test('Versions name who saved each version as Activity does in a shared folder with members, and the device elsewhere', async () => {
  const { owner, writer, keys } = await memberShare();
  owner.fs.put('plan.md', 'v1\n');
  await owner.sync();
  const ann = await writer('Ann');
  await ann.sync();
  ann.fs.put('plan.md', 'v2\n');
  await ann.sync();
  await owner.sync();
  const { st } = await owner.engine.view();
  const self: Self = { member: keys.id, device: owner.config.deviceName, changes: [...st.members] };
  const versions = await owner.engine.history('plan.md');
  assert.deepEqual(versions.map((v) => savedBy(v, self)), ['Ann', 'you']);
  assert.deepEqual(versions.map((v) => v.signer), [ann.keys!.id, keys.id]);
  assert.equal(savedBy({ seq: 5, device: 'ann-mbp', signer: keys.id }, self), 'you, on ann-mbp');
  // The vault, or a folder shared with a passphrase: nobody signs, so the device.
  const legacy: Self = { device: 'mac', changes: [] };
  assert.equal(savedBy({ seq: 5, device: 'mac' }, legacy), 'this device');
  assert.equal(savedBy({ seq: 5, device: 'ann-mbp' }, legacy), 'ann-mbp');
});

test('the Activity rows: a row per change with its files, changed first, and a row per member event', () => {
  const self: Self = { member: 'vuvuvuvu', device: 'mac', changes: [{ seq: 1, gen: 1, members: [m('vuvuvuvu', 'Vu', 'owner', { pub: 'p' }), m('lanlanla', 'Lan', 'write', { pub: 'q' })] }] };
  const rows = activityRows(
    [
      { seq: 4, time: 40, device: 'lan', signer: 'lanlanla', added: ['b.md'], changed: ['a.md'], deleted: ['c.md'] },
      { seq: 3, time: 30, device: 'mac', signer: 'vuvuvuvu', added: [], changed: [], deleted: [], members: { before: [m('vuvuvuvu', 'Vu', 'owner'), m('tomtomto', 'Tom', 'read')], after: [m('vuvuvuvu', 'Vu', 'owner')] } },
      { seq: 2, time: 20, device: 'mac', signer: 'vuvuvuvu', added: [], changed: [], deleted: [], members: { before: [], after: [] } },
    ],
    self,
  );
  assert.deepEqual(rows, [
    { seq: 4, time: 40, who: 'Lan', text: '1 added, 1 changed, 1 deleted', files: [{ path: 'a.md', kind: 'changed' }, { path: 'b.md', kind: 'added' }, { path: 'c.md', kind: 'deleted' }] },
    { seq: 3, time: 30, who: '', text: 'Tom was removed', files: [] },
  ]);
});

test('the notice after a sync names who else changed how many files, together, and stays quiet for this device’s own member', () => {
  const a = (signer: string | undefined, name: string, paths: string[], device = 'phone'): Arrival => ({ seq: 1, time: 1, device, ...(signer && { signer, name }), paths });
  const self: Self = { member: 'vuvuvuvu', device: 'mac', changes: [] };
  assert.equal(arrivalLine('Family', [a('lanlanla', 'Lan', ['a.md', 'b.md']), a('lanlanla', 'Lan', ['b.md', 'c.md'])], self), 'Lan changed 3 notes in “Family”');
  assert.equal(arrivalLine('Family', [a('lanlanla', 'Lan', ['a.md']), a('tomtomto', 'Tom', ['x.png'])], self), 'Lan and Tom changed 2 files in “Family”');
  assert.equal(
    arrivalLine('Family', [a('lanlanla', 'Lan', ['a.md']), a('tomtomto', 'Tom', ['b.md']), a('maimaima', 'Mai', ['c.md']), a('annannan', 'Ann', ['d.md'])], self),
    'Lan, Tom and 2 others changed 4 notes in “Family”',
  );
  assert.equal(arrivalLine('Family', [a('vuvuvuvu', 'Vu', ['a.md'], 'iphone')], self), '', 'the owner’s own other device');
  assert.equal(arrivalLine('Work', [a(undefined, '', ['a.md'], 'desktop-1')], { device: 'mac', changes: [] }), 'desktop-1 changed 1 note in “Work”');
  assert.equal(arrivalLine('Work', [a(undefined, '', ['a.md'], 'mac')], { device: 'mac', changes: [] }), '');
  assert.equal(arrivalLine('Work', [], self), '');
});

test('activity pages continue where the last one stopped, and a page still loading when the place changes is dropped', async () => {
  const item = (seq: number) => ({ seq, time: seq, device: 'd', added: [], changed: [], deleted: [] });
  const asked: (number | undefined)[] = [];
  let release!: () => void;
  let hold = false;
  const pages = new ActivityPages(
    async () => 'look',
    async (_look: string, before: number | undefined) => {
      asked.push(before);
      if (hold) await new Promise<void>((r) => (release = r));
      const top = Math.min(before === undefined ? 5 : before - 1, 5);
      const items = [top, top - 1].filter((s) => s > 0).map(item);
      return { items, ...(items.at(-1)!.seq > 1 && { next: items.at(-1)!.seq }) };
    },
  );
  assert.ok(await pages.next());
  assert.ok(await pages.next());
  assert.ok(await pages.next());
  assert.equal(pages.more, false);
  assert.ok(!(await pages.next()), 'nothing more to load');
  assert.deepEqual(pages.items.map((x) => x.seq), [5, 4, 3, 2, 1]);
  assert.deepEqual(asked, [undefined, 4, 2]);
  pages.reset();
  hold = true;
  const loading = pages.next();
  await new Promise((r) => setTimeout(r, 0));
  pages.reset();
  release();
  assert.ok(!(await loading));
  assert.deepEqual(pages.items, []);
});

test('activity for a legacy shared folder reads device names, through the same steps the screen takes', async () => {
  const clock = { now: 1_800_000_000_000 };
  const net = new SimStore(new MemoryStore(() => clock.now));
  const [a, b] = ['mac', 'desktop-1'].map((n) => new Device(n, net, clock));
  a.fs.put('a.md', 'a\n');
  await a.sync();
  await b.sync();
  b.fs.put('a.md', 'a, by B\n');
  const r = await b.sync();
  assert.deepEqual(r.arrived, []);
  const got = await a.sync();
  assert.equal(arrivalLine('Work', got.arrived, { device: 'mac', changes: [] }), 'desktop-1 changed 1 note in “Work”');
  const { repo, st } = await a.engine.view();
  const { items } = await listActivity(repo, st.lastSeq, a.config);
  assert.deepEqual(activityRows(items, { device: 'mac', changes: [] }).map((x) => [x.who, x.text]), [['desktop-1', '1 changed'], ['This device', '1 added']]);
});
