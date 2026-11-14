// Starting a shared folder with members, and joining one with an invite. No Obsidian import.
import { fromB64, randomBytes, toB64 } from './bytes.ts';
import { MIN_PASSPHRASE, newSigningKey, publicKeyOf } from './crypto.ts';
import { MemberBook, newMemberId, openSlot, readJoin, writeJoin, type MemberGrant, type MemberKeys } from './members.ts';
import { MEMBER_FORMAT, Repo, saneChunks } from './repo.ts';
import type { ChunkParams, Commit, RemoteStore } from './types.ts';

/**
 * Starts a member share in an empty storage location, with this device as its owner: the first commit names the owner
 * alone. Returns what the owner's devices keep in secret storage; give it to a `SyncEngine` as `member.keys`.
 * `passphrase` is what the owner links that set up the owner's other devices are sealed with; storage holds nothing
 * sealed with it.
 */
export async function createMemberShare(
  store: RemoteStore,
  o: { owner: string; device: string; passphrase: string; kdfIterations: number; chunk: ChunkParams; now?: number },
): Promise<MemberKeys> {
  if (o.passphrase.length < MIN_PASSPHRASE) throw new Error(`A shared folder needs a passphrase of at least ${MIN_PASSPHRASE} characters`);
  const name = o.owner.trim();
  if (!name) throw new Error('The owner needs a name, which members see');
  if (!saneChunks(o.chunk)) throw new Error('Those chunk sizes are not ones Coffer uses');
  const master = randomBytes(32);
  const root = randomBytes(32);
  const { key, pub } = await newSigningKey();
  const id = newMemberId();
  const repo = await Repo.createMember(store, master, o);
  repo.useMembers(new MemberBook(repo.id, { owner: pub, id, key }), () => ({ changes: [], through: 0 }));
  const first: Commit = {
    seq: 1, device: o.device, time: o.now ?? Date.now(), changes: [], prev: '', moved: true,
    members: { gen: 1, members: [{ id, name, role: 'owner', pub }], earlier: [] },
  };
  if (!(await repo.writeCommit(first))) throw new Error('Another device started a shared folder in this storage location at the same moment');
  return { repo: repo.id, id, master: toB64(master), owner: pub, key, root: toB64(root), since: 1 };
}

const USED = 'This invite was already used on another device. Ask for a new one: each invite adds one device.';

/**
 * Joins a member share with an invite (`decodeInvite`, or a follow link's `decodeFollow`, which joins to read): opens
 * the invite's slot for the master key and, to write, makes this device's own key pair. Writes nothing: keep what it
 * returns in secret storage, then, to write, call `publishJoin`, which leaves the public key for the owner's device to
 * confirm. Until then the device only receives. The private key never leaves the device.
 */
export async function joinShare(store: RemoteStore, invite: Omit<MemberGrant, 'role'> & { role?: MemberGrant['role'] }, now = Date.now()): Promise<MemberKeys> {
  const header = await Repo.header(store);
  if (!header) throw new Error('The shared folder is not in this storage location: its key file, vault.json, is missing');
  if (header.format !== MEMBER_FORMAT || header.id !== invite.repo) throw new Error('This storage location holds another shared folder than the one this invite is for');
  const secret = fromB64(invite.secret);
  const master = await openSlot(store, invite.repo, invite.member, secret, now);
  const keys: MemberKeys = { repo: invite.repo, id: invite.member, master: toB64(master), owner: invite.owner, secret: invite.secret, since: invite.since };
  if (invite.role === 'write') {
    if ((await readJoin(store, invite.repo, invite.member, secret)) !== null) throw new Error(USED);
    keys.key = (await newSigningKey()).key;
  }
  return keys;
}

/**
 * Leaves the public key of a device that joined to write (`joinShare`) for the owner's device to confirm. Call it once
 * the keys are kept: with the same keys it can be called again, as after the app stopped before it heard back. Syncs
 * of such a device call it too. Throws when another device used the invite first.
 */
export async function publishJoin(store: RemoteStore, keys: MemberKeys): Promise<void> {
  if (!keys.key || !keys.secret) throw new Error('This device did not join to write');
  if (!(await writeJoin(store, keys.repo, keys.id, fromB64(keys.secret), publicKeyOf(keys.key)))) throw new Error(USED);
}
