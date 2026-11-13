import { pool } from './bytes.ts';
import { placeKey } from './compact.ts';
import type { SyncConfig } from './config.ts';
import { packRanges } from './packer.ts';
import { seqKey, type Repo } from './repo.ts';
import { keptVersions } from './retention.ts';
import type { LocalState } from './state.ts';
import { errorText, plural } from './text.ts';
import { sameContent, type ChunkRef, type Commit, type Entry } from './types.ts';

export interface VerifyOptions {
  /** Also download and decrypt every chunk the current files use, and check its content against its id. */
  deep?: boolean;
  onProgress?: (progress: { phase: 'log' | 'chunks'; done: number; total: number }) => void;
}

export interface VerifyProblem {
  message: string;
  /** The storage object at fault, such as `pack/<id>` or `log/<seq>`. */
  object?: string;
  /** Files whose current version it affects. */
  paths?: string[];
  /** Files whose current version is fine, but an earlier one that history offers was stored in this pack and can no longer be restored. */
  earlier?: string[];
}

export interface VerifyReport {
  deep: boolean;
  /** Commits read and checked for order and chaining. */
  commits: number;
  /** The snapshot compared with the file table the log builds, or 0 when none could be. */
  snapshot: number;
  /** Files in the current table. */
  files: number;
  /** Packs the current files use, each found in the listing and long enough for its chunks. */
  packs: number;
  /** Deep mode: chunks downloaded, decrypted and checked against their id, and the bytes that took. */
  chunks: number;
  bytes: number;
  problems: VerifyProblem[];
}

interface Context extends VerifyOptions {
  concurrency: number;
  /** Chunks of one pack closer together than this are fetched in one request. */
  rangeGapBytes: number;
  /** The newest commit this device has seen, so a log cut back or forked under it is reported. */
  seen?: { seq: number; head?: string };
  /** When given, also finds data that only earlier versions history offers (`keptVersions`, as of `now`) need: see `lostInHistory`. */
  history?: { cfg: SyncConfig; now: number };
}

/** Ranges of a pack in flight at once in deep mode, each at most MAX_RANGE: memory stays at a few packs' worth. */
const PARALLEL = 3;
const MAX_RANGE = 4 << 20;
const LOG_WINDOW = 256;

/**
 * Checks the remote end to end and never writes to it. Quick mode reads every commit and lists
 * snapshots and packs; deep mode also downloads every chunk of the current files. With `history`, and a log that is
 * whole, it also looks at what the earlier versions need, in the packs listed already: besides what the commits cost,
 * a read of `pruned`, a list of the snapshots, a read of the snapshot the kept moments start from, and one read for
 * each interval of `snapshotEvery` commits since then, or for each commit where its digest is missing.
 */
export async function verifyRepo(repo: Repo, o: Context): Promise<VerifyReport> {
  const report: VerifyReport = { deep: !!o.deep, commits: 0, snapshot: 0, files: 0, packs: 0, chunks: 0, bytes: 0, problems: [] };
  const problem = (message: string, object?: string, paths?: Iterable<string>) => {
    report.problems.push({ message, ...(object && { object }), ...(paths && { paths: [...new Set(paths)].sort() }) });
  };
  const [seqs, snaps, packs] = await Promise.all([repo.commitSeqsAfter(0), repo.snapshots(), repo.listPacks()]);
  const { files, movedBy } = await replayLog(repo, o, seqs, snaps.at(-1)?.seq ?? 0, report, problem);
  report.files = files.size;
  const bad = checkPacks(files, movedBy, packs, report, problem);
  const damaged = chunksIn(files, bad);
  if (o.deep) await checkChunks(repo, o, files, bad, report, problem, (ref) => void damaged.set(placeKey(ref), ref));
  // Which earlier versions history offers is read off the log, which says so only when it is whole.
  if (o.history && !report.problems.some((p) => /^(log|snap)\//.test(p.object ?? ''))) {
    await checkHistory(repo, o.history, { lastSeq: seqs.at(-1) ?? 0, remote: files }, packs, damaged, bad, report);
  }
  return report;
}

/** The chunks the files keep in the packs `bad`, by place. */
function chunksIn(files: Map<string, Entry>, bad: Set<string>): Map<string, ChunkRef> {
  const out = new Map<string, ChunkRef>();
  for (const e of files.values()) for (const ref of e.chunks) if (bad.has(ref.pack)) out.set(placeKey(ref), ref);
  return out;
}

/** The current files with a chunk in a damaged place. */
export function affectedBy(files: Map<string, Entry>, damaged: Map<string, ChunkRef>): string[] {
  return [...files].filter(([, e]) => e.chunks.some((c) => damaged.has(placeKey(c)))).map(([path]) => path);
}

type Listing = { id: string; size: number }[];
type Lost = Map<string, { end: number; paths: Set<string> }>;

/**
 * The packs, missing or too short, that earlier versions history offers (`keptVersions`, as of `now`) need, each with
 * the files whose earlier versions are in it and how long it must be for them. A chunk counts only when no current
 * file keeps it where it can be read, and files in `skip` are left out, being reported for their current version.
 * Reads the log as `keptVersions` does, and writes nothing unless `mend`.
 */
export async function lostInHistory(
  repo: Repo, st: Pick<LocalState, 'lastSeq' | 'remote'>, cfg: SyncConfig, now: number, listing: Listing, damaged: Map<string, ChunkRef>, skip: Set<string>, mend = true,
): Promise<Lost> {
  const size = new Map(listing.map((p) => [p.id, p.size]));
  const lost = (c: ChunkRef) => (size.get(c.pack) ?? -1) < c.off + c.len;
  const whole = new Set<string>();
  for (const e of st.remote.values()) for (const c of e.chunks) if (!damaged.has(placeKey(c))) whole.add(c.id);
  const out: Lost = new Map();
  await keptVersions(repo, st, cfg, now, (path, e) => {
    if (skip.has(path)) return;
    for (const c of e.chunks) {
      if (!lost(c) || whole.has(c.id)) continue;
      let n = out.get(c.pack);
      if (!n) out.set(c.pack, (n = { end: 0, paths: new Set() }));
      n.end = Math.max(n.end, c.off + c.len);
      n.paths.add(path);
    }
  }, mend);
  return out;
}

/**
 * Reports, apart from the problems of the current files, each pack that only earlier versions need and that is missing
 * or too short. A pack in `bad` already has its report, for the current files, and repairing it may bring the earlier
 * versions back too.
 */
async function checkHistory(
  repo: Repo, h: NonNullable<Context['history']>, st: Pick<LocalState, 'lastSeq' | 'remote'>, listing: Listing, damaged: Map<string, ChunkRef>, bad: Set<string>, report: VerifyReport,
): Promise<void> {
  let lost: Lost;
  try {
    lost = await lostInHistory(repo, st, h.cfg, h.now, listing, damaged, new Set(affectedBy(st.remote, damaged)), false);
  } catch (e) {
    report.problems.push({ message: `Earlier versions could not be checked: ${errorText(e)}` });
    return;
  }
  const size = new Map(listing.map((p) => [p.id, p.size]));
  for (const [pack, n] of lost) {
    if (bad.has(pack)) continue;
    const have = size.get(pack);
    const files = plural(n.paths.size, 'file');
    report.problems.push({
      message:
        have === undefined
          ? `Pack ${pack} is missing: earlier versions of ${files} cannot be restored, though the current files are fine`
          : `Pack ${pack} is ${have} bytes, shorter than the ${n.end} that earlier versions of ${files} need: they cannot be restored, though the current files are fine`,
      object: `pack/${pack}`,
      earlier: [...n.paths].sort(),
    });
  }
}

/**
 * The chunks the current files keep in places that cannot be read, by place (`placeKey`), from one listing of
 * the packs. A pack that is missing or shorter than its chunks need is suspect throughout, so every chunk the
 * files keep in it counts. With `deep`, a chunk that cannot be downloaded, opened or matched to its id counts too.
 */
export async function damagedChunks(
  repo: Repo, files: Map<string, Entry>, listing: { id: string; size: number }[], o: VerifyOptions & { concurrency: number; rangeGapBytes: number },
): Promise<Map<string, ChunkRef>> {
  const report: VerifyReport = { deep: !!o.deep, commits: 0, snapshot: 0, files: 0, packs: 0, chunks: 0, bytes: 0, problems: [] };
  const none = () => {};
  const bad = checkPacks(files, new Map(), listing, report, none);
  const damaged = chunksIn(files, bad);
  if (o.deep) await checkChunks(repo, o, files, bad, report, none, (ref) => void damaged.set(placeKey(ref), ref));
  return damaged;
}

type Problem = (message: string, object?: string, paths?: Iterable<string>) => void;

/**
 * Replays the log, checking that it is contiguous and chained, that commits marked as moves change no
 * content, and compares the newest snapshot with the table at its commit. Returns the current table:
 * the log's, or where the log cannot be replayed, the snapshot's with the commits after it, as a new
 * device would see it; and for files whose current entry a move wrote, that move's commit.
 */
async function replayLog(
  repo: Repo, o: Context, seqs: number[], snapSeq: number, report: VerifyReport, problem: Problem,
): Promise<{ files: Map<string, Entry>; movedBy: Map<string, number> }> {
  const last = seqs.at(-1) ?? 0;
  const listed = new Set(seqs);
  let expected = 1;
  for (const seq of seqs) {
    if (seq > expected) {
      const which = seq - 1 > expected ? `Commits ${expected}-${seq - 1} are` : `Commit ${expected} is`;
      problem(`${which} missing: there is a gap before commit ${seq}`, seqKey('log', expected));
    }
    expected = seq + 1;
  }
  if (o.seen && o.seen.seq > last) {
    problem(`This device has seen commit ${o.seen.seq}, but the log ends at ${last}: newer commits are missing`, seqKey('log', o.seen.seq));
  }

  const snapKey = seqKey('snap', snapSeq);
  let snap: Awaited<ReturnType<Repo['readSnapshotWithHead']>> = null;
  if (snapSeq) {
    try {
      snap = await repo.readSnapshotWithHead(snapSeq);
      if (!snap) problem(`Snapshot ${snapSeq} is listed but cannot be read`, snapKey);
    } catch (e) {
      problem(`Snapshot ${snapSeq} cannot be read: ${errorText(e)}`, snapKey);
    }
    if (snapSeq > last) problem(`Snapshot ${snapSeq} is newer than the last commit, ${last}: commits are missing`, snapKey);
  }

  let table = new Map<string, Entry>();
  const movedBy = new Map<string, number>();
  // Digest of the commit before the next one; unknown after a commit that is missing or unreadable.
  let prev: string | undefined = '';
  let intact = true;
  for (let lo = 1; lo <= last; lo += LOG_WINDOW) {
    const block: (Commit | Error | null)[] = new Array<Commit | Error | null>(Math.min(LOG_WINDOW, last - lo + 1)).fill(null);
    await pool(block, o.concurrency, async (_, i) => {
      if (!listed.has(lo + i)) return;
      try {
        block[i] = await repo.readCommit(lo + i);
      } catch (e) {
        block[i] = e as Error;
      }
    });
    for (let i = 0; i < block.length; i++) {
      const seq = lo + i;
      const key = seqKey('log', seq);
      const c = block[i];
      if (!c || c instanceof Error) {
        if (c) problem(`Commit ${seq} cannot be read: ${errorText(c)}`, key);
        else if (listed.has(seq)) problem(`Commit ${seq} is listed but cannot be read`, key);
        intact = false;
        prev = undefined;
      } else {
        report.commits++;
        if (c.prev !== undefined && prev !== undefined && c.prev !== prev) {
          problem(`Commit ${seq} does not follow commit ${seq - 1}: the log was tampered with or forked`, key);
        }
        if (o.seen?.seq === seq && o.seen.head !== undefined && o.seen.head !== c.hash) {
          problem(`Commit ${seq} is not the one this device saw: the log was tampered with or forked`, key);
        }
        const changed: string[] = [];
        for (const ch of c.changes) {
          const was = table.get(ch.path);
          if (c.moved && intact && !(ch.entry && was && sameContent(was, ch.entry))) changed.push(ch.path);
          if (ch.entry) table.set(ch.path, ch.entry);
          else table.delete(ch.path);
          if (c.moved) movedBy.set(ch.path, seq);
          else movedBy.delete(ch.path);
        }
        if (changed.length) problem(`Commit ${seq} is marked as only moving data but changes what files contain`, key, changed);
        prev = c.hash;
      }
      if (seq === snapSeq && snap) {
        if (c && !(c instanceof Error) && snap.head !== undefined && snap.head !== c.hash) {
          problem(`Snapshot ${seq} was taken at a different commit ${seq} than the log holds: tampered with or forked`, snapKey);
        }
        if (intact) {
          const differ = differences(table, snap.files);
          if (differ.length) problem(`Snapshot ${seq} does not match the file table the log builds at commit ${seq}: inconsistent`, snapKey, differ);
          report.snapshot = seq;
        } else {
          table = new Map(snap.files);
          prev ??= snap.head;
        }
      }
      o.onProgress?.({ phase: 'log', done: seq, total: last });
    }
  }
  return snap && snapSeq > last ? { files: snap.files, movedBy: new Map() } : { files: table, movedBy };
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.size !== b.size || a.mtime !== b.mtime || a.chunks.length !== b.chunks.length) return false;
  return a.chunks.every((c, i) => {
    const d = b.chunks[i];
    return c.id === d.id && c.pack === d.pack && c.off === d.off && c.len === d.len && c.size === d.size;
  });
}

function differences(a: Map<string, Entry>, b: Map<string, Entry>): string[] {
  const out: string[] = [];
  for (const [path, e] of a) {
    const other = b.get(path);
    if (!other || !sameEntry(e, other)) out.push(path);
  }
  for (const path of b.keys()) if (!a.has(path)) out.push(path);
  return out;
}

/** Every pack the files use is listed and long enough. Returns the packs found wanting. */
function checkPacks(
  files: Map<string, Entry>, movedBy: Map<string, number>, listing: { id: string; size: number }[], report: VerifyReport, problem: Problem,
): Set<string> {
  const size = new Map(listing.map((p) => [p.id, p.size]));
  const need = new Map<string, { end: number; paths: string[] }>();
  for (const [path, e] of files) {
    for (const c of e.chunks) {
      let n = need.get(c.pack);
      if (!n) need.set(c.pack, (n = { end: 0, paths: [] }));
      n.end = Math.max(n.end, c.off + c.len);
      n.paths.push(path);
    }
  }
  report.packs = need.size;
  const bad = new Set<string>();
  for (const [pack, n] of need) {
    const have = size.get(pack);
    const seqs = [...new Set(n.paths.map((p) => movedBy.get(p)).filter((s) => s !== undefined))].sort((a, b) => a - b);
    const move = seqs.length ? `, though ${seqs.length > 1 ? 'commits' : 'commit'} ${seqs.join(', ')} moved data there` : '';
    if (have === undefined) problem(`Pack ${pack} is missing${move}`, `pack/${pack}`, n.paths);
    else if (have < n.end) problem(`Pack ${pack} is ${have} bytes, shorter than the ${n.end} its chunks need${move}: corrupted`, `pack/${pack}`, n.paths);
    else continue;
    bad.add(pack);
  }
  return bad;
}

/** Downloads, decrypts and hashes each stored chunk the files use, once, a few ranges at a time. */
async function checkChunks(
  repo: Repo, o: Context, files: Map<string, Entry>, skip: Set<string>, report: VerifyReport, problem: Problem, onDamaged?: (ref: ChunkRef) => void,
): Promise<void> {
  const byPack = new Map<string, Map<number, { ref: ChunkRef; paths: string[] }>>();
  for (const [path, e] of files) {
    for (const ref of e.chunks) {
      if (skip.has(ref.pack)) continue;
      let stored = byPack.get(ref.pack);
      if (!stored) byPack.set(ref.pack, (stored = new Map<number, { ref: ChunkRef; paths: string[] }>()));
      let u = stored.get(ref.off);
      if (!u) stored.set(ref.off, (u = { ref, paths: [] }));
      u.paths.push(path);
    }
  }
  const units = [...byPack.values()].flatMap((stored) => [...stored.values()]);
  const pathsOf = new Map(units.map((u) => [u.ref, u.paths]));
  const total = units.length;

  let done = 0;
  await pool(packRanges(units.map((u) => u.ref), o.rangeGapBytes, MAX_RANGE), Math.min(o.concurrency, PARALLEL), async (r) => {
    const data = await repo.getPackRange(r.pack, r.start, r.end);
    if (!data || data.length < r.end - r.start) {
      problem(`Pack ${r.pack} is missing or shorter than its chunks need`, `pack/${r.pack}`, r.refs.flatMap((ref) => pathsOf.get(ref)!));
      for (const ref of r.refs) onDamaged?.(ref);
      done += r.refs.length;
      o.onProgress?.({ phase: 'chunks', done, total });
      return;
    }
    report.bytes += data.length;
    for (const ref of r.refs) {
      const paths = pathsOf.get(ref)!;
      const at = ref.off - r.start;
      const where = `Chunk ${ref.id} in pack ${ref.pack}`;
      const fail = (what: string) => {
        problem(`${where} ${what}`, `pack/${ref.pack}`, paths);
        onDamaged?.(ref);
      };
      try {
        const plain = await repo.openChunk(ref.id, data.subarray(at, at + ref.len));
        if (plain.length !== ref.size) fail('has the wrong size: corrupted');
        else if ((await repo.chunkId(plain)) !== ref.id) fail('does not match its id: corrupted');
      } catch (e) {
        fail(`cannot be read: ${errorText(e)}`);
      }
      report.chunks++;
      o.onProgress?.({ phase: 'chunks', done: ++done, total });
    }
  });
}
