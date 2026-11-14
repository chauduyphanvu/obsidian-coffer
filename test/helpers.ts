import { fromB64 } from '../src/core/bytes.ts';
import { resolveConfig, type SyncConfig } from '../src/core/config.ts';
import { SyncEngine } from '../src/core/engine.ts';
import { decodeInvite, encodeInvite, type MemberKeys } from '../src/core/members.ts';
import { createMemberShare, joinShare, publishJoin } from '../src/core/membership.ts';
import { Repo } from '../src/core/repo.ts';
import type { RemoteStore } from '../src/core/types.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { withRetry } from '../src/stores/retry.ts';
import { MemFS, MemState } from '../src/testing/memfs.ts';
import { carries, type Catalog } from '../src/plugin/byproperty.ts';
import { SimStore } from '../src/testing/netsim.ts';

export const TEST_CONFIG: Partial<SyncConfig> = {
  kdfIterations: 1000,
  chunk: { min: 4096, avg: 16384, max: 65536 },
  packTargetBytes: 256 << 10,
};

export class Device {
  fs = new MemFS();
  state = new MemState();
  engine!: SyncEngine;
  name: string;
  store: RemoteStore;
  config: SyncConfig;
  clock: { now: number };
  /** A device of a shared folder with members: what it keeps in secret storage, and where it keeps its member list. */
  keys?: MemberKeys;
  position = new MemState();

  constructor(name: string, store: RemoteStore, clock: { now: number }, config: Partial<SyncConfig> = {}, keys?: MemberKeys) {
    this.name = name;
    this.store = store;
    this.clock = clock;
    this.config = resolveConfig({ ...TEST_CONFIG, deviceName: name, ...config });
    this.keys = keys;
    this.restart();
  }

  /** A fresh engine over the same files and saved state, as after an app restart or crash. */
  restart(): void {
    this.engine = new SyncEngine({
      fs: this.fs,
      store: this.store,
      stateStore: this.state,
      passphrase: 'test passphrase',
      config: this.config,
      now: () => this.clock.now,
      ...(this.keys && { member: { keys: this.keys, position: this.position } }),
    });
  }

  sync(force = false) {
    return this.engine.sync({ force });
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, f] of [...this.fs.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out[path] = Buffer.from(f.data).toString('base64');
    }
    return out;
  }
}

export const DAY = 86_400_000;

/**
 * A shared folder with members in memory, started by the owner's device `mac` (member "Vu"). `join` invites a member,
 * through an encoded link, and joins one device of it; a read member's device is set to only receive, as the plugin does.
 */
export async function memberShare(config: Partial<SyncConfig> = {}, wrap?: (net: RemoteStore) => RemoteStore) {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  /** What every device and link goes through: `net`, or what `wrap` puts in front of it. */
  const store = wrap ? wrap(net) : net;
  const keys = await createMemberShare(store, { owner: 'Vu', device: 'mac', passphrase: 'owner passphrase', kdfIterations: 1000, chunk: TEST_CONFIG.chunk!, now: clock.now });
  const owner = new Device('mac', store, clock, config, keys);
  const invite = async (name: string, role: 'write' | 'read', expires = clock.now + 7 * DAY) => {
    const grant = await owner.engine.invite({ name, role, expires });
    return decodeInvite(encodeInvite({ ...grant, storage: { bucket: 'b' }, share: 'Family', folder: 'Family' }));
  };
  const join = async (name: string, role: 'write' | 'read', o: { expires?: number; config?: Partial<SyncConfig> } = {}) => {
    const joined = await joinShare(store, await invite(name, role, o.expires), clock.now);
    if (role === 'write') await publishJoin(store, joined);
    return new Device(name, store, clock, { ...config, ...(role === 'read' && { readOnly: true }), ...o.config }, joined);
  };
  /** A write member, joined and confirmed. */
  const writer = async (name: string, o: { config?: Partial<SyncConfig> } = {}) => {
    const d = await join(name, 'write', o);
    await owner.engine.confirmJoins();
    return d;
  };
  return { clock, mem, net, store, keys, owner, invite, join, writer };
}

/**
 * `inner` behind the retrying wrapper every network store has. `lose` makes the next write whose key it matches land and
 * then fail, as when its reply is lost; with `after`, the writes after it fail too, or every request does, until `online`.
 */
export function lossy(inner: RemoteStore) {
  let armed: { match: (key: string) => boolean; after?: 'writes' | 'all' } | undefined;
  let down: 'writes' | 'all' | undefined;
  const fail = () => Promise.reject(new Error('the network is down'));
  const raw: RemoteStore = {
    get: (key, range) => (down === 'all' ? fail() : inner.get(key, range)),
    list: (prefix, after) => (down === 'all' ? fail() : inner.list(prefix, after)),
    put: async (key, data, opts) => {
      if (down) return fail();
      const ok = await inner.put(key, data, opts);
      if (armed?.match(key)) {
        down = armed.after;
        armed = undefined;
        throw new Error('the reply was lost');
      }
      return ok;
    },
    delete: (key) => (down ? fail() : inner.delete(key)),
  };
  return {
    store: withRetry(raw, 5, 1),
    lose(match: (key: string) => boolean, after?: 'writes' | 'all') {
      armed = { match, after };
    },
    /** Writes fail from now on, before they reach storage. */
    writesDown() {
      down = 'writes';
    },
    online() {
      down = undefined;
    },
    get armed() {
      return !!armed;
    },
  };
}

/** The share's storage as someone who holds its master key and nothing else sees it: no member changes, no signing key. */
export function rawRepo(store: RemoteStore, keys: MemberKeys): Promise<Repo> {
  return Repo.openMember(store, { repo: keys.repo, master: fromB64(keys.master) });
}

/**
 * What Obsidian has read of a vault, for notes shared by a property, as a test sets it: which notes say share: <name>,
 * and what each embeds. `refresh` reads it all from the files now; until then it lags them, as Obsidian's cache can.
 */
export class FakeCatalog implements Catalog {
  isReady = true;
  says = new Set<string>();
  shows = new Map<string, { original: string; target: string | null }[]>();
  private fs: MemFS;
  private name: string;

  constructor(fs: MemFS, name: string) {
    this.fs = fs;
    this.name = name;
  }

  refresh(): this {
    this.says.clear();
    this.shows.clear();
    for (const [path, f] of this.fs.files) {
      if (!path.endsWith('.md')) continue;
      const text = new TextDecoder().decode(f.data);
      if (carries(text, this.name)) this.says.add(path);
      this.shows.set(path, [...text.matchAll(/!\[\[([^\]|#]+)[^\]]*\]\]/g)].map((m) => ({ original: m[0], target: this.resolve(m[1]) })));
    }
    return this;
  }

  ready() {
    return this.isReady;
  }

  tagged() {
    return [...this.says];
  }

  embeds(note: string) {
    return this.shows.get(note) ?? [];
  }

  resolve(link: string) {
    if (this.fs.files.has(link)) return link;
    return [...this.fs.files.keys()].find((p) => p.split('/').pop() === link) ?? null;
  }
}
