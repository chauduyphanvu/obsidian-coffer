import { utf8 } from '../core/bytes.ts';
import { hasControl } from '../core/text.ts';
import type { RemoteStore } from '../core/types.ts';
import { sha256Hex } from '../stores/sigv4.ts';

/** One file of a built site: its bytes and the content type a browser is told. */
export interface SiteFile { data: Uint8Array; type: string }

/** Where the site's file list is kept, beside the site's files. */
export const MANIFEST = 'coffer-site.json';

/** The files Coffer has put at a site's location, each with the SHA-256 of its bytes in hex; '' for a file about to be written. */
export interface Manifest { version: 1; files: Record<string, string> }

/** What publishing would change at the location. Keys are sorted. */
export interface DeployPlan {
  /** Files not there yet. */
  added: string[];
  /** Files there with other content. */
  changed: string[];
  /** Files there that the site no longer has: deleted from the location. */
  removed: string[];
  /** Files already there as they are. */
  same: number;
  /** Bytes to upload: the sizes of `added` and `changed`. */
  bytes: number;
  /** Nothing was published here before. */
  first: boolean;
}

/** A plan with what carrying it out needs. */
export interface Planned {
  plan: DeployPlan;
  /** Each site file's hash, by key. */
  hashes: Map<string, string>;
  /** What the location's manifest said, or null. */
  before: Manifest | null;
}

/** The location holds a synced vault or shared folder (`vault.json`): publishing there would put readable pages among it. */
export class VaultLocationError extends Error {
  constructor() {
    super('This location holds a synced vault, so nothing was published. Choose a bucket or folder of its own for the website.');
  }
}

/** The location has an `index.html` and no file list of Coffer's: a site something else put there. */
export class ForeignSiteError extends Error {
  constructor() {
    super('This location already has a website that Coffer did not put there, so nothing was published. Choose an empty folder, or remove what is there.');
  }
}

/** The file list at the location cannot be read as one Coffer wrote. */
export class ManifestError extends Error {
  constructor(newer = false) {
    super(
      newer
        ? 'A newer version of Coffer published the website at this location, so nothing was published. Update Coffer to publish here again.'
        : `The list of published files at this location (${MANIFEST}) is damaged, so nothing was published. Remove the website's files and that list from the location, then publish again.`,
    );
  }
}

const INDEX = 'index.html';
const VAULT = 'vault.json';
const JSON_TYPE = 'application/json';

/**
 * Whether a file of this name may be put at the location: never the file list or a vault's, and never a name that leaves
 * the folder. A backslash is refused because a folder on Windows reads it as a separator.
 */
const unusable = (key: string): boolean =>
  key === MANIFEST || key === VAULT || key.includes('\\') || hasControl(key) || key.split('/').some((part) => part === '' || part === '.' || part === '..');

/** `files` in sorted order, as the bytes of a manifest: stable, so the same site always writes the same file. */
function manifestBytes(files: Iterable<[string, string]>): Uint8Array {
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
  const manifest: Manifest = { version: 1, files: Object.fromEntries(sorted) };
  return utf8.encode(JSON.stringify(manifest, null, 1));
}

function readManifest(bytes: Uint8Array): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ManifestError();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ManifestError();
  const { version, files } = raw as { version?: unknown; files?: unknown };
  if (typeof version === 'number' && version > 1) throw new ManifestError(true);
  if (version !== 1 || typeof files !== 'object' || files === null || Array.isArray(files)) throw new ManifestError();
  // Its names are deleted from the location when the site drops them, so a damaged one must not name anything outside the site.
  for (const [key, hash] of Object.entries(files)) if (typeof hash !== 'string' || unusable(key)) throw new ManifestError();
  return { version: 1, files: files as Record<string, string> };
}

/**
 * Compares the built site with what Coffer put at the location before, and writes nothing. Refuses a location that holds
 * a synced vault, or a website Coffer did not publish, or a file list it cannot read.
 */
export async function planDeploy(store: RemoteStore, files: ReadonlyMap<string, SiteFile>): Promise<Planned> {
  if ((await store.get(VAULT)) !== null) throw new VaultLocationError();
  const stored = await store.get(MANIFEST);
  const before = stored === null ? null : readManifest(stored);
  if (!before && (await store.get(INDEX)) !== null) throw new ForeignSiteError();
  for (const key of files.keys()) {
    if (unusable(key)) throw new Error(`The website has a file named "${key}", which cannot be put in the published folder, so nothing was published.`);
  }

  const hashes = new Map<string, string>();
  for (const [key, file] of files) hashes.set(key, await sha256Hex(file.data));

  const there = new Map(Object.entries(before?.files ?? {}));
  const added: string[] = [];
  const changed: string[] = [];
  let same = 0;
  let bytes = 0;
  for (const [key, hash] of hashes) {
    const was = there.get(key);
    // A hash is never '', so a file marked '' in the manifest counts as changed.
    if (was === undefined) added.push(key);
    else if (was !== hash) changed.push(key);
    else {
      same++;
      continue;
    }
    bytes += files.get(key)!.data.length;
  }
  const removed = [...there.keys()].filter((key) => !hashes.has(key));
  return { plan: { added: added.sort(), changed: changed.sort(), removed: removed.sort(), same, bytes, first: before === null }, hashes, before };
}

export interface DeployOptions {
  /** Uploads and deletions in flight at once. Default 4. */
  concurrency?: number;
  /** Called after each file is uploaded or deleted. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Runs `work` on each item, `limit` at a time. After a failure it starts no more, waits for the ones under way, and
 * throws the first error, so nothing is still being written once the caller sees the failure.
 */
async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async () => {
    while (!failure && next < items.length) {
      try {
        await work(items[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
}

/**
 * Carries out `planned`: uploads what is new or changed (the front page last), deletes what the site no longer has, and
 * keeps the manifest. Every file is named in the stored manifest before it is written and until after it is deleted, so
 * a publish cut short never leaves a public file Coffer has lost track of, and the next one finishes the job. Writes
 * nothing when nothing changed. A failure is thrown as the store gave it.
 */
export async function deploy(store: RemoteStore, files: ReadonlyMap<string, SiteFile>, planned: Planned, opts: DeployOptions = {}): Promise<void> {
  const { plan, hashes, before } = planned;
  const upload = [...plan.added, ...plan.changed];
  const total = upload.length + plan.removed.length;
  if (total === 0 && !plan.first) return;
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 4));
  let done = 0;

  if (upload.length) {
    // A changed file is marked too: if this run stops after it is written, the stored hash is no longer true of it, and a
    // site that went back to the old content would otherwise look as if it were already there.
    const interim = new Map(Object.entries(before?.files ?? {}));
    for (const key of upload) interim.set(key, '');
    await store.put(MANIFEST, manifestBytes(interim), { contentType: JSON_TYPE });
  }

  const put = async (key: string) => {
    const file = files.get(key)!;
    await store.put(key, file.data, { contentType: file.type });
    opts.onProgress?.(++done, total);
  };
  await inParallel(upload.filter((key) => key !== INDEX), limit, put);
  if (upload.includes(INDEX)) await put(INDEX);

  await inParallel(plan.removed, limit, async (key) => {
    await store.delete(key);
    opts.onProgress?.(++done, total);
  });

  await store.put(MANIFEST, manifestBytes(hashes), { contentType: JSON_TYPE });
}
