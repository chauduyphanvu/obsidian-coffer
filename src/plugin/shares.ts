// Shared folders: which engine a path belongs to, how each engine is built, and syncing them one after another.
// No Obsidian import, so it runs under plain Node tests.
import { SyncEngine, type EngineOptions, type SyncResult } from '../core/engine.ts';
import { vaultKey } from '../core/paths.ts';
import { MissingFolderError, ScopedFS, isInside, type FolderFS } from '../core/scopedfs.ts';
import type { RemoteStore, StateStore } from '../core/types.ts';
import type { RemoteSpec } from '../stores/open.ts';
import { isConfigured, remoteSpec, shareConfig, statePath, storageLocation, storageProblem, syncConfig, type SecretLookup, type Settings, type Share } from './settings.ts';

/** Where a vault path syncs: inside a shared folder, by its path there, or with the vault, by the same path. */
export interface Place {
  share?: Share;
  path: string;
}

/** The innermost shared folder holding `path` (a shared folder's own path gives '' inside it), or the vault. */
export function placeOf(shares: Share[], path: string): Place {
  let best: Share | undefined;
  for (const s of shares) {
    if (vaultKey(path) !== vaultKey(s.folder) && !isInside(s.folder, path)) continue;
    if (!best || s.folder.length > best.folder.length) best = s;
  }
  return best ? { share: best, path: path.length > best.folder.length ? path.slice(best.folder.length + 1) : '' } : { path };
}

/** The vault path of `path` inside `share`, or `path` itself for the vault. */
export const vaultPath = (share: Share | undefined, path: string) => (share ? (path ? `${share.folder}/${path}` : share.folder) : path);

/** Points every share at or under `from` at its place under `to`, after a folder was renamed or moved. Returns those that moved. */
export function followRename(shares: Share[], from: string, to: string): Share[] {
  const moved: Share[] = [];
  for (const s of shares) {
    if (s.folder !== from && !s.folder.startsWith(`${from}/`)) continue;
    s.folder = to + s.folder.slice(from.length);
    moved.push(s);
  }
  return moved;
}

/** The shares whose folder went with a deleted folder at `path`. */
export const goneWith = (shares: Share[], path: string) => shares.filter((s) => s.folder === path || s.folder.startsWith(`${path}/`));

/**
 * Why the vault, or `share`, must not sync now: its storage location is also another one's, as after the vault's
 * storage was changed in settings. Two engines on one location would each take the other's files for their own.
 */
export function locationClash(s: Settings, share?: Share): string {
  if (share) return storageProblem(s, share, share.id);
  const other = s.shares.find((x) => storageLocation(x) === storageLocation(s));
  return other ? `This vault and the shared folder “${other.folder}” are set to the same storage location. Change the vault's storage, or stop sharing that folder.` : '';
}

/** A share syncs when this device has its keys and its folder has not gone missing. */
export const syncable = (s: Share, secret: SecretLookup) => !s.missing && isConfigured(s, secret);

/**
 * After a share's sync failed. A missing folder pauses the share until the user chooses: if it came back empty, or
 * an empty one were made with its name, the next sync would take every file in it for deleted.
 */
export function pauseIfMissing(share: Share, e: unknown): void {
  if (e instanceof MissingFolderError) share.missing = true;
}

/** What an engine is built from: the plugin's settings and the vault's files, storage and saved state. */
export interface EngineHost {
  settings: Settings;
  configDir: string;
  pluginDir: string;
  files: FolderFS;
  secret: SecretLookup;
  openStore(spec: RemoteSpec): RemoteStore;
  stateStore(path: string): StateStore;
}

/**
 * The engine for the vault (no `share`) or for one shared folder, and the files it sees: the vault without its
 * shared folders, or one shared folder as if it were a vault. The folder is read through the share, so it follows a rename.
 */
export function makeEngine(h: EngineHost, share: Share | undefined, extra: Pick<EngineOptions, 'onProgress' | 'now'> = {}): { engine: SyncEngine; fs: ScopedFS } {
  const s = h.settings;
  // A folder of '' would be the whole vault.
  if (share && !share.folder) throw new Error('A shared folder has to be a folder inside the vault');
  const fs = new ScopedFS(h.files, () => share?.folder ?? '', () => h.settings.shares.map((x) => x.folder));
  const storage = share ?? s;
  const engine = new SyncEngine({
    fs,
    store: h.openStore(remoteSpec(storage, h.secret)),
    stateStore: h.stateStore(statePath(h.pluginDir, share?.id)),
    passphrase: h.secret(storage.passphraseSecret),
    config: share ? shareConfig(s, share, h.configDir) : syncConfig(s, h.configDir, h.pluginDir),
    ...extra,
  });
  return { engine, fs };
}

export type Outcome<T, R> = { target: T; result: R; error?: undefined } | { target: T; result?: undefined; error: unknown };

/** Runs `run` for each target in order. One failing does not stop the ones after it. */
export async function syncEach<T, R>(targets: T[], run: (target: T) => Promise<R>): Promise<Outcome<T, R>[]> {
  const out: Outcome<T, R>[] = [];
  for (const target of targets) {
    try {
      out.push({ target, result: await run(target) });
    } catch (error) {
      out.push({ target, error });
    }
  }
  return out;
}

/** The vault, then every shared folder that can sync here. */
export const targetsOf = (s: Settings, secret: SecretLookup): (Share | undefined)[] => [undefined, ...s.shares.filter((x) => syncable(x, secret))];

/**
 * One sync run: `run` for the vault and then for each shared folder that can sync, one failing not stopping the rest.
 * Nothing runs on a storage location that two of them are set to, and a shared folder whose folder is missing pauses.
 */
export async function syncAll<R>(s: Settings, secret: SecretLookup, run: (share?: Share) => Promise<R>): Promise<Outcome<Share | undefined, R>[]> {
  const out = await syncEach(targetsOf(s, secret), async (share) => {
    const clash = locationClash(s, share);
    if (clash) throw new Error(clash);
    return run(share);
  });
  for (const o of out) if (o.target && 'error' in o) pauseIfMissing(o.target, o.error);
  return out;
}

/** A share's sync result with the paths it names given as vault paths, for problems that open the files. */
export function inVault(share: Share, r: SyncResult): SyncResult {
  const at = (p: string) => vaultPath(share, p);
  return { ...r, errors: r.errors.map((e) => ({ ...e, path: at(e.path) })), tooLarge: r.tooLarge.map(at), conflictCopies: r.conflictCopies.map(at) };
}

/** An id for a new share: names its state file and secrets, so only a-z and 0-9. */
export function newShareId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}
