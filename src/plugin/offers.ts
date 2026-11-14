// Shared folders that follow the user's own devices: when a shared folder is added on one device, it leaves an offer in
// the vault's storage, sealed with the vault's key, that the vault's other devices add with one tap. No Obsidian import,
// so it runs under plain Node tests.
import { pool } from '../core/bytes.ts';
import { parseMemberKeys, type MemberKeys } from '../core/members.ts';
import type { Repo } from '../core/repo.ts';
import { MEMBER_KEYS } from './members.ts';
import { normalFolder, shareSecretName, shareWith, storageFromPayload, storageLocation, storagePayload, type SecretLookup, type Settings, type Share } from './settings.ts';

/*
 * One document per shared folder, `shares/<share id>`, among the vault's documents. A version before 0.4 lists and
 * deletes only its own kinds of objects (log/, snap/, pack/, dev/), so it never sees these.
 *
 * What a device adding it becomes:
 * - the owner's: another of the owner's devices, with the owner's keys, as the owner's own link gives;
 * - a member's that only reads: a read member's, a follower's, and also a write member's other device. An invite to
 *   edit is for one device: the member's private key never leaves it, so other devices of that member only receive;
 * - a device of a folder shared with a passphrase, with that passphrase.
 *
 * Cost: offering writes one document when a shared folder is added here, and again when its storage keys change while
 * an offer is kept. Looking for offers lists `shares/` and reads only the documents that are new or changed since the
 * last look: at the first sync of a session, every 30 minutes after, and when the Shared folders settings open.
 * Ordinary syncs in between ask for nothing more.
 */

export const OFFER_PREFIX = 'shares/';
export const offerKey = (id: string) => `${OFFER_PREFIX}${id}`;

/** How often the vault's sync looks for new offers. */
export const OFFERS_EVERY = 30 * 60_000;
export const offersDue = (lastLooked: number, now: number) => !lastLooked || now - lastLooked > OFFERS_EVERY;

export interface Offer {
  v: 1;
  /** The share's id on the device that offered it; a device that adds it uses the same one. */
  id: string;
  folder: string;
  /** The device that offered it, by name. */
  by: string;
  time: number;
  /** What a device that adds it is in the shared folder: the owner's, a member's that only reads, or '' when it is shared with a passphrase. */
  role: '' | 'owner' | 'read';
  /** The member that offered it may edit, on that device only. */
  edits?: true;
  readOnly: boolean;
  /** Where it is stored and the keys that reach it, as a setup code carries them. Unused when it is followed. */
  storage: Record<string, unknown>;
  followUrl?: string;
  passphrase?: string;
  member?: MemberKeys;
}

/** The vault's documents, as its `Repo` reads and writes them. */
export type Docs = Pick<Repo, 'readDoc' | 'writeDoc' | 'listDocs' | 'deleteDoc'>;

/** The offer of `share` as this device has it, to add it on another of the user's devices. */
export function offerOf(share: Share, secret: SecretLookup, by: string, now: number): Offer {
  const offer: Offer = { v: 1, id: share.id, folder: share.folder, by, time: now, role: '', readOnly: share.readOnly, storage: share.followUrl ? {} : storagePayload(share, secret) };
  if (share.followUrl) offer.followUrl = share.followUrl;
  const passphrase = secret(share.passphraseSecret);
  if (passphrase) offer.passphrase = passphrase;
  if (!share.memberKeysSecret) return offer;
  const keys = parseMemberKeys(secret(share.memberKeysSecret));
  if (share.role === 'owner') return { ...offer, role: 'owner', member: keys };
  // Never a write member's private key: two devices signing as one member would undo "one invite, one device".
  const { key, ...rest } = keys;
  return { ...offer, role: 'read', readOnly: true, ...(share.role === 'write' && key && { edits: true as const }), member: rest };
}

const isText = (v: unknown): v is string => typeof v === 'string';

/** An offer as read back, checked field by field; undefined for anything else. */
export function parseOffer(value: unknown): Offer | undefined {
  const o = value as Partial<Offer> | null;
  if (!o || typeof o !== 'object' || o.v !== 1) return undefined;
  if (!isText(o.id) || !/^[0-9a-z]{1,32}$/.test(o.id) || !isText(o.folder) || !normalFolder(o.folder) || !isText(o.by) || typeof o.time !== 'number') return undefined;
  if (o.role !== '' && o.role !== 'owner' && o.role !== 'read') return undefined;
  if (!o.storage || typeof o.storage !== 'object' || Array.isArray(o.storage)) return undefined;
  if (o.followUrl !== undefined && (!isText(o.followUrl) || !/^https?:\/\//i.test(o.followUrl))) return undefined;
  if (o.passphrase !== undefined && !isText(o.passphrase)) return undefined;
  let member: MemberKeys | undefined;
  try {
    if (o.member !== undefined) member = parseMemberKeys(o.member);
  } catch {
    return undefined;
  }
  // Each kind carries what it needs: a passphrase, or member keys (the owner's with the root and key).
  if (o.role === '' ? !o.passphrase || member || o.followUrl : !member || (o.role === 'owner' ? !member.root || !member.key : !!member.key)) return undefined;
  const offer: Offer = { v: 1, id: o.id, folder: normalFolder(o.folder), by: o.by, time: o.time, role: o.role, readOnly: o.role === 'read' || o.readOnly === true, storage: o.storage };
  if (o.edits === true) offer.edits = true;
  if (o.followUrl) offer.followUrl = o.followUrl;
  if (o.passphrase) offer.passphrase = o.passphrase;
  if (member) offer.member = member;
  return offer;
}

/**
 * The share an offer adds on this device of `vault`, at the folder it was offered at, and its secrets to store first,
 * named for the offer's id. The id is the offer's, so this device's later changes to the offer go to the same document.
 */
export function shareFromOffer(offer: Offer, vault: string): { share: Share; secrets: [string, string][] } {
  const name = (base: string) => shareSecretName(base, vault, offer.id);
  const { storage, secrets } = offer.followUrl ? { storage: {}, secrets: [] as [string, string][] } : storageFromPayload(offer.storage, name);
  const share = shareWith({ ...storage, id: offer.id, folder: offer.folder, readOnly: offer.readOnly, role: offer.role, followUrl: offer.followUrl ?? '' });
  if (offer.passphrase) {
    share.passphraseSecret = name('coffer-passphrase');
    secrets.push([share.passphraseSecret, offer.passphrase]);
  }
  if (offer.member) {
    share.memberKeysSecret = name(MEMBER_KEYS);
    secrets.push([share.memberKeysSecret, JSON.stringify(offer.member)]);
  }
  return { share, secrets };
}

/** Where an offer's shared folder is stored, as `storageLocation` says it, to tell the same shared folder under another id. */
export const offerLocation = (offer: Offer) => storageLocation(shareFromOffer(offer, '').share);

/** What a device offering it is, best first: a device that adds it from the better one can do more. */
const rank = (o: Offer) => (o.role === 'owner' ? 0 : o.role === '' ? 1 : 2);

/**
 * The offers to show on this device: not added here (under its id, or at its storage location under another), not
 * hidden here, one per storage location: the owner's, then the newest.
 */
export function offersHere(offers: Offer[], s: Settings): Offer[] {
  const here = new Set(s.shares.map((x) => storageLocation(x)));
  const ids = new Set(s.shares.map((x) => x.id));
  const best = new Map<string, Offer>();
  for (const o of offers) {
    const at = offerLocation(o);
    if (ids.has(o.id) || here.has(at) || s.offersHidden.includes(o.id)) continue;
    const kept = best.get(at);
    if (!kept || rank(o) < rank(kept) || (rank(o) === rank(kept) && o.time > kept.time)) best.set(at, o);
  }
  return [...best.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * What a look for offers keeps between looks: every document storage listed, by key, with when it was written and the
 * offer when it reads as one.
 */
export type OfferCache = Map<string, { modified: number; offer?: Offer }>;

/**
 * Brings `cache` up to date with the offers in the vault's storage: one list, and a read of each document that is new
 * or changed since. A document that cannot be read now is read again at the next look.
 */
export async function lookForOffers(docs: Docs, cache: OfferCache): Promise<Offer[]> {
  const listed = await docs.listDocs(OFFER_PREFIX);
  const keys = new Set(listed.map((o) => o.key));
  for (const key of [...cache.keys()]) if (!keys.has(key)) cache.delete(key);
  await pool(listed.filter((o) => cache.get(o.key)?.modified !== o.modified), 4, async (o) => {
    let offer: Offer | undefined;
    try {
      offer = parseOffer(await docs.readDoc(o.key));
    } catch {
      cache.set(o.key, { modified: Number.NaN });
      return;
    }
    cache.set(o.key, { modified: o.modified, ...(offer && offerKey(offer.id) === o.key && { offer }) });
  });
  return offersIn(cache);
}

export const offersIn = (cache: OfferCache): Offer[] => [...cache.values()].flatMap((c) => (c.offer ? [c.offer] : []));

/**
 * Writes this device's offer of `share`, and returns it. One that only updates (`offerPending` 'update') is written only
 * while an offer of it is kept, so an offer withdrawn on another device does not come back.
 */
export async function publishOffer(docs: Docs, share: Share, secret: SecretLookup, by: string, now: number): Promise<Offer | undefined> {
  // Notes shared by a property have one sender: another device of the vault gets them through the vault's own sync.
  if (share.property) return undefined;
  if (share.offerPending === 'update' && !(await docs.readDoc(offerKey(share.id)))) return undefined;
  const offer = offerOf(share, secret, by, now);
  await docs.writeDoc(offerKey(share.id), offer);
  return offer;
}

/** The ids of the offers of `share` the last look found, under its id or at its storage location. */
export function offersOf(share: Share, cache: OfferCache): string[] {
  const at = storageLocation(share);
  const ids = new Set<string>();
  for (const [key, c] of cache) if (key === offerKey(share.id) || (c.offer && offerLocation(c.offer) === at)) ids.add(key.slice(OFFER_PREFIX.length));
  return [...ids];
}

/** Withdraws every offer of `share`: its own, and those the last look found at its storage location under another id. */
export async function withdrawOffers(docs: Docs, share: Share, cache: OfferCache): Promise<void> {
  for (const id of new Set([share.id, ...offersOf(share, cache)])) {
    await docs.deleteDoc(offerKey(id));
    cache.delete(offerKey(id));
  }
}

/** Whether the last look found an offer of `share`. */
export const isOffered = (share: Share, cache: OfferCache): boolean => offersOf(share, cache).length > 0;

/** Settings kept per offer, trimmed to the offers storage still held at the last look. */
export function forgetGone(s: Settings, cache: OfferCache): void {
  const ids = new Set([...cache.keys()].map((key) => key.slice(OFFER_PREFIX.length)));
  s.offersTold = s.offersTold.filter((id) => ids.has(id));
  s.offersHidden = s.offersHidden.filter((id) => ids.has(id));
}
