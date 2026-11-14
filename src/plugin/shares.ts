// Shared folders: which engine a path belongs to, how each engine is built, and syncing them in one run.
// No Obsidian import, so it runs under plain Node tests.
import { pool } from '../core/bytes.ts';
import { compileExcludes } from '../core/config.ts';
import { SyncEngine, type EngineOptions, type SyncResult } from '../core/engine.ts';
import { vaultKey } from '../core/paths.ts';
import { plural } from '../core/text.ts';
import { MissingFolderError, ScopedFS, below, isAtOrInside, isInside, type FolderFS } from '../core/scopedfs.ts';
import { parseMemberKeys, type MemberKeys } from '../core/members.ts';
import { LocalState } from '../core/state.ts';
import type { LocalFS, RemoteStore, StateStore } from '../core/types.ts';
import type { RemoteSpec } from '../stores/open.ts';
import { PropertyFS, allowed, type Catalog } from './byproperty.ts';
import {
  encodeSetupCode, folderShares, isConfigured, labelOf, positionPath, propertyConfig, remoteSpec, shareConfig, statePath, storageLocation, storageProblem, syncConfig,
  type SecretLookup, type Settings, type Share,
} from './settings.ts';

/** Where a vault path syncs: inside a shared folder, by its path there, or with the vault, by the same path. */
export interface Place {
  share?: Share;
  path: string;
}

// A vault path and a share's folder may come in different Unicode forms (macOS and iOS hand out either): they are
// compared in NFC and cut by folder levels (`isAtOrInside`, `below`), so the part inside keeps its own, on-disk form.

const depth = (folder: string) => folder.split('/').length;

/**
 * The innermost shared folder holding `path` (a shared folder's own path gives '' inside it), or the vault. Notes shared
 * by a property are the vault's: they stay in its sync, and their share only sends them.
 */
export function placeOf(shares: Share[], path: string): Place {
  let best: Share | undefined;
  for (const s of shares) {
    if (s.property || !isAtOrInside(s.folder, path)) continue;
    if (!best || depth(s.folder) > depth(best.folder)) best = s;
  }
  return best ? { share: best, path: below(best.folder, path) } : { path };
}

/** The vault path of `path` inside `share`, or `path` itself for the vault and for notes shared by a property, which keep their vault paths. */
export const vaultPath = (share: Share | undefined, path: string) => (share && !share.property ? (path ? `${share.folder}/${path}` : share.folder) : path);

/** The ids of the shares by property a change at vault path `path` may be in: a note or attachment outside every shared folder. */
export const propertyPlaces = (shares: Share[], path: string): string[] =>
  allowed(path.normalize('NFC')) && !placeOf(shares, path).share ? shares.filter((s) => s.property).map((s) => s.id) : [];

/** Points every share at or under `from` at its place under `to`, after a folder was renamed or moved. Returns those that moved. */
export function followRename(shares: Share[], from: string, to: string): Share[] {
  const moved: Share[] = [];
  for (const s of folderShares(shares)) {
    if (!isAtOrInside(from, s.folder)) continue;
    const rest = below(from, s.folder);
    s.folder = rest ? `${to}/${rest}` : to;
    moved.push(s);
  }
  return moved;
}

/** The shares whose folder went with a deleted folder at `path`. */
export const goneWith = (shares: Share[], path: string) => folderShares(shares).filter((s) => isAtOrInside(path, s.folder));

/*
 * Sharing a folder that the vault already syncs takes it out of the vault on this device only. The vault's files in it
 * stay in the vault's storage, for the vault's devices that do not add the share, and this device's vault sync leaves
 * them alone: it deletes none of them and brings none back, wherever the shared folder is renamed or moved, or when it
 * goes missing and is downloaded again. Their paths are taken from the vault's sync state when sharing starts
 * (`takeVaultCopies`), and the vault leaves them out besides the folder's current name (`syncConfig`), so a stale entry
 * under the old name can neither look deleted nor be downloaded. Two things hand such paths back to the vault, both
 * on terms that delete nothing anywhere:
 * - a file of this device at one of those paths, as in an ordinary folder made later under the old name (`freeTaken`):
 *   that path is compared as if never synced, so the two versions are both kept when they differ;
 * - stopping sharing here (`rejoin`): the folder and those paths sync with the vault again, a file only one side has is
 *   copied to the other, files both have are merged as usual, and nothing is deleted on either side.
 */

type StateHost = Pick<EngineHost, 'pluginDir' | 'stateStore'>;

/** The vault's sync state as its engine saved it, and how to save it back. Only while no vault engine is open. */
async function vaultState(h: StateHost): Promise<{ st: LocalState; save: () => Promise<void> }> {
  const store = h.stateStore(statePath(h.pluginDir));
  const st = LocalState.parse(await store.load());
  return { st, save: () => store.save(st.serialize()) };
}

/** Records, as `share` starts, the vault's files in its folder: see above. */
export async function takeVaultCopies(h: StateHost, share: Share): Promise<void> {
  const { st } = await vaultState(h);
  const keys = new Set<string>();
  for (const table of [st.remote, st.synced]) for (const key of table.keys()) if (isInside(share.folder, key)) keys.add(key);
  share.vaultCopies = [...keys].sort();
}

/** Vault copies outside their share's folder now, which the vault leaves out by path. */
export const vaultCopiesOutside = (share: Share) => share.vaultCopies.filter((key) => !isInside(share.folder, key));

/**
 * Hands back to the vault each vault copy that a file of this device has taken the path of (`here`, by vault key).
 * True when one was: the vault's engine must then be made again.
 */
export async function freeTaken(h: StateHost & { settings: Settings }, here: (key: string) => boolean): Promise<boolean> {
  const taken = new Set<string>();
  for (const s of h.settings.shares) for (const key of vaultCopiesOutside(s)) if (here(key)) taken.add(key);
  if (!taken.size) return false;
  const { st, save } = await vaultState(h);
  // The file here is another one than the vault's copy, whatever this device synced there before it was shared.
  for (const key of taken) st.synced.delete(key);
  await save();
  for (const s of h.settings.shares) s.vaultCopies = s.vaultCopies.filter((key) => !taken.has(key));
  return true;
}

/**
 * Before `share` is removed: makes the vault's next sync take its folder and its vault copies back without deleting
 * anything. Where this device (`here`, by vault key) and the vault's storage (`remote`, its paths now when they could be
 * read, else as last seen) do not both have a file, what this device last synced there is forgotten, so the file is
 * copied to the side that lacks it instead of being deleted from the side that has it.
 */
export async function rejoin(h: StateHost, share: Share, here: (key: string) => boolean, remote?: Set<string>): Promise<void> {
  const { st, save } = await vaultState(h);
  const copies = new Set(share.vaultCopies);
  const there = remote ? (key: string) => remote.has(key) : (key: string) => st.remote.has(key);
  let forgot = false;
  for (const key of [...st.synced.keys()]) {
    if (!isInside(share.folder, key) && !copies.has(key)) continue;
    if (here(key) === there(key)) continue;
    st.synced.delete(key);
    forgot = true;
  }
  if (forgot) await save();
}

/** What stopping sharing does to the vault's own copies of the folder's files, for the confirmation; '' when it has none. */
export function rejoinNote(share: Share): string {
  if (!share.vaultCopies.length) return '';
  const away = vaultCopiesOutside(share).length === share.vaultCopies.length;
  return (
    `Your vault's storage still has the files that were in this folder when it was shared${away ? `, under “${commonFolder(share.vaultCopies)}”` : ''}, for your devices that did not add it. ` +
    'They sync with this device again: a file only one side has is copied to the other, both versions are kept where they differ, and nothing is deleted.'
  );
}

/** The deepest folder holding every one of `paths`. */
function commonFolder(paths: string[]): string {
  let parts = paths[0].split('/').slice(0, -1);
  for (const p of paths) {
    const q = p.split('/');
    let i = 0;
    while (i < parts.length && i < q.length - 1 && vaultKey(parts[i]) === vaultKey(q[i])) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/');
}

/**
 * Why the vault, or `share`, must not sync now: its storage location is also another one's, as after the vault's
 * storage was changed in settings. Two engines on one location would each take the other's files for their own.
 */
export function locationClash(s: Settings, share?: Share): string {
  if (share) return storageProblem(s, share, share.id);
  const other = s.shares.find((x) => storageLocation(x) === storageLocation(s));
  return other ? `This vault and the shared ${other.property ? 'notes' : 'folder'} “${labelOf(other)}” are set to the same storage location. Change the vault's storage, or stop sharing ${other.property ? 'them' : 'that folder'}.` : '';
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
  /**
   * For notes shared by a property: the vault's files as Obsidian's index has them, and what Obsidian has read of them.
   * Only the app has these, so only the app sends such a share.
   */
  notes?: { files: LocalFS; catalog: Catalog };
}

/** The files an engine of the vault or of a share sees, with the vault path of a path in them. */
export type ShareFS = LocalFS & { pathOf(path: string): string };

/**
 * The engine for the vault (no `share`) or for one shared folder, and the files it sees: the vault without its
 * shared folders, or one shared folder as if it were a vault. The folder is read through the share, so it follows a rename.
 * A shared folder with members opens with this device's keys to it, and keeps the member list it accepted in a file
 * of its own, which nothing that resets its sync state touches.
 */
export function makeEngine(h: EngineHost, share: Share | undefined, extra: Pick<EngineOptions, 'onProgress' | 'now'> = {}): { engine: SyncEngine; fs: ShareFS } {
  const s = h.settings;
  if (share?.property) return propertyEngine(h, share, extra);
  // A folder of '' would be the whole vault.
  if (share && !share.folder) throw new Error('A shared folder has to be a folder inside the vault');
  const fs = new ScopedFS(h.files, () => share?.folder ?? '', () => folderShares(h.settings.shares).map((x) => x.folder));
  const storage = share ?? s;
  const member = share?.memberKeysSecret ? { keys: memberKeysIn(share, h.secret), position: h.stateStore(positionPath(h.pluginDir, share.id)) } : undefined;
  const engine = new SyncEngine({
    fs,
    store: h.openStore(remoteSpec(storage, h.secret)),
    stateStore: h.stateStore(statePath(h.pluginDir, share?.id)),
    passphrase: member ? '' : h.secret(storage.passphraseSecret),
    config: share ? shareConfig(s, share, h.configDir) : syncConfig(s, h.configDir, h.pluginDir),
    ...(member && { member }),
    ...extra,
  });
  return { engine, fs };
}

/**
 * The engine of notes shared by a property (byproperty.ts), on the one device that sends them: it sees the vault's
 * notes and attachments in the share at their vault paths, can write and remove none of them (`PropertyFS`), sends
 * again whatever storage holds otherwise (`sendOnly`), and leaves a shared note alone while its properties no longer
 * say it is shared (`only`).
 */
function propertyEngine(h: EngineHost, share: Share, extra: Pick<EngineOptions, 'onProgress' | 'now'>): { engine: SyncEngine; fs: PropertyFS } {
  if (!h.notes) throw new Error('Notes shared by a property are sent only from Obsidian, which reads their properties.');
  const config = propertyConfig(h.settings, h.configDir, h.pluginDir);
  const fs = new PropertyFS({ inner: h.notes.files, catalog: h.notes.catalog, share: () => share, excluded: compileExcludes(config.exclude) });
  const engine = new SyncEngine({
    fs,
    store: h.openStore(remoteSpec(share, h.secret)),
    stateStore: h.stateStore(statePath(h.pluginDir, share.id)),
    passphrase: '',
    config,
    member: { keys: memberKeysIn(share, h.secret), position: h.stateStore(positionPath(h.pluginDir, share.id)) },
    only: (key) => fs.sends(key),
    sendOnly: true,
    ...extra,
  });
  return { engine, fs };
}

/** This device's keys to `share`, a shared folder with members, as kept in secret storage. */
export function memberKeysIn(share: Share, secret: SecretLookup): MemberKeys {
  const kept = secret(share.memberKeysSecret);
  if (!kept) throw new Error('This device no longer has its keys to this shared folder. Sync status says what to do.');
  return parseMemberKeys(kept);
}

/** What joining `share` again takes, once this device stops sharing it. Nobody can invite an owner: its own link brings it back. */
export function rejoinNeeds(share: Pick<Share, 'role' | 'memberKeysSecret'>): string {
  if (share.role === 'owner') return 'the link for your other devices and its passphrase';
  return share.memberKeysSecret ? 'a new invite' : 'the invite link and the passphrase';
}

/** Whether `share` is a shared folder with members, whose devices each hold keys of their own. */
export const hasMembers = (share: Share | undefined): share is Share => !!share?.memberKeysSecret;

export type Outcome<T, R> = { target: T; result: R; error?: undefined } | { target: T; result?: undefined; error: unknown };

/** How many shared folders sync, or are asked for changes, at the same time. */
export const SHARES_AT_ONCE = 3;

/**
 * Runs `run` for each target, `limit` at a time, starting them in order. One failing does not stop the others. The
 * outcomes are in the order of `targets`, whichever finishes first.
 */
export async function syncEach<T, R>(targets: T[], run: (target: T) => Promise<R>, limit = 1): Promise<Outcome<T, R>[]> {
  const out = new Array<Outcome<T, R>>(targets.length);
  await pool(targets, limit, async (target, i) => {
    try {
      out[i] = { target, result: await run(target) };
    } catch (error) {
      out[i] = { target, error };
    }
  });
  return out;
}

/** The vault, then every shared folder that can sync here. */
export const targetsOf = (s: Settings, secret: SecretLookup): (Share | undefined)[] => [undefined, ...s.shares.filter((x) => syncable(x, secret))];

/** What a run reports as it goes, so progress and status can follow each place on its own. */
export interface RunEvents {
  /** Once, before anything runs: the places this run covers, the vault (undefined) first. */
  planned?: (targets: (Share | undefined)[]) => void;
  started?: (target: Share | undefined) => void;
  /** `error` is what made it fail, when it did. */
  ended?: (target: Share | undefined, error?: unknown) => void;
}

/**
 * One sync run: `run` for the vault and then for each shared folder that can sync and `include` lets in, one failing
 * not stopping the rest. The vault goes first and alone, so its sync runs as it always did and no shared folder slows it
 * down. The shared folders follow, `SHARES_AT_ONCE` at a time. The outcomes are the vault's, then the shared folders' in
 * the order of the settings. Nothing runs on a storage location that two of them are set to, and a shared folder whose
 * folder is missing pauses as soon as its sync fails.
 */
export async function syncAll<R>(
  s: Settings,
  secret: SecretLookup,
  run: (share?: Share) => Promise<R>,
  include: (share?: Share) => boolean = () => true,
  events: RunEvents = {},
): Promise<Outcome<Share | undefined, R>[]> {
  const targets = targetsOf(s, secret).filter(include);
  events.planned?.(targets);
  const one = async (share?: Share): Promise<R> => {
    let error: unknown;
    events.started?.(share);
    try {
      const clash = locationClash(s, share);
      if (clash) throw new Error(clash);
      return await run(share);
    } catch (e) {
      error = e;
      if (share) pauseIfMissing(share, e);
      throw e;
    } finally {
      events.ended?.(share, error);
    }
  };
  const vault = await syncEach(targets.filter((t) => !t), one);
  const shares = await syncEach(targets.filter((t) => t), one, SHARES_AT_ONCE);
  return [...vault, ...shares];
}

/** A share's sync result with the paths it names given as vault paths, for problems that open the files. */
export function inVault(share: Share, r: SyncResult): SyncResult {
  const at = (p: string) => vaultPath(share, p);
  return { ...r, errors: r.errors.map((e) => ({ ...e, path: at(e.path) })), tooLarge: r.tooLarge.map(at), deferred: r.deferred.map(at), unsent: r.unsent.map(at), conflictCopies: r.conflictCopies.map(at) };
}

/**
 * The code of an invite to `share` for someone who may only read: it carries `keys`, which its owner made to read only,
 * in place of the ones `secret` finds for the share, and turns on Only receive changes for whoever opens it.
 */
export function readOnlyInviteCode(share: Share, keys: { access: string; secret: string; password: string; user: string }, secret: SecretLookup, folder: string, iterations: number): Promise<string> {
  const keyed = (name: string) =>
    !name ? '' : name === share.accessKeySecret ? keys.access : name === share.secretKeySecret ? keys.secret : name === share.webdavPasswordSecret ? keys.password : secret(name);
  return encodeSetupCode({ ...share, readOnly: true, webdavUser: keys.user || share.webdavUser }, keyed, folder, iterations);
}

/** What joining a shared folder does with the `n` files that are already in the folder it is mounted at, which is not empty. */
export function mountHint(folder: string, n: number, receivesOnly: boolean): string {
  const one = n === 1;
  const has = `“${folder}” already has ${plural(n, 'file')}.`;
  const same = 'a file with the same name is compared, and both are kept when they differ. Nothing is deleted.';
  return receivesOnly
    ? `${has} ${one ? 'It stays' : 'They stay'} on this device and ${one ? 'is' : 'are'} not sent, because this device only receives changes; ${same}`
    : `${has} ${one ? 'It is' : 'They are'} added to the shared folder, so everyone who shares it sees ${one ? 'it' : 'them'}; ${same}`;
}

/** An id for a new share: names its state file and secrets, so only a-z and 0-9. */
export function newShareId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => (b % 36).toString(36)).join('');
}
