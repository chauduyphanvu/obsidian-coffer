// How often to ask the storage whether another device has committed, which places to ask, and when to try again a
// place whose sync failed. No Obsidian import, so it runs under plain Node tests.
import type { SyncResult } from '../core/engine.ts';
import type { Why } from './changes.ts';

const FAST_MIN_MS = 5_000;
const ACTIVE_MS = 2 * 60_000;
const IDLE_MS = 10 * 60_000;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Milliseconds until the next poll, or undefined when polling is off. Right after activity (the app came to the
 * front, or changes arrived from another device) the user may be switching devices, so poll six times as often as
 * the setting, but not faster than every 5 seconds; after a long quiet spell, back off.
 */
export function nextPollDelay(pollSeconds: number, lastActivity: number, now: number): number | undefined {
  if (!(pollSeconds > 0)) return undefined;
  const idle = now - lastActivity;
  if (idle < ACTIVE_MS) return Math.max(FAST_MIN_MS, (pollSeconds * 1000) / 6);
  const base = Math.max(5, pollSeconds) * 1000;
  return idle >= IDLE_MS ? base * 2 : base;
}

/** Whether a sync brought changes from another device, which suggests the user is switching devices. */
export const receivedChanges = (r: SyncResult) => r.pulled + r.deletedLocal + r.merged + r.conflictCopies.length > 0;

/**
 * Places, the vault ('') or a shared folder (its id), whose last sync paused before deleting many files. Syncing one
 * again would pause again, and its storage keeps answering that something changed, so no sync that nobody asked for
 * includes it, and a poll does not ask it, until the user acts (a sync they ask for, which is how keeping or deleting
 * the files runs too) or something in it changes on this device.
 */
export class Pauses {
  private ids = new Set<string>();

  pause(id: string): void {
    this.ids.add(id);
  }

  /** The place synced, or something in it changed here. */
  lift(id: string): void {
    this.ids.delete(id);
  }

  /** Whether a sync started for `why` includes the place. */
  includes(id: string, why: Why): boolean {
    return why === 'manual' || !this.ids.has(id);
  }
}

/**
 * Places whose last sync failed, other than by pausing before a mass delete. Trying one again at once would most likely
 * fail the same way, after opening its storage and downloading again, so no sync that nobody asked for includes it, and
 * a poll does not ask it, for 5 seconds after the first failure, twice as long after each failure after that, up to 5
 * minutes, until one succeeds. A sync the user asks for tries it at once.
 */
export class Retries {
  private waits = new Map<string, { failures: number; until: number }>();

  /** The place's sync failed at `now`. Returns how long it waits. */
  failed(id: string, now: number): number {
    const failures = this.waits.get(id)?.failures ?? 0;
    const ms = Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_MAX_MS);
    this.waits.set(id, { failures: failures + 1, until: now + ms });
    return ms;
  }

  /** The place synced, or is gone. */
  reset(id: string): void {
    this.waits.delete(id);
  }

  /** Whether a sync started for `why` at `now` includes the place. */
  includes(id: string, why: Why, now: number): boolean {
    return why === 'manual' || now >= (this.waits.get(id)?.until ?? 0);
  }

  /** When the soonest wait still running ends, for a sync then; undefined when none is. */
  due(now: number): number | undefined {
    let soonest: number | undefined;
    for (const { until } of this.waits.values()) if (until > now && (soonest === undefined || until < soonest)) soonest = until;
    return soonest;
  }
}

/**
 * One poll: asks each place that a poll includes whether its storage has changes, until one has. True means a sync is
 * due; a place that can not be asked (offline) counts as unchanged, the next sync reports it.
 */
export async function pollPlaces(ids: string[], gate: { includes(id: string, why: Why): boolean }, changed: (id: string) => Promise<boolean>): Promise<boolean> {
  for (const id of ids) {
    if (!gate.includes(id, 'poll')) continue;
    try {
      if (await changed(id)) return true;
    } catch {
      // Offline or unreachable.
    }
  }
  return false;
}
