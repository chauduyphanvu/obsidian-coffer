// What the CLI keeps for a shared folder with members: its keys in a file only this user can read, joining with a link,
// and the checks on new storage keys. The CLI's other secrets come from the environment, but a member's signing key is
// made when it joins, so it has to be kept somewhere.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { FOLLOW_PREFIX, INVITE_PREFIX, decodeFollow, decodeInvite, parseMemberKeys, type MemberGrant, type MemberKeys } from '../core/members.ts';
import { joinShare, publishJoin } from '../core/membership.ts';
import { MEMBER_FORMAT, Repo } from '../core/repo.ts';
import { errorText } from '../core/text.ts';
import type { RemoteStore } from '../core/types.ts';
import { setupCodeFrom } from '../plugin/settings.ts';
import { checkStore } from '../stores/doctor.ts';

/** Where a joined device's keys are, under the vault. The state folder is never synced. */
export const KEYS_FILE = 'keys.json';
/** Where it keeps the member list it accepted, apart from its sync state, which accepting storage resets. */
export const POSITION_FILE = 'position.json';
/** Where it keeps what it has synced, for any vault. */
export const STATE_FILE = 'state.json';

/** The storage address part of a config for a shared folder: what the link says, without its keys. */
export type MemberRemote =
  | { type: 's3'; endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean }
  | { type: 'webdav'; url: string; username: string }
  | { type: 'follow'; url: string };

/** The storage keys that come with a link, and that a re-key replaces. */
export interface Credentials {
  accessKey?: string;
  secretKey?: string;
  /** Set only once a re-key changes it: until then the config's `username` stands. */
  webdavUser?: string;
  webdavPassword?: string;
}

/** The file: this device's member keys, and the storage keys it reaches the share with. */
export interface KeyFile {
  member: MemberKeys;
  storage: Credentials;
}

const CREDENTIAL_FIELDS = ['accessKey', 'secretKey', 'webdavUser', 'webdavPassword'] as const;

/** Reads the keys file, with the problem named if it is gone or damaged. */
export async function loadKeyFile(file: string): Promise<KeyFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`the keys of this shared folder are not here: ${file} is missing. Join it again with a new invite`);
    }
    throw e;
  }
  let parsed: { member?: unknown; storage?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`the keys file ${file} is not valid JSON`);
  }
  const storage: Credentials = {};
  const kept = parsed.storage && typeof parsed.storage === 'object' ? (parsed.storage as Record<string, unknown>) : {};
  for (const f of CREDENTIAL_FIELDS) if (typeof kept[f] === 'string' && kept[f]) storage[f] = kept[f];
  try {
    return { member: parseMemberKeys(parsed.member), storage };
  } catch {
    throw new Error(`the keys file ${file} is damaged. Join the shared folder again with a new invite`);
  }
}

/** Writes the keys file readable by its owner alone, whole or not at all. */
export async function saveKeyFile(file: string, keys: KeyFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

const cannotRead = () => new Error('That invite does not say where the shared folder is stored in a way this version can read');
const noKeys = () => new Error('That invite carries no keys for the storage it names');

/**
 * Where an invite's storage record says the share is, and the keys it carries: the names a setup code uses. A WebDAV
 * address may hold spaces and a password may start or end with one, as the plugin takes them.
 */
export function placeOf(storage: Record<string, unknown>): { remote: MemberRemote; creds: Credentials } {
  if (storage.storageType === 'webdav') {
    const url = text(storage.webdavUrl);
    if (!/^https?:\/\/\S/.test(url)) throw cannotRead();
    const password = typeof storage.webdavPassword === 'string' ? storage.webdavPassword : '';
    if (!password) throw noKeys();
    return { remote: { type: 'webdav', url, username: text(storage.webdavUser) }, creds: { webdavPassword: password } };
  }
  const endpoint = text(storage.endpoint);
  const bucket = text(storage.bucket);
  const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
  if (!endpoint || !bucket || !/^https?:\/\/[^/\s]+/.test(address)) throw cannotRead();
  if (!text(storage.accessKey) || !text(storage.secretKey)) throw noKeys();
  return {
    remote: {
      type: 's3',
      endpoint: address,
      region: text(storage.region) || 'auto',
      bucket,
      prefix: text(storage.prefix),
      pathStyle: typeof storage.pathStyle === 'boolean' ? storage.pathStyle : true,
    },
    creds: { accessKey: text(storage.accessKey), secretKey: text(storage.secretKey) },
  };
}

/** The keys of a re-key over the ones now kept, or undefined when it names none that this version can use. */
export function credentialsFrom(kept: Credentials, offered: Record<string, unknown>): Credentials | undefined {
  const next = { ...kept };
  let changed = false;
  for (const f of CREDENTIAL_FIELDS) {
    if (typeof offered[f] === 'string' && offered[f]) {
      next[f] = offered[f];
      changed = true;
    }
  }
  return changed ? next : undefined;
}

/**
 * Why `store` is not the storage of the share `keys` are for, or not usable with them, as a sentence: it must hold this
 * share's key file, be readable, and for a device that writes, take writes. Undefined when it will do.
 */
export async function storageProblem(store: RemoteStore, keys: MemberKeys): Promise<string | undefined> {
  try {
    const header = await Repo.header(store);
    if (!header) return 'it holds no shared folder';
    if (header.format !== MEMBER_FORMAT || header.id !== keys.repo) return 'it holds another shared folder than this one';
    const failed = (await checkStore(store, !keys.key)).checks.find((c) => !c.ok);
    return failed && `${failed.name} failed${failed.detail ? ` (${failed.detail})` : ''}`;
  } catch (e) {
    return errorText(e);
  }
}

/** A folder name a link suggests, if it is one a folder can be called on any system. */
function folderName(suggested: string): string {
  const name = suggested.split(/[\\/]/).filter(Boolean).at(-1)?.trim() ?? '';
  return name && name !== '.' && name !== '..' && !/[\u0000-\u001f:*?"<>|]/.test(name) ? name : '';
}

/** What a link says, whichever of the two kinds of link it is, bare or in the obsidian:// link the plugin copies. */
function decodeLink(link: string): { grant: Omit<MemberGrant, 'role'> & { role?: MemberGrant['role'] }; share: string; folder: string; place: { remote: MemberRemote; creds: Credentials } } {
  const text = setupCodeFrom(link);
  if (text.startsWith(FOLLOW_PREFIX)) {
    const f = decodeFollow(text);
    return { grant: f, share: f.share, folder: f.folder, place: { remote: { type: 'follow', url: f.url }, creds: {} } };
  }
  if (!text.startsWith(INVITE_PREFIX)) {
    if (/^coffer(share)?[12]\./.test(text)) {
      throw new Error(`join takes an invite to a shared folder with members (it starts with ${INVITE_PREFIX}) or a follow link (${FOLLOW_PREFIX}); a link that starts with ${text.split('.')[0]}. is for the Obsidian plugin`);
    }
    throw new Error(`That is not a link join can use: it starts with ${INVITE_PREFIX} for an invite and ${FOLLOW_PREFIX} for a follow link`);
  }
  const i = decodeInvite(text);
  return { grant: i, share: i.share, folder: i.folder, place: placeOf(i.storage) };
}

export interface Joined {
  share: string;
  /** 'write', 'read', or 'follow' for a follow link. */
  role: 'write' | 'read' | 'follow';
  config: string;
  vault: string;
  keys: string;
  /** Said when this device's join could not be recorded yet: the next sync tries again. */
  late?: string;
}

/**
 * Joins a shared folder with a member invite or a follow link: opens the invite, keeps the keys (first, so a join that
 * stops half-way loses nothing), tells the owner's device about a writing device, and writes the config file the other
 * commands read. Refuses before it touches the invite when it would overwrite the config or another share's keys.
 * `open` makes the store for what the link says.
 */
export async function joinWithLink(link: string, o: { config: string; vault?: string; stateDir: string; open: (remote: MemberRemote, creds: Credentials) => RemoteStore }): Promise<Joined> {
  const { grant, share, folder, place } = decodeLink(link);
  const name = o.vault === undefined ? folderName(folder) || folderName(share) : '';
  if (o.vault === undefined && !name) throw new Error('The link suggests no folder name this device can use; pass --vault=<folder> to say where the shared folder goes');
  const vault = resolve(o.vault ?? name);
  const config = resolve(o.config);
  const keysFile = join(vault, o.stateDir, KEYS_FILE);
  if (existsSync(config)) throw new Error(`config file ${config} exists already; pass --config=<file> to write another`);
  if (existsSync(keysFile)) throw new Error(`${vault} already holds the keys of a shared folder; pass --vault=<folder> to join into another folder`);
  // A record left by an earlier sync or join (a removed device's) belongs to the member it was made for: joined over it, the device would go on reading as removed.
  const record = join(vault, o.stateDir);
  if ([STATE_FILE, POSITION_FILE].some((f) => existsSync(join(record, f)))) {
    throw new Error(
      `${vault} holds the sync record of an earlier sync or join (${record}); to join into this folder again, delete ${record} first (the files stay, and any that differ from the shared folder's are kept as conflict copies), or pass --vault=<folder> to join into another folder`,
    );
  }

  const store = o.open(place.remote, place.creds);
  const keys = await joinShare(store, grant);
  await saveKeyFile(keysFile, { member: keys, storage: place.creds });
  const role = place.remote.type === 'follow' ? 'follow' : keys.key ? 'write' : 'read';
  const settings = {
    vault,
    remote: place.remote,
    share,
    ...(role !== 'write' && { sync: { readOnly: true } }),
  };
  try {
    await mkdir(vault, { recursive: true });
    await writeFile(config, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    await rm(keysFile, { force: true });
    throw e;
  }
  const joined: Joined = { share, role, config, vault, keys: keysFile };
  if (keys.key) {
    try {
      await publishJoin(store, keys);
    } catch (e) {
      if (/already used/.test(errorText(e))) {
        await rm(keysFile, { force: true });
        await rm(config, { force: true });
        throw e;
      }
      joined.late = errorText(e);
    }
  }
  return joined;
}
