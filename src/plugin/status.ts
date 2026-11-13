// What a sync did, what went wrong and what a conflict leaves to choose, in words a user can act on.
// No Obsidian import, so it runs under plain Node tests.
import { WrongPassphraseError } from '../core/crypto.ts';
import { HistoryError, SafetyError, type SyncResult } from '../core/engine.ts';
import { lineDiff, type DiffRegion } from '../core/merge.ts';
import { ext } from '../core/paths.ts';
import { DAY } from '../core/retention.ts';
import { MissingFolderError } from '../core/scopedfs.ts';
import { errorText, plural } from '../core/text.ts';

export function summarize(r: SyncResult): string {
  const parts = [
    r.pushed && `${r.pushed.toLocaleString()} sent`,
    r.pulled && `${r.pulled.toLocaleString()} received`,
    r.deletedLocal + r.deletedRemote && `${(r.deletedLocal + r.deletedRemote).toLocaleString()} deleted`,
    r.merged && `${r.merged.toLocaleString()} merged`,
    r.conflictCopies.length && plural(r.conflictCopies.length, 'conflict copy', 'conflict copies'),
    r.errors.length && `${r.errors.length.toLocaleString()} failed`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'everything is up to date';
}

export type Action = 'settings' | 'passphrase' | 'resolve-deletes' | 'files' | 'retry' | 'missing-folder' | 'accept-storage';

export interface Problem {
  /** A notice is shown once per id, so the same problem does not nag on every sync. */
  id: string;
  /** Critical: sync is stopped or data is at risk. Warning: something needs a look, nothing is lost. */
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  action?: Action;
  files?: string[];
  /** The id of the shared folder it is about; its actions act on that one. None for the vault's own. */
  share?: string;
}

/** A shared folder's folder is gone from this vault. */
export function missingProblem(folder: string): Problem {
  return {
    id: 'missing-folder',
    severity: 'critical',
    title: 'Folder missing from this vault',
    detail:
      `There is no folder “${folder}” in this vault now, so this shared folder stopped syncing here. Nothing was deleted for the others who share it. ` +
      `Download it again to bring its files back into “${folder}”, or stop sharing it on this device.`,
    action: 'missing-folder',
  };
}

/** A shared folder whose storage keys or passphrase this device no longer has, as after its keychain was reset. */
export function keysMissingProblem(): Problem {
  return {
    id: 'share-keys',
    severity: 'critical',
    title: 'Keys missing on this device',
    detail: 'This device no longer has the storage keys or the passphrase for this shared folder, so it does not sync here. Stop sharing it on this device, then join again with the invite link.',
    action: 'settings',
  };
}

/** A shared folder's problem, told apart from the vault's: its own id, and a title that names the folder. */
export function inShare(p: Problem, share: { id: string; folder: string }): Problem {
  return { ...p, id: `share:${share.id}:${p.id}`, title: `Shared folder “${share.folder}”: ${p.title}`, share: share.id };
}

/**
 * What one synced place (the vault, or a shared folder) has to report, worst first. Files changed here are only a
 * problem while the place only receives: once that is off, the next sync sends them.
 */
export function targetProblems(t: { failure?: Problem; found: Problem[]; conflictCopies: string[]; lastSuccess: number; readOnly: boolean }, now: number): Problem[] {
  const out: Problem[] = [];
  // A temporary failure (offline) only counts once it has gone on for a day.
  if (t.failure && t.failure.id !== 'offline') out.push(t.failure);
  if (t.failure) {
    const stale = staleProblem(t.lastSuccess, now);
    if (stale) out.push(stale);
  }
  out.push(...withConflicts(t.found, t.conflictCopies).filter((p) => t.readOnly || p.id !== 'unsent'));
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
}

export type Tone = 'ok' | 'busy' | 'warning' | 'critical' | 'off';

/** One line for a synced place: its worst problem, or when it last synced, whether it is offline and how much there is to review. */
export function statusText(problems: Problem[], lastSuccess: number, offline: boolean): { text: string; tone: Tone } {
  const critical = problems.filter((p) => p.severity === 'critical');
  if (critical.length) return { text: critical.length === 1 ? critical[0].title : `${plural(critical.length, 'problem')} need attention`, tone: 'critical' };
  const when = lastSuccess ? `Synced ${new Date(lastSuccess).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet';
  const review = problems.length ? `${plural(problems.length, 'thing', 'things')} to review` : '';
  return { text: [when, offline && 'offline', review].filter(Boolean).join(' · '), tone: problems.length ? 'warning' : 'ok' };
}

/** What the problems screen says when it lists nothing: all in sync, or what keeps that from being so. */
export function quietText(offline: boolean, waiting: boolean): string {
  if (offline) return "Can't reach the storage, so changes made here are not sent and changes from other devices do not arrive. Sync tries again on its own.";
  return waiting ? 'Changes made here are waiting to be sent.' : 'Everything is in sync.';
}

/** The settings row for files left in storage: how many, once every synced place has said, otherwise only what the row is. */
export function leftInStorage(counts: (number | undefined)[]): string {
  const known = counts.filter((n): n is number => n !== undefined);
  return known.length === counts.length ? `${plural(known.reduce((a, n) => a + n, 0), 'file')} left in storage` : 'Files left in storage';
}

/** What "Keep all files" does with the `kept` files: those `left` over the download limit stay in storage instead of being copied back. */
export function keptNote(kept: number, left: number): string {
  const back = `${plural(kept - left, 'file')} will be copied back.`;
  if (!left) return back;
  const stay = `${plural(left, 'file')} over the download limit ${left === 1 ? 'stays' : 'stay'} in storage until you choose ${left === 1 ? 'it' : 'them'}.`;
  return kept > left ? `${back} ${stay}` : stay;
}

/** Probably temporary: no network, or the storage is busy. Not worth an alarm until it lasts. */
export const isTransient = (message: string) =>
  /fetch failed|network|offline|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|socket|Request failed|net::ERR_|could not connect|could not be found|not connected to the internet|HTTP (5\d\d|429)/i.test(message);

/** A sync that threw, described. */
export function describeFailure(e: unknown): Problem {
  const message = errorText(e);
  if (e instanceof MissingFolderError) return missingProblem(e.folder);
  if (e instanceof SafetyError) {
    return {
      id: `deletes:${e.localDeletes}:${e.remoteDeletes}`,
      severity: 'critical',
      title: 'Sync paused before deleting many files',
      detail:
        `This sync would delete ${[e.localDeletes && `${plural(e.localDeletes, 'file')} on this device`, e.remoteDeletes && `${plural(e.remoteDeletes, 'file')} from storage`].filter(Boolean).join(' and ')}. ` +
        'If that was not you, keep the files: nothing is lost yet.',
      action: 'resolve-deletes',
    };
  }
  if (e instanceof HistoryError) {
    return {
      id: 'history',
      severity: 'critical',
      title: 'Storage was rolled back or replaced',
      detail:
        'Sync is stopped. What storage holds now is not what this device last saw there: part of the sync history was taken back or replaced. ' +
        'That is expected right after storage was restored from a backup or an older copy, and then this device can carry on from storage as it is. ' +
        `If nobody did that on purpose, leave sync stopped and find out who can reach your storage. The files on this device are untouched. (${message})`,
      action: 'accept-storage',
    };
  }
  if (e instanceof WrongPassphraseError || /wrong passphrase/i.test(message)) {
    return {
      id: 'passphrase',
      severity: 'critical',
      title: 'Wrong passphrase',
      detail: 'Sync is stopped. If the passphrase was changed on another device, enter the new one here.',
      action: 'passphrase',
    };
  }
  if (/HTTP 40[13]\b|AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId|refused the login/i.test(message)) {
    return {
      id: 'access',
      severity: 'critical',
      title: 'The storage refused the access keys',
      detail: `Sync is stopped. Check the keys, and that they may read and write this bucket or folder. If these keys may only read, turn on Only receive changes. (${message})`,
      action: 'settings',
    };
  }
  if (/NoSuchBucket/i.test(message)) {
    return { id: 'bucket', severity: 'critical', title: 'Bucket not found', detail: 'Sync is stopped. Check the bucket name and region.', action: 'settings' };
  }
  if (/vault uses format/i.test(message)) {
    return { id: 'format', severity: 'critical', title: 'Update Coffer on this device', detail: `Another device uses a newer version. (${message})` };
  }
  if (/failed authentication|corrupted|tampered|is missing|cannot be read|gap before|inconsistent|wrong size|vanished/i.test(message)) {
    return {
      id: 'damaged',
      severity: 'critical',
      title: 'Synced data in storage is damaged',
      detail: `Sync is stopped so nothing gets overwritten. The files on this device are untouched; do not delete them. (${message})`,
    };
  }
  if (isTransient(message)) {
    return { id: 'offline', severity: 'warning', title: "Can't reach the storage", detail: `Sync tries again on its own. (${message})`, action: 'retry' };
  }
  return { id: `failed:${message}`, severity: 'critical', title: 'Sync failed', detail: message, action: 'retry' };
}

/** Files a finished sync could not handle, and conflict copies still waiting for the user. */
export function resultProblems(r: Pick<SyncResult, 'errors' | 'tooLarge' | 'unsent'>, conflictCopies: string[], maxFileSizeMB: number): Problem[] {
  const out: Problem[] = [];
  if (r.errors.length) {
    out.push({
      id: `failed-files:${r.errors.map((e) => e.path).join('|')}`,
      severity: 'critical',
      title: `${plural(r.errors.length, 'file')} could not sync`,
      detail: r.errors.map((e) => `${e.path}: ${e.message}`).join('\n'),
      files: r.errors.map((e) => e.path),
      action: 'files',
    });
  }
  const conflicts = conflictProblem(conflictCopies);
  if (conflicts) out.push(conflicts);
  if (r.tooLarge.length) {
    out.push({
      id: `too-large:${r.tooLarge.join('|')}`,
      severity: 'warning',
      title: `${plural(r.tooLarge.length, 'file')} too large to sync here`,
      detail:
        r.tooLarge.length === 1
          ? `Over the ${maxFileSizeMB} MB limit set on this device, so it is not synced to or from it. Raise the limit in settings to include it.`
          : `Over the ${maxFileSizeMB} MB limit set on this device, so they are not synced to or from it. Raise the limit in settings to include them.`,
      files: r.tooLarge,
      action: 'settings',
    });
  }
  if (r.unsent.length) {
    out.push({
      // One id however many files, so a device that is meant to keep local changes is told once.
      id: 'unsent',
      severity: 'warning',
      title: `${plural(r.unsent.length, 'file')} changed here, not sent`,
      detail:
        'This device only receives changes, so what is changed here stays here. A file changed in storage as well is merged with the change made here; where that cannot be done, ' +
        'storage\'s version takes the name and this device\'s is kept beside it. Turn off Only receive changes in settings to send them.',
      files: r.unsent,
      action: 'files',
    });
  }
  return out;
}

function conflictProblem(conflictCopies: string[]): Problem | undefined {
  if (!conflictCopies.length) return undefined;
  return {
    id: `conflicts:${conflictCopies.join('|')}`,
    severity: 'warning',
    title: `${plural(conflictCopies.length, 'file')} changed on two devices`,
    detail: 'Both versions were kept: the copy has "(conflict …)" in its name. Resolve shows what differs and lets you choose what to keep.',
    files: conflictCopies,
    action: 'files',
  };
}

/** The vault's conflict copies, or a shared folder's (whose id `inShare` prefixes): the list offers to resolve each. */
export const isConflictProblem = (p: Problem) => /^(share:[^:]*:)?conflicts:/.test(p.id);

/** Why a storage check failed: what to check, in the words of that kind of storage, then the storage's own words. */
export function connectError(cause: string, storageType: 's3' | 'webdav'): string {
  const advice: Record<string, string> = {
    access:
      storageType === 'webdav'
        ? 'The server refused this user name and password. Check them, and that they may read and write this folder.'
        : 'The storage refused these keys. Check them, and that they may read and write this bucket.',
    bucket: 'Bucket not found. Check its name and the region.',
    offline: "Can't reach the storage. Check the address and the connection.",
  };
  const kind = describeFailure(new Error(cause)).id;
  return `${advice[kind] ?? 'Connecting failed.'}\n${cause}`;
}

/** `problems` with the conflict entry made to match `conflictCopies` now, since copies are resolved between syncs. */
export function withConflicts(problems: Problem[], conflictCopies: string[]): Problem[] {
  return problems.flatMap((p) => (p.id.startsWith('conflicts:') ? (conflictProblem(conflictCopies) ?? []) : p));
}

/** Larger files are not read to be compared, only kept or replaced whole. */
export const MAX_COMPARE_BYTES = 2 * 1024 * 1024;

/** A file as it was shown: its bytes when no larger than `MAX_COMPARE_BYTES`, otherwise only its size and time. */
export interface Snapshot {
  size: number;
  mtime: number;
  data?: Uint8Array;
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether a file is still as it was shown; undefined stands for no file. */
export function unchangedSince(before: Snapshot | undefined, now: Snapshot | undefined): boolean {
  if (!before || !now) return !before && !now;
  if (before.data && now.data) return sameBytes(before.data, now.data);
  return before.size === now.size && before.mtime === now.mtime;
}

/** Why a conflict can only be settled by keeping whole files. */
export type WholeReason = 'missing' | 'same' | 'large' | 'binary' | 'structured' | 'different';

export type Comparison = { kind: 'lines'; regions: DiffRegion[] } | { kind: 'whole'; reason: WholeReason };

/** Files whose structure lines picked from two versions could break. */
const STRUCTURED = new Set(['json', 'canvas']);

/** Text with its byte order mark kept, so writing it back changes nothing; undefined for anything that is not text. */
export function asText(data: Uint8Array): string | undefined {
  try {
    const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    return s.includes('\0') ? undefined : s;
  } catch {
    return undefined;
  }
}

/**
 * How the two sides of a conflict over `path` can be compared: change by change when both are text that a line
 * diff can follow, otherwise only as whole files. `mine` is this device's copy, `theirs` the file under the original name.
 */
export function compareConflict(path: string, mine: Snapshot, theirs: Snapshot | undefined): Comparison {
  const whole = (reason: WholeReason): Comparison => ({ kind: 'whole', reason });
  if (!theirs) return whole('missing');
  if (!mine.data || !theirs.data) return whole('large');
  if (sameBytes(mine.data, theirs.data)) return whole('same');
  const a = asText(mine.data);
  const b = asText(theirs.data);
  if (a === undefined || b === undefined) return whole('binary');
  if (STRUCTURED.has(ext(path))) return whole('structured');
  const regions = lineDiff(a, b);
  return regions ? { kind: 'lines', regions } : whole('different');
}

/** Failing quietly for a day is a problem in itself, even when each failure looked temporary. */
export function staleProblem(lastSuccess: number, now: number): Problem | undefined {
  if (!lastSuccess || now - lastSuccess < DAY) return undefined;
  return {
    id: 'stale',
    severity: 'critical',
    title: `Not synced since ${new Date(lastSuccess).toLocaleString()}`,
    detail: 'Changes on this device are not reaching your other devices, and theirs are not arriving here.',
    action: 'retry',
  };
}
