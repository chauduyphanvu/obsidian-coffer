import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/stores/memory.ts';
import { rng } from '../src/testing/netsim.ts';
import { Device } from './helpers.ts';

const MB = 1 << 20;

const random = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

/** Device A holds everything; B leaves files over 1 MB in storage. */
function setup() {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  return { clock, a: new Device('A', mem, clock), b: new Device('B', mem, clock, { deferAboveMB: 1 }) };
}

const remoteHas = async (d: Device, path: string) => (await d.engine.view()).st.remote.has(path);

test('a file the rule wants is downloaded by a sync, and one it does not want stays in storage', async () => {
  const { a, b } = setup();
  a.fs.put('wanted.bin', random(2 * MB, 1));
  a.fs.put('other.bin', random(2 * MB, 2));
  await a.sync();
  b.keep = (key) => key === 'wanted.bin';

  const r = await b.sync();
  assert.deepEqual(r.deferred, ['other.bin']);
  assert.ok(b.fs.files.has('wanted.bin') && !b.fs.files.has('other.bin'));

  b.keep = () => true;
  let listed = 0;
  const list = b.fs.list.bind(b.fs);
  b.fs.list = () => {
    listed++;
    return list();
  };
  assert.deepEqual((await b.engine.sync({ changed: [] })).deferred, [], 'the rule is asked again at every sync, also one told that nothing changed');
  assert.equal(listed, 0);
  assert.ok(b.fs.files.has('other.bin'));
});

test('evict removes a file from this device only: storage and the other device keep it, and it can be fetched again', async () => {
  const { a, b } = setup();
  const data = random(2 * MB, 1);
  a.fs.put('big.bin', data);
  a.fs.put('small.bin', random(1000, 2));
  a.fs.put('note.md', 'hi\n');
  await a.sync();
  await b.engine.sync({ fetch: ['big.bin'] });
  assert.ok(b.fs.files.has('big.bin'));

  const out = await b.engine.evict(['big.bin', 'small.bin', 'note.md', 'nothing.bin']);
  assert.deepEqual(out.evicted, ['big.bin']);
  assert.deepEqual(out.left, [
    { path: 'note.md', why: 'kept' },
    { path: 'nothing.bin', why: 'not-here' },
    { path: 'small.bin', why: 'kept' },
  ]);
  assert.ok(!b.fs.files.has('big.bin') && b.fs.files.has('small.bin') && b.fs.files.has('note.md'));

  for (const restart of [false, true]) {
    if (restart) b.restart();
    const r = await b.sync();
    assert.deepEqual([r.deletedRemote, r.pulled, r.pushed, r.commits], [0, 0, 0, 0], 'no deletion is sent');
    assert.deepEqual(r.deferred, ['big.bin']);
  }
  assert.equal((await b.engine.sync({ changed: ['big.bin'] })).deletedRemote, 0, 'nor by a sync told the file went');
  assert.deepEqual((await a.sync()).deletedLocal, 0);
  assert.ok(a.fs.files.has('big.bin') && (await remoteHas(a, 'big.bin')));

  await b.engine.sync({ fetch: ['big.bin'] });
  assert.deepEqual(b.fs.files.get('big.bin')!.data, data);
});

test('evict leaves a file changed here since its last sync, and one storage holds a newer version of', async () => {
  const { a, b } = setup();
  a.fs.put('edited.bin', random(2 * MB, 1));
  a.fs.put('stale.bin', random(2 * MB, 2));
  await a.sync();
  await b.engine.sync({ fetch: ['edited.bin', 'stale.bin'] });

  const mine = random(2 * MB, 3);
  b.fs.put('edited.bin', mine);
  a.fs.put('stale.bin', random(2 * MB, 4));
  await a.sync();
  await b.engine.view();

  const out = await b.engine.evict(['edited.bin', 'stale.bin']);
  assert.deepEqual(out, { evicted: [], left: [{ path: 'edited.bin', why: 'changed' }, { path: 'stale.bin', why: 'changed' }] });
  assert.deepEqual(b.fs.files.get('edited.bin')!.data, mine);
  await b.sync();
  await a.sync();
  assert.deepEqual(a.fs.files.get('edited.bin')!.data, mine, 'the edit still reaches the other device');
});

test('evict with no paths removes every file over the limit the rule does not want, and keeps the rest', async () => {
  const { a, b } = setup();
  a.fs.put('a.bin', random(2 * MB, 1));
  a.fs.put('b.bin', random(2 * MB, 2));
  a.fs.put('small.bin', random(1000, 3));
  await a.sync();
  b.keep = () => true;
  await b.sync();
  assert.equal(b.fs.files.size, 3);

  b.keep = (key) => key === 'a.bin';
  const out = await b.engine.evict();
  assert.deepEqual(out, { evicted: ['b.bin'], left: [{ path: 'a.bin', why: 'kept' }] });
  assert.deepEqual([...b.fs.files.keys()].sort(), ['a.bin', 'small.bin']);
  assert.deepEqual((await b.sync()).deferred, ['b.bin']);
});

test('a copy of a file that stays is not evicted: the next sync would only bring it back', async () => {
  const { a, b } = setup();
  const data = random(2 * MB, 1);
  a.fs.put('one.bin', data);
  a.fs.put('two.bin', data);
  await a.sync();
  b.keep = () => true;
  await b.sync();

  b.keep = (key) => key === 'one.bin';
  assert.deepEqual((await b.engine.evict()).evicted, []);
  b.keep = () => false;
  assert.deepEqual((await b.engine.evict()).evicted, ['one.bin', 'two.bin']);
});

test('stopped between forgetting a file and removing it, the next sync takes the file back and deletes nothing', async () => {
  const { a, b } = setup();
  a.fs.put('big.bin', random(2 * MB, 1));
  await a.sync();
  await b.engine.sync({ fetch: ['big.bin'] });

  // The app dies inside the removal: the state is saved, the file still there.
  const crashed = new Error('killed');
  b.fs.discard = () => Promise.reject(crashed);
  const saved = b.state.data;
  const save = b.state.save.bind(b.state);
  let atCrash: string | null = null;
  b.state.save = async (data) => {
    atCrash ??= data;
    await save(data);
  };
  const out = await b.engine.evict(['big.bin']);
  assert.deepEqual(out.left, [{ path: 'big.bin', why: 'failed', message: 'killed' }], 'a removal that fails leaves the file known as before');
  assert.notEqual(atCrash, saved);

  b.state.data = atCrash;
  b.state.save = save;
  b.restart();
  const r = await b.sync();
  assert.deepEqual([r.deletedRemote, r.deletedLocal, r.pushed, r.conflictCopies.length, r.errors.length], [0, 0, 0, 0, 0]);
  assert.ok(b.fs.files.has('big.bin'));
  assert.deepEqual((await a.sync()).deletedLocal, 0);
  assert.ok(a.fs.files.has('big.bin'));
  assert.deepEqual((await b.engine.evict(['big.bin'])).left, [{ path: 'big.bin', why: 'failed', message: 'killed' }], 'known again, so it can be evicted');
});

test('an evicted file moved or deleted on another device follows in storage without touching this device', async () => {
  const { a, b } = setup();
  a.fs.put('big.bin', random(2 * MB, 1));
  a.fs.put('gone.bin', random(2 * MB, 2));
  await a.sync();
  await b.engine.sync({ fetch: ['big.bin', 'gone.bin'] });
  assert.deepEqual((await b.engine.evict()).evicted, ['big.bin', 'gone.bin']);

  await a.fs.rename('big.bin', 'moved/big.bin');
  a.fs.files.delete('gone.bin');
  await a.sync();
  const r = await b.sync();
  assert.deepEqual(r.deferred, ['moved/big.bin']);
  assert.deepEqual([r.pulled, r.deletedLocal, r.deletedRemote, r.errors.length], [0, 0, 0, 0]);
  assert.equal(b.fs.files.size, 0);
});

test('the rule is told whether it is asked about a file here: one it would only hold on to is not downloaded, and not evicted', async () => {
  const { a, b } = setup();
  a.fs.put('shown.bin', random(2 * MB, 1));
  await a.sync();
  b.keep = (_key, here) => here;
  assert.deepEqual((await b.sync()).deferred, ['shown.bin']);
  assert.deepEqual((await b.engine.sync({ changed: [] })).deferred, ['shown.bin']);
  await b.engine.sync({ fetch: ['shown.bin'] });
  assert.deepEqual(await b.engine.evict(), { evicted: [], left: [{ path: 'shown.bin', why: 'kept' }] });
  b.keep = () => false;
  assert.deepEqual((await b.engine.evict()).evicted, ['shown.bin']);
});
