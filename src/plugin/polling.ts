// How often to ask the storage whether another device has committed, and which places to ask. No Obsidian import, so
// it runs under plain Node tests.
import type { Why } from './changes.ts';

const FAST_MS = 5_000;
const ACTIVE_MS = 2 * 60_000;
const IDLE_MS = 10 * 60_000;

/**
 * Milliseconds until the next poll, or undefined when polling is off. Right after activity another device is likely
 * to be involved (the user is about to switch devices), so poll fast; after a long quiet spell, back off.
 */
export function nextPollDelay(pollSeconds: number, lastActivity: number, now: number): number | undefined {
  if (!(pollSeconds > 0)) return undefined;
  const idle = now - lastActivity;
  if (idle < ACTIVE_MS) return FAST_MS;
  const base = Math.max(5, pollSeconds) * 1000;
  return idle >= IDLE_MS ? base * 2 : base;
}

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
 * One poll: asks each place that is not paused whether its storage has changes, until one has. True means a sync is
 * due and counts as activity; a place that can not be asked (offline) counts as unchanged, the next sync reports it.
 */
export async function pollPlaces(ids: string[], pauses: Pauses, changed: (id: string) => Promise<boolean>): Promise<boolean> {
  for (const id of ids) {
    if (!pauses.includes(id, 'poll')) continue;
    try {
      if (await changed(id)) return true;
    } catch {
      // Offline or unreachable.
    }
  }
  return false;
}
