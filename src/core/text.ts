/** A count and its noun: "1 file", "3 files", "1,204 changes". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * `s` without its control characters: those below a space, and with `c1` also DEL and the ones after it up to U+009F.
 * Not a regular expression: Obsidian's lint rules refuse one that names control characters.
 */
export function withoutControls(s: string, c1 = false): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && !(c1 && c >= 0x7f && c <= 0x9f)) out += s[i];
  }
  return out;
}

/** Whether `s` has a control character, one below a space. */
export const hasControl = (s: string) => withoutControls(s) !== s;

/** What a thrown value says: an Error's message, anything else as a string. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Text up to the end of its first sentence (a period before a space) or its first line, whichever comes first. */
export const firstSentence = (s: string): string => (/^[^\n]*?\.(?=\s)|^[^\n]*/.exec(s) ?? [''])[0];
