// Notes shared by a property. On the one device that sends them (the hub), a shared folder with members whose
// contents are the notes whose properties say `share: <name>`, with the pictures, sound, video and PDF files they show,
// at their paths in the vault. The files stay in the vault's own sync. The share only sends: its file system can not
// write, rename or remove anything, and the people invited may only read, or read and suggest. Leaving the share never
// depends on reading a property or Obsidian's cache: a file the share holds stays in it while it exists, until the
// sharer removes it with the command. The property and the cache can only add files, each checked against its bytes now.
// No Obsidian import, so it runs under plain Node tests.
import type { Arrival } from '../core/engine.ts';
import { KEY, entries, frontmatter, splitLines } from '../core/merge.ts';
import { conflictOriginal, ext, fileName, vaultKey } from '../core/paths.ts';
import { plural } from '../core/text.ts';
import type { FileStat, Held, LocalFS, LocalFile } from '../core/types.ts';
import type { Problem } from './status.ts';

/** The property a note carries to be shared: `share: Family`, or a list holding Family. */
export const PROPERTY = 'share';

const ATTACHMENTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'mp3', 'wav', 'm4a', 'ogg', 'flac', '3gp', 'webm', 'mp4', 'ogv', 'mov', 'mkv', 'pdf']);

export const isNote = (key: string) => ext(key) === 'md';
/** Pictures, sound, video and PDF files, which a shared note may show. */
export const isAttachment = (key: string) => ATTACHMENTS.has(ext(key));
/** The only kinds of file a share by property holds. Nothing that runs, nor a canvas or base, which can show any note. */
export const allowed = (key: string) => isNote(key) || isAttachment(key);

const folded = (v: string) => v.normalize('NFC').trim().toLowerCase();
const same = (a: string, b: string) => folded(a) === folded(b);

// Reading the property. The properties block is cut as the merge cuts it (`frontmatter`, `entries`), so a note reads
// the same here as there; a block that can not be read that way names no share.

/** A plain or quoted value as YAML reads it, without a comment after it; undefined for anything else. */
function scalar(raw: string): string | undefined {
  if (raw.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/.exec(raw);
    return m?.[1].replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t' })[c] ?? c);
  }
  if (raw.startsWith("'")) return /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/.exec(raw)?.[1].replace(/''/g, "'");
  const v = raw.replace(/[ \t]+#.*$/, '').trim();
  if (!v || /^(?:[[\]{}&*!|>%@`#]|[-?](?:[ \t]|$))/.test(v) || /:(?:[ \t]|$)/.test(v)) return undefined;
  return v;
}

/** The items of an inline list, `[a, "b"]`; undefined when it is not one. */
function flowList(raw: string): string[] | undefined {
  const items: string[] = [];
  let cur = '';
  const push = (): boolean => {
    const t = cur.trim();
    cur = '';
    if (!t) return true;
    const v = scalar(t);
    if (v === undefined) return false;
    items.push(v);
    return true;
  };
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      const re = ch === '"' ? /"(?:[^"\\]|\\.)*"/y : /'(?:[^']|'')*'/y;
      re.lastIndex = i;
      const m = re.exec(raw);
      if (!m) return undefined;
      cur += m[0];
      i += m[0].length - 1;
    } else if (ch === ',') {
      if (!push()) return undefined;
    } else if (ch === ']') {
      const after = raw.slice(i + 1).trim();
      if ((after && !after.startsWith('#')) || !push()) return undefined;
      return items;
    } else if (ch === '[' || ch === '{') return undefined;
    else cur += ch;
  }
  return undefined;
}

const withoutEol = (line: string) => line.replace(/\r?\n$/, '');

/**
 * One entry's head (`share:`), the rest of its first line, and how its lines end; and `after`, the blank lines and
 * comments after its last value, which an edit keeps: a comment there may be about the key below.
 */
function entryParts(entry: string) {
  const lines = splitLines(entry);
  const head = KEY.exec(lines[0])?.[0] ?? '';
  const last = lines.findLastIndex((l: string, i: number) => !i || !/^[ \t]*(?:#|$)/.test(withoutEol(l)));
  return { lines, head, rest: withoutEol(lines[0].slice(head.length)), eol: /\r?\n$/.exec(lines[0])?.[0] ?? '\n', after: lines.slice(last + 1).join('') };
}

/** The values of one entry: a value, an inline list or one `- item` line each. [] when empty; undefined when it can not be read. */
function entryValues(entry: string): string[] | undefined {
  const { lines, rest } = entryParts(entry);
  const first = rest.trim();
  if (first.startsWith('[')) return flowList([first, ...lines.slice(1).map((l) => withoutEol(l).trim())].join(' '));
  if (first && !first.startsWith('#')) {
    const v = scalar(first);
    return v === undefined ? undefined : [v];
  }
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    const t = withoutEol(line);
    if (!t.trim() || /^[ \t]*#/.test(t)) continue;
    const m = /^[ \t]*-(?:[ \t]+(.*))?$/.exec(t);
    if (!m) return undefined;
    if (m[1] === undefined || !m[1].trim()) continue;
    const v = scalar(m[1].trim());
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}

/** The entries of a properties block for the property `key`, by key as written: in any letter case, as Obsidian takes property names. */
const propertyKeys = (es: Map<string, string>, key: string) => [...es.keys()].filter((k) => k && k.toLowerCase() === key.toLowerCase());

/** Every value a note's text gives the property `key` (in any letter case): a value, an inline list or `- item` lines; undefined when its properties can not be read. */
export function propertyValues(text: string, key: string): string[] | undefined {
  const fm = frontmatter(text.startsWith(BOM) ? text.slice(1) : text);
  if (!fm) return [];
  const es = entries(fm.props);
  if (!es) return undefined;
  return propertyKeys(es, key).flatMap((k) => entryValues(es.get(k)!) ?? []);
}

/** What a note's property `share` says, read from its text: every value under that key; undefined when its properties can not be read. */
export function shareValues(text: string): string[] | undefined {
  return propertyValues(text, PROPERTY);
}

/** Whether a note's text says `share: <name>`, alone or in a list, in any letter case. */
export const carries = (text: string, name: string) => !!shareValues(text)?.some((v) => same(v, name));

/** A byte order mark, which an editor may keep before the properties block: edits go after it. */
const BOM = '\uFEFF';
const withBom = (text: string | undefined) => (text === undefined ? undefined : BOM + text);

/** `v` written so that it reads back as itself, alone or in an inline list. */
function written(v: string): string {
  const plain = v === v.trim() && /^[^\s"'#,[\]{}&*!|>%@`?:-][^,[\]{}#:"]*$/.test(v) && !/^(?:true|false|yes|no|on|off|null|~|[-+]?[\d._]+(?:e[-+]?\d+)?)$/i.test(v);
  return plain ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `text` with `name` taken out of its property `share`: the value goes, or that item of a list. Every other byte stays
 * as it was, line endings and comments included; a properties block left empty goes too. Undefined when its
 * properties can not be read.
 */
export function withoutShare(text: string, name: string): string | undefined {
  if (text.startsWith(BOM)) return withBom(withoutShare(text.slice(1), name));
  const fm = frontmatter(text);
  if (!fm) return text;
  const es = entries(fm.props);
  if (!es) return undefined;
  const keys = new Set(propertyKeys(es, PROPERTY));
  let props = '';
  for (const [key, entry] of es) props += keys.has(key) ? dropValue(entry, name) : entry;
  if (props === fm.props) return text;
  return props ? fm.open + props + fm.close + fm.body : fm.body;
}

function dropValue(entry: string, name: string): string {
  const values = entryValues(entry);
  if (!values) return entry;
  const keep = values.filter((v) => !same(v, name));
  if (keep.length === values.length) return entry;
  const { lines, head, rest, eol, after } = entryParts(entry);
  if (!keep.length) return after;
  if (rest.trim().startsWith('[')) return `${head} [${keep.map(written).join(', ')}]${eol}${after}`;
  return lines
    .filter((line, i) => {
      const m = i ? /^[ \t]*-[ \t]+(.*)$/.exec(withoutEol(line)) : null;
      return !m || !same(scalar(m[1].trim()) ?? '', name);
    })
    .join('');
}

/**
 * `text` with `name` added to its property `share`: a new line, a value turned into a list, or one more item. Every
 * other byte stays as it was. A note without properties gets a block with only this. Undefined when its properties can
 * not be read, or its share property holds something other than plain values.
 */
export function withShare(text: string, name: string): string | undefined {
  if (text.startsWith(BOM)) return withBom(withShare(text.slice(1), name));
  const fm = frontmatter(text);
  const eol = /\r?\n/.exec(fm?.open ?? text)?.[0] ?? '\n';
  const line = `${PROPERTY}: ${written(name)}${eol}`;
  if (!fm) return `---${eol}${line}---${eol}${text}`;
  const es = entries(fm.props);
  if (!es) return undefined;
  const key = propertyKeys(es, PROPERTY)[0];
  if (key === undefined) return fm.open + fm.props + line + fm.close + fm.body;
  const entry = es.get(key)!;
  const values = entryValues(entry);
  if (!values) return undefined;
  if (values.some((v) => same(v, name))) return text;
  const { lines, head, rest, after } = entryParts(entry);
  let edited: string;
  if (rest.trim() && !rest.trim().startsWith('#')) edited = `${head} [${[...values, name].map(written).join(', ')}]${eol}${after}`;
  else {
    const last = lines.findLastIndex((l: string, i: number) => i > 0 && /^[ \t]*-[ \t]/.test(l));
    if (last < 0) edited = `${head} ${written(name)}${eol}${lines.slice(1).join('')}`;
    else {
      const indent = /^[ \t]*/.exec(lines[last])![0];
      edited = [...lines.slice(0, last + 1), `${indent}- ${written(name)}${eol}`, ...lines.slice(last + 1)].join('');
    }
  }
  let props = '';
  for (const [k, e] of es) props += k === key ? edited : e;
  return fm.open + props + fm.close + fm.body;
}

/**
 * The link paths a note's text embeds, `![[target|alias]]` and `![alt](target)`, without alias, heading or block, and
 * without web addresses. For telling which embeds a change brings; what joins the share is checked with Obsidian's own reading.
 */
export function embedLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/!\[\[([^\]\r\n]+?)\]\]/g)) {
    const link = m[1].split('|')[0].split('#')[0].trim();
    if (link) out.add(link);
  }
  for (const m of text.matchAll(/!\[[^\]\r\n]*\]\([ \t]*(<[^>\r\n]+>|[^)\s]+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*\)/g)) {
    let link = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    try {
      link = decodeURIComponent(link);
    } catch {
      // Left as written, as Obsidian does with an escape cut short.
    }
    link = link.split('#')[0].trim();
    if (link) out.add(link);
  }
  return [...out];
}

/** What Obsidian has read of the vault: the properties and links of each note. A first guess only; bytes decide. */
export interface Catalog {
  /** Obsidian has read every file since the app started. Until then nothing new joins; what the share holds still syncs. */
  ready(): boolean;
  /** The notes whose properties, as read, name `name` under `share`. */
  tagged(name: string): string[];
  /** What `note` embeds, as read: each link as written in it, and the file it leads to now, if any. */
  embeds(note: string): { original: string; target: string | null }[];
  /** The file a link in `from` leads to now, if any. */
  resolve(link: string, from: string): string | null;
}

/** What a share by property keeps in settings (`Share`). */
export interface PropertyShare {
  /** Its name, and the value its notes carry. */
  property: string;
  /** Files the sharer took out (removed, or "Don't share"), by key. Nothing puts them back but sharing them again. */
  removed: string[];
  /** Attachments the sharer said to share that waited first, by key. */
  approved: string[];
  /** Attachments that wait for the sharer because a suggestion taken in made a shared note show them, by key. */
  ask: string[];
}

/**
 * Whether Obsidian has read the vault already for a copy of the plugin that loaded after the app had started
 * (`loadedLate`), as when it is turned on or updated: that copy hears no 'resolved' until something changes. Read means
 * every note has its properties read (`cached`) and its links resolved in this session (`resolved`); a note the app is
 * still reading, new or changed while it was closed, lacks one or the other until it is done. At the app's start
 * plugins load before Obsidian reads the vault, and wait for 'resolved' instead.
 */
export function readAlready(loadedLate: boolean, notes: string[], cached: (path: string) => boolean, resolved: (path: string) => boolean): boolean {
  return loadedLate && notes.every((p) => cached(p) && resolved(p));
}

/** What one listing found, for the engine and for "What's shared". */
export interface Survey {
  /** In the share now, by key, with each file's path and stat here. */
  shared: Map<string, LocalFile>;
  /** The files the engine held when it asked, by key. */
  held: Set<string>;
  /** Of `shared`, those that joined in this listing. */
  fresh: string[];
  /** Held files found at another path now, `[from, to]`. */
  moved: [string, string][];
  /** Held files gone from the vault and found nowhere else: deleted for the others at the sync, unless kept in the share. */
  stored: string[];
  /** Held notes whose properties no longer say share: <name>. Neither sent nor deleted until the sharer chooses. */
  unmarked: string[];
  /** Attachments a shared note shows that wait for the sharer: their name is not unique in the vault, or a suggestion taken in brought them. */
  waiting: { key: string; note: string; why: 'name' | 'suggested' }[];
  /** Attachments in the share that no shared note shows now. Known only once the cache is ready. */
  unused: string[];
  /** Files taken out with the command that a shared note shows, or whose properties say share: <name> again, as read by the cache. */
  removedTagged: string[];
  /** Notes, and attachments a shared note shows, that the share can not hold: left out of this vault's sync, or a conflict copy of a note not shared. */
  notShared: { key: string; why: 'excluded' | 'conflict' }[];
  /** Obsidian had read the vault, so files could join. */
  ready: boolean;
}

/** The vault's file list came back empty while the share holds files: listing it as empty would delete them for everyone. */
export class VaultNotListedError extends Error {
  constructor() {
    super("This vault's file list is empty, so nothing was sent. The shared notes would otherwise look deleted.");
  }
}

/** The hub's vault only receives changes: a share by property can only be sent from a device that sends this vault's changes. */
export class NotSendingError extends Error {
  constructor() {
    super('This device only receives this vault’s changes, so it can not send notes shared by a property.');
  }
}

/** Another device signed changes to a share by property as its sender: only one device may send it. */
export class OtherSenderError extends Error {
  readonly device: string;
  constructor(device: string) {
    super(`Another of your devices (${device}) also sends these notes`);
    this.device = device;
  }
}

/** The device other than `device` whose commits arrived signed by `member`, this hub's own member, if any (see `OtherSenderError`). */
export function otherSender(arrived: Arrival[], member: string | undefined, device: string): string | undefined {
  return member ? arrived.find((a) => a.signer === member && a.device !== device)?.device : undefined;
}

/** The most of the files found at other paths that one listing reads to tell moves apart by their content: bytes, files. */
const MOVE_READ = { bytes: 32 << 20, files: 2000 };

/**
 * Held files that are gone from where they were and found at another path, `[from, to]`: a file that is not held,
 * with the same extension and the very size and time a gone one had when last synced. Renames and moves keep both,
 * also when this vault's sync brings a move made on another device. Where several files have the same size and time,
 * as files made together and moved as a folder, what decides is their content when the listing can name it
 * (`content`, reading at most `MOVE_READ`), and otherwise the file name, then the most folders in common from the
 * end. Anything less clear is not a move: the gone file is deleted for the others, the sharer keeps the other.
 */
export async function findMoves(
  gone: string[],
  was: (key: string) => FileStat | undefined,
  candidates: Map<string, LocalFile>,
  content?: NonNullable<Held['content']> & { read(key: string): Promise<Uint8Array> },
): Promise<[string, string][]> {
  const id = (s: FileStat) => `${s.size}:${s.mtime}`;
  const add = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const found = new Map<string, string[]>();
  for (const [key, f] of candidates) add(found, id(f), key);
  const lost = new Map<string, string[]>();
  for (const key of gone) {
    const s = was(key);
    if (s && s.size >= 0) add(lost, id(s), key);
  }
  const out: [string, string][] = [];
  const budget = { ...MOVE_READ };
  for (const [k, from] of lost) {
    const to = found.get(k);
    if (!to) continue;
    if (from.length === 1 && to.length === 1) {
      if (ext(from[0]) === ext(to[0])) out.push([from[0], to[0]]);
      continue;
    }
    const kinds = new Set(from.map(ext));
    const read = to.filter((t) => kinds.has(ext(t)));
    const bytes = was(from[0])!.size * read.length;
    let pairs: [string, string][] = [];
    if (content && bytes <= budget.bytes && read.length <= budget.files) {
      budget.bytes -= bytes;
      budget.files -= read.length;
      const byContent = new Map<string, string[]>();
      for (const f of from) {
        const c = content.of(f);
        if (c !== undefined) add(byContent, c, f);
      }
      for (const t of read) {
        // Gone again since the listing: not a move this time.
        const data = await content.read(t).catch(() => undefined);
        const same = (data && byContent.get(await content.id(data))) || [];
        for (const f of same) if (ext(f) === ext(t)) pairs.push([f, t]);
      }
    } else {
      const byName = new Map<string, string[]>();
      for (const t of read) add(byName, fileName(t), t);
      for (const f of from) for (const t of byName.get(fileName(f)) ?? []) if (ext(f) === ext(t)) pairs.push([f, t]);
    }
    out.push(...clearPairs(pairs));
  }
  return out;
}

/**
 * Of `pairs`, each a file gone and one found that could be it, those that are clear: one that nothing else could be,
 * then of the rest, with the same file name, the one that has the most folders in common with it from the end.
 */
function clearPairs(pairs: [string, string][]): [string, string][] {
  const best = (list: [string, string][], score: (p: [string, string]) => number) => {
    const top = [new Map<string, { s: number; n: number }>(), new Map<string, { s: number; n: number }>()];
    const scored = list.map((p) => ({ p, s: score(p) }));
    for (const { p, s } of scored) {
      for (const side of [0, 1] as const) {
        const t = top[side].get(p[side]);
        if (!t || s > t.s) top[side].set(p[side], { s, n: 1 });
        else if (s === t.s) t.n++;
      }
    }
    const alone = ({ p, s }: { p: [string, string]; s: number }) =>
      ([0, 1] as const).every((side) => {
        const t = top[side].get(p[side])!;
        return t.s === s && t.n === 1;
      });
    return scored.filter(alone).map(({ p }) => p);
  };
  const out = best(pairs, () => 0);
  const taken = new Set(out.flat());
  const rest = pairs.filter(([a, b]) => !taken.has(a) && !taken.has(b) && fileName(a) === fileName(b));
  const common = ([a, b]: [string, string]) => {
    const x = a.split('/').reverse();
    const y = b.split('/').reverse();
    let n = 0;
    while (n < x.length && n < y.length && x[n] === y[n]) n++;
    return n;
  };
  return [...out, ...best(rest, common)];
}

export interface PropertyOptions {
  /** The vault's files, as Obsidian's index has them, read and asked about on disk. */
  inner: LocalFS;
  catalog: Catalog;
  /** The share's settings, read anew at every listing. */
  share: () => PropertyShare;
  /** What this share leaves out: what the vault's sync leaves out here, with every other shared folder, the settings folder and dot paths. */
  excluded: (key: string) => boolean;
}

const decoder = new TextDecoder();
const NOTHING_HELD: Held = { get: () => undefined, keys: () => [] };

/**
 * The vault as the engine of a share by property sees it: only the files in the share, at their vault paths. It can not
 * write or remove anything: a share by property only sends.
 */
export class PropertyFS implements LocalFS {
  private o: PropertyOptions;
  /** What the engine's last listing found: what `sends` and "What's shared" go by. */
  private view?: Survey;
  private lastHeld?: Held;
  /** Notes read since they last changed, with whether they said share: <name>, by key. */
  private checked = new Map<string, { size: number; mtime: number; name: string; says: boolean }>();

  constructor(o: PropertyOptions) {
    this.o = o;
  }

  get name(): string {
    return this.o.share().property;
  }

  /** The vault path of `path`; refused for anything the share could not hold. */
  pathOf(path: string): string {
    if (path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) throw new Error(`"${path}" is not a path in this vault`);
    const key = vaultKey(path);
    if (!allowed(key)) throw new Error(`“${fileName(path)}” is not a note, picture, sound, video or PDF file, so it is not shared by a property`);
    if (this.o.excluded(key)) throw new Error(`“${path}” is left out of what “${this.name}” can share`);
    return path;
  }

  /**
   * The files in the share. With `held` (the engine's listing), what it finds is kept for `sends` and `survey`; without,
   * as for a screen, the engine's last `held` stands in and nothing is kept.
   */
  async list(held?: Held): Promise<LocalFile[]> {
    const survey = await this.look(held ?? this.lastHeld ?? NOTHING_HELD);
    if (held) {
      this.lastHeld = held;
      this.view = survey;
    }
    return [...survey.shared.values()];
  }

  /**
   * Whether the engine may sync `key` now: a note or attachment, and not a shared note whose properties no longer say
   * share: <name>, which waits for the sharer. What it may not sync it neither sends nor deletes.
   */
  sends(key: string): boolean {
    return allowed(key) && !this.view?.unmarked.includes(key);
  }

  /** What the engine's last listing found; undefined before one. */
  survey(): Survey | undefined {
    return this.view;
  }

  /** The share as it would be now if it held nothing yet: what starting it would send. */
  preview(): Promise<Survey> {
    return this.look(NOTHING_HELD);
  }

  /** The share as it is now, read without syncing and kept nowhere: for a screen. `held` is what the engine holds (`SyncEngine.held`). */
  peek(held?: Held): Promise<Survey> {
    return this.look(held ?? this.lastHeld ?? NOTHING_HELD);
  }

  read(path: string): Promise<Uint8Array> {
    return this.o.inner.read(this.pathOf(path));
  }

  stat(path: string): Promise<FileStat | null> {
    return this.o.inner.stat(this.pathOf(path));
  }

  write(path: string): Promise<FileStat> {
    return Promise.reject(new Error(`“${this.name}” only sends: “${path}” was not written into this vault through it`));
  }

  remove(path: string): Promise<void> {
    return Promise.reject(new Error(`“${this.name}” only sends: “${path}” was not removed from this vault through it`));
  }

  /** Whether the note at `key`, as it is now (`f`), says share: <name>. A note read before and unchanged since is not read again. */
  private async says(key: string, f: LocalFile, name: string): Promise<boolean> {
    const known = this.checked.get(key);
    if (known && known.size === f.size && known.mtime === f.mtime && known.name === name) return known.says;
    const says = carries(decoder.decode(await this.o.inner.read(f.path)), name);
    this.checked.set(key, { size: f.size, mtime: f.mtime, name, says });
    return says;
  }

  private async look(held: Held): Promise<Survey> {
    const { inner, catalog, excluded } = this.o;
    const s = this.o.share();
    const name = s.property;
    const removed = new Set(s.removed.map(vaultKey));
    const index = await inner.list();
    const all = new Set<string>();
    const present = new Map<string, LocalFile>();
    const names = new Map<string, number>();
    for (const f of index) {
      const key = vaultKey(f.path);
      all.add(key);
      const base = fileName(key).toLowerCase();
      names.set(base, (names.get(base) ?? 0) + 1);
      if (allowed(key) && !excluded(key) && !present.has(key)) present.set(key, f);
    }
    const heldKeys = [...held.keys()].filter((k) => allowed(k) && !excluded(k));
    if (!index.length && heldKeys.length) throw new VaultNotListedError();
    const lower = new Set([...all].map((k) => k.toLowerCase()));

    // What the share holds stays while it exists: nothing here asks the property or the cache.
    const shared = new Map<string, LocalFile>();
    const gone: string[] = [];
    for (const key of heldKeys) {
      if (removed.has(key)) continue;
      const f = present.get(key);
      if (f) {
        shared.set(key, f);
        continue;
      }
      // Missing from the index can mean not in it yet, as just after a file was written. Not when the index has it in
      // other letter case: a disk that ignores case answers for the old name of a file renamed that way.
      const st = lower.has(key.toLowerCase()) ? null : await inner.stat(key).catch(() => null);
      if (st) shared.set(key, { path: key, ...st });
      else gone.push(key);
    }
    const unheld = new Map([...present].filter(([key]) => !held.get(key) && !removed.has(key)));
    const pairs = await findMoves(gone, (k) => held.get(k), unheld, held.content && { ...held.content, read: (k) => inner.read(unheld.get(k)!.path) });
    const moved: [string, string][] = [];
    // A note found that way must still say share: <name>, so a private note that happens to match brings nothing in.
    for (const [a, b] of pairs) if (isNote(b) && (await this.says(b, present.get(b)!, name))) moved.push([a, b]);
    const from = new Map<string, string>();
    for (const [a, b] of moved) {
      shared.set(b, present.get(b)!);
      from.set(b, a);
    }

    // A held note that changed since it was last sent is sent only while it still says share: <name>.
    const unmarked: string[] = [];
    for (const [key, f] of shared) {
      if (!isNote(key)) continue;
      const was = held.get(from.get(key) ?? key);
      if (was && was.size === f.size && was.mtime === f.mtime) continue;
      if (!(await this.says(key, f, name))) unmarked.push(key);
    }
    for (const key of unmarked) shared.delete(key);

    const texts = new Map<string, string>();
    const text = async (note: string) => {
      let t = texts.get(note);
      if (t === undefined) texts.set(note, (t = decoder.decode(await inner.read(shared.get(note)!.path))));
      return t;
    };
    // An attachment found that way must be named in a shared note now, so a private copy that happens to match brings nothing in.
    for (const [a, b] of pairs) {
      if (isNote(b)) continue;
      for (const note of [...shared.keys()].filter(isNote)) {
        if (!mentions(await text(note), b)) continue;
        moved.push([a, b]);
        shared.set(b, present.get(b)!);
        break;
      }
    }
    const stored = gone.filter((key) => !moved.some(([a]) => a === key));

    const fresh: string[] = [];
    const notShared: Survey['notShared'] = [];
    const join = (key: string) => {
      shared.set(key, present.get(key)!);
      fresh.push(key);
    };
    for (const key of s.approved.map(vaultKey)) if (!shared.has(key) && !removed.has(key) && present.has(key) && isAttachment(key)) join(key);

    const ready = catalog.ready();
    const waiting: Survey['waiting'] = [];
    const unused: string[] = [];
    const removedTagged: string[] = [];
    if (ready) {
      const tagged = [...new Set(catalog.tagged(name).map(vaultKey))].sort();
      const copies: string[] = [];
      for (const key of tagged) {
        if (!isNote(key) || shared.has(key) || unmarked.includes(key)) continue;
        if (removed.has(key)) {
          if (present.has(key)) removedTagged.push(key);
          continue;
        }
        const f = present.get(key);
        if (!f) {
          if (all.has(key)) notShared.push({ key, why: 'excluded' });
          continue;
        }
        if (conflictOriginal(key) !== key) copies.push(key);
        else if (await this.says(key, f, name)) join(key);
      }
      // A conflict copy joins only beside the note it was made from: never in place of one taken out.
      for (const key of copies) {
        if (!shared.has(vaultKey(conflictOriginal(key)))) notShared.push({ key, why: 'conflict' });
        else if (await this.says(key, present.get(key)!, name)) join(key);
      }

      const ask = new Set(s.ask.map(vaultKey));
      const shown = new Set<string>();
      for (const note of [...shared.keys()].filter(isNote)) {
        for (const e of catalog.embeds(note)) {
          if (!e.target) continue;
          const key = vaultKey(e.target);
          shown.add(key);
          // Taken out, and shown again: listed, so that sharing it again is a tap away.
          if (removed.has(key) && isAttachment(key) && present.has(key) && !removedTagged.includes(key)) removedTagged.push(key);
          if (shared.has(key) || removed.has(key) || !isAttachment(key) || waiting.some((w) => w.key === key)) continue;
          if (!present.has(key)) {
            if (all.has(key) && !notShared.some((n) => n.key === key)) notShared.push({ key, why: 'excluded' });
            continue;
          }
          if (ask.has(key)) waiting.push({ key, note, why: 'suggested' });
          else if ((names.get(fileName(key).toLowerCase()) ?? 0) > 1) waiting.push({ key, note, why: 'name' });
          else if ((await text(note)).includes(e.original)) join(key);
        }
      }
      // A note that no longer says share is still in the share, and still shows its files there; nothing new joins through it.
      for (const note of unmarked) for (const e of catalog.embeds(note)) if (e.target) shown.add(vaultKey(e.target));
      const approved = new Set(s.approved.map(vaultKey));
      for (const key of shared.keys()) if (isAttachment(key) && !shown.has(key) && !approved.has(key)) unused.push(key);
    }
    return { shared, held: new Set(heldKeys), fresh, moved, stored, unmarked, waiting, unused: unused.sort(), removedTagged, notShared, ready };
  }
}

/**
 * Why a suggested note may not be written at vault path `key` for share `name`, or '' when it may. It may go where no
 * file is, or over a note in the share; never over a file of the vault that is not in it, whatever the letter case.
 */
export function writeProblem(key: string, name: string, o: { excluded: (key: string) => boolean; exists: (key: string) => string | undefined; shared: (key: string) => boolean }): string {
  if (!isNote(key)) return `Only notes can be taken into “${name}”.`;
  if (o.excluded(key)) return `“${key}” is left out of what “${name}” can share, so it can not be taken in.`;
  const there = o.exists(key);
  if (there !== undefined && there !== key) return `“${there}” has this name in other letter case, so it is not written over. To take this in, rename it first.`;
  if (there !== undefined && !o.shared(key)) return `“${there}” is a note of yours that is not in “${name}”, so it is not written over. To take this in, rename yours first.`;
  return '';
}

/** The attachments `after` embeds that `before` did not, as links. A suggestion taken in makes these wait for the sharer. */
export function newEmbeds(before: string, after: string): string[] {
  const had = new Set(embedLinks(before));
  return embedLinks(after).filter((link) => !had.has(link));
}

/**
 * The sharer's choices kept in settings, without what no longer needs keeping: a file taken out or said yes to stays
 * listed while it exists (`exists`) or the engine still holds it; a waiting one while it exists and was not decided.
 */
export function settleChoices(s: PropertyShare, exists: (key: string) => boolean, held: ReadonlySet<string>): Pick<PropertyShare, 'removed' | 'approved' | 'ask'> {
  const kept = (key: string) => exists(vaultKey(key)) || held.has(vaultKey(key));
  const removed = s.removed.filter(kept);
  const approved = s.approved.filter((k) => kept(k) && !removed.includes(k));
  const ask = s.ask.filter((k) => exists(vaultKey(k)) && !removed.includes(k) && !approved.includes(k));
  return { removed, approved, ask };
}

/** Whether a note's `text` names the file at `key`: its file name as written, or as a link writes it, in any letter case. */
function mentions(text: string, key: string): boolean {
  const base = fileName(key).toLowerCase();
  const t = text.toLowerCase();
  return t.includes(base) || t.includes(encodeURI(base));
}

/**
 * What removing `note` from the share takes with it when the sharer asks: the attachments in the share it shows that no
 * other note in the share mentions by name, read from each one's bytes now.
 */
export function onlyShownBy(note: string, shows: string[], others: { key: string; text: string }[]): string[] {
  return shows.filter((key) => !others.some((o) => o.key !== note && mentions(o.text, key)));
}

/** Why notes shared by a property named `name` can not start on this device, or '' when they can. */
export function startProblem(s: { readOnly: boolean; shares: { property: string }[] }, name: string): string {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (n.length > 60) return 'Use a shorter name.';
  if (/[\\/:*?"<>|#^[\]\r\n]/.test(n) || n.startsWith('.')) return 'A name can not hold / \\ : * ? " < > | # ^ [ ] or start with a dot. People get the notes in a folder with this name.';
  const problem = sendProblem(s);
  if (problem) return problem.message;
  const other = s.shares.find((x) => x.property);
  if (other) return `This vault already shares notes by a property, as “${other.property}”. A vault can have one such share.`;
  return '';
}

/** A device that only receives this vault's changes can not send a share by property; undefined when it can. */
export const sendProblem = (s: { readOnly: boolean }) => (s.readOnly ? new NotSendingError() : undefined);

/** Why an invite to `share` for `role` can not be made, or ''. People may read notes shared by a property, or read and suggest; never change them. */
export function inviteProblem(share: { property: string }, role: 'write' | 'read'): string {
  return share.property && role === 'write' ? `People can read the notes in “${share.property}”, or read them and send suggestions. They can not change them.` : '';
}

/** Why the note at `key` can not join `name` by its property, or '' when it can: it is in the shared folder `folder`, or `excluded` leaves it out. */
export function joinProblem(key: string, name: string, o: { folder?: string; excluded: (key: string) => boolean }): string {
  const what = `“${fileName(key).replace(/\.md$/i, '')}”`;
  if (o.folder) return `${what} is in the shared folder “${o.folder}”, so it can not be shared in “${name}”.`;
  if (o.excluded(key)) return `This vault leaves ${what} out of sync on this device, so it can not be shared in “${name}”.`;
  return '';
}

/**
 * Whether the note at `key` is in the share, or joins it at the next sync: the last sync found it there (`survey`), or
 * Obsidian reads its properties as saying share (`says`), and the sharer did not take it out. With `unmarked`, also a
 * note there whose properties no longer say so. What decides whether a note is offered to be shared or taken out.
 */
export function noteInShare(key: string, s: Pick<PropertyShare, 'removed'>, survey: Pick<Survey, 'shared' | 'unmarked'> | undefined, says: boolean, unmarked = false): boolean {
  if (s.removed.some((k) => vaultKey(k) === key)) return false;
  return !!survey?.shared.has(key) || (unmarked && !!survey?.unmarked.includes(key)) || says;
}

/**
 * What the sharer is told after taking `paths` out of `name`: removed, or while the engine still holds one of them
 * (`pending`), that the deletion goes out at the next sync that works, with why this one did not (`why`).
 */
export function removedText(name: string, paths: string[], pending: boolean, why = ''): string {
  const one = paths.length === 1;
  const what = one ? `“${fileName(paths[0]).replace(/\.md$/i, '')}”` : plural(paths.length, 'file');
  if (!pending) return `Removed ${what} from “${name}”.`;
  return `Took ${what} out of “${name}”. ${one ? 'It leaves' : 'They leave'} the others’ devices at the next sync that works.${why ? ` This sync: ${why}.` : ''}`;
}

/** What "Keep them" says for notes shared by a property: the files stay in the share; nothing comes back into the vault. */
export const keptText = (name: string, kept: number) =>
  `Kept ${plural(kept, 'file')} in “${name}” for the people who have them. They are not put back in your vault; What's shared lists them, to remove them later.`;

/** A few file names, without `.md`, for a notice. */
function someNames(keys: string[]): string {
  const shown = keys.slice(0, 3).map((k) => fileName(k).replace(/\.md$/i, ''));
  return `${shown.join(', ')}${keys.length > 3 ? ` and ${keys.length - 3} more` : ''}`;
}

export const sentNotesText = (name: string, keys: string[]) => `Sent ${plural(keys.length, 'new note')} to “${name}”: ${someNames(keys)}.`;

export const unmarkedText = (name: string, keys: string[]) =>
  keys.length === 1
    ? `“${someNames(keys)}” no longer says share: ${name}, but it is still in “${name}”.`
    : `${keys.length.toLocaleString()} notes no longer say share: ${name}, but they are still in “${name}”: ${someNames(keys)}.`;

export const unusedText = (name: string, keys: string[]) =>
  `${plural(keys.length, 'file')} that no shared note shows ${keys.length === 1 ? 'is' : 'are'} still in “${name}”: ${someNames(keys)}.`;

/** What waits for the sharer after a sync, as problems: notes that stopped saying share, and attachments waiting for a yes. */
export function propertyProblems(name: string, survey: Survey): Problem[] {
  const out: Problem[] = [];
  const n = survey.unmarked.length;
  if (n) {
    const [it, they] = n === 1 ? ['it', 'It stays'] : ['them', 'They stay'];
    out.push({
      id: 'unmarked',
      severity: 'warning',
      title: n === 1 ? `A note no longer says share: ${name}` : `${n.toLocaleString()} notes no longer say share: ${name}`,
      detail: `${they} in “${name}”, and what you change in ${it} is not sent until you choose: keep ${it} in “${name}”, or remove ${it} from it.`,
      files: survey.unmarked,
      action: 'whats-shared',
    });
  }
  const w = survey.waiting.length;
  if (w) {
    out.push({
      id: 'waiting',
      severity: 'warning',
      title: `${plural(w, 'file')} ${w === 1 ? 'waits' : 'wait'} for you`,
      detail: `Notes in “${name}” show ${w === 1 ? 'a file' : 'files'} of this vault that ${w === 1 ? 'is' : 'are'} not sent until you say so.`,
      files: survey.waiting.map((x) => x.key),
      action: 'whats-shared',
    });
  }
  return out;
}
