// A note's body as HTML for a published site: what Obsidian's reading view shows for the common cases. CommonMark's
// usual blocks and inline syntax, with Obsidian's wikilinks, embeds, callouts, tags, highlights, comments, footnotes,
// math and block ids. Nothing of Obsidian or Node is used, so it runs the same in both.
//
// What a page reveals is decided here. Text is always escaped; raw HTML keeps only a short list of harmless tags, never
// their attributes; a link leads to the web over a few schemes, or where the caller's hooks say. Comments, `%%…%%` and
// `<!-- … -->`, never reach the page. Every step is linear in the note's size and nesting is capped, so no note can
// hang the renderer or overflow its stack.
import { hasControl, withoutControls } from '../core/text.ts';

/** Where a link or an embed leads on the site, decided by the caller. */
export interface RenderHooks {
  /**
   * A link to a file of the vault: a wikilink `[[target]]`, or a Markdown link `[text](target)` whose address has no
   * scheme. `target` is the path part as written, percent-decoded for Markdown links, without `#fragment` and without
   * `|alias`; never empty. Returns the address to link to (already safe to put in an href: relative and percent-encoded),
   * or null when the link leads to nothing on the site: the text is then shown without a link.
   */
  link(target: string): { href: string } | null;
  /**
   * A file shown inside the note: `![[target]]` or `![alt](target)` without a scheme. Same `target` rule as `link`.
   * Returns where it is on the site and what kind it is, or null when it is not on the site: nothing is shown then.
   * `title` is given for kind 'note': the note's title, shown as the link text.
   */
  embed(target: string): { href: string; kind: 'image' | 'audio' | 'video' | 'pdf' | 'note'; title?: string } | null;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface Rendered {
  /** The body as HTML: block elements only, no <html> or <body>. */
  html: string;
  /** Every heading in order, with the id its element carries. `text` is plain text (no tags, entities decoded), each run of whitespace one space, none at either end. */
  headings: Heading[];
  /** True when the first block of the note is a level-1 heading. */
  startsWithH1: boolean;
}

/** How deeply quotes, list items and footnotes go inside one another; a marker deeper than this is text. */
const MAX_DEPTH = 32;
/** The most link brackets open at once; more are text. Bounds how deeply links, images and inline footnotes nest. */
const MAX_BRACKETS = 32;
/** Rounds of cutting comments out and reading the note again before falling back to cutting them out blind. */
const MAX_ROUNDS = 8;
/** Raw HTML tags a note may use. They pass without their attributes; any other tag is shown as text. */
const ALLOWED_TAGS = new Set(['br', 'hr', 'kbd', 'sub', 'sup', 'u', 's', 'del', 'ins', 'mark', 'small', 'b', 'i', 'em', 'strong', 'abbr', 'details', 'summary', 'div', 'span', 'p', 'center']);
const VOID_TAGS = new Set(['br', 'hr']);
/** The schemes a link may lead to. An image loads only over http and https. */
const SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` with `& < > " '` replaced so it can go into HTML text or a quoted attribute. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * The id a heading gets, and the fragment a link to it uses: its plain text without the characters a fragment or an
 * attribute can not carry safely (`" ' < > & # % \`` and control characters), trimmed, each run of spaces made one
 * `-`; letter case kept. 'section' when nothing is left.
 */
export function headingId(text: string): string {
  return (
    withoutControls(text.replace(/\s+/g, ' '), true)
      .replace(/["'<>&#%`]/g, '')
      .trim()
      .replace(/ +/g, '-') || 'section'
  );
}

/** Renders a note's body (its text after the properties block, which the caller has removed). */
export function renderMarkdown(body: string, hooks: RenderHooks): Rendered {
  const src = body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replaceAll('\u0000', '\uFFFD');
  const doc = visibleBlocks(src);
  const defs = new Map<string, Block>();
  collectDefs(doc, defs);
  const ctx: Ctx = { hooks, defs, labels: new Set(defs.keys()), ids: new Set(), idNext: new Map(), headings: [], numbers: new Map(), refs: new Map(), notes: [] };
  const html = renderBlocks(doc.kids, ctx) + footnotes(ctx);
  const first = doc.kids.find((b) => b.kind !== 'fndef');
  return { html, headings: ctx.headings, startsWithH1: first?.kind === 'heading' && first.level === 1 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks. A line at a time, as CommonMark reads them: the containers a line continues (quotes, list items, footnote
// definitions), the ones it opens, then the leaf it adds to or starts. Quotes take no lazy lines: each line needs its `>`.

type Kind = 'doc' | 'quote' | 'list' | 'item' | 'fndef' | 'para' | 'heading' | 'code' | 'math' | 'table' | 'hr' | 'html';

/** Part of one line of the note: its text, and where it starts in the note, so a comment found in it can be cut there. */
interface Seg {
  s: string;
  at: number;
}

interface Block {
  kind: Kind;
  parent: Block | null;
  kids: Block[];
  open: boolean;
  /** Quotes, list items and footnote definitions around it, itself included. */
  depth: number;
  /** Its first and last line, which tell a loose list from a tight one. */
  first: number;
  last: number;
  /** A block id, `^abc`, written at its end or alone on the line after it. */
  id?: string;
  /** Its text, a piece per line: paragraphs, headings and HTML blocks. */
  segs: Seg[];
  /** Code and math: the lines inside. */
  lines: string[];
  level?: number;
  /** Code: the opening fence, its info string, and the indentation taken off its lines. */
  fence?: string;
  info?: string;
  indent?: number;
  /** List item: how far its lines must be indented to stay in it (`indent`), and the column its text starts at. */
  content?: number;
  /** List item: the character between `[ ]` of a task. */
  task?: string;
  ordered?: boolean;
  start?: number;
  bullet?: string;
  loose?: boolean;
  callout?: { type: string; fold: string; title: Seg | null };
  align?: string[];
  head?: Seg[];
  rows?: Seg[][];
  label?: string;
}

const CONTAINERS = new Set<Kind>(['doc', 'quote', 'list', 'item', 'fndef']);
const HEADING = /^(#{1,6})(?=[ \t]|$)/;
const HR = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const HTML_BLOCK = /^<\/?(?:div|p|details|summary|center|hr)(?=[ \t/>]|$)/i;
const CALLOUT = /^\[!([^\]]*)\]([+-]?)(.*)$/;
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:/;
const TASK = /^\[([^\]])\](?=[ \t]|$)/;
const BLOCK_ID = /(?:^|[ \t])\^([A-Za-z0-9-]+)$/;

function newBlock(kind: Kind, parent: Block | null, line: number): Block {
  const depth = (parent?.depth ?? 0) + (kind === 'quote' || kind === 'item' || kind === 'fndef' ? 1 : 0);
  return { kind, parent, kids: [], open: true, depth, first: line, last: line, segs: [], lines: [] };
}

const lastOpen = (b: Block): Block | undefined => {
  const k = b.kids[b.kids.length - 1];
  return k?.open ? k : undefined;
};

const isSpace = (c: string | undefined) => c === ' ' || c === '\t';

/** How many columns of spaces and tabs (tab stops of 4) start at `p`, where the column is `col`, and where they end. */
function indentAt(line: string, p: number, col: number): { cols: number; end: number } {
  let c = col;
  let i = p;
  for (; isSpace(line[i]); i++) c += line[i] === '\t' ? 4 - (c % 4) : 1;
  return { cols: c - col, end: i };
}

/** Skips up to `n` columns of spaces and tabs; a tab that goes past them is taken whole. */
function skipCols(line: string, p: number, col: number, n: number): [number, number] {
  const stop = col + n;
  for (; col < stop && isSpace(line[p]); p++) col += line[p] === '\t' ? 4 - (col % 4) : 1;
  return [p, col];
}

function parseBlocks(src: string): Block {
  const doc = newBlock('doc', null, 0);
  const lines = src.split('\n');
  let at = 0;
  for (let li = 0; li < lines.length; li++) {
    parseLine(doc, lines[li], at, li);
    at += lines[li].length + 1;
  }
  close(doc);
  return doc;
}

/** Adds a new block as the last under `parent`, closing what was open there; a list holds only items. */
function add(parent: Block, kind: Kind, line: number): Block {
  let p = parent;
  while (p.kind === 'list' && kind !== 'item') {
    close(p);
    p = p.parent!;
  }
  const open = lastOpen(p);
  if (open) close(open);
  const b = newBlock(kind, p, line);
  p.kids.push(b);
  return b;
}

function close(b: Block): void {
  if (!b.open) return;
  const k = lastOpen(b);
  if (k) close(k);
  b.open = false;
  if (b.kind === 'para') finishPara(b);
  for (const kid of b.kids) if (kid.last > b.last) b.last = kid.last;
  if (b.kind === 'list') b.loose = b.kids.some((it, i) => (i > 0 && it.first > b.kids[i - 1].last + 1) || it.kids.some((k2, j) => j > 0 && k2.first > it.kids[j - 1].last + 1));
}

/**
 * A block id at the end of a paragraph becomes its id. A paragraph holding only one gives it to the block before it,
 * as Obsidian does for a table, a list or a quote, and is dropped.
 */
function finishPara(p: Block): void {
  const last = p.segs[p.segs.length - 1];
  const m = last && BLOCK_ID.exec(last.s);
  if (!m) return;
  const id = `^${m[1]}`;
  const keep = last.s.slice(0, m.index).trimEnd();
  if (keep) p.segs[p.segs.length - 1] = { s: keep, at: last.at };
  else p.segs.pop();
  if (p.segs.length) {
    p.id = id;
    return;
  }
  const siblings = p.parent!.kids;
  siblings.pop();
  const before = siblings[siblings.length - 1];
  if (before && !before.id && before.kind !== 'heading' && before.kind !== 'fndef') before.id = id;
}

/** Where the open container `b` lets `line` go on inside it, after its marker or indentation; null when it ends `b`. */
function continues(b: Block, line: string, p: number, col: number): [number, number] | null {
  const { cols, end } = indentAt(line, p, col);
  const blank = end >= line.length;
  if (b.kind === 'quote') {
    if (blank || cols > 3 || line[end] !== '>') return null;
    let q = end + 1;
    let c = col + cols + 1;
    if (isSpace(line[q])) c += line[q++] === '\t' ? 4 - (c % 4) : 1;
    return [q, c];
  }
  // A list item or footnote goes on over blank lines once it holds something, and over lines indented under it.
  if (blank) return b.kids.length ? [end, col + cols] : null;
  const need = b.kind === 'item' ? b.indent! : 4;
  if (cols < need) return null;
  return skipCols(line, p, col, Math.min(cols, b.kind === 'item' ? b.content! : 4));
}

/** The list marker at `i`: `-`, `+`, `*`, or up to 9 digits and `.` or `)`, followed by a space, a tab or the line's end. */
function listMarker(line: string, i: number): { ordered: boolean; bullet: string; start: number; end: number } | null {
  const c = line[i];
  if (c === '-' || c === '+' || c === '*') return isSpace(line[i + 1]) || i + 1 === line.length ? { ordered: false, bullet: c, start: 1, end: i + 1 } : null;
  let j = i;
  while (j - i < 9 && line[j] >= '0' && line[j] <= '9') j++;
  if (j === i || (line[j] !== '.' && line[j] !== ')')) return null;
  if (!isSpace(line[j + 1]) && j + 1 !== line.length) return null;
  return { ordered: true, bullet: line[j], start: parseInt(line.slice(i, j), 10), end: j + 1 };
}

/** Whether the text of a line, indented `cols`, starts a block other than a paragraph, so a paragraph does not take it. */
function startsLeaf(rest: string, cols: number): boolean {
  if (isFence(rest)) return true;
  if (cols > 3) return false;
  return !!mathOpen(rest) || HEADING.test(rest) || HR.test(rest) || HTML_BLOCK.test(rest);
}

function isFence(rest: string): RegExpExecArray | null {
  const f = FENCE.exec(rest);
  return f && !(f[1][0] === '`' && f[2].includes('`')) ? f : null;
}

/** A math block opened by `$$` at the start of a line: its first content, and whether `$$` closes it on the same line. */
function mathOpen(rest: string): { body: string; closed: boolean } | null {
  if (!rest.startsWith('$$')) return null;
  const after = rest.slice(2);
  const k = after.indexOf('$$');
  if (k < 0) return { body: after, closed: false };
  // `$$a$$ and more` is a paragraph with math in it.
  return after.slice(k + 2).trim() ? null : { body: after.slice(0, k), closed: true };
}

function parseLine(doc: Block, line: string, at: number, li: number): void {
  let p = 0;
  let col = 0;
  let c = doc;
  let all = true;
  for (let k = lastOpen(c); k && CONTAINERS.has(k.kind); k = lastOpen(c)) {
    if (k.kind !== 'list') {
      const r = continues(k, line, p, col);
      if (!r) {
        all = false;
        break;
      }
      [p, col] = r;
    }
    c = k;
  }
  let tip = c;
  for (let k = lastOpen(tip); k; k = lastOpen(tip)) tip = k;
  if (all && (tip.kind === 'code' || tip.kind === 'math')) {
    codeLine(tip, line, p, col, li);
    return;
  }

  // A delimiter row under a paragraph's last line makes that line a table's header.
  if (all && tip.kind === 'para' && tableStart(tip, line, p, col, li)) return;

  let opened = false;
  const closeUnmatched = () => {
    if (opened) return;
    opened = true;
    const k = lastOpen(c);
    if (k && !all) close(k);
  };
  while (c.depth < MAX_DEPTH) {
    const { cols, end } = indentAt(line, p, col);
    if (end >= line.length) break;
    if (cols <= 3 && line[end] === '>') {
      closeUnmatched();
      c = add(c, 'quote', li);
      p = end + 1;
      col += cols + 1;
      if (isSpace(line[p])) col += line[p++] === '\t' ? 4 - (col % 4) : 1;
      if (calloutStart(c, line, p, at)) return;
      continue;
    }
    const m = listMarker(line, end);
    if (m && !(cols <= 3 && HR.test(line.slice(end)))) {
      const sameList = c.kind === 'list' && c.ordered === m.ordered && c.bullet === m.bullet;
      // A list can break into a paragraph it would otherwise continue only with a bullet or 1, and text after the marker.
      const interrupts = !opened && tip.kind === 'para' && !sameList && (all || !quoteBetween(c, tip));
      if (!interrupts || ((!m.ordered || m.start === 1) && line.slice(m.end).trim())) {
        closeUnmatched();
        let list = c;
        if (!sameList) {
          if (c.kind === 'list') {
            close(c);
            c = c.parent!;
          }
          list = add(c, 'list', li);
          list.ordered = m.ordered;
          list.start = m.start;
          list.bullet = m.bullet;
        }
        const item = add(list, 'item', li);
        const width = m.end - end;
        const after = col + cols + width;
        const sp = indentAt(line, m.end, after);
        let pad = width + sp.cols;
        if (sp.end >= line.length || sp.cols >= 5) {
          pad = width + 1;
          [p, col] = sp.end >= line.length ? [sp.end, after + sp.cols] : skipCols(line, m.end, after, 1);
        } else [p, col] = [sp.end, after + sp.cols];
        item.indent = cols + 2;
        item.content = cols + pad;
        const t = TASK.exec(line.slice(p));
        if (t) {
          item.task = t[1];
          [p, col] = [p + 3, col + 3];
          const s = indentAt(line, p, col);
          [p, col] = [s.end, col + s.cols];
        }
        c = item;
        continue;
      }
    }
    if (cols <= 3 && line[end] === '[' && line[end + 1] === '^') {
      const f = FOOTNOTE_DEF.exec(line.slice(end));
      if (f && !hasMarker(f[1])) {
        closeUnmatched();
        c = add(c, 'fndef', li);
        c.label = f[1];
        p = end + f[0].length;
        col += cols + f[0].length;
        continue;
      }
    }
    break;
  }

  const { cols, end } = indentAt(line, p, col);
  if (end >= line.length) {
    // A blank line ends a paragraph, a table or HTML, and whatever it did not continue.
    const k = lastOpen(c);
    if (k) close(k);
    return;
  }
  const rest = line.slice(end);
  if (!all && !opened && tip.kind === 'para' && !startsLeaf(rest, cols) && !quoteBetween(c, tip)) {
    addSeg(tip, line, end, at, li);
    return;
  }
  closeUnmatched();
  const leaf = lastOpen(c);
  if (leaf?.kind === 'para' && !startsLeaf(rest, cols)) return addSeg(leaf, line, end, at, li);
  if (leaf?.kind === 'html') return addSeg(leaf, line, end, at, li);
  if (leaf?.kind === 'table' && !startsLeaf(rest, cols) && rest.includes('|')) {
    leaf.rows!.push(splitRow(line, end, at));
    leaf.last = li;
    return;
  }
  newLeaf(c, line, end, cols, at, li);
}

/** Whether a quote lies between container `c` and the paragraph `tip` inside it: a quote takes no lazy line. */
function quoteBetween(c: Block, tip: Block): boolean {
  for (let b = tip.parent; b && b !== c; b = b.parent) if (b.kind === 'quote') return true;
  return false;
}

/** Makes the quote `q`, opened on this line, a callout when the line is `[!type]`; true when it was. */
function calloutStart(q: Block, line: string, p: number, at: number): boolean {
  const m = CALLOUT.exec(line.slice(p));
  if (!m) return false;
  const type = m[1].toLowerCase();
  if (!/^[a-z0-9-]+$/.test(type)) return false;
  const from = p + m[0].length - m[3].length;
  const title: Seg = { s: m[3].trim(), at: at + from + (m[3].length - m[3].trimStart().length) };
  q.callout = { type, fold: m[2], title: title.s ? title : null };
  return true;
}

function newLeaf(c: Block, line: string, end: number, cols: number, at: number, li: number): void {
  const rest = line.slice(end);
  const f = isFence(rest);
  if (f) {
    const b = add(c, 'code', li);
    b.fence = f[1];
    b.info = f[2].trim();
    b.indent = cols;
    return;
  }
  if (cols <= 3) {
    const m = mathOpen(rest);
    if (m) {
      const b = add(c, 'math', li);
      if (m.body.trim()) b.lines.push(m.body);
      if (m.closed) close(b);
      return;
    }
    const h = HEADING.exec(rest);
    if (h) {
      const b = add(c, 'heading', li);
      b.level = h[1].length;
      b.segs.push(headingSeg(line, end + h[1].length, at));
      close(b);
      return;
    }
    if (HR.test(rest)) return close(add(c, 'hr', li));
    if (HTML_BLOCK.test(rest)) return addSeg(add(c, 'html', li), line, end, at, li);
  }
  addSeg(add(c, 'para', li), line, end, at, li);
}

function addSeg(b: Block, line: string, from: number, at: number, li: number): void {
  let s = from;
  while (isSpace(line[s])) s++;
  let e = line.length;
  while (e > s && isSpace(line[e - 1])) e--;
  b.segs.push({ s: line.slice(s, e), at: at + s });
  b.last = li;
}

/** A heading's text: without the spaces around it, the closing `#`s, or a block id. */
function headingSeg(line: string, from: number, at: number): Seg {
  let s = from;
  while (isSpace(line[s])) s++;
  let e = line.length;
  while (e > s && isSpace(line[e - 1])) e--;
  let h = e;
  while (h > s && line[h - 1] === '#') h--;
  if (h === s) e = s;
  else if (h < e && isSpace(line[h - 1])) for (e = h; e > s && isSpace(line[e - 1]); ) e--;
  const id = BLOCK_ID.exec(line.slice(s, e));
  if (id) for (e = s + id.index; e > s && isSpace(line[e - 1]); ) e--;
  return { s: line.slice(s, e), at: at + s };
}

function codeLine(b: Block, line: string, p: number, col: number, li: number): void {
  b.last = li;
  if (b.kind === 'math') {
    const t = line.slice(p).trimEnd();
    if (!t.endsWith('$$')) return void b.lines.push(line.slice(p));
    if (t.slice(0, -2).trim()) b.lines.push(t.slice(0, -2));
    return close(b);
  }
  const { cols, end } = indentAt(line, p, col);
  const f = /^(`{3,}|~{3,})[ \t]*$/.exec(line.slice(end));
  if (f && f[1][0] === b.fence![0] && f[1].length >= b.fence!.length && cols <= Math.max(3, b.indent!)) return close(b);
  b.lines.push(line.slice(skipCols(line, p, col, b.indent!)[0]));
}

/** Turns the paragraph's last line into a table's header when `line` is a delimiter row with as many cells; true when it did. */
function tableStart(para: Block, line: string, p: number, col: number, li: number): boolean {
  const { cols, end } = indentAt(line, p, col);
  const rest = line.slice(end);
  if (cols > 3 || !rest.includes('|') || !/^[ \t|:-]+$/.test(rest)) return false;
  const cells = rest.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => x.trim());
  if (!cells.every((x) => /^:?-+:?$/.test(x))) return false;
  const header = para.segs[para.segs.length - 1];
  const head = splitRow(header.s, 0, header.at);
  if (head.length !== cells.length) return false;
  para.segs.pop();
  const parent = para.parent!;
  if (para.segs.length) close(para);
  else {
    parent.kids.pop();
    para.open = false;
  }
  const t = add(parent, 'table', para.last);
  t.last = li;
  t.head = head;
  t.rows = [];
  t.align = cells.map((x) => (x.startsWith(':') ? (x.endsWith(':') ? 'center' : 'left') : x.endsWith(':') ? 'right' : ''));
  return true;
}

/**
 * The cells of a table row, trimmed, without the pipes at its ends. `\|` is a pipe in a cell; a pipe inside inline code
 * or a wikilink (`[[note|alias]]`, `[[note\|alias]]`) does not split one.
 */
function splitRow(line: string, from: number, at: number): Seg[] {
  let s = from;
  while (isSpace(line[s])) s++;
  let e = line.length;
  while (e > s && isSpace(line[e - 1])) e--;
  if (line[s] === '|') s++;
  const cells: Seg[] = [];
  const cut = (a: number, b: number) => {
    while (a < b && isSpace(line[a])) a++;
    while (b > a && isSpace(line[b - 1])) b--;
    cells.push({ s: line.slice(a, b), at: at + a });
  };
  const tick = backtickFinder(line);
  const wikiEnd = finder(line, ']]');
  let start = s;
  for (let i = s; i < e; ) {
    const ch = line[i];
    if (ch === '\\') i += 2;
    else if (ch === '`') {
      let j = i;
      while (line[j] === '`') j++;
      const k = tick(i, j - i);
      i = k >= 0 && k < e ? k + (j - i) : j;
    } else if (ch === '[' && line[i + 1] === '[' && wikiEnd(i + 2) < e) i = wikiEnd(i + 2) + 2;
    else {
      if (ch === '|') {
        cut(start, i);
        start = i + 1;
      }
      i++;
    }
  }
  if (start < e) cut(start, e);
  return cells;
}

/** A note's footnote definitions by label; the first of a label counts. */
function collectDefs(b: Block, defs: Map<string, Block>): void {
  if (b.kind === 'fndef' && !defs.has(b.label!)) defs.set(b.label!, b);
  for (const k of b.kids) collectDefs(k, defs);
}

// ---------------------------------------------------------------------------------------------------------------------
// Comments. Found by the same inline reading that renders the text, so code spans and math keep theirs; cut out of the
// note itself, from the opening marker to the closing one wherever it is (a comment hides the blocks it spans), or to
// the note's end when there is none. Cutting can change how the rest reads (a fence opened inside a comment is gone),
// so the note is read again until no comment is left in any text. That is what guarantees none reaches the page.

const NO_LABELS: ReadonlySet<string> = new Set();
const hasMarker = (s: string) => s.includes('%%') || s.includes('<!--');

function visibleBlocks(src: string): Block {
  let doc = parseBlocks(src);
  if (!hasMarker(src)) return doc;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const cuts = commentCuts(src, doc);
    if (!cuts.length) return doc;
    let kept = '';
    let from = 0;
    for (const [a, b] of cuts) {
      kept += src.slice(from, a);
      from = b;
    }
    src = kept + src.slice(from);
    doc = parseBlocks(src);
  }
  return parseBlocks(stripAll(src));
}

/** Where the comments in the note's text are, as [start, end) in `src`, in order; a line left holding nothing goes too. */
function commentCuts(src: string, doc: Block): [number, number][] {
  const texts: Seg[][] = [];
  textsOf(doc, texts);
  texts.sort((a, b) => a[0].at - b[0].at);
  const cuts: [number, number][] = [];
  let done = 0;
  for (const segs of texts) {
    const text = segs.map((g) => g.s).join('\n');
    if (!hasMarker(text)) continue;
    let seg = 0;
    let segStart = 0;
    for (const t of scan(text, NO_LABELS, false)) {
      if (t.k !== 'comment') continue;
      while (seg < segs.length - 1 && t.at > segStart + segs[seg].s.length) segStart += segs[seg++].s.length + 1;
      const s = segs[seg].at + t.at - segStart;
      if (s < done) continue;
      const html = src.startsWith('<!--', s);
      const closer = html ? '-->' : '%%';
      const j = src.indexOf(closer, s + (html ? 4 : 2));
      const [a, b] = wholeLines(src, s, j < 0 ? src.length : j + closer.length);
      cuts.push([a, b]);
      done = b;
    }
  }
  return cuts;
}

/** Every piece of text the page shows, in the blocks' order: what holds the comments to cut. */
function textsOf(b: Block, out: Seg[][]): void {
  if ((b.kind === 'para' || b.kind === 'heading' || b.kind === 'html') && b.segs.length) out.push(b.segs);
  else if (b.kind === 'table') for (const cell of [...b.head!, ...b.rows!.flat()]) out.push([cell]);
  else if (b.callout?.title) out.push([b.callout.title]);
  for (const k of b.kids) textsOf(k, out);
}

/** [s, e) widened to whole lines when nothing but spaces (and a quote's `>`) is around it on them. */
function wholeLines(src: string, s: number, e: number): [number, number] {
  let a = s;
  while (a > 0 && (isSpace(src[a - 1]) || src[a - 1] === '>')) a--;
  if (a > 0 && src[a - 1] !== '\n') return [s, e];
  let b = e;
  while (b < src.length && isSpace(src[b])) b++;
  if (b < src.length && src[b] !== '\n') return [s, e];
  return [a, b < src.length ? b + 1 : b];
}

/** `src` with every comment cut out, code or not, as text would read after each cut: the fallback that hides more. */
function stripAll(src: string): string {
  const out: string[] = [];
  for (let i = 0; i < src.length; ) {
    out.push(src[i++]);
    const k = out.length;
    if (out[k - 1] === '%' && out[k - 2] === '%') {
      out.length -= 2;
      const j = src.indexOf('%%', i);
      i = j < 0 ? src.length : j + 2;
    } else if (out[k - 1] === '-' && out[k - 2] === '-' && out[k - 3] === '!' && out[k - 4] === '<') {
      out.length -= 4;
      const j = src.indexOf('-->', i);
      i = j < 0 ? src.length : j + 3;
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------------------------------------------------
// Inline. One pass over a block's text into tokens, with CommonMark's delimiter stack for emphasis and bracket stack for
// links; every lookup ahead is done once for the whole text, so the pass stays linear on any input. Code spans, math and
// comments are found first in the order they start; any other syntax that would swallow a comment marker is not taken.

interface DelimTok {
  k: 'delim';
  ch: string;
  n: number;
  /** Tags this run closes and opens, in the order they were matched (innermost first). */
  open: string[];
  close: string[];
}

interface OpenTok {
  k: 'open';
  lit: string;
  kind?: 'link' | 'image' | 'fn';
  /** The index of its closing token. */
  end: number;
  dest: string;
  title?: string;
}

type Tok =
  | { k: 'text' | 'ent' | 'code' | 'math' | 'hashtag'; s: string }
  | { k: 'br' }
  | { k: 'comment'; at: number }
  | { k: 'tag'; name: string; close: boolean; self: boolean }
  | DelimTok
  | OpenTok
  | { k: 'close'; open: number }
  | { k: 'wiki'; embed: boolean; target: string; frags: string[]; alias?: string }
  | { k: 'fnref'; label: string }
  | { k: 'url'; href: string; s: string };

interface Delim {
  t: DelimTok;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delim | null;
  next: Delim | null;
}

interface Bracket {
  tok: number;
  image: boolean;
  fn: boolean;
  active: boolean;
  bottom: Delim | null;
}

const PUNCT = /[\p{P}\p{S}]/u;
const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
const WHITE = /\s/;
const ENTITY = /&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/y;
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\n]*(\/?)>/y;
const FOOTNOTE_REF = /\[\^([^\]\s[]{1,200})\]/y;
const HASHTAG = /[\p{L}\p{M}0-9_/-]+/uy;
const URL_STOP = /[\s<>"`{}|\\^[\]]/;

/** Where `needle` next starts at or after `p`, for positions that mostly grow; the text's length when nowhere. */
function finder(text: string, needle: string): (p: number) => number {
  let from = -1;
  let found = -1;
  return (p) => {
    if (from < 0 || p < from || (found >= 0 && p > found)) {
      from = p;
      found = text.indexOf(needle, p);
    }
    return found < 0 ? text.length : found;
  };
}

/** For growing positions `p`: where the next run of exactly `len` backticks after `p` starts, or -1. */
function backtickFinder(text: string): (p: number, len: number) => number {
  const runs = new Map<number, { at: number[]; i: number }>();
  for (let i = text.indexOf('`'); i >= 0; i = text.indexOf('`', i)) {
    let j = i;
    while (text[j] === '`') j++;
    let r = runs.get(j - i);
    if (!r) runs.set(j - i, (r = { at: [], i: 0 }));
    r.at.push(i);
    i = j;
  }
  return (p, len) => {
    const r = runs.get(len);
    if (!r) return -1;
    while (r.i < r.at.length && r.at[r.i] <= p) r.i++;
    return r.i < r.at.length ? r.at[r.i] : -1;
  };
}

const unescape = (s: string) => decodeEntities(s.replace(/\\([!-/:-@[-`{-~])/g, '$1'));

/** The tokens of a block's text. `labels` are the note's footnote labels; `cell` is for a table cell, where `\|` in code is `|`. */
function scan(text: string, labels: ReadonlySet<string>, cell: boolean): Tok[] {
  const n = text.length;
  const toks: Tok[] = [];
  const brackets: Bracket[] = [];
  let top: Delim | null = null;
  let from = 0;
  const pct = finder(text, '%%');
  const lt = finder(text, '<!--');
  const commentAt = (p: number) => Math.min(pct(p), lt(p));
  const nl = finder(text, '\n');
  const wikiEnd = finder(text, ']]');
  const wikiStart = finder(text, '[[');
  const linkEnd = finder(text, '](');
  const twoDollars = finder(text, '$$');
  const tick = backtickFinder(text);
  const dollar = finder(text, '$');

  const flush = (to: number) => {
    if (to > from) toks.push({ k: 'text', s: text.slice(from, to) });
  };
  const put = (i: number, t: Tok, next: number): number => {
    flush(i);
    toks.push(t);
    from = next;
    return next;
  };

  const unlink = (d: Delim) => {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else top = d.prev;
  };
  // CommonMark's "process emphasis", over the delimiters above `bottom`; `floors` keeps it linear.
  const emphasis = (bottom: Delim | null) => {
    const floors = new Map<string, Delim | null>();
    let closer: Delim | null = top === bottom ? null : top;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const ch = closer.t.ch;
      const star = ch === '*' || ch === '_';
      const key = star ? `${ch}${closer.canOpen ? 1 : 0}${closer.orig % 3}` : ch;
      const floor = floors.has(key) ? floors.get(key) : bottom;
      let opener = closer.prev;
      for (; opener && opener !== bottom && opener !== floor; opener = opener.prev) {
        if (opener.t.ch !== ch || !opener.canOpen) continue;
        if (star && (opener.canClose || closer.canOpen) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0) continue;
        break;
      }
      if (opener && opener !== bottom && opener !== floor) {
        const use = !star || (closer.t.n >= 2 && opener.t.n >= 2) ? 2 : 1;
        const tag = ch === '~' ? 'del' : ch === '=' ? 'mark' : use === 2 ? 'strong' : 'em';
        opener.t.n -= use;
        closer.t.n -= use;
        opener.t.open.push(tag);
        closer.t.close.push(tag);
        opener.next = closer;
        closer.prev = opener;
        if (!opener.t.n) unlink(opener);
        if (!closer.t.n) {
          const next: Delim | null = closer.next;
          unlink(closer);
          closer = next;
        }
      } else {
        floors.set(key, closer.prev);
        const next: Delim | null = closer.next;
        if (!closer.canOpen) unlink(closer);
        closer = next;
      }
    }
    while (top && top !== bottom) unlink(top);
  };

  const openBracket = (i: number, lit: string): number => {
    if (brackets.length >= MAX_BRACKETS) return i + lit.length;
    brackets.push({ tok: toks.length + (i > from ? 1 : 0), image: lit === '![', fn: lit === '^[', active: true, bottom: top });
    return put(i, { k: 'open', lit, end: -1, dest: '' }, i + lit.length);
  };

  const spaces = (j: number, stop: number) => {
    let line = false;
    for (; j < stop; j++) {
      if (text[j] === '\n' && !line) line = true;
      else if (!isSpace(text[j])) break;
    }
    return j;
  };
  // `(destination "title")` after a `]`, starting after its `(`. No part of it runs past the next `](`, which keeps
  // every attempt short however many brackets a text holds.
  const destination = (p: number): { dest: string; title?: string; end: number } | null => {
    const stop = linkEnd(p);
    let j = spaces(p, stop);
    let dest: string;
    if (text[j] === '<') {
      let k = j + 1;
      while (k < stop && text[k] !== '>' && text[k] !== '<' && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
      if (k >= stop || text[k] !== '>') return null;
      dest = text.slice(j + 1, k);
      j = k + 1;
    } else {
      let k = j;
      let depth = 0;
      for (; k < stop; k++) {
        const ch = text[k];
        if (ch === '\\' && ASCII_PUNCT.test(text[k + 1] ?? '')) k++;
        else if (ch === '(') {
          if (++depth > 32) return null;
        } else if (ch === ')') {
          if (!depth) break;
          depth--;
        } else if (ch <= ' ' || ch === '\u007f') break;
      }
      if (depth || k > stop) return null;
      dest = text.slice(j, k);
      j = k;
    }
    const gap = j;
    j = spaces(j, stop);
    let title: string | undefined;
    const q = text[j];
    if (j > gap && (q === '"' || q === "'" || q === '(')) {
      const qe = q === '(' ? ')' : q;
      let k = j + 1;
      while (k < stop && text[k] !== qe) k += text[k] === '\\' ? 2 : 1;
      if (k >= stop) return null;
      title = unescape(text.slice(j + 1, k));
      j = spaces(k + 1, stop);
    }
    if (j >= stop || text[j] !== ')' || commentAt(p) < j) return null;
    return { dest: unescape(dest), title, end: j + 1 };
  };

  const closeBracket = (i: number): number => {
    const b = brackets[brackets.length - 1];
    if (!b) return i + 1;
    const o = toks[b.tok] as OpenTok;
    let next = i + 1;
    if (!b.active) {
      brackets.pop();
      return put(i, { k: 'text', s: ']' }, next);
    }
    if (b.fn) o.kind = 'fn';
    else {
      const d = text[i + 1] === '(' ? destination(i + 2) : null;
      if (!d) {
        brackets.pop();
        return put(i, { k: 'text', s: ']' }, next);
      }
      o.kind = b.image ? 'image' : 'link';
      o.dest = d.dest;
      o.title = d.title;
      next = d.end;
    }
    put(i, { k: 'close', open: b.tok }, next);
    o.end = toks.length - 1;
    emphasis(b.bottom);
    brackets.pop();
    // No link inside a link.
    if (o.kind === 'link') for (const x of brackets) if (!x.image && !x.fn) x.active = false;
    return next;
  };

  const wiki = (i: number): { target: string; frags: string[]; alias?: string; end: number } | null => {
    const s = i + 2;
    const e = wikiEnd(s);
    if (e >= n || text[s] === '[' || nl(s) < e || wikiStart(s) < e || commentAt(s) < e) return null;
    const inner = text.slice(s, e);
    const bar = inner.indexOf('|');
    let link = bar < 0 ? inner : inner.slice(0, bar);
    // In a table, `[[note\|alias]]` keeps the cell whole; elsewhere the backslash is as stray.
    if (link.endsWith('\\')) link = link.slice(0, -1);
    const [target, ...frags] = link.split('#');
    const alias = bar < 0 ? '' : inner.slice(bar + 1).trim();
    if (!target.trim() && !frags.some((f) => f.trim())) return null;
    return { target: target.trim(), frags: frags.map((f) => f.trim()), alias: alias || undefined, end: e + 2 };
  };

  const bareUrl = (i: number): string | null => {
    const host = i + (text[i + 4] === 's' ? 8 : 7);
    if (!/[A-Za-z0-9]/.test(text[host] ?? '')) return null;
    const lim = commentAt(i);
    let j = host;
    while (j < n && j < lim && !URL_STOP.test(text[j])) j++;
    let opens = 0;
    let shuts = 0;
    for (let k = i; k < j; k++) {
      if (text[k] === '(') opens++;
      else if (text[k] === ')') shuts++;
    }
    for (;;) {
      const last = text[j - 1];
      if (/[.,;:!?*_~'"]/.test(last)) j--;
      else if (last === ')' && shuts > opens) {
        j--;
        shuts--;
      } else break;
    }
    return j > host ? text.slice(i, j) : null;
  };

  let i = 0;
  while (i < n) {
    const c = text[i];
    switch (c) {
      case '%':
        if (text[i + 1] === '%') {
          const j = text.indexOf('%%', i + 2);
          i = put(i, { k: 'comment', at: i }, j < 0 ? n : j + 2);
          continue;
        }
        break;
      case '<': {
        if (text.startsWith('<!--', i)) {
          const j = text.indexOf('-->', i + 4);
          i = put(i, { k: 'comment', at: i }, j < 0 ? n : j + 3);
          continue;
        }
        AUTOLINK.lastIndex = i;
        let m = AUTOLINK.exec(text);
        if (m && !hasControl(m[0]) && commentAt(i) >= i + m[0].length) {
          const u = m[0].slice(1, -1);
          i = put(i, SCHEMES.has(m[1].toLowerCase()) ? { k: 'url', href: u, s: u } : { k: 'text', s: m[0] }, i + m[0].length);
          continue;
        }
        TAG.lastIndex = i;
        m = TAG.exec(text);
        if (m && commentAt(i) >= i + m[0].length) {
          const name = m[2].toLowerCase();
          i = put(i, ALLOWED_TAGS.has(name) ? { k: 'tag', name, close: m[1] === '/', self: m[3] === '/' } : { k: 'text', s: m[0] }, i + m[0].length);
          continue;
        }
        break;
      }
      case '\\': {
        const d = text[i + 1];
        if (d === '\n') {
          flush(i);
          from = i + 1;
        } else if (d !== undefined && ASCII_PUNCT.test(d) && !text.startsWith('%%', i + 1) && !text.startsWith('<!--', i + 1)) {
          i = put(i, { k: 'text', s: d }, i + 2);
          continue;
        }
        break;
      }
      case '\n': {
        let e = i;
        while (e > from && isSpace(text[e - 1])) e--;
        flush(e);
        toks.push({ k: 'br' });
        let j = i + 1;
        while (isSpace(text[j])) j++;
        from = i = j;
        continue;
      }
      case '`': {
        let j = i;
        while (text[j] === '`') j++;
        const e = tick(i, j - i);
        if (e < 0) {
          i = put(i, { k: 'text', s: text.slice(i, j) }, j);
          continue;
        }
        let s = text.slice(j, e).replace(/\n/g, ' ');
        if (cell) s = s.replace(/\\\|/g, '|');
        if (s.length > 1 && s[0] === ' ' && s[s.length - 1] === ' ' && s.trim()) s = s.slice(1, -1);
        i = put(i, { k: 'code', s }, e + j - i);
        continue;
      }
      case '$': {
        if (text[i + 1] === '$') {
          const e = twoDollars(i + 2);
          if (e < n && text.slice(i + 2, e).trim()) {
            i = put(i, { k: 'math', s: text.slice(i + 2, e) }, e + 2);
            continue;
          }
          i += 2;
          continue;
        }
        const d = text[i + 1];
        if (d !== undefined && !WHITE.test(d)) {
          // Only the next `$` can close it, and only when not after a space, before a digit or doubled: `$5 or $10` is no math.
          let e = dollar(i + 1);
          while (e < n && text[e - 1] === '\\') e = dollar(e + 1);
          const after = text[e + 1];
          if (e < nl(i) && !WHITE.test(text[e - 1]) && after !== '$' && !(after >= '0' && after <= '9')) {
            i = put(i, { k: 'math', s: text.slice(i + 1, e) }, e + 1);
            continue;
          }
        }
        break;
      }
      case '*':
      case '_':
      case '~':
      case '=': {
        let j = i;
        while (text[j] === c) j++;
        if ((c === '~' || c === '=') && j - i !== 2) {
          i = j;
          continue;
        }
        const before = i > 0 ? text[i - 1] : ' ';
        const after = j < n ? text[j] : ' ';
        const left = !WHITE.test(after) && (!PUNCT.test(after) || WHITE.test(before) || PUNCT.test(before));
        const right = !WHITE.test(before) && (!PUNCT.test(before) || WHITE.test(after) || PUNCT.test(after));
        const canOpen = c === '_' ? left && (!right || PUNCT.test(before)) : left;
        const canClose = c === '_' ? right && (!left || PUNCT.test(after)) : right;
        const t: DelimTok = { k: 'delim', ch: c, n: j - i, open: [], close: [] };
        put(i, t, j);
        if (canOpen || canClose) {
          const d: Delim = { t, orig: j - i, canOpen, canClose, prev: top, next: null };
          if (top) top.next = d;
          top = d;
        }
        i = j;
        continue;
      }
      case '!':
        if (text[i + 1] === '[') {
          const w = text[i + 2] === '[' ? wiki(i + 1) : null;
          if (w) {
            i = put(i, { k: 'wiki', embed: true, target: w.target, frags: w.frags, alias: w.alias }, w.end);
            continue;
          }
          i = openBracket(i, '![');
          continue;
        }
        break;
      case '^':
        if (text[i + 1] === '[' && text[i + 2] !== '[') {
          i = openBracket(i, '^[');
          continue;
        }
        break;
      case '[': {
        if (text[i + 1] === '[') {
          const w = wiki(i);
          if (w) {
            i = put(i, { k: 'wiki', embed: false, target: w.target, frags: w.frags, alias: w.alias }, w.end);
            continue;
          }
        } else if (text[i + 1] === '^') {
          FOOTNOTE_REF.lastIndex = i;
          const m = FOOTNOTE_REF.exec(text);
          if (m && labels.has(m[1]) && commentAt(i) >= i + m[0].length) {
            i = put(i, { k: 'fnref', label: m[1] }, i + m[0].length);
            continue;
          }
        }
        i = openBracket(i, '[');
        continue;
      }
      case ']':
        i = closeBracket(i);
        continue;
      case '&': {
        ENTITY.lastIndex = i;
        const m = ENTITY.exec(text);
        if (m) {
          i = put(i, { k: 'ent', s: m[0] }, i + m[0].length);
          continue;
        }
        break;
      }
      case '#':
        if (i === 0 || WHITE.test(text[i - 1])) {
          HASHTAG.lastIndex = i + 1;
          const m = HASHTAG.exec(text);
          if (m && /[^0-9]/.test(m[0])) {
            i = put(i, { k: 'hashtag', s: `#${m[0]}` }, i + 1 + m[0].length);
            continue;
          }
        }
        break;
      case 'h':
        if ((i === 0 || /[\s*_~(]/.test(text[i - 1])) && (text.startsWith('https://', i) || text.startsWith('http://', i))) {
          const u = bareUrl(i);
          if (u) {
            i = put(i, { k: 'url', href: u, s: u }, i + u.length);
            continue;
          }
        }
        break;
    }
    i++;
  }
  flush(n);
  emphasis(null);
  return toks;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering.

interface Note {
  n: number;
  /** An inline footnote's HTML, rendered where it was written. */
  html?: string;
  def?: Block;
}

interface Ctx {
  hooks: RenderHooks;
  defs: Map<string, Block>;
  labels: ReadonlySet<string>;
  /** Every id given out, and the next number to try after a taken heading id. */
  ids: Set<string>;
  idNext: Map<string, number>;
  headings: Heading[];
  /** Footnote numbers by label, how many references each number has, and the footnotes in number order. */
  numbers: Map<string, number>;
  refs: Map<number, number>;
  notes: Note[];
}

/** 'inline' for a paragraph or heading, 'cell' for a table cell, 'html' for an HTML block (line ends kept as such), 'plain' for text only. */
type Mode = 'inline' | 'cell' | 'html' | 'plain';

/** Markdown's or a raw tag's element open in the inline HTML: what closes it, and the raw tags opened inside it. */
interface Frame {
  end: string;
  tags: string[];
  counts: Map<string, number>;
}

const frame = (end: string): Frame => ({ end, tags: [], counts: new Map() });
const shut = (f: Frame) => f.tags.reduceRight((out, tag) => `${out}</${tag}>`, '') + f.end;

function inline(segs: Seg[], ctx: Ctx, mode: Mode = 'inline'): string {
  const toks = scan(segs.map((g) => g.s).join('\n'), ctx.labels, mode === 'cell');
  return emit(toks, 0, toks.length, ctx, mode, false);
}

/**
 * The HTML of tokens [from, to). Raw tags stay balanced: each Markdown element closes the tags opened inside it, a
 * closing tag with no opener is dropped, and what is still open at the end is closed.
 */
function emit(toks: Tok[], from: number, to: number, ctx: Ctx, mode: Mode, inLink: boolean): string {
  const plain = mode === 'plain';
  const frames: Frame[] = [frame('')];
  let links = inLink ? 1 : 0;
  let out = '';
  for (let i = from; i < to; i++) {
    const t = toks[i];
    switch (t.k) {
      case 'text':
        out += plain ? t.s : escapeHtml(t.s);
        break;
      case 'ent':
        out += plain ? decodeEntities(t.s) : t.s;
        break;
      case 'br':
        out += plain ? ' ' : mode === 'html' ? '\n' : '<br>\n';
        break;
      case 'code':
        out += plain ? t.s : `<code>${escapeHtml(t.s)}</code>`;
        break;
      case 'math':
        out += plain ? t.s : `<code class="math">${escapeHtml(t.s)}</code>`;
        break;
      case 'hashtag':
        out += plain ? t.s : `<span class="tag">${escapeHtml(t.s)}</span>`;
        break;
      case 'comment':
        break;
      case 'tag':
        if (!plain) out += rawTag(t, frames[frames.length - 1]);
        break;
      case 'delim':
        if (!plain) for (let k = 0; k < t.close.length; k++) out += shut(frames.pop()!);
        out += t.ch.repeat(t.n);
        if (!plain)
          for (let k = t.open.length - 1; k >= 0; k--) {
            out += `<${t.open[k]}>`;
            frames.push(frame(`</${t.open[k]}>`));
          }
        break;
      case 'url':
        out += plain || links ? (plain ? t.s : escapeHtml(t.s)) : `<a href="${escapeHtml(normalizeUrl(t.href))}" class="external" rel="noopener noreferrer">${escapeHtml(t.s)}</a>`;
        break;
      case 'wiki':
        out += t.embed ? (plain ? '' : embedHtml(ctx, t.target, fragment(t.frags), t.alias, links > 0)) : wikiLink(t, ctx, plain, links > 0);
        break;
      case 'fnref':
        if (!plain) out += links ? escapeHtml(`[^${t.label}]`) : noteRef(ctx, t.label);
        break;
      case 'open':
        if (!t.kind) out += t.lit;
        else if (t.kind === 'image') {
          if (!plain) out += image(t, emit(toks, i + 1, t.end, ctx, 'plain', true).trim(), ctx, links > 0);
          i = t.end;
        } else if (t.kind === 'fn') {
          if (links && !plain) out += '^[';
          else {
            if (!plain) {
              const note: Note = { n: ctx.notes.length + 1 };
              ctx.notes.push(note);
              ctx.refs.set(note.n, 1);
              note.html = emit(toks, i + 1, t.end, ctx, mode === 'html' ? 'inline' : mode, false);
              out += refHtml(note.n, 1);
            }
            i = t.end;
          }
        } else {
          if (!plain) {
            const [open, end] = linkTags(t, ctx);
            out += open;
            frames.push(frame(end));
          }
          links++;
        }
        break;
      case 'close': {
        const o = toks[t.open] as OpenTok;
        if (o.kind === 'fn') out += ']';
        else {
          if (!plain) out += shut(frames.pop()!);
          links--;
        }
        break;
      }
    }
  }
  while (frames.length) out += shut(frames.pop()!);
  return out;
}

/** An allowed raw tag, without attributes, kept balanced within the element `f` it was written in. */
function rawTag(t: { name: string; close: boolean; self: boolean }, f: Frame): string {
  if (VOID_TAGS.has(t.name)) return t.close ? '' : `<${t.name}>`;
  if (!t.close) {
    if (t.self) return `<${t.name}></${t.name}>`;
    f.tags.push(t.name);
    f.counts.set(t.name, (f.counts.get(t.name) ?? 0) + 1);
    return `<${t.name}>`;
  }
  if (!f.counts.get(t.name)) return '';
  let out = '';
  for (;;) {
    const tag = f.tags.pop()!;
    f.counts.set(tag, f.counts.get(tag)! - 1);
    out += `</${tag}>`;
    if (tag === t.name) return out;
  }
}

/** The fragment of a link to a heading or a block, `#…`, from the parts after its `#`s: the last one counts. '' for none. */
function fragment(parts: string[]): string {
  const last = parts.filter((x) => x.trim()).pop()?.trim();
  if (!last) return '';
  return last.startsWith('^') ? `#^${last.slice(1).replace(/[^A-Za-z0-9-]/g, '')}` : `#${headingId(last)}`;
}

function wikiLink(t: { target: string; frags: string[]; alias?: string }, ctx: Ctx, plain: boolean, nested: boolean): string {
  const text = t.alias ?? [t.target, ...t.frags].filter(Boolean).join(' > ');
  if (plain) return text;
  if (nested) return escapeHtml(text);
  const frag = fragment(t.frags);
  if (!t.target) return frag ? `<a href="${escapeHtml(frag)}" class="internal">${escapeHtml(text)}</a>` : escapeHtml(text);
  const r = ctx.hooks.link(t.target);
  return r ? `<a href="${escapeHtml(siteHref(r.href) + frag)}" class="internal">${escapeHtml(text)}</a>` : `<span class="unresolved">${escapeHtml(text)}</span>`;
}

type Address = { kind: 'web'; href: string } | { kind: 'page'; frag: string } | { kind: 'file'; path: string; frag: string } | { kind: 'none' };

/**
 * Where a Markdown link's address leads. With a scheme, compared without case, spaces or control characters: the web
 * for http, https, mailto and tel, nowhere for any other. Starting with `#`: a heading or block of this page. Anything
 * else is a path in the vault, percent-decoded, for the caller to look up.
 */
function address(dest: string): Address {
  const probe = withoutControls(dest.replace(/\s/g, ''), true);
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(probe);
  if (m) {
    const scheme = m[1].toLowerCase();
    const d = dest.trim();
    return SCHEMES.has(scheme) && d.slice(0, scheme.length + 1).toLowerCase() === `${scheme}:` ? { kind: 'web', href: normalizeUrl(d) } : { kind: 'none' };
  }
  const hash = dest.indexOf('#');
  const path = decodePath(hash < 0 ? dest : dest.slice(0, hash)).trim();
  const frag = hash < 0 ? '' : fragment(decodePath(dest.slice(hash + 1)).split('#'));
  if (path) return { kind: 'file', path, frag };
  return frag ? { kind: 'page', frag } : { kind: 'none' };
}

/** The tags around a Markdown link's text: an anchor, a span for a link to nothing on the site, or none for an unsafe address. */
function linkTags(t: OpenTok, ctx: Ctx): [string, string] {
  const title = t.title ? ` title="${escapeHtml(t.title)}"` : '';
  const to = address(t.dest);
  if (to.kind === 'web') return [`<a href="${escapeHtml(to.href)}" class="external" rel="noopener noreferrer"${title}>`, '</a>'];
  if (to.kind === 'page') return [`<a href="${escapeHtml(to.frag)}" class="internal"${title}>`, '</a>'];
  if (to.kind === 'none') return ['', ''];
  const r = ctx.hooks.link(to.path);
  return r ? [`<a href="${escapeHtml(siteHref(r.href) + to.frag)}" class="internal"${title}>`, '</a>'] : ['<span class="unresolved">', '</span>'];
}

/** A size written after the last `|` of an embed's alias or an image's alt, `300` or `300x200`, and the text before it. */
function sized(alias: string | undefined): { alt?: string; size: string } {
  if (alias === undefined) return { size: '' };
  const bar = alias.lastIndexOf('|');
  const m = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(alias.slice(bar + 1).trim());
  if (!m) return { alt: alias, size: '' };
  return { alt: bar < 0 ? undefined : alias.slice(0, bar), size: ` width="${m[1]}"${m[2] ? ` height="${m[2]}"` : ''}` };
}

function image(t: OpenTok, alt: string, ctx: Ctx, nested: boolean): string {
  const to = address(t.dest);
  if (to.kind === 'web') {
    if (!/^https?:/i.test(to.href)) return '';
    const s = sized(alt);
    return `<img src="${escapeHtml(to.href)}" alt="${escapeHtml(s.alt?.trim() ?? '')}"${s.size} loading="lazy">`;
  }
  return to.kind === 'file' ? embedHtml(ctx, to.path, to.frag, alt || undefined, nested) : '';
}

/** A file shown in the note, as the caller places it; inside a link, only a picture stays an element (no link in a link). */
function embedHtml(ctx: Ctx, target: string, frag: string, alias: string | undefined, nested: boolean): string {
  if (!target) return '';
  const r = ctx.hooks.embed(target);
  if (!r) return '';
  const name = target.slice(target.lastIndexOf('/') + 1);
  const href = siteHref(r.href);
  const src = escapeHtml(href);
  const { alt, size } = sized(alias);
  switch (r.kind) {
    case 'image':
      return `<img src="${src}" alt="${escapeHtml(alt?.trim() || name)}"${size} loading="lazy">`;
    case 'audio':
      return nested ? escapeHtml(name) : `<audio controls src="${src}"></audio>`;
    case 'video':
      return nested ? escapeHtml(name) : `<video controls src="${src}"></video>`;
    case 'pdf':
      return nested ? escapeHtml(name) : `<a href="${escapeHtml(href + (/^#page=\d+$/.test(frag) ? frag : ''))}" class="internal">${escapeHtml(name)}</a>`;
    case 'note': {
      const label = r.title ?? alias ?? target;
      return nested ? escapeHtml(label) : `<a href="${escapeHtml(href + frag)}" class="internal embed">${escapeHtml(label)}</a>`;
    }
  }
  return '';
}

const refHtml = (n: number, k: number) => `<sup class="footnote-ref"><a href="#fn-${n}" id="fnref-${n}${k > 1 ? `-${k}` : ''}">${n}</a></sup>`;

/** A reference to footnote `label`, numbered in the order footnotes are first referenced; a second reference gets its own id. */
function noteRef(ctx: Ctx, label: string): string {
  let n = ctx.numbers.get(label);
  if (n === undefined) {
    n = ctx.notes.length + 1;
    ctx.numbers.set(label, n);
    ctx.notes.push({ n, def: ctx.defs.get(label) });
  }
  const k = (ctx.refs.get(n) ?? 0) + 1;
  ctx.refs.set(n, k);
  return refHtml(n, k);
}

/** `base`, or with `-1`, `-2`, … after it when an element of the page already has it. */
function uniqueId(ctx: Ctx, base: string): string {
  let id = base;
  if (ctx.ids.has(id)) {
    let k = ctx.idNext.get(base) ?? 1;
    while (ctx.ids.has(`${base}-${k}`)) k++;
    ctx.idNext.set(base, k + 1);
    id = `${base}-${k}`;
  }
  ctx.ids.add(id);
  return id;
}

/** ` id="^abc"` for a block id not given out yet; a repeated one is left off. */
function idAttr(ctx: Ctx, id: string | undefined): string {
  if (!id || ctx.ids.has(id)) return '';
  ctx.ids.add(id);
  return ` id="${escapeHtml(id)}"`;
}

function renderBlocks(kids: Block[], ctx: Ctx): string {
  const out: string[] = [];
  for (const b of kids) {
    const html = renderBlock(b, ctx);
    if (html) out.push(html);
  }
  return out.join('\n');
}

const wrap = (open: string, body: string, close: string) => (body ? `${open}\n${body}\n${close}` : `${open}${close}`);

function renderBlock(b: Block, ctx: Ctx): string {
  switch (b.kind) {
    case 'para':
      return `<p${idAttr(ctx, b.id)}>${inline(b.segs, ctx)}</p>`;
    case 'heading': {
      const toks = scan(b.segs[0].s, ctx.labels, false);
      // An embed or comment taken out leaves the spaces around it: a heading starting with one would start with a space.
      const text = emit(toks, 0, toks.length, ctx, 'plain', false).replace(/\s+/g, ' ').trim();
      const id = uniqueId(ctx, headingId(text));
      ctx.headings.push({ level: b.level!, text, id });
      return `<h${b.level} id="${escapeHtml(id)}">${emit(toks, 0, toks.length, ctx, 'inline', false).trim()}</h${b.level}>`;
    }
    case 'code': {
      const lang = /^[A-Za-z0-9_+#.-]+/.exec(b.info!)?.[0];
      return `<pre${idAttr(ctx, b.id)}><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(b.lines.join('\n'))}</code></pre>`;
    }
    case 'math':
      return `<pre class="math"${idAttr(ctx, b.id)}><code>${escapeHtml(b.lines.join('\n'))}</code></pre>`;
    case 'hr':
      return `<hr${idAttr(ctx, b.id)}>`;
    case 'html':
      return inline(b.segs, ctx, 'html');
    case 'table': {
      const row = (cells: Seg[], tag: string) =>
        `<tr>${b.align!.map((a, k) => `<${tag}${a ? ` class="${a}"` : ''}>${cells[k] ? inline([cells[k]], ctx, 'cell') : ''}</${tag}>`).join('')}</tr>`;
      const head = `<table${idAttr(ctx, b.id)}>\n<thead>\n${row(b.head!, 'th')}\n</thead>`;
      return b.rows!.length ? `${head}\n<tbody>\n${b.rows!.map((r) => row(r, 'td')).join('\n')}\n</tbody>\n</table>` : `${head}\n</table>`;
    }
    case 'quote': {
      if (!b.callout) return wrap(`<blockquote${idAttr(ctx, b.id)}>`, renderBlocks(b.kids, ctx), '</blockquote>');
      const { type, fold, title } = b.callout;
      const attrs = ` class="callout" data-callout="${type}"${idAttr(ctx, b.id)}`;
      const head = title ? inline([title], ctx) : escapeHtml(type[0].toUpperCase() + type.slice(1));
      const content = wrap('<div class="callout-content">', renderBlocks(b.kids, ctx), '</div>');
      if (fold) return `<details${attrs}${fold === '+' ? ' open' : ''}>\n<summary class="callout-title">${head}</summary>\n${content}\n</details>`;
      return `<div${attrs}>\n<div class="callout-title">${head}</div>\n${content}\n</div>`;
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      return wrap(`<${tag}${start}${idAttr(ctx, b.id)}>`, b.kids.map((it) => listItem(it, ctx, !b.loose)).join('\n'), `</${tag}>`);
    }
    default:
      return '';
  }
}

/**
 * A list item. In a tight list its paragraphs go without `<p>`. A block id on one of its paragraphs is the item's, as
 * Obsidian links to the item. A task's checkbox goes before its first paragraph's text.
 */
function listItem(it: Block, ctx: Ctx, tight: boolean): string {
  const owner = it.kids.find((k) => k.kind === 'para' && k.id);
  const id = idAttr(ctx, owner?.id);
  let box = it.task === undefined ? '' : `<input type="checkbox"${it.task === ' ' ? '' : ' checked'} disabled>`;
  const pieces: { html: string; inline: boolean }[] = [];
  for (const k of it.kids) {
    if (k.kind === 'fndef') continue;
    if (k.kind !== 'para') {
      pieces.push({ html: renderBlock(k, ctx), inline: false });
      continue;
    }
    const text = (box ? `${box} ` : '') + inline(k.segs, ctx);
    box = '';
    pieces.push(tight ? { html: text, inline: true } : { html: `<p${k === owner ? '' : idAttr(ctx, k.id)}>${text}</p>`, inline: false });
  }
  if (box) pieces.unshift({ html: box, inline: true });
  const open = `<li${it.task === undefined ? '' : ' class="task"'}${id}>`;
  if (!pieces.length) return `${open}</li>`;
  const body = pieces.map((x) => x.html).join('\n');
  return `${open}${pieces[0].inline ? '' : '\n'}${body}${pieces[pieces.length - 1].inline ? '' : '\n'}</li>`;
}

/** The footnotes referenced, in number order, each with a link back to its first reference. Empty when there are none. */
function footnotes(ctx: Ctx): string {
  const items: string[] = [];
  // Rendering a footnote can reference more of them, which join the end of the list.
  for (let i = 0; i < ctx.notes.length; i++) {
    const { n, html, def } = ctx.notes[i];
    const back = `<a href="#fnref-${n}" class="footnote-back">↩</a>`;
    const kids = def?.kids.filter((k) => k.kind !== 'fndef') ?? [];
    let body: string;
    if (html !== undefined || !kids.length) body = `${html ? `${html} ` : ''}${back}`;
    else if (kids.length === 1 && kids[0].kind === 'para') body = `${inline(kids[0].segs, ctx)} ${back}`;
    else {
      const last = kids[kids.length - 1];
      const end = last.kind === 'para' ? `<p${idAttr(ctx, last.id)}>${inline(last.segs, ctx)} ${back}</p>` : '';
      const rest = renderBlocks(last.kind === 'para' ? kids.slice(0, -1) : kids, ctx);
      body = `\n${[rest, end || back].filter(Boolean).join('\n')}\n`;
    }
    items.push(`<li id="fn-${n}">${body}</li>`);
  }
  return items.length ? `\n<section class="footnotes">\n<ol>\n${items.join('\n')}\n</ol>\n</section>` : '';
}

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers.

const NAMED = new Map(
  Object.entries({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', deg: '°', times: '×', divide: '÷', euro: '€',
    pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', plusmn: '±', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', shy: '­',
  }),
);

/** The character an entity reference stands for; a name not known here stays as written. */
function decodeEntity(e: string): string {
  const body = e.slice(1, -1);
  if (body[0] !== '#') return NAMED.get(body) ?? e;
  const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
}

const decodeEntities = (s: string) => s.replace(/&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, decodeEntity);

/**
 * An href or src from the hooks, which are trusted to give one already safe. A relative path whose first part holds a
 * colon (a note named `javascript:x`) would still read as a scheme, so it gets `./` before it, as a URL needs anyway.
 */
function siteHref(href: string): string {
  return /^[^/?#]*:/.test(href) && !/^https?:/i.test(href) ? `./${href}` : href;
}

function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // An escape cut short stays as written, as Obsidian takes it.
    return s;
  }
}

/** `u` with what can not stand in a URL percent-encoded, and a `%` that starts no escape written `%25`. */
function normalizeUrl(u: string): string {
  return u.replace(/%(?![0-9A-Fa-f]{2})/g, '%25').replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g, (m) => {
    try {
      return encodeURIComponent(m);
    } catch {
      // A lone surrogate.
      return [...m].map((ch) => (ch.length === 1 && ch >= '\uD800' && ch <= '\uDFFF' ? '%EF%BF%BD' : encodeURIComponent(ch))).join('');
    }
  });
}
