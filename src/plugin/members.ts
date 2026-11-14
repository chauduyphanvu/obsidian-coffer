// Shared folders with members, as the plugin handles them: keys and where they are kept, invites and joining, the
// member list in words, and new storage keys. No Obsidian import, so it runs under plain Node tests.
import { UnverifiedError, type MemberStanding, type MemberStatus, type SyncEngine } from '../core/engine.ts';
import { publishJoin, joinShare } from '../core/membership.ts';
import type { FollowInvite, MemberInvite, MemberKeys, Role } from '../core/members.ts';
import { keyPolicy, providerFromEndpoint, type Policy, type PolicyKind } from '../core/policy.ts';
import { DAY } from '../core/retention.ts';
import { Repo } from '../core/repo.ts';
import { errorText } from '../core/text.ts';
import { ReadOnlyError, type RemoteStore } from '../core/types.ts';
import { checkStore } from '../stores/doctor.ts';
import type { SecretLookup, Share, Storage } from './settings.ts';
import { connectError, describeFailure, isTransient } from './status.ts';

/** The secret a shared folder with members keeps this device's keys to it under, made the share's own by `shareSecretName`. */
export const MEMBER_KEYS = 'coffer-member-keys';

/** How long a new invite works, in days, as offered. */
export const INVITE_DAYS = [1, 7, 30] as const;

/** Storage keys typed in: S3's pair, or WebDAV's user and password. */
export interface KeySet {
  access: string;
  secret: string;
  user: string;
  password: string;
}

export const noKeys = (): KeySet => ({ access: '', secret: '', user: '', password: '' });

/** `keys` with the spaces copying adds taken off. A WebDAV password is taken as typed. */
export const trimKeys = (k: KeySet): KeySet => ({ access: k.access.trim(), secret: k.secret.trim(), user: k.user.trim(), password: k.password });

/** What is missing from keys typed for storage of `type`, or ''. */
export function keysProblem(type: Storage['storageType'], k: KeySet): string {
  if (type === 'webdav') return k.user.trim() && k.password ? '' : 'Enter the user name and the password.';
  return k.access.trim() && k.secret.trim() ? '' : 'Enter both keys.';
}

/** Whether two sets of keys are the same for storage of `type`. */
export function sameKeySet(type: Storage['storageType'], a: KeySet, b: KeySet): boolean {
  return type === 'webdav' ? a.user.trim() === b.user.trim() && a.password === b.password : a.access.trim() === b.access.trim();
}

/** The keys `storage` reaches its location with on this device. */
export function keysOf(storage: Storage, secret: SecretLookup): KeySet {
  return { access: secret(storage.accessKeySecret), secret: secret(storage.secretKeySecret), user: storage.webdavUser, password: secret(storage.webdavPasswordSecret) };
}

/**
 * `storage` with `keys` in place of its own, and a lookup that finds them, for trying keys before they are kept. The
 * address stays: keys reach the same place or none.
 */
export function withKeys(storage: Storage, keys: KeySet): { storage: Storage; secret: SecretLookup } {
  const values: Record<string, string> = { a: keys.access.trim(), s: keys.secret.trim(), p: keys.password };
  return {
    storage: { ...storage, accessKeySecret: 'a', secretKeySecret: 's', webdavPasswordSecret: 'p', webdavUser: keys.user.trim() || storage.webdavUser },
    secret: (n) => values[n] ?? '',
  };
}

/** The keys a re-key hands out, by the names a setup code gives them, which the command-line tool reads too. */
export function keysPayload(type: Storage['storageType'], k: KeySet): Record<string, unknown> {
  return type === 'webdav' ? { webdavUser: k.user.trim(), webdavPassword: k.password } : { accessKey: k.access.trim(), secretKey: k.secret.trim() };
}

/** The keys in a re-key for storage of `type`, over `kept` (the user name stays when a WebDAV one has none); undefined when it holds none to use. */
export function keysFromPayload(type: Storage['storageType'], p: Record<string, unknown>, kept: KeySet): KeySet | undefined {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  if (type === 'webdav') {
    const password = text(p.webdavPassword);
    return password ? { ...kept, user: text(p.webdavUser).trim() || kept.user, password } : undefined;
  }
  const access = text(p.accessKey).trim();
  const secret = text(p.secretKey).trim();
  return access && secret ? { ...kept, access, secret } : undefined;
}

/**
 * Checks keys against the storage of one shared folder before they are kept: they must reach it, read it and, for a
 * device that writes (`write`), write to it, and the shared folder stored there must be the one `repo` names (when this
 * device knows which). With `onlyRead` (see `mustNotWrite`), they must not write outside the inbox. Throws in words the
 * user can act on.
 */
export async function testKeys(store: RemoteStore, o: { repo?: string; write: boolean; onlyRead?: boolean; storageType: Storage['storageType'] }): Promise<void> {
  try {
    const report = await checkStore(store, !o.write);
    const bad = report.checks.find((x) => !x.ok);
    if (bad) throw new Error(bad.detail ?? bad.name);
  } catch (e) {
    throw new Error(connectError(errorText(e), o.storageType, o.write));
  }
  let header: Awaited<ReturnType<typeof Repo.header>>;
  try {
    header = await Repo.header(store);
  } catch (e) {
    throw new Error(connectError(errorText(e), o.storageType, o.write));
  }
  if (!header) throw new Error('With these keys, nothing is stored there. Check that they reach the same bucket and folder as the old ones.');
  if (o.repo && header.id !== o.repo) throw new Error('These keys reach another shared folder than this one. Check the bucket and folder they are for.');
  if (o.onlyRead) await refuseWriting(store);
}

/**
 * Whether keys the owner hands out to read (`suggest`: and to send suggestions) are refused when they can write outside
 * the inbox. Not for WebDAV, whose servers often can not limit a user to reading, nor for suggestions where the provider
 * can not limit writing to the inbox: the rules shown for those say a key that writes is the way (`policy.ts`).
 */
export function mustNotWrite(storage: Storage, suggest: boolean): boolean {
  if (storage.storageType === 'webdav') return false;
  return !suggest || sharePolicy(storage, 'readAndInbox').possible;
}

/** Throws when `store` lets these keys write. Tried outside inbox/, where a key that may also send suggestions writes. */
async function refuseWriting(store: RemoteStore): Promise<void> {
  const key = `doctor/${Math.random().toString(36).slice(2)}`;
  let wrote: boolean;
  try {
    wrote = await store.put(key, new Uint8Array(1), { ifNoneMatch: true });
  } catch (e) {
    if (describeFailure(e).id === 'access') return;
    throw new Error(`Could not check that these keys can only read: ${errorText(e)}`);
  }
  if (!wrote) return;
  await store.delete(key).catch(() => undefined);
  throw new Error('These keys can also change and delete what is stored, and whoever is given them could too. Make keys that can only read, with the rules shown here.');
}

/**
 * What is wrong with the keys typed for a read invite, or '': `own` are the keys this device writes with. `suggest`:
 * the invite is to read and send suggestions, whose key may also add to the inbox.
 */
export function readKeyProblem(type: Storage['storageType'], read: KeySet, own: KeySet, suggest: boolean): string {
  const missing = keysProblem(type, read);
  if (missing) return missing;
  if (!sameKeySet(type, read, own)) return '';
  return `That is the key this device writes with. Make another one that can ${suggest ? 'read and add suggestions' : 'only read'}.`;
}

/**
 * Said where new storage keys are said to cut a removed member off, when the member list holds a follow link: anyone
 * who has the master key, as everyone who joined has, reads the public copy without storage keys. '' when there is none.
 */
export function followCaveat(members: readonly Pick<MemberStatus, 'follow'>[] | undefined): string {
  return members?.some((m) => m.follow)
    ? 'This folder has a follow link, so its public address still lets someone you removed read everything, now and later. Only a new shared folder stops that.'
    : '';
}

/** Asks for a new key for the members who only read, at a re-key. One key serves them all. */
export function rekeyReadersNote(readers: readonly string[]): string {
  return `${readers.join(', ')} only ${readers.length === 1 ? 'reads' : 'read'}: make a new key that can only read this folder, too.`;
}

/** Asks for a new key for the members who read and send suggestions, at a re-key: one for them all, apart from the read-only one. */
export function rekeySuggestersNote(suggesters: readonly string[]): string {
  return `${suggesters.join(', ')} ${suggesters.length === 1 ? 'sends' : 'send'} you suggestions: make a new key that can read this folder and add suggestions to it, too.`;
}

/** What a storage location holds, for starting to share a folder there: nothing yet, a vault or folder shared with a passphrase, or a shared folder with members. */
export function storedKind(header: { format: number } | null): 'empty' | 'passphrase' | 'members' {
  if (!header) return 'empty';
  return header.format >= 2 ? 'members' : 'passphrase';
}

/**
 * Joins a shared folder with members with `invite`: opens it for its keys, has `keep` keep them (secret storage, the
 * share in settings), and only then, for an invite to write, leaves this device's key for the owner's device to
 * confirm, so a stop in between cannot leave a used invite whose key is lost. A join that cannot be left now is left
 * by the next sync. Throws when the invite does not open, or another device used it first.
 */
export async function joinWithInvite(store: RemoteStore, invite: MemberInvite, keep: (keys: MemberKeys) => Promise<void>, now = Date.now()): Promise<{ keys: MemberKeys; sent: boolean }> {
  const keys = await joinShare(store, invite, now);
  await keep(keys);
  if (invite.role !== 'write') return { keys, sent: true };
  try {
    await publishJoin(store, keys);
    return { keys, sent: true };
  } catch (e) {
    if (isUsedError(e)) throw e;
    return { keys, sent: false };
  }
}

/** What the join screen holds about the link opened last; `I` is what a sealed invite opened to. */
export interface OpenedLink<I> {
  invite?: I;
  member?: MemberInvite;
  follow?: FollowInvite;
  readOnly: boolean;
  folder: string;
  /** The folder the link suggested, to tell it from one typed since. */
  suggested: string;
}

/**
 * The join screen after `link` opened, in place of any link opened before and gone back from: only the one opened last
 * is joined, with only its own reason to receive only, in the folder it suggests unless another was typed.
 */
export function openedLink<I>(
  before: { folder: string; suggested: string },
  link: { invite: I; member?: MemberInvite; follow?: FollowInvite; readOnly: boolean; folder: string },
): OpenedLink<I> {
  const typed = !!before.folder && before.folder !== before.suggested;
  return { invite: link.invite, member: link.member, follow: link.follow, readOnly: link.readOnly, folder: typed ? before.folder : link.folder, suggested: link.folder };
}

/** Why changing who is a member, or their keys, did not work, in words for the owner. */
export function memberError(e: unknown): string {
  if (e instanceof UnverifiedError) return 'Its storage holds a change no member made, so nothing can be added after it. Remove that change first: Sync status lists it.';
  if (e instanceof ReadOnlyError) return 'This device only receives changes for this folder. Turn that off on its row first: this writes to its storage.';
  return errorText(e);
}

/** Another device used this invite first. */
export const isUsedError = (e: unknown) => /already used/i.test(errorText(e));

/**
 * A role in a few words, as a shared folder's row and the member list show it. A follow link's member, or a followed
 * folder, `follows`; a read member invited to send suggestions `suggests`.
 */
export function roleLabel(role: '' | Role | undefined, follows = false, suggests = false): string {
  if (follows) return 'Follow link';
  if (role === 'read' && suggests) return 'Can read and suggest';
  return role === 'owner' ? 'Owner' : role === 'write' ? 'Can edit' : role === 'read' ? 'Can only read' : '';
}

/** The role a shared folder's row shows for this device: none once its owner removed it, which the row's status says instead. */
export const roleOnRow = (share: Pick<Share, 'role' | 'followUrl'>, standing?: Pick<MemberStanding, 'removed'>) => (standing?.removed ? '' : roleLabel(share.role, !!share.followUrl));

/**
 * The first line after a shared folder was added: started here, joined with someone's invite, or added to another of
 * the owner's devices or from an offer of this vault's (`added`). `summary` says what its first sync did.
 */
export function addedLine(label: string, how: 'started' | 'joined' | 'added', summary = ''): string {
  const tail = summary ? `: ${summary}` : '';
  if (how === 'joined') return `You joined “${label}”${tail}.`;
  if (how === 'added') return `“${label}” is on this device too${tail}.`;
  return `“${label}” is shared${tail}.`;
}

/**
 * What this device is in `share`, from what its engine says (`MemberStanding`). A device added as one that only reads,
 * as a write member's other device is (offers.ts), never waits to be confirmed: the member's invite was another device's.
 */
export function standingHere(share: Pick<Share, 'role'>, standing: MemberStanding | undefined): MemberStanding | undefined {
  return standing && share.role === 'read' ? { ...standing, mayWrite: false, waiting: false } : standing;
}

/** The provider `storage` is at, for the access rules it can be given: a guess from its address. */
export const policyProvider = (storage: Storage) => (storage.storageType === 'webdav' ? 'webdav' : providerFromEndpoint(storage.endpoint));

/** Copy-ready access rules for a key to the storage of `storage` (a shared folder's): see `keyPolicy`. */
export const sharePolicy = (storage: Storage, kind: PolicyKind): Policy => keyPolicy({ provider: policyProvider(storage), bucket: storage.bucket.trim(), prefix: storage.prefix }, kind);

/**
 * A guess at the public address of `storage`'s folder, once it is made public, for providers whose public addresses
 * follow from the storage settings; '' where only the provider's console tells (R2's, WebDAV).
 */
export function publicAddressGuess(storage: Storage): string {
  const provider = policyProvider(storage);
  const bucket = storage.bucket.trim();
  const prefix = storage.prefix.replace(/^\/+|\/+$/g, '');
  if (provider === 'webdav' || provider === 'r2' || !bucket) return '';
  const at = (base: string) => [base.replace(/\/+$/, ''), prefix].filter(Boolean).join('/');
  if (provider === 'aws') return at(`https://${bucket}.s3.${storage.region.trim() || 'us-east-1'}.amazonaws.com`);
  const endpoint = (/^https?:\/\//i.test(storage.endpoint.trim()) ? storage.endpoint.trim() : `https://${storage.endpoint.trim()}`).replace(/\/+$/, '');
  return at(`${endpoint}/${bucket}`);
}

/**
 * Checks that a public address serves the shared folder `repo` names, before a follow link is made with it: its key
 * file must be there and be that folder's. Throws in words the owner can act on.
 */
export async function checkFollowAddress(store: RemoteStore, repo: string): Promise<void> {
  let header: Awaited<ReturnType<typeof Repo.header>>;
  try {
    header = await Repo.header(store);
  } catch (e) {
    throw new Error(`That address did not answer as expected: ${errorText(e)}`);
  }
  if (!header) {
    throw new Error('Nothing at that address serves this folder: its file vault.json could not be read there. Check the address, and that the folder is public.');
  }
  if (header.id !== repo) throw new Error('That address serves another shared folder than this one.');
}

/** What a follow link does and does not do, said where it is copied. */
export const followNote =
  'Anyone with this link can read this folder and every change to it, from the public address, with no passphrase and no storage keys. ' +
  'A follower can not be cut off short of making a new shared folder: removing the link stops Coffer on their devices, but whoever kept it can still read everything at that address.';

const day = (time: number) => new Date(time).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const moment = (time: number) => new Date(time).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** One member's line on the owner's member list: how it stands, and when it last changed something. */
export function memberLine(m: MemberStatus, now: number): string {
  const until = m.expires ? day(m.expires) : '';
  let state: string;
  if (m.follow) {
    state = m.state === 'expired' ? 'The link opens nothing new. Devices that followed before keep reading.' : 'Anyone with the link can read';
  } else {
    switch (m.state) {
      case 'joined':
        state = m.self ? 'This is you' : 'Joined';
        break;
      case 'confirming':
        state = 'Joined on a device, waiting for your device to confirm it';
        break;
      case 'waiting':
        state = m.role === 'read' ? `Invite works${until ? ` until ${until}` : ''}` : `Invited, not joined yet${until ? ` · invite works until ${until}` : ''}`;
        break;
      case 'expired':
        state = m.role === 'read' ? 'Invite expired. Devices that joined before keep receiving.' : 'Invite expired before anyone joined';
        break;
    }
  }
  const last = m.lastChange ? `last change ${m.lastChange > now - DAY ? new Date(m.lastChange).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : moment(m.lastChange)}` : '';
  return [state, last].filter(Boolean).join(' · ');
}

/** What a member's invite link does, said where it is copied. */
export function inviteNote(name: string, role: 'write' | 'read', expires: number): string {
  const who = name.trim() || 'them';
  return role === 'write'
    ? `Send this link to ${who} privately: it is all they need, with no passphrase. It works for one device: once your device confirms the one that joined, it stops working. Unused, it stops working on ${day(expires)}.`
    : `Send this link to ${who} privately: it is all they need, with no passphrase. Their devices only receive changes. It works until ${day(expires)} on any device that opens it, unless you remove ${who} before.`;
}

/** How long a re-key that did not work here waits before it is tried again: new keys can take a while to work at a provider. */
export const REKEY_RETRY_MS = 30 * 60_000;

/** A re-key found not to work on this device, and when. */
export interface RekeyFailure {
  n: number;
  at: number;
}

/** The re-key `followRekey` leaves untried at `now`, after `failed`. */
export const rekeySkip = (failed: RekeyFailure | undefined, now: number) => (failed && now - failed.at < REKEY_RETRY_MS ? failed.n : undefined);

/**
 * At a sync of a shared folder with members: new storage keys the owner handed this device, when there are any, are
 * tested (`test`) and kept (`keep`) before the engine is told; keys that fail the test are not kept, and this device
 * carries on with its own. `skip` is a re-key already found not to work here, not tested again (`rekeySkip`).
 * `transient` says the test failed on the way to storage, not on the keys: the next sync tries them again.
 */
export async function followRekey(
  engine: SyncEngine,
  o: { type: Storage['storageType']; kept: KeySet; skip?: number; test: (keys: KeySet) => Promise<void>; keep: (keys: KeySet) => Promise<void> },
): Promise<{ n: number; switched: boolean; problem?: string; transient?: true } | undefined> {
  const offer = await engine.rekeyOffer();
  if (!offer || offer.n === o.skip) return undefined;
  const keys = keysFromPayload(o.type, offer.storage, o.kept);
  if (!keys) return { n: offer.n, switched: false, problem: 'They hold no keys for this kind of storage.' };
  try {
    await o.test(keys);
  } catch (e) {
    const problem = errorText(e);
    return { n: offer.n, switched: false, problem, ...(isTransient(problem) && { transient: true as const }) };
  }
  await o.keep(keys);
  await engine.acceptRekey(offer.n);
  return { n: offer.n, switched: true };
}

/** Who a set of keys handed out at a re-key is for: the devices that write, members who only read, or those who also send suggestions. */
export type KeyUse = 'write' | 'read' | 'suggest';

/**
 * How keys handed out at a re-key are tested (`testKeys`): those for members who read may not write, by the same rule
 * as at their invite (`mustNotWrite`).
 */
export const rekeyTest = (storage: Storage, use: KeyUse) => ({ write: use === 'write', onlyRead: use !== 'write' && mustNotWrite(storage, use === 'suggest') });

/**
 * Owner: hands new storage keys to every member and to the owner's other devices. Every set is tested against this
 * shared folder (`test`, see `rekeyTest`) before anything is written. Read keys are needed while someone only reads
 * (`readers`), keys for suggestions while someone reads and sends them (`suggesters`); each set differs from the
 * others. Returns the re-key's number. The caller then keeps the write keys itself.
 */
export async function rekey(
  engine: SyncEngine,
  o: {
    type: Storage['storageType'];
    write: KeySet;
    read?: KeySet;
    readers: string[];
    suggest?: KeySet;
    suggesters?: string[];
    test: (keys: KeySet, use: KeyUse) => Promise<void>;
    /** The keys this device uses now, which every member was given in some form: handing them out again cuts nobody off. */
    current?: KeySet;
  },
): Promise<number> {
  const missing = keysProblem(o.type, o.write);
  if (missing) throw new Error(missing);
  const old = o.current;
  if (old && [o.write, o.read, o.suggest].some((k) => k && !keysProblem(o.type, k) && sameKeySet(o.type, k, old))) {
    throw new Error('Those are the storage keys this device uses now, which the members you invited to edit were given. Make new ones at your storage provider.');
  }
  let read: KeySet | undefined;
  if (o.readers.length) {
    if (!o.read || keysProblem(o.type, o.read)) throw new Error(`Enter read-only keys too: ${o.readers.join(', ')} only ${o.readers.length === 1 ? 'receives' : 'receive'} changes.`);
    if (sameKeySet(o.type, o.read, o.write)) throw new Error('The read-only keys are the new write keys. Make keys that can only read.');
    read = o.read;
  }
  let suggest: KeySet | undefined;
  const suggesters = o.suggesters ?? [];
  if (suggesters.length) {
    if (!o.suggest || keysProblem(o.type, o.suggest)) throw new Error(`Enter keys for suggestions too: ${suggesters.join(', ')} ${suggesters.length === 1 ? 'sends' : 'send'} you suggestions.`);
    if (sameKeySet(o.type, o.suggest, o.write)) throw new Error('The keys for suggestions are the new write keys. Make keys that can read and add suggestions.');
    if (read && sameKeySet(o.type, o.suggest, read)) throw new Error('The keys for suggestions are the read-only keys. Make separate ones, so that those who only read can not send suggestions.');
    suggest = o.suggest;
  }
  await o.test(o.write, 'write');
  if (read) await o.test(read, 'read');
  if (suggest) await o.test(suggest, 'suggest');
  return engine.writeRekey({
    write: keysPayload(o.type, o.write),
    ...(read && { read: keysPayload(o.type, read) }),
    ...(suggest && { suggest: keysPayload(o.type, suggest) }),
  });
}

/** An invite's expiry, `days` from `now`. */
export const expiresIn = (days: number, now: number) => now + days * DAY;
