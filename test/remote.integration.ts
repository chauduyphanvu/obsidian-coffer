// Runs a real storage client against a real server, with real files on disk.
//   S3_ENDPOINT=http://127.0.0.1:9100 S3_ACCESS_KEY=... S3_SECRET_KEY=... node test/remote.integration.ts
//   WEBDAV_URL=http://127.0.0.1:9200 WEBDAV_USER=... WEBDAV_PASSWORD=... node test/remote.integration.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../src/core/config.ts';
import { SyncEngine } from '../src/core/engine.ts';
import { FileState, NodeFS } from '../src/node/nodefs.ts';
import { checkStore } from '../src/stores/doctor.ts';
import { withRetry } from '../src/stores/retry.ts';
import { fetchHttp } from '../src/stores/http.ts';
import { S3Store } from '../src/stores/s3.ts';
import { sha256Hex, sign } from '../src/stores/sigv4.ts';
import { WebDavStore } from '../src/stores/webdav.ts';

let requests = 0;
const http: typeof fetchHttp = (req) => {
  requests++;
  return fetchHttp(req);
};

async function s3Store() {
  const endpoint = process.env.S3_ENDPOINT!;
  const accessKey = process.env.S3_ACCESS_KEY!;
  const secretKey = process.env.S3_SECRET_KEY!;
  const region = process.env.S3_REGION ?? 'us-east-1';
  const bucket = process.env.S3_BUCKET ?? `selfsync-test-${Date.now()}`;
  if (!process.env.S3_BUCKET) {
    const headers = await sign({
      method: 'PUT', host: new URL(endpoint).host, path: `/${bucket}`, query: {}, headers: {},
      payloadHash: await sha256Hex(new Uint8Array(0)), region, accessKey, secretKey, date: new Date(),
    });
    const res = await fetchHttp({ method: 'PUT', url: `${endpoint}/${bucket}`, headers });
    assert.equal(res.status, 200, `create bucket: ${new TextDecoder().decode(res.body)}`);
  }
  return new S3Store({ endpoint, region, bucket, prefix: 'my vault/nested', accessKey, secretKey, pathStyle: true }, http);
}

const store = withRetry(
  process.env.WEBDAV_URL
    ? new WebDavStore({ url: `${process.env.WEBDAV_URL}/vault ${Date.now()}/nested`, username: process.env.WEBDAV_USER!, password: process.env.WEBDAV_PASSWORD! }, http)
    : await s3Store(),
);

const report = await checkStore(store);
for (const c of report.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
assert.ok(report.ok, 'storage check failed');

const root = await mkdtemp(join(tmpdir(), 'selfsync-'));
const device = (name: string) => {
  const dir = join(root, name);
  // Every note in its own object, so listing has to page through more than 1,000 keys.
  const config = resolveConfig({ deviceName: name, kdfIterations: 1000, packMaxBlobBytes: 0, snapshotEvery: 3 });
  const engine = new SyncEngine({ fs: new NodeFS(dir), store, stateStore: new FileState(join(dir, '.self-sync/state.json')), passphrase: 'integration', config });
  return { dir, engine, fs: new NodeFS(dir) };
};
const a = device('a');
const b = device('b');
const listing = async (d: { fs: NodeFS }) =>
  Object.fromEntries(await Promise.all((await d.fs.list()).filter((f) => !f.path.startsWith('.self-sync')).sort((x, y) => (x.path < y.path ? -1 : 1)).map(async (f) => [f.path.normalize('NFC'), await sha256Hex(await d.fs.read(f.path))])));

await mkdir(join(a.dir, 'Ghi chú/sub'), { recursive: true });
await mkdir(b.dir);
for (let i = 0; i < 1100; i++) await writeFile(join(a.dir, i % 2 ? 'Ghi chú' : 'Ghi chú/sub', `note ${i}.md`), `# Note ${i}\n\n${'lorem ipsum '.repeat(i % 40)}\n`);
const big = crypto.getRandomValues(new Uint8Array(65536));
const video = new Uint8Array(9_000_000);
for (let i = 0; i < video.length; i += 65536) video.set(big.subarray(0, Math.min(65536, video.length - i)).map((x) => x ^ (i >> 16)), i);
await writeFile(join(a.dir, 'clip & "odd" name+(1).bin'), video);

let t = performance.now();
let r = await a.engine.sync();
console.log(`upload: ${r.pushed} files, ${requests} requests, ${Math.round(performance.now() - t)} ms`);
assert.equal(r.pushed, 1101);
assert.deepEqual(r.errors, []);

requests = 0;
t = performance.now();
r = await b.engine.sync();
console.log(`download: ${r.pulled} files, ${requests} requests, ${Math.round(performance.now() - t)} ms`);
assert.equal(r.pulled, 1101);
assert.deepEqual(await listing(b), await listing(a));

await writeFile(join(a.dir, 'Ghi chú/note 1.md'), '# Note 1\n\nedited on a\n\nlorem ipsum \n');
await writeFile(join(b.dir, 'Ghi chú/note 1.md'), '# Note 1\n\nlorem ipsum \n\nedited on b\n');
await rename(join(a.dir, 'Ghi chú/sub'), join(a.dir, 'moved'));
const edited = Buffer.concat([video.subarray(0, 4_000_000), Buffer.from('inserted'), video.subarray(4_000_000)]);
await writeFile(join(b.dir, 'clip & "odd" name+(1).bin'), edited);

requests = 0;
[r] = await Promise.all([a.engine.sync(), b.engine.sync()]);
for (let i = 0; i < 2; i++) for (const d of [a, b]) await d.engine.sync();
console.log(`concurrent edits, move of 550 files, large-file edit: ${requests} requests`);
assert.deepEqual(await listing(b), await listing(a));
assert.equal(await readFile(join(a.dir, 'Ghi chú/note 1.md'), 'utf8'), '# Note 1\n\nedited on a\n\nlorem ipsum \n\nedited on b\n');
assert.ok(Buffer.compare(await readFile(join(a.dir, 'clip & "odd" name+(1).bin')), edited) === 0);
assert.equal(Object.keys(await listing(a)).length, 1101);

requests = 0;
await a.engine.sync();
assert.equal(requests, 2, 'idle sync');
const versions = await a.engine.history('Ghi chú/note 1.md');
assert.ok(versions.length >= 2, 'history');
const gc = await a.engine.gc();
console.log(`history: ${versions.length} versions; clean-up examined all packs, removed ${gc.packsDeleted} (all are recent)`);
assert.equal(gc.packsDeleted, 0);
assert.ok((await store.list('pack/')).length > 1000, 'listing pages past 1,000 keys');

await rm(root, { recursive: true });
console.log('integration: all checks passed');
