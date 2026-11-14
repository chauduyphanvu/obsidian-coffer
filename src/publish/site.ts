// A website from the notes whose properties say `publish: true`: a page for each, the pictures, sound, video and PDF
// files they show, a front page and a style sheet. What goes on it is decided here, and every rule leans towards leaving
// a file out: a note is a page only when its own bytes say publish: true, a file joins only when a page shows or links
// it, and a link leads only to what is on the site. Links are resolved by one fixed rule over every file of the vault,
// so a link meant for a private note finds that note and shows as text. The same vault always gives the same bytes.
// No Obsidian import, so the plugin and the command line build the same site.
import { KEY, entries, frontmatter, splitLines } from '../core/merge.ts';
import { conflictOriginal, ext, fileName, vaultKey } from '../core/paths.ts';
import { hasControl } from '../core/text.ts';
import { isAttachment, isNote, propertyValues } from '../plugin/byproperty.ts';
import { MANIFEST, type SiteFile } from './deploy.ts';
import { escapeHtml, renderMarkdown, type RenderHooks, type Rendered } from './markdown.ts';
import { THEME } from './theme.ts';

/** The property a note carries to be on the website: `publish: true`. */
export const PUBLISH = 'publish';

/** The vault as publishing reads it. */
export interface VaultReader {
  /** Every file's vault path. */
  list(): Promise<string[]>;
  read(path: string): Promise<Uint8Array>;
}

export interface SiteOptions {
  /** Shown at the top of every page and as the front page's heading. '' reads as "Notes". */
  title: string;
  /** Vault path of the note that is the front page, with or without `.md`; '' for none. */
  home: string;
  /** Files the caller keeps out of everything: what sync leaves out, the settings folder. Given a vault key (NFC path). */
  excluded: (key: string) => boolean;
  /**
   * The whole vault is the website: every note is a page unless its properties say otherwise (`publish: false`, or
   * anything but `publish: true`). Without it, only the notes that say `publish: true` are.
   */
  whole?: boolean;
}

/**
 * Why a file that would be on the site is not: left out by the caller or in a dot folder, a conflict copy, a name a
 * website can not carry, a name another file of the site has in other letter case, or a file a page shows by a name
 * that more than one file of the vault has, so that which one the author meant is a guess.
 */
export type LeftOutWhy = 'excluded' | 'conflict' | 'name' | 'clash' | 'ambiguous';

/** What a built site holds and what it left out, for the person publishing it. */
export interface SiteReport {
  /** The notes on the site, sorted by path. `key` is the page's file on the site. */
  pages: { path: string; key: string; title: string }[];
  /** The other files on the site, sorted by path. */
  attachments: { path: string; key: string; size: number }[];
  /** Links in published notes to notes that are not on the site: their text is shown without a link. */
  unpublished: { from: string; link: string }[];
  /** Links and embeds in published notes that lead to no file in the vault. */
  missing: { from: string; link: string }[];
  /** Files that would be on the site but are left out, each with why. */
  leftOut: { path: string; why: LeftOutWhy }[];
  /** The site was built of the whole vault (`SiteOptions.whole`). */
  whole: boolean;
  /** The note chosen as the front page, when it is not a note on the site: the front page is then the list of pages. '' otherwise. */
  homeNotFound: string;
}

/** A built site: its files by key, and the report on what it holds. */
export interface Site {
  files: Map<string, SiteFile>;
  report: SiteReport;
}

const BOM = '\uFEFF';
const INDEX = 'index.html';
const STYLE = 'site.css';
/** The site's own files and the location's: no page or file of the vault may have one of these names, in any letter case. */
const RESERVED = [INDEX, STYLE, MANIFEST, 'vault.json'];
const HTML_TYPE = 'text/html; charset=utf-8';
const CSS_TYPE = 'text/css; charset=utf-8';
/** Files read at once. */
const READS = 8;

type Kind = 'image' | 'audio' | 'video' | 'pdf';
/** How each kind of attachment is shown and the content type it is served with. Only these join a site. */
const KINDS = new Map<string, { kind: Kind; type: string }>([
  ['png', { kind: 'image', type: 'image/png' }],
  ['jpg', { kind: 'image', type: 'image/jpeg' }],
  ['jpeg', { kind: 'image', type: 'image/jpeg' }],
  ['gif', { kind: 'image', type: 'image/gif' }],
  ['bmp', { kind: 'image', type: 'image/bmp' }],
  ['svg', { kind: 'image', type: 'image/svg+xml' }],
  ['webp', { kind: 'image', type: 'image/webp' }],
  ['avif', { kind: 'image', type: 'image/avif' }],
  ['mp3', { kind: 'audio', type: 'audio/mpeg' }],
  ['wav', { kind: 'audio', type: 'audio/wav' }],
  ['m4a', { kind: 'audio', type: 'audio/mp4' }],
  ['ogg', { kind: 'audio', type: 'audio/ogg' }],
  ['flac', { kind: 'audio', type: 'audio/flac' }],
  ['3gp', { kind: 'audio', type: 'audio/3gpp' }],
  ['webm', { kind: 'video', type: 'video/webm' }],
  ['mp4', { kind: 'video', type: 'video/mp4' }],
  ['ogv', { kind: 'video', type: 'video/ogg' }],
  ['mov', { kind: 'video', type: 'video/quicktime' }],
  ['mkv', { kind: 'video', type: 'video/x-matroska' }],
  ['pdf', { kind: 'pdf', type: 'application/pdf' }],
]);

/** The kind of a file a page may show or link, or undefined for any other file. */
const kindOf = (key: string) => (isAttachment(key) ? KINDS.get(ext(key)) : undefined);

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Ignoring letter case first, for lists a person reads; then exactly, so the order never depends on where it runs. */
const byName = (a: string, b: string) => byText(a.toLowerCase(), b.toLowerCase()) || byText(a, b);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Whether a note's text says `publish: true` in its properties. False for anything else, and when the properties can not be read. */
export function publishes(text: string): boolean {
  const values = propertyValues(text, PUBLISH);
  if (values?.length !== 1 || values[0].toLowerCase() !== 'true') return false;
  const es = entries(frontmatter(text.startsWith(BOM) ? text.slice(1) : text)!.props)!;
  const keys = [...es.keys()].filter((k) => k.toLowerCase() === PUBLISH);
  if (keys.length !== 1) return false;
  // A value on the key's line is read alone, but YAML reads indented lines after it as more of that value: `true and more`.
  const [first, ...more] = splitLines(es.get(keys[0])!);
  const rest = first.slice(KEY.exec(first)![0].length).trim();
  return !rest || rest.startsWith('[') || rest.startsWith('#') || more.every((line) => /^[ \t]*(?:#.*)?\r?\n?$/.test(line));
}

/**
 * Whether a note is a page of a website of the whole vault: it is unless it has a `publish` property that does not say
 * true, as `publish: false` or an empty one. A note whose properties can not be read is not: it may be saying no.
 */
export function publishedInWhole(text: string): boolean {
  const fm = frontmatter(text.startsWith(BOM) ? text.slice(1) : text);
  if (!fm) return true;
  const es = entries(fm.props);
  if (!es) return false;
  return [...es.keys()].some((k) => k.toLowerCase() === PUBLISH) ? publishes(text) : true;
}

/** Whether a property's value, as Obsidian has read it, is what `publishes` takes for `publish: true`: true, the text "true", or a list of one of those. */
export function saysTrue(value: unknown): boolean {
  const one: unknown = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return one === true || (typeof one === 'string' && one.trim().toLowerCase() === 'true');
}

/** Whether a path is in a dot folder or is a dot file, as `.trash/` and `.obsidian/`. */
const dotted = (key: string) => key.split('/').some((part) => part.startsWith('.'));

/** Why a file is left out by its path alone, or undefined. */
function pathWhy(key: string, excluded: (key: string) => boolean): LeftOutWhy | undefined {
  const parts = key.split('/');
  if (excluded(key) || dotted(key)) return 'excluded';
  if (conflictOriginal(key) !== key) return 'conflict';
  // What the uploader refuses, and a lone surrogate, which no URL can carry.
  if (key.includes('\\') || hasControl(key) || /\p{Cs}/u.test(key) || parts.includes('')) return 'name';
  return undefined;
}

// Links.

/** The vault's files arranged for `resolveLink`. Built once per site. */
export interface LinkIndex {
  /** Every file, by vault key. */
  readonly keys: ReadonlySet<string>;
  /** Files by key in lower case, each list in plain string order. */
  readonly lower: ReadonlyMap<string, string[]>;
  /** Files by file name, each list in the order a tie is broken: fewest path segments, then plain string order. */
  readonly names: ReadonlyMap<string, string[]>;
  /** The same by file name in lower case, each with its key in lower case. */
  readonly lowerNames: ReadonlyMap<string, { key: string; lower: string }[]>;
}

/** The index `resolveLink` reads, of the files at these vault keys. */
export function linkIndex(keys: Iterable<string>): LinkIndex {
  const segments = (k: string) => k.split('/').length;
  const all = [...new Set([...keys].map(vaultKey))].map((key) => ({ key, n: segments(key) })).sort((a, b) => a.n - b.n || byText(a.key, b.key));
  const lower = new Map<string, string[]>();
  const names = new Map<string, string[]>();
  const lowerNames = new Map<string, { key: string; lower: string }[]>();
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const { key } of all) {
    const l = key.toLowerCase();
    add(lower, l, key);
    add(names, fileName(key), key);
    add(lowerNames, fileName(key).toLowerCase(), { key, lower: l });
  }
  for (const list of lower.values()) list.sort(byText);
  return { keys: new Set(all.map((f) => f.key)), lower, names, lowerNames };
}

/** `path` read from the folder `dir`, with `.` and `..` taken away; null when it climbs above the vault. */
function within(dir: string, path: string): string | null {
  const out = dir ? dir.split('/') : [];
  for (const part of path.split('/')) {
    if (part === '.') continue;
    if (part !== '..') out.push(part);
    else if (!out.pop()) return null;
  }
  return out.join('/');
}

/** A link's file, and whether another file matched it as well as this one did. */
export interface Resolved {
  key: string;
  /** More than one file matched at the step that found it, so a tie was broken: which file the author meant is a guess. */
  ambiguous: boolean;
}

/** The first item of `list` that `match` accepts, and whether a later one does too; undefined when none does. */
function first<T>(list: readonly T[] | undefined, match: (item: T) => boolean): { hit: T; more: boolean } | undefined {
  if (!list) return undefined;
  const i = list.findIndex(match);
  if (i < 0) return undefined;
  return { hit: list[i], more: list.some((item, j) => j > i && match(item)) };
}

/**
 * The file a link written in the note `from` leads to, among `files`, or null, and whether that was a guess between
 * several. The first that matches of: the vault path as written; the path from `from`'s folder, through `./` and `../`;
 * for a link without those, a file whose path ends with the link, the one with the fewest folders and then the first in
 * plain string order; then the same three ignoring letter case. Each tries the link as written, then with `.md` after
 * it. A link starting with `/` is only a path from the vault's top. Names compare in NFC. Only a match found ignoring
 * case, or by the end of the path, can be ambiguous.
 */
export function resolveLinkDetail(link: string, from: string, files: LinkIndex): Resolved | null {
  const written = link.normalize('NFC');
  const rooted = written.startsWith('/');
  const path = rooted ? written.replace(/^\/+/, '') : written;
  if (!path) return null;
  const forms = (p: string) => (/\.md$/i.test(p) ? [p] : [p, `${p}.md`]);
  const source = vaultKey(from);
  const relative = rooted ? null : within(source.slice(0, Math.max(0, source.lastIndexOf('/'))), path);
  const anywhere = !rooted && !path.split('/').some((part) => part === '.' || part === '..');
  for (const fold of [false, true]) {
    const exact = (p: string): Resolved | undefined => {
      if (!fold) return files.keys.has(p) ? { key: p, ambiguous: false } : undefined;
      const same = files.lower.get(p.toLowerCase());
      return same && { key: same[0], ambiguous: same.length > 1 };
    };
    const ending = (p: string): Resolved | undefined => {
      const l = p.toLowerCase();
      if (!fold) {
        const m = first(files.names.get(fileName(p)), (k) => k === p || k.endsWith(`/${p}`));
        // Obsidian ignores letter case in links, so a file of the same name in other case is as much a rival as one in the same.
        const rivals = (files.lowerNames.get(fileName(p).toLowerCase()) ?? []).filter((f) => f.lower === l || f.lower.endsWith(`/${l}`));
        return m && { key: m.hit, ambiguous: m.more || rivals.length > 1 };
      }
      const m = first(files.lowerNames.get(fileName(p).toLowerCase()), (f) => f.lower === l || f.lower.endsWith(`/${l}`));
      return m && { key: m.hit.key, ambiguous: m.more };
    };
    for (const p of forms(path)) {
      const hit = exact(p);
      if (hit) return hit;
    }
    if (relative !== null) {
      for (const p of forms(relative)) {
        const hit = exact(p);
        if (hit) return hit;
      }
    }
    if (anywhere) {
      for (const p of forms(path)) {
        const hit = ending(p);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** The file a link written in the note `from` leads to, among `files`, or null: `resolveLinkDetail` without whether it was a guess. */
export function resolveLink(link: string, from: string, files: LinkIndex): string | null {
  return resolveLinkDetail(link, from, files)?.key ?? null;
}

/**
 * The address of the site file `toKey` from the page `fromKey`: relative, so the site works in any folder of a bucket
 * and from disk, with each path segment percent-encoded. A page's address for itself is its file name.
 */
export function relativeHref(fromKey: string, toKey: string): string {
  const from = fromKey.split('/').slice(0, -1);
  const to = toKey.split('/');
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return '../'.repeat(from.length - same) + to.slice(same).map(encodeURIComponent).join('/');
}

// The site.

/** A note on the site. */
interface Page {
  path: string;
  key: string;
  /** Its file on the site. */
  site: string;
  /** Its text after the properties block. */
  body: string;
  /** Its `title` property, when that has one value. */
  named?: string;
  /** Its title once known: from `named`, its first heading or its file name. */
  title?: string;
  /** Its article, rendered. */
  article?: string;
  /** What rendering it met. */
  found?: Found;
}

/** What rendering a page met: links to nothing, links to notes not on the site, and the files it shows or links. */
interface Found {
  missing: Set<string>;
  unpublished: Set<string>;
  shows: Set<string>;
}

const NO_HOOKS: RenderHooks = { link: () => null, embed: () => null };
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Runs `work` on each item, `limit` at a time, and gives the results in the items' order. */
async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/** A page's title when it has no `title` property, from what rendering its body gave: the first heading when the body starts with one, else its file name. */
function titleFrom(p: Page, r: Rendered): string {
  return (r.startsWithH1 && oneLine(r.headings[0]?.text ?? '')) || fileName(p.key).slice(0, -3);
}

/** A whole HTML document for the site file `key`. */
function documentHtml(key: string, title: string, siteTitle: string, main: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="generator" content="Coffer">',
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="${escapeHtml(relativeHref(key, STYLE))}">`,
    '</head>',
    '<body>',
    `<header class="site"><a href="${escapeHtml(relativeHref(key, INDEX))}">${escapeHtml(siteTitle)}</a></header>`,
    '<main>',
    main,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

interface Folder {
  folders: Map<string, Folder>;
  pages: Page[];
}

/** The front page's list of `pages` as nested lists by folder: folders first, then pages, each by name ignoring letter case. */
function navHtml(pages: Page[]): string {
  const root: Folder = { folders: new Map(), pages: [] };
  for (const p of pages) {
    let f = root;
    for (const part of p.key.split('/').slice(0, -1)) {
      let sub = f.folders.get(part);
      if (!sub) f.folders.set(part, (sub = { folders: new Map(), pages: [] }));
      f = sub;
    }
    f.pages.push(p);
  }
  const list = (f: Folder): string => {
    const folders = [...f.folders].sort(([a], [b]) => byName(a, b)).map(([name, sub]) => `<li><span class="folder">${escapeHtml(name)}</span>\n${list(sub)}\n</li>`);
    const pages = f.pages
      .sort((a, b) => byName(a.title!, b.title!) || byText(a.key, b.key))
      .map((p) => `<li><a href="${escapeHtml(relativeHref(INDEX, p.site))}">${escapeHtml(p.title!)}</a></li>`);
    return `<ul>\n${[...folders, ...pages].join('\n')}\n</ul>`;
  };
  return `<nav class="pages">\n${list(root)}\n</nav>`;
}

/**
 * Builds the website from the vault: a page for each note that says publish: true, the files those pages show or
 * link, `index.html` and `site.css`. Reads every note, and of the other files only those a page shows or links. A file
 * that can not be read is treated as one that does not say publish, or as missing.
 */
export async function buildSite(vault: VaultReader, o: SiteOptions): Promise<Site> {
  const siteTitle = oneLine(o.title) || 'Notes';
  const listed = [...new Set(await vault.list())].map((path) => ({ path, key: vaultKey(path) })).sort((a, b) => byText(a.key, b.key) || byText(a.path, b.path));
  // Two paths can be one key (the same name listed in NFC and NFD): the first stands for it, the other is never read for the site.
  const pathOf = new Map<string, string>();
  for (const f of listed) if (!pathOf.has(f.key)) pathOf.set(f.key, f.path);
  const index = linkIndex(pathOf.keys());

  // A note in a dot folder (`.trash/`) is never a page, and not read: listing each as left out would only be noise.
  const notes = listed.filter((f) => isNote(f.key) && !dotted(f.key));
  const texts = await inParallel(notes, READS, async (f) => {
    try {
      const text = decoder.decode(await vault.read(f.path));
      return (o.whole ? publishedInWhole(text) : publishes(text)) ? text : undefined;
    } catch {
      return undefined;
    }
  });

  const leftOut = new Map<string, LeftOutWhy>();
  /** Notes that say publish but are left out, by key: a link to one is not a link to a note that does not say publish. */
  const outNotes = new Set<string>();
  const leave = (path: string, key: string, why: LeftOutWhy) => {
    leftOut.set(path, why);
    if (isNote(key)) outNotes.add(key);
  };
  const candidates: Page[] = [];
  notes.forEach((f, i) => {
    const text = texts[i];
    if (text === undefined) return;
    const why = pathWhy(f.key, o.excluded) ?? (f.path === pathOf.get(f.key) ? undefined : 'clash');
    // In a website of the whole vault, a note kept out by a setting or as a conflict copy is only worth a word when it asks to be on it.
    if (why) return o.whole && (why === 'excluded' || why === 'conflict') && !publishes(text) ? undefined : leave(f.path, f.key, why);
    const named = propertyValues(text, 'title');
    const bare = text.startsWith(BOM) ? text.slice(1) : text;
    const body = frontmatter(bare)?.body ?? bare;
    candidates.push({ path: f.path, key: f.key, site: '', body, named: named?.length === 1 && oneLine(named[0]) ? oneLine(named[0]) : undefined });
  });

  const wanted = vaultKey(o.home.trim());
  const chosen = wanted ? (candidates.find((p) => p.key === wanted) ?? candidates.find((p) => p.key === `${wanted}.md`)) : undefined;
  const home =
    chosen ??
    candidates.find((p) => !p.key.includes('/') && p.key.toLowerCase() === 'index.md');

  // A name taken, in lower case: some hosts, and every folder on macOS and Windows, take two names that differ only in case as one.
  const taken = new Set(RESERVED);
  const pages = new Map<string, Page>();
  if (home) {
    home.site = INDEX;
    pages.set(home.key, home);
  }
  for (const p of candidates) {
    if (p === home) continue;
    p.site = `${p.key.slice(0, -3)}.html`;
    if (taken.has(p.site.toLowerCase())) {
      leave(p.path, p.key, 'clash');
      continue;
    }
    taken.add(p.site.toLowerCase());
    pages.set(p.key, p);
  }
  const order = [...pages.values()].sort((a, b) => byText(a.key, b.key));

  /** Files a page showed that are not on the site after all: read and found missing, or another file's name in other letter case. */
  const dropped = new Map<string, 'missing' | 'clash'>();
  const fileWhy = new Map<string, LeftOutWhy | undefined>();
  // A heading's text does not depend on the hooks, so a page rendered without them has the title its own page shows.
  const titleOf = (p: Page) => (p.title ??= p.named ?? titleFrom(p, renderMarkdown(p.body, NO_HOOKS)));

  /** Where a link or embed in `page` leads on the site: a page, a file's key, or null; what it meets is noted in `found`. */
  const lead = (target: string, page: Page, found: Found): Page | string | null => {
    const resolved = resolveLinkDetail(target, page.key, index);
    const key = resolved?.key;
    if (key === undefined || dropped.get(key) === 'missing') {
      found.missing.add(target);
      return null;
    }
    const to = pages.get(key);
    if (to) return to;
    if (isNote(key)) {
      if (!outNotes.has(key)) found.unpublished.add(target);
      return null;
    }
    if (!kindOf(key) || dropped.has(key)) return null;
    if (!fileWhy.has(key)) fileWhy.set(key, pathWhy(key, o.excluded));
    // A guess between files of one name could publish a private one in place of the one the author sees.
    const why = resolved!.ambiguous ? 'ambiguous' : fileWhy.get(key);
    if (why) {
      leftOut.set(pathOf.get(key)!, why);
      return null;
    }
    found.shows.add(key);
    return key;
  };

  const render = (page: Page) => {
    const found: Found = { missing: new Set(), unpublished: new Set(), shows: new Set() };
    const href = (to: Page | string) => relativeHref(page.site, typeof to === 'string' ? to : to.site);
    const r = renderMarkdown(page.body, {
      link: (target) => {
        const to = lead(target, page, found);
        return to === null ? null : { href: href(to) };
      },
      embed: (target) => {
        const to = lead(target, page, found);
        if (to === null) return null;
        if (typeof to !== 'string') return { href: href(to), kind: 'note', title: titleOf(to) };
        return { href: href(to), kind: kindOf(to)!.kind };
      },
    });
    page.title ??= page.named ?? titleFrom(page, r);
    page.found = found;
    page.article = `<article>\n${r.startsWithH1 ? '' : `<h1 class="title">${escapeHtml(page.title)}</h1>\n`}${r.html}\n</article>`;
  };
  for (const p of order) render(p);

  // Files join only through what the pages showed, never by reading the notes' text: what a comment names stays out.
  const shown = [...new Set(order.flatMap((p) => [...p.found!.shows]))].sort(byText);
  const joining: string[] = [];
  for (const key of shown) {
    if (taken.has(key.toLowerCase())) {
      dropped.set(key, 'clash');
      leftOut.set(pathOf.get(key)!, 'clash');
    } else {
      taken.add(key.toLowerCase());
      joining.push(key);
    }
  }
  const data = await inParallel(joining, READS, async (key) => {
    try {
      return await vault.read(pathOf.get(key)!);
    } catch {
      return undefined;
    }
  });
  joining.forEach((key, i) => {
    if (!data[i]) dropped.set(key, 'missing');
  });
  // Rendering again only takes away: a page that showed a dropped file now shows it as missing or not at all.
  if (dropped.size) for (const p of order) if ([...p.found!.shows].some((k) => dropped.has(k))) render(p);

  const files = new Map<string, SiteFile>();
  const html = (s: string): SiteFile => ({ data: encoder.encode(s), type: HTML_TYPE });
  for (const p of order) if (p !== home) files.set(p.site, html(documentHtml(p.site, `${p.title} – ${siteTitle}`, siteTitle, p.article!)));
  const others = order.filter((p) => p !== home);
  const front = [
    home ? home.article! : `<h1 class="title">${escapeHtml(siteTitle)}</h1>`,
    ...(others.length ? [navHtml(others)] : home ? [] : ['<p class="empty">Nothing has been published here yet.</p>']),
  ];
  files.set(INDEX, html(documentHtml(INDEX, siteTitle, siteTitle, front.join('\n'))));
  files.set(STYLE, { data: encoder.encode(THEME), type: CSS_TYPE });
  const attachments: SiteReport['attachments'] = [];
  joining.forEach((key, i) => {
    const bytes = data[i];
    if (!bytes) return;
    files.set(key, { data: bytes, type: KINDS.get(ext(key))?.type ?? 'application/octet-stream' });
    attachments.push({ path: pathOf.get(key)!, key, size: bytes.length });
    // Another page showed it by a name only it has: on the site after all, though the guess still shows nothing.
    if (leftOut.get(pathOf.get(key)!) === 'ambiguous') leftOut.delete(pathOf.get(key)!);
  });

  const links = (which: 'missing' | 'unpublished') =>
    order.flatMap((p) => [...p.found![which]].map((link) => ({ from: p.path, link }))).sort((a, b) => byText(a.from, b.from) || byText(a.link, b.link));
  const byPath = (a: { path: string }, b: { path: string }) => byText(a.path, b.path);
  return {
    files: new Map([...files].sort(([a], [b]) => byText(a, b))),
    report: {
      pages: order.map((p) => ({ path: p.path, key: p.site, title: p.title! })).sort(byPath),
      attachments: attachments.sort(byPath),
      unpublished: links('unpublished'),
      missing: links('missing'),
      whole: !!o.whole,
      homeNotFound: wanted && !chosen ? o.home.trim() : '',
      leftOut: [...leftOut].map(([path, why]) => ({ path, why })).sort(byPath),
    },
  };
}
