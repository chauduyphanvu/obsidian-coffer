import type { ChunkRef, Entry } from './types.ts';

// The compact form of a file entry, used both by the remote format and by the local state file.

type WireEntry = (string | number)[];

class PackTable {
  list: string[] = [];
  private index = new Map<string, number>();
  idx(pack: string): number {
    let i = this.index.get(pack);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(pack);
      this.index.set(pack, i);
    }
    return i;
  }
}

function encEntry(e: Entry, pt: PackTable): WireEntry {
  const w: WireEntry = [e.size, e.mtime];
  for (const c of e.chunks) w.push(c.id, pt.idx(c.pack), c.off, c.len, c.size);
  return w;
}

function decEntry(w: WireEntry, packs: string[], from = 0): Entry {
  const chunks: ChunkRef[] = [];
  for (let i = from + 2; i < w.length; i += 5) {
    chunks.push({ id: w[i] as string, pack: packs[w[i + 1] as number], off: w[i + 2] as number, len: w[i + 3] as number, size: w[i + 4] as number });
  }
  return { size: w[from] as number, mtime: w[from + 1] as number, chunks };
}

export { PackTable, encEntry, decEntry, type WireEntry };
