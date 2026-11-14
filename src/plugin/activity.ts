// Who changed what in a shared folder, in words: the Activity screen, and the notice after a sync that brought in other
// people's changes. No Obsidian import, so it runs under plain Node tests.
import type { Arrival } from '../core/engine.ts';
import { MemberBook, type Member, type MemberChange } from '../core/members.ts';
import { plural } from '../core/text.ts';
import type { Activity } from '../core/timeline.ts';
import { changesLabel } from './restore.ts';
import { kindNoun } from './suggestions.ts';

/** What tells this device's own changes from others': its member id in a shared folder with members, and its name. */
export interface Self {
  member?: string;
  device: string;
  /** Every member change the device holds, oldest first, for names; none for a folder shared with a passphrase. */
  changes: MemberChange[];
}

/** The name member `id` had at commit `seq`, or failing that the newest name it had. */
export function memberName(changes: MemberChange[], id: string, seq: number): string | undefined {
  const then = MemberBook.before(changes, seq)?.members.find((m) => m.id === id);
  if (then) return then.name;
  for (let i = changes.length - 1; i >= 0; i--) {
    const m = changes[i].members.find((x) => x.id === id);
    if (m) return m.name;
  }
  return undefined;
}

/** Who made a change: a member by name (in a folder shared with a passphrase, a device), or this device's own member. */
export function whoLabel(c: { seq: number; device: string; signer?: string }, self: Self): string {
  if (!c.signer) return c.device === self.device ? 'This device' : c.device;
  if (c.signer === self.member) return c.device === self.device ? 'You' : `You, on ${c.device}`;
  return memberName(self.changes, c.signer, c.seq) ?? c.device;
}

/**
 * Who saved a version, as the Versions screen says it, within a sentence: a member by name, as Activity names them, and
 * this device's own member as you; where nobody signs, as in the vault or a folder shared with a passphrase, the device.
 */
export function savedBy(v: { seq: number; device: string; signer?: string }, self: Self): string {
  if (!v.signer) return v.device === self.device ? 'this device' : v.device;
  if (v.signer === self.member) return v.device === self.device ? 'you' : `you, on ${v.device}`;
  return memberName(self.changes, v.signer, v.seq) ?? v.device;
}

/** What a member change did, a sentence each: who started the folder, was invited, joined or was removed. */
export function memberEvents(before: Member[], after: Member[]): string[] {
  const out: string[] = [];
  const was = new Map(before.map((m) => [m.id, m]));
  const is = new Set(after.map((m) => m.id));
  for (const m of after) {
    const old = was.get(m.id);
    if (!old) {
      if (m.role === 'owner') out.push(`${m.name} started sharing this folder`);
      else if (m.follow) out.push(`A follow link, “${m.name}”, was made`);
      else out.push(`${m.name} was invited to ${m.role === 'write' ? 'edit' : 'read'}`);
    } else if (m.pub && !old.pub) out.push(`${m.name} joined`);
  }
  for (const m of before) if (!is.has(m.id)) out.push(m.follow ? `The follow link “${m.name}” was removed` : `${m.name} was removed`);
  return out;
}

export interface ActivityRow {
  seq: number;
  time: number;
  /** Who did it; '' for a change to the members, which `text` says in full. */
  who: string;
  text: string;
  files: { path: string; kind: 'added' | 'changed' | 'deleted' }[];
}

/** The Activity screen's rows for `items` (newest first): one per change to the files, one per member event. */
export function activityRows(items: Activity[], self: Self): ActivityRow[] {
  const out: ActivityRow[] = [];
  for (const a of items) {
    if (a.members) {
      for (const text of memberEvents(a.members.before, a.members.after)) out.push({ seq: a.seq, time: a.time, who: '', text, files: [] });
      continue;
    }
    const files = [
      ...a.changed.map((path) => ({ path, kind: 'changed' as const })),
      ...a.added.map((path) => ({ path, kind: 'added' as const })),
      ...a.deleted.map((path) => ({ path, kind: 'deleted' as const })),
    ];
    out.push({ seq: a.seq, time: a.time, who: whoLabel(a, self), text: changesLabel({ added: a.added.length, changed: a.changed.length, deleted: a.deleted.length }), files });
  }
  return out;
}

/** "Lan", "Lan and Tom", "Lan, Tom and 2 others". */
function names(list: string[]): string {
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, 2).join(', ')} and ${plural(list.length - 2, 'other')}`;
}

/**
 * The line after a sync of the shared folder `folder` that brought in other people's changes, like "Lan changed 3
 * notes in “Family”": everyone together, each file once. '' when only this device's own member (on its other devices)
 * changed something, or nothing came in.
 */
export function arrivalLine(folder: string, arrivals: Arrival[], self: Self): string {
  const others = arrivals.filter((a) => (a.signer ? a.signer !== self.member : a.device !== self.device));
  if (!others.length) return '';
  const who = [...new Set(others.map((a) => (a.signer ? (a.name ?? a.device) : a.device)))];
  const paths = [...new Set(others.flatMap((a) => a.paths))];
  return `${names(who)} changed ${plural(paths.length, kindNoun(paths))} in “${folder}”`;
}

/**
 * The Activity of one place, a page at a time, newest first, read from a history that `open` gives once. A page that
 * is still loading when `reset` comes is dropped.
 */
export class ActivityPages<L> {
  look?: L;
  items: Activity[] = [];
  more = true;
  loading = false;
  private before?: number;
  private generation = 0;
  private open: () => Promise<L>;
  private page: (look: L, beforeSeq: number | undefined) => Promise<{ items: Activity[]; next?: number }>;

  constructor(open: () => Promise<L>, page: (look: L, beforeSeq: number | undefined) => Promise<{ items: Activity[]; next?: number }>) {
    this.open = open;
    this.page = page;
  }

  reset(): void {
    this.generation++;
    this.look = undefined;
    this.items = [];
    this.before = undefined;
    this.more = true;
    this.loading = false;
  }

  /** Loads the next page. False when nothing was added: one was loading already, there is no more, or `reset` came meanwhile. */
  async next(): Promise<boolean> {
    if (this.loading || !this.more) return false;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.loading = true;
    try {
      const look = this.look ?? (await this.open());
      if (!current()) return false;
      this.look = look;
      const page = await this.page(look, this.before);
      if (!current()) return false;
      this.items.push(...page.items);
      this.before = page.next;
      this.more = page.next !== undefined;
      return true;
    } finally {
      if (current()) this.loading = false;
    }
  }
}
