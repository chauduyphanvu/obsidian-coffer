// Branches: a vault's second lines of history. A device is on one line at a time, the main one or a branch, and its
// files are that line's. No Obsidian import, so it runs under plain Node tests.
//
// A branch starts as the main line was at one commit (its fork) and takes commits of its own from there. The stored
// data is shared, so a branch costs only what changes on it. Its record here says what it is called and where it
// started; `Repo.onLine` reads and writes its log.
//
// Merging brings the changes of one line into another, always between the main line and a branch. Both are compared
// with the file table they last had in common (the branch's `base`): at first the table the branch started from,
// after a merge the table of the line that was merged in.
import { pool, randomBytes, toHex } from './bytes.ts';
import type { Line, Repo } from './repo.ts';
import { contentKey, sameContent, type Commit, type Entry } from './types.ts';

export const BRANCH_PREFIX = 'branch/';
/** What the main line is called wherever a line is named. No branch can take the name. */
export const MAIN_NAME = 'main';
/** The first version that reads a vault with branches: every device must run it before a vault is upgraded for them. */
export const BRANCHES_SINCE = '0.12.0';
/** How long a closed branch's own objects stay, for a device that was on it and has been away. */
export const CLOSED_KEPT = 30 * 86_400_000;
const MAX_NAME = 60;

export interface Branch {
  id: string;
  name: string;
  /** The main line's commit it started at. */
  fork: number;
  created: number;
  /** The device that started it. */
  by: string;
  /** When it was closed, and by which device. A closed branch takes no more commits. */
  closed?: number;
  closedBy?: string;
}

/** A device's sync found the branch it is on closed. Nothing was sent: switching to another line carries on from there. */
export class BranchClosedError extends Error {
  constructor(name?: string) {
    super(`${name ? `The branch “${name}”` : 'The branch this device is on'} was closed on another device. Switch to the main line to carry on: what this device has not sent is merged in there, or kept as a copy.`);
  }
}

export const lineOf = (b: Branch): Line => ({ id: b.id, fork: b.fork });

export const newBranchId = (): string => toHex(randomBytes(8));

export function parseBranch(v: unknown): Branch | null {
  const b = v as Partial<Branch> | null;
  const ok =
    !!b && typeof b === 'object' &&
    typeof b.id === 'string' && /^[0-9a-f]{16}$/.test(b.id) &&
    typeof b.name === 'string' && !!b.name &&
    Number.isInteger(b.fork) && b.fork! >= 0 &&
    typeof b.created === 'number' && typeof b.by === 'string' &&
    (b.closed === undefined || typeof b.closed === 'number') &&
    (b.closedBy === undefined || typeof b.closedBy === 'string');
  return ok ? { id: b.id!, name: b.name!, fork: b.fork!, created: b.created!, by: b.by!, ...(b.closed !== undefined && { closed: b.closed }), ...(b.closedBy !== undefined && { closedBy: b.closedBy }) } : null;
}

/** Why `name` cannot be a new branch's, among `existing`; undefined when it can. A closed branch's name is free again. */
export function branchNameProblem(name: string, existing: Branch[]): string | undefined {
  const n = name.trim();
  if (!n) return 'Give the branch a name';
  if (n.length > MAX_NAME) return `A branch name is at most ${MAX_NAME} characters`;
  if (/[\r\n\t]/.test(n)) return 'A branch name is one line of plain text';
  const lower = n.toLowerCase();
  if (lower === MAIN_NAME) return `“${MAIN_NAME}” is what the vault's own line is called`;
  if (existing.some((b) => !b.closed && b.name.toLowerCase() === lower)) return `There is already a branch called “${n}”`;
  return undefined;
}

/** Every branch the vault has a record of, oldest first, closed ones included. One list and a read per branch. */
export async function listBranches(repo: Repo, concurrency = 4): Promise<Branch[]> {
  const docs = await repo.listDocs(BRANCH_PREFIX);
  const out: (Branch | null)[] = new Array<Branch | null>(docs.length).fill(null);
  await pool(docs, concurrency, async (d, i) => {
    out[i] = parseBranch(await repo.readDoc(d.key));
  });
  return out.filter((b): b is Branch => b !== null).sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
}

export async function readBranch(repo: Repo, id: string): Promise<Branch | null> {
  return parseBranch(await repo.readDoc(BRANCH_PREFIX + id));
}

export async function writeBranch(repo: Repo, b: Branch): Promise<void> {
  await repo.writeDoc(BRANCH_PREFIX + b.id, b);
}

/** The branch `name` names among `branches`: an open one by its name, whatever the letter case, or any by its id. */
export function findBranch(branches: Branch[], name: string): Branch | undefined {
  const lower = name.trim().toLowerCase();
  return branches.find((b) => !b.closed && b.name.toLowerCase() === lower) ?? branches.find((b) => b.id === lower);
}

/** True when version `v` ("1.2.3") is `since` or later. One that cannot be read is not. */
export function versionAtLeast(v: string, since: string): boolean {
  const parts = (x: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(x)?.slice(1).map(Number);
  const a = parts(v);
  const b = parts(since)!;
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** The vault cannot be upgraded for branches while these devices' last records name a version from before them. */
export class UpgradeBlockedError extends Error {
  readonly devices: { name: string; version: string }[];
  constructor(devices: { name: string; version: string }[]) {
    super(
      `Not upgraded: ${devices.map((d) => `${d.name} (${d.version})`).join(', ')} ${devices.length === 1 ? 'runs' : 'run'} a version from before branches, which could no longer open the vault. ` +
        `Update Coffer there to ${BRANCHES_SINCE} or later and sync once, or forget a device that is gone for good.`,
    );
    this.devices = devices;
  }
}

/** A line as storage holds it now. */
export interface Tip {
  /** Its newest commit that changes files or data, and that commit's digest ('' before the first). */
  seq: number;
  head: string | undefined;
  files: Map<string, Entry>;
  /** The commit that closed it, when it is a closed branch. */
  closed?: Commit;
}

/**
 * Reads a line's newest file table as a new device would: from its newest snapshot that can be read, then the commits
 * after it, which must follow one another. `repo` is on the line to read.
 */
export async function tipOf(repo: Repo, concurrency = 4): Promise<Tip> {
  const tip: Tip = { seq: 0, head: '', files: new Map() };
  for (const s of (await repo.snapshots()).reverse()) {
    const [snap, at] = await Promise.all([repo.readSnapshotWithHead(s.seq), s.seq ? repo.readCommit(s.seq) : null]);
    if (!snap || (s.seq && !at)) continue;
    if (at && snap.head !== undefined && snap.head !== at.hash) throw new Error(`Remote snapshot ${s.seq} was taken at a different commit than storage holds: the log was tampered with or forked`);
    tip.seq = s.seq;
    tip.head = at ? at.hash : '';
    tip.files = new Map(snap.files);
    break;
  }
  const seqs = await repo.commitSeqsAfter(tip.seq);
  const commits: (Commit | null)[] = new Array<Commit | null>(seqs.length).fill(null);
  await pool(seqs, concurrency, async (seq, i) => {
    commits[i] = await repo.readCommit(seq);
  });
  for (const [i, c] of commits.entries()) {
    if (!c || c.seq !== tip.seq + 1) throw new Error(`Remote log has a gap before commit ${seqs[i]}`);
    if (c.prev !== undefined && tip.head !== undefined && c.prev !== tip.head) throw new Error(`Remote commit ${c.seq} does not follow the commit before it: the log was tampered with or forked`);
    if (c.closed) {
      tip.closed = c;
      break;
    }
    for (const ch of c.changes) {
      if (ch.entry) tip.files.set(ch.path, ch.entry);
      else tip.files.delete(ch.path);
    }
    tip.seq = c.seq;
    tip.head = c.hash;
  }
  return tip;
}

/** A change to our line's file table a merge makes without making any content: it applies only while our entry is still `expect`. */
export interface Take {
  path: string;
  entry: Entry | null;
  expect: Entry | null;
}

export interface MergePlan {
  /** Their versions taken, files removed, and files given the name the other line moved them to. Removals first. */
  take: Take[];
  /** Changed on both lines in different ways: combined when the kind of file can be, else theirs is kept beside ours as a copy. */
  both: { path: string; base: Entry | null; ours: Entry; theirs: Entry }[];
}

/** One line of a merge as a reader sees it. */
export interface TakeRow {
  kind: 'move' | 'add' | 'take' | 'remove';
  path: string;
  /** Where a moved file goes. */
  to?: string;
}

/**
 * A merge's takes for reading: a file removed at one name and added with the same content at another, when exactly one
 * of each holds that content, is one move. Moves first, then the rest in the order given.
 */
export function takeRows(take: Take[]): TakeRow[] {
  const gone = new Map<string, Take[]>();
  const came = new Map<string, Take[]>();
  const add = (m: Map<string, Take[]>, e: Entry, t: Take) => {
    if (e.size > 0) m.set(contentKey(e), [...(m.get(contentKey(e)) ?? []), t]);
  };
  for (const t of take) {
    if (!t.entry && t.expect) add(gone, t.expect, t);
    else if (t.entry && !t.expect) add(came, t.entry, t);
  }
  const moved = new Map<Take, Take>();
  for (const [key, from] of gone) {
    const to = came.get(key);
    if (from.length === 1 && to?.length === 1) moved.set(from[0], to[0]);
  }
  const targets = new Set(moved.values());
  const rows: TakeRow[] = [...moved].map(([from, to]) => ({ kind: 'move' as const, path: from.path, to: to.path }));
  for (const t of take) {
    if (moved.has(t) || targets.has(t)) continue;
    rows.push({ kind: t.entry ? (t.expect ? 'take' : 'add') : 'remove', path: t.path });
  }
  return rows;
}

const same = (a: Entry | null | undefined, b: Entry | null | undefined) => (a && b ? sameContent(a, b) : !a && !b);
const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Files `side` moved without changing them since `base`: the one file gone and the one new with the same content, by old path. */
function movesIn(base: Map<string, Entry>, side: Map<string, Entry>): Map<string, string> {
  const gone = new Map<string, string[]>();
  const came = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, e: Entry, path: string) => {
    if (e.size > 0) m.set(contentKey(e), [...(m.get(contentKey(e)) ?? []), path]);
  };
  for (const [path, e] of base) if (!side.has(path)) add(gone, e, path);
  for (const [path, e] of side) if (!base.has(path)) add(came, e, path);
  const out = new Map<string, string>();
  for (const [key, from] of gone) {
    const to = came.get(key);
    if (from.length === 1 && to?.length === 1) out.set(from[0], to[0]);
  }
  return out;
}

/**
 * Folders `side` moved whole: a file moved from one to the same name in another, and nothing of `base` left in or
 * under the old one. Longest old folder first, so a file goes by the nearest folder that moved.
 */
function foldersMoved(base: Map<string, Entry>, side: Map<string, Entry>, moves: Map<string, string>): [string, string][] {
  const pairs = new Map<string, string>();
  for (const [from, to] of moves) {
    const a = dirOf(from);
    const b = dirOf(to);
    if (a && a !== b && nameOf(from) === nameOf(to) && !pairs.has(a)) pairs.set(a, b);
  }
  const left = (dir: string) => {
    for (const path of side.keys()) if (path.startsWith(`${dir}/`) && base.has(path)) return true;
    return false;
  };
  return [...pairs].filter(([a]) => !left(a)).sort(([a], [b]) => b.length - a.length);
}

const under = (path: string, folders: [string, string][]): string | undefined => {
  for (const [a, b] of folders) if (path.startsWith(`${a}/`)) return `${b ? `${b}/` : ''}${path.slice(a.length + 1)}`;
  return undefined;
};

/**
 * What brings the changes `theirs` made since `base` into `ours`, keeping ours. Per file: changed only there, theirs
 * is taken; changed only here, or the same way on both, nothing; changed both ways, see `MergePlan.both`; edited on
 * one line and deleted on the other, the edit stays. A file one line moved without changing it takes the other line's
 * edit to its new name, and a folder one line moved whole takes the other line's new files with it.
 */
export function planMerge(base: Map<string, Entry>, ours: Map<string, Entry>, theirs: Map<string, Entry>): MergePlan {
  const take: Take[] = [];
  const both: MergePlan['both'] = [];
  const done = new Set<string>();
  const get = (m: Map<string, Entry>, path: string) => m.get(path) ?? null;
  const put = (path: string, entry: Entry | null) => take.push({ path, entry, expect: get(ours, path) });

  const theirMoves = movesIn(base, theirs);
  const ourMoves = movesIn(base, ours);
  // They moved a file we edited: our edit goes to their name for it.
  for (const [from, to] of theirMoves) {
    const mine = ours.get(from);
    if (!mine || same(mine, base.get(from)) || ours.has(to)) continue;
    put(from, null);
    put(to, mine);
    done.add(from).add(to);
  }
  // We moved a file they edited: their edit comes to our name for it.
  for (const [from, to] of ourMoves) {
    const their = theirs.get(from);
    if (!their || same(their, base.get(from)) || done.has(from) || done.has(to) || theirs.has(to)) continue;
    put(to, their);
    done.add(from).add(to);
  }
  // A folder moved whole on one line takes the files the other line added to it.
  const theirFolders = foldersMoved(base, theirs, theirMoves);
  const ourFolders = foldersMoved(base, ours, ourMoves);
  for (const [path, mine] of ours) {
    const to = base.has(path) || done.has(path) || theirs.has(path) ? undefined : under(path, theirFolders);
    if (!to || ours.has(to) || theirs.has(to) || done.has(to)) continue;
    put(path, null);
    put(to, mine);
    done.add(path).add(to);
  }
  for (const [path, their] of theirs) {
    const to = base.has(path) || done.has(path) || ours.has(path) ? undefined : under(path, ourFolders);
    if (!to || ours.has(to) || theirs.has(to) || done.has(to)) continue;
    put(to, their);
    done.add(path).add(to);
  }

  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    if (done.has(path)) continue;
    const b = get(base, path);
    const o = get(ours, path);
    const t = get(theirs, path);
    if (same(o, t) || same(t, b)) continue;
    if (same(o, b) || !o) put(path, t);
    else if (t) both.push({ path, base: b, ours: o, theirs: t });
  }
  take.sort((x, y) => Number(!!x.entry) - Number(!!y.entry) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  both.sort((x, y) => (x.path < y.path ? -1 : 1));
  return { take, both };
}
