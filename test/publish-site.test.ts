// Building the published website from a vault: which notes and files go on it (the part that makes private notes
// public, so most of this file), how links are resolved, the pages and front page it writes, and publishing it with a
// preview of what changes. Rendering a note's body is in publish-markdown.test.ts, the uploader in publish-deploy.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteStore } from '../src/core/types.ts';
import { propertyValues, shareValues } from '../src/plugin/byproperty.ts';
import { MANIFEST } from '../src/publish/deploy.ts';
import { changesOf, preparePublish, publishPrepared, summaryLines } from '../src/publish/publish.ts';
import { PUBLISH, buildSite, publishedInWhole, saysTrue, linkIndex, publishes, relativeHref, resolveLink, resolveLinkDetail, type Site, type SiteOptions, type VaultReader } from '../src/publish/site.ts';
import { THEME } from '../src/publish/theme.ts';
import { MemoryStore } from '../src/stores/memory.ts';

const enc = new TextEncoder();
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

type Files = Record<string, string | Uint8Array> | Map<string, string | Uint8Array>;

/** A vault over a map of path to text or bytes. A path in `broken` throws when read; `delay` holds a read back. */
class MapVault implements VaultReader {
  files: Map<string, string | Uint8Array>;
  broken = new Set<string>();
  reads: string[] = [];
  delay?: (path: string) => number;
  constructor(files: Files) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
  }
  async list() {
    return [...this.files.keys()];
  }
  async read(path: string) {
    this.reads.push(path);
    const ms = this.delay?.(path);
    if (ms !== undefined) await new Promise((r) => setTimeout(r, ms));
    const f = this.files.get(path);
    if (f === undefined || this.broken.has(path)) throw new Error(`can not read ${path}`);
    return typeof f === 'string' ? enc.encode(f) : f;
  }
}

const opts = (o: Partial<SiteOptions> = {}): SiteOptions => ({ title: 'Garden', home: '', excluded: () => false, ...o });
/** A note that says publish: true, with more properties when given (each line ending in \n). */
const pub = (body: string, props = '') => `---\npublish: true\n${props}---\n${body}`;
const build = (files: Files, o: Partial<SiteOptions> = {}) => buildSite(new MapVault(files), opts(o));
const keys = (site: Site) => [...site.files.keys()];
function page(site: Site, key: string): string {
  const f = site.files.get(key);
  assert.ok(f, `${key} is on the site`);
  return dec(f.data);
}
const hrefs = (html: string) => [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
/** The part of a page between <main> and </main>. */
const mainOf = (html: string) => html.slice(html.indexOf('<main>\n') + 7, html.indexOf('\n</main>'));

/** A store that records what is written to it and deleted from it. */
function recording(store = new MemoryStore()) {
  const puts: string[] = [];
  const deletes: string[] = [];
  const s: RemoteStore = {
    get: (k, r) => store.get(k, r),
    list: (p, a) => store.list(p, a),
    put: (k, d, o) => {
      puts.push(k);
      return store.put(k, d, o);
    },
    delete: (k) => {
      deletes.push(k);
      return store.delete(k);
    },
  };
  return { store, s, puts, deletes };
}

// Which notes say publish.

test('publishes: only publish: true, alone, in any letter case; CRLF and a byte order mark read too', () => {
  assert.equal(PUBLISH, 'publish');
  const says = (props: string) => publishes(`---\n${props}\n---\nbody\n`);
  for (const yes of [
    'publish: true', 'Publish: True', 'PUBLISH: TRUE', 'publish: tRuE', 'publish: "true"', "publish: 'true'", 'publish: true # yes', 'publish:   true  ', '"publish": true', 'publish : true',
    'publish: [true]', 'publish: [ "True" ]', 'publish:\n  - true', 'publish:\n- true', 'title: x\npublish: true\ntags: [a]', 'publish: true\n# a comment after it\n',
  ]) {
    assert.ok(says(yes), yes);
  }
  for (const no of [
    'publish: false', 'publish: yes', 'publish: Yes', 'publish: 1', 'publish: on', 'publish: y', 'publish: truee', 'publish: " true"', 'publish: true!', 'publish:', 'publish: ""', 'publish: []',
    'publish: [true, true]', 'publish: [true, false]', 'publish:\n  - true\n  - false', 'publish: [[true]]', 'publish: {a: true}', 'publish: |\n  true', 'publish: >\n  true', 'publish: !!bool true', 'publish: &a true',
    // YAML reads these as more of the value, or as no value at all; only the line is read here, so they are refused.
    'publish: true\n  and more', 'publish: true\n- x',
    // Two keys, which Obsidian takes as one property.
    'publish: true\nPUBLISH: true', 'publish: true\nPublish:',
    'published: true', 'publish-it: true', 'is publish: true', 'meta:\n  publish: true', '# publish: true', 'title: publish: true', 'title: "publish: true"',
  ]) {
    assert.ok(!says(no), no);
  }
  assert.ok(publishes('---\r\npublish: true\r\n---\r\nbody\r\n'), 'CRLF');
  assert.ok(publishes('---\r\npublish:\r\n  - True\r\n---\r\n'), 'CRLF list');
  assert.ok(publishes('---\r\npublish: true\r\n# c\r\n---\r\n'), 'CRLF comment');
  assert.ok(!publishes('---\r\npublish: true\r\n  more\r\n---\r\n'), 'CRLF continued');
  assert.ok(publishes('\uFEFF---\npublish: true\n---\nbody'), 'BOM');
  assert.ok(publishes('---\npublish: true\n---'), 'no body, no last line end');
  // Only the properties block counts: not the body, a code block, a block cut short, one that is not first, or one that can not be read.
  assert.ok(!publishes('publish: true\n'));
  assert.ok(!publishes('# Note\n\npublish: true\n'));
  assert.ok(!publishes('# Note\n\n```yaml\n---\npublish: true\n---\n```\n'));
  assert.ok(!publishes('\n---\npublish: true\n---\n'));
  assert.ok(!publishes('---\npublish: true\n'));
  assert.ok(!publishes('--- \npublish: true\n---\n'));
  assert.ok(!publishes('---\npublish: true\npublish: true\n---\n'));
  assert.ok(!publishes('---\npublish: true\n: broken\n---\n'));
  assert.ok(!publishes('---\ntitle: a\n  b: c\nbroken line\npublish: true\n---\n'));
  assert.ok(!publishes(''));
});

test('propertyValues reads any property as shareValues reads share, the key in any letter case', () => {
  assert.deepEqual(propertyValues('---\nTitle: My page\nshare: [a, b]\n---\n', 'title'), ['My page']);
  assert.deepEqual(propertyValues('---\ntitle:\n  - a\n  - "b"\n---\n', 'TITLE'), ['a', 'b']);
  assert.deepEqual(propertyValues('no properties', 'title'), []);
  assert.equal(propertyValues('---\ntitle: a\ntitle: b\n---\n', 'title'), undefined);
  const text = '---\nShare: [Family, "Work"]\n---\n';
  assert.deepEqual(propertyValues(text, 'share'), shareValues(text));
});

// What stays private.

const SENTINELS = Array.from({ length: 20 }, (_, i) => `SENTINEL-${i}-X`);
const S = (i: number) => SENTINELS[i];

test('privacy: nothing of a note that does not say publish, of a comment or of a properties block reaches any file of the site', async () => {
  const vault = new MapVault({
    'Public/Post.md': pub(
      [
        '# Post',
        '',
        'Read [[Plan]] and [[Diary]], [the diary](../Diary.md) and ![[Diary]] and ![[Scan.png]].',
        '',
        `%%${S(1)} ![[Comment pic.png]] [[Diary]]%%`,
        '',
        `<!-- ${S(2)} ![[Comment pic.png]] -->`,
        '',
        'See [[Draft]], [[Old]], [[Hidden]], [[Kept out]], [[Unreadable]], [[Post (conflict laptop 20260102-150405)]], [[Accent]].',
        '',
        `[^unused]: ${S(16)} ![[Comment pic.png]]`,
        '',
      ].join('\n'),
      `secret: ${S(3)}\ntags: [${S(4)}]\n`,
    ),
    'Public/Plan.md': pub('The public plan.'),
    // Two private notes with the published one's file name, in other folders.
    'Private/Plan.md': `---\nshare: Family\n---\nThe private plan ${S(5)}`,
    'Other/Plan.md': `Another private plan ${S(6)}`,
    'Private/Index.md': pub('From here, [[Plan]] is the private plan, and so is [this](Plan.md).'),
    'Diary.md': `---\nmood: ${S(7)}\n---\nDear diary ${S(8)}`,
    'Draft.md': `---\npublish: false\n---\n${S(9)}`,
    'Old.md': `---\npublish: true\npublish: true\n---\n${S(10)}`,
    'Unreadable.md': pub(S(11)),
    'Public/Post (conflict laptop 20260102-150405).md': pub(`A stale copy ${S(12)} ![[Left out pic.png]]`),
    '.hidden/Hidden.md': pub(`${S(13)} ![[Left out pic.png]]`),
    'Kept out/Kept out.md': pub(`${S(14)} ![[Left out pic.png]]`),
    'Prive\u0301/Accent.md': pub(S(17)),
    'Scan.png': enc.encode('PNG scan'),
    'Comment pic.png': enc.encode(`picture ${S(15)}`),
    'Left out pic.png': enc.encode(`picture ${S(0)}`),
  });
  vault.broken.add('Unreadable.md');
  const seen: string[] = [];
  const site = await buildSite(vault, opts({ excluded: (k) => (seen.push(k), k.startsWith('Kept out/') || k.startsWith('Priv\u00e9/')) }));

  for (const [key, file] of site.files) {
    const text = dec(file.data);
    for (const s of SENTINELS) assert.ok(!text.includes(s), `${s} is in ${key}`);
    assert.ok(!/diary|Hidden\.|Kept out\.|Draft\.|Old\.|conflict/i.test(hrefs(text).join(' ')), `${key} links to a note that is not on the site`);
  }
  assert.deepEqual(keys(site), ['Private/Index.html', 'Public/Plan.html', 'Public/Post.html', 'Scan.png', 'index.html', 'site.css']);
  assert.ok(!vault.reads.includes('Comment pic.png'), 'a picture named only in a comment is not even read');
  assert.ok(!vault.reads.includes('Left out pic.png'), 'nor one that only notes left out show');
  assert.ok(!vault.reads.includes('.hidden/Hidden.md'), 'nor a note in a dot folder');
  assert.ok(seen.includes('Priv\u00e9/Accent.md'), 'excluded is asked with the NFC key');

  // A link next to the private Plan leads to it, and shows as text: never to the published Plan of the same name.
  const index = page(site, 'Private/Index.html');
  assert.ok(index.includes('<span class="unresolved">Plan</span>'), index);
  assert.ok(index.includes('<span class="unresolved">this</span>'), index);
  assert.ok(!index.includes('Plan.html'), index);
  // From Public, the same link leads to the published one.
  const post = page(site, 'Public/Post.html');
  assert.ok(post.includes('<a href="Plan.html" class="internal">Plan</a>'), post);
  assert.ok(post.includes('<span class="unresolved">Diary</span>') && post.includes('<span class="unresolved">the diary</span>'), post);
  assert.ok(post.includes('<img src="../Scan.png" alt="Scan.png" loading="lazy">'), post);

  // A note in a dot folder is not even listed as left out: it is never read, so a link to it reads as one to a note not published.
  assert.deepEqual(site.report.leftOut, [
    { path: 'Kept out/Kept out.md', why: 'excluded' },
    { path: 'Prive\u0301/Accent.md', why: 'excluded' },
    { path: 'Public/Post (conflict laptop 20260102-150405).md', why: 'conflict' },
  ]);
  assert.deepEqual(site.report.unpublished, [
    { from: 'Private/Index.md', link: 'Plan' },
    { from: 'Private/Index.md', link: 'Plan.md' },
    { from: 'Public/Post.md', link: '../Diary.md' },
    { from: 'Public/Post.md', link: 'Diary' },
    { from: 'Public/Post.md', link: 'Draft' },
    { from: 'Public/Post.md', link: 'Hidden' },
    { from: 'Public/Post.md', link: 'Old' },
    { from: 'Public/Post.md', link: 'Unreadable' },
  ]);
  assert.deepEqual(site.report.missing, []);
  assert.deepEqual(site.report.pages.map((p) => p.path), ['Private/Index.md', 'Public/Plan.md', 'Public/Post.md']);
});

test('privacy: a file a page shows or links stays off the site when it is left out, a conflict copy or in a dot folder', async () => {
  const site = await build(
    {
      'Post.md': pub('![[a.png]] ![[pic (conflict laptop 20260102-150405).png]] ![[.attachments/b.png]] [[Kept/c.pdf]] ![[.obsidian/d.svg]] ![[ok.png]] ![[back\\slash.png]]'),
      'a.png': 'A',
      'pic (conflict laptop 20260102-150405).png': 'C',
      'pic.png': 'P',
      '.attachments/b.png': 'B',
      'Kept/c.pdf': 'K',
      '.obsidian/d.svg': '<svg/>',
      'ok.png': 'OK',
      'back\\slash.png': 'BS',
    },
    { excluded: (k) => k === 'a.png' || k.startsWith('Kept/') },
  );
  assert.deepEqual(keys(site), ['Post.html', 'index.html', 'ok.png', 'site.css']);
  assert.deepEqual(hrefs(mainOf(page(site, 'Post.html'))), ['ok.png']);
  assert.deepEqual(site.report.leftOut, [
    { path: '.attachments/b.png', why: 'excluded' },
    { path: '.obsidian/d.svg', why: 'excluded' },
    { path: 'Kept/c.pdf', why: 'excluded' },
    { path: 'a.png', why: 'excluded' },
    { path: 'back\\slash.png', why: 'name' },
    { path: 'pic (conflict laptop 20260102-150405).png', why: 'conflict' },
  ]);
  assert.deepEqual(site.report.attachments, [{ path: 'ok.png', key: 'ok.png', size: 2 }]);
});

test('privacy: a file shown by a name more than one file has is a guess, and is never published', async () => {
  const vault = { 'Blog/post.md': pub('![[image.png]]'), 'Blog/assets/image.png': 'public picture', 'Private/image.png': `private scan ${S(0)}` };
  const site = await build(vault);
  assert.deepEqual(keys(site), ['Blog/post.html', 'index.html', 'site.css']);
  assert.deepEqual(hrefs(mainOf(page(site, 'Blog/post.html'))), []);
  assert.deepEqual(site.report.leftOut, [{ path: 'Private/image.png', why: 'ambiguous' }]);
  assert.deepEqual([site.report.missing, site.report.attachments], [[], []]);
  // Linked rather than shown, the same.
  assert.deepEqual(keys(await build({ ...vault, 'Blog/post.md': pub('[[image.png]]') })), ['Blog/post.html', 'index.html', 'site.css']);

  // Its folder makes it one file: the path from the top or from the note, written from anywhere.
  for (const [note, link] of [
    ['Blog/post.md', 'Blog/assets/image.png'],
    ['Blog/post.md', 'assets/image.png'],
    ['Blog/post.md', './assets/image.png'],
    ['Blog/post.md', '/Blog/assets/image.png'],
    ['Other/post.md', 'assets/image.png'],
    ['Other/post.md', '../Blog/assets/image.png'],
  ]) {
    const one = await build({ 'Blog/assets/image.png': 'public picture', 'Private/image.png': 'private scan', [note]: pub(`![[${link}]]`) });
    assert.deepEqual(one.report.attachments, [{ path: 'Blog/assets/image.png', key: 'Blog/assets/image.png', size: 14 }], link);
    assert.deepEqual(one.report.leftOut, [], link);
    assert.ok(!keys(one).includes('Private/image.png'), link);
  }

  // Ignoring letter case, the same: by the end of the path, and as a whole path.
  const folded = await build({ 'Blog/post.md': pub('![[image.png]] ![[pics/a.png]]'), 'Blog/assets/Image.PNG': 'public', 'Private/IMAGE.png': 'private', 'Pics/a.png': 'one', 'PICS/A.png': 'two' });
  assert.deepEqual(keys(folded), ['Blog/post.html', 'index.html', 'site.css']);
  assert.deepEqual(folded.report.leftOut, [
    { path: 'PICS/A.png', why: 'ambiguous' },
    { path: 'Private/IMAGE.png', why: 'ambiguous' },
  ]);
  // In the note's folder in other letter case, it is one file: found from there before anywhere else.
  const beside = await build({ 'Blog/post.md': pub('![[image.png]]'), 'Blog/Image.PNG': 'public', 'Private/IMAGE.png': 'private' });
  assert.deepEqual(beside.report.attachments.map((a) => a.path), ['Blog/Image.PNG']);

  // A name only one file has is published, in any letter case; and for notes a name many have changes nothing.
  const unique = await build({
    'Blog/post.md': pub('![[unique.png]] ![[OTHER.PNG]] [[Plan]]'),
    'Elsewhere/unique.png': 'u',
    'Deep/er/other.png': 'o',
    'A/Plan.md': pub('a'),
    'B/Plan.md': pub('b'),
  });
  assert.deepEqual(unique.report.attachments.map((a) => a.path), ['Deep/er/other.png', 'Elsewhere/unique.png']);
  assert.deepEqual(unique.report.leftOut, []);
  assert.ok(page(unique, 'Blog/post.html').includes('<a href="../A/Plan.html" class="internal">Plan</a>'));

  // Shown by its whole path on another page, the file is on the site, and not listed as left out; the guess still shows nothing.
  const both = await build({ ...vault, 'Notes/scan.md': pub('![[Private/image.png]]') });
  assert.deepEqual(both.report.attachments.map((a) => a.path), ['Private/image.png']);
  assert.deepEqual(both.report.leftOut, []);
  assert.deepEqual(hrefs(mainOf(page(both, 'Blog/post.html'))), []);
});

test('privacy: a link to a note that is not published shows its text, and no address holds its path', async () => {
  const site = await build({
    'Blog/Post.md': pub('One [[Folder/Secret Plan|the plan]], two [[Secret Plan#Costs]], three [x](../Folder/Secret%20Plan.md#costs), four ![[Secret Plan]].'),
    'Folder/Secret Plan.md': 'private',
  });
  const html = page(site, 'Blog/Post.html');
  assert.ok(html.includes('One <span class="unresolved">the plan</span>, two <span class="unresolved">Secret Plan &gt; Costs</span>, three <span class="unresolved">x</span>, four .'), html);
  for (const h of hrefs(html)) assert.ok(!/secret|folder/i.test(decodeURIComponent(h)), h);
  assert.deepEqual(keys(site), ['Blog/Post.html', 'index.html', 'site.css']);
});

test('privacy: a note that stops saying publish leaves the site with the files only it showed, at the location and in its manifest', async () => {
  const vault = new MapVault({
    'A.md': pub('![[only-a.png]] ![[shared.png]]'),
    'B.md': pub('![[shared.png]]'),
    'only-a.png': 'A',
    'shared.png': 'S',
  });
  const store = new MemoryStore();
  await publishPrepared(store, await preparePublish(vault, store, opts()));
  assert.deepEqual([...store.objects.keys()].sort(), ['A.html', 'B.html', MANIFEST, 'index.html', 'only-a.png', 'shared.png', 'site.css']);

  vault.files.set('A.md', '---\npublish: false\n---\n![[only-a.png]] ![[shared.png]]');
  const p = await preparePublish(vault, store, opts());
  assert.deepEqual(keys(p.site), ['B.html', 'index.html', 'shared.png', 'site.css']);
  assert.deepEqual(p.planned.plan.removed, ['A.html', 'only-a.png']);
  const c = changesOf(p);
  assert.deepEqual([c.removedPages, c.removedFiles, c.changedPages], [['A'], ['only-a.png'], ['Front page']]);
  await publishPrepared(store, p);
  assert.deepEqual([...store.objects.keys()].sort(), ['B.html', MANIFEST, 'index.html', 'shared.png', 'site.css']);
  const manifest = JSON.parse(dec(store.objects.get(MANIFEST)!.data)) as { files: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.files), ['B.html', 'index.html', 'shared.png', 'site.css']);

  // The last one too: what is left is a front page that says nothing is here.
  vault.files.set('B.md', 'gone');
  await publishPrepared(store, await preparePublish(vault, store, opts()));
  assert.deepEqual([...store.objects.keys()].sort(), [MANIFEST, 'index.html', 'site.css']);
  assert.ok(dec(store.objects.get('index.html')!.data).includes('Nothing has been published here yet.'));
});

test('privacy: a note or file that can not be read is not published, and the rest of the site is', async () => {
  const vault = new MapVault({
    'A.md': pub('![[gone.png]] ![[fine.png]] [[B]]'),
    'B.md': pub('B'),
    'gone.png': 'G',
    'fine.png': 'F',
  });
  vault.broken.add('B.md');
  vault.broken.add('gone.png');
  const site = await buildSite(vault, opts());
  assert.deepEqual(keys(site), ['A.html', 'fine.png', 'index.html', 'site.css']);
  const html = page(site, 'A.html');
  assert.deepEqual(hrefs(mainOf(html)), ['fine.png']);
  assert.ok(html.includes('<span class="unresolved">B</span>'), html);
  assert.deepEqual(site.report.missing, [{ from: 'A.md', link: 'gone.png' }]);
  assert.deepEqual(site.report.unpublished, [{ from: 'A.md', link: 'B' }]);
});

test('files join a page only as shown or linked: pictures, sound, video and PDF, each read once with its content type', async () => {
  const vault = new MapVault({
    'Notes/A.md': pub('![[p.png]] ![[s.mp3]] ![[v.mp4]] ![[d.pdf]] ![[i.svg|200]] [[d.pdf]] ![[p.png]] [[x.canvas]] [[data.json]] ![[run.js]] [[base.base]]'),
    'Notes/B.md': pub('![[p.png]] [the doc](d.pdf#page=2) ![[j.JPG]]'),
    'Notes/p.png': 'P',
    'Notes/s.mp3': 'S',
    'Notes/v.mp4': 'V',
    'Notes/d.pdf': 'D',
    'Notes/i.svg': '<svg/>',
    'Notes/j.JPG': 'J',
    'Notes/x.canvas': '{}',
    'Notes/data.json': '{}',
    'Notes/run.js': 'alert(1)',
    'Notes/base.base': '',
  });
  const site = await buildSite(vault, opts());
  assert.deepEqual(
    [...site.files].filter(([k]) => !k.endsWith('.html') && k !== 'site.css').map(([k, f]) => [k, f.type]),
    [
      ['Notes/d.pdf', 'application/pdf'],
      ['Notes/i.svg', 'image/svg+xml'],
      ['Notes/j.JPG', 'image/jpeg'],
      ['Notes/p.png', 'image/png'],
      ['Notes/s.mp3', 'audio/mpeg'],
      ['Notes/v.mp4', 'video/mp4'],
    ],
  );
  assert.equal(vault.reads.filter((p) => p === 'Notes/p.png').length, 1);
  assert.ok(!vault.reads.some((p) => /canvas|json|\.js|base/.test(p)));
  const a = mainOf(page(site, 'Notes/A.html'));
  assert.ok(a.includes('<img src="p.png" alt="p.png" loading="lazy"> <audio controls src="s.mp3"></audio> <video controls src="v.mp4"></video> <a href="d.pdf" class="internal">d.pdf</a> <img src="i.svg" alt="i.svg" width="200" loading="lazy"> <a href="d.pdf" class="internal">d.pdf</a>'), a);
  assert.ok(a.includes('<span class="unresolved">x.canvas</span> <span class="unresolved">data.json</span>  <span class="unresolved">base.base</span>'), a);
  assert.deepEqual(site.report.unpublished, []);
  assert.deepEqual(site.report.missing, []);
  assert.deepEqual(site.report.leftOut, []);
  assert.ok(page(site, 'Notes/B.html').includes('<a href="d.pdf#page=2" class="internal">the doc</a>'));
  assert.equal(page(site, 'site.css'), THEME);
  assert.equal(site.files.get('site.css')!.type, 'text/css; charset=utf-8');
  assert.equal(site.files.get('index.html')!.type, 'text/html; charset=utf-8');
});

// Where things are on the site.

test('relativeHref: up from the page, then each segment percent-encoded', () => {
  assert.equal(relativeHref('A/B/Note.html', 'C/Pic 1.png'), '../../C/Pic%201.png');
  assert.equal(relativeHref('Note.html', 'Other.html'), 'Other.html');
  assert.equal(relativeHref('A/x.html', 'A/y.html'), 'y.html');
  assert.equal(relativeHref('A/x.html', 'A/x.html'), 'x.html');
  assert.equal(relativeHref('index.html', 'A/B/x.html'), 'A/B/x.html');
  assert.equal(relativeHref('A/B/x.html', 'A/C/y.html'), '../C/y.html');
  assert.equal(relativeHref('A/B/x.html', 'A/B/C/y.html'), 'C/y.html');
  assert.equal(relativeHref('A/x.html', 'A.html'), '../A.html');
  assert.equal(relativeHref('A/B/x.html', 'index.html'), '../../index.html');
  assert.equal(relativeHref('index.html', 'Q&A/Why? #1 100% : yes.html'), 'Q%26A/Why%3F%20%231%20100%25%20%3A%20yes.html');
  assert.equal(relativeHref('index.html', 'Caf\u00e9/日本 ü.png'), 'Caf%C3%A9/%E6%97%A5%E6%9C%AC%20%C3%BC.png');
  assert.equal(relativeHref('a:b/x.html', 'c:d.html'), '../c%3Ad.html');
});

test('site keys: a note becomes its path with .html, a file keeps its path, and every address is relative', async () => {
  const site = await build({
    'Folder/Sub/Note.md': pub('[[Top]] [[Folder/Side]] ![[Pics/Pic 1.png]] [[Note]] [[#Here]] [[Top#A b]]'),
    'Folder/Side.MD': pub('[[Note]]'),
    'Top.md': pub('[[Folder/Sub/Note|down]]'),
    'Pics/Pic 1.png': 'P',
    'Q&A/Why? #1 100%.md': pub('[[Top]]'),
  });
  assert.deepEqual(keys(site), ['Folder/Side.html', 'Folder/Sub/Note.html', 'Pics/Pic 1.png', 'Q&A/Why? #1 100%.html', 'Top.html', 'index.html', 'site.css']);
  const note = page(site, 'Folder/Sub/Note.html');
  assert.deepEqual(hrefs(note), ['../../site.css', '../../index.html', '../../Top.html', '../Side.html', '../../Pics/Pic%201.png', 'Note.html', '#Here', '../../Top.html#A-b']);
  assert.deepEqual(hrefs(mainOf(page(site, 'Top.html'))), ['Folder/Sub/Note.html']);
  // Side links [[Note]]: no Note.md at the top or beside it, so the one anywhere in the vault.
  assert.deepEqual(hrefs(mainOf(page(site, 'Folder/Side.html'))), ['Sub/Note.html']);
  assert.deepEqual(hrefs(page(site, 'Q&A/Why? #1 100%.html')), ['../site.css', '../index.html', '../Top.html']);
  assert.ok(page(site, 'index.html').includes('<a href="Q%26A/Why%3F%20%231%20100%25.html">Why? #1 100%</a>'));
});

test('front page: the note the setting names, with or without .md; links to it lead to index.html and a root index.md is left out', async () => {
  for (const home of ['Folder/Welcome', 'Folder/Welcome.md', ' Folder/Welcome ']) {
    const site = await build(
      {
        'Folder/Welcome.md': pub('Hello. See [[Other]] and [[Welcome#Top]].', 'title: Welcome home\n'),
        'Other.md': pub('Back to [[Welcome]].'),
        'index.md': pub('The other front page'),
      },
      { home },
    );
    assert.deepEqual(keys(site), ['Other.html', 'index.html', 'site.css'], home);
    const index = page(site, 'index.html');
    assert.ok(index.includes('<title>Garden</title>'), index);
    assert.ok(mainOf(index).startsWith('<article>\n<h1 class="title">Welcome home</h1>\n<p>Hello. See <a href="Other.html" class="internal">Other</a> and <a href="index.html#Top" class="internal">Welcome &gt; Top</a>.</p>\n</article>\n<nav class="pages">'), index);
    assert.ok(!index.includes('The other front page'));
    assert.ok(page(site, 'Other.html').includes('<a href="index.html" class="internal">Welcome</a>'));
    assert.deepEqual(site.report.leftOut, [{ path: 'index.md', why: 'clash' }]);
    assert.deepEqual(site.report.pages, [
      { path: 'Folder/Welcome.md', key: 'index.html', title: 'Welcome home' },
      { path: 'Other.md', key: 'Other.html', title: 'Other' },
    ]);
  }
  // A name typed in NFD finds the note listed in NFC.
  const nfd = await build({ 'Caf\u00e9.md': pub('Bonjour') }, { home: 'Cafe\u0301' });
  assert.ok(page(nfd, 'index.html').includes('Bonjour'));
  assert.deepEqual(keys(nfd), ['index.html', 'site.css']);
});

test('front page: a root index.md in any letter case when no setting names one; never a note that does not say publish', async () => {
  // Only at the top: Sub/index.md is a page like any other.
  const one = await build({ 'INDEX.md': pub('# Hi\n\n[[Sub/index]]'), 'Sub/index.md': pub('Sub index') });
  assert.deepEqual(keys(one), ['Sub/index.html', 'index.html', 'site.css']);
  assert.ok(page(one, 'index.html').includes('<title>Garden</title>'));
  assert.ok(mainOf(page(one, 'index.html')).startsWith('<article>\n<h1 id="Hi">Hi</h1>'));
  assert.deepEqual(one.report.leftOut, []);
  assert.deepEqual(hrefs(mainOf(page(one, 'index.html'))), ['Sub/index.html', 'Sub/index.html']);

  // Two at the top in other case: the first in sorted order is the front page, the other clashes with it.
  const two = await build({ 'index.md': pub('lower'), 'Index.md': pub('upper') });
  assert.ok(page(two, 'index.html').includes('upper'));
  assert.deepEqual(two.report.leftOut, [{ path: 'index.md', why: 'clash' }]);

  // The setting names a note that does not say publish: it stays private, and the root index.md is the front page.
  const priv = await build({ 'Secret.md': `---\ntitle: ${S(18)}\n---\n${S(19)}`, 'index.md': pub('public front') }, { home: 'Secret' });
  assert.ok(page(priv, 'index.html').includes('public front'));
  for (const [, f] of priv.files) assert.ok(!dec(f.data).includes('SENTINEL'));
  // Neither: the site title is the heading and the pages are listed.
  const none = await build({ 'A.md': pub('a'), 'Folder/index.md': pub('not the top') }, { home: 'Missing' });
  assert.equal(mainOf(page(none, 'index.html')), '<h1 class="title">Garden</h1>\n<nav class="pages">\n<ul>\n<li><span class="folder">Folder</span>\n<ul>\n<li><a href="Folder/index.html">index</a></li>\n</ul>\n</li>\n<li><a href="A.html">A</a></li>\n</ul>\n</nav>');
});

test('clashes: names equal ignoring letter case and the reserved names; the later one in sorted order is left out', async () => {
  const site = await build(
    {
      'Notes/Plan.md': pub('[[notes/plan]] ![[pics/A.png]] ![[Pics/a.png]]'),
      'notes/plan.md': pub('lower'),
      'Home.md': pub('home'),
      'INDEX.md': pub('a second index'),
      'Pics/a.png': 'first',
      'pics/A.png': 'second',
      'Caf\u00e9.md': pub('nfc'),
      'Cafe\u0301.md': pub('nfd'),
    },
    { home: 'Home' },
  );
  assert.deepEqual(keys(site), ['Caf\u00e9.html', 'Notes/Plan.html', 'Pics/a.png', 'index.html', 'site.css']);
  assert.deepEqual(site.report.leftOut, [
    { path: 'Caf\u00e9.md', why: 'clash' },
    { path: 'INDEX.md', why: 'clash' },
    { path: 'notes/plan.md', why: 'clash' },
    { path: 'pics/A.png', why: 'clash' },
  ]);
  assert.ok(page(site, 'Caf\u00e9.html').includes('nfd'));
  // The link to the note left out shows as text; of the two pictures only the one on the site is shown, whatever the order they were embedded in.
  assert.deepEqual(hrefs(mainOf(page(site, 'Notes/Plan.html'))), ['../Pics/a.png']);
  assert.ok(page(site, 'Notes/Plan.html').includes('<span class="unresolved">notes/plan</span>'));
  assert.deepEqual(site.report.unpublished, []);

  // One note listed in NFD and in NFC is one front page: the other copy gets no page of its own.
  const twice = await build({ 'Café.md': pub('nfc'), 'Café.md': pub('nfd'), 'Other.md': pub('[[Café]]') }, { home: 'Café' });
  assert.deepEqual(keys(twice), ['Other.html', 'index.html', 'site.css']);
  assert.ok(page(twice, 'index.html').includes('nfd') && !page(twice, 'index.html').includes('nfc'));
  assert.ok(page(twice, 'Other.html').includes('<a href="index.html" class="internal">'));
  assert.deepEqual(twice.report.leftOut, [{ path: 'Café.md', why: 'clash' }]);
});

// Resolving links.

test('resolveLink: exact path, then from the note\'s folder, then anywhere by the end of the path, then all of it ignoring case', () => {
  const idx = linkIndex(['Note.md', 'A/Note.md', 'A/B/Note.md', 'A/B/Deep.md', 'C/Deep.md', 'B2/Deep.md', 'X/Y/Deep.md', 'Pics/p.png', 'Note.v2.md', 'b/x.md', 'B/X.md', 'Notes/plan.md', 'PLAN.md', 'Only']);
  const r = (link: string, from = 'R.md') => resolveLink(link, from, idx);
  // 2. the exact path, as written or with .md.
  assert.equal(r('A/Note'), 'A/Note.md');
  assert.equal(r('A/Note.md'), 'A/Note.md');
  assert.equal(r('Only'), 'Only');
  // 2 before 3: a note at that path from the top wins over one beside the link.
  assert.equal(r('Note', 'A/B/x.md'), 'Note.md');
  // 3. from the note's folder, with ./ and ../.
  assert.equal(r('Deep', 'A/B/x.md'), 'A/B/Deep.md');
  assert.equal(r('B/Deep', 'A/x.md'), 'A/B/Deep.md');
  assert.equal(r('./Deep', 'C/x.md'), 'C/Deep.md');
  assert.equal(r('../Note', 'A/B/x.md'), 'A/Note.md');
  assert.equal(r('../../Note.md', 'A/B/x.md'), 'Note.md');
  assert.equal(r('./../B/./Deep', 'A/B/x.md'), 'A/B/Deep.md');
  // Above the top is nothing, and a link with ./ or ../ is never looked for anywhere else.
  assert.equal(r('../../../Note', 'A/B/x.md'), null);
  assert.equal(r('../Deep', 'Z/x.md'), null);
  assert.equal(r('./Deep', 'Z/x.md'), null);
  // 4. anywhere: the fewest folders, then plain string order.
  assert.equal(r('Deep'), 'B2/Deep.md');
  assert.equal(r('Y/Deep'), 'X/Y/Deep.md');
  assert.equal(r('p.png'), 'Pics/p.png');
  assert.equal(r('p'), null, 'only notes go without their extension');
  assert.equal(r('eep'), null, 'the end of the path is whole names');
  // A name with dots in it.
  assert.equal(r('Note.v2'), 'Note.v2.md');
  // 4 exactly before 5: plan finds Notes/plan.md before PLAN.md, which matches only ignoring case.
  assert.equal(r('plan'), 'Notes/plan.md');
  // 5. ignoring case, with the same order, and the smallest in plain string order among names equal but for case.
  assert.equal(r('note'), 'Note.md');
  assert.equal(r('A/NOTE.MD'), 'A/Note.md');
  assert.equal(r('deep', 'a/b/x.md'), 'A/B/Deep.md');
  assert.equal(r('DEEP'), 'B2/Deep.md');
  assert.equal(r('B/x'), 'B/X.md');
  assert.equal(r('P.PNG'), 'Pics/p.png');
  // A leading slash: from the top only.
  assert.equal(r('/Note', 'A/B/x.md'), 'Note.md');
  assert.equal(r('/Deep', 'C/x.md'), null);
  assert.equal(r('/note'), 'Note.md');
  assert.equal(r('/'), null);
  assert.equal(r(''), null);
  assert.equal(r('Nope'), null);

  // Whether a tie was broken: only by the end of the path, or ignoring case, and only when another file matched as well.
  const d = (link: string, from = 'R.md') => resolveLinkDetail(link, from, idx);
  assert.deepEqual(d('Deep'), { key: 'B2/Deep.md', ambiguous: true });
  assert.deepEqual(d('DEEP'), { key: 'B2/Deep.md', ambiguous: true });
  assert.deepEqual(d('B/x'), { key: 'B/X.md', ambiguous: true }, 'a whole path in two letter cases');
  for (const [link, from, key] of [
    ['Y/Deep', 'R.md', 'X/Y/Deep.md'],
    ['p.png', 'R.md', 'Pics/p.png'],
    ['P.PNG', 'R.md', 'Pics/p.png'],
    ['Deep', 'A/B/x.md', 'A/B/Deep.md'],
    ['../Note', 'A/B/x.md', 'A/Note.md'],
    ['A/Note', 'R.md', 'A/Note.md'],
    ['/Note', 'A/x.md', 'Note.md'],
    ['note', 'R.md', 'Note.md'],
  ]) {
    assert.deepEqual(d(link, from), { key, ambiguous: false }, link);
  }
  // The same name in other letter case elsewhere makes the pick a guess: Obsidian's own may differ.
  assert.deepEqual(d('plan', 'R.md'), { key: 'Notes/plan.md', ambiguous: true });
  assert.equal(d('Nope'), null);
});

test('resolveLink: names compare in NFC, whichever form the link or the listing has', () => {
  const nfcListed = linkIndex(['Caf\u00e9/R\u00e9sum\u00e9.md']);
  const nfdListed = linkIndex(['Cafe\u0301/Re\u0301sume\u0301.md']);
  for (const idx of [nfcListed, nfdListed]) {
    for (const link of ['R\u00e9sum\u00e9', 'Re\u0301sume\u0301', 'Cafe\u0301/R\u00e9sum\u00e9.md', 'r\u00c9sum\u00e9']) {
      assert.equal(resolveLink(link, 'x.md', idx), 'Caf\u00e9/R\u00e9sum\u00e9.md', link);
    }
    assert.equal(resolveLink('./R\u00e9sum\u00e9', 'Cafe\u0301/x.md', idx), 'Caf\u00e9/R\u00e9sum\u00e9.md');
  }
});

// Titles and pages.

test('titles: the title property, else the first heading when the note starts with one, else the file name', async () => {
  const site = await build({
    'Prop.md': pub('Body', 'title: "  My   Title "\n'),
    'PropAndH1.md': pub('# Heading\n\nBody', 'title: From the property\n'),
    'TwoTitles.md': pub('Body', 'title: [a, b]\n'),
    'EmptyTitle.md': pub('# Heading two', 'title: ""\n'),
    'H1.md': pub('# First *Heading* [[Prop|link]]\n\nBody'),
    'H1Later.md': pub('Intro\n\n# Not first'),
    'H2.md': pub('## Second level'),
    'Plain.md': pub('Just text, and ![[H1]] ![[Plain]] ![[Prop]]'),
  });
  const titles = Object.fromEntries(site.report.pages.map((p) => [p.path, p.title]));
  assert.deepEqual(titles, {
    'EmptyTitle.md': 'Heading two',
    'H1.md': 'First Heading link',
    'H1Later.md': 'H1Later',
    'H2.md': 'H2',
    'Plain.md': 'Plain',
    'Prop.md': 'My Title',
    'PropAndH1.md': 'From the property',
    'TwoTitles.md': 'TwoTitles',
  });
  const article = (key: string) => mainOf(page(site, key));
  assert.ok(article('Prop.html').startsWith('<article>\n<h1 class="title">My Title</h1>\n<p>Body</p>'));
  assert.ok(article('PropAndH1.html').startsWith('<article>\n<h1 id="Heading">Heading</h1>'));
  assert.ok(article('H1.html').startsWith('<article>\n<h1 id="First-Heading-link">'));
  assert.ok(article('H1Later.html').startsWith('<article>\n<h1 class="title">H1Later</h1>\n<p>Intro</p>'));
  assert.ok(article('H2.html').startsWith('<article>\n<h1 class="title">H2</h1>\n<h2'));
  assert.ok(page(site, 'H1.html').includes('<title>First Heading link – Garden</title>'));
  // An embedded note is shown as a link with its title, the same title its own page has; a note may embed itself.
  assert.ok(article('Plain.html').includes('<a href="H1.html" class="internal embed">First Heading link</a> <a href="Plain.html" class="internal embed">Plain</a> <a href="Prop.html" class="internal embed">My Title</a>'), article('Plain.html'));
});

test('front page list: folders first, then pages, each by name ignoring letter case; none when no other page; an empty site says so', async () => {
  const site = await build({
    'Zeta.md': pub('z'),
    'alpha.md': pub('a'),
    'Folder/Inner.md': pub('# beta'),
    'Folder/Sub/Deep.md': pub('d'),
    'b folder/x.md': pub('x', 'title: <X>\n'),
    'Private/Note.md': 'not published',
  });
  assert.equal(
    mainOf(page(site, 'index.html')),
    [
      '<h1 class="title">Garden</h1>',
      '<nav class="pages">',
      '<ul>',
      '<li><span class="folder">b folder</span>',
      '<ul>',
      '<li><a href="b%20folder/x.html">&lt;X&gt;</a></li>',
      '</ul>',
      '</li>',
      '<li><span class="folder">Folder</span>',
      '<ul>',
      '<li><span class="folder">Sub</span>',
      '<ul>',
      '<li><a href="Folder/Sub/Deep.html">Deep</a></li>',
      '</ul>',
      '</li>',
      '<li><a href="Folder/Inner.html">beta</a></li>',
      '</ul>',
      '</li>',
      '<li><a href="alpha.html">alpha</a></li>',
      '<li><a href="Zeta.html">Zeta</a></li>',
      '</ul>',
      '</nav>',
    ].join('\n'),
  );
  const alone = await build({ 'index.md': pub('Only me') });
  assert.equal(mainOf(page(alone, 'index.html')), '<article>\n<h1 class="title">index</h1>\n<p>Only me</p>\n</article>');
  const empty = await build({ 'Note.md': 'private', 'pic.png': 'P' }, { title: '' });
  assert.deepEqual(keys(empty), ['index.html', 'site.css']);
  assert.equal(mainOf(page(empty, 'index.html')), '<h1 class="title">Notes</h1>\n<p class="empty">Nothing has been published here yet.</p>');
  assert.ok(page(empty, 'index.html').includes('<title>Notes</title>'));
  assert.deepEqual(empty.report, { pages: [], attachments: [], unpublished: [], missing: [], whole: false, homeNotFound: '', leftOut: [] });
});

test('determinism: the same vault gives the same bytes, whatever order it is listed in and reads finish in', async () => {
  const entries: [string, string][] = [
    ['index.md', pub('Welcome [[B]] ![[img/one.png]]')],
    ['B.md', pub('# Bee\n\n![[img/two.png]] [[C]] [[Nope]] [[Secret]]')],
    ['Sub/C.md', pub('![[one.png]] ![[A]]')],
    ['Sub/D.md', pub('![[img/two.png]]', 'title: Dee\n')],
    ['A.md', pub('[[index]] ![[B]]')],
    ['Secret.md', 'private'],
    ['img/one.png', 'one'],
    ['img/two.png', 'two'],
    ['x (conflict pc 20260102-150405).md', pub('copy')],
  ];
  const first = new MapVault(new Map(entries));
  const second = new MapVault(new Map([...entries].reverse()));
  second.delay = (path) => (path.length * 7) % 13;
  const a = await buildSite(first, opts());
  const b = await buildSite(second, opts());
  assert.deepEqual(keys(a), keys(b));
  for (const [key, f] of a.files) assert.deepEqual(b.files.get(key), f, key);
  assert.deepEqual(a.report, b.report);
  assert.deepEqual(keys(a), ['A.html', 'B.html', 'Sub/C.html', 'Sub/D.html', 'img/one.png', 'img/two.png', 'index.html', 'site.css']);
});

test('pages are whole documents, with every title and name escaped', async () => {
  const site = await build(
    {
      'Evil.md': pub('<script>alert(2)</script> [[a<b>]]', 'title: <script>alert(1)</script>\n'),
      'a<b>.md': pub('text'),
      'Folder "q"/Note \'s.md': pub('# <img src=x onerror=alert(3)>'),
    },
    { title: 'Tom\'s "Notes" <b>' },
  );
  for (const [key, f] of site.files) {
    if (!key.endsWith('.html')) continue;
    const html = dec(f.data);
    assert.ok(html.startsWith('<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="referrer" content="no-referrer">\n'), key);
    assert.ok(html.endsWith('</main>\n</body>\n</html>\n'), key);
    assert.equal(html.split('<title>').length, 2, key);
    assert.ok(!/<script|<img|<b>/i.test(html), key);
    assert.ok(html.includes('<header class="site"><a href="'), key);
    assert.ok(html.includes('>Tom&#39;s &quot;Notes&quot; &lt;b&gt;</a></header>'), key);
    assert.ok(!/\$\{|undefined|null/.test(html), key);
  }
  assert.ok(page(site, 'Evil.html').includes('<title>&lt;script&gt;alert(1)&lt;/script&gt; – Tom&#39;s &quot;Notes&quot; &lt;b&gt;</title>'));
  assert.ok(page(site, 'Evil.html').includes('<a href="a%3Cb%3E.html" class="internal">a&lt;b&gt;</a>'));
  assert.ok(page(site, 'index.html').includes('<a href="Folder%20%22q%22/Note%20&#39;s.html">&lt;img src=x onerror=alert(3)&gt;</a>'));
  assert.ok(page(site, 'index.html').includes('<title>Tom&#39;s &quot;Notes&quot; &lt;b&gt;</title>'));
});

// Previewing and publishing.

test('changes and summary: the first publish, an update, and nothing to do', async () => {
  const vault = new MapVault({
    'Home.md': pub('Welcome', 'title: Welcome\n'),
    'Blog/One.md': pub('# First post\n\n![[pics/a.png]]'),
    'Blog/Two.md': pub('# Second post\n\n![[pics/b.png]]'),
    'pics/a.png': 'A',
    'pics/b.png': 'B',
    'pics/c.png': 'C',
  });
  const { s, puts, deletes } = recording();
  const o = opts({ home: 'Home' });

  let p = await preparePublish(vault, s, o);
  assert.equal(p.planned.plan.first, true);
  assert.deepEqual(changesOf(p), {
    newPages: ['First post', 'Front page', 'Second post'],
    newPageKeys: [
      { title: 'First post', key: 'Blog/One.html' },
      { title: 'Second post', key: 'Blog/Two.html' },
    ],
    changedPages: [],
    removedPages: [],
    newFiles: ['Page style', 'pics/a.png', 'pics/b.png'],
    changedFiles: [],
    removedFiles: [],
    nothing: false,
  });
  const firstLines = summaryLines(p);
  assert.equal(firstLines[0], 'The website has 3 pages and 3 other files, published here for the first time.');
  assert.match(firstLines[1], /^3 new pages, 3 new files\. \d+(\.\d)? KB to upload\.$/);
  assert.deepEqual(firstLines.slice(2), [
    'New page: First post (at Blog/One.html)',
    'New page: Front page',
    'New page: Second post (at Blog/Two.html)',
    'New file: Page style',
    'New file: pics/a.png',
    'New file: pics/b.png',
  ]);
  await publishPrepared(s, p);

  // A new page with a new file, a changed page with a changed file, a page and a file removed.
  vault.files.set('Blog/Three.md', pub('# Third post\n\n![[pics/c.png]] [[Private]] [[Nowhere]]'));
  vault.files.set('Blog/One.md', pub('# First post, edited\n\n![[pics/a.png]]'));
  vault.files.set('pics/a.png', 'A2');
  vault.files.set('Blog/Two.md', 'unpublished now');
  vault.files.set('Private.md', 'private');
  vault.files.set('Drafts/Later.md', pub('later'));
  p = await preparePublish(vault, s, { ...o, excluded: (k) => k.startsWith('Drafts/') });
  assert.deepEqual(changesOf(p), {
    newPages: ['Third post'],
    newPageKeys: [{ title: 'Third post', key: 'Blog/Three.html' }],
    changedPages: ['First post, edited', 'Front page'],
    removedPages: ['Blog/Two'],
    newFiles: ['pics/c.png'],
    changedFiles: ['pics/a.png'],
    removedFiles: ['pics/b.png'],
    nothing: false,
  });
  const lines = summaryLines(p);
  assert.equal(lines[0], 'The website has 3 pages and 3 other files.');
  assert.match(lines[1], /^1 new page, 2 changed pages, 1 removed page, 1 new file, 1 changed file, 1 removed file\. \S+ (?:bytes|KB) to upload\.$/);
  assert.deepEqual(lines.slice(2), [
    'New page: Third post (at Blog/Three.html)',
    'Changed page: First post, edited',
    'Changed page: Front page',
    'Removed page: Blog/Two',
    'New file: pics/c.png',
    'Changed file: pics/a.png',
    'Removed file: pics/b.png',
    'Left out: Drafts/Later.md, because it is left out of sync or of the website in settings, or is in a hidden folder.',
    'Not linked: “Private” in Blog/Three.md leads to a note that is not published, so its text is shown without a link.',
    'Not found: “Nowhere” in Blog/Three.md leads to no file in the vault.',
  ]);
  await publishPrepared(s, p);

  // Nothing changed: nothing is written, not even the manifest.
  p = await preparePublish(vault, s, { ...o, excluded: (k) => k.startsWith('Drafts/') });
  const c = changesOf(p);
  assert.equal(c.nothing, true);
  assert.deepEqual([c.newPages, c.newPageKeys, c.changedPages, c.removedPages, c.newFiles, c.changedFiles, c.removedFiles], [[], [], [], [], [], [], []]);
  assert.equal(summaryLines(p)[1], 'Nothing to upload or delete: the website at this location is up to date.');
  const before = [puts.length, deletes.length];
  await publishPrepared(s, p);
  assert.deepEqual([puts.length, deletes.length], before);
});

test('summary: what was left out says why, for every reason; a note in a dot folder is not mentioned', async () => {
  const store = new MemoryStore();
  const vault = new MapVault({
    'A.md': pub('![[x (conflict pc 20260102-150405).png]] ![[bad\\name.png]] ![[.attachments/y.png]] ![[pic.png]] [[Old]]'),
    'a.md': pub('clash'),
    '.trash/Old.md': pub('old'),
    '.attachments/y.png': 'Y',
    'One/pic.png': '1',
    'Two/pic.png': '2',
    'x (conflict pc 20260102-150405).png': 'X',
    'bad\\name.png': 'B',
  });
  const p = await preparePublish(vault, store, opts());
  const lines = summaryLines(p);
  assert.deepEqual(lines.filter((l) => l.startsWith('Left out')), [
    'Left out: .attachments/y.png, because it is left out of sync or of the website in settings, or is in a hidden folder.',
    'Left out: One/pic.png, because more than one file in the vault has this name; link it with its folder, as in [[Folder/name.png]].',
    'Left out: a.md, because another file of the website has this name, in the same or other letter case.',
    'Left out: bad\\name.png, because its name can not be used on a website.',
    'Left out: x (conflict pc 20260102-150405).png, because it is a conflict copy of another file.',
  ]);
  assert.ok(!lines.some((l) => l.includes('.trash')), lines.join('\n'));
  assert.ok(!vault.reads.includes('.trash/Old.md'));
});

test('summary: a new page is named with its address when that says more than its title', async () => {
  const p = await preparePublish(new MapVault({ 'About.md': pub('about'), 'x.md': pub('', 'title: Why\n'), 'Blog/One.md': pub('# One'), 'index.md': pub('front') }), new MemoryStore(), opts());
  assert.deepEqual(changesOf(p).newPageKeys, [
    { title: 'About', key: 'About.html' },
    { title: 'One', key: 'Blog/One.html' },
    { title: 'Why', key: 'x.html' },
  ]);
  assert.deepEqual(summaryLines(p).filter((l) => l.startsWith('New page')), ['New page: About', 'New page: Front page', 'New page: One (at Blog/One.html)', 'New page: Why (at x.html)']);
});

test('end to end: an edit uploads only that page, and the front page only when its list changes', async () => {
  const vault = new MapVault({ 'A.md': pub('# Alpha\n\nfirst'), 'B.md': pub('# Bravo\n\n![[p.png]]'), 'p.png': 'P' });
  const { store, s, puts, deletes } = recording();
  await publishPrepared(s, await preparePublish(vault, s, opts()));
  assert.deepEqual([...puts].sort(), ['A.html', 'B.html', MANIFEST, MANIFEST, 'index.html', 'p.png', 'site.css']);
  for (const [key, f] of (await buildSite(vault, opts())).files) {
    assert.deepEqual(store.objects.get(key)?.data, f.data, key);
    assert.equal(store.objects.get(key)?.type, f.type, key);
  }

  puts.length = 0;
  vault.files.set('A.md', pub('# Alpha\n\nsecond'));
  await publishPrepared(s, await preparePublish(vault, s, opts()));
  assert.deepEqual(puts, [MANIFEST, 'A.html', MANIFEST]);
  assert.ok(dec(store.objects.get('A.html')!.data).includes('second'));

  puts.length = 0;
  vault.files.set('A.md', pub('# Alpha, renamed\n\nsecond'));
  await publishPrepared(s, await preparePublish(vault, s, opts()));
  assert.deepEqual(puts, [MANIFEST, 'A.html', 'index.html', MANIFEST]);
  assert.deepEqual(deletes, []);
});

test('scale: 3,000 notes, 300 published with 10 links each, build in a few seconds', async () => {
  const files = new Map<string, string>();
  for (let i = 0; i < 3000; i++) {
    const links = Array.from({ length: 10 }, (_, k) => `[[Note ${(i * 7 + k * 301) % 3000}]]`).join(' ');
    const body = `# Note ${i}\n\nText ${links} ![[pic ${Math.floor(i / 10) % 50}.png]]\n`;
    files.set(`F${i % 30}/Sub ${i % 7}/Note ${i}.md`, i % 10 === 0 ? pub(body) : body);
  }
  for (let i = 0; i < 50; i++) files.set(`Pics/pic ${i}.png`, `p${i}`);
  const started = performance.now();
  const site = await buildSite(new MapVault(files), opts());
  const ms = performance.now() - started;
  assert.equal(site.report.pages.length, 300);
  assert.equal(site.report.attachments.length, 50);
  assert.ok(site.report.unpublished.length > 0);
  assert.ok(ms < 10_000, `took ${Math.round(ms)} ms`);
});

test('a bare name that another file has in other letter case is a guess too', () => {
  const files = linkIndex(['Blog/x/image.png', 'Private/Image.png', 'Blog/post.md']);
  assert.deepEqual(resolveLinkDetail('image.png', 'Blog/post.md', files), { key: 'Blog/x/image.png', ambiguous: true });
  assert.deepEqual(resolveLinkDetail('x/image.png', 'Blog/post.md', files), { key: 'Blog/x/image.png', ambiguous: false });
});

test('a front page that is not a published note is said, and the front page is then the list', async () => {
  const notes = { 'Home.md': '---\npublish: true\n---\nhome\n', 'Private.md': 'private\n', 'index.md': '---\npublish: true\n---\nroot\n' };
  const build = (home: string) => buildSite({ list: async () => Object.keys(notes), read: async (p) => new TextEncoder().encode(notes[p as keyof typeof notes]) }, { title: '', home, excluded: () => false });
  assert.equal((await build('Home.md')).report.homeNotFound, '');
  assert.equal((await build('Home')).report.homeNotFound, '');
  assert.equal((await build('')).report.homeNotFound, '');
  for (const wrong of ['Nope.md', 'Private.md', 'home.md']) {
    const site = await build(wrong);
    assert.equal(site.report.homeNotFound, wrong);
    const planned = { plan: { added: [], changed: [], removed: [], same: 0, bytes: 0, first: false }, hashes: new Map<string, string>(), before: null };
    assert.ok(summaryLines({ site, planned }).some((l) => l.startsWith(`Not found: the front page “${wrong}” is not a published note`)), wrong);
  }
});

test('what Obsidian read of the property is judged as the note\'s text is', () => {
  for (const yes of [true, 'true', 'True', ' TRUE ', [true], ['true']]) assert.ok(saysTrue(yes), JSON.stringify(yes));
  for (const no of [false, 'yes', 1, null, undefined, [], [true, true], ['no'], {}]) assert.ok(!saysTrue(no), JSON.stringify(no));
});

test('the whole vault: every note is a page unless it says otherwise, and the same things stay off', async () => {
  for (const yes of ['plain text\n', '---\ntitle: x\n---\nbody\n', '---\npublish: true\n---\n', '\uFEFF---\ntags: [a]\n---\n', '---\nnever closed\n']) assert.ok(publishedInWhole(yes), JSON.stringify(yes));
  for (const no of ['---\npublish: false\n---\n', '---\nPublish: no\n---\n', '---\npublish:\n---\n', '---\npublish: [true, false]\n---\n', '---\nno colon here\npublish: true\n---\n']) assert.ok(!publishedInWhole(no), JSON.stringify(no));

  const notes: Record<string, string> = {
    'Plain.md': 'A plain note with [[Off]] and ![[pic.png]].\n',
    'Props.md': '---\ntitle: With properties\nsecret: SENTINEL-PROP\n---\nbody %%SENTINEL-COMMENT%%\n',
    'Off.md': '---\npublish: false\n---\nSENTINEL-OFF\n',
    'Private/Diary.md': 'SENTINEL-DIARY\n',
    'Private/Asked.md': '---\npublish: true\n---\nSENTINEL-ASKED\n',
    '.trash/Old.md': 'SENTINEL-TRASH\n',
    'Plain (conflict laptop 20260102-150405).md': 'SENTINEL-CONFLICT\n',
    'Broken.md': '---\nno colon here\n---\nSENTINEL-BROKEN\n',
    'pic.png': 'png',
    'unused.png': 'SENTINEL-UNUSED',
  };
  const vault = { list: async () => Object.keys(notes), read: async (p: string) => new TextEncoder().encode(notes[p]) };
  const o = { title: '', home: '', excluded: (k: string) => k.startsWith('Private/') };
  const site = await buildSite(vault, { ...o, whole: true });
  assert.deepEqual(site.report.pages.map((p) => p.path), ['Plain.md', 'Props.md']);
  assert.deepEqual(site.report.attachments.map((a) => a.path), ['pic.png'], 'only the files a page shows, as ever');
  assert.ok(site.report.whole);
  // Only the note that asked to be published is worth a word; the rest of the folder kept off is not.
  assert.deepEqual(site.report.leftOut, [{ path: 'Private/Asked.md', why: 'excluded' }]);
  assert.deepEqual(site.report.unpublished, [{ from: 'Plain.md', link: 'Off' }]);
  const all = [...site.files.values()].map((f) => new TextDecoder().decode(f.data)).join('\n');
  assert.ok(!all.includes('SENTINEL'), 'nothing kept off, hidden, commented or said to be off reaches a file');
  // Without it, the same vault publishes nothing: no note says publish: true outside the folder kept off.
  const marked = await buildSite(vault, o);
  assert.deepEqual(marked.report.pages, []);
  assert.ok(!marked.report.whole);
  const planned = { plan: { added: [], changed: [], removed: [], same: 0, bytes: 0, first: false }, hashes: new Map<string, string>(), before: null };
  assert.match(summaryLines({ site, planned })[0], /made of the whole vault except notes that say publish: false/);
  assert.doesNotMatch(summaryLines({ site: marked, planned })[0], /whole vault/);
});
