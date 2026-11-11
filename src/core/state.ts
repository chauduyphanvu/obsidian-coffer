import { sameContent, type Entry } from './types.ts';
import { PackTable, decEntry, encEntry, type WireEntry } from './wire.ts';

export interface Synced {
  /** The version local and remote last agreed on: the base of every three-way decision. */
  entry: Entry;
  /** Local stat at that moment. A different stat later means the file was touched. */
  lsize: number;
  lmtime: number;
}

/** What this device knows: the remote file table as of `lastSeq`, and per file the last agreed version. */
export class LocalState {
  vaultId = '';
  lastSeq = 0;
  remote = new Map<string, Entry>();
  synced = new Map<string, Synced>();

  static parse(json: string | null): LocalState {
    const st = new LocalState();
    if (!json) return st;
    const w = JSON.parse(json) as { id: string; seq: number; p: string[]; f: [string, WireEntry | 0, 0 | [number, number] | [number, number, WireEntry]][] };
    st.vaultId = w.id;
    st.lastSeq = w.seq;
    for (const [path, r, s] of w.f) {
      const remote = r ? decEntry(r, w.p) : undefined;
      if (remote) st.remote.set(path, remote);
      if (s) st.synced.set(path, { entry: s[2] ? decEntry(s[2], w.p) : remote!, lsize: s[0], lmtime: s[1] });
    }
    return st;
  }

  serialize(): string {
    const pt = new PackTable();
    const f: unknown[] = [];
    for (const [path, r] of this.remote) {
      const s = this.synced.get(path);
      f.push([path, encEntry(r, pt), !s ? 0 : s.entry === r || sameContent(s.entry, r) && s.entry.mtime === r.mtime ? [s.lsize, s.lmtime] : [s.lsize, s.lmtime, encEntry(s.entry, pt)]]);
    }
    for (const [path, s] of this.synced) {
      if (!this.remote.has(path)) f.push([path, 0, [s.lsize, s.lmtime, encEntry(s.entry, pt)]]);
    }
    return JSON.stringify({ id: this.vaultId, seq: this.lastSeq, p: pt.list, f });
  }
}
