// Notes rendered as HTML for a published site: what Obsidian's reading view shows, comments never published, every
// link and tag safe, and any input rendered in linear time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, headingId, renderMarkdown, type RenderHooks } from '../src/publish/markdown.ts';

/** What the hooks were asked. */
interface Calls {
  link: string[];
  embed: string[];
}

/**
 * A site where every note is at `<target>.html` except those starting with `missing`; files by extension: pictures,
 * sound, video and PDF under `files/`, anything else a note titled `<target> (title)`.
 */
function site(calls?: Calls): RenderHooks {
  return {
    link(target) {
      calls?.link.push(target);
      return target.startsWith('missing') ? null : { href: `${encodeURI(target)}.html` };
    },
    embed(target) {
      calls?.embed.push(target);
      if (target.startsWith('missing')) return null;
      const ext = /\.([a-z0-9]+)$/.exec(target)?.[1];
      const href = `files/${encodeURI(target)}`;
      if (ext === 'png' || ext === 'jpg') return { href, kind: 'image' };
      if (ext === 'mp3') return { href, kind: 'audio' };
      if (ext === 'mp4') return { href, kind: 'video' };
      if (ext === 'pdf') return { href, kind: 'pdf' };
      return { href: `${encodeURI(target)}.html`, kind: 'note', title: `${target} (title)` };
    },
  };
}

const html = (md: string, hooks: RenderHooks = site()) => renderMarkdown(md, hooks).html;

/** Each `[markdown, html]` renders exactly so. */
function renders(cases: [string, string][]) {
  for (const [md, want] of cases) assert.equal(html(md), want, JSON.stringify(md));
}

/** Nothing of `secret` shows anywhere in the page, in any letter case. */
function hidden(md: string, secret = 'secret') {
  const out = html(md);
  assert.ok(!out.toLowerCase().includes(secret.toLowerCase()), `${JSON.stringify(md)} showed ${secret}: ${out}`);
  return out;
}

// Hidden text. People keep private remarks in comments: none may reach the page.

test('comments: %%…%% and <!-- --> are cut, inline, two on a line, and across lines', () => {
  renders([
    ['a %%secret%% b', '<p>a  b</p>'],
    ['a %%one%% b %%two%% c', '<p>a  b  c</p>'],
    ['a <!-- secret --> b', '<p>a  b</p>'],
    ['a <!--one--> b %%two%% c <!--three--> d', '<p>a  b  c  d</p>'],
    ['a %%secret\nstill secret%% b', '<p>a  b</p>'],
    ['%%secret%%', ''],
    ['Before\n%% secret %%\nAfter', '<p>Before<br>\nAfter</p>'],
    ['Before\n\n%%\nsecret\n%%\n\nAfter', '<p>Before</p>\n<p>After</p>'],
    ['Before\n<!--\nsecret\n-->\nAfter', '<p>Before<br>\nAfter</p>'],
  ]);
  for (const md of ['a %%secret%% b', 'a <!-- secret --> b', '%%secret', '<!-- secret', 'x %%secret%%%%secret%% y', 'x <!--secret--><!--secret--> y']) hidden(md);
});

test('comments: one spanning blocks hides every block it spans', () => {
  const md = 'Visible one %% secret starts\n\n# Secret heading\n\n- secret item\n\n> secret quote\n\n| secret | table |\n|---|---|\n| secret | row |\n\nsecret ends %% visible two';
  assert.equal(hidden(md), '<p>Visible one  visible two</p>');
  assert.equal(hidden('Start <!-- secret\n\n## Secret\n\nsecret --> end'), '<p>Start  end</p>');
  // A fence opened inside a comment is no fence: the comment ends at the next marker, wherever it is.
  assert.equal(hidden('a %% secret\n```\nsecret %% b\n```\nc'), '<p>a  b</p>\n<pre><code>c</code></pre>');
});

test('comments: an unclosed one hides everything to the end of the note, as in Obsidian', () => {
  assert.equal(hidden('Shown\n\n%% secret\n\n# Secret\n\n- secret'), '<p>Shown</p>');
  assert.equal(hidden('Shown <!-- secret\n\n```\nsecret\n```'), '<p>Shown</p>');
  assert.equal(hidden('Shown %% secret `code` secret'), '<p>Shown</p>');
});

test('comments: inside a list item, a table cell, a callout, a heading, a footnote and a link', () => {
  assert.equal(hidden('- one %%secret%%\n- two'), '<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
  assert.equal(hidden('- one\n  %%secret%%\n- two'), '<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
  assert.equal(hidden('- one %% secret\n- secret %% two'), '<ul>\n<li>one  two</li>\n</ul>');
  assert.equal(
    hidden('| a | b %%secret%% |\n|---|---|\n| c %%secret%% | <!--secret--> |'),
    '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>c</td><td></td></tr>\n</tbody>\n</table>',
  );
  assert.equal(
    hidden('> [!note] Title %%secret%%\n> body %%secret%%\n> %% secret %%\n> more'),
    '<div class="callout" data-callout="note">\n<div class="callout-title">Title</div>\n<div class="callout-content">\n<p>body<br>\nmore</p>\n</div>\n</div>',
  );
  assert.equal(hidden('> [!note] %%secret%%\n> body'), '<div class="callout" data-callout="note">\n<div class="callout-title">Note</div>\n<div class="callout-content">\n<p>body</p>\n</div>\n</div>');
  assert.equal(hidden('> quote %% secret\n> secret %% end'), '<blockquote>\n<p>quote  end</p>\n</blockquote>');
  const r = renderMarkdown('# Title %%secret%%\n\n## <!--secret-->Other', site());
  assert.deepEqual(r.headings, [{ level: 1, text: 'Title', id: 'Title' }, { level: 2, text: 'Other', id: 'Other' }]);
  hidden('Text[^1]\n\n[^1]: note %%secret%%');
  hidden('Text^[note %%secret%%]');
  hidden('[link %%secret%%](https://example.com)');
  hidden('![alt %%secret%%](a.png)');
});

test('comments: a marker in an address, a wikilink, a tag or a URL still starts a comment', () => {
  for (const md of [
    '[a](note%%secret%%.md)',
    '[a](https://example.com/%%secret%%)',
    '[[note%%secret%%]]',
    '[[note|alias %%secret%%]]',
    '![[a.png|%%secret%%]]',
    '<span title="%%secret%%">x</span>',
    '<unknown title="%%secret%%">',
    'https://example.com/%%secret%%',
    '<https://example.com/%%secret%%>',
    '#tag%%secret%%',
    '\\%%secret%%',
    '\\<!--secret-->',
    '[^%%secret%%]',
    '^[%%secret%%]',
  ])
    hidden(md);
  // Cut out, the comment leaves `[^a]: definition`, a footnote no one references.
  assert.equal(hidden('[^a%%secret%%]: definition\n\nafter %% secret'), '<p>after</p>');
});

test('comments: %% and <!-- stay as written inside code and math', () => {
  renders([
    ['`a %%kept%% b`', '<p><code>a %%kept%% b</code></p>'],
    ['`%%` and %%secret%%', '<p><code>%%</code> and</p>'],
    ['``x %% ` y``', '<p><code>x %% ` y</code></p>'],
    ['`<!-- kept -->`', '<p><code>&lt;!-- kept --&gt;</code></p>'],
    ['```\n%% kept %%\n<!-- kept -->\n```', '<pre><code>%% kept %%\n&lt;!-- kept --&gt;</code></pre>'],
    ['~~~\n%% unclosed kept\n~~~\nafter %%secret%%', '<pre><code>%% unclosed kept</code></pre>\n<p>after</p>'],
    ['- item\n  ```\n  %% kept %%\n  ```', '<ul>\n<li>item\n<pre><code>%% kept %%</code></pre>\n</li>\n</ul>'],
    ['> ```\n> %% kept\n> ```', '<blockquote>\n<pre><code>%% kept</code></pre>\n</blockquote>'],
    ['$a %% b$', '<p><code class="math">a %% b</code></p>'],
    ['$$\n%% kept %%\n$$', '<pre class="math"><code>%% kept %%</code></pre>'],
  ]);
  // A code span that starts inside a comment is no code span.
  assert.equal(hidden('%% secret `a %% b`'), '<p>b`</p>');
});

// Blocks.

test('headings: # to ######, a space after the hashes, closing hashes dropped', () => {
  renders([
    ['# One', '<h1 id="One">One</h1>'],
    ['###### Six', '<h6 id="Six">Six</h6>'],
    ['## Two ##', '<h2 id="Two">Two</h2>'],
    ['## C#', '<h2 id="C">C#</h2>'],
    ['#\tTab', '<h1 id="Tab">Tab</h1>'],
    ['   # Indented', '<h1 id="Indented">Indented</h1>'],
    ['#', '<h1 id="section"></h1>'],
    ['## *Em* and `code`', '<h2 id="Em-and-code"><em>Em</em> and <code>code</code></h2>'],
  ]);
  renders([
    ['#tag', '<p><span class="tag">#tag</span></p>'],
    ['####### Seven', '<p>####### Seven</p>'],
    ['    # Four spaces', '<p># Four spaces</p>'],
    ['\\# Escaped', '<p># Escaped</p>'],
  ]);
});

test('headings: ids from plain text, repeated ids numbered, and the list of headings', () => {
  const r = renderMarkdown('# Intro\n\n## Intro\n\n## Intro\n\n### Tom &amp; **Jerry** <b>x</b>\n\n# Intro-1', site());
  assert.deepEqual(r.headings, [
    { level: 1, text: 'Intro', id: 'Intro' },
    { level: 2, text: 'Intro', id: 'Intro-1' },
    { level: 2, text: 'Intro', id: 'Intro-2' },
    { level: 3, text: 'Tom & Jerry x', id: 'Tom-Jerry-x' },
    { level: 1, text: 'Intro-1', id: 'Intro-1-1' },
  ]);
  assert.ok(r.html.includes('<h2 id="Intro-2">Intro</h2>'));
  assert.ok(r.startsWithH1);
  assert.equal(renderMarkdown('Text\n\n# Title', site()).startsWithH1, false);
  assert.equal(renderMarkdown('## Title', site()).startsWithH1, false);
  assert.equal(renderMarkdown('[^1]: def\n\n# Title', site()).startsWithH1, true);
});

test('headings: what an embed or comment taken out leaves is no space at either end, and one space inside', () => {
  const none: RenderHooks = { link: () => null, embed: () => null };
  const r = renderMarkdown('# ![[x.png]] Title\n\n## Two %%c%%   words ![[y.png]]\n\n### <!--c--> A ![[z.png]]  B <!--d-->\n\n# ![[x.png]]', none);
  // Spaces inside the element stay as written, as a browser shows a run of them as one.
  assert.equal(r.html, '<h1 id="Title">Title</h1>\n<h2 id="Two-words">Two    words</h2>\n<h3 id="A-B">A   B</h3>\n<h1 id="section"></h1>');
  assert.deepEqual(r.headings, [
    { level: 1, text: 'Title', id: 'Title' },
    { level: 2, text: 'Two words', id: 'Two-words' },
    { level: 3, text: 'A B', id: 'A-B' },
    { level: 1, text: '', id: 'section' },
  ]);
  assert.ok(r.startsWithH1);
  // A picture that stays keeps its place.
  assert.equal(html('# ![[x.png]] Title'), '<h1 id="Title"><img src="files/x.png" alt="x.png" loading="lazy"> Title</h1>');
});

test('headingId: spaces to dashes, unsafe characters out, case kept', () => {
  for (const [text, id] of [
    ['Hello World', 'Hello-World'],
    ['  Many   spaces\there  ', 'Many-spaces-here'],
    ['Q&A: "quotes" <tags> #hash 50% `tick`', 'QA:-quotes-tags-hash-50-tick'],
    ["it's", 'its'],
    ['Café ünïcode', 'Café-ünïcode'],
    ['', 'section'],
    ['#%&', 'section'],
    ['a\u0000b\u007fc', 'abc'],
  ])
    assert.equal(headingId(text), id, text);
});

test('paragraphs: a single line break is <br>, a blank line starts a new paragraph', () => {
  renders([
    ['one\ntwo', '<p>one<br>\ntwo</p>'],
    ['one  \n   two', '<p>one<br>\ntwo</p>'],
    ['one\\\ntwo', '<p>one<br>\ntwo</p>'],
    ['one\n\ntwo', '<p>one</p>\n<p>two</p>'],
    ['one\n\n\n\ntwo', '<p>one</p>\n<p>two</p>'],
    ['    indented is text', '<p>indented is text</p>'],
    ['', ''],
    ['\n\n', ''],
  ]);
});

test('fenced code: backticks or tildes, the language as a class, contents escaped and untouched', () => {
  renders([
    ['```js\nlet a = 1 < 2 && "x";\n```', '<pre><code class="language-js">let a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;</code></pre>'],
    ['~~~python extra words\n*not em*\n~~~', '<pre><code class="language-python">*not em*</code></pre>'],
    ['```\n[[link]] #tag $x$\n```', '<pre><code>[[link]] #tag $x$</code></pre>'],
    ['````\n```\ninside\n```\n````', '<pre><code>```\ninside\n```</code></pre>'],
    ['```\nunclosed\n\nruns on', '<pre><code>unclosed\n\nruns on</code></pre>'],
    ['```\na\n``\nb\n~~~\n```', '<pre><code>a\n``\nb\n~~~</code></pre>'],
    ['```\n```', '<pre><code></code></pre>'],
    ['  ```\n  indented\n    more\n  ```', '<pre><code>indented\n  more</code></pre>'],
    ['text\n```\ncode\n```', '<p>text</p>\n<pre><code>code</code></pre>'],
    ['```c++\nx\n```', '<pre><code class="language-c++">x</code></pre>'],
  ]);
  // Not a fence: two backticks, or a backtick in a backtick fence's info string.
  renders([
    ['``\nx\n``', '<p><code>x</code></p>'],
    ['``` a`b\nx', '<p>``` a`b<br>\nx</p>'],
  ]);
});

test('blockquotes: nested, and each line needs its >', () => {
  renders([
    ['> quote', '<blockquote>\n<p>quote</p>\n</blockquote>'],
    ['> one\n> two', '<blockquote>\n<p>one<br>\ntwo</p>\n</blockquote>'],
    ['>no space', '<blockquote>\n<p>no space</p>\n</blockquote>'],
    ['> outer\n> > inner\n> back', '<blockquote>\n<p>outer</p>\n<blockquote>\n<p>inner</p>\n</blockquote>\n<p>back</p>\n</blockquote>'],
    ['> one\n>\n> two', '<blockquote>\n<p>one</p>\n<p>two</p>\n</blockquote>'],
    ['> # Heading\n> - item', '<blockquote>\n<h1 id="Heading">Heading</h1>\n<ul>\n<li>item</li>\n</ul>\n</blockquote>'],
    ['>', '<blockquote></blockquote>'],
  ]);
  renders([
    ['> quote\nnot quoted', '<blockquote>\n<p>quote</p>\n</blockquote>\n<p>not quoted</p>'],
    ['> quote\n\n> another', '<blockquote>\n<p>quote</p>\n</blockquote>\n<blockquote>\n<p>another</p>\n</blockquote>'],
    ['    > four spaces', '<p>&gt; four spaces</p>'],
  ]);
});

test('callouts: type, title, default title, folding, and an ordinary quote for anything else', () => {
  renders([
    ['> [!note]\n> Body', '<div class="callout" data-callout="note">\n<div class="callout-title">Note</div>\n<div class="callout-content">\n<p>Body</p>\n</div>\n</div>'],
    ['> [!WARNING] Be **careful**', '<div class="callout" data-callout="warning">\n<div class="callout-title">Be <strong>careful</strong></div>\n<div class="callout-content"></div>\n</div>'],
    ['> [!my-type2]', '<div class="callout" data-callout="my-type2">\n<div class="callout-title">My-type2</div>\n<div class="callout-content"></div>\n</div>'],
    ['> [!tip]+ Open\n> x', '<details class="callout" data-callout="tip" open>\n<summary class="callout-title">Open</summary>\n<div class="callout-content">\n<p>x</p>\n</div>\n</details>'],
    ['> [!tip]- Closed\n> x', '<details class="callout" data-callout="tip">\n<summary class="callout-title">Closed</summary>\n<div class="callout-content">\n<p>x</p>\n</div>\n</details>'],
    ['> [!faq]-', '<details class="callout" data-callout="faq">\n<summary class="callout-title">Faq</summary>\n<div class="callout-content"></div>\n</details>'],
    [
      '> [!info] Steps\n> - one\n>   - nested\n> - two',
      '<div class="callout" data-callout="info">\n<div class="callout-title">Steps</div>\n<div class="callout-content">\n<ul>\n<li>one\n<ul>\n<li>nested</li>\n</ul>\n</li>\n<li>two</li>\n</ul>\n</div>\n</div>',
    ],
    [
      '> [!note]\n> > [!tip] Inner\n> > x',
      '<div class="callout" data-callout="note">\n<div class="callout-title">Note</div>\n<div class="callout-content">\n<div class="callout" data-callout="tip">\n<div class="callout-title">Inner</div>\n<div class="callout-content">\n<p>x</p>\n</div>\n</div>\n</div>\n</div>',
    ],
  ]);
  renders([
    ['> [!bad type]\n> x', '<blockquote>\n<p>[!bad type]<br>\nx</p>\n</blockquote>'],
    ['> [!"><script>]', '<blockquote>\n<p>[!&quot;&gt;&lt;script&gt;]</p>\n</blockquote>'],
    ['> [!]', '<blockquote>\n<p>[!]</p>\n</blockquote>'],
    ['> text\n> [!note]', '<blockquote>\n<p>text<br>\n[!note]</p>\n</blockquote>'],
    ['[!note] not in a quote', '<p>[!note] not in a quote</p>'],
  ]);
});

test('lists: bullets, numbers with their start, nesting by spaces or tabs', () => {
  renders([
    ['- a\n- b', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'],
    ['* a\n+ b', '<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>'],
    ['1. a\n2. b', '<ol>\n<li>a</li>\n<li>b</li>\n</ol>'],
    ['3) a\n4) b', '<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>'],
    ['- a\n  - b\n    - c\n- d', '<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul>\n</li>\n</ul>\n</li>\n<li>d</li>\n</ul>'],
    ['- a\n\t- b\n\t\t- c', '<ul>\n<li>a\n<ul>\n<li>b\n<ul>\n<li>c</li>\n</ul>\n</li>\n</ul>\n</li>\n</ul>'],
    ['1. a\n  - b', '<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n</ol>'],
    ['1. a\n   1. b', '<ol>\n<li>a\n<ol>\n<li>b</li>\n</ol>\n</li>\n</ol>'],
    ['- a\n continued\nlazy', '<ul>\n<li>a<br>\ncontinued<br>\nlazy</li>\n</ul>'],
    ['- a\n - b', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'],
    ['text\n- item', '<p>text</p>\n<ul>\n<li>item</li>\n</ul>'],
    ['-\n  late text', '<ul>\n<li>late text</li>\n</ul>'],
    ['- ', '<ul>\n<li></li>\n</ul>'],
  ]);
  renders([
    ['-not a list', '<p>-not a list</p>'],
    ['1.5 is a number', '<p>1.5 is a number</p>'],
    ['I paid\n2. not a list', '<p>I paid<br>\n2. not a list</p>'],
    ['- a\n\nafter', '<ul>\n<li>a</li>\n</ul>\n<p>after</p>'],
    ['> quoted\n2. listed', '<blockquote>\n<p>quoted</p>\n</blockquote>\n<ol start="2">\n<li>listed</li>\n</ol>'],
  ]);
});

test('lists: tasks, open or checked by any character, at any depth', () => {
  renders([
    ['- [ ] todo\n- [x] done\n- [X] done\n- [-] cancelled', '<ul>\n<li class="task"><input type="checkbox" disabled> todo</li>\n<li class="task"><input type="checkbox" checked disabled> done</li>\n<li class="task"><input type="checkbox" checked disabled> done</li>\n<li class="task"><input type="checkbox" checked disabled> cancelled</li>\n</ul>'],
    [
      '- [ ] parent\n  - [x] child\n  - plain',
      '<ul>\n<li class="task"><input type="checkbox" disabled> parent\n<ul>\n<li class="task"><input type="checkbox" checked disabled> child</li>\n<li>plain</li>\n</ul>\n</li>\n</ul>',
    ],
    ['1. [ ] numbered', '<ol>\n<li class="task"><input type="checkbox" disabled> numbered</li>\n</ol>'],
    ['- [ ]', '<ul>\n<li class="task"><input type="checkbox" disabled></li>\n</ul>'],
    ['- [ ] a\n\n- [x] b', '<ul>\n<li class="task">\n<p><input type="checkbox" disabled> a</p>\n</li>\n<li class="task">\n<p><input type="checkbox" checked disabled> b</p>\n</li>\n</ul>'],
  ]);
  renders([
    ['- [] not a task', '<ul>\n<li>[] not a task</li>\n</ul>'],
    ['- [ab] not a task', '<ul>\n<li>[ab] not a task</li>\n</ul>'],
    ['- [x]not a task', '<ul>\n<li>[x]not a task</li>\n</ul>'],
    ['[ ] not in a list', '<p>[ ] not in a list</p>'],
  ]);
});

test('lists: tight unless blank lines separate items or an item\'s blocks', () => {
  renders([
    ['- a\n- b', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'],
    ['- a\n\n- b', '<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>'],
    ['- a\n\n  second paragraph\n- b', '<ul>\n<li>\n<p>a</p>\n<p>second paragraph</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>'],
    ['- a\n  - b\n\n  - c\n- d', '<ul>\n<li>a\n<ul>\n<li>\n<p>b</p>\n</li>\n<li>\n<p>c</p>\n</li>\n</ul>\n</li>\n<li>d</li>\n</ul>'],
    ['- a\n- b\n\n', '<ul>\n<li>a</li>\n<li>b</li>\n</ul>'],
  ]);
});

test('lists: blocks indented under an item belong to it: code fences, quotes, paragraphs', () => {
  renders([
    ['- item\n  ```js\n  code\n    indented\n  ```\n- next', '<ul>\n<li>item\n<pre><code class="language-js">code\n  indented</code></pre>\n</li>\n<li>next</li>\n</ul>'],
    ['1. item\n   ```\n   x\n\n   y\n   ```', '<ol>\n<li>item\n<pre><code>x\n\ny</code></pre>\n</li>\n</ol>'],
    ['- item\n  > quoted', '<ul>\n<li>item\n<blockquote>\n<p>quoted</p>\n</blockquote>\n</li>\n</ul>'],
    ['- > quoted\n  > more', '<ul>\n<li>\n<blockquote>\n<p>quoted<br>\nmore</p>\n</blockquote>\n</li>\n</ul>'],
    ['- item\n```\nnot in item\n```', '<ul>\n<li>item</li>\n</ul>\n<pre><code>not in item</code></pre>'],
  ]);
});

test('tables: header, alignment by class, body rows, and cells padded or cut to the header', () => {
  renders([
    ['| a | b |\n|---|---|\n| 1 | 2 |', '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table>'],
    [
      'a | b | c\n:-- | :-: | --:\n1 | 2 | 3',
      '<table>\n<thead>\n<tr><th class="left">a</th><th class="center">b</th><th class="right">c</th></tr>\n</thead>\n<tbody>\n<tr><td class="left">1</td><td class="center">2</td><td class="right">3</td></tr>\n</tbody>\n</table>',
    ],
    ['| a | b |\n| - | - |', '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n</table>'],
    ['| a | b |\n|---|---|\n| only |\n| 1 | 2 | 3 |', '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>only</td><td></td></tr>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table>'],
    ['| *a* | `b` |\n|---|---|', '<table>\n<thead>\n<tr><th><em>a</em></th><th><code>b</code></th></tr>\n</thead>\n</table>'],
    ['Intro\n| a |\n|---|\n| 1 |\nafter', '<p>Intro</p>\n<table>\n<thead>\n<tr><th>a</th></tr>\n</thead>\n<tbody>\n<tr><td>1</td></tr>\n</tbody>\n</table>\n<p>after</p>'],
  ]);
  renders([
    ['| a | b |\n|---|', '<p>| a | b |<br>\n|---|</p>'],
    ['| a |\n| x |', '<p>| a |<br>\n| x |</p>'],
    ['a\n---', '<p>a</p>\n<hr>'],
  ]);
});

test('tables: \\| is a pipe in a cell; pipes in inline code and wikilinks do not split cells', () => {
  renders([
    ['| a \\| b | c |\n|---|---|', '<table>\n<thead>\n<tr><th>a | b</th><th>c</th></tr>\n</thead>\n</table>'],
    ['| `x | y` | `p \\| q` |\n|---|---|', '<table>\n<thead>\n<tr><th><code>x | y</code></th><th><code>p | q</code></th></tr>\n</thead>\n</table>'],
    ['| [[Note\\|alias]] | [[Other|shown]] |\n|---|---|', '<table>\n<thead>\n<tr><th><a href="Note.html" class="internal">alias</a></th><th><a href="Other.html" class="internal">shown</a></th></tr>\n</thead>\n</table>'],
    ['| [[Note#Part\\|alias]] |\n|---|', '<table>\n<thead>\n<tr><th><a href="Note.html#Part" class="internal">alias</a></th></tr>\n</thead>\n</table>'],
  ]);
});

test('horizontal rules: three or more of - * _, alone on a line', () => {
  renders([
    ['---', '<hr>'],
    ['***', '<hr>'],
    ['___', '<hr>'],
    ['- - -', '<hr>'],
    ['----------', '<hr>'],
    ['a\n\n***\n\nb', '<p>a</p>\n<hr>\n<p>b</p>'],
  ]);
  renders([
    ['--', '<p>--</p>'],
    ['--- x', '<p>--- x</p>'],
    ['-*-', '<p>-*-</p>'],
  ]);
});

test('footnotes: numbered by first reference, a back link each, unreferenced ones dropped', () => {
  assert.equal(
    html('B[^b] then A[^a] then B again[^b].\n\n[^a]: Note A\n[^b]: Note *B*\n[^unused]: never shown'),
    '<p>B<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup> then A<sup class="footnote-ref"><a href="#fn-2" id="fnref-2">2</a></sup> then B again<sup class="footnote-ref"><a href="#fn-1" id="fnref-1-2">1</a></sup>.</p>\n' +
      '<section class="footnotes">\n<ol>\n<li id="fn-1">Note <em>B</em> <a href="#fnref-1" class="footnote-back">↩</a></li>\n<li id="fn-2">Note A <a href="#fnref-2" class="footnote-back">↩</a></li>\n</ol>\n</section>',
  );
  assert.equal(html('No note[^missing] here.'), '<p>No note[^missing] here.</p>');
  assert.equal(html('[^lonely]: Only a definition'), '');
  assert.equal(
    html('Inline^[a *quick* note] and defined[^d].\n\n[^d]: Defined'),
    '<p>Inline<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup> and defined<sup class="footnote-ref"><a href="#fn-2" id="fnref-2">2</a></sup>.</p>\n' +
      '<section class="footnotes">\n<ol>\n<li id="fn-1">a <em>quick</em> note <a href="#fnref-1" class="footnote-back">↩</a></li>\n<li id="fn-2">Defined <a href="#fnref-2" class="footnote-back">↩</a></li>\n</ol>\n</section>',
  );
  assert.equal(
    html('Long[^l].\n\n[^l]: First paragraph\n    continued.\n\n    Second paragraph.'),
    '<p>Long<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>.</p>\n<section class="footnotes">\n<ol>\n<li id="fn-1">\n<p>First paragraph<br>\ncontinued.</p>\n<p>Second paragraph. <a href="#fnref-1" class="footnote-back">↩</a></p>\n</li>\n</ol>\n</section>',
  );
  // A footnote referenced only from another footnote follows it.
  assert.ok(html('A[^1]\n\n[^1]: see[^2]\n[^2]: deeper').includes('<li id="fn-2">deeper'));
  assert.equal(html('Not a note ^ [x] or x^y'), '<p>Not a note ^ [x] or x^y</p>');
});

test('math: $$ blocks and inline $…$ hold their source, escaped', () => {
  renders([
    ['$$\na < b\n\\frac{1}{2}\n$$', '<pre class="math"><code>a &lt; b\n\\frac{1}{2}</code></pre>'],
    ['$$x^2$$', '<pre class="math"><code>x^2</code></pre>'],
    ['$$\nunclosed', '<pre class="math"><code>unclosed</code></pre>'],
    ['Euler: $e^{i\\pi} = -1$.', '<p>Euler: <code class="math">e^{i\\pi} = -1</code>.</p>'],
    ['$a$ and $b$', '<p><code class="math">a</code> and <code class="math">b</code></p>'],
    ['$a\\$b$', '<p><code class="math">a\\$b</code></p>'],
    ['Inline $$x$$ display', '<p>Inline <code class="math">x</code> display</p>'],
  ]);
  renders([
    ['It costs $5 and $10.', '<p>It costs $5 and $10.</p>'],
    ['From $5 to $10, and $x$ is math', '<p>From $5 to $10, and <code class="math">x</code> is math</p>'],
    ['$a$$b$', '<p>$a$$b$</p>'],
    ['$ not math$', '<p>$ not math$</p>'],
    ['$not math $', '<p>$not math $</p>'],
    ['$1$2', '<p>$1$2</p>'],
    ['\\$x$', '<p>$x$</p>'],
    ['$a\nb$', '<p>$a<br>\nb$</p>'],
  ]);
});

test('raw HTML: allowed tags pass without attributes, others show as text', () => {
  renders([
    ['a<br>b<br/>c', '<p>a<br>b<br>c</p>'],
    ['<kbd>Ctrl</kbd>+<kbd>C</kbd>', '<p><kbd>Ctrl</kbd>+<kbd>C</kbd></p>'],
    ['H<sub>2</sub>O x<sup>2</sup> <u>u</u> <s>s</s> <mark>m</mark> <small>s</small> <ins>i</ins> <del>d</del>', '<p>H<sub>2</sub>O x<sup>2</sup> <u>u</u> <s>s</s> <mark>m</mark> <small>s</small> <ins>i</ins> <del>d</del></p>'],
    ['<span style="color:red" class="x">red</span>', '<p><span>red</span></p>'],
    ['<B>Bold</B>', '<p><b>Bold</b></p>'],
    ['<div align="center">\n**centered**\n</div>', '<div>\n<strong>centered</strong>\n</div>'],
    ['<details>\n<summary>More</summary>\nHidden until opened\n</details>', '<details>\n<summary>More</summary>\nHidden until opened\n</details>'],
    ['<abbr title="x">HTML</abbr>', '<p><abbr>HTML</abbr></p>'],
  ]);
  renders([
    ['<iframe src="x"></iframe>', '<p>&lt;iframe src=&quot;x&quot;&gt;&lt;/iframe&gt;</p>'],
    ['<style>p{}</style>', '<p>&lt;style&gt;p{}&lt;/style&gt;</p>'],
    ['<svg:rect/>', '<p>&lt;svg:rect/&gt;</p>'],
    ['<custom-tag>x</custom-tag>', '<p>&lt;custom-tag&gt;x&lt;/custom-tag&gt;</p>'],
    ['a < b > c', '<p>a &lt; b &gt; c</p>'],
  ]);
});

test('raw HTML: tags stay balanced within each block and each Markdown element', () => {
  renders([
    ['<b>never closed', '<p><b>never closed</b></p>'],
    ['closed only</b> here', '<p>closed only here</p>'],
    ['<b><i>crossed</b></i>', '<p><b><i>crossed</i></b></p>'],
    ['**a <i>b** c</i>', '<p><strong>a <i>b</i></strong> c</p>'],
    ['<b>one\n\ntwo</b>', '<p><b>one</b></p>\n<p>two</p>'],
    ['[<b>x](https://a.com) y</b>', '<p><a href="https://a.com" class="external" rel="noopener noreferrer"><b>x</b></a> y</p>'],
    ['- <i>item\n- next</i>', '<ul>\n<li><i>item</i></li>\n<li>next</li>\n</ul>'],
    ['<b/>x', '<p><b></b>x</p>'],
    ['</br>', '<p></p>'],
  ]);
});

test('block ids: at the end of a block, or alone on the line after one', () => {
  renders([
    ['A paragraph ^para-1', '<p id="^para-1">A paragraph</p>'],
    ['Two lines\n^next-line', '<p id="^next-line">Two lines</p>'],
    ['- item ^li1\n- other', '<ul>\n<li id="^li1">item</li>\n<li>other</li>\n</ul>'],
    ['- [ ] task ^t1', '<ul>\n<li class="task" id="^t1"><input type="checkbox" disabled> task</li>\n</ul>'],
    ['- a\n- b\n\n^list', '<ul id="^list">\n<li>a</li>\n<li>b</li>\n</ul>'],
    ['> quote\n\n^q', '<blockquote id="^q">\n<p>quote</p>\n</blockquote>'],
    ['> [!note]\n> x\n\n^c', '<div class="callout" data-callout="note" id="^c">\n<div class="callout-title">Note</div>\n<div class="callout-content">\n<p>x</p>\n</div>\n</div>'],
    ['| a |\n|---|\n| b |\n^t', '<table id="^t">\n<thead>\n<tr><th>a</th></tr>\n</thead>\n<tbody>\n<tr><td>b</td></tr>\n</tbody>\n</table>'],
    ['```\ncode\n```\n^code', '<pre id="^code"><code>code</code></pre>'],
    ['$$\nx\n$$\n^m', '<pre class="math" id="^m"><code>x</code></pre>'],
    ['---\n^rule', '<hr id="^rule">'],
    ['# Heading ^h', '<h1 id="Heading">Heading</h1>'],
    ['A ^dup\n\nB ^dup', '<p id="^dup">A</p>\n<p>B</p>'],
  ]);
  renders([
    ['x^notid', '<p>x^notid</p>'],
    ['a ^bad_id', '<p>a ^bad_id</p>'],
    ['^alone', ''],
    ['`code ^x`', '<p><code>code ^x</code></p>'],
  ]);
});

// Inline.

test('inline: emphasis, strong, both, strikethrough and highlight; unmatched delimiters are text', () => {
  renders([
    ['*em* _em_ **strong** __strong__', '<p><em>em</em> <em>em</em> <strong>strong</strong> <strong>strong</strong></p>'],
    ['***both*** ___both___', '<p><em><strong>both</strong></em> <em><strong>both</strong></em></p>'],
    ['**bold *and em***', '<p><strong>bold <em>and em</em></strong></p>'],
    ['~~gone~~ ==marked==', '<p><del>gone</del> <mark>marked</mark></p>'],
    ['**[[Note]]**', '<p><strong><a href="Note.html" class="internal">Note</a></strong></p>'],
    ['*a **b** c*', '<p><em>a <strong>b</strong> c</em></p>'],
    ['intra*word*emphasis', '<p>intra<em>word</em>emphasis</p>'],
  ]);
  renders([
    ['snake_case_name', '<p>snake_case_name</p>'],
    ['*not closed', '<p>*not closed</p>'],
    ['a * b * c', '<p>a * b * c</p>'],
    ['~one~ ~~~three~~~', '<p>~one~ ~~~three~~~</p>'],
    ['a == b', '<p>a == b</p>'],
    ['**a*', '<p>*<em>a</em></p>'],
    ['\\*escaped\\*', '<p>*escaped*</p>'],
  ]);
});

test('inline: code spans of any backtick run, one space stripped from each side', () => {
  renders([
    ['`code`', '<p><code>code</code></p>'],
    ['`` a`b ``', '<p><code>a`b</code></p>'],
    ['` `', '<p><code> </code></p>'],
    ['`  two  `', '<p><code> two </code></p>'],
    ['`<b>&amp;</b>`', '<p><code>&lt;b&gt;&amp;amp;&lt;/b&gt;</code></p>'],
    ['`a\nb`', '<p><code>a b</code></p>'],
    ['`*no em*` *em*', '<p><code>*no em*</code> <em>em</em></p>'],
  ]);
  renders([
    ['`unclosed', '<p>`unclosed</p>'],
    ['``a`', '<p>``a`</p>'],
    ['\\`not code`', '<p>`not code`</p>'],
  ]);
});

test('inline: escapes and entities', () => {
  renders([
    ['\\[not link\\](x) \\# \\_ \\\\', '<p>[not link](x) # _ \\</p>'],
    ['\\a stays', '<p>\\a stays</p>'],
    ['&amp; &copy; &#123; &#x1F600; &nbsp;', '<p>&amp; &copy; &#123; &#x1F600; &nbsp;</p>'],
    ['AT&T & a&b; &#xZZ; &;', '<p>AT&amp;T &amp; a&amp;b; &amp;#xZZ; &amp;;</p>'],
    ['&lt;script&gt;', '<p>&lt;script&gt;</p>'],
  ]);
});

test('wikilinks: shown text and fragments as Obsidian shows them', () => {
  renders([
    ['[[Note]]', '<p><a href="Note.html" class="internal">Note</a></p>'],
    ['[[Note|Shown]]', '<p><a href="Note.html" class="internal">Shown</a></p>'],
    ['[[Note#Some Heading]]', '<p><a href="Note.html#Some-Heading" class="internal">Note &gt; Some Heading</a></p>'],
    ['[[Note#A#B]]', '<p><a href="Note.html#B" class="internal">Note &gt; A &gt; B</a></p>'],
    ['[[Note#^block-1]]', '<p><a href="Note.html#^block-1" class="internal">Note &gt; ^block-1</a></p>'],
    ['[[Note#Heading|alias]]', '<p><a href="Note.html#Heading" class="internal">alias</a></p>'],
    ['[[#Local Heading]]', '<p><a href="#Local-Heading" class="internal">Local Heading</a></p>'],
    ['[[#^local]]', '<p><a href="#^local" class="internal">^local</a></p>'],
    ['[[folder/My Note]]', '<p><a href="folder/My%20Note.html" class="internal">folder/My Note</a></p>'],
    ['[[missing note]]', '<p><span class="unresolved">missing note</span></p>'],
    ['[[missing|Alias]]', '<p><span class="unresolved">Alias</span></p>'],
    ['[[a]] and [[b]]', '<p><a href="a.html" class="internal">a</a> and <a href="b.html" class="internal">b</a></p>'],
  ]);
  renders([
    ['[[]]', '<p>[[]]</p>'],
    ['[[unclosed', '<p>[[unclosed</p>'],
    ['[[a\nb]]', '<p>[[a<br>\nb]]</p>'],
    ['`[[code]]`', '<p><code>[[code]]</code></p>'],
    ['\\[[escaped]]', '<p>[[escaped]]</p>'],
  ]);
});

test('markdown links: web, page, vault paths, titles, and text-only for unknown targets', () => {
  renders([
    ['[site](https://example.com/a?b=1&c=2)', '<p><a href="https://example.com/a?b=1&amp;c=2" class="external" rel="noopener noreferrer">site</a></p>'],
    ['[mail](mailto:a@b.c) [call](tel:+123)', '<p><a href="mailto:a@b.c" class="external" rel="noopener noreferrer">mail</a> <a href="tel:+123" class="external" rel="noopener noreferrer">call</a></p>'],
    ['[t](https://a.com "Title \\"q\\"")', '<p><a href="https://a.com" class="external" rel="noopener noreferrer" title="Title &quot;q&quot;">t</a></p>'],
    ['[sp](<https://a.com/with space>)', '<p><a href="https://a.com/with%20space" class="external" rel="noopener noreferrer">sp</a></p>'],
    ['[up](HTTPS://A.COM)', '<p><a href="HTTPS://A.COM" class="external" rel="noopener noreferrer">up</a></p>'],
    ['[wiki](https://en.wikipedia.org/wiki/A_(b))', '<p><a href="https://en.wikipedia.org/wiki/A_(b)" class="external" rel="noopener noreferrer">wiki</a></p>'],
    ['[here](#My Heading)', '<p>[here](#My Heading)</p>'],
    ['[here](#My%20Heading)', '<p><a href="#My-Heading" class="internal">here</a></p>'],
    ['[blk](#^b1)', '<p><a href="#^b1" class="internal">blk</a></p>'],
    ['[n](My%20Note.md)', '<p><a href="My%20Note.md.html" class="internal">n</a></p>'],
    ['[n](<My Note.md#Part Two>)', '<p><a href="My%20Note.md.html#Part-Two" class="internal">n</a></p>'],
    ['[gone](missing.md)', '<p><span class="unresolved">gone</span></p>'],
    ['[*em* text](https://a.com)', '<p><a href="https://a.com" class="external" rel="noopener noreferrer"><em>em</em> text</a></p>'],
    // No link inside a link: the outer brackets are text, and the address after them a bare URL, as GFM has it.
    ['[outer [inner](https://b.com)](https://a.com)', '<p>[outer <a href="https://b.com" class="external" rel="noopener noreferrer">inner</a>](<a href="https://a.com" class="external" rel="noopener noreferrer">https://a.com</a>)</p>'],
    ['[a [[Note]] b](https://a.com)', '<p><a href="https://a.com" class="external" rel="noopener noreferrer">a Note b</a></p>'],
    ['[![pic](a.png)](https://a.com)', '<p><a href="https://a.com" class="external" rel="noopener noreferrer"><img src="files/a.png" alt="pic" loading="lazy"></a></p>'],
  ]);
  renders([
    ['[no address]', '<p>[no address]</p>'],
    ['[empty]()', '<p>empty</p>'],
    ['[spaces](a b)', '<p>[spaces](a b)</p>'],
    ['[unclosed](https://a.com', '<p>[unclosed](<a href="https://a.com" class="external" rel="noopener noreferrer">https://a.com</a></p>'],
    ['[ftp](ftp://a.com)', '<p>ftp</p>'],
  ]);
});

test('autolinks: <https://…> and bare URLs, without trailing punctuation', () => {
  const a = (u: string, text = u) => `<a href="${u}" class="external" rel="noopener noreferrer">${text}</a>`;
  renders([
    ['<https://a.com/x>', `<p>${a('https://a.com/x')}</p>`],
    ['<mailto:a@b.c>', `<p>${a('mailto:a@b.c')}</p>`],
    ['See https://a.com/page.', `<p>See ${a('https://a.com/page')}.</p>`],
    ['(see https://a.com/x)', `<p>(see ${a('https://a.com/x')})</p>`],
    ['https://en.wikipedia.org/wiki/A_(b), next', `<p>${a('https://en.wikipedia.org/wiki/A_(b)')}, next</p>`],
    ['http://a.com/x_y_z?q=1!', `<p>${a('http://a.com/x_y_z?q=1')}!</p>`],
    ['**https://a.com**', `<p><strong>${a('https://a.com')}</strong></p>`],
    ['https://a.com/a&b', `<p>${a('https://a.com/a&amp;b', 'https://a.com/a&amp;b')}</p>`],
  ]);
  renders([
    ['xhttps://a.com', '<p>xhttps://a.com</p>'],
    ['https://', '<p>https://</p>'],
    ['https://.', '<p>https://.</p>'],
    ['<javascript:alert(1)>', '<p>&lt;javascript:alert(1)&gt;</p>'],
    ['ftp://a.com', '<p>ftp://a.com</p>'],
  ]);
});

test('embeds: each kind, sizes, alt text, fragments, and nothing for what is not on the site', () => {
  renders([
    ['![[a.png]]', '<p><img src="files/a.png" alt="a.png" loading="lazy"></p>'],
    ['![[pics/a.png|300]]', '<p><img src="files/pics/a.png" alt="a.png" width="300" loading="lazy"></p>'],
    ['![[a.png|300x200]]', '<p><img src="files/a.png" alt="a.png" width="300" height="200" loading="lazy"></p>'],
    ['![[a.png|A "quoted" alt]]', '<p><img src="files/a.png" alt="A &quot;quoted&quot; alt" loading="lazy"></p>'],
    ['![[a.png|alt|120]]', '<p><img src="files/a.png" alt="alt" width="120" loading="lazy"></p>'],
    ['![[song.mp3]]', '<p><audio controls src="files/song.mp3"></audio></p>'],
    ['![[clip.mp4]]', '<p><video controls src="files/clip.mp4"></video></p>'],
    ['![[docs/paper.pdf]]', '<p><a href="files/docs/paper.pdf" class="internal">paper.pdf</a></p>'],
    ['![[paper.pdf#page=3]]', '<p><a href="files/paper.pdf#page=3" class="internal">paper.pdf</a></p>'],
    ['![[Other note]]', '<p><a href="Other%20note.html" class="internal embed">Other note (title)</a></p>'],
    ['![[Other#Part]]', '<p><a href="Other.html#Part" class="internal embed">Other (title)</a></p>'],
    ['![alt](a.png)', '<p><img src="files/a.png" alt="alt" loading="lazy"></p>'],
    ['![alt|250](a.png)', '<p><img src="files/a.png" alt="alt" width="250" loading="lazy"></p>'],
    ['![*rich* alt](a%20b.png)', '<p><img src="files/a%20b.png" alt="rich alt" loading="lazy"></p>'],
    ['![web](https://example.com/p.png)', '<p><img src="https://example.com/p.png" alt="web" loading="lazy"></p>'],
    ['![web|100x50](https://example.com/p.png)', '<p><img src="https://example.com/p.png" alt="web" width="100" height="50" loading="lazy"></p>'],
  ]);
  renders([
    ['![[missing.png]]', '<p></p>'],
    ['![gone](missing.png)', '<p></p>'],
    ['![mail](mailto:a@b.c)', '<p></p>'],
    ['![[#heading]]', '<p></p>'],
    ['![not an image]', '<p>![not an image]</p>'],
  ]);
});

test('tags: #tag after a space or at the start, letters in any script, not all digits', () => {
  renders([
    ['#tag #nested/tag #with-dash_and_underscore', '<p><span class="tag">#tag</span> <span class="tag">#nested/tag</span> <span class="tag">#with-dash_and_underscore</span></p>'],
    ['#日本語 #café #1a', '<p><span class="tag">#日本語</span> <span class="tag">#café</span> <span class="tag">#1a</span></p>'],
    ['text #tag, more', '<p>text <span class="tag">#tag</span>, more</p>'],
  ]);
  renders([
    ['#123', '<p>#123</p>'],
    ['C#sharp', '<p>C#sharp</p>'],
    ['# heading', '<h1 id="heading">heading</h1>'],
    ['#', '<h1 id="section"></h1>'],
    ['`#code`', '<p><code>#code</code></p>'],
  ]);
});

// Safety.

/** Every element in `out` is one the renderer writes, with only its own attributes, none leading to a script. */
function safe(out: string, md: string) {
  const tags = new Set(['p', 'a', 'img', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'input', 'blockquote', 'div', 'details', 'summary', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'em', 'strong', 'del', 'mark', 'sup', 'sub', 'kbd', 'u', 's', 'ins', 'small', 'b', 'i', 'abbr', 'center', 'audio', 'video', 'section']);
  const attrs = new Set(['href', 'src', 'alt', 'class', 'id', 'rel', 'title', 'width', 'height', 'loading', 'start', 'type', 'checked', 'disabled', 'controls', 'open', 'data-callout']);
  for (const [tag, name, rest] of out.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/g)) {
    assert.ok(tags.has(name), `${md}: <${name}> in ${out}`);
    for (const [, attr, value = ''] of rest.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)) {
      assert.ok(attrs.has(attr), `${md}: ${attr} in ${tag}`);
      if (attr === 'href' || attr === 'src') assert.ok(!/^\s*(?:javascript|data|vbscript|file|obsidian):/i.test(value.replace(/&[^;]+;|[\u0000- ]/g, '')), `${md}: ${tag}`);
    }
  }
  // A `<` the renderer did not write is always escaped, so nothing else can open a tag.
  assert.equal(out.replace(/<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>/g, '').includes('<'), false, `${md}: ${out}`);
}

test('safety: no executable URL in any link or image, whatever its spelling', () => {
  for (const md of [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x]( javascript:alert(1))',
    '[x](<javascript:alert(1)>)',
    '[x](java\tscript:alert(1))',
    '[x](java\nscript:alert(1))',
    '[x](javascript&colon;alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](\\javascript:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox)',
    '[x](obsidian://open?vault=x)',
    '[x](file:///etc/passwd)',
    '![x](javascript:alert(1))',
    '![x](data:image/png;base64,AAAA)',
    '![[javascript:alert(1)]]',
    '<javascript:alert(1)>',
    '<data:text/html,x>',
    'javascript:alert(1)',
  ])
    safe(html(md), md);
  // The vault hooks get whatever has no scheme; a site that links it as given must still be safe.
  const naive: RenderHooks = { link: (t) => ({ href: encodeURI(t) }), embed: (t) => ({ href: encodeURI(t), kind: 'image' }) };
  for (const md of ['[x](javascript&colon;alert(1))', '[x](javascript%3Aalert(1))', '[[javascript:alert(1)]]']) assert.ok(!html(md, naive).includes('href="javascript:'), md);
  renders([
    ['[x](javascript:alert(1))', '<p>x</p>'],
    ['[x](JaVaScRiPt:alert(1))', '<p>x</p>'],
    ['[x]( javascript:alert(1))', '<p>x</p>'],
    ['[x](data:text/html,hi)', '<p>x</p>'],
    ['[x](javascript&colon;alert(1))', '<p>x</p>'],
    ['![x](javascript:alert(1))', '<p></p>'],
    ['![x](data:image/png;base64,AAAA)', '<p></p>'],
  ]);
});

test('safety: no executable tag or handler from raw HTML, headings, aliases or info strings', () => {
  renders([
    ['<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
    ['<img src=x onerror=alert(1)>', '<p>&lt;img src=x onerror=alert(1)&gt;</p>'],
    ['<div onclick="x">hi</div>', '<div>hi</div>'],
    ['<span onmouseover=alert(1)>x</span>', '<p><span>x</span></p>'],
    ['<a href="javascript:alert(1)">x</a>', '<p>&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;</p>'],
    ['# Title <script>alert(1)</script>', '<h1 id="Title-scriptalert(1)/script">Title &lt;script&gt;alert(1)&lt;/script&gt;</h1>'],
    ['[[Note|"><script>alert(1)</script>]]', '<p><a href="Note.html" class="internal">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a></p>'],
    ['[[x"onmouseover="alert(1)]]', '<p><a href="x%22onmouseover=%22alert(1).html" class="internal">x&quot;onmouseover=&quot;alert(1)</a></p>'],
    ['```js" onclick="alert(1)\ncode\n```', '<pre><code class="language-js">code</code></pre>'],
    ['```"><script>\ncode\n```', '<pre><code>code</code></pre>'],
    ['<scr<script>ipt>alert(1)</script>', '<p>&lt;scr&lt;script&gt;ipt&gt;alert(1)&lt;/script&gt;</p>'],
    ['<SCRIPT SRC=//x.js></SCRIPT>', '<p>&lt;SCRIPT SRC=//x.js&gt;&lt;/SCRIPT&gt;</p>'],
    ['<svg onload=alert(1)>', '<p>&lt;svg onload=alert(1)&gt;</p>'],
    ['<iframe srcdoc="<script>alert(1)</script>">', '<p>&lt;iframe srcdoc=&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;</p>'],
    ['![[a.png|x" onerror="alert(1)]]', '<p><img src="files/a.png" alt="x&quot; onerror=&quot;alert(1)" loading="lazy"></p>'],
    ['[x](https://a.com "t\\" onmouseover=\\"alert(1)")', '<p><a href="https://a.com" class="external" rel="noopener noreferrer" title="t&quot; onmouseover=&quot;alert(1)">x</a></p>'],
    ['[x](https://a.com/"onmouseover="alert(1))', '<p><a href="https://a.com/%22onmouseover=%22alert(1)" class="external" rel="noopener noreferrer">x</a></p>'],
    ['<p style="background:url(javascript:alert(1))">x</p>', '<p>x</p>'],
    ['> [!note] <img src=x onerror=alert(1)>', '<div class="callout" data-callout="note">\n<div class="callout-title">&lt;img src=x onerror=alert(1)&gt;</div>\n<div class="callout-content"></div>\n</div>'],
    ['| <script> | b |\n|---|---|', '<table>\n<thead>\n<tr><th>&lt;script&gt;</th><th>b</th></tr>\n</thead>\n</table>'],
    ['#<script>', '<p>#&lt;script&gt;</p>'],
  ]);
  const everything = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<div onclick="x">', '<a href="javascript:alert(1)">x</a>', '# <script>alert(1)</script>',
    '[[Note|"><script>alert(1)</script>]]', '```js" onclick="x\ncode\n```', '<math><mi xlink:href="javascript:alert(1)">', '<details open ontoggle=alert(1)>',
    '<object data="javascript:alert(1)">', '<form action="javascript:alert(1)"><button>x</button></form>', '<base href="javascript:/">', '<meta http-equiv="refresh">',
    '<link rel=import href=x>', '<!--><script>alert(1)</script>-->', '<![CDATA[<script>]]>', '<?xml ?>', '<!DOCTYPE html>', '<p/onclick=alert(1)>x',
  ].join('\n\n');
  safe(html(everything), everything);
});

test('escapeHtml: & < > " \' all replaced', () => {
  assert.equal(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
  assert.equal(escapeHtml('plain'), 'plain');
});

// Hooks.

test('hooks: called with the target as written, decoded, without fragment or alias', () => {
  const calls: Calls = { link: [], embed: [] };
  renderMarkdown(
    [
      '[[Plain]] [[With Alias|shown]] [[Head#Section]] [[Deep#A#B|x]] [[Block#^b1]] [[#Local]] [[ Spaced ]]',
      '[md](Some%20Note.md#Part) [md2](<Other Note.md>) [web](https://a.com) [page](#Top) [bad](%E0%A4%A)',
      '![[pic.png|300]] ![[Embedded#Part|alias]] ![img](folder/my%20pic.png#x) ![web](https://a.com/p.png)',
      '| [[Table\\|alias]] |\n|---|',
    ].join('\n\n'),
    site(calls),
  );
  assert.deepEqual(calls.link, ['Plain', 'With Alias', 'Head', 'Deep', 'Block', 'Spaced', 'Some Note.md', 'Other Note.md', '%E0%A4%A', 'Table']);
  assert.deepEqual(calls.embed, ['pic.png', 'Embedded', 'folder/my pic.png']);
});

test('hooks: a link the caller does not know is text, an embed it does not know is nothing', () => {
  const none: RenderHooks = { link: () => null, embed: () => null };
  assert.equal(html('[[Note]] [text](note.md) ![[a.png]] ![x](a.png) [[#Local]]', none), '<p><span class="unresolved">Note</span> <span class="unresolved">text</span>   <a href="#Local" class="internal">Local</a></p>');
  // The caller's href is trusted to be safe, and still escaped as an attribute.
  const odd: RenderHooks = { link: () => ({ href: 'a"b<c.html' }), embed: () => ({ href: 'p"q.png', kind: 'image' }) };
  assert.equal(html('[[x]] ![[y.png]]', odd), '<p><a href="a&quot;b&lt;c.html" class="internal">x</a> <img src="p&quot;q.png" alt="y.png" loading="lazy"></p>');
  // A relative path whose first part holds a colon would read as a scheme: it gets ./ before it.
  const colon: RenderHooks = { link: (t) => ({ href: `${t}.html` }), embed: (t) => ({ href: t, kind: 'image' }) };
  assert.equal(html('[[javascript:alert(1)]] [[a/b:c]] ![[x:y.png]]', colon), '<p><a href="./javascript:alert(1).html" class="internal">javascript:alert(1)</a> <a href="a/b:c.html" class="internal">a/b:c</a> <img src="./x:y.png" alt="x:y.png" loading="lazy"></p>');
});

test('hooks: a note embed shows its title, or its target when the caller gives none', () => {
  const hooks: RenderHooks = { link: () => null, embed: () => ({ href: 'n.html', kind: 'note' }) };
  assert.equal(html('![[Some note]] ![[Other|Alias]]', hooks), '<p><a href="n.html" class="internal embed">Some note</a> <a href="n.html" class="internal embed">Alias</a></p>');
});

// Input forms and determinism.

test('CRLF and a byte order mark render as LF does', () => {
  const md = '# Title\n\nPara one\nline two\n\n- a\n  - b\n\n```js\nx\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!note] T\n> body %%secret\n> more%%\n\nText[^1]\n\n[^1]: Note\n';
  const lf = renderMarkdown(md, site());
  assert.deepEqual(renderMarkdown(md.replace(/\n/g, '\r\n'), site()), lf);
  assert.deepEqual(renderMarkdown(`\uFEFF${md}`, site()), lf);
  assert.deepEqual(renderMarkdown(md.replace(/\n/g, '\r'), site()), lf);
});

test('the same note renders to the same string every time', () => {
  const md = '# A\n\n## A\n\nText[^n] ^[inline] [[Link]] ![[a.png]] #tag\n\n[^n]: Note\n\n- [ ] task ^id\n\n| x |\n|---|\n| y |';
  const first = renderMarkdown(md, site());
  for (let i = 0; i < 3; i++) assert.deepEqual(renderMarkdown(md, site()), first);
});

// Any input: no throw, no hang, no stack overflow.

test('pathological input renders quickly and without throwing', () => {
  const big = 'word '.repeat(100_000);
  for (const [name, md] of [
    ['50,000 *', '*'.repeat(50_000)],
    ['50,000 * between words', 'a* '.repeat(50_000)],
    ['50,000 [', '['.repeat(50_000)],
    ['50,000 [ with ](', '[a](b'.repeat(50_000)],
    ['50,000 ![[', '![['.repeat(50_000)],
    ['20,000 nested >', `${'>'.repeat(20_000)} deep`],
    ['20,000 lines of growing quotes', Array.from({ length: 2000 }, (_, i) => '> '.repeat(i % 100) + 'x').join('\n')],
    ['20,000 nested list items', Array.from({ length: 20_000 }, (_, i) => `${' '.repeat(i * 2 % 400)}- item`).join('\n')],
    ['a 500 KB paragraph', big],
    ['5,000 unclosed `', '`'.repeat(5000)],
    ['5,000 runs of growing `', Array.from({ length: 300 }, (_, i) => '`'.repeat(i + 1)).join(' x ')],
    ['5,000 ` between words', 'a ` '.repeat(5000)],
    ['many $', '$a '.repeat(50_000)],
    ['many <', '<a b="'.repeat(30_000)],
    ['many tags', '<b>'.repeat(30_000) + '</i>'.repeat(30_000)],
    ['many %%', 'a %% '.repeat(50_000)],
    ['many <!--', '<!-- '.repeat(50_000)],
    ['many ^[', '^['.repeat(50_000)],
    ['many _', 'a_b_'.repeat(50_000)],
    ['many ~~ and ==', '~~a=='.repeat(50_000)],
    ['many URLs', 'http://(http://('.repeat(20_000)],
    ['many entities', '&amp'.repeat(50_000)],
    ['many headings', '# A\n'.repeat(20_000)],
    ['many table rows', `| a | b |\n|---|---|\n${'| `x | [[y | z\n'.repeat(20_000)}`],
    ['many footnotes', Array.from({ length: 5000 }, (_, i) => `x[^${i}]`).join(' ') + '\n\n' + Array.from({ length: 5000 }, (_, i) => `[^${i}]: n${i}`).join('\n')],
    ['many comment cuts', 'text %%a%%\n'.repeat(20_000)],
  ] as [string, string][]) {
    const start = performance.now();
    const r = renderMarkdown(md, site());
    const ms = performance.now() - start;
    assert.equal(typeof r.html, 'string', name);
    assert.ok(ms < 2000, `${name}: ${Math.round(ms)} ms`);
  }
});

test('random notes: no throw, every tag balanced and the renderer\'s own, no comment outside code', () => {
  // Pieces of Markdown joined at random. No lone `%` or `<`: next to an element the renderer drops, either would read as
  // a marker in the output that was none in the note.
  const pieces = ['*', '**', '_', '~~', '==', '`', '``', '```', '~~~', '$', '$$', '%%', '<!--', '-->', '[', ']', '(', ')', '[[', ']]', '![[', '|', '\\|', '#', '# ', '> ', '- ', '1. ', '- [ ] ', '[^1]', '[^1]: ', '^[', ' ^b-1', '\n', '\n', '\n\n', '  ', '    ', '\t', 'a', 'word', ' ', '<b>', '</b>', '<i>', '</i>', '<div>', '</div>', '<span x="y">', '<script>', '<br>', '<p>', '<details>', '&amp;', '&', 'https://x.y/z', '<https://a.b>', '| a | b |', '|---|---|', '---', '> [!note] T', '> [!tip]- ', '](https://e.com)', '](note.md)', '](javascript:x)', '!', '^', '\\', '>'];
  const hooks: RenderHooks = {
    link: (t) => (t.length % 3 ? { href: `${encodeURIComponent(t)}.html` } : null),
    embed: (t) => (t.length % 4 ? { href: encodeURIComponent(t), kind: (['image', 'audio', 'video', 'pdf', 'note'] as const)[t.length % 5], title: t } : null),
  };
  const ours = /^(?:p|a|img|code|pre|h[1-6]|ul|ol|li|input|blockquote|div|details|summary|span|table|thead|tbody|tr|th|td|hr|br|em|strong|del|mark|sup|sub|kbd|u|s|ins|small|b|i|abbr|center|audio|video|section)$/;
  let seed = 7;
  const pick = () => pieces[((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 8) % pieces.length];
  for (let k = 0; k < 4000; k++) {
    let md = '';
    for (let j = 0, len = 1 + (k % 60); j < len; j++) md += pick();
    const out = renderMarkdown(md, hooks).html;
    const open: string[] = [];
    for (const [tag, close, name] of out.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/g)) {
      assert.match(name, ours, `${JSON.stringify(md)}: ${tag}`);
      if (name === 'br' || name === 'hr' || name === 'img' || name === 'input') continue;
      if (!close) open.push(name);
      else assert.equal(open.pop(), name, `${JSON.stringify(md)}: ${out}`);
    }
    assert.deepEqual(open, [], `${JSON.stringify(md)}: ${out}`);
    const shown = out.replace(/<pre[^>]*>[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>| alt="[^"]*"/g, '');
    assert.ok(!shown.includes('%%') && !shown.includes('&lt;!--'), `${JSON.stringify(md)}: ${out}`);
  }
});

test('nesting deeper than the cap is text', () => {
  const out = html(`${'> '.repeat(40)}deep`);
  assert.equal(out.split('<blockquote>').length - 1, 32);
  assert.ok(out.includes('&gt; &gt; &gt; &gt; &gt; &gt; &gt; &gt; deep'));
  const list = html(Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n'));
  assert.equal(list.split('<li>').length - 1, 32);
  assert.ok(list.includes('- level 39'));
});
