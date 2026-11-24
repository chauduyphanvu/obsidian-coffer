import type { MemberChange } from './members.ts';
import type { Line } from './repo.ts';
import { sameContent, type Commit, type Entry } from './types.ts';
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
  /** Digest of commit `lastSeq` ('' before the first), which the next commit must name. Unknown in a state saved before the log was chained. */
  head: string | undefined = '';
  remote = new Map<string, Entry>();
  synced = new Map<string, Synced>();
  /** Paths a commit marked `confirmed` deleted, and nothing has changed since: their deletion here is not counted by the guard. */
  confirmed = new Set<string>();
  /** A shared folder with members: every member change up to `lastSeq`, oldest first, which the commits after are checked by. */
  members: MemberChange[] = [];
  /** A shared folder with members: when each member's newest commit this device has taken was made, by member id. */
  lastBy = new Map<string, number>();
  /** The branch this device is on (`lines.ts`), which `lastSeq`, `head` and `remote` are of; undefined on the main line. */
  line?: Line;
  /**
   * Since this device changed lines, no sync has finished cleanly: 1 while none has begun to change its files either,
   * 2 once one has. At 2 the files may be partly the other line's with `synced` not saying so, as when the app was
   * closed mid-download, and a file that does not match its record is not taken to descend from that record
   * (`SyncEngine.settleFiles`). 0 otherwise.
   */
  unsettled: 0 | 1 | 2 = 0;

  static parse(json: string | null): LocalState {
    const st = new LocalState();
    if (!json) return st;
    const w = JSON.parse(json) as {
      id: string; seq: number; h?: string; p: string[]; f: [string, WireEntry | 0, 0 | [number, number] | [number, number, WireEntry]][]; c?: string[];
      m?: MemberChange[]; b?: [string, number][]; l?: Line; u?: number;
    };
    st.vaultId = w.id;
    st.lastSeq = w.seq;
    st.head = w.h ?? (w.seq ? undefined : '');
    for (const [path, r, s] of w.f) {
      const remote = r ? decEntry(r, w.p) : undefined;
      if (remote) st.remote.set(path, remote);
      if (s) st.synced.set(path, { entry: s[2] ? decEntry(s[2], w.p) : remote!, lsize: s[0], lmtime: s[1] });
    }
    st.confirmed = new Set(w.c);
    // A version before send-only keys saved one as a member with both marks, as the list in storage carries it.
    st.members = (w.m ?? []).map((c) => ({ ...c, members: c.members.map((m) => (m.follow && m.suggest ? { id: m.id, name: m.name, role: m.role, capture: true as const } : m)) }));
    st.lastBy = new Map(w.b);
    if (w.l && typeof w.l.id === 'string' && Number.isInteger(w.l.fork)) st.line = { id: w.l.id, fork: w.l.fork };
    st.unsettled = w.u === 1 || w.u === 2 ? w.u : 0;
    return st;
  }

  /** Advances the remote file table by one commit. */
  apply(c: Commit): void {
    for (const ch of c.changes) {
      if (ch.entry) this.remote.set(ch.path, ch.entry);
      else this.remote.delete(ch.path);
      if (c.confirmed && !ch.entry) this.confirmed.add(ch.path);
      else this.confirmed.delete(ch.path);
    }
    if (c.members) this.members.push({ seq: c.seq, gen: c.members.gen, members: c.members.members, ...(c.hash && { hash: c.hash }) });
    if (c.signer && !c.moved && c.time > (this.lastBy.get(c.signer) ?? 0)) this.lastBy.set(c.signer, c.time);
    this.lastSeq = c.seq;
    this.head = c.hash;
  }

  /**
   * Each path's row as last written, reused while it is made of the same entries: an entry is never
   * changed once in the tables, only replaced. Rows name packs by their place in `packs`, which only grows
   * until it is rebuilt with the rows, once it has outgrown the packs in use.
   */
  private rows = new Map<string, Row>();
  private packs = new PackTable();
  private packsInUse = 0;

  serialize(): string {
    if (this.packs.list.length > 2 * this.packsInUse + 256) {
      this.packs = new PackTable();
      this.rows = new Map();
    }
    const pt = this.packs;
    const rows = this.rows;
    const fresh = rows.size === 0;
    const out: string[] = [];
    const row = (path: string, r: Entry | undefined, s: Synced | undefined) => {
      let w = rows.get(path);
      if (!w || w.r !== r || w.s !== s?.entry || w.lsize !== s?.lsize || w.lmtime !== s?.lmtime) {
        const synced = !s ? 0 : r && (s.entry === r || (sameContent(s.entry, r) && s.entry.mtime === r.mtime)) ? [s.lsize, s.lmtime] : [s.lsize, s.lmtime, encEntry(s.entry, pt)];
        w = { r, s: s?.entry, lsize: s?.lsize, lmtime: s?.lmtime, text: JSON.stringify([path, r ? encEntry(r, pt) : 0, synced]) };
        rows.set(path, w);
      }
      out.push(w.text);
    };
    let syncedInRemote = 0;
    for (const [path, r] of this.remote) {
      const s = this.synced.get(path);
      if (s) syncedInRemote++;
      row(path, r, s);
    }
    // Agreed versions of files gone from storage: none when every one was met above.
    if (syncedInRemote < this.synced.size) for (const [path, s] of this.synced) if (!this.remote.has(path)) row(path, undefined, s);
    // Rows of paths in neither table any more: only after a deletion, so the common save leaves the cache as it is.
    if (rows.size > out.length) for (const path of rows.keys()) if (!this.remote.has(path) && !this.synced.has(path)) rows.delete(path);
    if (fresh) this.packsInUse = pt.list.length;
    const head = this.head === undefined ? '' : `,"h":${JSON.stringify(this.head)}`;
    const confirmed = this.confirmed.size ? `,"c":${JSON.stringify([...this.confirmed])}` : '';
    const members = this.members.length ? `,"m":${JSON.stringify(this.members)}` : '';
    const lastBy = this.lastBy.size ? `,"b":${JSON.stringify([...this.lastBy])}` : '';
    const line = (this.line ? `,"l":${JSON.stringify(this.line)}` : '') + (this.unsettled ? `,"u":${this.unsettled}` : '');
    return `{"id":${JSON.stringify(this.vaultId)},"seq":${this.lastSeq}${head},"p":${JSON.stringify(pt.list)},"f":[${out.join(',')}]${confirmed}${members}${lastBy}${line}}`;
  }
}

interface Row {
  r: Entry | undefined;
  s: Entry | undefined;
  lsize: number | undefined;
  lmtime: number | undefined;
  text: string;
}
