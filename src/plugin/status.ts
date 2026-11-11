// What a sync did and what went wrong, in words a user can act on. No Obsidian import, so it runs under plain Node tests.
import { WrongPassphraseError } from '../core/crypto.ts';
import { SafetyError, type SyncResult } from '../core/engine.ts';
import { DAY } from '../core/retention.ts';

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

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

export type Action = 'settings' | 'passphrase' | 'resolve-deletes' | 'files' | 'retry';

export interface Problem {
  /** A notice is shown once per id, so the same problem does not nag on every sync. */
  id: string;
  /** Critical: sync is stopped or data is at risk. Warning: something needs a look, nothing is lost. */
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  action?: Action;
  files?: string[];
}

/** Probably temporary: no network, or the storage is busy. Not worth an alarm until it lasts. */
export const isTransient = (message: string) =>
  /fetch failed|network|offline|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|socket|Request failed|net::ERR_|could not connect|could not be found|not connected to the internet|HTTP (5\d\d|429)/i.test(message);

/** A sync that threw, described. */
export function describeFailure(e: unknown): Problem {
  const message = e instanceof Error ? e.message : String(e);
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
      detail: `Sync is stopped. Check the keys, and that they may read and write this bucket or folder. (${message})`,
      action: 'settings',
    };
  }
  if (/NoSuchBucket/i.test(message)) {
    return { id: 'bucket', severity: 'critical', title: 'Bucket not found', detail: 'Sync is stopped. Check the bucket name and region.', action: 'settings' };
  }
  if (/vault uses format/i.test(message)) {
    return { id: 'format', severity: 'critical', title: 'Update Self Sync on this device', detail: `Another device uses a newer version. (${message})` };
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
export function resultProblems(r: Pick<SyncResult, 'errors' | 'tooLarge'>, conflictCopies: string[], maxFileSizeMB: number): Problem[] {
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
  if (conflictCopies.length) {
    out.push({
      id: `conflicts:${conflictCopies.join('|')}`,
      severity: 'warning',
      title: `${plural(conflictCopies.length, 'file')} changed on two devices`,
      detail: 'Both versions were kept: the copy has "(conflict …)" in its name. Compare them, keep what you need, then delete the copy.',
      files: conflictCopies,
      action: 'files',
    });
  }
  if (r.tooLarge.length) {
    out.push({
      id: `too-large:${r.tooLarge.join('|')}`,
      severity: 'warning',
      title: `${plural(r.tooLarge.length, 'file')} too large to sync here`,
      detail: `Over the ${maxFileSizeMB} MB limit set on this device, so they are not synced to or from it. Raise the limit in settings to include them.`,
      files: r.tooLarge,
      action: 'settings',
    });
  }
  return out;
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
