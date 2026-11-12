// How often to ask the storage whether another device has committed. No Obsidian import, so it runs under plain Node tests.

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
