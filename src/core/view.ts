// Which large files a device keeps (`EngineOptions.keep`): those in use lately. The rest stay in storage.
import { vaultKey } from './paths.ts';

const DAY = 86_400_000;

/** A note with the files it links to or embeds: whole vault paths, or link text as written in the note. */
export interface LinkingNote {
  path: string;
  mtime: number;
  links: Iterable<string>;
}

export interface ViewRule {
  now: number;
  /** A file counts as in use for this many days. */
  days: number;
  /** Folders whose files are always kept; '' or '/' is the whole vault. */
  pins: string[];
  /** When each file was last opened or asked for on this device, by vault path. */
  opened: Iterable<[string, number]>;
}

const fold = (path: string) => vaultKey(path).toLowerCase();

/** `link` from a note in `folder` as a vault path, when it climbs or starts from the note's folder; else as written. */
function resolved(link: string, folder: string): string[] {
  const clean = link.replace(/^\/+/, '');
  if (!/^\.\.?\//.test(clean)) return folder ? [clean, `${folder}/${clean}`] : [clean];
  const parts = folder ? folder.split('/') : [];
  for (const part of clean.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return [parts.join('/')];
}

/**
 * Tells whether the file at a vault path, last changed at `mtime`, is in use: in a pinned folder, changed or opened
 * within `days`, or linked from a note changed within `days`. A link names a file by its whole path, by a path from
 * the note's folder, or as Obsidian's shortest links do, by the end of its path; letter case is ignored, as Obsidian does.
 */
export function inUse(notes: Iterable<LinkingNote>, rule: ViewRule): (path: string, mtime: number) => boolean {
  const since = rule.now - rule.days * DAY;
  const pins = rule.pins.map((p) => fold(p.trim().replace(/^\/+|\/+$/g, '')));
  const everything = rule.pins.some((p) => p.trim() === '/');
  const opened = new Set<string>();
  for (const [path, time] of rule.opened) if (time >= since) opened.add(fold(path));
  const linked = new Set<string>();
  for (const note of notes) {
    if (note.mtime < since) continue;
    const folder = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
    for (const link of note.links) for (const target of resolved(link, folder)) linked.add(fold(target));
  }
  return (path, mtime) => {
    if (everything || mtime >= since) return true;
    const key = fold(path);
    if (opened.has(key) || pins.some((pin) => pin && key.startsWith(`${pin}/`))) return true;
    if (!linked.size) return false;
    for (let at = 0; at >= 0; at = key.indexOf('/', at) + 1 || -1) if (linked.has(key.slice(at))) return true;
    return false;
  };
}

/** The files a note's text links to or embeds, as written: `[[file]]`, `![[file|300]]`, `[text](file)`. Web addresses are left out. */
export function linksIn(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/\[\[([^\]|#\n]+)[^\]\n]*\]\]/g)) out.push(m[1].trim());
  for (const m of markdown.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))[^)\n]*\)/g)) {
    const target = (m[1] ?? m[2]).replace(/#.*$/, '');
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    try {
      out.push(decodeURIComponent(target));
    } catch {
      out.push(target);
    }
  }
  return out;
}
