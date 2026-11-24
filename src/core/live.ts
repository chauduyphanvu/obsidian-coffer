// The live link: a direct connection between two of the user's devices, over which one tells the other at once that
// it has synced, so the other need not wait for its next look at storage. No Obsidian import and no WebRTC here: the
// connection itself is a `Wire` the host makes, so this runs under plain Node tests.
import { utf8 } from './bytes.ts';
import type { Repo } from './repo.ts';

/*
 * How two devices find each other with no server of their own: through the vault's storage.
 *
 * A device learns that another is awake when a sync brings in a change that device made. It then leaves it an offer:
 * a document `live/<to>/<from>-o`, sealed with the vault's key like every document, holding what the other needs to
 * connect (addresses on the local network, and a fingerprint of the connection's key). A device that has just sent a
 * change looks under `live/<itself>/` a few times over the next two minutes, answers an offer it finds with a
 * document of its own (`-a`), and the two connect. Both documents are deleted once they have been read.
 *
 * Trust: only a device that holds the vault's key can write a document the other opens, and the connection accepts
 * only the key whose fingerprint that document named. What goes over it is "I have synced up to commit N": the files
 * themselves still travel through storage, encrypted as ever.
 *
 * Cost: nothing while a device is idle. A change sent costs up to eight listings of an empty prefix over two minutes,
 * never closer than four seconds apart however many changes are sent (one listing while a link is open); a link costs each side one write, a few listings and reads, and two deletes.
 * An older version neither lists nor deletes `live/`.
 */

export const LIVE_PREFIX = 'live/';
/**
 * An offer or answer older than this is not acted on. Generous, since it is the writer's clock against the reader's:
 * two devices whose clocks are further apart than this can not link. An offer is also acted on once only (`seen`).
 */
export const SIGNAL_TTL = 10 * 60_000;
/** After a connection that never opened, how long before this device offers that one a link again; doubled each time, up to `RETRY_MAX`. */
const RETRY_FIRST = 30_000;
const RETRY_MAX = 30 * 60_000;
/** How many offer ids are remembered, so that one read or put back a second time is not acted on again. */
const SEEN_MAX = 200;
/** When a device that sent a change looks for offers, after it. */
const LISTEN_AT = [6_000, 12_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000];
/** The same while a link is open: another device may still want one. */
const LISTEN_LINKED_AT = [40_000];
/** When a device that left an offer looks for the answer. After the last, the offer is withdrawn. */
const ANSWER_AT = [3_000, 6_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000];
/** How long an answered connection may take to open. */
const OPEN_WITHIN = 30_000;
/** Looks closer together than this are one look. */
const LOOK_GAP = 4_000;
export const MAX_LINKS = 4;
const MAX_SDP = 20_000;

export interface Signal {
  v: 1;
  kind: 'offer' | 'answer';
  from: string;
  to: string;
  /** The offer's own id; an answer names the offer it answers. */
  id: string;
  time: number;
  sdp: string;
}

export function parseSignal(value: unknown): Signal | undefined {
  const s = value as Partial<Signal> | null;
  if (!s || typeof s !== 'object' || s.v !== 1 || (s.kind !== 'offer' && s.kind !== 'answer')) return undefined;
  if (typeof s.from !== 'string' || !s.from || typeof s.to !== 'string' || !s.to || typeof s.id !== 'string' || !/^[0-9a-z]{8,32}$/.test(s.id)) return undefined;
  if (typeof s.time !== 'number' || typeof s.sdp !== 'string' || !s.sdp || s.sdp.length > MAX_SDP) return undefined;
  return { v: 1, kind: s.kind, from: s.from, to: s.to, id: s.id, time: s.time, sdp: s.sdp };
}

/** One direct connection, being set up or open. The host makes it; in the plugin it is a WebRTC data channel. */
export interface Wire {
  /** What the other device needs to connect to this one, complete: nothing is added to it later. */
  offer(): Promise<string>;
  /** Takes the other device's offer and gives what it needs back. */
  answer(offer: string): Promise<string>;
  /** The device that offered takes the answer. */
  accept(answer: string): Promise<void>;
  send(text: string): void;
  close(): void;
  onopen?: () => void;
  onmessage?: (text: string) => void;
  /** The connection ended or never opened. Not called after `close`. */
  onclose?: () => void;
}

/** The vault's documents the link uses, with device names turned into the ids its keys carry. */
export interface LiveDocs {
  id(name: string): Promise<string>;
  list(prefix: string): Promise<{ key: string; modified: number }[]>;
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** `LiveDocs` over a vault's `Repo`. Ids are keyed with the vault's key, as device records are, so storage cannot test a guessed name. */
export function liveDocs(repo: Pick<Repo, 'readDoc' | 'writeDoc' | 'listDocs' | 'deleteDoc' | 'chunkId'>): LiveDocs {
  return {
    id: (name) => repo.chunkId(utf8.encode(`live:${name}`)),
    list: (prefix) => repo.listDocs(prefix),
    read: (key) => repo.readDoc(key),
    write: (key, value) => repo.writeDoc(key, value),
    delete: (key) => repo.deleteDoc(key),
  };
}

export interface LiveOptions {
  /** This device's name, as its commits carry it. */
  me: string;
  /** The vault's documents now: asked for at each use, since the host may reopen storage. */
  docs: () => Promise<LiveDocs>;
  wire: () => Wire;
  now: () => number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  later: (ms: number, fn: () => void) => () => void;
  /** The newest commit this device's files are at: one it has only read does not count. */
  position: () => number;
  /** A linked device says it has synced up to `seq`, which is past this device's position. */
  onBehind: (peer: string, seq: number) => void;
  /** The set of open links changed. Not called for the links `close` ends. */
  onChange?: () => void;
}

interface Link {
  wire: Wire;
  state: 'offered' | 'answered' | 'open';
  /** The offer's id: ours while `offered`, the other device's once `answered`. */
  id: string;
  /** Cancels what gives up on a connection that does not open. */
  giveUp?: () => void;
  /** The storage this device's offer or answer was written to, to remove it from there even after the host has moved to other storage. */
  docs?: LiveDocs;
}

const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => (b % 36).toString(36)).join('');

/** The links of one device to the vault's other devices, and the looks at storage that set them up. */
export class LiveLinks {
  private o: LiveOptions;
  private links = new Map<string, Link>();
  /** When to look under this device's prefix, soonest first. */
  private due: number[] = [];
  private cancel?: () => void;
  private looking = false;
  private closed = false;
  /** Ids of the offers acted on. */
  private seen = new Set<string>();
  /** Documents whose read failed once: a second failure removes them, since a request that fails passes and a document that does not open never will. */
  private unread = new Set<string>();
  /** Devices a connection to did not open: how often in a row, and when to offer again. */
  private failed = new Map<string, { n: number; until: number }>();

  constructor(o: LiveOptions) {
    this.o = o;
  }

  /** The devices a link is open to. */
  peers(): string[] {
    return [...this.links].filter(([, l]) => l.state === 'open').map(([name]) => name).sort();
  }

  /** A sync brought in changes these devices made: each is awake, so each not linked yet is left an offer. Best effort. */
  async saw(devices: Iterable<string>): Promise<void> {
    for (const peer of new Set(devices)) {
      if (this.closed || !peer || peer === this.o.me || this.links.has(peer) || this.links.size >= MAX_LINKS) continue;
      // Two devices that can not reach each other, as on different networks, would otherwise try at every change.
      if ((this.failed.get(peer)?.until ?? 0) > this.o.now()) continue;
      await this.offer(peer).catch(() => this.drop(peer));
    }
  }

  /** This device sent a change, as commit `seq`: linked devices are told, and offers are looked for over the next two minutes. */
  committed(seq: number): void {
    if (this.closed) return;
    this.tell(seq);
    this.plan(this.peers().length ? LISTEN_LINKED_AT : LISTEN_AT);
  }

  /** Ends every link and every look, and removes an offer this device left unanswered from the storage it was written to. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancel?.();
    this.due = [];
    const offered = [...this.links].filter(([, l]) => l.state === 'offered');
    for (const peer of [...this.links.keys()]) this.drop(peer);
    for (const [peer, l] of offered) await this.forget(peer, 'offer', l.docs).catch(() => undefined);
  }

  private tell(seq: number): void {
    for (const [peer, l] of this.links) {
      if (l.state !== 'open') continue;
      try {
        l.wire.send(JSON.stringify({ t: 'at', seq }));
      } catch {
        this.drop(peer);
      }
    }
  }

  /** An offer and its answer have keys of their own, so removing one that was read never removes the other. */
  private async key(docs: LiveDocs, to: string, from: string, kind: Signal['kind']): Promise<string> {
    return `${LIVE_PREFIX}${await docs.id(to)}/${await docs.id(from)}-${kind === 'offer' ? 'o' : 'a'}`;
  }

  /** Removes what this device left for `to`, from `docs` when it was written there. */
  private async forget(to: string, kind: Signal['kind'], docs?: LiveDocs): Promise<void> {
    const at = docs ?? (await this.o.docs());
    await at.delete(await this.key(at, to, this.o.me, kind));
  }

  private plan(delays: number[]): void {
    const now = this.o.now();
    for (const d of delays) if (!this.due.some((t) => Math.abs(t - (now + d)) < LOOK_GAP)) this.due.push(now + d);
    this.due.sort((a, b) => a - b);
    this.arm();
  }

  private arm(): void {
    this.cancel?.();
    this.cancel = undefined;
    if (this.closed || !this.due.length) return;
    this.cancel = this.o.later(Math.max(0, this.due[0] - this.o.now()), () => {
      this.cancel = undefined;
      const now = this.o.now();
      this.due = this.due.filter((t) => t > now + LOOK_GAP / 2);
      void this.look().finally(() => this.arm());
    });
  }

  private wireFor(peer: string, state: Link['state'], id: string): Link {
    const wire = this.o.wire();
    const link: Link = { wire, state, id };
    this.links.set(peer, link);
    wire.onopen = () => {
      if (this.links.get(peer) !== link) return;
      link.giveUp?.();
      link.state = 'open';
      this.failed.delete(peer);
      try {
        wire.send(JSON.stringify({ t: 'at', seq: this.o.position() }));
      } catch {
        this.drop(peer);
        return;
      }
      this.o.onChange?.();
    };
    wire.onmessage = (text) => {
      if (this.links.get(peer) !== link) return;
      let m: { t?: unknown; seq?: unknown } | null = null;
      try {
        m = JSON.parse(text) as { t?: unknown; seq?: unknown } | null;
      } catch {
        return;
      }
      if (m && m.t === 'at' && typeof m.seq === 'number' && m.seq > this.o.position()) this.o.onBehind(peer, m.seq);
    };
    wire.onclose = () => {
      if (this.links.get(peer) === link) this.drop(peer);
    };
    return link;
  }

  private drop(peer: string): void {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    link.giveUp?.();
    link.wire.onopen = link.wire.onmessage = link.wire.onclose = undefined;
    try {
      link.wire.close();
    } catch {
      // already gone
    }
    if (this.closed) return;
    if (link.state === 'open') this.o.onChange?.();
    else if (link.docs) {
      // Its offer or answer went out and no connection opened.
      const n = (this.failed.get(peer)?.n ?? 0) + 1;
      this.failed.set(peer, { n, until: this.o.now() + Math.min(RETRY_MAX, RETRY_FIRST * 2 ** (n - 1)) });
    }
  }

  private async offer(peer: string): Promise<void> {
    const id = randomId();
    const link = this.wireFor(peer, 'offered', id);
    const sdp = await link.wire.offer();
    if (this.links.get(peer) !== link) return;
    const signal: Signal = { v: 1, kind: 'offer', from: this.o.me, to: peer, id, time: this.o.now(), sdp };
    const docs = await this.o.docs();
    await docs.write(await this.key(docs, peer, this.o.me, 'offer'), signal);
    link.docs = docs;
    if (this.links.get(peer) !== link) return;
    link.giveUp = this.o.later(ANSWER_AT.at(-1)! + LOOK_GAP, () => {
      if (this.links.get(peer) !== link || link.state === 'open') return;
      this.drop(peer);
      void this.forget(peer, 'offer', docs).catch(() => undefined);
    });
    this.plan(ANSWER_AT);
  }

  /** Reads what other devices left for this one: offers are answered, answers taken. One listing when there is nothing. */
  private async look(): Promise<void> {
    if (this.looking || this.closed) return;
    this.looking = true;
    try {
      const docs = await this.o.docs();
      const mine = `${LIVE_PREFIX}${await docs.id(this.o.me)}/`;
      for (const { key } of await docs.list(mine)) {
        if (this.closed) return;
        let s: Signal | undefined;
        try {
          s = parseSignal(await docs.read(key));
          this.unread.delete(key);
        } catch {
          // A request that failed, or a document not sealed with this vault's key: the first is read at the next look.
          if (!this.unread.has(key)) {
            this.unread.add(key);
            continue;
          }
          this.unread.delete(key);
        }
        const fresh = s && s.to === this.o.me && s.from !== this.o.me && Math.abs(this.o.now() - s.time) <= SIGNAL_TTL && key === (await this.key(docs, this.o.me, s.from, s.kind));
        // Read once: an offer or answer is of no use a second time.
        await docs.delete(key).catch(() => undefined);
        if (!s || !fresh) continue;
        if (s.kind === 'offer') {
          // One whose removal failed, or that someone put back, is not answered again: that would end the link it made.
          if (this.seen.has(s.id)) continue;
          this.seen.add(s.id);
          if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
        }
        await (s.kind === 'offer' ? this.answer(s) : this.accept(s)).catch(() => this.drop(s.from));
      }
    } catch {
      // Storage is out of reach: the next look tries again.
    } finally {
      this.looking = false;
    }
  }

  private async answer(s: Signal): Promise<void> {
    const peer = s.from;
    const had = this.links.get(peer);
    if (had?.state === 'offered') {
      // Both offered at once: the offer of the device whose name sorts first stands, and the other device answers it.
      if (this.o.me < peer) return;
      void this.forget(peer, 'offer', had.docs).catch(() => undefined);
    }
    // A device that offers has no link to this one any more, whatever this one still holds.
    if (had) this.drop(peer);
    else if (this.links.size >= MAX_LINKS) return;
    const link = this.wireFor(peer, 'answered', s.id);
    const sdp = await link.wire.answer(s.sdp);
    if (this.links.get(peer) !== link) return;
    const signal: Signal = { v: 1, kind: 'answer', from: this.o.me, to: peer, id: s.id, time: this.o.now(), sdp };
    const docs = await this.o.docs();
    await docs.write(await this.key(docs, peer, this.o.me, 'answer'), signal);
    link.docs = docs;
    if (this.links.get(peer) !== link) return;
    link.giveUp = this.o.later(OPEN_WITHIN, () => {
      if (this.links.get(peer) !== link || link.state === 'open') return;
      this.drop(peer);
      // The other device never took the answer.
      void this.forget(peer, 'answer', docs).catch(() => undefined);
    });
  }

  private async accept(s: Signal): Promise<void> {
    const link = this.links.get(s.from);
    if (!link || link.state !== 'offered' || link.id !== s.id) return;
    link.state = 'answered';
    link.giveUp?.();
    link.giveUp = this.o.later(OPEN_WITHIN, () => {
      if (this.links.get(s.from) === link && link.state !== 'open') this.drop(s.from);
    });
    await link.wire.accept(s.sdp);
  }
}
