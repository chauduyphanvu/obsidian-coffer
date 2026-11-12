// Each device keeps a small encrypted record of how far it has got, so any device can tell whether the others keep up.
// No Obsidian import, so it runs under plain Node tests.
import { pool, utf8 } from './bytes.ts';
import type { RepoView } from './engine.ts';
import type { Repo } from './repo.ts';
import { DAY } from './retention.ts';
import { plural } from './text.ts';

const PREFIX = 'dev/';
const QUIET_AFTER = 7 * DAY;
const HEARTBEAT_EVERY = 30 * 60_000;

/** What a device writes about itself. */
interface Heartbeat {
  name: string;
  platform: string;
  version: string;
  time: number;
  /** The newest commit it had seen, and that commit's digest when its state held one. */
  seq: number;
  head?: string;
}

export type DeviceState = 'current' | 'behind' | 'quiet' | 'diverged';

export interface DeviceStatus {
  name: string;
  platform: string;
  version: string;
  lastSeen: number;
  /** Commits it has not seen yet, as far as this device can tell. */
  behind: number;
  isSelf: boolean;
  state: DeviceState;
}

/** Keyed with the vault key, so storage cannot test a guessed device name, and safe as an object key whatever the name holds. */
export async function deviceKey(repo: Repo, name: string): Promise<string> {
  return PREFIX + (await repo.chunkId(utf8.encode(name)));
}

function parse(v: unknown): Heartbeat | null {
  const r = v as Partial<Heartbeat> | null;
  const ok =
    !!r &&
    typeof r.name === 'string' &&
    typeof r.platform === 'string' &&
    typeof r.version === 'string' &&
    typeof r.time === 'number' &&
    typeof r.seq === 'number' &&
    r.seq >= 0 &&
    (r.head === undefined || typeof r.head === 'string');
  return ok ? (r as Heartbeat) : null;
}

/** Costs one write. */
export async function writeHeartbeat(view: RepoView, info: { platform: string; version: string }): Promise<void> {
  const { repo, st, cfg, now } = view;
  const record: Heartbeat = { name: cfg.deviceName, platform: info.platform, version: info.version, time: now, seq: st.lastSeq };
  if (st.head) record.head = st.head;
  await repo.writeDoc(await deviceKey(repo, cfg.deviceName), record);
}

/** Costs one list and one read per record, the reads in parallel. */
export async function listDevices(view: RepoView): Promise<DeviceStatus[]> {
  const { repo, st, cfg, now } = view;
  const docs = await repo.listDocs(PREFIX);
  const records: (Heartbeat | null)[] = new Array(docs.length).fill(null);
  await pool(docs, cfg.concurrency, async (doc, i) => {
    try {
      records[i] = parse(await repo.readDoc(doc.key));
    } catch {
      // One record that cannot be read must not hide the others.
    }
  });
  return records
    .filter((r): r is Heartbeat => r !== null)
    .map((r): DeviceStatus => {
      const isSelf = r.name === cfg.deviceName;
      // This device's own record can be older than the view, which has just been brought up to date.
      const behind = isSelf ? 0 : Math.max(0, st.lastSeq - r.seq);
      const diverged = !isSelf && !!st.head && !!r.head && r.seq === st.lastSeq && r.head !== st.head;
      const state: DeviceState = diverged ? 'diverged' : isSelf ? 'current' : now - r.time > QUIET_AFTER ? 'quiet' : behind ? 'behind' : 'current';
      return { name: r.name, platform: r.platform, version: r.version, lastSeen: r.time, behind, isSelf, state };
    })
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || b.lastSeen - a.lastSeen || (a.name < b.name ? -1 : 1));
}

/** For a device that is gone for good. One that still syncs writes its record again at its next sync. */
export async function forgetDevice(view: RepoView, name: string): Promise<void> {
  if (name === view.cfg.deviceName) throw new Error('This device cannot be forgotten: it would write its record again at its next sync');
  await view.repo.deleteDoc(await deviceKey(view.repo, name));
}

/** `lastWritten` is when this app session last wrote one, 0 when it has not. */
export const heartbeatDue = (lastWritten: number, now: number): boolean => !lastWritten || now - lastWritten > HEARTBEAT_EVERY;

/** How long ago, in words. Another device's clock can run ahead of this one, so a negative span reads as now. */
export function agoText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  if (minutes < 24 * 60) return `${plural(Math.floor(minutes / 60), 'hour')} ago`;
  return `${plural(Math.floor(minutes / (24 * 60)), 'day')} ago`;
}

export function statusText(d: DeviceStatus, now: number): string {
  switch (d.state) {
    case 'current':
      return 'Up to date';
    case 'behind':
      return `${plural(d.behind, 'change')} behind`;
    case 'quiet':
      return `Not seen for ${plural(Math.floor((now - d.lastSeen) / DAY), 'day')}`;
    case 'diverged':
      return `This device and ${d.name} disagree about the sync history. Run "Check synced data for damage".`;
  }
}

export const statusTone = (d: DeviceStatus): 'ok' | 'warning' | 'critical' => (d.state === 'current' ? 'ok' : d.state === 'diverged' ? 'critical' : 'warning');
