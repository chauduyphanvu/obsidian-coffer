import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SafetyError, SyncEngine, deleteLimit } from '../src/core/engine.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng, SimStore } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

const DAY = 86_400_000;

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

test('create, edit and delete travel between devices', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('notes/one.md', 'hello\n');
  a.fs.put('img/pic.png', random(50_000, 1));
  a.fs.put('empty.md', '');
  await a.sync();
  const r = await b.sync();
  assert.equal(r.pulled, 3);
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.equal(b.fs.files.get('notes/one.md')!.mtime, a.fs.files.get('notes/one.md')!.mtime);

  b.fs.put('notes/one.md', 'hello\nworld\n');
  await b.sync();
  await a.sync();
  assert.equal(a.fs.text('notes/one.md'), 'hello\nworld\n');

  a.fs.files.delete('img/pic.png');
  assert.equal((await a.sync()).deletedRemote, 1);
  assert.equal((await b.sync()).deletedLocal, 1);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a sync with nothing to do costs two empty reads, and a small edit two writes', async () => {
  const { devices: [a, b], net } = setup();
  a.fs.put('a.md', 'x\n');
  await a.sync();
  await b.sync();
  net.reset();
  await a.sync();
  assert.deepEqual(net.stats, { get: 2, put: 0, list: 0, delete: 0, up: 0, down: 0 });
  a.fs.put('a.md', 'x\ny\n');
  net.reset();
  await a.sync();
  assert.equal(net.stats.get + net.stats.list, 0);
  assert.equal(net.stats.put, 2);
  net.reset();
  await b.sync();
  assert.equal(b.fs.text('a.md'), 'x\ny\n');
  assert.equal(net.stats.get, 3);
});

test('nothing readable is stored remotely', async () => {
  const { devices: [a], mem } = setup();
  a.fs.put('Secret Project/plan.md', 'the launch code is swordfish\n'.repeat(20));
  await a.sync();
  for (const [key, o] of mem.objects) {
    const text = Buffer.from(o.data).toString('latin1');
    assert.ok(!/Secret|plan\.md|swordfish/.test(key + text), key);
  }
});

test('edits to different parts of a note merge', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('n.md', '# Title\n\none\n\ntwo\n\nthree\n');
  await a.sync();
  await b.sync();
  a.fs.put('n.md', '# Title\n\nONE\n\ntwo\n\nthree\n');
  b.fs.put('n.md', '# Title\n\none\n\ntwo\n\nthree\n\nfour\n');
  await a.sync();
  const r = await b.sync();
  assert.equal(r.merged, 1);
  assert.deepEqual(r.conflictCopies, []);
  await a.sync();
  assert.equal(a.fs.text('n.md'), '# Title\n\nONE\n\ntwo\n\nthree\n\nfour\n');
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('overlapping edits keep both versions', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('n.md', 'line\n');
  await a.sync();
  await b.sync();
  a.fs.put('n.md', 'from A\n');
  b.fs.put('n.md', 'from B\n');
  await a.sync();
  const r = await b.sync();
  assert.equal(r.conflictCopies.length, 1);
  await a.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.equal(a.fs.text('n.md'), 'from A\n');
  assert.equal(a.fs.text(r.conflictCopies[0]), 'from B\n');
  assert.match(r.conflictCopies[0], /^n \(conflict B \d{8}-\d{6}\)\.md$/);
});

test('binary files and the copy strategy never merge', async () => {
  const { devices: [a, b] } = setup(['A', 'B'], { conflictStrategy: 'copy' });
  a.fs.put('n.md', 'a\nb\nc\n');
  a.fs.put('p.png', random(1000, 1));
  await a.sync();
  await b.sync();
  a.fs.put('n.md', 'A\nb\nc\n');
  b.fs.put('n.md', 'a\nb\nC\n');
  a.fs.put('p.png', random(1000, 2));
  b.fs.put('p.png', random(1000, 3));
  await a.sync();
  const r = await b.sync();
  assert.equal(r.merged, 0);
  assert.equal(r.conflictCopies.length, 2);
  await a.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.equal(Object.keys(a.snapshot()).length, 4);
});

for (const conflictStrategy of ['merge', 'copy'] as const) {
  test(`settings changed on two devices are combined, never copied (${conflictStrategy})`, async () => {
    const { devices: [a, b] } = setup(['A', 'B'], { conflictStrategy });
    const j = (v: unknown) => JSON.stringify(v, null, 2);
    const json = (d: typeof a, p: string) => JSON.parse(d.fs.text(p) ?? "null");
    // Joining: both devices already have settings of their own.
    a.fs.put('.obsidian/app.json', j({ spellcheck: true, theme: 'dark' }));
    a.fs.put('.obsidian/community-plugins.json', j(['calendar']));
    a.fs.put('.obsidian/snippets/x.css', 'a {}\n');
    a.fs.put('.obsidian/plugins/p/main.js', 'console.log("A")');
    b.fs.put('.obsidian/app.json', j({ theme: 'light', vimMode: true }));
    b.fs.put('.obsidian/community-plugins.json', j(['dataview']));
    b.fs.put('.obsidian/snippets/x.css', 'b {}\n');
    b.fs.put('.obsidian/plugins/p/main.js', 'console.log("B")');
    await a.sync();
    let r = await b.sync();
    assert.deepEqual(r.conflictCopies, []);
    assert.deepEqual(json(b, '.obsidian/app.json'), { spellcheck: true, theme: 'dark', vimMode: true });
    assert.deepEqual(json(b, '.obsidian/community-plugins.json'), ['calendar', 'dataview']);
    assert.equal(b.fs.text('.obsidian/snippets/x.css'), 'a {}\n');
    assert.equal(b.fs.text('.obsidian/plugins/p/main.js'), 'console.log("A")');
    await a.sync();
    assert.deepEqual(b.snapshot(), a.snapshot());

    // Later: each device changes something, and both change the theme.
    a.fs.put('.obsidian/app.json', j({ spellcheck: false, theme: 'moonstone', vimMode: true }));
    a.fs.put('.obsidian/community-plugins.json', j(['calendar', 'dataview', 'tasks']));
    a.fs.put('.obsidian/snippets/x.css', 'a {}\n\nfrom A {}\n');
    b.fs.put('.obsidian/app.json', j({ spellcheck: true, theme: 'obsidian', vimMode: false, foldHeading: true }));
    b.fs.put('.obsidian/community-plugins.json', j(['dataview']));
    b.fs.put('.obsidian/snippets/x.css', 'from B {}\n\na {}\n');
    await a.sync();
    r = await b.sync();
    assert.deepEqual(r.conflictCopies, []);
    assert.equal(r.merged, 3);
    await a.sync();
    assert.deepEqual(b.snapshot(), a.snapshot());
    assert.deepEqual(json(a, '.obsidian/app.json'), { spellcheck: false, theme: 'moonstone', vimMode: false, foldHeading: true });
    assert.deepEqual(json(a, '.obsidian/community-plugins.json'), ['dataview', 'tasks']);
    assert.equal(a.fs.text('.obsidian/snippets/x.css'), 'from B {}\n\na {}\n\nfrom A {}\n');
    assert.ok(![...a.fs.files.keys()].some((p) => p.includes('conflict')));
  });
}

test('an edit beats a delete, in both directions', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('x.md', 'x\n');
  a.fs.put('y.md', 'y\n');
  await a.sync();
  await b.sync();
  a.fs.files.delete('x.md');
  b.fs.put('x.md', 'x\nedited on B\n');
  a.fs.put('y.md', 'y\nedited on A\n');
  b.fs.files.delete('y.md');
  await a.sync();
  await b.sync();
  await a.sync();
  assert.equal(a.fs.text('x.md'), 'x\nedited on B\n');
  assert.equal(b.fs.text('y.md'), 'y\nedited on A\n');
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a moved folder is applied on the other device without downloading it again', async () => {
  const { devices: [a, b], net } = setup();
  for (let i = 0; i < 40; i++) a.fs.put(`old/n${i}.md`, `note ${i}\n`.repeat(50));
  await a.sync();
  await b.sync();
  for (const [path, f] of [...a.fs.files]) {
    a.fs.files.delete(path);
    a.fs.files.set(path.replace('old/', 'new/'), f);
  }
  net.reset();
  await a.sync();
  assert.equal(net.stats.put, 1, 'only the commit is uploaded');
  net.reset();
  const r = await b.sync();
  assert.equal(r.pulled, 40);
  assert.equal(r.deletedLocal, 40);
  assert.equal(net.stats.down < 5000, true, `downloaded ${net.stats.down} bytes`);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a small change to a large file uploads only the chunks around it', async () => {
  const { devices: [a, b], net } = setup();
  const big = random(3_000_000, 5);
  a.fs.put('big.bin', big);
  await a.sync();
  await b.sync();
  const edited = new Uint8Array(big.length + 10);
  edited.set(big.subarray(0, 1_500_000));
  edited.set(big.subarray(1_500_000), 1_500_010);
  a.fs.put('big.bin', edited);
  net.reset();
  await a.sync();
  assert.ok(net.stats.up < 200_000, `uploaded ${net.stats.up} bytes`);
  net.reset();
  await b.sync();
  assert.ok(net.stats.down < 200_000, `downloaded ${net.stats.down} bytes`);
  assert.deepEqual(b.fs.files.get('big.bin')!.data, edited);
});

test('identical content is stored once', async () => {
  const { devices: [a], net } = setup();
  const data = random(200_000, 9);
  a.fs.put('one.bin', data);
  a.fs.put('two.bin', data);
  await a.sync();
  assert.ok(net.stats.up < 230_000, `uploaded ${net.stats.up} bytes`);
});

test('first sync of two devices that already hold the same files transfers no file data', async () => {
  const { devices: [a, b], net } = setup();
  for (const d of [a, b]) {
    d.fs.put('same.md', 'same\n');
    d.fs.put('pic.png', random(100_000, 4));
  }
  b.fs.put('differs.md', 'B version\n');
  a.fs.put('differs.md', 'A version\n');
  await a.sync();
  net.reset();
  const r = await b.sync();
  assert.equal(r.conflictCopies.length, 1);
  assert.ok(net.stats.down < 5000 && net.stats.up < 5000, JSON.stringify(net.stats));
  await a.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a sync that would wipe most of the vault is refused unless forced', async () => {
  const { devices: [a, b] } = setup();
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  await b.sync();
  const saved = new Map(a.fs.files);
  a.fs.files.clear(); // e.g. the vault folder failed to mount
  await assert.rejects(a.sync(), SafetyError);
  a.fs.files = saved;
  await a.sync();
  await b.sync();
  assert.equal(b.fs.files.size, 30);

  a.fs.files.clear();
  await a.sync(true);
  await assert.rejects(b.sync(), SafetyError);
  await b.sync(true);
  assert.equal(b.fs.files.size, 0);
});

test('losing the local state file loses nothing', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('a.md', 'a\n');
  a.fs.put('b.md', 'b\n');
  await a.sync();
  await b.sync();
  b.state.data = null;
  b.restart();
  b.fs.put('b.md', 'b\nmore\n');
  a.fs.put('c.md', 'c\n');
  await a.sync();
  const r = await b.sync();
  assert.equal(r.pulled, 2); // c.md, plus A's b.md while B's own edit moves to a conflict copy
  assert.equal(r.conflictCopies.length, 1);
  await a.sync();
  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.ok(Object.values(a.snapshot()).some((v) => Buffer.from(v, 'base64').toString() === 'b\nmore\n'));
});

test('file names are matched across Unicode normal forms', async () => {
  const { devices: [a, b] } = setup();
  const nfd = 'Tiếng Việt.md'.normalize('NFD');
  a.fs.put(nfd, 'xin chào\n');
  await a.sync();
  await b.sync();
  assert.equal(b.fs.text('Tiếng Việt.md'.normalize('NFC')), 'xin chào\n');
  b.fs.put('Tiếng Việt.md'.normalize('NFC'), 'xin chào\ntạm biệt\n');
  await b.sync();
  await a.sync();
  assert.equal(a.fs.files.size, 1);
  assert.equal(a.fs.text(nfd), 'xin chào\ntạm biệt\n');
});

test('excluded and oversized files stay local', async () => {
  const { devices: [a, b] } = setup(['A', 'B'], { exclude: ['.obsidian/workspace*.json', 'private/'], maxFileSizeMB: 1 });
  a.fs.put('.obsidian/workspace.json', '{}');
  a.fs.put('.obsidian/app.json', '{}');
  a.fs.put('private/diary.md', 'x');
  a.fs.put('huge.bin', new Uint8Array(2 << 20));
  await a.sync();
  await b.sync();
  assert.deepEqual(Object.keys(b.snapshot()), ['.obsidian/app.json']);
});

test('a new device starts from a snapshot instead of replaying the whole log', async () => {
  const { devices: [a], net, clock } = setup(['A'], { snapshotEvery: 10 });
  for (let i = 0; i < 35; i++) {
    a.fs.put(`n${i % 7}.md`, `rev ${i}\n`);
    await a.sync();
  }
  const c = new Device('C', net, clock, { snapshotEvery: 10 });
  net.reset();
  await c.sync();
  assert.deepEqual(c.snapshot(), a.snapshot());
  assert.ok(net.stats.get < 20, `${net.stats.get} GETs`);
});

test('history lists versions and an old one can be read back', async () => {
  const { devices: [a], clock } = setup();
  for (const text of ['v1\n', 'v2\n', 'v3\n']) {
    a.fs.put('n.md', text);
    await a.sync();
    clock.now += 60_000;
  }
  a.fs.files.delete('n.md');
  await a.sync();
  const versions = await a.engine.history('n.md');
  assert.deepEqual(versions.map((v) => v.seq), [4, 3, 2, 1]);
  assert.equal(versions[0].entry, null);
  assert.equal(new TextDecoder().decode(await a.engine.readVersion(versions[2].entry!)), 'v2\n');
});

test('history includes the version that was current when the retention window began', async () => {
  const { devices: [a], clock } = setup(['A'], { snapshotEvery: 2, retentionDays: 30 });
  a.fs.put('n.md', 'old text\n');
  a.fs.put('other.md', 'x\n');
  await a.sync();
  a.fs.put('other.md', 'y\n');
  await a.sync();
  clock.now += 40 * DAY;
  a.fs.put('n.md', 'edited today\n');
  await a.sync();
  const versions = await a.engine.history('n.md');
  assert.deepEqual(versions.map((v) => v.seq), [3, 1]);
  await a.engine.gc();
  assert.equal(new TextDecoder().decode(await a.engine.readVersion(versions[1].entry!)), 'old text\n');
});

test('cleanup removes only data that no version inside the retention window needs', async () => {
  const { devices: [a, b], mem, clock } = setup(['A', 'B'], { snapshotEvery: 2, retentionDays: 7, packMaxBlobBytes: 4096 });
  a.fs.put('keep.md', 'keep\n');
  a.fs.put('old.bin', random(300_000, 1));
  await a.sync();
  clock.now += DAY;
  a.fs.put('old.bin', random(300_000, 2));
  await a.sync();
  const packs = () => [...mem.objects.keys()].filter((k) => k.startsWith('pack/')).length;
  const before = packs();

  assert.equal((await a.engine.gc()).packsDeleted, 0, 'the first version is still inside the window');
  clock.now += 3 * DAY;
  a.fs.put('later.md', 'later\n');
  await a.sync();
  a.fs.put('later.md', 'later 2\n');
  await a.sync(); // commit 4 writes a snapshot that will become the floor
  clock.now += 10 * DAY;
  const r = await a.engine.gc();
  assert.ok(r.packsDeleted >= 1 && r.bytesFreed >= 300_000, JSON.stringify(r));
  assert.ok(packs() < before + 2);

  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());

  a.fs.put('fresh.bin', random(10_000, 3));
  await a.sync();
  const fresh = (await a.engine.view()).st.remote.get('fresh.bin')!.chunks.map((c) => `pack/${c.pack}`);
  a.fs.files.delete('fresh.bin');
  await a.sync();
  // The cleanup above copied the current data of the small packs into one; the next frees the old ones.
  assert.ok(r.packsCombined >= 2, JSON.stringify(r));
  assert.equal((await a.engine.gc()).packsDeleted, r.packsCombined, 'recent packs are never collected');
  assert.ok(fresh.every((k) => mem.objects.has(k)));
});

test('remote corruption is detected, not written into the vault', async () => {
  const { devices: [a, b], mem } = setup();
  a.fs.put('n.md', 'important\n'.repeat(100));
  await a.sync();
  for (const [key, o] of mem.objects) if (key.startsWith('pack/')) o.data[o.data.length >> 1] ^= 0xff;
  const r = await b.sync();
  assert.deepEqual(r.errors.map((e) => e.path), ['n.md']);
  assert.match(r.errors[0].message, /authentication/);
  assert.equal(b.fs.files.size, 0);
});

test('a wrong passphrase is reported as such', async () => {
  const { devices: [a], net, clock } = setup();
  a.fs.put('n.md', 'x');
  await a.sync();
  const b = new Device('B', net, clock);
  (b as unknown as { engine: unknown }).engine = new (await import('../src/core/engine.ts')).SyncEngine({
    fs: b.fs, store: net, stateStore: b.state, passphrase: 'not it', config: b.config,
  });
  await assert.rejects(b.sync(), /Wrong passphrase/);
});

test('three devices committing at once all converge', async () => {
  const { devices } = setup(['A', 'B', 'C']);
  const [a, b, c] = devices;
  a.fs.put('shared.md', 'top\n\nmiddle\n\nbottom\n');
  await a.sync();
  await Promise.all([b.sync(), c.sync()]);
  a.fs.put('a.md', 'a\n');
  b.fs.put('b.md', 'b\n');
  c.fs.put('c.md', 'c\n');
  a.fs.put('shared.md', 'TOP\n\nmiddle\n\nbottom\n');
  c.fs.put('shared.md', 'top\n\nmiddle\n\nBOTTOM\n');
  await Promise.all(devices.map((d) => d.sync()));
  for (let i = 0; i < 2; i++) for (const d of devices) await d.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.deepEqual(c.snapshot(), a.snapshot());
  assert.equal(a.fs.text('shared.md'), 'TOP\n\nmiddle\n\nBOTTOM\n');
  assert.equal(a.fs.files.size, 4);
});

test('a commit whose confirmation is lost is recognised as our own, not as a conflict', async () => {
  const { devices: [a, b], net } = setup();
  a.fs.put('n.md', 'one\n');
  await a.sync();
  await b.sync();
  const put = net.put.bind(net);
  let lied = false;
  net.put = async (key, data, opts) => {
    const ok = await put(key, data, opts);
    if (ok && opts?.ifNoneMatch && key.startsWith('log/') && !lied) {
      lied = true;
      return false; // stored, but the caller is told it was not (a retried request after a dropped reply)
    }
    return ok;
  };
  a.fs.put('n.md', 'one\ntwo\n');
  a.fs.put('new.md', 'new\n');
  const r = await a.sync();
  assert.ok(lied);
  assert.deepEqual(r.conflictCopies, []);
  assert.deepEqual(r.errors, []);
  await b.sync();
  await a.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.deepEqual(Object.keys(a.snapshot()), ['n.md', 'new.md']);
  assert.equal(b.fs.text('n.md'), 'one\ntwo\n');
});

test('a file that was only touched does not stop remote changes from arriving', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('n.md', 'one\n');
  await a.sync();
  await b.sync();
  a.fs.put('other.md', 'from A\n');
  await a.sync();
  b.fs.put('n.md', 'one\n'); // same content, new timestamp
  const r = await b.sync();
  assert.equal(r.pushed, 0);
  assert.equal(b.fs.text('other.md'), 'from A\n');
});

test('history reaches past thousands of commits using one request per snapshot interval', async () => {
  const { devices: [a], net, clock } = setup(['A'], { snapshotEvery: 20, retentionDays: 30 });
  a.fs.put('target.md', 'first\n');
  await a.sync();
  for (let i = 0; i < 2500; i++) {
    clock.now += 60_000;
    a.fs.put(i === 1200 ? 'target.md' : `other${i % 5}.md`, `rev ${i}\n`);
    await a.sync();
  }
  net.reset();
  const versions = await a.engine.history('target.md');
  assert.deepEqual(versions.map((v) => v.seq), [1202, 1]);
  assert.equal(new TextDecoder().decode(await a.engine.readVersion(versions[1].entry!)), 'first\n');
  assert.ok(net.stats.get < 200, `${net.stats.get} requests for 2,501 commits`);

  clock.now += 29 * DAY;
  assert.deepEqual((await a.engine.history('target.md')).map((v) => v.seq), [1202, 1], 'the first version was still current inside the window');
  clock.now += 2 * DAY;
  assert.deepEqual((await a.engine.history('target.md')).map((v) => v.seq), [1202], 'versions replaced before the retention window are not offered');
});

test('the passphrase can be changed without re-uploading anything', async () => {
  const { devices: [a, b], net, clock } = setup();
  a.fs.put('n.md', 'x\n');
  await a.sync();
  await b.sync();
  net.reset();
  await a.engine.changePassphrase('new passphrase');
  assert.equal(net.stats.put, 1);
  a.fs.put('n.md', 'x\ny\n');
  await a.sync();

  const { SyncEngine } = await import('../src/core/engine.ts');
  const fresh = (passphrase: string) => {
    const d = new Device('C', net, clock);
    d.engine = new SyncEngine({ fs: d.fs, store: net, stateStore: d.state, passphrase, config: d.config });
    return d;
  };
  await assert.rejects(fresh('test passphrase').sync(), /Wrong passphrase/);
  const c = fresh('new passphrase');
  await c.sync();
  assert.equal(c.fs.text('n.md'), 'x\ny\n');
  // A device that was already running keeps working with the key it holds.
  await b.sync();
  assert.equal(b.fs.text('n.md'), 'x\ny\n');
});

test('checking for remote changes is one tiny request and no local work', async () => {
  const { devices: [a, b], net } = setup();
  a.fs.put('n.md', 'x\n');
  await a.sync();
  await b.sync();
  net.reset();
  assert.equal(await b.engine.remoteChanged(), false);
  assert.deepEqual([net.stats.get, net.stats.down], [1, 0]);
  a.fs.put('n.md', 'x\ny\n');
  await a.sync();
  net.reset();
  assert.equal(await b.engine.remoteChanged(), true);
  assert.ok(net.stats.down <= 1);
});

test('progress is reported for uploads and downloads', async () => {
  const { devices: [a, b], net, clock } = setup();
  for (let i = 0; i < 25; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  const seen: string[] = [];
  const { SyncEngine } = await import('../src/core/engine.ts');
  for (const d of [a, b]) {
    d.engine = new SyncEngine({
      fs: d.fs, store: net, stateStore: d.state, passphrase: 'test passphrase', config: d.config, now: () => clock.now,
      onProgress: (p) => seen.push(`${p.phase} ${p.done}/${p.total}`),
    });
    await d.sync();
  }
  assert.ok(seen.includes('upload 25/25') && seen.includes('download 25/25'), seen.slice(-3).join(', '));
});

test('a file that cannot be read is reported once', async () => {
  const { devices: [a] } = setup(['A']);
  a.fs.put('ok.md', 'ok\n');
  await a.sync();
  a.fs.put('locked.md', 'locked\n');
  const read = a.fs.read.bind(a.fs);
  a.fs.read = async (path) => {
    if (path === 'locked.md') throw new Error('EACCES: permission denied');
    return read(path);
  };
  const r = await a.sync();
  assert.deepEqual(r.errors, [{ path: 'locked.md', message: 'EACCES: permission denied' }]);
});

test('download progress never counts past its total', async () => {
  const { devices: [a, b], net, clock } = setup();
  a.fs.put('pic.bin', random(5000, 1));
  await a.sync();
  await b.sync();
  a.fs.put('pic.bin', random(5000, 2));
  b.fs.put('pic.bin', random(5000, 3));
  await a.sync();
  const seen: { done: number; total: number }[] = [];
  b.engine = new SyncEngine({
    fs: b.fs, store: net, stateStore: b.state, passphrase: 'test passphrase', config: b.config, now: () => clock.now,
    onProgress: (p) => p.phase === 'download' && seen.push(p),
  });
  assert.equal((await b.sync()).conflictCopies.length, 1);
  assert.ok(seen.length > 0);
  for (const p of seen) assert.ok(p.done <= p.total, `${p.done} of ${p.total}`);
});

test('a file that grows past the size limit is reported, not deleted from other devices', async () => {
  const { devices: [a, b] } = setup(['A', 'B'], { maxFileSizeMB: 1 });
  a.fs.put('video.bin', random(500_000, 1));
  await a.sync();
  await b.sync();
  a.fs.put('video.bin', random(2 << 20, 2));
  const r = await a.sync();
  assert.deepEqual(r.tooLarge, ['video.bin']);
  assert.equal(r.deletedRemote, 0);
  await b.sync();
  assert.ok(b.fs.files.has('video.bin'), 'the other device keeps its copy');
});

test('a remote file over this device\'s size limit is reported as not synced here', async () => {
  const { devices: [a], net, clock } = setup(['A'], { maxFileSizeMB: 0 });
  a.fs.put('big.bin', random(2 << 20, 3));
  a.fs.put('note.md', 'hi\n');
  await a.sync();
  const b = new Device('B', net, clock, { maxFileSizeMB: 1 });
  const r = await b.sync();
  assert.deepEqual(r.tooLarge, ['big.bin']);
  assert.ok(!b.fs.files.has('big.bin'));
  assert.ok(b.fs.files.has('note.md'));
});

test('after a paused mass delete, keeping all files brings them back on both sides', async () => {
  const { devices: [a, b] } = setup();
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  await b.sync();

  a.fs.files.clear(); // deleted here by mistake
  await assert.rejects(a.sync(), SafetyError);
  assert.equal(await a.engine.keepAllFiles(), 30);
  await a.sync();
  assert.equal(a.fs.files.size, 30);

  a.fs.files.clear();
  await a.sync(true); // deleted on purpose there, but this device wants to keep them
  await assert.rejects(b.sync(), SafetyError);
  assert.equal(await b.engine.keepAllFiles(), 30);
  await b.sync();
  assert.equal(b.fs.files.size, 30);
  await a.sync();
  assert.equal(a.fs.files.size, 30);
});

test('a commit lists its files in the order they were planned, whichever is prepared first', async () => {
  const { devices: [a] } = setup(['A']);
  for (const name of ['a.bin', 'b.bin', 'c.bin']) a.fs.put(name, random(20_000, name.charCodeAt(0)));
  const read = a.fs.read.bind(a.fs);
  const delay: Record<string, number> = { 'a.bin': 30, 'b.bin': 15, 'c.bin': 0 };
  a.fs.read = async (path) => {
    await new Promise((r) => setTimeout(r, delay[path] ?? 0));
    return read(path);
  };
  await a.sync();
  const { repo } = await a.engine.view();
  assert.deepEqual((await repo.readCommit(1))!.changes.map((c) => c.path), ['a.bin', 'b.bin', 'c.bin']);
});

test('the delete limit is the larger of a count and a share of the files last synced', () => {
  const cfg = { maxDeleteCount: 10, maxDeleteFraction: 0.5 };
  assert.equal(deleteLimit(13, cfg), 10);
  assert.equal(deleteLimit(45, cfg), 22.5);
  assert.equal(deleteLimit(0, { maxDeleteCount: 3, maxDeleteFraction: 2 }), 3);
});

async function thirty() {
  const env = setup(['A', 'B', 'C']);
  const [a, b, c] = env.devices;
  for (let i = 0; i < 30; i++) a.fs.put(`n${i}.md`, `${i}\n`);
  await a.sync();
  await b.sync();
  await c.sync();
  return { ...env, a, b, c };
}

const names = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `n${from + i}.md`);

test('deletions the user confirmed get past the guard, here and on other devices', async () => {
  const { a, b } = await thirty();
  const restored = names(0, 20);
  for (const p of [...restored, 'n20.md', 'n21.md']) a.fs.files.delete(p);
  const r = await a.engine.sync({ allowDeletes: restored });
  assert.equal(r.deletedRemote, 22);
  const got = await b.sync();
  assert.equal(got.deletedLocal, 22);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('deletions nobody confirmed still count in full, beside confirmed ones and from other devices', async () => {
  const { a, b, c } = await thirty();
  for (const p of names(0, 21)) a.fs.files.delete(p);
  const e = await a.engine.sync({ allowDeletes: names(0, 5) }).then(() => assert.fail('expected a refusal'), (x: unknown) => x);
  assert.ok(e instanceof SafetyError);
  assert.deepEqual([e.localDeletes, e.remoteDeletes], [0, 16], 'only the deletions nobody confirmed are counted and reported');
  assert.equal((await b.sync()).deletedLocal, 0, 'nothing was deleted');

  // A restore on A, while C deletes many others without asking: B pauses for C's only.
  for (const [p, f] of b.fs.files) a.fs.files.set(p, f);
  await a.sync();
  for (const p of names(0, 10)) a.fs.files.delete(p);
  await a.engine.sync({ allowDeletes: names(0, 10) });
  await c.sync();
  for (const p of names(10, 26)) c.fs.files.delete(p);
  await c.sync(true);
  const paused = await b.sync().then(() => assert.fail('expected a refusal'), (x: unknown) => x);
  assert.ok(paused instanceof SafetyError);
  assert.deepEqual([paused.localDeletes, paused.remoteDeletes], [16, 0]);
  assert.equal((await b.sync(true)).deletedLocal, 26);
});

test('only deletions the sync finds and was told of are marked, in a commit of their own', async () => {
  const { a, b } = await thirty();
  for (const p of names(0, 20)) a.fs.files.delete(p);
  a.fs.files.delete('n29.md');
  a.fs.put('n28.md', 'edited\n');
  const r = await a.engine.sync({ allowDeletes: [...names(0, 20), 'n25.md', 'never existed.md'] });
  assert.deepEqual([r.deletedRemote, r.pushed], [21, 1]);
  const { repo, st } = await a.engine.view();
  assert.ok(st.remote.has('n25.md'), 'named, but still there: not deleted');
  const commits = await Promise.all([2, 3].map((seq) => repo.readCommit(seq)));
  const marked = commits.filter((c) => c!.confirmed);
  assert.equal(marked.length, 1);
  assert.deepEqual(marked[0]!.changes.map((c) => [c.path, c.entry]), names(0, 20).map((p) => [p, null]));
  const other = commits.find((c) => !c!.confirmed)!;
  assert.deepEqual(other.changes.map((c) => [c.path, !!c.entry]).sort(), [['n28.md', true], ['n29.md', false]]);
  await b.sync();
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a device that restarts before it could delete confirmed files still does not count them', async () => {
  const { a, b } = await thirty();
  for (const p of names(0, 20)) a.fs.files.delete(p);
  a.fs.put('n25.md', 'restored version\n');
  await a.engine.sync({ allowDeletes: names(0, 20) });
  const remove = b.fs.remove.bind(b.fs);
  b.fs.remove = async () => {
    throw new Error('EBUSY');
  };
  const r = await b.sync();
  assert.deepEqual([r.pulled, r.deletedLocal, r.errors.length], [1, 0, 20]);
  b.fs.remove = remove;
  b.restart();
  assert.equal((await b.sync()).deletedLocal, 20);
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('a sync writes the state file once, and not at all when nothing changed', async () => {
  const { devices: [a, b] } = setup();
  a.fs.put('a.md', 'a\n');
  await a.sync();
  await b.sync();
  const saves = (d: typeof a) => {
    let n = 0;
    const save = d.state.save.bind(d.state);
    d.state.save = async (data) => {
      n++;
      return save(data);
    };
    return () => n;
  };
  const [savedA, savedB] = [saves(a), saves(b)];
  await a.sync();
  assert.equal(savedA(), 0, 'nothing to do');
  a.fs.put('a.md', 'a\nb\n');
  a.fs.put('c.md', 'c\n');
  await a.sync();
  assert.equal(savedA(), 1, 'one commit');
  await b.sync();
  assert.equal(savedB(), 1, 'two files received');
  b.fs.put('a.md', 'a\nb\nfrom B\n');
  a.fs.put('a.md', 'from A\na\nb\n');
  await a.sync();
  await b.sync();
  assert.equal(savedB(), 2, 'a merge received and sent: once, after its commit');
});
