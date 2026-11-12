import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WrongPassphraseError } from '../src/core/crypto.ts';
import type { SyncEngine } from '../src/core/engine.ts';
import { Repo } from '../src/core/repo.ts';
import { MissingFolderError, ScopedFS, type FolderFS } from '../src/core/scopedfs.ts';
import { ChangeLog, type Why } from '../src/plugin/changes.ts';
import { defaultSettings, shareWith, statePath, type Settings, type Share } from '../src/plugin/settings.ts';
import { vaultKey } from '../src/core/paths.ts';
import { followRename, freeTaken, goneWith, inVault, makeEngine, placeOf, rejoin, rejoinNote, syncAll, takeVaultCopies, vaultPath, type EngineHost } from '../src/plugin/shares.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { Device, TEST_CONFIG } from './helpers.ts';

/** A vault on disk: files, and folders that exist even when empty, as Obsidian keeps them. */
class VaultFS extends MemFS implements FolderFS {
  folders = new Set<string>();

  /** Folders are found in any Unicode form, as on macOS and iOS. */
  async listFolder(folder: string) {
    const at = `${folder.normalize('NFC')}/`;
    const files = (await this.list()).filter((f) => f.path.normalize('NFC').startsWith(at));
    return [...this.folders].some((f) => f.normalize('NFC') === folder.normalize('NFC')) || files.length ? files : null;
  }

  /** A folder renamed or moved: its files keep their bytes and times. */
  moveFolder(from: string, to: string): void {
    for (const [path, f] of [...this.files]) {
      if (!path.startsWith(`${from}/`)) continue;
      this.files.delete(path);
      this.files.set(to + path.slice(from.length), f);
    }
    this.folders.delete(from);
    this.folders.add(to);
  }

  dropFolder(folder: string): void {
    for (const path of [...this.files.keys()]) if (path.startsWith(`${folder}/`)) this.files.delete(path);
    this.folders.delete(folder);
  }

  move(from: string, to: string): void {
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
}

/**
 * A vault as Obsidian lists it: its file index has no file or folder whose name starts with a dot, and the settings
 * folder, read file by file when it syncs, without its node_modules folders. Reading, writing and asking about a file
 * by name reach every file, as the vault's adapter does.
 */
class ObsidianLikeFS extends VaultFS {
  withConfig = true;

  override async list() {
    return (await super.list()).filter((f) => {
      const parts = f.path.split('/');
      if (parts[0] === '.obsidian') return this.withConfig && !parts.includes('node_modules');
      return !parts.some((p) => p.startsWith('.'));
    });
  }
}

const PLUGIN_DIR = '.obsidian/plugins/self-sync';

/** One person's device: a vault syncing with its own storage, and the shared folders added to it. */
class Person {
  fs: VaultFS;
  states = new Map<string, MemState>();
  settings: Settings;
  host: EngineHost;
  private engines = new Map<string, SyncEngine>();

  constructor(name: string, stores: Record<string, MemoryStore>, vault: string, secrets: Record<string, string>, fs = new VaultFS()) {
    this.fs = fs;
    this.settings = { ...defaultSettings(false), deviceName: name, endpoint: 'https://s3.test', bucket: 'b', prefix: vault, accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: `pass:${vault}` };
    this.host = {
      settings: this.settings,
      configDir: '.obsidian',
      pluginDir: PLUGIN_DIR,
      files: this.fs,
      secret: (n) => ({ ak: 'AK', sk: 'SK', ...secrets })[n] ?? '',
      openStore: (spec) => stores[spec.type === 's3' ? spec.prefix : spec.url],
      stateStore: (path) => {
        if (!this.states.has(path)) this.states.set(path, new MemState());
        return this.states.get(path)!;
      },
    };
  }

  /** Adds a shared folder as the plugin does: its folder made in the vault, and the vault's own files there noted. */
  async share(id: string, folder: string, remote: string): Promise<Share> {
    const s = shareWith({ id, folder, endpoint: 'https://s3.test', bucket: 'b', prefix: remote, accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: `pass:${remote}` });
    this.restart();
    await takeVaultCopies(this.host, s);
    this.settings.shares.push(s);
    this.fs.folders.add(folder);
    return s;
  }

  /** Stops sharing as the plugin does: the vault takes the folder back, and the share's state is forgotten. */
  async stopSharing(s: Share): Promise<void> {
    const remote = new Set((await this.engine().view()).st.remote.keys());
    this.restart();
    await rejoin(this.host, s, (key) => this.has(key), remote);
    this.settings.shares = this.settings.shares.filter((x) => x !== s);
    this.states.delete(statePath(PLUGIN_DIR, s.id));
  }

  has(key: string): boolean {
    return [...this.fs.files.keys()].some((p) => vaultKey(p) === key);
  }

  engine(share?: Share): SyncEngine {
    const key = share?.id ?? '';
    if (!this.engines.has(key)) this.engines.set(key, makeEngine(this.host, share).engine);
    return this.engines.get(key)!;
  }

  /** New engines from the settings as they are now, as saving settings does in the plugin. */
  restart(): void {
    this.engines.clear();
  }

  /** One sync run as the plugin does it. */
  async syncAll() {
    if (await freeTaken(this.host, (key) => this.has(key))) this.restart();
    return syncAll(this.settings, this.host.secret, (s) => this.engine(s).sync());
  }

  async remote(share?: Share): Promise<string[]> {
    return [...(await this.engine(share).view()).st.remote.keys()].sort();
  }

  paths(): string[] {
    return [...this.fs.files.keys()].sort();
  }
}

const ok = (outcomes: { error?: unknown }[]) => assert.deepEqual(outcomes.map((o) => o.error), outcomes.map(() => undefined));

/** Storage for each person's vault and for the shared folder, made with a fast key derivation for tests. */
async function world() {
  const stores: Record<string, MemoryStore> = { 'vault-a': new MemoryStore(), 'vault-b': new MemoryStore(), team: new MemoryStore(), other: new MemoryStore() };
  const secrets: Record<string, string> = {};
  for (const [name, store] of Object.entries(stores)) {
    secrets[`pass:${name}`] = `${name} passphrase`;
    await Repo.open(store, secrets[`pass:${name}`], { kdfIterations: TEST_CONFIG.kdfIterations!, chunk: TEST_CONFIG.chunk! });
  }
  const a = new Person('A', stores, 'vault-a', secrets);
  const b = new Person('B', stores, 'vault-b', secrets);
  return { stores, secrets, a, b };
}

/** A and B share one folder, called "Shared" in A's vault and "Projects/Team" in B's, and have synced. */
async function sharing() {
  const w = await world();
  const { a, b } = w;
  a.fs.put('a.md', 'only in A');
  a.fs.put('Shared notes/n.md', 'a sibling whose name starts like the shared folder');
  a.fs.put('Shared/s1.md', 'from A');
  a.fs.put('Shared/sub/s2.md', 'from A, deeper');
  b.fs.put('b.md', 'only in B');
  b.fs.put('Projects/Team/t1.md', 'from B');
  const sa = await a.share('sa', 'Shared', 'team');
  const sb = await b.share('sb', 'Projects/Team', 'team');
  ok(await a.syncAll());
  ok(await b.syncAll());
  ok(await a.syncAll());
  return { ...w, sa, sb };
}

test('scoped: a folder is a vault of its own, and nothing outside it can be reached', async () => {
  const fs = new VaultFS();
  fs.put('Shared/a.md', 'a');
  fs.put('Shared/sub/b.md', 'b');
  fs.put('Shared notes/c.md', 'sibling');
  fs.put('Sharedx.md', 'neighbour');
  fs.put('top.md', 'top');
  fs.folders.add('Shared');
  let at = 'Shared';
  const scoped = new ScopedFS(fs, () => at);
  assert.deepEqual((await scoped.list()).map((f) => f.path).sort(), ['a.md', 'sub/b.md']);
  assert.equal(new TextDecoder().decode(await scoped.read('sub/b.md')), 'b');
  await scoped.write('new/c.md', new TextEncoder().encode('c'));
  assert.equal(fs.text('Shared/new/c.md'), 'c');
  assert.deepEqual(await scoped.stat('a.md'), await fs.stat('Shared/a.md'));
  await scoped.remove('a.md');
  assert.ok(!fs.files.has('Shared/a.md'));

  for (const bad of ['../top.md', '../Shared notes/c.md', 'sub/../../top.md', '..\\top.md', '/top.md', '', 'a//b.md', './a.md']) {
    await assert.rejects(scoped.write(bad, new Uint8Array(1)), /not a path inside the folder/, bad);
    await assert.rejects(scoped.read(bad), /not a path inside the folder/, bad);
    await assert.rejects(scoped.remove(bad), /not a path inside the folder/, bad);
  }
  assert.equal(fs.text('top.md'), 'top');
  assert.equal(fs.text('Shared notes/c.md'), 'sibling');

  at = 'Elsewhere';
  await assert.rejects(scoped.list(), (e: unknown) => e instanceof MissingFolderError && e.folder === 'Elsewhere');
  fs.folders.add('Elsewhere');
  assert.deepEqual(await scoped.list(), [], 'an empty folder that exists lists as empty');
});

test('scoped: the vault without its shared folders, and shared folders inside another left to their own sync', async () => {
  const fs = new VaultFS();
  for (const p of ['a.md', 'Shared/s.md', 'Shared notes/n.md', 'Work/w.md', 'Work/Inner/i.md']) fs.put(p, p);
  const mounts = ['Shared', 'Work/Inner'];
  const vault = new ScopedFS(fs, () => '', () => mounts);
  assert.deepEqual((await vault.list()).map((f) => f.path).sort(), ['Shared notes/n.md', 'Work/w.md', 'a.md']);
  await assert.rejects(vault.write('Shared/x.md', new Uint8Array(1)), /inside the shared folder "Shared"/);
  await assert.rejects(vault.write('shared/x.md', new Uint8Array(1)), /inside the shared folder "Shared"/, 'some file systems ignore case');
  await assert.rejects(vault.remove('Work/Inner/i.md'), /inside the shared folder "Work\/Inner"/);
  await vault.write('Shared notes/m.md', new Uint8Array(1));
  assert.ok(fs.files.has('Shared notes/m.md'));

  fs.folders.add('Work');
  const work = new ScopedFS(fs, () => 'Work', () => [...mounts, 'Work']);
  assert.deepEqual((await work.list()).map((f) => f.path), ['w.md']);
  await assert.rejects(work.write('Inner/x.md', new Uint8Array(1)), /inside the shared folder/);
});

test('routing: a path goes to the innermost shared folder holding it, by its path there', () => {
  const work = shareWith({ id: 'w', folder: 'Work' });
  const inner = shareWith({ id: 'i', folder: 'Work/Inner' });
  const shares = [work, inner];
  assert.deepEqual(placeOf(shares, 'a.md'), { path: 'a.md' });
  assert.deepEqual(placeOf(shares, 'Work notes/a.md'), { path: 'Work notes/a.md' });
  assert.deepEqual(placeOf(shares, 'Work/a.md'), { share: work, path: 'a.md' });
  assert.deepEqual(placeOf(shares, 'Work'), { share: work, path: '' });
  assert.deepEqual(placeOf(shares, 'Work/Inner/b/c.md'), { share: inner, path: 'b/c.md' });
  assert.equal(vaultPath(work, 'a.md'), 'Work/a.md');
  assert.equal(vaultPath(work, ''), 'Work');
  assert.equal(vaultPath(undefined, 'a.md'), 'a.md');
  const r = inVault(work, { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflictCopies: ['x (conflict).md'], skipped: 0, tooLarge: ['big.mov'], errors: [{ path: 'e.md', message: 'no' }], commits: 0, rounds: 1 });
  assert.deepEqual([r.conflictCopies, r.tooLarge, r.errors.map((e) => e.path)], [['Work/x (conflict).md'], ['Work/big.mov'], ['Work/e.md']]);
});

test('routing: a renamed or moved folder takes the shares in it along; a deleted one names the shares it took', () => {
  const work = shareWith({ id: 'w', folder: 'Work' });
  const inner = shareWith({ id: 'i', folder: 'Projects/Inner' });
  const prefix = shareWith({ id: 'p', folder: 'Workshop' });
  const shares = [work, inner, prefix];
  assert.deepEqual(followRename(shares, 'Work', 'Job'), [work]);
  assert.equal(work.folder, 'Job');
  assert.equal(prefix.folder, 'Workshop', 'a folder whose name only starts the same does not move');
  assert.deepEqual(followRename(shares, 'Projects', 'Archive/Projects'), [inner]);
  assert.equal(inner.folder, 'Archive/Projects/Inner');
  assert.deepEqual(followRename(shares, 'Other', 'Else'), []);
  assert.deepEqual(goneWith(shares, 'Archive'), [inner]);
  assert.deepEqual(goneWith(shares, 'Job'), [work]);
  assert.deepEqual(goneWith(shares, 'Work'), []);
});

const NFC = 'Café'.normalize('NFC');
const NFD = 'Café'.normalize('NFD');

test('routing: a path in the other Unicode form than the shared folder\'s name is routed, cut and followed alike, keeping its own form inside', () => {
  for (const [stored, given] of [[NFC, NFD], [NFD, NFC]]) {
    const s = shareWith({ id: 'c', folder: `${stored}/Notes` });
    const other = shareWith({ id: 'o', folder: 'Other' });
    const shares = [s, other];
    assert.deepEqual(placeOf(shares, `${given}/Notes/n.md`), { share: s, path: 'n.md' });
    assert.deepEqual(placeOf(shares, `${given}/Notes`), { share: s, path: '' });
    assert.deepEqual(placeOf(shares, `${given}/Notes/${given}/x.md`), { share: s, path: `${given}/x.md` }, 'the path inside keeps the form the file has on disk');
    assert.deepEqual(placeOf(shares, `${given}/Notes x/n.md`), { path: `${given}/Notes x/n.md` });
    assert.equal(vaultPath(s, placeOf(shares, `${given}/Notes/n.md`).path).normalize('NFC'), `${NFC}/Notes/n.md`);
    assert.deepEqual(goneWith(shares, given), [s]);
    assert.deepEqual(goneWith(shares, `${given}/Notes`), [s]);
    assert.deepEqual(followRename(shares, `${given}/Notes`, `${given}/Old notes`), [s]);
    assert.equal(s.folder, `${given}/Old notes`);
    assert.deepEqual(followRename(shares, given, 'Archive'), [s]);
    assert.equal(s.folder, 'Archive/Old notes');
  }
});

test('scoped: a shared folder whose name the file system gives in the other Unicode form lists its files and deletes nothing', async () => {
  for (const [stored, onDisk] of [[NFC, NFD], [NFD, NFC]]) {
    const fs = new VaultFS();
    fs.put(`${onDisk}/a.md`, 'a');
    fs.put(`${onDisk}/sub/b.md`, 'b');
    fs.put(`${onDisk} notes/c.md`, 'sibling');
    fs.folders.add(onDisk);
    const scoped = new ScopedFS(fs, () => stored);
    assert.deepEqual((await scoped.list()).map((f) => f.path).sort(), ['a.md', 'sub/b.md']);
    const vault = new ScopedFS(fs, () => '', () => [stored]);
    assert.deepEqual((await vault.list()).map((f) => f.path), [`${onDisk} notes/c.md`]);
  }
});

test('two people share a folder under different names: files flow both ways and never reach either vault\'s storage', async () => {
  const { a, b, sa, sb } = await sharing();
  assert.equal(a.fs.text('Shared/t1.md'), 'from B');
  assert.equal(b.fs.text('Projects/Team/s1.md'), 'from A');
  assert.equal(b.fs.text('Projects/Team/sub/s2.md'), 'from A, deeper');
  assert.deepEqual(b.paths(), ['Projects/Team/s1.md', 'Projects/Team/sub/s2.md', 'Projects/Team/t1.md', 'b.md']);
  assert.deepEqual(await a.remote(), ['Shared notes/n.md', 'a.md'], "A's vault storage has no shared file, and keeps the sibling folder");
  assert.deepEqual(await b.remote(), ['b.md']);
  assert.deepEqual(await a.remote(sa), ['s1.md', 'sub/s2.md', 't1.md']);
  assert.deepEqual(await b.remote(sb), ['s1.md', 'sub/s2.md', 't1.md']);

  b.fs.put('Projects/Team/t1.md', 'edited by B');
  a.fs.put('Shared/new.md', 'new from A');
  ok(await b.syncAll());
  ok(await a.syncAll());
  ok(await b.syncAll());
  assert.equal(a.fs.text('Shared/t1.md'), 'edited by B');
  assert.equal(b.fs.text('Projects/Team/new.md'), 'new from A');
  assert.equal(a.fs.text('Shared notes/n.md'), 'a sibling whose name starts like the shared folder');
  assert.deepEqual(await a.remote(), ['Shared notes/n.md', 'a.md']);
  assert.deepEqual(await b.remote(), ['b.md']);
});

test('a file moved out of the shared folder leaves the share and arrives in the mover\'s own vault storage', async () => {
  const { a, b, sa } = await sharing();
  a.fs.move('Shared/s1.md', 's1.md');
  ok(await a.syncAll());
  ok(await b.syncAll());
  assert.ok(!b.fs.files.has('Projects/Team/s1.md'));
  assert.deepEqual(await a.remote(sa), ['sub/s2.md', 't1.md']);
  assert.deepEqual(await a.remote(), ['Shared notes/n.md', 'a.md', 's1.md']);
  assert.deepEqual(await b.remote(), ['b.md']);

  a.fs.move('a.md', 'Shared/a.md');
  ok(await a.syncAll());
  ok(await b.syncAll());
  assert.equal(b.fs.text('Projects/Team/a.md'), 'only in A');
  assert.deepEqual(await a.remote(), ['Shared notes/n.md', 's1.md']);
});

test('what a vault\'s storage holds under a shared folder\'s name stays out of the shared folder', async () => {
  const w = await world();
  const { a, stores, secrets } = w;
  // Another of A's devices, where "Shared" is still an ordinary folder of the vault.
  const other = new Person('A2', stores, 'vault-a', secrets);
  other.fs.put('Shared/private.md', 'vault file, not for the share');
  ok(await other.syncAll());
  const sa = await a.share('sa', 'Shared', 'team');
  ok(await a.syncAll());
  assert.ok(!a.fs.files.has('Shared/private.md'));
  assert.deepEqual(await a.remote(sa), []);
});

test('a missing shared folder deletes nothing for the other person, even when an empty one comes back', async () => {
  const { a, b, sa, sb } = await sharing();
  const before = await a.remote(sa);
  b.fs.dropFolder('Projects/Team');
  const out = await b.syncAll();
  assert.equal(out[0].error, undefined, "B's vault still syncs");
  assert.ok(out[1].error instanceof MissingFolderError);
  assert.ok(sb.missing, 'the share pauses');

  b.fs.folders.add('Projects/Team');
  const again = await b.syncAll();
  assert.equal(again.length, 1, 'a paused share does not sync, so an empty folder is not taken for every file deleted');
  ok(await a.syncAll());
  assert.deepEqual(await a.remote(sa), before);
  assert.deepEqual(a.paths().filter((p) => p.startsWith('Shared/')), ['Shared/s1.md', 'Shared/sub/s2.md', 'Shared/t1.md']);

  // "Download it again": what B knew of the share is forgotten, so its next sync only adds.
  b.states.get(statePath(PLUGIN_DIR, 'sb'))!.data = null;
  sb.missing = false;
  b.restart();
  ok(await b.syncAll());
  ok(await a.syncAll());
  assert.deepEqual(b.paths().filter((p) => p.startsWith('Projects/Team/')), ['Projects/Team/s1.md', 'Projects/Team/sub/s2.md', 'Projects/Team/t1.md']);
  assert.deepEqual(await a.remote(sa), before);
});

test('a shared folder renamed in the vault is followed: nothing is deleted, and nothing leaks into the vault\'s storage', async () => {
  const { a, b, sa } = await sharing();
  const before = await a.remote(sa);
  a.fs.moveFolder('Shared', 'Work/Shared');
  // Until the share follows, its folder is missing: that stops its sync rather than deleting.
  await assert.rejects(a.engine(sa).sync(), MissingFolderError);
  assert.deepEqual(followRename(a.settings.shares, 'Shared', 'Work/Shared'), [sa]);
  // The engines built before the rename still run, as one already syncing would.
  const out = await a.syncAll();
  ok(out);
  assert.deepEqual([out[1].result!.pushed, out[1].result!.deletedRemote], [0, 0]);
  assert.deepEqual(await a.remote(), ['Shared notes/n.md', 'a.md']);
  a.restart();
  ok(await a.syncAll());
  ok(await b.syncAll());
  assert.deepEqual(await a.remote(), ['Shared notes/n.md', 'a.md']);
  assert.deepEqual(await a.remote(sa), before);
  assert.deepEqual(b.paths().filter((p) => p.startsWith('Projects/Team/')).length, 3);
});

test('hinted syncs of the vault and a shared folder: a file moved into it leaves the vault unlisted, a renamed or vanished shared folder is listed', async () => {
  const { a, b, sa } = await sharing();
  const log = new ChangeLog(() => a.settings.shares);
  let listed: string[] = [];
  const list = a.fs.list.bind(a.fs);
  const listFolder = a.fs.listFolder.bind(a.fs);
  let inFolder = false;
  a.fs.list = () => {
    if (!inFolder) listed.push('the vault');
    return list();
  };
  a.fs.listFolder = async (folder) => {
    listed.push(folder);
    inFolder = true;
    try {
      return await listFolder(folder);
    } finally {
      inFolder = false;
    }
  };
  // As the plugin does it, from the vault's events.
  const run = (why: Why) =>
    syncAll(a.settings, a.host.secret, (s) => {
      const changed = log.take(s, why, s && { folderMissing: !a.fs.folders.has(s.folder) });
      return a.engine(s).sync({ changed }).catch((e: unknown) => {
        log.failed(s);
        throw e;
      });
    });
  ok(await run('start'));
  assert.deepEqual(listed, ['the vault', 'Shared']);
  listed = [];

  a.fs.move('a.md', 'Shared/a.md');
  log.file('a.md');
  log.file('Shared/a.md');
  a.fs.put('Shared/sub/s2.md', 'edited by A');
  log.file('Shared/sub/s2.md');
  let out = await run('edit');
  ok(out);
  assert.deepEqual(listed, []);
  assert.deepEqual([out[0].result!.deletedRemote, out[1].result!.pushed], [1, 2]);
  ok(await b.syncAll());
  assert.equal(b.fs.text('Projects/Team/a.md'), 'only in A');
  assert.equal(b.fs.text('Projects/Team/sub/s2.md'), 'edited by A');
  assert.deepEqual(await a.remote(), ['Shared notes/n.md']);

  a.fs.moveFolder('Shared', 'Work/Shared');
  log.folder('Shared', 'Work/Shared');
  followRename(a.settings.shares, 'Shared', 'Work/Shared');
  a.fs.put('Work/Shared/t1.md', 'edited after the move');
  log.file('Work/Shared/t1.md');
  out = await run('edit');
  ok(out);
  assert.deepEqual(listed, ['the vault', 'Work/Shared']);
  assert.deepEqual([out[1].result!.pushed, out[1].result!.deletedRemote], [1, 0]);
  const before = await a.remote(sa);

  // Gone without a folder event, as when deleted outside Obsidian: an event for one file must not delete it for everyone.
  a.fs.dropFolder('Work/Shared');
  log.file('Work/Shared/t1.md');
  out = await run('edit');
  assert.ok(out[1].error instanceof MissingFolderError);
  assert.deepEqual(await a.remote(sa), before);
});

const projects = (n = 6) => Array.from({ length: n }, (_, i) => `Projects/p${i}.md`);

/**
 * A and A2 are two devices of one vault, which syncs a folder Projects. A shares that folder; A2 does not add the
 * share, so for A2 it stays a folder of the vault.
 */
async function sharedFromVault() {
  const w = await world();
  const { a, stores, secrets } = w;
  const a2 = new Person('A2', stores, 'vault-a', secrets);
  for (const p of projects()) a.fs.put(p, `${p} from the vault`);
  a.fs.put('a.md', 'a vault note');
  ok(await a.syncAll());
  ok(await a2.syncAll());
  assert.deepEqual(a2.paths(), [...projects(), 'a.md']);
  const sa = await a.share('sa', 'Projects', 'team');
  ok(await a.syncAll());
  return { ...w, a2, sa };
}

test('a folder the vault already syncs, shared on one device and renamed there, is neither deleted for the vault\'s other devices nor brought back', async () => {
  const { a, a2, sa } = await sharedFromVault();
  a2.fs.put('Projects/p0.md', 'edited on A2, which did not add the share');
  ok(await a2.syncAll());
  ok(await a.syncAll());
  assert.equal(a.fs.text('Projects/p0.md'), 'Projects/p0.md from the vault', "the vault's copy stays out of the shared folder");

  a.fs.moveFolder('Projects', 'Work');
  followRename(a.settings.shares, 'Projects', 'Work');
  a.restart();
  ok(await a.syncAll());
  ok(await a2.syncAll());
  ok(await a.syncAll());
  assert.deepEqual(a2.paths(), [...projects(), 'a.md'], 'A2 keeps every file');
  assert.equal(a2.fs.text('Projects/p0.md'), 'edited on A2, which did not add the share');
  assert.deepEqual(await a.remote(), [...projects(), 'a.md'], "the vault's storage keeps them for the devices that did not add the share");
  assert.deepEqual(a.paths(), [...projects().map((p) => p.replace('Projects/', 'Work/')), 'a.md'], 'and they do not come back to A under the old name');
  assert.deepEqual(await a.remote(sa), projects().map((p) => p.slice('Projects/'.length)));

  // Moved again, into another folder of the vault.
  a.fs.moveFolder('Work', 'Archive/Work');
  followRename(a.settings.shares, 'Work', 'Archive/Work');
  a.restart();
  ok(await a.syncAll());
  ok(await a2.syncAll());
  assert.deepEqual(a2.paths(), [...projects(), 'a.md']);
  assert.deepEqual(await a.remote(), [...projects(), 'a.md']);
});

/** Every file of a person's vault with its text. */
const texts = (p: Person) => Object.fromEntries(p.paths().map((path) => [path, p.fs.text(path)]));

test('stopping sharing a folder the vault already synced takes it back into the vault, deleting nothing on either side and merging edits', async () => {
  const { a, a2, sa } = await sharedFromVault();
  a.fs.put('Projects/p1.md', 'edited on A while shared');
  a.fs.files.delete('Projects/p2.md');
  a.fs.put('Projects/new.md', 'added on A while shared');
  ok(await a.syncAll());
  a2.fs.put('Projects/p3.md', 'edited on A2');
  a2.fs.files.delete('Projects/p4.md');
  ok(await a2.syncAll());
  ok(await a.syncAll());
  const shared = await a.remote(sa);

  assert.match(rejoinNote(sa), /^Your vault's storage still has the files that were in this folder when it was shared, for your devices/);
  await a.stopSharing(sa);
  ok(await a.syncAll());
  ok(await a2.syncAll());
  ok(await a.syncAll());
  const expected = {
    'Projects/new.md': 'added on A while shared',
    'Projects/p0.md': 'Projects/p0.md from the vault',
    'Projects/p1.md': 'edited on A while shared',
    'Projects/p2.md': 'Projects/p2.md from the vault',
    'Projects/p3.md': 'edited on A2',
    'Projects/p4.md': 'Projects/p4.md from the vault',
    'Projects/p5.md': 'Projects/p5.md from the vault',
    'a.md': 'a vault note',
  };
  assert.deepEqual(texts(a), expected, 'what only one side had is copied to the other, and an edit made on one side only wins without a conflict copy');
  assert.deepEqual(texts(a2), expected);
  assert.deepEqual(await a.remote(sa), shared, 'the shared storage is left as it was');
});

test('stopping sharing a folder that was renamed while shared: the vault\'s files come back under the old name beside it, and nothing is deleted', async () => {
  const { a, a2, sa } = await sharedFromVault();
  a.fs.moveFolder('Projects', 'Work');
  followRename(a.settings.shares, 'Projects', 'Work');
  a.fs.files.delete('Work/p2.md');
  a.restart();
  ok(await a.syncAll());
  assert.match(rejoinNote(sa), /, under “Projects”, for your devices/);
  await a.stopSharing(sa);
  ok(await a.syncAll());
  ok(await a2.syncAll());
  ok(await a.syncAll());
  const work = projects().filter((p) => p !== 'Projects/p2.md').map((p) => p.replace('Projects/', 'Work/'));
  assert.deepEqual(a.paths(), [...projects(), 'a.md', ...work].sort());
  assert.deepEqual(a2.paths(), a.paths());
});

test('a shared folder that went missing and was downloaded again leaves the vault\'s copies alone; stopping instead brings them back', async () => {
  const { a, a2, sa } = await sharedFromVault();
  a.fs.dropFolder('Projects');
  const out = await a.syncAll();
  assert.equal(out[0].error, undefined);
  assert.ok(out[1].error instanceof MissingFolderError && sa.missing);
  ok(await a2.syncAll());
  assert.deepEqual(a2.paths(), [...projects(), 'a.md'], 'a missing shared folder deletes nothing from the vault either');

  // "Download it again".
  a.fs.folders.add('Projects');
  a.states.get(statePath(PLUGIN_DIR, 'sa'))!.data = null;
  sa.missing = false;
  a.restart();
  ok(await a.syncAll());
  ok(await a2.syncAll());
  assert.deepEqual(a.paths(), [...projects(), 'a.md']);
  assert.deepEqual(a2.paths(), [...projects(), 'a.md']);
  assert.deepEqual(await a.remote(), [...projects(), 'a.md']);

  // Missing again, and this time sharing stops: the vault's copies come back, as the confirmation says.
  a.fs.dropFolder('Projects');
  await a.syncAll();
  await a.stopSharing(sa);
  ok(await a.syncAll());
  ok(await a2.syncAll());
  assert.deepEqual(a.paths(), [...projects(), 'a.md']);
  assert.deepEqual(a2.paths(), [...projects(), 'a.md']);
});

test('an ordinary folder made later under the old name of a renamed shared folder syncs, without the vault\'s old copies coming back', async () => {
  const { a, a2 } = await sharedFromVault();
  a.fs.moveFolder('Projects', 'Work');
  followRename(a.settings.shares, 'Projects', 'Work');
  a.restart();
  ok(await a.syncAll());
  a.fs.put('Projects/fresh.md', 'a new note in a new folder');
  a.fs.put('Projects/p0.md', 'another note that happens to have an old name');
  a.fs.move('a.md', 'Projects/a.md');
  ok(await a.syncAll());
  ok(await a2.syncAll());
  ok(await a.syncAll());
  const copy = a.paths().find((p) => p.startsWith('Projects/p0 (conflict A '))!;
  assert.ok(copy, 'the note that took an old name is kept beside the vault\'s copy, not written over it');
  assert.deepEqual(a.paths(), ['Projects/a.md', copy, 'Projects/fresh.md', 'Projects/p0.md', ...projects().map((p) => p.replace('Projects/', 'Work/'))].sort());
  assert.equal(a.fs.text(copy), 'another note that happens to have an old name');
  assert.deepEqual(a2.paths(), [...projects(), 'Projects/a.md', copy, 'Projects/fresh.md'].sort());
  assert.equal(a2.fs.text('Projects/p0.md'), 'Projects/p0.md from the vault');
  assert.equal(a2.fs.text('Projects/a.md'), 'a vault note');
});

test('a file Obsidian does not list, such as one whose name starts with a dot, is neither received nor deleted by a plugin device', async () => {
  const stores = { cli: new MemoryStore(), team: new MemoryStore() };
  for (const store of Object.values(stores)) await Repo.open(store, 'test passphrase', { kdfIterations: TEST_CONFIG.kdfIterations!, chunk: TEST_CONFIG.chunk! });
  const secrets = { 'pass:cli': 'test passphrase', 'pass:team': 'test passphrase' };
  const fs = new ObsidianLikeFS();
  const p = new Person('P', stores, 'cli', secrets, fs);
  // Devices that list every file, as the command line does: one syncing the vault, one the shared folder.
  const clock = { now: 1_800_000_000_000 };
  const cli = new Device('C', stores.cli, clock);
  const member = new Device('M', stores.team, clock);
  const hidden = ['.gitignore', '.vscode/settings.json', 'notes/.keep', 'notes/.cache/x.json', '.obsidian/plugins/p/.hotreload', '.obsidian/plugins/p/node_modules/m/index.js', '.obsidianx/a'];
  for (const path of [...hidden, 'notes/n.md', '.obsidian/plugins/p/main.js']) cli.fs.put(path, path);
  await cli.sync();
  ok(await p.syncAll());
  fs.put('notes/mine.md', 'written on P, so the next sync lists the vault');
  ok(await p.syncAll());
  ok(await p.syncAll());
  await cli.sync();
  assert.deepEqual([...cli.fs.files.keys()].sort(), [...hidden, 'notes/mine.md', 'notes/n.md', '.obsidian/plugins/p/main.js'].sort(), 'nothing the plugin device can not list is deleted');
  assert.deepEqual(p.paths(), ['.obsidian/plugins/p/main.js', 'notes/mine.md', 'notes/n.md'], 'and none of it is downloaded there');

  // With the settings folder not synced on the plugin device, its files are left alone too.
  p.settings.syncConfigDir = false;
  fs.withConfig = false;
  p.restart();
  cli.fs.put('.obsidian/plugins/q/main.js', 'a plugin the plugin device does not have');
  cli.fs.put('.obsidian/plugins/p/main.js', 'an update');
  await cli.sync();
  fs.put('notes/mine.md', 'edited, so the next sync lists the vault');
  ok(await p.syncAll());
  ok(await p.syncAll());
  await cli.sync();
  assert.equal(cli.fs.text('.obsidian/plugins/q/main.js'), 'a plugin the plugin device does not have');
  assert.equal(p.fs.text('.obsidian/plugins/p/main.js'), '.obsidian/plugins/p/main.js', 'nor are they downloaded');
  assert.ok(!p.fs.files.has('.obsidian/plugins/q/main.js'));

  // The same inside a shared folder.
  await p.share('t', 'Team', 'team');
  for (const path of ['.keep', 'sub/.hidden/y.md', 'sub/z.md']) member.fs.put(path, path);
  await member.sync();
  ok(await p.syncAll());
  fs.put('Team/mine.md', 'mine');
  ok(await p.syncAll());
  ok(await p.syncAll());
  await member.sync();
  assert.deepEqual([...member.fs.files.keys()].sort(), ['.keep', 'mine.md', 'sub/.hidden/y.md', 'sub/z.md']);
  assert.deepEqual(p.paths().filter((x) => x.startsWith('Team/')), ['Team/mine.md', 'Team/sub/z.md']);
});

test('one shared folder failing (wrong passphrase) does not stop the vault or the shared folder after it', async () => {
  const { a, secrets } = await world();
  a.fs.put('a.md', 'vault');
  a.fs.put('Other/o.md', 'other');
  a.fs.put('Shared/s.md', 'shared');
  const bad = await a.share('bad', 'Other', 'other');
  const good = await a.share('good', 'Shared', 'team');
  secrets['pass:other'] = 'not it';
  a.restart();
  const out = await a.syncAll();
  assert.deepEqual(out.map((o) => o.target?.id ?? 'vault'), ['vault', 'bad', 'good']);
  assert.equal(out[0].result?.pushed, 1);
  assert.ok(out[1].error instanceof WrongPassphraseError);
  assert.ok(!bad.missing);
  assert.equal(out[2].result?.pushed, 1);
  assert.deepEqual(await a.remote(good), ['s.md']);
  assert.deepEqual(await a.remote(), ['a.md']);
});

test('nothing syncs on a storage location that the vault and a shared folder are both set to', async () => {
  const { a, sa } = await sharing();
  a.settings.prefix = 'team';
  a.restart();
  const out = await a.syncAll();
  assert.match(String(out[0].error), /This vault and the shared folder “Shared” are set to the same storage location/);
  assert.match(String(out[1].error), /where this vault itself syncs/);
  assert.ok(!a.fs.files.has('s1.md') && !a.fs.files.has('t1.md'), "the share's files are not pulled into the vault");
  a.settings.prefix = 'vault-a';
  a.restart();
  ok(await a.syncAll());
  assert.deepEqual(await a.remote(sa), ['s1.md', 'sub/s2.md', 't1.md']);
});
