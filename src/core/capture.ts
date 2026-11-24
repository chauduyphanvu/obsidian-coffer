// A send-only key: what a script, an agent or another person holds to add notes to a shared folder and read none of it.
// It is a member's id and secret with storage keys, and no master key: it seals a suggestion (suggest.ts) and puts it
// in the inbox, never opening the vault, its header or its log. No Obsidian import.
import { fromB64, toB64, utf8 } from './bytes.ts';
import { isMemberId } from './members.ts';
import { vaultKey } from './paths.ts';
import { SUGGEST_MAX_FILE, SUGGEST_MAX_FILES, SUGGEST_MAX_TOTAL, inboxKey, sealSuggestion, suggestKind, type SuggestedFile } from './suggest.ts';
import type { RemoteStore } from './types.ts';

export const CAPTURE_PREFIX = 'coffercapture1.';

export interface CaptureKey {
  /** The shared folder's id, which seals what is sent to it alone. */
  repo: string;
  member: string;
  /** The member's secret, base64url. No slot is kept for it in storage, so it unwraps no master key. */
  secret: string;
  /** Storage address and credentials, as the app that makes the key names them: ones that may only add to the inbox. */
  storage: Record<string, unknown>;
  /** The shared folder's name, to say where a note went. */
  share: string;
}

export function encodeCaptureKey(k: CaptureKey): string {
  const { repo, member, secret, storage, share } = k;
  return CAPTURE_PREFIX + toB64(utf8.encode(JSON.stringify({ v: 1, repo, member, secret, storage, share })));
}

export function decodeCaptureKey(link: string): CaptureKey {
  const text = link.trim();
  if (!text.startsWith(CAPTURE_PREFIX)) throw new Error('That is not a send-only key (it starts with coffercapture1.)');
  let p: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromB64(text.slice(CAPTURE_PREFIX.length)))) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) p = parsed as Record<string, unknown>;
  } catch {
    // reported below
  }
  if (!p) throw new Error('That send-only key is damaged, or it was cut short when it was copied');
  let secretOk = false;
  try {
    secretOk = typeof p.secret === 'string' && fromB64(p.secret).length === 32;
  } catch {
    // not base64
  }
  if (p.v !== 1 || typeof p.repo !== 'string' || !p.repo || !isMemberId(p.member) || !secretOk || !p.storage || typeof p.storage !== 'object' || typeof p.share !== 'string') {
    throw new Error('That send-only key is damaged, or comes from a newer version of Coffer');
  }
  return { repo: p.repo, member: p.member, secret: p.secret as string, storage: p.storage as Record<string, unknown>, share: p.share };
}

/** A note to send: where it goes in the shared folder, and its text. */
export interface CapturedNote {
  path: string;
  text: string;
}

/** What is wrong with a note for a send-only key to carry, or ''. */
export function captureProblem(n: CapturedNote, total = 0): string {
  const path = n.path;
  if (!path || path.length > 1024 || path.includes('\\') || path.split('/').some((x) => !x || x === '.' || x === '..')) return `“${path}” is not a path inside the shared folder`;
  if (!suggestKind(path)) return `“${path}” is not a note or a canvas: a send-only key carries .md and .canvas files`;
  const size = utf8.encode(n.text).length;
  if (size > SUGGEST_MAX_FILE) return `“${path}” is over 1 MB, the most one note can be`;
  if (total + size > SUGGEST_MAX_TOTAL) return 'Together these notes are over 4 MB, the most that is sent at once';
  return '';
}

/**
 * Sends `notes` to the owner's devices as one suggestion of new files, with one request to storage per try: a write
 * that refuses to replace what is there. Nothing is read, listed or opened, so storage keys that may only add to the
 * inbox are enough. Returns where it was stored.
 */
export async function sendCapture(store: RemoteStore, key: CaptureKey, notes: CapturedNote[], device: string, now = Date.now()): Promise<string> {
  if (!notes.length) throw new Error('There is nothing to send');
  if (notes.length > SUGGEST_MAX_FILES) throw new Error(`That is ${notes.length} notes: at most ${SUGGEST_MAX_FILES} are sent at once`);
  const files: SuggestedFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const n of notes) {
    const path = vaultKey(n.path);
    const problem = captureProblem({ path, text: n.text }, total) || (seen.has(path) ? `“${path}” is named twice` : '');
    if (problem) throw new Error(problem);
    seen.add(path);
    total += utf8.encode(n.text).length;
    files.push({ path, text: n.text });
  }
  const secret = fromB64(key.secret);
  // Another sender with this key may send in the same millisecond: each suggestion takes a place no other has.
  for (let time = now, tries = 0; tries < 5; time++, tries++) {
    const at = inboxKey(key.member, time);
    const sealed = await sealSuggestion(key.repo, secret, { key: at, member: key.member, time, device: device.slice(0, 200), files });
    if (await store.put(at, sealed, { ifNoneMatch: true })) return at;
  }
  throw new Error('Could not find a free place in storage for the note. Try again.');
}

/** A name for a note sent with a send-only key to try: `path` itself for 1, and with " (n)" before its extension from 2 on. */
export function numbered(path: string, n: number): string {
  if (n < 2) return path;
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? `${path.slice(0, dot)} (${n})${path.slice(dot)}` : `${path} (${n})`;
}
