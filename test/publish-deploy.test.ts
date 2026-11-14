// Publishing a built site: what the stores say about a file's content type, and the deploy that compares a site with
// what was uploaded before, uploads what changed and deletes what is gone. Rendering the notes is in publish-markdown.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOnlyStore, type RemoteStore } from '../src/core/types.ts';
import {
  ForeignSiteError, MANIFEST, ManifestError, VaultLocationError, deploy, planDeploy, type DeployOptions, type Manifest, type Planned, type SiteFile,
} from '../src/publish/deploy.ts';
import { splitContentType, type Http, type HttpRequest } from '../src/stores/http.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { withRetry } from '../src/stores/retry.ts';
import { S3Store } from '../src/stores/s3.ts';
import { sha256Hex } from '../src/stores/sigv4.ts';
import { WebDavStore } from '../src/stores/webdav.ts';
import { lossy } from './helpers.ts';

const enc = new TextEncoder();
const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const HTML = 'text/html; charset=utf-8';
const empty = new Uint8Array(0);

// A content type on put.

/** Answers every request with `status` and records it. */
function recordingHttp(status: number, answer?: (req: HttpRequest) => number | undefined) {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return { status: answer?.(req) ?? status, body: empty };
  };
  return { http, seen };
}

const s3 = (http: Http) => new S3Store({ endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'site', prefix: '', accessKey: 'AK', secretKey: 'SK', pathStyle: true }, http);
const signedHeaders = (req: HttpRequest) => /SignedHeaders=([^,]+)/.exec(req.headers.authorization)![1].split(';');

test('s3: a put with a content type sends it, and it is among the signed headers', async () => {
  const { http, seen } = recordingHttp(200);
  assert.equal(await s3(http).put('index.html', enc.encode('<p>hi</p>'), { contentType: HTML }), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'PUT');
  assert.equal(seen[0].headers['content-type'], HTML);
  assert.deepEqual(signedHeaders(seen[0]), ['content-type', 'host', 'x-amz-content-sha256', 'x-amz-date']);
});

test('s3: a put without one sends no content type, exactly as before', async () => {
  const { http, seen } = recordingHttp(200);
  await s3(http).put('index.html', enc.encode('x'));
  await s3(http).put('log/1', enc.encode('x'), { ifNoneMatch: true });
  assert.deepEqual(Object.keys(seen[0].headers).sort(), ['authorization', 'x-amz-content-sha256', 'x-amz-date']);
  assert.deepEqual(signedHeaders(seen[0]), ['host', 'x-amz-content-sha256', 'x-amz-date']);
  assert.deepEqual(Object.keys(seen[1].headers).sort(), ['authorization', 'if-none-match', 'x-amz-content-sha256', 'x-amz-date']);
});

test('s3: a content type and a create-if-absent put together send both', async () => {
  const { http, seen } = recordingHttp(200);
  await s3(http).put('a.css', enc.encode('x'), { ifNoneMatch: true, contentType: 'text/css' });
  assert.equal(seen[0].headers['if-none-match'], '*');
  assert.equal(seen[0].headers['content-type'], 'text/css');
  assert.deepEqual(signedHeaders(seen[0]), ['content-type', 'host', 'if-none-match', 'x-amz-content-sha256', 'x-amz-date']);
});

test('webdav: a put with a content type sends it on both attempts, before and after the folder is made', async () => {
  let made = false;
  const { http, seen } = recordingHttp(201, (req) => {
    if (req.method === 'MKCOL') made = true;
    return req.method === 'PUT' && !made ? 409 : undefined;
  });
  const store = new WebDavStore({ url: 'https://dav.example.com/site', username: 'u', password: 'p' }, http);
  await store.put('notes/a.html', enc.encode('x'), { contentType: HTML });
  const puts = seen.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 2);
  for (const put of puts) {
    assert.equal(put.headers['content-type'], HTML);
    assert.ok(put.headers.authorization);
  }
});

test('webdav: a put without one sends no content type', async () => {
  const { http, seen } = recordingHttp(201);
  const store = new WebDavStore({ url: 'https://dav.example.com/site', username: 'u', password: 'p' }, http);
  await store.put('a.html', enc.encode('x'));
  await store.put('b.html', enc.encode('x'), { ifNoneMatch: true });
  assert.deepEqual(Object.keys(seen[0].headers), ['authorization']);
  assert.deepEqual(Object.keys(seen[1].headers).sort(), ['authorization', 'if-none-match']);
});

test('memory store: records the content type it was given, and none for a put without one', async () => {
  const store = new MemoryStore();
  await store.put('a.html', enc.encode('x'), { contentType: HTML });
  await store.put('b', enc.encode('x'));
  await store.put('c', enc.encode('x'), { ifNoneMatch: true });
  assert.equal(store.objects.get('a.html')!.type, HTML);
  assert.ok(!('type' in store.objects.get('b')!));
  assert.ok(!('type' in store.objects.get('c')!));
  await store.put('a.html', enc.encode('y'));
  assert.ok(!('type' in store.objects.get('a.html')!), 'an overwrite without a type does not keep the old one');
  assert.equal(await store.put('c', enc.encode('z'), { ifNoneMatch: true, contentType: 'text/css' }), false);
  assert.ok(!('type' in store.objects.get('c')!), 'a put that wrote nothing changes nothing');
});

test('the retrying store passes the content type on', async () => {
  const mem = new MemoryStore();
  await withRetry(mem).put('a.html', enc.encode('x'), { contentType: HTML });
  assert.equal(mem.objects.get('a.html')!.type, HTML);
});

test('splitContentType: takes the content type out of the headers, in any letter case', () => {
  assert.deepEqual(splitContentType({ 'content-type': 'text/html', range: 'bytes=0-1' }), { contentType: 'text/html', headers: { range: 'bytes=0-1' } });
  assert.deepEqual(splitContentType({ 'Content-Type': 'text/css', 'x-a': 'b' }), { contentType: 'text/css', headers: { 'x-a': 'b' } });
  assert.deepEqual(splitContentType({ 'CONTENT-TYPE': 'application/xml' }), { contentType: 'application/xml', headers: {} });
});

test('splitContentType: headers without one come back as they were, with no content type named', () => {
  const given = { authorization: 'Basic x', 'cache-control': 'no-store' };
  const split = splitContentType(given);
  assert.deepEqual(split, { headers: given });
  assert.ok(!('contentType' in split));
  assert.deepEqual(splitContentType({}), { headers: {} });
  const withType = { 'content-type': 'a/b', x: 'y' };
  splitContentType(withType);
  assert.deepEqual(withType, { 'content-type': 'a/b', x: 'y' }, 'the headers given are not changed');
});

// Building blocks for what follows.

const TYPES: Record<string, string> = { html: HTML, css: 'text/css', png: 'image/png' };

/** A built site from file names and their text; the type follows the extension. */
function site(entries: Record<string, string>): Map<string, SiteFile> {
  return new Map(Object.entries(entries).map(([key, text]) => [key, { data: enc.encode(text), type: TYPES[key.slice(key.lastIndexOf('.') + 1)] ?? 'application/octet-stream' }]));
}

const publish = async (store: RemoteStore, files: ReadonlyMap<string, SiteFile>, opts?: DeployOptions): Promise<Planned> => {
  const planned = await planDeploy(store, files);
  await deploy(store, files, planned, opts);
  return planned;
};

const storedManifest = (mem: MemoryStore): Manifest => JSON.parse(dec(mem.objects.get(MANIFEST)!.data));

/** The store holds exactly the site's files and a manifest that says what they are. */
async function assertPublished(mem: MemoryStore, files: ReadonlyMap<string, SiteFile>): Promise<void> {
  assert.deepEqual([...mem.objects.keys()].sort(), [...files.keys(), MANIFEST].sort());
  const hashes: Record<string, string> = {};
  for (const key of [...files.keys()].sort()) {
    const file = files.get(key)!;
    assert.deepEqual(mem.objects.get(key)!.data, file.data, key);
    assert.equal(mem.objects.get(key)!.type, file.type, key);
    hashes[key] = await sha256Hex(file.data);
  }
  const manifest = mem.objects.get(MANIFEST)!;
  assert.equal(manifest.type, 'application/json');
  assert.equal(dec(manifest.data), JSON.stringify({ version: 1, files: hashes }, null, 1));
}

/** The invariant a publish cut short must keep: whatever is in storage, the manifest in storage names it. */
function assertTracked(mem: MemoryStore): void {
  const listed = mem.objects.has(MANIFEST) ? storedManifest(mem).files : {};
  for (const key of mem.objects.keys()) {
    if (key !== MANIFEST) assert.ok(Object.hasOwn(listed, key), `${key} is in storage and not in its manifest`);
  }
}

interface Call { op: 'put' | 'delete'; key: string; type?: string; data?: Uint8Array }
interface Fault {
  /** Which write fails: the `n`th call counted from 1. */
  when: (call: Call, n: number) => boolean;
  /** The write takes effect and then fails, as when its reply is lost. */
  landed: boolean;
}

/** `inner` with its writes recorded, in the order they start and finish, how many are under way at once, and an optional failing write. */
function watch(inner: RemoteStore, fault?: Fault) {
  const calls: Call[] = [];
  const events: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const write = async <T>(call: Call, run: () => Promise<T>): Promise<T> => {
    calls.push(call);
    const n = calls.length;
    events.push(`start ${call.op} ${call.key}`);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const failing = fault?.when(call, n);
      if (failing && !fault!.landed) throw new Error('the write failed');
      const out = await run();
      if (failing) throw new Error('the reply was lost');
      events.push(`end ${call.op} ${call.key}`);
      return out;
    } finally {
      inFlight--;
    }
  };
  const store: RemoteStore = {
    get: (key, range) => inner.get(key, range),
    list: (prefix, after) => inner.list(prefix, after),
    put: (key, data, opts) => write({ op: 'put', key, type: opts?.contentType, data }, () => inner.put(key, data, opts)),
    delete: (key) => write({ op: 'delete', key }, () => inner.delete(key)),
  };
  return {
    store,
    calls,
    events,
    get peak() {
      return peak;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

/** A store with `files` published to it. */
async function published(files?: ReadonlyMap<string, SiteFile>): Promise<MemoryStore> {
  const mem = new MemoryStore();
  if (files) await publish(mem, files);
  return mem;
}

const snapshot = (mem: MemoryStore) => JSON.stringify([...mem.objects].map(([key, o]) => [key, Array.from(o.data), o.modified, o.type]));
const tick = () => new Promise((resolve) => setImmediate(resolve));

// planDeploy: what it refuses.

test('plan: a location with a vault in it is refused before anything else is looked at', async () => {
  const mem = new MemoryStore();
  mem.objects.set('vault.json', { data: enc.encode('{}'), modified: 0 });
  mem.objects.set(MANIFEST, { data: enc.encode('not json'), modified: 0 });
  mem.objects.set('index.html', { data: enc.encode('x'), modified: 0 });
  const reads: string[] = [];
  const store: RemoteStore = { get: (key) => (reads.push(key), mem.get(key)), put: (...a) => mem.put(...a), delete: (key) => mem.delete(key), list: (p, a) => mem.list(p, a) };
  await assert.rejects(planDeploy(store, site({ '../bad': 'x' })), (e: Error) => e instanceof VaultLocationError && /synced vault.*nothing was published/.test(e.message));
  assert.deepEqual(reads, ['vault.json']);
});

test('plan: an index.html that Coffer did not put there is refused, and one it did is not', async () => {
  const foreign = new MemoryStore();
  foreign.objects.set('index.html', { data: enc.encode('<p>mine</p>'), modified: 0 });
  await assert.rejects(planDeploy(foreign, site({ 'index.html': 'x' })), (e: Error) => e instanceof ForeignSiteError && /did not put there/.test(e.message));
  assert.equal(dec(foreign.objects.get('index.html')!.data), '<p>mine</p>');

  const ours = await published(site({ 'index.html': 'x' }));
  assert.equal((await planDeploy(ours, site({ 'index.html': 'y' }))).plan.changed.length, 1);
});

test('plan: a folder with other files but no index.html and no manifest counts as empty', async () => {
  const mem = new MemoryStore();
  mem.objects.set('notes.txt', { data: enc.encode('x'), modified: 0 });
  const { plan } = await planDeploy(mem, site({ 'index.html': 'x' }));
  assert.equal(plan.first, true);
  assert.deepEqual(plan.added, ['index.html']);
});

test('plan: a manifest that is not one Coffer wrote is refused', async () => {
  const bad = [
    '', 'not json', '{', 'null', '[]', '"x"', '7', '{}', '{"files":{}}', '{"version":1}', '{"version":1,"files":null}', '{"version":1,"files":[]}', '{"version":1,"files":"x"}',
    '{"version":1,"files":{"a.html":1}}', '{"version":1,"files":{"a.html":null}}', '{"version":"1","files":{}}', '{"version":0,"files":{}}', '{"version":null,"files":{}}',
    '{"version":1,"files":{"../x":"h"}}', '{"version":1,"files":{"/x":"h"}}', '{"version":1,"files":{"a//b":"h"}}', '{"version":1,"files":{"vault.json":""}}',
    `{"version":1,"files":{"${MANIFEST}":""}}`,
  ];
  for (const text of bad) {
    const mem = new MemoryStore();
    mem.objects.set(MANIFEST, { data: enc.encode(text), modified: 0 });
    await assert.rejects(planDeploy(mem, site({ 'index.html': 'x' })), (e: Error) => e instanceof ManifestError && !/newer/.test(e.message), JSON.stringify(text));
  }
});

test('plan: a manifest from a newer version of Coffer is refused, and says so', async () => {
  for (const version of [2, 3, 99]) {
    const mem = new MemoryStore();
    mem.objects.set(MANIFEST, { data: enc.encode(JSON.stringify({ version, files: { 'index.html': 'h' }, extra: true })), modified: 0 });
    await assert.rejects(planDeploy(mem, site({ 'index.html': 'x' })), (e: Error) => e instanceof ManifestError && /newer version of Coffer/.test(e.message));
  }
});

test('plan: a file the site must not have is refused by name, as a plain error', async () => {
  const mem = new MemoryStore();
  for (const key of ['', '/index.html', 'a//b.html', 'a/', '.', '..', 'a/./b.html', 'a/../b.html', '../b.html', MANIFEST, 'vault.json']) {
    const files = site({ 'index.html': 'x' });
    files.set(key, { data: enc.encode('x'), type: HTML });
    await assert.rejects(planDeploy(mem, files), (e: Error) => e.constructor === Error && e.message.includes(`"${key}"`), JSON.stringify(key));
  }
  for (const key of ['notes/a b.html', 'ü/é.html', '.nojekyll', '.well-known/x', 'a..b', '...', 'a/b/c/d.png']) {
    await planDeploy(mem, site({ [key]: 'x' }));
  }
});

// planDeploy: what it works out.

test('plan: a first publish adds every file, with the bytes to send', async () => {
  const files = site({ 'index.html': '<p>home</p>', 'notes/b.html': 'bb', 'a.css': 'a' });
  const { plan, hashes, before } = await planDeploy(new MemoryStore(), files);
  assert.deepEqual(plan, { added: ['a.css', 'index.html', 'notes/b.html'], changed: [], removed: [], same: 0, bytes: 11 + 2 + 1, first: true });
  assert.equal(before, null);
  assert.equal(hashes.size, 3);
  for (const [key, file] of files) assert.equal(hashes.get(key), await sha256Hex(file.data));
});

test('plan: a later publish says what is added, changed, removed and the same, each in order', async () => {
  const mem = await published(site({ 'index.html': 'v1', 'z.html': 'z', 'same.html': 's', 'a-changed.html': 'old', 'b-gone.html': 'x', 'a-gone.html': 'y' }));
  const { plan, before } = await planDeploy(mem, site({ 'index.html': 'v1', 'z.html': 'z', 'same.html': 's', 'a-changed.html': 'new!', 'c-new.html': '12345', 'b-new.html': '1' }));
  assert.deepEqual(plan, { added: ['b-new.html', 'c-new.html'], changed: ['a-changed.html'], removed: ['a-gone.html', 'b-gone.html'], same: 3, bytes: 4 + 5 + 1, first: false });
  assert.deepEqual(Object.keys(before!.files).sort(), ['a-changed.html', 'a-gone.html', 'b-gone.html', 'index.html', 'same.html', 'z.html']);
});

test('plan: a file marked with an empty hash in the manifest is always changed', async () => {
  const files = site({ 'a.html': 'a', 'b.html': 'b' });
  const mem = new MemoryStore();
  mem.objects.set(MANIFEST, { data: enc.encode(JSON.stringify({ version: 1, files: { 'a.html': '', 'b.html': await sha256Hex(enc.encode('b')) } })), modified: 0 });
  const { plan } = await planDeploy(mem, files);
  assert.deepEqual([plan.added, plan.changed, plan.removed, plan.same, plan.first], [[], ['a.html'], [], 1, false]);
});

test('plan: writes nothing, and works on a store that cannot be written to', async () => {
  const mem = await published(site({ 'index.html': 'v1', 'gone.html': 'x' }));
  const before = snapshot(mem);
  const files = site({ 'index.html': 'v2', 'new.html': 'n' });
  const open = await planDeploy(mem, files);
  const readOnly = await planDeploy(readOnlyStore(mem), files);
  assert.deepEqual(readOnly.plan, open.plan);
  assert.equal(snapshot(mem), before);
  const w = watch(mem);
  await planDeploy(w.store, files);
  assert.equal(w.calls.length, 0);
});

// deploy.

test('deploy: a first publish puts every file with its type, then a manifest that names exactly them', async () => {
  const files = site({ 'index.html': '<h1>Home</h1>', 'notes/a.html': '<p>a</p>', 'assets/a.css': 'body{}' });
  const mem = new MemoryStore();
  const planned = await publish(mem, files);
  assert.equal(planned.plan.first, true);
  await assertPublished(mem, files);
  assert.equal(mem.objects.get('notes/a.html')!.type, HTML);
  assert.equal(mem.objects.get('assets/a.css')!.type, 'text/css');
  const listed = Object.keys(storedManifest(mem).files);
  assert.deepEqual(listed, [...listed].sort(), 'the manifest lists its files in order');
  const again = await planDeploy(mem, files);
  assert.deepEqual([again.plan.added, again.plan.changed, again.plan.removed, again.plan.same, again.plan.first], [[], [], [], 3, false]);
});

test('deploy: the manifest is the same bytes however the site was reached', async () => {
  const files = site({ 'b.html': 'b', 'a.html': 'a' });
  const direct = await published(files);
  const viaUpdate = await published(site({ 'a.html': 'old', 'gone.html': 'g' }));
  await publish(viaUpdate, files);
  assert.deepEqual(direct.objects.get(MANIFEST)!.data, viaUpdate.objects.get(MANIFEST)!.data);
});

test('deploy: a second publish makes exactly the changes the plan names, and the front page goes up last', async () => {
  const mem = await published(site({ 'index.html': 'v1', 'a.html': 'old', 'same.html': 's', 'gone.html': 'g' }));
  const after = site({ 'index.html': 'v2', 'a.html': 'new', 'same.html': 's', 'new.html': 'n' });
  const w = watch(mem);
  await publish(w.store, after);
  await assertPublished(mem, after);

  const puts = w.calls.filter((c) => c.op === 'put' && c.key !== MANIFEST).map((c) => c.key);
  assert.equal(puts.at(-1), 'index.html');
  assert.deepEqual(puts.slice(0, -1).sort(), ['a.html', 'new.html']);
  assert.deepEqual(w.calls.filter((c) => c.op === 'delete').map((c) => c.key), ['gone.html']);
  assert.equal(w.calls.length, 1 + 3 + 1 + 1);
  assert.equal(w.calls[0].key, MANIFEST);
  assert.equal(w.calls.at(-1)!.key, MANIFEST);
  assert.deepEqual(w.calls.filter((c) => c.op === 'put' && c.key !== MANIFEST).map((c) => c.type), [HTML, HTML, HTML]);
  assert.deepEqual(w.calls.filter((c) => c.key === MANIFEST).map((c) => c.type), ['application/json', 'application/json']);

  // Every other upload has finished before the front page starts, and the deletion comes after it.
  const at = (event: string) => w.events.indexOf(event);
  for (const key of ['a.html', 'new.html']) assert.ok(at(`end put ${key}`) < at('start put index.html'), key);
  assert.ok(at('end put index.html') < at('start delete gone.html'));
});

test('deploy: before anything is written the manifest names the new files, and marks the ones it is about to change', async () => {
  const mem = await published(site({ 'index.html': 'v1', 'a.html': 'old', 'same.html': 's', 'gone.html': 'g' }));
  const hash = (text: string) => sha256Hex(enc.encode(text));
  const w = watch(mem);
  await publish(w.store, site({ 'index.html': 'v2', 'a.html': 'new', 'same.html': 's', 'new.html': 'n' }));
  const interim = JSON.parse(dec(w.calls[0].data!)) as Manifest;
  assert.deepEqual(interim, { version: 1, files: { 'a.html': '', 'gone.html': await hash('g'), 'index.html': '', 'new.html': '', 'same.html': await hash('s') } });
});

test('deploy: a change that only replaces files still marks them in the manifest first', async () => {
  const mem = await published(site({ 'index.html': 'v1', 'a.html': 'old' }));
  const w = watch(mem);
  await publish(w.store, site({ 'index.html': 'v1', 'a.html': 'new' }));
  assert.deepEqual(w.calls.map((c) => `${c.op} ${c.key}`), [`put ${MANIFEST}`, 'put a.html', `put ${MANIFEST}`]);
  assert.equal(JSON.parse(dec(w.calls[0].data!)).files['a.html'], '');
});

test('deploy: a change that only removes files writes the manifest after the deletions', async () => {
  const mem = await published(site({ 'index.html': 'v1', 'a.html': 'a', 'b.html': 'b' }));
  const w = watch(mem);
  await publish(w.store, site({ 'index.html': 'v1' }));
  assert.deepEqual(w.calls.map((c) => `${c.op} ${c.key}`), ['delete a.html', 'delete b.html', `put ${MANIFEST}`]);
  await assertPublished(mem, site({ 'index.html': 'v1' }));
});

test('deploy: nothing changed, nothing written', async () => {
  const files = site({ 'index.html': 'v1', 'a.html': 'a' });
  const mem = await published(files);
  const before = snapshot(mem);
  const w = watch(mem);
  const progress: number[] = [];
  const planned = await planDeploy(w.store, files);
  await deploy(w.store, files, planned, { onProgress: (done) => progress.push(done) });
  assert.equal(w.calls.length, 0);
  assert.deepEqual(progress, []);
  assert.equal(snapshot(mem), before);
});

test('deploy: an empty site still leaves a manifest the first time, and a site emptied out leaves an empty one', async () => {
  const mem = new MemoryStore();
  await publish(mem, site({}));
  await assertPublished(mem, site({}));
  const full = site({ 'index.html': 'x', 'a.html': 'a' });
  await publish(mem, full);
  await assertPublished(mem, full);
  await publish(mem, site({}));
  await assertPublished(mem, site({}));
  const w = watch(mem);
  await publish(w.store, site({}));
  assert.equal(w.calls.length, 0);
});

test('deploy: a site without a front page publishes', async () => {
  const files = site({ 'a.html': 'a', 'b.html': 'b' });
  const mem = await published(files);
  await assertPublished(mem, files);
});


test('deploy: a page that is back to what it was before a cut-short publish is uploaded again', async () => {
  const v1 = site({ 'index.html': 'i', 'a.html': 'v1' });
  const v2 = site({ 'index.html': 'i', 'a.html': 'v2' });
  const mem = await published(v1);
  const cut = watch(mem, { when: (call) => call.key === 'a.html', landed: true });
  await assert.rejects(publish(cut.store, v2), /the reply was lost/);
  assert.equal(dec(mem.objects.get('a.html')!.data), 'v2');
  assertTracked(mem);

  const { plan } = await planDeploy(mem, v1);
  assert.deepEqual(plan.changed, ['a.html']);
  await publish(mem, v1);
  await assertPublished(mem, v1);
});

test('deploy: a failure is the store\'s own error, and leaves the manifest that was written before the uploads', async () => {
  const files = site({ 'index.html': 'i', 'a.html': 'a', 'b.html': 'b' });
  const mem = new MemoryStore();
  const w = watch(mem, { when: (call) => call.key === 'b.html', landed: false });
  await assert.rejects(publish(w.store, files), { message: 'the write failed' });
  assert.equal(w.inFlight, 0);
  assert.deepEqual(storedManifest(mem), { version: 1, files: { 'a.html': '', 'b.html': '', 'index.html': '' } });
  assert.ok(!mem.objects.has('index.html'), 'the front page was not put up ahead of the rest');
  assert.ok(!w.calls.some((c) => c.key === 'index.html'));
});

test('deploy: a removed file whose deletion failed is deleted by the next run', async () => {
  const mem = await published(site({ 'index.html': 'i', 'a.html': 'a', 'gone.html': 'g' }));
  const after = site({ 'index.html': 'i', 'a.html': 'a2' });
  const w = watch(mem, { when: (call) => call.op === 'delete', landed: false });
  await assert.rejects(publish(w.store, after), { message: 'the write failed' });
  assert.ok(mem.objects.has('gone.html'));
  assertTracked(mem);
  assert.ok(Object.hasOwn(storedManifest(mem).files, 'gone.html'));

  const retry = await planDeploy(mem, after);
  assert.deepEqual(retry.plan.removed, ['gone.html']);
  await deploy(mem, after, retry);
  assert.ok(!mem.objects.has('gone.html'));
  await assertPublished(mem, after);
});

/**
 * Runs the publish of `to` over a store that holds `from` (or nothing), failing the nth write for every n a clean run makes,
 * both when the write fails and when it lands and its reply is lost. After each: nothing is in storage that the manifest in
 * storage does not name, nothing is still being written, and an ordinary run afterwards leaves exactly the site.
 */
async function cutShortEverywhere(from: Map<string, SiteFile> | undefined, to: Map<string, SiteFile>, concurrency: number): Promise<number> {
  const probe = watch(await published(from));
  await publish(probe.store, to, { concurrency });
  const writes = probe.calls.length;
  for (let on = 1; on <= writes; on++) {
    for (const landed of [false, true]) {
      const label = `write ${on} of ${writes}, ${landed ? 'landed' : 'not landed'}, concurrency ${concurrency}`;
      const mem = await published(from);
      const w = watch(mem, { when: (_, n) => n === on, landed });
      await assert.rejects(publish(w.store, to, { concurrency }), /the (write failed|reply was lost)/, label);
      assert.equal(w.inFlight, 0, label);
      const settled = snapshot(mem);
      assertTracked(mem);
      await tick();
      await tick();
      assert.equal(snapshot(mem), settled, `${label}: something was still being written`);
      await publish(mem, to, { concurrency });
      await assertPublished(mem, to);
    }
  }
  return writes;
}

test('deploy: a first publish cut short at any write never leaves a file the manifest does not name, and the next run finishes it', async () => {
  const to = site({ 'index.html': 'home', 'notes/a.html': 'a', 'notes/b.html': 'b', 'assets/style.css': 'css', 'assets/logo.png': 'png' });
  for (const concurrency of [1, 3]) assert.equal(await cutShortEverywhere(undefined, to, concurrency), 1 + 5 + 1);
});

test('deploy: an update that adds, changes and removes, cut short at any write, never loses track of a file', async () => {
  const from = site({ 'index.html': 'v1', 'notes/same.html': 's', 'notes/change.html': 'old', 'notes/gone.html': 'g', 'notes/gone2.html': 'g2', 'style.css': 'css' });
  const to = site({ 'index.html': 'v2', 'notes/same.html': 's', 'notes/change.html': 'new', 'notes/new.html': 'n', 'notes/new2.html': 'n2', 'style.css': 'css' });
  // The manifest twice, the front page and three other uploads, two deletions.
  for (const concurrency of [1, 3]) assert.equal(await cutShortEverywhere(from, to, concurrency), 2 + 4 + 2);
});

test('deploy: an update that only removes files, cut short at any write', async () => {
  const from = site({ 'index.html': 'i', 'a.html': 'a', 'b.html': 'b', 'c.html': 'c' });
  const to = site({ 'index.html': 'i' });
  assert.equal(await cutShortEverywhere(from, to, 2), 3 + 1);
});

test('deploy: a reply lost after a file landed is retried by the store, and an outage after it leaves a state the next run finishes', async () => {
  const files = site({ 'index.html': 'i', 'a.html': 'a', 'b.html': 'b' });
  const mem = new MemoryStore();
  const net = lossy(mem);
  net.lose((key) => key === 'b.html');
  await publish(net.store, files);
  assert.equal(net.armed, false);
  await assertPublished(mem, files);

  const down = new MemoryStore();
  const outage = lossy(down);
  outage.lose((key) => key === 'b.html', 'writes');
  await assert.rejects(publish(outage.store, files), /the network is down/);
  assert.ok(down.objects.has('b.html'));
  assertTracked(down);
  outage.online();
  await publish(outage.store, files);
  await assertPublished(down, files);
});

test('deploy: no more uploads and deletions run at once than the option allows, 4 when it is not given', async () => {
  const pages = (n: number, prefix: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}.html`, `page ${i}`]));
  const first = site({ 'index.html': 'i', ...pages(12, 'p') });
  const second = site({ 'index.html': 'i', ...pages(2, 'q') });
  for (const [concurrency, peak] of [[1, 1], [2, 2], [3, 3], [undefined, 4], [0, 1]] as const) {
    const up = watch(new MemoryStore());
    await publish(up.store, first, { concurrency });
    assert.equal(up.peak, peak, `uploads at ${concurrency}`);

    const mem = await published(first);
    const down = watch(mem);
    await publish(down.store, second, { concurrency });
    assert.equal(down.peak, peak, `deletions at ${concurrency}`);
    await assertPublished(mem, second);
  }
});

test('deploy: progress is reported after each upload and deletion, out of all of them, and not for the manifest', async () => {
  const mem = await published(site({ 'index.html': 'v1', 'a.html': 'old', 'same.html': 's', 'gone.html': 'g', 'gone2.html': 'g' }));
  const seen: Array<[number, number]> = [];
  const files = site({ 'index.html': 'v2', 'a.html': 'new', 'same.html': 's', 'new.html': 'n' });
  const w = watch(mem);
  await publish(w.store, files, { onProgress: (done, total) => seen.push([done, total]) });
  assert.deepEqual(seen, [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);

  const first: Array<[number, number]> = [];
  await publish(new MemoryStore(), site({ 'index.html': 'i', 'a.html': 'a' }), { onProgress: (done, total) => first.push([done, total]) });
  assert.deepEqual(first, [[1, 2], [2, 2]]);
});
