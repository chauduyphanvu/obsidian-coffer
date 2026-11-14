// Notes shared by a property: reading and editing the property, the file system its engine sees, and the rules
// around it. Scenarios with whole devices syncing are in byproperty-sync.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileExcludes } from '../src/core/config.ts';
import { entries, frontmatter } from '../src/core/merge.ts';
import type { Held, LocalFS, LocalFile } from '../src/core/types.ts';
import {
  NotSendingError, OtherSenderError, PropertyFS, VaultNotListedError, carries, embedLinks, findMoves, inviteProblem, joinProblem, keptText, newEmbeds, noteInShare, onlyShownBy, otherSender,
  propertyProblems, readAlready, removedText, sendProblem, settleChoices, shareValues, startProblem, withShare, withoutShare, writeProblem, type PropertyShare,
} from '../src/plugin/byproperty.ts';
import { publishOffer, type Docs } from '../src/plugin/offers.ts';
import { pausesOn } from '../src/plugin/polling.ts';
import { defaultSettings, folderProblem, loadSettings, propertyConfig, shareWith, syncConfig, type Settings } from '../src/plugin/settings.ts';
import { followRename, goneWith, makeEngine, placeOf, propertyPlaces, vaultPath, type EngineHost } from '../src/plugin/shares.ts';
import { describeFailure, inShare } from '../src/plugin/status.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { FakeCatalog } from './helpers.ts';

const NAME = 'Family';

// Reading the property from bytes.

test('the property: a value or a list, the key in any letter case, quoted, commented, CRLF', () => {
  const says = (props: string) => carries(`---\n${props}\n---\nbody\n`, NAME);
  for (const yes of ['share: Family', 'share: family', 'Share: Family', 'SHARE: Family', 'share: "Family"', "share: 'Family'", 'share: Family # mine', 'share: [family, work]', 'share: [Work, "Family"]', 'share:\n  - work\n  - Family', 'share:\n- Family', 'share:   Family  ', 'tags: [a]\nshare: Family\ntitle: x']) {
    assert.ok(says(yes), yes);
  }
  for (const no of ['share: Familyx', 'share: true', 'shares: Family', 'share-with: Family', 'share: [Work]', 'share:', 'share: Fam ily', 'share: |\n  Family', 'share:\n  name: Family', 'title: share: Family', '# share: Family']) {
    assert.ok(!says(no), no);
  }
  assert.ok(carries('---\r\nshare: Family\r\n---\r\nbody\r\n', NAME), 'CRLF');
  assert.ok(carries('---\r\nshare:\r\n  - Family\r\n---\r\n', NAME), 'CRLF list');
  assert.ok(!carries('---\r\nshare: Familyx\r\n---\r\n', NAME));
  // Only the properties block counts: the body, a code block, a later block or a block cut short do not.
  assert.ok(!carries('Text\nshare: Family\n', NAME));
  assert.ok(!carries('# Note\n\n```yaml\n---\nshare: Family\n---\n```\n', NAME));
  assert.ok(!carries('\n---\nshare: Family\n---\n', NAME));
  assert.ok(!carries('---\nshare: Family\n', NAME));
  // A block that can not be read names no share, rather than guessing.
  assert.equal(shareValues('---\nshare: Family\nshare: Work\n---\n'), undefined);
  assert.ok(!carries('---\nshare: Family\n: broken\n---\n', NAME));
  assert.deepEqual(shareValues('---\nshare: [a, "b, c", \'d\'\'s\']\n---\n'), ['a', 'b, c', "d's"]);
});

test('core: a properties block and its entries are cut so that they put the note back together byte for byte', () => {
  for (const text of ['---\nshare: Family\ntags:\n  - a\n# note\n---\nbody', '---\r\nshare: [a, b]\r\n\r\ntitle: "x: y"\r\n---\r\n', '---\n---\n']) {
    const fm = frontmatter(text)!;
    assert.equal(fm.open + fm.props + fm.close + fm.body, text);
    assert.equal([...entries(fm.props)!.values()].join(''), fm.props);
  }
});

test('removing the property changes nothing else: a value, one item of a list, CRLF and comments kept', () => {
  assert.equal(withoutShare('---\ntitle: Pie # best\nshare: Family\ntags: [x]\n---\nbody\n', NAME), '---\ntitle: Pie # best\ntags: [x]\n---\nbody\n');
  assert.equal(withoutShare('---\nshare: [family, work]\n---\nbody', NAME), '---\nshare: [work]\n---\nbody');
  assert.equal(withoutShare('---\r\nshare:\r\n  - Work # kept\r\n  - Family\r\nnext: 1\r\n---\r\nbody\r\n', NAME), '---\r\nshare:\r\n  - Work # kept\r\nnext: 1\r\n---\r\nbody\r\n');
  // A block left with nothing goes, as it was before the note was shared.
  assert.equal(withoutShare('---\nshare: Family\n---\nbody\n', NAME), 'body\n');
  assert.equal(withoutShare('---\nshare: Work\n---\nbody\n', NAME), '---\nshare: Work\n---\nbody\n');
  assert.equal(withoutShare('no properties\n', NAME), 'no properties\n');
  assert.equal(withoutShare('---\nshare: Family\nshare: x\n---\n', NAME), undefined, 'unreadable: not touched');
  for (const t of ['---\nshare: [family, work]\n---\n', '---\r\nshare:\r\n  - Work\r\n  - Family\r\n---\r\n', '---\nShare: Family\na: 1\n---\nx']) assert.ok(!carries(withoutShare(t, NAME)!, NAME), t);
});

test('removing or adding the property keeps the comments and blank lines after it, which may be about the next key', () => {
  assert.equal(withoutShare('---\ntags: [a]\nshare: Family\n# Dates\ncreated: 2024\n---\nbody', NAME), '---\ntags: [a]\n# Dates\ncreated: 2024\n---\nbody');
  assert.equal(withoutShare('---\nshare: Family\n\n# next\ncreated: 2024\n---\nbody', NAME), '---\n\n# next\ncreated: 2024\n---\nbody');
  assert.equal(withoutShare('---\nshare:\n  - Family\n# note\ncreated: 2024\n---\nbody', NAME), '---\n# note\ncreated: 2024\n---\nbody');
  assert.equal(withoutShare('---\nshare: [Family, work]\n# Dates\ncreated: 2024\n---\nbody', NAME), '---\nshare: [work]\n# Dates\ncreated: 2024\n---\nbody');
  assert.equal(withoutShare('---\r\nshare: Family\r\n# Dates\r\n---\r\nbody', NAME), '---\r\n# Dates\r\n---\r\nbody');
  assert.equal(withShare('---\nshare: work\n# Dates\ncreated: 2024\n---\nbody', NAME), '---\nshare: [work, Family]\n# Dates\ncreated: 2024\n---\nbody');
});

test('adding the property changes nothing else, and reads back as shared', () => {
  assert.equal(withShare('body\n', NAME), '---\nshare: Family\n---\nbody\n');
  assert.equal(withShare('body\r\nmore\r\n', NAME), '---\r\nshare: Family\r\n---\r\nbody\r\nmore\r\n');
  assert.equal(withShare('---\ntitle: x # c\n---\nbody', NAME), '---\ntitle: x # c\nshare: Family\n---\nbody');
  assert.equal(withShare('---\nshare: Work\n---\n', NAME), '---\nshare: [Work, Family]\n---\n');
  assert.equal(withShare('---\nshare:\n  - Work\n# c\n---\n', NAME), '---\nshare:\n  - Work\n  - Family\n# c\n---\n');
  assert.equal(withShare('---\nshare: [family]\n---\n', NAME), '---\nshare: [family]\n---\n', 'already there');
  assert.equal(withShare('---\nshare: |\n  x\n---\n', NAME), undefined);
  assert.equal(withShare('---\na: 1\na: 2\n---\n', NAME), undefined);
  assert.equal(withShare('x', 'Family: Tree'), '---\nshare: "Family: Tree"\n---\nx');
  assert.equal(withShare('\uFEFFx', NAME), '\uFEFF---\nshare: Family\n---\nx', 'after a byte order mark');
  assert.equal(withoutShare('\uFEFF---\nshare: Family\n---\nx', NAME), '\uFEFFx');
  assert.ok(carries('\uFEFF---\nshare: Family\n---\nx', NAME));
  // Back to what it was, except that a value turned into a list stays one.
  for (const [t, back] of [['x', 'x'], ['---\nshare: Work\n---\n', '---\nshare: [Work]\n---\n'], ['---\r\nshare:\r\n  - Work\r\n---\r\n', '---\r\nshare:\r\n  - Work\r\n---\r\n'], ['---\n---\n', '']]) {
    const out = withShare(t, NAME)!;
    assert.ok(carries(out, NAME), t);
    assert.equal(withoutShare(out, NAME), back, `round trip ${JSON.stringify(t)}`);
  }
});

test('embeds a text shows: both forms, without alias, heading or web address', () => {
  assert.deepEqual(
    embedLinks('![[pie.jpg]] ![[Notes/x.png|200]] ![[doc.pdf#page=2]] [[link.png]] ![alt](a%20b.png) ![](<c d.png> "t") ![](https://x/y.png) !not'),
    ['pie.jpg', 'Notes/x.png', 'doc.pdf', 'a b.png', 'c d.png'],
  );
  assert.deepEqual(newEmbeds('![[a.png]]', '![[a.png]] ![[secret.png]]'), ['secret.png']);
});

// The file system the engine sees.

const held = (files: Record<string, { size: number; mtime: number }>): Held => ({ get: (k) => files[k], keys: () => Object.keys(files) });
const heldNow = (fs: MemFS, keys: string[]) => held(Object.fromEntries(keys.map((k) => [k, { size: fs.files.get(k)!.data.length, mtime: fs.files.get(k)!.mtime }])));
const keysOf = (files: LocalFile[]) => files.map((f) => f.path).sort();

function propertyFS(fs: MemFS, s: Partial<PropertyShare> = {}, exclude: string[] = []) {
  const catalog = new FakeCatalog(fs, NAME).refresh();
  const share: PropertyShare = { property: NAME, removed: [], approved: [], ask: [], ...s };
  const settings: Settings = { ...defaultSettings(false), exclude: exclude.join('\n') };
  const pfs = new PropertyFS({ inner: fs, catalog, share: () => share, excluded: compileExcludes(propertyConfig(settings, '.obsidian', '.obsidian/plugins/coffer').exclude) });
  return { pfs, catalog, share };
}

test('I1: a held note stays listed whatever the property or the cache say; one changed without it is left alone, not deleted', async () => {
  const fs = new MemFS();
  fs.put('Pie.md', '---\nshare: Family\n---\npie');
  fs.put('Cake.md', '---\nshare: Family\n---\ncake');
  const { pfs, catalog } = propertyFS(fs);
  const h = heldNow(fs, ['Pie.md', 'Cake.md']);
  // The cache forgets everything and is not ready: what is held is still all there.
  catalog.isReady = false;
  catalog.says.clear();
  assert.deepEqual(keysOf(await pfs.list(h)), ['Cake.md', 'Pie.md']);
  // Pie loses its property: it is no longer sent, and the engine leaves it alone (`sends`), so nothing deletes it.
  fs.put('Pie.md', 'pie, now private');
  catalog.isReady = true;
  catalog.refresh();
  assert.deepEqual(keysOf(await pfs.list(h)), ['Cake.md']);
  assert.equal(pfs.sends('Pie.md'), false);
  assert.equal(pfs.sends('Cake.md'), true);
  assert.deepEqual(pfs.survey()!.unmarked, ['Pie.md']);
  // Unchanged since it was sent: not even read again.
  fs.put('Cake.md', '---\nshare: Family\n---\ncake 2');
  assert.deepEqual(keysOf(await pfs.list(h)), ['Cake.md']);
});

test('I1: over random vaults and caches, every held file that exists is listed unless removed or left alone', async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let round = 0; round < 40; round++) {
    const fs = new MemFS();
    const paths = Array.from({ length: 12 }, (_, i) => (i % 4 === 3 ? `img${i}.png` : `n${i}.md`));
    for (const p of paths) fs.put(p, p.endsWith('.md') && rnd() < 0.6 ? `---\nshare: Family\n---\n${p}` : `${p} ![[img3.png]]`);
    const heldKeys = paths.filter(() => rnd() < 0.5);
    const removed = paths.filter(() => rnd() < 0.15);
    const h = heldNow(fs, heldKeys);
    for (const p of paths) if (rnd() < 0.3) fs.put(p, rnd() < 0.5 ? 'private now' : '---\nshare: Family\n---\nedited');
    for (const p of paths) if (rnd() < 0.1) fs.files.delete(p);
    const { pfs, catalog } = propertyFS(fs, { removed });
    catalog.isReady = rnd() < 0.5;
    if (rnd() < 0.5) catalog.says = new Set(paths.filter(() => rnd() < 0.5));
    const listed = new Set(keysOf(await pfs.list(h)));
    const survey = pfs.survey()!;
    for (const k of heldKeys) {
      if (!fs.files.has(k) || removed.includes(k)) continue;
      assert.ok(listed.has(k) || survey.unmarked.includes(k), `round ${round}: ${k} held and present`);
      if (survey.unmarked.includes(k)) assert.ok(!carries(fs.text(k)!, NAME) && !pfs.sends(k));
    }
    for (const k of listed) if (!heldKeys.includes(k) && k.endsWith('.md')) assert.ok(carries(fs.text(k)!, NAME), `round ${round}: ${k} joined without saying so`);
  }
});

test('I3: a note joins only once its bytes say so, and only after the cache is ready', async () => {
  const fs = new MemFS();
  fs.put('Pie.md', '---\nshare: Family\n---\npie');
  fs.put('Body.md', 'share: Family\n```\n---\nshare: Family\n---\n```');
  fs.put('Stale.md', 'no property');
  const { pfs, catalog } = propertyFS(fs);
  catalog.says.add('Body.md');
  catalog.says.add('Stale.md'); // a stale cache: says so, the bytes do not
  catalog.isReady = false;
  assert.deepEqual(keysOf(await pfs.list(held({}))), [], 'nothing before the cache is ready');
  catalog.isReady = true;
  assert.deepEqual(keysOf(await pfs.list(held({}))), ['Pie.md']);
  assert.deepEqual(pfs.survey()!.fresh, ['Pie.md']);
  // The cache lags a note that just got the property: it joins at a later listing, nothing meanwhile.
  fs.put('Late.md', '---\nshare: Family\n---\nlate');
  assert.deepEqual(keysOf(await pfs.list(held({}))), ['Pie.md']);
  catalog.refresh();
  assert.deepEqual(keysOf(await pfs.list(held({}))), ['Late.md', 'Pie.md']);
});

test('I3: an attachment joins only when a shared note shows it now; embedded notes, canvases and plain links do not', async () => {
  const fs = new MemFS();
  fs.put('pie.jpg', 'jpg');
  fs.put('recipe.pdf', 'pdf');
  fs.put('secret.png', 'png');
  fs.put('Diary.md', 'private');
  fs.put('board.canvas', '{}');
  fs.put('linked.png', 'png2');
  fs.put('Pie.md', '---\nshare: Family\n---\n![[pie.jpg]] ![[recipe.pdf]] ![[Diary]] ![[board.canvas]] [[linked.png]]');
  const { pfs, catalog } = propertyFS(fs);
  catalog.shows.get('Pie.md')!.push({ original: '![[secret.png]]', target: 'secret.png' }, { original: '![[Diary.md]]', target: 'Diary.md' });
  assert.deepEqual(keysOf(await pfs.list(held({}))), ['Pie.md', 'pie.jpg', 'recipe.pdf']);
});

test('B5: an attachment whose name another file of the vault has too waits for the sharer', async () => {
  const fs = new MemFS();
  fs.put('Trips/logo.png', 'trip logo');
  fs.put('logo.png', 'private logo');
  fs.put('Trip.md', '---\nshare: Family\n---\n![[logo.png]]');
  // Obsidian takes the embed to the private one at the root: it waits, whichever it is.
  const { pfs } = propertyFS(fs);
  assert.deepEqual(keysOf(await pfs.list(held({}))), ['Trip.md']);
  assert.deepEqual(pfs.survey()!.waiting.map((w) => [w.key, w.why]), [['logo.png', 'name']]);
  const said = propertyFS(fs, { approved: ['logo.png'] });
  assert.deepEqual(keysOf(await said.pfs.list(held({}))), ['Trip.md', 'logo.png']);
  const no = propertyFS(fs, { removed: ['logo.png'] });
  assert.deepEqual(keysOf(await no.pfs.list(held({}))), ['Trip.md']);
  assert.deepEqual(no.pfs.survey()!.waiting, []);
});

test('I7: what a suggestion taken in made a shared note show waits for the sharer', async () => {
  const fs = new MemFS();
  fs.put('secret.png', 'private');
  fs.put('Pie.md', '---\nshare: Family\n---\npie ![[secret.png]]');
  const { pfs } = propertyFS(fs, { ask: ['secret.png'] });
  assert.deepEqual(keysOf(await pfs.list(heldNow(fs, ['Pie.md']))), ['Pie.md']);
  assert.deepEqual(pfs.survey()!.waiting.map((w) => [w.key, w.why]), [['secret.png', 'suggested']]);
  assert.deepEqual(newEmbeds('pie', 'pie ![[secret.png]]'), ['secret.png']);
});

test('I6: nothing the vault leaves out here, nor the settings folder, a dot path, a script or a canvas', async () => {
  const fs = new MemFS();
  const marked = '---\nshare: Family\n---\nx';
  for (const p of ['.obsidian/plugins/x/main.md', '.hidden/a.md', 'Work/x.md', 'LeftOut/x.md', 'tool.js', 'b.canvas', 'ok.md']) fs.put(p, marked);
  const settings: Settings = { ...defaultSettings(false), exclude: 'LeftOut/', shares: [shareWith({ id: 'w', folder: 'Work' })] };
  const excluded = compileExcludes(propertyConfig(settings, '.obsidian', '.obsidian/plugins/coffer').exclude);
  const catalog = new FakeCatalog(fs, NAME).refresh();
  for (const p of fs.files.keys()) catalog.says.add(p);
  const pfs = new PropertyFS({ inner: fs, catalog, share: () => ({ property: NAME, removed: [], approved: [], ask: [] }), excluded });
  // Held files there are not listed either: the engine leaves them alone.
  assert.deepEqual(keysOf(await pfs.list(heldNow(fs, ['Work/x.md', '.hidden/a.md']))), ['ok.md']);
  assert.deepEqual(pfs.survey()!.notShared.map((n) => n.key).sort(), ['.hidden/a.md', '.obsidian/plugins/x/main.md', 'LeftOut/x.md', 'Work/x.md']);
  for (const bad of ['Work/x.md', 'LeftOut/x.md', '.obsidian/app.json', '.hidden/a.md', 'tool.js', 'b.canvas', '../x.md', 'a//b.md']) assert.throws(() => pfs.pathOf(bad), bad);
  assert.equal(pfs.pathOf('Notes/ok.md'), 'Notes/ok.md');
});

test('I5: the share can write, rename or remove nothing in the vault', async () => {
  const fs = new MemFS();
  fs.put('Pie.md', '---\nshare: Family\n---\npie');
  const { pfs } = propertyFS(fs);
  // As the engine calls it.
  const local: LocalFS = pfs;
  const before = new Map(fs.files);
  await assert.rejects(local.write('Pie.md', new Uint8Array(1)), /only sends/);
  await assert.rejects(local.write('New.md', new Uint8Array(1), 5), /only sends/);
  await assert.rejects(local.remove('Pie.md'), /only sends/);
  assert.deepEqual(fs.files, before);
});

test('I5: a suggestion is taken in only where no file is, or over a note in the share; never over a private one', () => {
  const vault = new Map([['private.md', 'Private.md'], ['pie.md', 'Pie.md']].map(([k, v]) => [k, v]));
  const o = { excluded: (k: string) => k.startsWith('Work/'), exists: (k: string) => vault.get(k.toLowerCase()), shared: (k: string) => k === 'Pie.md' };
  assert.equal(writeProblem('Pie.md', NAME, o), '');
  assert.equal(writeProblem('New.md', NAME, o), '');
  assert.match(writeProblem('Private.md', NAME, o), /not in “Family”, so it is not written over\. To take this in, rename yours first\./);
  assert.match(writeProblem('PIE.md', NAME, o), /other letter case/, 'a clash in letter case alone');
  assert.match(writeProblem('Work/a.md', NAME, o), /left out/);
  assert.match(writeProblem('a.canvas', NAME, o), /Only notes/);
});

test('I2: an empty file list while files are held stops the listing instead of deleting them', async () => {
  const fs = new MemFS();
  const { pfs } = propertyFS(fs);
  await assert.rejects(pfs.list(held({ 'Pie.md': { size: 3, mtime: 1 } })), VaultNotListedError);
  assert.deepEqual(await pfs.list(held({})), []);
});

test('B6: a held file missing from the index but there on disk is still listed', async () => {
  const fs = new MemFS();
  fs.put('Pie.md', '---\nshare: Family\n---\npie');
  fs.put('Cake.md', '---\nshare: Family\n---\ncake');
  const h = heldNow(fs, ['Pie.md', 'Cake.md']);
  const lagging = Object.assign(Object.create(fs) as MemFS, { list: async () => (await fs.list()).filter((f) => f.path !== 'Pie.md') });
  const pfs = new PropertyFS({ inner: lagging, catalog: new FakeCatalog(fs, NAME).refresh(), share: () => ({ property: NAME, removed: [], approved: [], ask: [] }), excluded: () => false });
  assert.deepEqual(keysOf(await pfs.list(h)), ['Cake.md', 'Pie.md']);
});

test('I13 B3: a held file found at another path with its size and time is a move, read from the listing alone', async () => {
  const fs = new MemFS();
  fs.put('Recipes/Pie.md', '---\nshare: Family\n---\npie ![[pie.jpg]]');
  fs.put('pie.jpg', 'jpg');
  const h = heldNow(fs, ['Recipes/Pie.md', 'pie.jpg']);
  const move = (a: string, b: string) => {
    fs.files.set(b, fs.files.get(a)!);
    fs.files.delete(a);
  };
  move('Recipes/Pie.md', 'Dinner/Pie.md');
  move('pie.jpg', 'Attachments/pie.jpg');
  const { pfs, catalog } = propertyFS(fs);
  catalog.isReady = false;
  assert.deepEqual(keysOf(await pfs.list(h)), ['Attachments/pie.jpg', 'Dinner/Pie.md']);
  assert.deepEqual(pfs.survey()!.moved.sort(), [['Recipes/Pie.md', 'Dinner/Pie.md'], ['pie.jpg', 'Attachments/pie.jpg']]);
  // Nothing was kept: another listing, as after a restart, finds the same.
  const again = propertyFS(fs);
  assert.deepEqual(keysOf(await again.pfs.list(h)), ['Attachments/pie.jpg', 'Dinner/Pie.md']);
  // A private note that happens to have a gone note's size and time does not come in that way.
  const fs2 = new MemFS();
  fs2.put('Pie.md', '---\nshare: Family\n---\npie');
  const h2 = heldNow(fs2, ['Pie.md']);
  fs2.files.set('Diary.md', { data: new TextEncoder().encode('diary, never shared at al'), mtime: fs2.files.get('Pie.md')!.mtime });
  fs2.files.delete('Pie.md');
  assert.equal(fs2.files.get('Diary.md')!.data.length, h2.get('Pie.md')!.size);
  const priv = propertyFS(fs2);
  assert.deepEqual(keysOf(await priv.pfs.list(h2)), []);
  // Nor does a picture that no shared note names: a private copy kept with its time, the shared one deleted.
  const fs3 = new MemFS();
  fs3.put('Pie.md', '---\nshare: Family\n---\npie');
  fs3.put('pie.jpg', 'jpg');
  const h3 = heldNow(fs3, ['Pie.md', 'pie.jpg']);
  fs3.files.set('Private/pie.jpg', fs3.files.get('pie.jpg')!);
  fs3.files.delete('pie.jpg');
  const copy = propertyFS(fs3);
  copy.catalog.isReady = false;
  assert.deepEqual(keysOf(await copy.pfs.list(h3)), ['Pie.md']);
  assert.deepEqual(copy.pfs.survey()!.moved, []);
});

test('I13: moves are matched only when nothing else could be meant', async () => {
  const f = (path: string, size: number, mtime: number): [string, LocalFile] => [path, { path, size, mtime }];
  const stats: Record<string, { size: number; mtime: number }> = { 'a.md': { size: 3, mtime: 1 }, 'c.md': { size: 5, mtime: 9 }, 'x.png': { size: 3, mtime: 1 }, 'm.md': { size: -1, mtime: -1 } };
  const was = (k: string) => stats[k];
  assert.deepEqual(await findMoves(['a.md'], was, new Map([f('A2.md', 3, 1)])), [['a.md', 'A2.md']]);
  assert.deepEqual(await findMoves(['a.md'], was, new Map([f('A2.md', 3, 1), f('A3.md', 3, 1)])), [], 'two candidates');
  assert.deepEqual(await findMoves(['a.md', 'x.png'], was, new Map([f('A2.md', 3, 1)])), [], 'two gone with the same stat');
  assert.deepEqual(await findMoves(['x.png'], was, new Map([f('A2.md', 3, 1)])), [], 'not the same kind');
  assert.deepEqual(await findMoves(['x.png'], was, new Map([f('x.jpg', 3, 1)])), [], 'not the same extension');
  assert.deepEqual(await findMoves(['c.md'], was, new Map([f('C2.md', 6, 9)])), [], 'changed as well');
  assert.deepEqual(await findMoves(['m.md'], was, new Map([f('M2.md', -1, -1)])), [], 'merged, so its stat is not known');
});

test('I13: files with the same size and time are told apart by their content, else by their name and the folders they keep', async () => {
  const f = (path: string): [string, LocalFile] => [path, { path, size: 3, mtime: 1 }];
  const was = () => ({ size: 3, mtime: 1 });
  const sorted = (m: [string, string][]) => m.sort(([a], [b]) => (a < b ? -1 : 1));
  // A folder of notes made together, moved, with nothing to compare their content with: the names decide.
  assert.deepEqual(sorted(await findMoves(['Club/a.md', 'Club/b.md'], was, new Map([f('Groups/Club/a.md'), f('Groups/Club/b.md')]))), [
    ['Club/a.md', 'Groups/Club/a.md'],
    ['Club/b.md', 'Groups/Club/b.md'],
  ]);
  // The same name in two folders, both moved into a third: the folder each keeps decides.
  assert.deepEqual(sorted(await findMoves(['A/x.md', 'B/x.md'], was, new Map([f('Z/A/x.md'), f('Z/B/x.md')]))), [
    ['A/x.md', 'Z/A/x.md'],
    ['B/x.md', 'Z/B/x.md'],
  ]);
  assert.deepEqual(await findMoves(['a.png'], was, new Map([f('x/a.png'), f('y/a.png')])), [], 'two copies and nothing to tell them apart');
  // Where the content can be named: renamed as well as moved, each is found by what it holds; one that holds something
  // else is never taken for it, whatever its name; copies of the same text go by name.
  const held: Record<string, string> = { 'n/one.md': 'one', 'n/two.md': 'two', 'n/dup1.md': 'dup', 'n/dup2.md': 'dup' };
  const disk: Record<string, string> = { 'm/first.md': 'one', 'm/second.md': 'two', 'm/one.md': 'xyz', 'm/dup1.md': 'dup', 'm/dup2.md': 'dup' };
  const read: string[] = [];
  const content = {
    of: (k: string) => held[k],
    id: async (d: Uint8Array) => new TextDecoder().decode(d),
    read: async (k: string) => (read.push(k), new TextEncoder().encode(disk[k])),
  };
  assert.deepEqual(sorted(await findMoves(Object.keys(held), was, new Map(Object.keys(disk).map(f)), content)), [
    ['n/dup1.md', 'm/dup1.md'],
    ['n/dup2.md', 'm/dup2.md'],
    ['n/one.md', 'm/first.md'],
    ['n/two.md', 'm/second.md'],
  ]);
  assert.equal(read.length, 5, 'each file found is read once');
  // A file with a unique size and time is matched as before, without reading anything.
  read.length = 0;
  assert.deepEqual(await findMoves(['n/one.md'], was, new Map([f('m/first.md')]), content), [['n/one.md', 'm/first.md']]);
  assert.equal(read.length, 0);
});

test('B2: a conflict copy joins only beside a note in the share, never in place of one taken out', async () => {
  const fs = new MemFS();
  fs.put('Pie.md', '---\nshare: Family\n---\npie');
  fs.put('Pie (conflict iPhone 20260101-120000).md', '---\nshare: Family\n---\npie, edited offline');
  fs.put('Cake.md', 'cake: taken out');
  fs.put('Cake (conflict iPhone 20260101-120000).md', '---\nshare: Family\n---\ncake, edited offline');
  const { pfs } = propertyFS(fs, { removed: ['Cake.md'] });
  assert.deepEqual(keysOf(await pfs.list(heldNow(fs, ['Pie.md']))), ['Pie (conflict iPhone 20260101-120000).md', 'Pie.md']);
  assert.deepEqual(pfs.survey()!.notShared, [{ key: 'Cake (conflict iPhone 20260101-120000).md', why: 'conflict' }]);
});

test('B4: a listing a screen asks for keeps nothing: what the engine goes by stays as its own listing found it', async () => {
  const fs = new MemFS();
  fs.put('Pie.md', '---\nshare: Family\n---\npie');
  const { pfs } = propertyFS(fs);
  const h = heldNow(fs, ['Pie.md']);
  await pfs.list(h);
  const survey = pfs.survey();
  fs.put('Pie.md', 'private now');
  fs.put('New.md', '---\nshare: Family\n---\nnew');
  await pfs.list();
  const peeked = await pfs.peek();
  assert.equal(pfs.survey(), survey);
  assert.equal(pfs.sends('Pie.md'), true, 'still as the engine last saw it');
  assert.deepEqual(peeked.unmarked, ['Pie.md'], 'the screen sees it as it is now');
});

test('B9 B12: files no note shows, and taken-out notes that say share again, are listed for the sharer', async () => {
  const fs = new MemFS();
  fs.put('pie.jpg', 'jpg');
  fs.put('Pie.md', '---\nshare: Family\n---\nno picture now');
  fs.put('Daily.md', '---\nshare: Family\n---\nagain');
  const { pfs } = propertyFS(fs, { removed: ['Daily.md'] });
  await pfs.list(heldNow(fs, ['Pie.md', 'pie.jpg']));
  assert.deepEqual(pfs.survey()!.unused, ['pie.jpg']);
  assert.deepEqual(pfs.survey()!.removedTagged, ['Daily.md']);
});

test('a note that no longer says share still shows its files in the share: they are not called unused', async () => {
  const fs = new MemFS();
  fs.put('cake.png', 'png');
  fs.put('Cake.md', '---\nshare: Family\n---\n![[cake.png]]');
  const { pfs, catalog } = propertyFS(fs);
  const h = heldNow(fs, ['Cake.md', 'cake.png']);
  fs.put('Cake.md', '---\nshare: Work\n---\n![[cake.png]] and a private line');
  catalog.refresh();
  await pfs.list(h);
  assert.deepEqual(pfs.survey()!.unmarked, ['Cake.md']);
  assert.deepEqual(pfs.survey()!.unused, []);
  assert.ok(pfs.survey()!.shared.has('cake.png'));
});

test('only a note in the share is offered to be taken out; a note never shared is offered to be shared instead', () => {
  const survey = { shared: new Map([['Pie.md', { path: 'Pie.md', size: 1, mtime: 1 }]]), unmarked: ['Cake.md'] };
  const s = { removed: ['Soup.md'] };
  assert.equal(noteInShare('Pie.md', s, survey, false), true, 'found there by the last sync');
  assert.equal(noteInShare('Daily.md', s, survey, true), true, 'its properties say share: it joins at the next sync');
  assert.equal(noteInShare('Note 02.md', s, survey, false), false, 'never shared: nothing to take out');
  assert.equal(noteInShare('Note 02.md', s, undefined, false), false, 'before any sync in this session too');
  assert.equal(noteInShare('Soup.md', s, survey, true), false, 'taken out stays out until shared again');
  assert.equal(noteInShare('Cake.md', s, survey, false), false, 'no longer says share: offered to share again');
  assert.equal(noteInShare('Cake.md', s, survey, false, true), true, 'and still there, so it can be taken out');
});

test('B12: a choice is kept while its file exists or is held, so a new note with an old name is not blocked', () => {
  const s: PropertyShare = { property: NAME, removed: ['Gone.md', 'Held.md', 'Here.md'], approved: ['a.png', 'gone.png', 'Here.md'], ask: ['b.png', 'a.png', 'c.png'] };
  const exists = (k: string) => ['Here.md', 'a.png', 'b.png'].includes(k);
  assert.deepEqual(settleChoices(s, exists, new Set(['Held.md'])), { removed: ['Held.md', 'Here.md'], approved: ['a.png'], ask: ['b.png'] });
});

test('B8 I12: what removing a note takes with it is read from the other shared notes, not the cache', () => {
  const others = [
    { key: 'Pie.md', text: 'me' },
    { key: 'Cake.md', text: 'see ![[Attachments/Crust.PNG]]' },
    { key: 'Soup.md', text: '![](pie%20bowl.jpg)' },
  ];
  assert.deepEqual(onlyShownBy('Pie.md', ['pie.jpg', 'Attachments/crust.png', 'pie bowl.jpg'], others), ['pie.jpg']);
});

test('I9 B13: changes signed by this device’s member from another device stop it; its own do not', () => {
  const a = (signer: string, device: string) => ({ seq: 1, time: 1, device, signer, paths: [] });
  assert.equal(otherSender([a('vu', 'mac')], 'vu', 'mac'), undefined);
  assert.equal(otherSender([a('lan', 'phone'), a('vu', 'ipad')], 'vu', 'mac'), 'ipad');
  assert.equal(otherSender([a('vu', 'mac-old')], 'vu', 'mac'), 'mac-old', 'a renamed device reads as another: documented');
  assert.ok(pausesOn(new OtherSenderError('ipad')));
  assert.match(describeFailure(new OtherSenderError('ipad')).title, /ipad/);
});

test('I9 I11: one per vault, only from a device that sends the vault, only invites to read', async () => {
  const s = { readOnly: false, shares: [] as { property: string }[] };
  assert.equal(startProblem(s, 'Family'), '');
  for (const bad of ['', '  ', 'a/b', 'x:y', '.hidden', '#tag', 'a'.repeat(61)]) assert.notEqual(startProblem(s, bad), '', bad);
  assert.match(startProblem({ ...s, shares: [{ property: 'Work' }] }, 'Family'), /already shares notes by a property/);
  assert.match(startProblem({ ...s, readOnly: true }, 'Family'), /only receives/);
  assert.ok(sendProblem({ readOnly: true }) instanceof NotSendingError);
  assert.equal(sendProblem({ readOnly: false }), undefined);
  assert.ok(pausesOn(new NotSendingError()));
  assert.equal(describeFailure(new NotSendingError()).id, 'not-sending');
  assert.notEqual(inviteProblem({ property: 'Family' }, 'write'), '');
  assert.equal(inviteProblem({ property: 'Family' }, 'read'), '');
  assert.equal(inviteProblem({ property: '' }, 'write'), '');
  // Never offered to the vault's other devices: nothing is written.
  const written: string[] = [];
  const docs: Docs = { readDoc: async () => null, writeDoc: async (k: string) => void written.push(k), listDocs: async () => [], deleteDoc: async () => undefined } as unknown as Docs;
  const share = shareWith({ id: 'fam', folder: '', property: 'Family', offerPending: 'add', memberKeysSecret: 'mk', role: 'owner' });
  assert.equal(await publishOffer(docs, share, () => '', 'mac', 1), undefined);
  assert.deepEqual(written, []);
});

test('problems: what waits for the sharer, named for the shared notes', () => {
  const survey = { unmarked: ['Pie.md'], waiting: [{ key: 'logo.png', note: 'Trip.md', why: 'name' as const }] };
  const ps = propertyProblems(NAME, survey as never);
  assert.deepEqual(ps.map((p) => [p.id, p.action, p.files]), [['unmarked', 'whats-shared', ['Pie.md']], ['waiting', 'whats-shared', ['logo.png']]]);
  assert.match(inShare(ps[0], { id: 'fam', folder: '', property: NAME }).title, /^Shared notes “Family”: A note no longer says share: Family/);
});

// Settings and routing: notes shared by a property stay out of every rule made for folders.

const PLUGIN_DIR = '.obsidian/plugins/coffer';

test('I8 I14: the vault keeps syncing every shared note; only the share’s own files are left out, and no pattern is made from no folder', () => {
  const s: Settings = { ...defaultSettings(false), shares: [shareWith({ id: 'fam', folder: '', property: NAME }), shareWith({ id: 'w', folder: 'Work', vaultCopies: ['Old/x.md'] })] };
  const exclude = syncConfig(s, '.obsidian', PLUGIN_DIR).exclude;
  const without = syncConfig({ ...s, shares: [s.shares[1]] }, '.obsidian', PLUGIN_DIR).exclude;
  assert.deepEqual(exclude.filter((p) => !without.includes(p)), [`${PLUGIN_DIR}/state-fam.json`, `${PLUGIN_DIR}/members-fam.json`]);
  assert.ok(!exclude.includes('/'));
  const excluded = compileExcludes(exclude);
  for (const p of ['Pie.md', 'Recipes/Pie.md', 'pie.jpg']) assert.ok(!excluded(p), p);
  const own = compileExcludes(propertyConfig(s, '.obsidian', PLUGIN_DIR).exclude);
  for (const p of ['Work/a.md', '.obsidian/app.json', '.trash/a.md', 'x/.git/a.md', `${PLUGIN_DIR}/state-fam.json`]) assert.ok(own(p), p);
  assert.ok(!own('Recipes/Pie.md'));
  assert.equal(propertyConfig({ ...s, readOnly: true }, '.obsidian', PLUGIN_DIR).readOnly, false);
});

test('I14 B11: routing, renames and folder rules pass over notes shared by a property', () => {
  const fam = shareWith({ id: 'fam', folder: '', property: NAME });
  const work = shareWith({ id: 'w', folder: 'Work' });
  const shares = [fam, work];
  assert.deepEqual(placeOf(shares, 'Recipes/Pie.md'), { path: 'Recipes/Pie.md' });
  assert.equal(placeOf(shares, 'Work/a.md').share, work);
  assert.equal(vaultPath(fam, 'Recipes/Pie.md'), 'Recipes/Pie.md');
  assert.equal(vaultPath(work, 'a.md'), 'Work/a.md');
  assert.deepEqual(followRename(shares, '', 'X'), []);
  assert.equal(fam.folder, '');
  assert.deepEqual(goneWith(shares, ''), []);
  // B11: a change to a note or attachment outside shared folders concerns the shared notes, which may stop pausing.
  assert.deepEqual(propertyPlaces(shares, 'Recipes/Pie.md'), ['fam']);
  assert.deepEqual(propertyPlaces(shares, 'pie.JPG'), ['fam']);
  assert.deepEqual(propertyPlaces(shares, 'Work/a.md'), []);
  assert.deepEqual(propertyPlaces(shares, 'tool.js'), []);
  // A loaded 0.3.0 share has none of the new fields, and is a folder share.
  const loaded = loadSettings({ shares: [{ id: 'x', folder: 'F' } as never] }, false).shares[0];
  assert.deepEqual([loaded.property, loaded.removed, loaded.approved, loaded.ask], ['', [], [], []]);
});

test('B7: a shared folder may not take files the shared notes hold', () => {
  const s: Settings = { ...defaultSettings(false), shares: [shareWith({ id: 'fam', folder: '', property: NAME })] };
  assert.match(folderProblem(s, 'Recipes', '.obsidian', PLUGIN_DIR, '', ['Recipes/Pie.md', 'recipes/b.png', 'Other.md']), /holds 2 files shared in “Family”/);
  assert.equal(folderProblem(s, 'Work', '.obsidian', PLUGIN_DIR, '', ['Recipes/Pie.md']), '');
  assert.equal(folderProblem(s, 'Work', '.obsidian', PLUGIN_DIR), '');
});

test('the CLI, or anything but the app, can not send notes shared by a property', () => {
  const s: Settings = { ...defaultSettings(false), shares: [] };
  const share = shareWith({ id: 'fam', folder: '', property: NAME, role: 'owner', memberKeysSecret: 'mk' });
  const host: EngineHost = {
    settings: s, configDir: '.obsidian', pluginDir: PLUGIN_DIR, files: Object.assign(new MemFS(), { listFolder: async () => [] }), secret: () => '',
    openStore: () => new MemoryStore(), stateStore: () => new MemState(),
  };
  assert.throws(() => makeEngine(host, share), /only from Obsidian/);
});

test('a note in a shared folder or a left-out folder can not be shared by its property, and is told so before anything is written', () => {
  const excluded = compileExcludes(['Private/']);
  assert.equal(joinProblem('Work/Plan.md', 'Family', { folder: 'Work', excluded }), '“Plan” is in the shared folder “Work”, so it can not be shared in “Family”.');
  assert.equal(joinProblem('Private/x.md', 'Family', { excluded }), 'This vault leaves “x” out of sync on this device, so it can not be shared in “Family”.');
  assert.equal(joinProblem('Recipes/Pie.md', 'Family', { excluded }), '');
});

test('after Remove: removed once nothing holds it any more; otherwise when it will be, and why this sync did not', () => {
  assert.equal(removedText('Family', ['Recipes/Pie.md'], false), 'Removed “Pie” from “Family”.');
  assert.equal(removedText('Family', ['Pie.md', 'pie.jpg'], false), 'Removed 2 files from “Family”.');
  assert.equal(removedText('Family', ['Pie.md'], true, 'Offline'), 'Took “Pie” out of “Family”. It leaves the others’ devices at the next sync that works. This sync: Offline.');
  assert.equal(removedText('Family', ['Pie.md', 'pie.jpg'], true), 'Took 2 files out of “Family”. They leave the others’ devices at the next sync that works.');
  assert.match(keptText('Family', 15), /^Kept 15 files in “Family” .*not put back in your vault/);
});

test('P5: a copy of the plugin loaded after the app started finds the vault read only when every note is read and resolved', () => {
  const notes = ['a.md', 'b.md'];
  const yes = () => true;
  assert.ok(readAlready(true, notes, yes, yes), 'turned on or updated while the app runs');
  assert.ok(!readAlready(false, notes, yes, yes), 'at the app’s start: Obsidian says when it has read the vault');
  assert.ok(!readAlready(true, notes, (p) => p !== 'b.md', yes), 'a new note not read yet');
  assert.ok(!readAlready(true, notes, yes, (p) => p !== 'b.md'), 'a note changed while the app was closed, read from the old cache and not yet again');
  assert.ok(readAlready(true, [], yes, yes), 'a vault with no notes');
});
