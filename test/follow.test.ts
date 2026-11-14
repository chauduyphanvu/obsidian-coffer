import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadOnlyError, type RemoteStore } from '../src/core/types.ts';
import { FollowStore } from '../src/stores/follow.ts';
import type { Http, HttpRequest } from '../src/stores/http.ts';
import { openRemote } from '../src/stores/open.ts';

const BASE = 'https://files.example.com/family';

/** Serves `files` by URL, honouring `Range` unless `ignoreRange`, and records every request. */
function fakeHttp(files: Record<string, Uint8Array>, opts: { ignoreRange?: boolean; status?: number } = {}) {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    if (opts.status) return { status: opts.status, body: new Uint8Array(0) };
    const body = files[req.url];
    if (!body) return { status: 404, body: new TextEncoder().encode('<Error>not found</Error>') };
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!m || opts.ignoreRange) return { status: 200, body };
    if (Number(m[1]) >= body.length) return { status: 416, body: new Uint8Array(0) };
    return { status: 206, body: body.subarray(Number(m[1]), Number(m[2]) + 1) };
  };
  return { http, seen };
}

const bytes = (...n: number[]) => Uint8Array.from(n);
const noList = (s: RemoteStore) => (s as RemoteStore & { noList?: boolean }).noList;

test('follow: a public object is read with a plain GET and no credentials', async () => {
  const { http, seen } = fakeHttp({ [`${BASE}/vault.json`]: bytes(1, 2, 3) });
  const store = new FollowStore({ url: BASE }, http);
  assert.deepEqual(await store.get('vault.json'), bytes(1, 2, 3));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, `${BASE}/vault.json`);
  assert.deepEqual(seen[0].headers, {});
  assert.equal(seen[0].body, undefined);
  assert.equal(noList(store), true);
});

test('follow: a missing object and a non-public one both read as absent', async () => {
  const { http } = fakeHttp({});
  assert.equal(await new FollowStore({ url: BASE }, http).get('log/0000000001'), null);
  assert.equal(await new FollowStore({ url: BASE }, fakeHttp({}, { status: 403 }).http).get('log/0000000001'), null);
});

test('follow: other failures throw, and only the transient ones are worth retrying', async () => {
  for (const status of [500, 502, 429]) {
    const err = await new FollowStore({ url: BASE }, fakeHttp({}, { status }).http).get('x').catch((e) => e);
    assert.match(err.message, new RegExp(`GET x failed with HTTP ${status}`));
    assert.equal(err.permanent, undefined);
  }
  for (const status of [401, 400, 301]) {
    const err = await new FollowStore({ url: BASE }, fakeHttp({}, { status }).http).get('x').catch((e) => e);
    assert.match(err.message, new RegExp(`GET x failed with HTTP ${status}`));
    assert.equal(err.permanent, true);
  }
});

test('follow: ranges ask for the bytes before `end`, and work when the server ignores them', async () => {
  const files = { [`${BASE}/pack/p1`]: bytes(10, 11, 12, 13, 14, 15) };
  const { http, seen } = fakeHttp(files);
  const store = new FollowStore({ url: BASE }, http);
  assert.deepEqual(await store.get('pack/p1', { start: 1, end: 4 }), bytes(11, 12, 13));
  assert.equal(seen[0].headers.range, 'bytes=1-3');
  // Past the end of the object.
  assert.deepEqual(await store.get('pack/p1', { start: 9, end: 12 }), bytes());
  // An empty range needs no request.
  assert.deepEqual(await store.get('pack/p1', { start: 2, end: 2 }), bytes());
  assert.equal(seen.length, 2);

  const plain = fakeHttp(files, { ignoreRange: true });
  assert.deepEqual(await new FollowStore({ url: BASE }, plain.http).get('pack/p1', { start: 2, end: 5 }), bytes(12, 13, 14));
  assert.equal(await store.get('pack/none', { start: 0, end: 4 }), null);
});

test('follow: writes are refused before anything is sent', async () => {
  const { http, seen } = fakeHttp({});
  const store = new FollowStore({ url: BASE }, http);
  await assert.rejects(store.put('log/0000000001', bytes(1)), ReadOnlyError);
  await assert.rejects(store.put('log/0000000001', bytes(1), { ifNoneMatch: true }), ReadOnlyError);
  await assert.rejects(store.delete('log/0000000001'), ReadOnlyError);
  assert.equal(seen.length, 0);
});

test('follow: listing is refused with a clear, final error', async () => {
  const { http, seen } = fakeHttp({});
  const err = await new FollowStore({ url: BASE }, http).list('log/').catch((e) => e);
  assert.match(err.message, /cannot be listed/);
  assert.equal(err.permanent, true);
  assert.equal(seen.length, 0);
});

test('follow: the base address joins with or without a trailing slash, and keys are encoded like S3 keys', async () => {
  const cases: [string, string][] = [
    ['https://files.example.com/family', 'https://files.example.com/family/log/1'],
    ['https://files.example.com/family/', 'https://files.example.com/family/log/1'],
    ['https://files.example.com/family//', 'https://files.example.com/family/log/1'],
    ['https://files.example.com', 'https://files.example.com/log/1'],
    ['https://files.example.com/', 'https://files.example.com/log/1'],
    ['https://files.example.com/a/b c/', 'https://files.example.com/a/b%20c/log/1'],
    ['https://files.example.com/a%20b/', 'https://files.example.com/a%20b/log/1'],
    ['https://files.example.com/family?x=1#top', 'https://files.example.com/family/log/1'],
    ['http://localhost:8080/f', 'http://localhost:8080/f/log/1'],
  ];
  for (const [base, expected] of cases) {
    const { http, seen } = fakeHttp({});
    await new FollowStore({ url: base }, http).get('log/1');
    assert.equal(seen[0].url, expected, base);
  }

  const { http, seen } = fakeHttp({});
  await new FollowStore({ url: BASE }, http).get("pack/my note (1)*!'é.md");
  assert.equal(seen[0].url, `${BASE}/pack/my%20note%20%281%29%2A%21%27%C3%A9.md`);
});

test('follow: an address that is not a web address is refused', () => {
  assert.throws(() => new FollowStore({ url: 'not a url' }));
  assert.throws(() => new FollowStore({ url: 'file:///etc' }), /must start with https/);
  assert.throws(() => new FollowStore({ url: 'ftp://files.example.com/x' }), /must start with https/);
});

test('follow: openRemote keeps the no-listing flag, retries reads, and does not retry refused writes', async () => {
  let calls = 0;
  const http: Http = async () => (++calls === 1 ? { status: 503, body: new Uint8Array(0) } : { status: 200, body: bytes(7) });
  const store = openRemote({ type: 'follow', url: BASE }, http);
  assert.equal(noList(store), true);
  assert.deepEqual(await store.get('vault.json'), bytes(7));
  assert.equal(calls, 2);

  const before = Date.now();
  await assert.rejects(store.put('x', bytes(1)), ReadOnlyError);
  await assert.rejects(store.delete('x'), ReadOnlyError);
  await assert.rejects(store.list('log/'), /cannot be listed/);
  assert.ok(Date.now() - before < 200, 'refusals are not retried with backoff');
  assert.equal(calls, 2);

  const webdav = openRemote({ type: 'webdav', url: 'https://dav.example.com/x', username: 'u', password: 'p' }, http);
  assert.equal(noList(webdav), undefined);
});
