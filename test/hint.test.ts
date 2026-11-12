import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SafetyError } from '../src/core/engine.ts';
import type { FileStat } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS } from '../src/testing/memfs.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

function setup(names = ['A', 'B'], config = {}) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  const devices = names.map((n) => new Device(n, net, clock, config));
  return { clock, mem, net, devices };
}

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

/** Counts how often the engine lists the vault. */
function listings(d: Device): () => number {
  let n = 0;
  const list = d.fs.list.bind(d.fs);
  d.fs.list = () => {
    n++;
    return list();
  };
  return () => n;
}

const hinted = (d: Device, ...changed: string[]) => d.engine.sync({ changed });

function rename(fs: MemFS, from: string, to: string): void {
  const f = fs.files.get(from)!;
  fs.files.delete(from);
  fs.files.set(to, f);
}

/** A file system that ignores letter case, as on macOS, iOS and Windows: any spelling finds the file, a listing shows the name it has. */
class CaseFS extends MemFS {
  private find(path: string): string | undefined {
    for (const k of this.files.keys()) if (k.toLowerCase() === path.toLowerCase()) return k;
    return undefined;
  }
  override async stat(path: string): Promise<FileStat | null> {
    return super.stat(this.find(path) ?? path);
  }
  override async read(path: string): Promise<Uint8Array> {
    return super.read(this.find(path) ?? path);
  }
  override async write(path: string, data: Uint8Array, mtime?: number): Promise<FileStat> {
    return super.write(this.find(path) ?? path, data, mtime);
  }
  override async remove(path: string): Promise<void> {
    return super.remove(this.find(path) ?? path);
  }
}

async function synced() {
  const env = setup();
  const [a, b] = env.devices;
  for (const p of ['a.md', 'b.md', 'c.md', 'sub/d.md', 'shared.md']) a.fs.put(p, `${p}\n\nmiddle\n\nend\n`);
  await a.sync();
  await b.sync();
  return { ...env, a, b, listed: listings(a) };
}

test('a hinted sync looks only at the paths it is told of: an edit, a new file and a deletion travel without listing the vault', async () => {
  const { a, b, listed } = await synced();
  a.fs.put('a.md', 'a.md\n\nedited\n');
  a.fs.put('e.md', 'new\n');
  a.fs.files.delete('c.md');
  const r = await hinted(a, 'a.md', 'e.md', 'c.md');
  assert.deepEqual([r.pushed, r.deletedRemote, r.errors.length, listed()], [2, 1, 0, 0]);
  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a hinted rename moves the file without uploading it, and a case-only rename replaces the old name', async () => {
  const { a, b, net, listed } = await synced();
  rename(a.fs, 'b.md', 'x/b2.md');
  net.reset();
  const r = await hinted(a, 'b.md', 'x/b2.md');
  assert.deepEqual([r.pushed, r.deletedRemote, net.stats.put], [1, 1, 1]);
  rename(a.fs, 'sub/d.md', 'sub/D.md');
  await hinted(a, 'sub/d.md', 'sub/D.md');
  assert.equal(listed(), 0);
  const got = await b.sync();
  assert.equal(got.deletedLocal, 2);
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.deepEqual(Object.keys(b.snapshot()).filter((p) => /b2|sub/.test(p)), ['sub/D.md', 'x/b2.md']);
});

test('on a file system that ignores case, a case-only rename is found by listing, so the old name does not survive', async () => {
  const { devices: [a, b] } = setup();
  a.fs = new CaseFS();
  a.restart();
  const listed = listings(a);
  a.fs.put('Note.md', 'note\n');
  a.fs.put('other.md', 'other\n');
  await a.sync();
  await b.sync();
  rename(a.fs, 'Note.md', 'note.md');
  assert.ok(await a.fs.stat('Note.md'), 'asked by its old name, the file system answers for the new one');
  const before = listed();
  const r = await hinted(a, 'Note.md', 'note.md');
  assert.equal(listed(), before + 1);
  assert.deepEqual([r.pushed, r.deletedRemote], [1, 1]);
  await b.sync();
  assert.deepEqual(Object.keys(b.snapshot()), ['note.md', 'other.md']);
  assert.equal(b.fs.text('note.md'), 'note\n');
});

test('a hinted path that is excluded, over the size limit, unchanged or nothing at all is reported as a full sync would, and not sent', async () => {
  const { devices: [a, b] } = setup(['A', 'B'], { exclude: ['private/'], maxFileSizeMB: 1 });
  const big = new Device('Big', a.store, a.clock, { maxFileSizeMB: 0 });
  a.fs.put('n.md', 'n\n');
  await a.sync();
  const listed = listings(a);
  a.fs.put('private/p.md', 'secret\n');
  a.fs.put('huge.bin', random(2 << 20, 1));
  let r = await hinted(a, 'private/p.md', 'huge.bin', 'n.md', 'nothing.md', 'no/such/folder');
  assert.deepEqual([r.pushed, r.errors.length, r.tooLarge], [0, 0, ['huge.bin']]);
  big.fs.put('remote-huge.bin', random(2 << 20, 2));
  await big.sync();
  r = await hinted(a);
  assert.deepEqual(r.tooLarge, ['huge.bin', 'remote-huge.bin']);
  assert.equal(listed(), 0);
  assert.deepEqual((await a.sync()).tooLarge, r.tooLarge, 'the same as a full sync reports');

  a.fs.put('huge.bin', random(1000, 3));
  r = await hinted(a, 'huge.bin');
  assert.deepEqual([r.pushed, r.tooLarge], [1, ['remote-huge.bin']]);
  await b.sync();
  assert.deepEqual(Object.keys(b.snapshot()).sort(), ['huge.bin', 'n.md']);
});

test('a hinted sync brings in remote changes and merges or keeps both sides of a conflict', async () => {
  const { a, b, listed } = await synced();
  b.fs.put('b.md', 'b.md\n\nfrom B\n');
  b.fs.put('f.md', 'new on B\n');
  b.fs.files.delete('a.md');
  b.fs.put('shared.md', 'shared.md (B)\n\nmiddle\n\nend\n');
  b.fs.put('c.md', 'c.md from B\n');
  await b.sync();

  a.fs.put('e.md', 'new on A\n');
  a.fs.put('shared.md', 'shared.md\n\nmiddle\n\nend (A)\n');
  a.fs.put('c.md', 'c.md from A\n');
  const r = await hinted(a, 'e.md', 'shared.md', 'c.md');
  assert.deepEqual([r.pulled, r.deletedLocal, r.merged, r.conflictCopies.length, r.errors.length], [3, 1, 1, 1, 0]);
  assert.equal(a.fs.text('shared.md'), 'shared.md (B)\n\nmiddle\n\nend (A)\n');
  assert.equal(a.fs.text(r.conflictCopies[0]), 'c.md from A\n');
  assert.equal(listed(), 0);
  const again = await hinted(a);
  assert.equal(again.pushed + again.pulled, 0, 'everything settled');
  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a folder renamed or deleted, hinted by its own path, makes the sync list the vault', async () => {
  const { a, b, listed } = await synced();
  for (let i = 0; i < 3; i++) a.fs.put(`dir/n${i}.md`, `${i}\n`);
  await hinted(a, 'dir/n0.md', 'dir/n1.md', 'dir/n2.md');
  assert.equal(listed(), 0);
  for (const p of ['dir/n0.md', 'dir/n1.md', 'dir/n2.md']) rename(a.fs, p, p.replace('dir/', 'moved/'));
  await hinted(a, 'dir', 'moved');
  assert.equal(listed(), 1);
  for (const p of ['moved/n0.md', 'moved/n1.md', 'moved/n2.md', 'sub/d.md']) a.fs.files.delete(p);
  await hinted(a, 'moved', 'sub');
  assert.equal(listed(), 2);
  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.ok(!Object.keys(b.snapshot()).some((p) => p.includes('/')));

  // Files created in a new folder and the folder renamed before any sync: their old paths say it is a folder.
  a.fs.put('new/x.md', 'x\n');
  rename(a.fs, 'new/x.md', 'newer/x.md');
  await hinted(a, 'new/x.md', 'new', 'newer');
  assert.equal(listed(), 3);
  await b.sync();
  assert.equal(b.fs.text('newer/x.md'), 'x\n');
});

test('the hint is ignored on the first sync of an engine, after a sync that failed, and after keeping all files', async () => {
  const { a, net, listed } = await synced();
  a.restart();
  a.fs.put('a.md', 'edited\n');
  await hinted(a, 'a.md');
  assert.equal(listed(), 1, 'a new engine lists');
  await hinted(a);
  assert.equal(listed(), 1);

  const put = net.put.bind(net);
  net.put = async () => {
    throw new Error('offline');
  };
  a.fs.put('b.md', 'edited\n');
  await assert.rejects(hinted(a, 'b.md'), /offline/);
  net.put = put;
  a.fs.put('c.md', 'edited, and not named below\n');
  const r = await hinted(a, 'b.md');
  assert.equal(listed(), 2, 'after a failed sync it lists');
  assert.equal(r.pushed, 2);

  await a.engine.keepAllFiles();
  const before = listed();
  await hinted(a);
  assert.equal(listed(), before + 1);
});

test('remote changes read outside a sync are still synced by a hint naming nothing, and reported as changes meanwhile', async () => {
  const { a, b } = await synced();
  b.fs.put('b.md', 'from B\n');
  await b.sync();
  await a.engine.view();
  assert.equal(await a.engine.remoteChanged(), true);
  const r = await hinted(a);
  assert.equal(r.pulled, 1);
  assert.equal(a.fs.text('b.md'), 'from B\n');
  assert.equal(await a.engine.remoteChanged(), false);

  // A sync that read the new commit and then failed has not synced it either.
  b.fs.put('c.md', 'from B too\n');
  await b.sync();
  const get = a.store.get.bind(a.store);
  a.store.get = async (key, range) => {
    if (key.startsWith('pack/')) throw new Error('offline');
    return get(key, range);
  };
  await assert.rejects(hinted(a), /offline/);
  a.store.get = get;
  assert.equal(await a.engine.remoteChanged(), true);
  assert.equal((await hinted(a)).pulled, 1);
  assert.equal(await a.engine.remoteChanged(), false);
});

test('a file that failed is tried again by the next hinted sync though nothing names it', async () => {
  const { a, b } = await synced();
  a.fs.put('locked.md', 'locked\n');
  const read = a.fs.read.bind(a.fs);
  a.fs.read = async (path) => {
    if (path === 'locked.md') throw new Error('EACCES: permission denied');
    return read(path);
  };
  assert.deepEqual((await hinted(a, 'locked.md')).errors.map((e) => e.path), ['locked.md']);
  a.fs.read = read;
  assert.equal((await hinted(a)).pushed, 1);
  await b.sync();
  assert.equal(b.fs.text('locked.md'), 'locked\n');
});

test('settings files fire no vault events, so a hinted sync leaves them to the next full one', async () => {
  const { devices: [a] } = setup();
  a.fs.put('.obsidian/app.json', '{"a":1}');
  await a.sync();
  a.fs.put('.obsidian/app.json', '{"a":2}');
  assert.equal((await hinted(a)).pushed, 0);
  assert.equal((await a.sync()).pushed, 1);
});

test('the guard against mass deletion counts a hinted sync\'s deletions as it would a full one\'s', async () => {
  const { devices: [a] } = setup();
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  const gone = Array.from({ length: 20 }, (_, i) => `n${i}.md`);
  for (const p of gone) a.fs.files.delete(p);
  await assert.rejects(hinted(a, ...gone), SafetyError);
  await assert.rejects(hinted(a), SafetyError, 'after a refusal the next sync lists, and still finds them');
  assert.equal((await a.engine.sync({ changed: [], force: true })).deletedRemote, 20);
});

test('a hinted sync finds a file by the name it has on disk when that is another Unicode form', async () => {
  const { devices: [a, b] } = setup();
  const nfd = 'Tiếng Việt.md'.normalize('NFD');
  const nfc = nfd.normalize('NFC');
  a.fs.put(nfd, 'xin chào\n');
  await a.sync();
  await b.sync();
  a.fs.put(nfd, 'xin chào\nmột\n');
  assert.equal((await hinted(a, nfd)).pushed, 1);
  await b.sync();
  b.fs.put(nfc, 'xin chào\nmột\nhai\n');
  await b.sync();
  const listed = listings(a);
  assert.equal((await hinted(a)).pulled, 1);
  assert.equal(listed(), 0);
  assert.deepEqual([...a.fs.files.keys()], [nfd]);
  assert.equal(a.fs.text(nfd), 'xin chào\nmột\nhai\n');
});

test('a conflict copy left behind when taking the remote version fails is sent by the next hinted sync', async () => {
  const { devices: [a, b], net } = setup();
  a.fs.put('p.bin', random(2000, 1));
  await a.sync();
  await b.sync();
  b.fs.put('p.bin', random(2000, 2));
  await b.sync();
  a.fs.put('p.bin', random(2000, 3));
  const get = net.get.bind(net);
  net.get = async (key, range) => {
    if (key.startsWith('pack/')) throw new Error('offline');
    return get(key, range);
  };
  const r = await hinted(a, 'p.bin');
  assert.deepEqual(r.errors.map((e) => e.path), ['p.bin']);
  const copy = [...a.fs.files.keys()].find((p) => p.includes('conflict'))!;
  assert.ok(copy, 'this device\'s version was moved aside before the failure');
  net.get = get;
  await hinted(a);
  await b.sync();
  assert.equal(Buffer.compare(b.fs.files.get(copy)!.data, random(2000, 3)), 0);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a path the file system will not stat makes the sync list instead of failing', async () => {
  const { a, b, listed } = await synced();
  const stat = a.fs.stat.bind(a.fs);
  a.fs.stat = async (path) => {
    if (path.startsWith('shared/')) throw new Error(`"${path}" is inside the shared folder "shared"`);
    return stat(path);
  };
  a.fs.put('a.md', 'edited\n');
  const r = await hinted(a, 'a.md', 'shared/x.md');
  assert.deepEqual([r.pushed, r.errors.length, listed()], [1, 0, 1]);
  await b.sync();
  assert.equal(b.fs.text('a.md'), 'edited\n');
});
