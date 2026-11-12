// What a restore does, and how the past reads to a person. No Obsidian import, so it runs under plain Node tests.
import { compileExcludes, type SyncConfig } from '../core/config.ts';
import { diffCounts, lineDiff, type DiffRegion } from '../core/merge.ts';
import { ext, vaultKey } from '../core/paths.ts';
import { DAY } from '../core/retention.ts';
import type { RestorePlan } from '../core/timeline.ts';
import type { Entry } from '../core/types.ts';
import type { VerifyReport } from '../core/verify.ts';
import { MAX_COMPARE_BYTES, asText, plural, sameBytes } from './status.ts';

/** `add` brings back a file that is not there now, `change` replaces one that is, `remove` takes one away. */
export interface Step {
  kind: 'add' | 'change' | 'remove';
  path: string;
  entry?: Entry;
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * A restore plan as steps, removals first (see `planRestore`), each kind in path order, without the paths
 * `keptOut` protects. `current` is the file table the plan was made against. `left` counts the paths left out.
 */
export function restoreSteps(plan: RestorePlan, current: Map<string, unknown>, keptOut: (path: string) => boolean): { steps: Step[]; left: number } {
  const remove: Step[] = plan.remove.filter((path) => !keptOut(path)).map((path) => ({ kind: 'remove' as const, path })).sort(byPath);
  const write: Step[] = plan.write
    .filter((w) => !keptOut(w.path))
    .map((w) => ({ kind: current.has(w.path) ? ('change' as const) : ('add' as const), path: w.path, entry: w.entry }))
    .sort(byPath);
  return { steps: [...remove, ...write], left: plan.remove.length + plan.write.length - remove.length - write.length };
}

export function countSteps(steps: Step[]): Record<Step['kind'], number> {
  const out = { add: 0, change: 0, remove: 0 };
  for (const s of steps) out[s.kind]++;
  return out;
}

/** Two plans touch the same paths in the same ways. */
export const sameSteps = (a: Step[], b: Step[]) => a.length === b.length && a.every((s, i) => s.kind === b[i].kind && s.path === b[i].path);

/** "3 files will be brought back, 2 changed and 1 removed." With `done`, the same in the past. */
export function stepSummary(c: Record<Step['kind'], number>, done = false): string {
  const parts: [number, string][] = [[c.add, 'brought back'], [c.change, 'changed'], [c.remove, 'removed']];
  const said = parts.filter(([n]) => n > 0).map(([n, verb], i) => (i ? `${n.toLocaleString()} ${verb}` : `${plural(n, 'file')} ${done ? (n === 1 ? 'was' : 'were') : 'will be'} ${verb}`));
  if (!said.length) return done ? 'Nothing was changed.' : 'Nothing needs to change: it already matches that time.';
  return `${said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : said[0]}.`;
}

export const scopeName = (folder: string) => (folder ? `“${folder.replace(/\/+$/, '')}”` : 'the whole vault');

/** Paths a restore never touches: those excluded from sync on this device, and anything inside `folders`. */
export function keepOut(exclude: string[], folders: string[]): (path: string) => boolean {
  const excluded = compileExcludes(exclude);
  const inside = folders.map((f) => `${f.replace(/\/+$/, '')}/`);
  return (path) => excluded(path) || inside.some((f) => path.startsWith(f));
}

/**
 * Where each of `paths` comes back: where it was when that is free, otherwise beside it as “name (restored).md”,
 * then “(restored 2)” and on. `taken` holds the vault's paths in lower case, as some file systems ignore case;
 * the chosen paths are added to it, so files restored together do not land on each other.
 */
export function placeRestored(paths: string[], taken: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of paths) {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const at = dot > slash + 1 ? dot : path.length;
    let to = path;
    for (let n = 1; taken.has(vaultKey(to).toLowerCase()); n++) to = `${path.slice(0, at)} (restored${n > 1 ? ` ${n}` : ''})${path.slice(at)}`;
    taken.add(vaultKey(to).toLowerCase());
    out.set(path, to);
  }
  return out;
}

/**
 * Whether every file this device last synced (`synced`) that is gone from it now was removed by a restore
 * (`restored`): then a sync that deletes them from storage only carries out what the user confirmed.
 */
export function goneOnlyByRestore(synced: Iterable<string>, present: Set<string>, excluded: (path: string) => boolean, restored: Set<string>): boolean {
  for (const path of synced) if (!present.has(path) && !excluded(path) && !restored.has(path)) return false;
  return true;
}

/**
 * A sync carrying out a restore that wrote `write` files and removed `remove`, here or on a device receiving it, is
 * refused for deleting many files when they shrink by more than the larger of `maxDeleteCount` and that share of the
 * `synced` files, as `SyncEngine` checks. Returns that limit when it is crossed.
 */
export function deleteLimitCrossed(write: number, remove: number, synced: number, cfg: Pick<SyncConfig, 'maxDeleteCount' | 'maxDeleteFraction'>): number | undefined {
  const limit = Math.max(cfg.maxDeleteCount, synced * cfg.maxDeleteFraction);
  return remove - write > limit ? Math.floor(limit) : undefined;
}

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** "Today", "Yesterday", "Monday 9 November", with the year when it is not this one. */
export function dayLabel(time: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(time);
  const year = d.getFullYear() !== new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(year && { year: 'numeric' }) });
}

export const timeLabel = (time: number, seconds = false) =>
  new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds && { second: '2-digit' }) });

/** Times of day for a list, with seconds only where two of them fall in the same minute. */
export function timeLabels(times: number[]): string[] {
  const minute = (t: number) => Math.floor(t / 60_000);
  const seen = new Map<number, number>();
  for (const t of times) seen.set(minute(t), (seen.get(minute(t)) ?? 0) + 1);
  return times.map((t) => timeLabel(t, seen.get(minute(t))! > 1));
}

/** A moment inside a sentence: "today at 14:32", "on Monday 9 November at 14:32". */
export function momentLabel(time: number, now: number): string {
  const day = dayLabel(time, now);
  return `${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`} at ${timeLabel(time)}`;
}

/** Items in their order, under a heading for each day. */
export function byDay<T>(items: T[], timeOf: (item: T) => number, now: number): { day: string; items: T[] }[] {
  const out: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = dayLabel(timeOf(item), now);
    if (out.at(-1)?.day === day) out.at(-1)!.items.push(item);
    else out.push({ day, items: [item] });
  }
  return out;
}

export const deviceLabel = (device: string, me: string) => (device === me ? 'this device' : device);

/** What one sync did across the vault: "3 added, 2 changed, 1 deleted", leaving out what it did not do. */
export function changesLabel(c: { added: number; changed: number; deleted: number }): string {
  const parts = [c.added && `${c.added.toLocaleString()} added`, c.changed && `${c.changed.toLocaleString()} changed`, c.deleted && `${c.deleted.toLocaleString()} deleted`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no files changed';
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1000) return plural(bytes, 'byte');
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1000;
  let i = 0;
  for (; n >= 999.5 && i < units.length - 1; i++) n /= 1000;
  return `${n < 9.95 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Every word typed appears somewhere in the path, its name or its folders, in any case. */
export function matchesQuery(path: string, query: string): boolean {
  const p = vaultKey(path).toLowerCase();
  return vaultKey(query).toLowerCase().split(/\s+/).every((w) => p.includes(w));
}

const TEXT = new Set(['md', 'markdown', 'txt', 'canvas', 'base', 'json', 'css', 'js', 'ts', 'csv', 'tsv', 'html', 'htm', 'xml', 'svg', 'yaml', 'yml', 'tex', 'org', 'rst', 'toml', 'ini', 'log']);

/** Versions worth downloading to count their changed lines: text by name, and small enough to compare. */
export const countable = (path: string, size: number) => TEXT.has(ext(path)) && size <= MAX_COMPARE_BYTES;

/** Lines added and removed from `older` to `newer`; undefined when either is not text or they differ too much to follow. */
export function lineChanges(older: Uint8Array, newer: Uint8Array): { added: number; removed: number } | undefined {
  const a = asText(older);
  const b = asText(newer);
  const regions = a === undefined || b === undefined ? null : lineDiff(a, b);
  if (!regions) return undefined;
  const { added, removed } = diffCounts(regions);
  return { added, removed };
}

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string } | { kind: 'gap'; lines: number };

/**
 * The lines to show for `regions`: every changed line, removed before added, with up to `context` shared lines
 * either side of each change. A longer shared run becomes a gap saying how many lines it hides.
 */
export function diffLines(regions: DiffRegion[], context: number): DiffLine[] {
  const out: DiffLine[] = [];
  const line = (kind: 'same' | 'added' | 'removed') => (l: string) => out.push({ kind, text: l.replace(/\r?\n$/, '') });
  regions.forEach((r, i) => {
    if (r.kind === 'change') {
      r.a.forEach(line('removed'));
      r.b.forEach(line('added'));
      return;
    }
    const n = r.lines.length;
    const head = i > 0 ? context : 0;
    const tail = i < regions.length - 1 ? context : 0;
    if (head + tail >= n) {
      r.lines.forEach(line('same'));
      return;
    }
    r.lines.slice(0, head).forEach(line('same'));
    out.push({ kind: 'gap', lines: n - head - tail });
    r.lines.slice(n - tail).forEach(line('same'));
  });
  return out;
}

export type Preview =
  | { kind: 'changes'; text: string; lines: DiffLine[]; added: number; removed: number }
  | { kind: 'same'; text: string }
  | { kind: 'text'; text: string; why: 'missing' | 'different' }
  | { kind: 'facts'; why: 'binary' | 'large' };

/**
 * How to show a version (undefined: too large to read) beside the current file (null: there is none; undefined:
 * too large to read): the changes restoring it would make, or failing that its whole text, or only the facts.
 */
export function previewVersion(version: Uint8Array | undefined, current: Uint8Array | null | undefined): Preview {
  if (!version) return { kind: 'facts', why: 'large' };
  const text = asText(version);
  if (text === undefined) return { kind: 'facts', why: 'binary' };
  if (current === null) return { kind: 'text', text, why: 'missing' };
  if (current && sameBytes(current, version)) return { kind: 'same', text };
  const now = current && asText(current);
  const regions = now === undefined ? null : lineDiff(now, text);
  if (!regions) return { kind: 'text', text, why: 'different' };
  const { added, removed } = diffCounts(regions);
  return { kind: 'changes', text, lines: diffLines(regions, 3), added, removed };
}

export interface VerifyFinding {
  title: string;
  detail: string;
  /** Files whose current version is affected. */
  files: string[];
  /** The checker's own words, for anyone who wants them. */
  messages: string[];
}

const FINDINGS: [RegExp, string, string][] = [
  [/^pack\//, 'Stored file data is missing or damaged', 'Some of the encrypted data the files below are stored in could not be found or read. Other devices may be unable to download them.'],
  [/^log\//, 'Part of the sync history is missing or damaged', 'Devices may stop syncing until it is repaired, and some earlier times may not be restorable.'],
  [/^snap\//, 'A stored overview of the vault is damaged', 'New devices start from it, so setting one up may fail.'],
  [/(?:)/, 'Something in storage does not add up', 'The details below say what.'],
];

/** A check's report in plain words: what was checked, and each kind of problem once, with the files it affects. */
export function describeVerify(r: VerifyReport): { ok: boolean; title: string; detail: string; findings: VerifyFinding[] } {
  const checked =
    `Checked ${plural(r.files, 'file')}, the history of ${plural(r.commits, 'sync')} and ${plural(r.packs, 'storage object')}` +
    (r.deep ? `, and downloaded ${sizeLabel(r.bytes)} to check what is inside.` : '.');
  if (!r.problems.length) return { ok: true, title: 'No damage found', detail: checked, findings: [] };
  const found = new Map<number, VerifyFinding>();
  for (const p of r.problems) {
    const i = FINDINGS.findIndex(([re]) => re.test(p.object ?? ''));
    let f = found.get(i);
    if (!f) found.set(i, (f = { title: FINDINGS[i][1], detail: FINDINGS[i][2], files: [], messages: [] }));
    f.files.push(...(p.paths ?? []));
    f.messages.push(p.message);
  }
  const findings = [...found.entries()].sort(([a], [b]) => a - b).map(([, f]) => ({ ...f, files: [...new Set(f.files)].sort() }));
  return {
    ok: false,
    title: `${plural(r.problems.length, 'problem')} found`,
    detail: `${checked} Nothing was changed. Keep the files on your devices: they may be the only good copies.`,
    findings,
  };
}

export const verifyProgress = (p: { phase: 'log' | 'chunks'; done: number; total: number }) =>
  `${p.phase === 'log' ? 'Reading the sync history' : 'Downloading and checking stored data'}: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
