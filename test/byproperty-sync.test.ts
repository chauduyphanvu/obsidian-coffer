// Notes shared by a property, synced: the sharer's device (the hub) runs the vault's engine and the share's on one
// vault, another of the sharer's devices syncs the vault, and people invited read the share. Also the three small
// changes to the engine it needs (`LocalFS.list` with what is held, `only`, `sendOnly`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SafetyError, SyncEngine } from '../src/core/engine.ts';
import { decodeInvite, encodeInvite, type MemberKeys } from '../src/core/members.ts';
import { createMemberShare, joinShare } from '../src/core/membership.ts';
import { Repo } from '../src/core/repo.ts';
import { resolveConfig } from '../src/core/config.ts';
import type { Held, LocalFS, LocalFile } from '../src/core/types.ts';
import { PropertyFS, VaultNotListedError, otherSender, settleChoices, withShare, withoutShare } from '../src/plugin/byproperty.ts';
import { defaultSettings, shareWith, type Settings, type Share } from '../src/plugin/settings.ts';
import { makeEngine, syncAll, type EngineHost } from '../src/plugin/shares.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { DAY, Device, FakeCatalog, TEST_CONFIG } from './helpers.ts';

const NAME = 'Family';
const PLUGIN_DIR = '.obsidian/plugins/coffer';
const marked = (body: string) => `---\nshare: Family\n---\n${body}`;

/** A vault as the app has it: files, and the folders that hold them. */
class VaultFS extends MemFS {
  async listFolder(folder: string) {
    const files = (await this.list()).filter((f) => f.path.startsWith(`${folder}/`));
    return files.length ? files : null;
  }
  /** Renamed or moved as Obsidian does: the same bytes and time. */
  move(from: string, to: string): void {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
}

/** The sharer's device: its vault syncing with the vault's storage, and the notes it shares by a property. */
class Hub {
  fs = new VaultFS();
  catalog = new FakeCatalog(this.fs, NAME);
  states = new Map<string, MemState>();
  settings: Settings;
  share: Share;
  host: EngineHost;
  private engines = new Map<string, ReturnType<typeof makeEngine>>();

  constructor(w: { clock: { now: number }; vault: MemoryStore; family: MemoryStore; keys: MemberKeys }, device = 'mac') {
    this.settings = { ...defaultSettings(false), deviceName: device, endpoint: 'https://s3.test', bucket: 'b', prefix: 'vault', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'vp' };
    this.share = shareWith({ id: 'fam', folder: '', property: NAME, role: 'owner', memberKeysSecret: 'mk', endpoint: 'https://s3.test', bucket: 'b', prefix: 'family', accessKeySecret: 'ak', secretKeySecret: 'sk' });
    this.settings.shares.push(this.share);
    const secrets: Record<string, string> = { ak: 'AK', sk: 'SK', vp: 'test passphrase', mk: JSON.stringify(w.keys) };
    this.host = {
      settings: this.settings,
      configDir: '.obsidian',
      pluginDir: PLUGIN_DIR,
      files: this.fs,
      secret: (n) => secrets[n] ?? '',
      openStore: (spec) => (spec.type === 's3' && spec.prefix === 'vault' ? w.vault : w.family),
      stateStore: (path) => {
        if (!this.states.has(path)) this.states.set(path, new MemState());
        return this.states.get(path)!;
      },
      notes: { files: this.fs, catalog: this.catalog },
    };
    this.catalog.refresh();
  }

  scope(share?: Share) {
    const key = share?.id ?? '';
    if (!this.engines.has(key)) this.engines.set(key, makeEngine(this.host, share, { now: () => Date.now() }));
    return this.engines.get(key)!;
  }

  get engine(): SyncEngine {
    return this.scope(this.share).engine;
  }

  get pfs(): PropertyFS {
    return this.scope(this.share).fs as PropertyFS;
  }

  /** The share's sync as the app runs it: listing everything, with the removals the sharer confirmed. */
  syncShare(force = false) {
    return this.engine.sync({ force, allowDeletes: this.share.removed });
  }

  /** One run as the app does it: the vault first, then the share; the sharer's choices settled after. */
  async run() {
    const out = await syncAll(this.settings, this.host.secret, (s) => (s ? this.syncShare() : this.scope().engine.sync()));
    for (const o of out) if (o.error) throw o.error;
    const survey = this.pfs.survey();
    if (survey) Object.assign(this.share, settleChoices(this.share, (k) => this.fs.files.has(k), survey.held));
    return out;
  }

  /** Taken out with the command: kept out, and its property taken off. */
  remove(...paths: string[]): void {
    this.share.removed.push(...paths);
    for (const p of paths) if (p.endsWith('.md')) this.fs.put(p, withoutShare(this.fs.text(p)!, NAME)!);
  }

  restart(): void {
    this.engines.clear();
  }
}

async function world() {
  const clock = { now: 1_800_000_000_000 };
  const vault = new MemoryStore(() => clock.now);
  await Repo.open(vault, 'test passphrase', { kdfIterations: TEST_CONFIG.kdfIterations!, chunk: TEST_CONFIG.chunk! });
  const family = new MemoryStore(() => clock.now);
  const keys = await createMemberShare(family, { owner: 'Vu', device: 'mac', passphrase: 'unused passphrase', kdfIterations: 1000, chunk: TEST_CONFIG.chunk!, now: clock.now });
  const w = { clock, vault, family, keys };
  const hub = new Hub(w);
  const phone = new Device('phone', vault, clock);
  /** Someone invited to read: their device only receives. */
  const reader = async (name = 'Lan') => {
    const grant = await hub.engine.invite({ name, role: 'read', expires: clock.now + 7 * DAY });
    const joined = await joinShare(family, decodeInvite(encodeInvite({ ...grant, storage: { bucket: 'b' }, share: NAME, folder: NAME })), clock.now);
    return new Device(name, family, clock, { readOnly: true }, joined);
  };
  return { ...w, hub, phone, reader };
}

const paths = (fs: MemFS) => [...fs.files.keys()].sort();

test('the shared notes and the files they show reach people, at their vault paths; nothing else does', async () => {
  const { hub, reader } = await world();
  hub.fs.put('Recipes/Pie.md', marked('![[pie.jpg]]'));
  hub.fs.put('Attachments/pie.jpg', 'jpg');
  hub.fs.put('Diary.md', 'private');
  hub.fs.put('secret.png', 'private picture');
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Attachments/pie.jpg', 'Recipes/Pie.md']);
  assert.equal(lan.fs.text('Recipes/Pie.md'), marked('![[pie.jpg]]'));
});

test('I1 I4: a cache that is not ready or forgets everything sends no deletion; a note just written joins later', async () => {
  const { hub, reader } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.fs.put('Cake.md', marked('cake'));
  hub.catalog.refresh();
  await hub.run();
  hub.catalog.isReady = false;
  hub.catalog.says.clear();
  hub.restart();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Cake.md', 'Pie.md']);
  // A note the vault's sync just wrote, before the cache read it: nothing meanwhile, then it joins.
  hub.catalog.isReady = true;
  hub.catalog.refresh();
  hub.fs.put('Soup.md', marked('soup'));
  await hub.run();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Cake.md', 'Pie.md']);
  hub.catalog.refresh();
  await hub.run();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Cake.md', 'Pie.md', 'Soup.md']);
});

test('B1: a note that stops saying share is neither sent nor deleted until the sharer chooses', async () => {
  const { hub, reader } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  // The sharer takes the property off by hand, then writes something private.
  hub.fs.put('Pie.md', 'pie, and a private thought');
  hub.catalog.refresh();
  await hub.run();
  await hub.run();
  await lan.sync();
  assert.equal(lan.fs.text('Pie.md'), marked('pie'), 'not sent');
  assert.deepEqual(hub.pfs.survey()!.unmarked, ['Pie.md']);
  // "Keep in Family" writes the property back: then it is sent.
  hub.fs.put('Pie.md', withShare(hub.fs.text('Pie.md')!, NAME)!);
  hub.catalog.refresh();
  await hub.run();
  await lan.sync();
  assert.ok(lan.fs.text('Pie.md')!.includes('private thought'));
  // Or, after it stopped saying share again, "Remove from Family": a deletion the sharer confirmed.
  hub.fs.put('Pie.md', 'private again');
  await hub.run();
  hub.remove('Pie.md');
  const r = await hub.syncShare();
  assert.equal(r.deletedRemote, 1);
  await lan.sync();
  assert.deepEqual(paths(lan.fs), []);
  assert.equal(hub.fs.text('Pie.md'), 'private again', 'the sharer keeps it');
});

test('I2 I12: "Remove from Family" sends a confirmed deletion at once, nothing else changed; no guard trips anywhere', async () => {
  const { hub, reader } = await world();
  for (let i = 0; i < 20; i++) hub.fs.put(`n${i}.md`, marked(`note ${i}`));
  hub.fs.put('List.md', '---\nshare: [family, work]\n---\nlist');
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  // 15 of 21 at once, which a deletion seen happening would be refused for.
  const gone = Array.from({ length: 14 }, (_, i) => `n${i}.md`);
  hub.remove(...gone, 'List.md');
  assert.equal(hub.fs.text('List.md'), '---\nshare: [work]\n---\nlist');
  const r = await hub.syncShare();
  assert.equal(r.deletedRemote, 15);
  const { repo, st } = await hub.engine.view();
  const c = (await repo.readCommit(st.lastSeq))!;
  assert.equal(c.confirmed, true);
  assert.equal(c.changes.length, 15);
  await lan.sync();
  assert.equal(paths(lan.fs).length, 6);
  for (const p of [...gone, 'List.md']) assert.ok(hub.fs.files.has(p), `${p} stays with the sharer`);
  // A cache that still says List.md is shared does not bring it back.
  hub.catalog.says.add('List.md');
  await hub.run();
  await lan.sync();
  assert.ok(!lan.fs.files.has('List.md'));
});

test('I2: the sharer deleting shared notes deletes them for people, and many at once pause first', async () => {
  const { hub, reader } = await world();
  hub.fs.put('Diary.md', 'private, not shared');
  for (let i = 0; i < 12; i++) hub.fs.put(`n${i}.md`, marked(`note ${i}`));
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  hub.fs.files.delete('n0.md');
  hub.catalog.refresh();
  await hub.run();
  await lan.sync();
  assert.ok(!lan.fs.files.has('n0.md'));
  for (let i = 1; i < 12; i++) hub.fs.files.delete(`n${i}.md`);
  hub.catalog.refresh();
  await assert.rejects(hub.syncShare(), SafetyError);
  // Keeping them keeps them for people: nothing is written back into the vault.
  await hub.engine.keepAllFiles();
  await hub.syncShare();
  assert.deepEqual(paths(hub.fs), ['Diary.md']);
  await lan.sync();
  assert.equal(paths(lan.fs).length, 11);
});

test('I2: an empty file list while the share holds files stops the sync, and sends nothing', async () => {
  const { hub, family } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.catalog.refresh();
  await hub.run();
  const before = (await family.list('log/')).length;
  const all = new Map(hub.fs.files);
  hub.fs.files.clear();
  await assert.rejects(hub.syncShare(), VaultNotListedError);
  assert.equal((await family.list('log/')).length, before);
  hub.fs.files = all;
});

test('I5 I10: carrying on from storage, or losing the state, writes nothing into the vault; the vault’s files win', async () => {
  const { hub, reader, family } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.fs.put('Cake.md', marked('cake'));
  hub.catalog.refresh();
  await hub.run();
  // Storage holds Pie as it was; here it changed while the state was lost, and Cake lost its property before that.
  hub.fs.put('Cake.md', 'cake, private');
  hub.states.delete(`${PLUGIN_DIR}/state-fam.json`);
  hub.fs.put('Pie.md', marked('pie, newer'));
  hub.restart();
  const before = new Map([...hub.fs.files].map(([k, f]) => [k, f.mtime]));
  await hub.run();
  assert.deepEqual(new Map([...hub.fs.files].map(([k, f]) => [k, f.mtime])), before, 'nothing written or removed');
  const lan = await reader();
  await lan.sync();
  assert.equal(lan.fs.text('Pie.md'), marked('pie, newer'));
  assert.equal(lan.fs.text('Cake.md'), marked('cake'), 'kept in storage, not deleted, not sent');
  await hub.engine.acceptStorage();
  await hub.run();
  assert.deepEqual(new Map([...hub.fs.files].map(([k, f]) => [k, f.mtime])), before);
  assert.ok((await family.list('log/')).length > 0);
});

test('core: an engine that only sends sends its files again over what storage lost, and never writes', async () => {
  const clock = { now: 1_800_000_000_000 };
  const store = new MemoryStore(() => clock.now);
  const mac = new Device('mac', store, clock);
  mac.fs.put('a.md', 'a');
  mac.fs.put('b.md', 'b');
  await mac.sync();
  // Another device deletes b and changes a (as an older state of this one would see it).
  const other = new Device('other', store, clock);
  await other.sync();
  other.fs.put('a.md', 'a from elsewhere');
  other.fs.files.delete('b.md');
  other.fs.put('c.md', 'only in storage');
  await other.sync();
  const writes: string[] = [];
  const fs = Object.assign(Object.create(mac.fs) as MemFS, {
    write: async (p: string) => {
      writes.push(p);
      throw new Error('no');
    },
    remove: async (p: string) => {
      writes.push(p);
      throw new Error('no');
    },
  });
  const engine = new SyncEngine({ fs, store, stateStore: mac.state, passphrase: 'test passphrase', config: mac.config, sendOnly: true });
  const r = await engine.sync();
  assert.deepEqual(writes, []);
  assert.deepEqual(r.errors, []);
  assert.equal(r.pulled + r.deletedLocal, 0);
  await other.sync();
  assert.equal(other.fs.text('a.md'), 'a');
  assert.equal(other.fs.text('b.md'), 'b');
  assert.equal(other.fs.text('c.md'), 'only in storage');
});

test('core: an engine leaves alone what `only` does not take, and lists with what it holds', async () => {
  const clock = { now: 1_800_000_000_000 };
  const store = new MemoryStore(() => clock.now);
  const mac = new Device('mac', store, clock);
  mac.fs.put('a.md', 'a');
  mac.fs.put('b.md', 'b');
  await mac.sync();
  let take = (k: string) => k !== 'b.md';
  const seen: { keys: string[]; b?: { size: number; mtime: number } }[] = [];
  const fs = Object.assign(Object.create(mac.fs) as MemFS, {
    list: async (held?: Held): Promise<LocalFile[]> => {
      if (held) seen.push({ keys: [...held.keys()].sort(), b: held.get('b.md') });
      return mac.fs.list();
    },
  });
  const engine = new SyncEngine({ fs, store, stateStore: mac.state, passphrase: 'test passphrase', config: mac.config, only: (k) => take(k) });
  mac.fs.put('b.md', 'b changed');
  mac.fs.files.delete('a.md');
  mac.fs.put('a.md', 'a changed');
  await engine.sync();
  const other = new Device('other', store, clock);
  await other.sync();
  assert.equal(other.fs.text('a.md'), 'a changed');
  assert.equal(other.fs.text('b.md'), 'b', 'not sent');
  mac.fs.files.delete('b.md');
  await engine.sync();
  await other.sync();
  assert.equal(other.fs.text('b.md'), 'b', 'nor deleted');
  take = () => true;
  await engine.sync();
  await other.sync();
  assert.ok(!other.fs.files.has('b.md'), 'once taken, it syncs again');
  assert.deepEqual(seen[0].keys, ['a.md', 'b.md']);
  assert.deepEqual(seen[0].b && Object.keys(seen[0].b).sort(), ['mtime', 'size']);
});

test('I6: a note in another shared folder, a left-out folder or the settings folder is not sent, even when the vault syncs them', async () => {
  const { hub, reader } = await world();
  hub.settings.exclude = 'Private/';
  hub.settings.shares.push(shareWith({ id: 'w', folder: 'Work', endpoint: 'https://s3.test', bucket: 'b', prefix: 'work', accessKeySecret: 'ak', secretKeySecret: 'sk' }));
  for (const p of ['Work/plan.md', 'Private/x.md', '.obsidian/snippets/s.md', 'ok.md']) hub.fs.put(p, marked(p));
  hub.catalog.refresh();
  for (const p of hub.fs.files.keys()) hub.catalog.says.add(p);
  await hub.syncShare();
  const lan = await reader();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['ok.md']);
  assert.deepEqual(hub.pfs.survey()!.notShared.map((n) => n.key).sort(), ['.obsidian/snippets/s.md', 'Private/x.md', 'Work/plan.md']);
});

test('I8: changes from the sharer’s other devices reach people through the hub; the share changes nothing the vault sees', async () => {
  const { hub, phone, reader, vault } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.catalog.refresh();
  await hub.run();
  await phone.sync();
  phone.fs.put('Pie.md', marked('pie, from the phone'));
  phone.fs.put('Soup.md', marked('soup, from the phone'));
  await phone.sync();
  await hub.run();
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  assert.equal(lan.fs.text('Pie.md'), marked('pie, from the phone'));
  assert.equal(lan.fs.text('Soup.md'), marked('soup, from the phone'));
  // Stopping the share: the vault's next sync has nothing to do.
  const logs = (await vault.list('log/')).length;
  hub.settings.shares = [];
  hub.restart();
  const r = await hub.scope().engine.sync();
  assert.equal(r.commits, 0);
  assert.equal((await vault.list('log/')).length, logs);
});

test('I13 B3: a rename on the hub, or a move the vault brings from the phone, is a move for people', async () => {
  const { hub, phone, reader } = await world();
  hub.fs.put('Recipes/Pie.md', marked('![[pie.jpg]]'));
  hub.fs.put('pie.jpg', 'jpg');
  for (let i = 0; i < 3; i++) hub.fs.put(`Recipes/n${i}.md`, marked(`${i}`));
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  // A folder renamed in Obsidian on the hub, and the cache not caught up yet.
  for (const p of [...hub.fs.files.keys()]) if (p.startsWith('Recipes/')) hub.fs.move(p, `Dinner/${p.slice(8)}`);
  hub.catalog.isReady = false;
  const r = await hub.syncShare();
  assert.equal(r.deletedRemote, 4);
  assert.equal(r.pushed, 4);
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Dinner/Pie.md', 'Dinner/n0.md', 'Dinner/n1.md', 'Dinner/n2.md', 'pie.jpg']);
  // A picture, which no property brings back, moved on the phone: the vault brings the move, the share follows it.
  hub.catalog.isReady = true;
  await hub.run();
  await phone.sync();
  phone.fs.files.set('Attachments/pie.jpg', phone.fs.files.get('pie.jpg')!);
  phone.fs.files.delete('pie.jpg');
  await phone.sync();
  hub.catalog.isReady = false;
  await hub.run();
  assert.deepEqual(hub.pfs.survey()!.moved, [['pie.jpg', 'Attachments/pie.jpg']]);
  await lan.sync();
  assert.ok(lan.fs.files.has('Attachments/pie.jpg') && !lan.fs.files.has('pie.jpg'));
});

test('P1: a folder of shared notes made together, with the same size and time, moves for people as moves, renamed too, not as new notes', async () => {
  const { hub, reader } = await world();
  const club = [0, 1, 2, 3, 4, 5].map((i) => `Club/Meeting 0${i}.md`);
  for (const [i, p] of club.entries()) hub.fs.files.set(p, { data: new TextEncoder().encode(marked(`m${i}`)), mtime: 1_700_000_000_000 });
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  for (const p of club) hub.fs.move(p, `Groups/${p}`);
  hub.catalog.refresh();
  await hub.run();
  let v = hub.pfs.survey()!;
  assert.deepEqual(v.moved.sort(), club.map((p) => [p, `Groups/${p}`]));
  assert.deepEqual(v.fresh, []);
  // Renamed as well, so no name matches: what each holds still tells them apart.
  for (const p of club) hub.fs.move(`Groups/${p}`, `Groups/Club/Old ${p.slice(5)}`);
  hub.catalog.refresh();
  await hub.run();
  v = hub.pfs.survey()!;
  assert.deepEqual(v.moved.sort(), club.map((p) => [`Groups/${p}`, `Groups/Club/Old ${p.slice(5)}`]));
  assert.deepEqual(v.fresh, []);
  await lan.sync();
  assert.deepEqual(paths(lan.fs), club.map((p) => `Groups/Club/Old ${p.slice(5)}`));
  assert.equal(lan.fs.text('Groups/Club/Old Meeting 03.md'), marked('m3'));
});

test('I13: a held file gone with no clear new place is deleted for people, and the sharer keeps whatever is left', async () => {
  const { hub, reader } = await world();
  hub.fs.put('a.png', 'same');
  hub.fs.put('Pie.md', marked('![[a.png]]'));
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  const f = hub.fs.files.get('a.png')!;
  hub.fs.files.delete('a.png');
  hub.fs.files.set('x/a.png', f);
  hub.fs.files.set('y/a.png', f);
  hub.fs.put('Pie.md', marked('no picture'));
  hub.catalog.refresh();
  await hub.run();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Pie.md']);
  assert.ok(hub.fs.files.has('x/a.png') && hub.fs.files.has('y/a.png'));
});

test('I9: a change signed as the hub from another device is found; a second sender is not allowed to go on', async () => {
  const { hub, keys, family, clock } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.catalog.refresh();
  await hub.run();
  // The same keys used on another device, as if copied there by hand.
  const ipad = new Device('ipad', family, clock, {}, keys);
  await ipad.sync();
  ipad.fs.put('Other.md', 'from the ipad');
  await ipad.sync();
  const r = await hub.syncShare();
  assert.equal(otherSender(r.arrived, keys.id, 'mac'), 'ipad');
  assert.ok(!hub.fs.files.has('Other.md'), 'and nothing came into the vault');
});

test('I14: a shared folder and the shared notes sync side by side and touch no file of each other', async () => {
  const { hub, reader } = await world();
  const work = new MemoryStore();
  await Repo.open(work, 'work passphrase', { kdfIterations: 1000, chunk: TEST_CONFIG.chunk! });
  const open = hub.host.openStore;
  hub.host.openStore = (spec) => (spec.type === 's3' && spec.prefix === 'work' ? work : open(spec));
  const secret = hub.host.secret;
  hub.host.secret = (n) => (n === 'wp' ? 'work passphrase' : secret(n));
  hub.settings.shares.push(shareWith({ id: 'w', folder: 'Work', endpoint: 'https://s3.test', bucket: 'b', prefix: 'work', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'wp' }));
  hub.fs.put('Work/plan.md', marked('work plan'));
  hub.fs.put('Pie.md', marked('pie'));
  hub.catalog.refresh();
  await syncAll(hub.settings, hub.host.secret, (s) => (s?.property ? hub.syncShare() : hub.scope(s).engine.sync()));
  const lan = await reader();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Pie.md']);
  const colleague = new Device('c', work, { now: 0 }, {});
  colleague.engine = new SyncEngine({ fs: colleague.fs, store: work, stateStore: colleague.state, passphrase: 'work passphrase', config: resolveConfig({ ...TEST_CONFIG, deviceName: 'c' }) });
  await colleague.engine.sync();
  assert.deepEqual(paths(colleague.fs), ['plan.md']);
});

test('people may read and suggest: a suggestion reaches the hub, and taking it in writes through the vault, not the share', async () => {
  const { hub, family, clock } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.catalog.refresh();
  await hub.run();
  const grant = await hub.engine.invite({ name: 'Mai', role: 'read', expires: clock.now + DAY, suggest: true });
  const joined = await joinShare(family, decodeInvite(encodeInvite({ ...grant, storage: { bucket: 'b' }, share: NAME, folder: NAME })), clock.now);
  const mai = new Device('Mai', family, clock, { readOnly: true }, joined);
  await mai.sync();
  mai.fs.put('Pie.md', marked('pie, with more butter'));
  const r = await mai.sync();
  assert.deepEqual(r.unsent, ['Pie.md']);
  await mai.engine.sendSuggestion(['Pie.md']);
  const { items } = await hub.engine.suggestions();
  assert.equal(items[0].suggestion!.files[0].text, marked('pie, with more butter'));
  // The share itself can not take it in; the app writes it into the vault, and the share sends it as the sharer's.
  await assert.rejects((hub.pfs as LocalFS).write('Pie.md', new TextEncoder().encode('x')), /only sends/);
  hub.fs.put('Pie.md', items[0].suggestion!.files[0].text);
  await hub.run();
  await mai.sync();
  assert.equal(mai.fs.text('Pie.md'), marked('pie, with more butter'));
});

test('“Remove from Family” is sent also for a file only storage holds now, as after this device lost its state', async () => {
  const { hub, reader } = await world();
  hub.fs.put('Pie.md', marked('pie'));
  hub.fs.put('Cake.md', marked('cake'));
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  hub.states.delete(`${PLUGIN_DIR}/state-fam.json`);
  hub.restart();
  hub.remove('Pie.md');
  const r = await hub.syncShare();
  assert.equal(r.deletedRemote, 1);
  assert.equal((await hub.engine.held()).get('Pie.md'), undefined);
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Cake.md']);
  assert.equal(hub.fs.text('Pie.md'), 'pie', 'the sharer keeps it');
});

test('files kept in Family after they were deleted here are listed as only there, and Remove deletes them for people', async () => {
  const { hub, reader } = await world();
  for (let i = 0; i < 12; i++) hub.fs.put(`n${i}.md`, marked(`note ${i}`));
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  for (let i = 1; i < 12; i++) hub.fs.files.delete(`n${i}.md`);
  hub.catalog.refresh();
  await assert.rejects(hub.syncShare(), SafetyError);
  await hub.engine.keepAllFiles();
  await hub.syncShare();
  const kept = Array.from({ length: 11 }, (_, i) => `n${i + 1}.md`).sort();
  assert.deepEqual((await hub.pfs.peek(await hub.engine.held())).stored.sort(), kept);
  hub.share.removed.push('n1.md');
  const r = await hub.syncShare();
  assert.equal(r.deletedRemote, 1);
  await lan.sync();
  assert.ok(!lan.fs.files.has('n1.md'));
  assert.equal(paths(lan.fs).length, 11);
  assert.deepEqual((await hub.pfs.peek(await hub.engine.held())).stored.sort(), kept.filter((k) => k !== 'n1.md'));
});

test('a note or folder renamed only in letter case, on a disk that ignores case, moves for people and leaves no copy under the old name', async () => {
  const { hub, reader } = await world();
  const names = ['Cake', 'Pie', 'Soup'];
  for (const n of names) hub.fs.put(`recipes/${n}.md`, marked(n));
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  // Such a disk answers for a name in any letter case.
  const fs = hub.fs;
  const real = (p: string) => [...fs.files.keys()].find((k) => k.toLowerCase() === p.toLowerCase()) ?? p;
  const stat = fs.stat.bind(fs);
  const read = fs.read.bind(fs);
  fs.stat = (p: string) => stat(real(p));
  fs.read = (p: string) => read(real(p));
  for (const n of names) fs.move(`recipes/${n}.md`, `Recipes/${n}.md`);
  hub.catalog.refresh();
  await hub.run();
  const renamed = names.map((n) => `Recipes/${n}.md`);
  assert.deepEqual([...hub.pfs.survey()!.shared.keys()].sort(), renamed);
  const { st } = await hub.engine.view();
  assert.deepEqual([...st.remote.keys()].sort(), renamed);
  await lan.sync();
  assert.deepEqual(paths(lan.fs), renamed);
});

test('a private copy with the same size and time does not take the place of a shared picture the sharer deleted', async () => {
  const { hub, reader } = await world();
  hub.fs.put('Trips/Paris.md', marked('![[paris.jpg]]'));
  hub.fs.put('Trips/paris.jpg', 'jpg');
  // Copied keeping its time, as Finder or `cp -p` do.
  hub.fs.files.set('Private/Archive/paris-original.jpg', hub.fs.files.get('Trips/paris.jpg')!);
  hub.catalog.refresh();
  await hub.run();
  const lan = await reader();
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Trips/Paris.md', 'Trips/paris.jpg']);
  // The sharer stops showing the picture, and deletes it.
  hub.fs.put('Trips/Paris.md', marked('no picture'));
  hub.fs.files.delete('Trips/paris.jpg');
  hub.catalog.refresh();
  await hub.run();
  assert.deepEqual(hub.pfs.survey()!.moved, []);
  await lan.sync();
  assert.deepEqual(paths(lan.fs), ['Trips/Paris.md']);
});

test('What’s shared, looked at by an engine made again (as after any settings change), lists what the share holds', async () => {
  const { hub } = await world();
  hub.fs.put('A.md', marked('![[pic.png]]'));
  hub.fs.put('B.md', marked('b'));
  hub.fs.put('C.md', marked('c'));
  hub.fs.put('pic.png', 'png');
  hub.catalog.refresh();
  await hub.run();
  hub.fs.put('C.md', 'c, no longer shared');
  hub.catalog.refresh();
  await hub.run();
  const synced = hub.pfs.survey()!;
  assert.deepEqual(synced.unmarked, ['C.md']);
  hub.restart();
  const seen = await hub.pfs.peek(await hub.engine.held());
  assert.deepEqual([...seen.shared.keys()].sort(), ['A.md', 'B.md', 'pic.png']);
  assert.deepEqual(seen.fresh, []);
  assert.deepEqual(seen.unmarked, ['C.md']);
});

test('a picture taken out with its note is listed as taken out once a shared note shows it again, so it can be shared again', async () => {
  const { hub } = await world();
  hub.fs.put('Pie.md', marked('![[pie.jpg]]'));
  hub.fs.put('pie.jpg', 'jpg');
  hub.catalog.refresh();
  await hub.run();
  hub.remove('Pie.md', 'pie.jpg');
  hub.catalog.refresh();
  await hub.run();
  // "Share again" on the note only.
  hub.fs.put('Pie.md', withShare(hub.fs.text('Pie.md')!, NAME)!);
  hub.share.removed = hub.share.removed.filter((k) => k !== 'Pie.md');
  hub.catalog.refresh();
  await hub.run();
  const v = hub.pfs.survey()!;
  assert.deepEqual([...v.shared.keys()], ['Pie.md']);
  assert.deepEqual(v.removedTagged, ['pie.jpg']);
});
