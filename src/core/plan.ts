import type { LocalState } from './state.ts';
import { sameContent, type Entry, type LocalFile } from './types.ts';

/** A file found by the local scan, under its vault key. */
export interface Local extends LocalFile {
  key: string;
}

/** What one pass will do. */
export interface Plan {
  pushes: Local[];
  pushDeletes: string[];
  pulls: string[];
  pullDeletes: string[];
  conflicts: string[];
}

/**
 * Compares every path's local and remote state with the version both sides last agreed on.
 * Where nothing needs doing it brings that agreed version up to date in `st`.
 * `tooLargeHere` holds paths whose local file is over the size limit: they are missing from
 * `local`, but must not be mistaken for local deletions. A path over the limit on either side is left alone.
 * With `keys`, compares only those paths, and `local` need only hold those of them that exist.
 * `defer` names remote files left in storage until asked for: one that this device never had (no local file and no
 * agreed version) is not pulled, and being absent here is not a deletion.
 */
export function planChanges(
  local: Map<string, Local>,
  st: LocalState,
  excluded: (path: string) => boolean,
  maxSize: number,
  tooLargeHere: Set<string> = new Set(),
  keys?: Set<string>,
  defer?: (key: string, r: Entry) => boolean,
): Plan {
  const pushes: Local[] = [];
  const pushDeletes: string[] = [];
  const pulls: string[] = [];
  const pullDeletes: string[] = [];
  const conflicts: string[] = [];

  const plan = (key: string) => {
    if (excluded(key)) return;
    const l = local.get(key);
    const s = st.synced.get(key);
    const r = st.remote.get(key);
    if (tooLargeHere.has(key) || (r && r.size > maxSize)) return;
    if (!l && !s && r && defer?.(key, r)) return;
    const base = s?.entry;
    const localTouched = l ? !s || s.lsize !== l.size || s.lmtime !== l.mtime : !!s;
    const remoteChanged = base ? !r || !sameContent(r, base) : !!r;
    if (!remoteChanged) {
      if (s && r) s.entry = r;
      if (!localTouched) return;
      if (l) pushes.push(l);
      else pushDeletes.push(key);
    } else if (!localTouched) {
      if (r) pulls.push(key);
      else pullDeletes.push(key);
    } else if (!l && !r) st.synced.delete(key);
    else if (!l) pulls.push(key); // deleted here, edited elsewhere: the edit wins
    else if (!r) pushes.push(l); // edited here, deleted elsewhere: the edit wins
    else conflicts.push(key);
  };
  if (keys) {
    for (const key of keys) plan(key);
  } else {
    for (const key of local.keys()) plan(key);
    for (const key of st.synced.keys()) if (!local.has(key)) plan(key);
    for (const key of st.remote.keys()) if (!local.has(key) && !st.synced.has(key)) plan(key);
    for (const key of tooLargeHere) if (!st.synced.has(key) && !st.remote.has(key)) plan(key);
  }
  return { pushes, pushDeletes, pulls, pullDeletes, conflicts };
}

export const nothingToDo = (p: Plan) => !p.pushes.length && !p.pushDeletes.length && !p.pulls.length && !p.pullDeletes.length && !p.conflicts.length;
