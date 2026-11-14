// Suggestions in a shared folder with members, as the plugin handles them: which device can send one, what sending
// did, and how the owner's device takes each suggested file in. No Obsidian import, so it runs under plain Node tests.
import type { SuggestOutcome } from '../core/engine.ts';
import { lineDiff, mergeCanvas, mergeNote, type DiffRegion } from '../core/merge.ts';
import { ext, fileName } from '../core/paths.ts';
import { suggestKind, type Suggestion } from '../core/suggest.ts';
import { errorText, plural } from '../core/text.ts';
import { sameContent, type Entry } from '../core/types.ts';
import { diffLines, type DiffLine } from './restore.ts';
import type { Share } from './settings.ts';
import { asText, type Snapshot } from './status.ts';

/**
 * Whether this device can send `share`'s owner a suggestion: it is a member's that only reads, with storage keys of its
 * own. A follower reads a public copy with no keys at all, and the owner's and a write member's devices send changes.
 */
export const canSuggest = (share: Share) => !!share.memberKeysSecret && share.role === 'read' && !share.followUrl;

/** What was sent before, by path, for `SyncEngine.sendSuggestion`. */
export const sentBefore = (share: Share) => new Map(share.suggested);

/** Records what `out` sent, so the same text is not sent again. */
export function recordSent(share: Share, out: SuggestOutcome): void {
  const sent = sentBefore(share);
  for (const f of out.sent) sent.set(f.path, f.sum);
  share.suggested = [...sent].sort(([a], [b]) => (a < b ? -1 : 1));
}

/** After a sync: forgets what was sent of files no longer unsent (`unsent`, inside the folder), as when the owner took them in. True when something was forgotten. */
export function forgetSent(share: Share, unsent: string[]): boolean {
  const still = new Set(unsent);
  const kept = share.suggested.filter(([path]) => still.has(path));
  if (kept.length === share.suggested.length) return false;
  share.suggested = kept;
  return true;
}

/** How many of the files changed here (`unsent`, inside the folder) were sent to `owner` as a suggestion already; '' for none. */
export function sentNote(share: Share, unsent: string[], owner: string): string {
  const still = new Set(unsent);
  const n = share.suggested.filter(([path]) => still.has(path)).length;
  if (!n) return '';
  return `${plural(n, 'file')} of these ${n === 1 ? 'was' : 'were'} sent to ${owner || 'the owner'} as a suggestion. A note changed again since can be sent again.`;
}

/** Of the files changed here (`paths`), those a suggestion carries and the rest. */
export function suggestable(paths: string[]): { notes: string[]; others: string[] } {
  return { notes: paths.filter(suggestKind), others: paths.filter((p) => !suggestKind(p)) };
}

/** Storage refused to keep the suggestion: the key this device has may not write there. */
export const isRefused = (e: unknown) => /HTTP 40[13]\b|AccessDenied|refused the login/i.test(errorText(e));

/** Why a suggestion was refused, for whoever sent it: `rules` is the title of the key rules that allow it. */
export function refusedText(owner: string, rules: string): string {
  const who = owner || 'The owner';
  return (
    'The storage key this device has may only read, so the suggestion was not sent. Your changes stay on this device. ' +
    `${who} can send you a new invite with a key that may also send suggestions: at the storage provider, a key with the rules “${rules}”.`
  );
}

const WHY: Record<SuggestOutcome['skipped'][number]['why'], string> = {
  kind: 'only notes and canvases can be suggested',
  large: 'larger than 1 MB',
  binary: 'not text',
  same: 'the same as in the shared folder',
  sent: 'sent before, unchanged since',
  gone: 'no longer on this device',
  full: 'more than one suggestion holds: send again after this one',
};

/** What sending did, in a few sentences: `name` gives each path as the user knows it. */
export function sentText(out: SuggestOutcome, owner: string, name: (path: string) => string = fileName): string {
  const who = owner || 'the owner';
  const head = out.sent.length
    ? `Sent ${plural(out.sent.length, kindNoun(out.sent.map((f) => f.path)))} to ${who} as a suggestion.`
    : 'Nothing was sent.';
  const groups = new Map<string, string[]>();
  for (const s of out.skipped) groups.set(WHY[s.why], [...(groups.get(WHY[s.why]) ?? []), name(s.path)]);
  const rest = [...groups].map(([why, paths]) => `Not sent, ${why}: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}.`);
  return [head, ...rest].join('\n');
}

/** "note" when every path is a note, otherwise "file". */
export const kindNoun = (paths: string[]) => (paths.length && paths.every((p) => ext(p) === 'md' || ext(p) === 'markdown') ? 'note' : 'file');

/** One suggestion's files in a line: "2 notes: Plan.md, Ideas.md". */
export function filesLine(s: Pick<Suggestion, 'files'>): string {
  const names = s.files.map((f) => fileName(f.path));
  return `${plural(names.length, kindNoun(s.files.map((f) => f.path)))}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
}

/** Said under the owner's list of suggestions when `more` wait behind the ones it shows. */
export function moreWaitingText(more: number): string {
  return more === 1
    ? 'One more suggestion is waiting. It shows here once you have dealt with these.'
    : `${plural(more, 'more suggestion')} are waiting. They show here once you have dealt with these.`;
}

/**
 * Where a suggested file is now, when it is gone from its path: moved, with its content as the suggestion was based
 * on, to the path returned. `remote` is the shared folder's files as this device last synced them.
 */
export function movedTo(path: string, base: Entry | undefined, remote: Map<string, Entry>): string | undefined {
  if (!base || remote.has(path)) return undefined;
  return [...remote].filter(([p, e]) => p !== path && sameContent(e, base)).map(([p]) => p).sort()[0];
}

/**
 * What accepting one suggested file would do, for the owner to look at first:
 * - `same`: the file has this text already;
 * - `new`: there is no such file, and none was there when the member changed it: accepting adds it;
 * - `apply`: accepting writes `result`, the suggested change, combined with what changed here since when `merged`;
 *   `lines` shows what that changes, when the two texts can be compared line by line;
 * - `choose`: choose at each change, because both changed the same lines (`both`), the version it was based on can no
 *   longer be read (`unknown`), or a file is here that the member's device did not have (`exists`);
 * - `whole`: the two can only be compared whole: accepting replaces the file with the suggested text;
 * - `gone`: the file was deleted, or moved and changed, since: accepting adds it back.
 */
export type Review =
  | { kind: 'same' }
  | { kind: 'new'; text: string }
  | { kind: 'apply'; result: string; lines?: DiffLine[]; merged: boolean }
  | { kind: 'choose'; why: 'both' | 'unknown' | 'exists'; regions: DiffRegion[] }
  | { kind: 'whole'; why: 'structured' | 'binary' | 'large' | 'different'; text: string }
  | { kind: 'gone'; text: string };

/**
 * How the owner's device can take in `suggested` for the file at `path`. `base` is the text the member changed:
 * undefined when the member made the file, null when the version is known but can no longer be read. `current` is the
 * file here now (undefined: there is none; without `data`, too large to compare). A suggestion made from an older
 * version than the current one is merged with what changed since, where both did not change the same lines.
 */
export function reviewSuggested(path: string, suggested: string, base: string | null | undefined, current: Snapshot | undefined): Review {
  if (!current) return base === undefined ? { kind: 'new', text: suggested } : { kind: 'gone', text: suggested };
  if (!current.data) return { kind: 'whole', why: 'large', text: suggested };
  const now = asText(current.data);
  if (now === undefined) return { kind: 'whole', why: 'binary', text: suggested };
  if (now === suggested) return { kind: 'same' };
  const canvas = ext(path) === 'canvas';
  if (typeof base === 'string') {
    const merged = (canvas ? mergeCanvas : mergeNote)(base, now, suggested);
    if (merged === now) return { kind: 'same' };
    if (merged !== null) {
      const regions = lineDiff(now, merged);
      return { kind: 'apply', result: merged, merged: now !== base, ...(regions && { lines: diffLines(regions, 3) }) };
    }
  }
  if (canvas) return { kind: 'whole', why: 'structured', text: suggested };
  const regions = lineDiff(now, suggested);
  const why = base === undefined ? 'exists' : base === null ? 'unknown' : 'both';
  return regions ? { kind: 'choose', why, regions } : { kind: 'whole', why: 'different', text: suggested };
}

/**
 * What the owner reads above a suggested file, and the button that takes it in (none when there is nothing to take
 * in). `name` is the member's, `file` the file's name, and `moved` where it is now, when it was moved since.
 */
export function reviewText(r: Review, o: { name: string; file: string; moved?: string }): { intro: string; accept?: string } {
  const { name, file } = o;
  const its = `${name}'s`;
  const out = ((): { intro: string; accept?: string } => {
    switch (r.kind) {
      case 'same':
        return { intro: `“${file}” already has this text, so there is nothing to take in.` };
      case 'new':
        return { intro: `${name} suggests a new ${kindNoun([file]) === 'note' ? 'note' : 'file'}, “${file}”:`, accept: 'Add it' };
      case 'apply':
        return {
          intro: r.merged
            ? `“${file}” changed here after ${its} copy of it. Taking it in combines ${its} change with the file as it is now:`
            : `Taking it in changes “${file}” like this:`,
          accept: 'Take it in',
        };
      case 'choose':
        return {
          intro:
            r.why === 'both'
              ? `“${file}” changed here after ${its} copy of it, and both changed the same lines. Choose what to keep at each change.`
              : r.why === 'unknown'
                ? `The version ${name} changed is no longer kept, so only the file as it is now and ${its} can be compared. Choose what to keep at each change.`
                : `There is a “${file}” here that ${its} device did not have. Choose what to keep at each change.`,
          accept: 'Save',
        };
      case 'whole': {
        const why = {
          structured: `Mixing lines from two versions could break this kind of file, and both changed it.`,
          binary: `“${file}” is not text now, so it can not be compared.`,
          large: `“${file}” is too large to compare here.`,
          different: 'The two are too different to compare line by line.',
        }[r.why];
        return { intro: `${why} Taking it in replaces “${file}” with ${its} version:`, accept: 'Replace it' };
      }
      case 'gone':
        return { intro: `There is no “${file}” in the folder now: it was deleted, or moved and changed, after ${its} copy of it. Taking it in adds it back with ${its} text:`, accept: 'Add it back' };
    }
  })();
  return o.moved ? { ...out, intro: `It was moved to “${o.moved}” since, and is taken in there. ${out.intro}` } : out;
}
