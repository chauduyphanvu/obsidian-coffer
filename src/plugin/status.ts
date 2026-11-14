// What a sync did, what went wrong and what a conflict leaves to choose, in words a user can act on.
// No Obsidian import, so it runs under plain Node tests.
import { WrongPassphraseError } from '../core/crypto.ts';
import { HistoryError, RemovedError, SafetyError, UnverifiedError, type MemberStanding, type SyncResult } from '../core/engine.ts';
import { lineDiff, type DiffRegion } from '../core/merge.ts';
import { ext } from '../core/paths.ts';
import { DAY } from '../core/retention.ts';
import { MissingFolderError } from '../core/scopedfs.ts';
import { errorText, plural } from '../core/text.ts';
import type { Share } from './settings.ts';
import { NotSendingError, OtherSenderError, VaultNotListedError } from './byproperty.ts';
import { rejoinNeeds } from './shares.ts';

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

export type Action = 'settings' | 'passphrase' | 'resolve-deletes' | 'files' | 'retry' | 'missing-folder' | 'accept-storage' | 'remove-unverified' | 'stop-sharing' | 'whats-shared';

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

/**
 * A shared folder whose storage keys or passphrase (for one with members, this device's keys to it) this device no
 * longer has, as after its keychain was reset. Notes shared by a property have no link to join again with: only a new share.
 */
export function keysMissingProblem(share: Pick<Share, 'role' | 'memberKeysSecret'> & { property?: string }): Problem {
  return {
    id: 'share-keys',
    severity: 'critical',
    title: 'Keys missing on this device',
    detail:
      `This device no longer has the storage keys or ${share.memberKeysSecret ? 'its own keys' : 'the passphrase'} for this shared folder, so it does not sync here. ` +
      (share.property ? 'Stop sharing it on this device, then start a new share and invite people again.' : `Stop sharing it on this device, then join again with ${rejoinNeeds(share)}.`),
    action: 'settings',
  };
}

/** A shared folder's problem, told apart from the vault's: its own id, and a title that names the folder, or the notes shared by a property. */
export function inShare(p: Problem, share: { id: string; folder: string; property?: string }): Problem {
  const what = share.property ? `Shared notes “${share.property}”` : `Shared folder “${share.folder}”`;
  return { ...p, id: `share:${share.id}:${p.id}`, title: `${what}: ${p.title}`, share: share.id };
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

/**
 * One line for a shared folder: its worst problem; while it waits for the owner's device to let it send changes, that;
 * otherwise as for any place (`statusText`).
 */
export function shareLine(problems: Problem[], standing: Pick<MemberStanding, 'waiting' | 'owner'> | undefined, lastSuccess: number, offline: boolean): { text: string; tone: Tone } {
  if (standing?.waiting && !problems.some((p) => p.severity === 'critical')) return { text: waitingText(standing.owner), tone: 'warning' };
  return statusText(problems, lastSuccess, offline);
}

/** What a write member's device waits for until the owner's device confirms it; `owner` is the owner's name, '' when not known yet. */
export const waitingText = (owner: string) => `Waiting for ${owner ? `${owner}'s` : "the owner's"} device to confirm`;

/** One line for a synced place: its worst problem, or when it last synced, whether it is offline and how much there is to review. */
export function statusText(problems: Problem[], lastSuccess: number, offline: boolean): { text: string; tone: Tone } {
  const critical = problems.filter((p) => p.severity === 'critical');
  if (critical.length) return { text: critical.length === 1 ? critical[0].title : `${plural(critical.length, 'problem')} need attention`, tone: 'critical' };
  const when = lastSuccess ? `Synced ${new Date(lastSuccess).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet';
  const review = problems.length ? `${plural(problems.length, 'thing', 'things')} to review` : '';
  return { text: [when, offline && 'offline', review].filter(Boolean).join(' · '), tone: problems.length ? 'warning' : 'ok' };
}

/** A synced place as a run knows it: the vault ('' for its id), or a shared folder, which names its folder as it is now. */
export interface RunPlace {
  id: string;
  folder?: string;
  /** Notes shared by a property: their name, shown instead of a folder. */
  property?: string;
}

/**
 * Where a sync run is, place by place. The status bar has one line for the whole run, so it must not jump between
 * places that sync side by side: it follows the vault while that syncs, then says how many shared folders are still to
 * finish, and follows a shared folder only once it is the last one. Each place's own state is in `stateOf`.
 */
export class RunProgress {
  private places = new Map<string, { place: RunPlace; started: boolean; text: string }>();
  private ended = new Set<string>();

  /** The run is going to cover these places, none started yet. */
  plan(places: RunPlace[]): void {
    this.clear();
    for (const p of places) this.places.set(p.id, { place: p, started: false, text: '' });
  }

  start(p: RunPlace): void {
    this.known(p).started = true;
  }

  /** `text` is what the place is doing, like "Receiving 4 of 10". Anything a place says after it has ended is ignored. */
  say(p: RunPlace, text: string): void {
    if (this.ended.has(p.id)) return;
    const known = this.known(p);
    known.started = true;
    known.text = text;
  }

  end(p: RunPlace): void {
    this.places.delete(p.id);
    this.ended.add(p.id);
  }

  clear(): void {
    this.places.clear();
    this.ended.clear();
  }

  private known(p: RunPlace) {
    let known = this.places.get(p.id);
    if (!known) this.places.set(p.id, (known = { place: p, started: false, text: '' }));
    return known;
  }

  /** The line for the whole run. */
  line(): string {
    const vault = this.places.get('');
    if (vault) return vault.text || 'Syncing…';
    const shares = [...this.places.values()];
    if (shares.length > 1) return `Syncing ${plural(shares.length, 'shared folder')}…`;
    const [one] = shares;
    return one?.text ? `“${one.place.property || one.place.folder}”: ${one.text}` : 'Syncing…';
  }

  /** What the run is doing with the place, if it has not finished with it: 'syncing', or 'waiting' for its turn. */
  stateOf(id: string): 'syncing' | 'waiting' | undefined {
    const known = this.places.get(id);
    return known && (known.started ? 'syncing' : 'waiting');
  }
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

/**
 * Why a passphrase change failed. Every failure but `PassphraseUnknownError` leaves storage on the passphrase in use, so
 * it says so: the unknown case has words of its own, and the two must not read alike.
 */
export function passphraseFailure(e: unknown): string {
  const cause = errorText(e);
  return isTransient(cause) ? `The passphrase was not changed: can't reach the storage. Try again when it is back. (${cause})` : `The passphrase was not changed: ${cause}`;
}

/** What a shared folder with members tells about a failure: whether this device is the owner's, and the owner's name. */
export interface MemberContext {
  owner: boolean;
  ownerName: string;
}

/** A sync that threw, described. `member` is set for a shared folder with members. */
export function describeFailure(e: unknown, member?: MemberContext): Problem {
  const message = errorText(e);
  if (e instanceof MissingFolderError) return missingProblem(e.folder);
  if (e instanceof RemovedError) {
    return {
      id: 'removed',
      severity: 'critical',
      title: 'Removed by its owner',
      detail:
        'Its owner removed you, so it no longer syncs here. The files in the folder stay on this device. ' +
        'Stop sharing it on this device to keep them with the rest of this vault, or ask the owner for a new invite.',
      action: 'stop-sharing',
    };
  }
  if (e instanceof UnverifiedError) {
    const who = member?.ownerName ? `${member.ownerName}'s` : "The owner's";
    return {
      id: 'unverified',
      severity: 'critical',
      title: 'A change was not made by a member who may write to it',
      detail:
        'Its storage holds a change that no member who may change this folder made: someone who can reach the storage without being such a member wrote it, or it was damaged. ' +
        'It does not sync until that change is gone, and nothing from that change on was applied here. The files on this device are untouched. ' +
        (member?.owner
          ? 'Remove the changes that were not signed by a member, and syncing carries on.'
          : `${who} device can remove that change; syncing carries on once it has.`),
      ...(member?.owner && { action: 'remove-unverified' as const }),
    };
  }
  if (e instanceof NotSendingError) {
    return {
      id: 'not-sending',
      severity: 'critical',
      title: 'This device only receives this vault’s changes',
      detail: 'Notes shared by a property are sent from a device that sends this vault’s changes, so nothing is sent from here. Turn off Only receive changes for this vault, or stop sharing them.',
      action: 'settings',
    };
  }
  if (e instanceof OtherSenderError) {
    return {
      id: 'other-sender',
      severity: 'critical',
      title: `Another of your devices (${e.device}) also sends these notes`,
      detail: 'Only one device can send notes shared by a property, so this one stopped. Stop sharing them on one of the two. If you renamed this device, sync now and it carries on.',
      action: 'retry',
    };
  }
  if (e instanceof VaultNotListedError) {
    return { id: 'not-listed', severity: 'critical', title: 'The vault looks empty', detail: `${e.message} Sync tries again once Obsidian lists the vault's files.`, action: 'retry' };
  }
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
    // A member did not choose its keys: they came with the invite, or with the owner's new keys since.
    const owner = member?.ownerName || 'the owner';
    return {
      id: 'access',
      severity: 'critical',
      title: 'The storage refused the access keys',
      detail:
        member && !member.owner
          ? `Sync is stopped. The storage keys this device has for this folder no longer work: ${owner} may have replaced them while this device was not syncing. Ask ${owner} for a new invite, or enter new keys under More… → Change storage keys on this device. (${message})`
          : `Sync is stopped. Check the keys, and that they may read and write this bucket or folder. If these keys may only read, turn on Only receive changes. (${message})`,
      action: 'settings',
    };
  }
  if (/NoSuchBucket/i.test(message)) {
    return { id: 'bucket', severity: 'critical', title: 'Bucket not found', detail: 'Sync is stopped. Check the bucket name and region.', action: 'settings' };
  }
  if (/holds a shared folder with members/i.test(message)) {
    return {
      id: 'members-format',
      severity: 'critical',
      title: 'Storage holds a shared folder with members',
      detail:
        'Sync is stopped. The storage set here now holds a shared folder whose members each join with an invite link of their own, not with a passphrase. ' +
        'To use it on this device, stop syncing it here and join again with an invite from its owner.',
      action: 'stop-sharing',
    };
  }
  if (/holds another shared folder than/i.test(message)) {
    return {
      id: 'other-share',
      severity: 'critical',
      title: 'Storage holds another shared folder',
      detail: `Sync is stopped. The storage this device reaches now holds another shared folder than the one it joined, so nothing was synced. Check its storage keys, or stop sharing it on this device. (${message})`,
      action: 'settings',
    };
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

/**
 * Files a finished sync could not handle, and conflict copies still waiting for the user. `waitingFor`, the owner's
 * name, says the place may not send yet: a member's device the owner's has not confirmed. `suggestTo`, the owner's
 * name, says it is a member's that may only read, which can send what it changed as a suggestion.
 */
export function resultProblems(
  r: Pick<SyncResult, 'errors' | 'tooLarge' | 'unsent'>,
  conflictCopies: string[],
  maxFileSizeMB: number,
  waitingFor?: string,
  suggestTo?: string,
): Problem[] {
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
    const merged = "A file changed in storage as well is merged with the change made here; where that cannot be done, storage's version takes the name and this device's is kept beside it.";
    const owner = suggestTo || 'the owner';
    out.push({
      // One id however many files, so a device that is meant to keep local changes is told once.
      id: 'unsent',
      severity: 'warning',
      title: `${plural(r.unsent.length, 'file')} changed here, not sent`,
      detail:
        suggestTo !== undefined
          ? `You may only read this shared folder, so what is changed here stays here. Notes and canvases can be sent to ${owner} as a suggestion, for ${owner} to take in. ${merged}`
          : waitingFor !== undefined
            ? `This device sends changes once ${waitingFor ? `${waitingFor}'s` : "the owner's"} device confirms it; until then what is changed here stays here, and is sent then. ${merged}`
            : `This device only receives changes, so what is changed here stays here. ${merged} Turn off Only receive changes in settings to send them.`,
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

/** Files changed here and not sent, the vault's or a shared folder's. */
export const isUnsentProblem = (p: Problem) => /^(share:[^:]*:)?unsent$/.test(p.id);

/** Why a storage check failed: what to check, in the words of that kind of storage, then the storage's own words. */
export function connectError(cause: string, storageType: 's3' | 'webdav', write = true): string {
  const may = write ? 'read and write' : 'read';
  const advice: Record<string, string> = {
    access:
      storageType === 'webdav'
        ? `The server refused this user name and password. Check them, and that they may ${may} this folder.`
        : `The storage refused these keys. Check them, and that they may ${may} this bucket.`,
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
