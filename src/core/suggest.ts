// Suggestions: a member who may only read sends the notes changed on its device to the owner, who takes each into the
// shared folder or not. No Obsidian import, so it runs under plain Node tests.
import { utf8 } from './bytes.ts';
import { hkdf, openWithKey, sealWithKey } from './crypto.ts';
import { isMemberId } from './members.ts';
import { ext } from './paths.ts';
import type { ChunkRef, Entry } from './types.ts';

/*
 * One object per suggestion, `inbox/<member id>-<time>`, sealed under HKDF(member secret, "coffer/suggest") with its key
 * as associated data: only that member's devices could have made it, and only the owner's devices, which derive every
 * member's secret from the root, can open it. It is not in the log and changes no file: the owner's device writes what
 * it takes into the folder, and its next sync sends that as its own change.
 */

export const INBOX = 'inbox/';
/** Notes and canvases: the kinds of file a suggestion carries, which the owner's device can compare and merge. */
const KINDS = new Set(['md', 'markdown', 'canvas']);
/** The most text one file of a suggestion carries, in bytes. */
export const SUGGEST_MAX_FILE = 1 << 20;
/** The most text one suggestion carries in all. */
export const SUGGEST_MAX_TOTAL = 4 << 20;
const MAX_FILES = 500;
/** More than the most a suggestion holds, sealed: anything larger is not opened, nor downloaded whole. */
export const MAX_SEALED = SUGGEST_MAX_TOTAL * 2 + (1 << 20);
/**
 * How many objects in the inbox the owner's device opens at a time, newest first: a member who may add to the inbox
 * could fill it with any number of them.
 */
export const INBOX_OPENED = 50;

export const suggestKind = (path: string) => KINDS.has(ext(path));

export interface SuggestedFile {
  /** Its path in the shared folder. */
  path: string;
  /** The version it was changed from, as the member's device last synced it; none for a file it made. */
  base?: Entry;
  text: string;
}

export interface Suggestion {
  /** Where it is stored: `inbox/<member>-<time>`. */
  key: string;
  member: string;
  /** When it was sent, by the sending device's clock. */
  time: number;
  /** The name of the device that sent it. */
  device: string;
  files: SuggestedFile[];
}

export const inboxKey = (member: string, time: number) => `${INBOX}${member}-${time}`;

/** The member and time a suggestion's key names; undefined for any other key. A member id may hold '-': the time is after the last one. */
export function parseInboxKey(key: string): { member: string; time: number } | undefined {
  const m = /^inbox\/([A-Za-z0-9_-]+)-(\d{1,15})$/.exec(key);
  return m && isMemberId(m[1]) ? { member: m[1], time: Number(m[2]) } : undefined;
}

const sealKey = (secret: Uint8Array) => hkdf(secret, 'coffer/suggest');
const aad = (repo: string, key: string) => `${repo}:${key}`;

export async function sealSuggestion(repo: string, secret: Uint8Array, s: Suggestion): Promise<Uint8Array> {
  const body = { v: 1, m: s.member, t: s.time, d: s.device, f: s.files.map((f) => ({ p: f.path, x: f.text, ...(f.base && { b: f.base }) })) };
  return sealWithKey(await sealKey(secret), utf8.encode(JSON.stringify(body)), aad(repo, s.key));
}

const isCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/** A path inside the shared folder, of a kind a suggestion carries. */
const goodPath = (p: unknown): p is string =>
  typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.includes('\\') && !p.split('/').some((x) => !x || x === '.' || x === '..') && suggestKind(p);

function entryOf(b: unknown): Entry | undefined {
  const e = b as Partial<Entry> | null;
  if (!e || typeof e !== 'object' || !isCount(e.size) || typeof e.mtime !== 'number' || !Array.isArray(e.chunks)) return undefined;
  const chunks: ChunkRef[] = [];
  let size = 0;
  for (const c of e.chunks as Partial<ChunkRef>[]) {
    if (!c || typeof c.id !== 'string' || typeof c.pack !== 'string' || !isCount(c.off) || !isCount(c.len) || !isCount(c.size)) return undefined;
    chunks.push({ id: c.id, pack: c.pack, off: c.off, len: c.len, size: c.size });
    size += c.size;
  }
  return size === e.size ? { size: e.size, mtime: e.mtime, chunks } : undefined;
}

/**
 * Opens the suggestion stored at `key` with the secret of the member it names. Throws when it does not open with that
 * secret, or holds anything a member's device does not write.
 */
export async function openSuggestion(repo: string, secret: Uint8Array, key: string, raw: Uint8Array): Promise<Suggestion> {
  const at = parseInboxKey(key);
  const bad = () => new Error('This suggestion is damaged, or was not made by the member it names');
  if (!at || raw.length > MAX_SEALED) throw bad();
  let d: { v?: unknown; m?: unknown; t?: unknown; d?: unknown; f?: unknown };
  try {
    d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await openWithKey(await sealKey(secret), raw, aad(repo, key)))) as typeof d;
  } catch {
    throw bad();
  }
  if (!d || d.v !== 1 || d.m !== at.member || typeof d.t !== 'number' || typeof d.d !== 'string' || d.d.length > 200) throw bad();
  if (!Array.isArray(d.f) || !d.f.length || d.f.length > MAX_FILES) throw bad();
  const files: SuggestedFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of d.f as { p?: unknown; x?: unknown; b?: unknown }[]) {
    if (!f || !goodPath(f.p) || seen.has(f.p) || typeof f.x !== 'string') throw bad();
    const size = utf8.encode(f.x).length;
    total += size;
    if (size > SUGGEST_MAX_FILE || total > SUGGEST_MAX_TOTAL) throw bad();
    const base = f.b === undefined ? undefined : entryOf(f.b);
    if (f.b !== undefined && !base) throw bad();
    seen.add(f.p);
    files.push({ path: f.p, text: f.x, ...(base && { base }) });
  }
  return { key, member: at.member, time: d.t, device: d.d, files };
}
