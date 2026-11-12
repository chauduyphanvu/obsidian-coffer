// Which files may have changed since each engine's last sync, collected from the vault's events, and when a sync may
// look at those alone instead of listing everything. No Obsidian import, so it runs under plain Node tests.
import type { Share } from './settings.ts';
import { goneWith, placeOf } from './shares.ts';

/**
 * What asked for a sync. After `edit` (the wait after the vault's events) and `poll` (another device committed) every
 * local change since the last sync came with an event. After the others one may not have: nothing listened before
 * `start`, a `manual` sync and the `timer` are there to catch what was missed, and before `resume` the app may have
 * been suspended while other apps or iCloud wrote files.
 */
export type Why = 'edit' | 'poll' | 'start' | 'manual' | 'timer' | 'resume';

export const fromEvents = (why: Why) => why === 'edit' || why === 'poll';

/** What one place, the vault or a shared folder, has seen since its last sync began. */
export interface Seen {
  /** Files created, changed or deleted, by their path in that place's engine. */
  paths: Set<string>;
  /** Something changed that `paths` may not cover: a folder moved or deleted, a sync failed, or nothing was listening. */
  unknown: boolean;
}

/** What a place's events cannot tell. */
export interface Unseen {
  /** The vault's settings folder is due to be listed again: its files fire no events. */
  settingsDue?: boolean;
  /** A shared folder's own folder is not in the vault: only a listing notices that, and stops instead of deleting. */
  folderMissing?: boolean;
}

/** Whether a sync of a place may look only at the files it has seen change; otherwise it lists them all. */
export function trustSeen(seen: Seen, why: Why, unseen: Unseen = {}): boolean {
  return fromEvents(why) && !seen.unknown && !unseen.settingsDue && !unseen.folderMissing;
}

/** The vault's events, sorted by the place they belong to, as shared folders route paths. */
export class ChangeLog {
  private seen = new Map<string, Seen>();
  private shares: () => Share[];

  constructor(shares: () => Share[]) {
    this.shares = shares;
  }

  /** A place not heard of since the plugin started has missed everything before. */
  private of(id: string): Seen {
    let s = this.seen.get(id);
    if (!s) this.seen.set(id, (s = { paths: new Set(), unknown: true }));
    return s;
  }

  /** A file created, changed or deleted, by vault path. A file renamed or moved is both paths. Returns its place's id. */
  file(path: string): string {
    const { share, path: inside } = placeOf(this.shares(), path);
    const id = share?.id ?? '';
    if (inside) this.of(id).paths.add(inside);
    return id;
  }

  /**
   * A folder renamed or moved to `to`, or deleted: the places it was and is in, and the shared folders it is or holds.
   * Returns their ids.
   */
  folder(path: string, to?: string): string[] {
    const shares = this.shares();
    const ids: string[] = [];
    for (const at of to === undefined ? [path] : [path, to]) {
      ids.push(placeOf(shares, at).share?.id ?? '', ...goneWith(shares, at).map((s) => s.id));
    }
    for (const id of ids) this.of(id).unknown = true;
    return [...new Set(ids)];
  }

  /** Changes may have gone unseen anywhere. */
  lost(): void {
    this.seen.clear();
  }

  /**
   * For the sync of `share`, or of the vault, that starts now: the paths to pass as `changed`, or undefined to list.
   * What happens from now on belongs to the next one.
   */
  take(share: Share | undefined, why: Why, unseen?: Unseen): Set<string> | undefined {
    const id = share?.id ?? '';
    const s = this.of(id);
    this.seen.set(id, { paths: new Set(), unknown: false });
    return trustSeen(s, why, unseen) ? s.paths : undefined;
  }

  /** The sync of `share`, or of the vault, failed: the next one lists. */
  failed(share: Share | undefined): void {
    this.of(share?.id ?? '').unknown = true;
  }
}
