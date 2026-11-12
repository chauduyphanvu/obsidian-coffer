import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WrongPassphraseError } from '../src/core/crypto.ts';
import type { SyncEngine } from '../src/core/engine.ts';
import { Repo } from '../src/core/repo.ts';
import { MissingFolderError, ScopedFS, type FolderFS } from '../src/core/scopedfs.ts';
import { defaultSettings, shareWith, statePath, type Settings, type Share } from '../src/plugin/settings.ts';
import { followRename, goneWith, inVault, makeEngine, placeOf, syncAll, vaultPath, type EngineHost } from '../src/plugin/shares.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { TEST_CONFIG } from './helpers.ts';

/** A vault on disk: files, and folders that exist even when empty, as Obsidian keeps them. */
class VaultFS extends MemFS implements FolderFS {
  folders = new Set<string>();

  async listFolder(folder: string) {
    const files = (await this.list()).filter((f) => f.path.startsWith(`${folder}/`));
    return this.folders.has(folder) || files.length ? files : null;
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

const PLUGIN_DIR = '.obsidian/plugins/self-sync';

/** One person's device: a vault syncing with its own storage, and the shared folders added to it. */
class Person {
  fs = new VaultFS();
  states = new Map<string, MemState>();
  settings: Settings;
  host: EngineHost;
  private engines = new Map<string, SyncEngine>();

  constructor(name: string, stores: Record<string, MemoryStore>, vault: string, secrets: Record<string, string>) {
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

  /** Adds a shared folder, its folder made in the vault as adding one does. */
  share(id: string, folder: string, remote: string): Share {
    const s = shareWith({ id, folder, endpoint: 'https://s3.test', bucket: 'b', prefix: remote, accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: `pass:${remote}` });
    this.settings.shares.push(s);
    this.fs.folders.add(folder);
    this.restart();
    return s;
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
  syncAll() {
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
  const sa = a.share('sa', 'Shared', 'team');
  const sb = b.share('sb', 'Projects/Team', 'team');
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
  const sa = a.share('sa', 'Shared', 'team');
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

test('one shared folder failing (wrong passphrase) does not stop the vault or the shared folder after it', async () => {
  const { a, secrets } = await world();
  a.fs.put('a.md', 'vault');
  a.fs.put('Other/o.md', 'other');
  a.fs.put('Shared/s.md', 'shared');
  const bad = a.share('bad', 'Other', 'other');
  const good = a.share('good', 'Shared', 'team');
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
