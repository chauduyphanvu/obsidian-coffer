import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutPoints } from '../src/core/chunker.ts';
import { compileExcludes } from '../src/core/config.ts';
import { chunkId, createKeys, open, seal, unlockKeys, WrongPassphraseError } from '../src/core/crypto.ts';
import { merge3 } from '../src/core/merge.ts';
import { checkStore } from '../src/stores/doctor.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { sign } from '../src/stores/sigv4.ts';
import { rng } from '../src/testing/netsim.ts';

const bytes = (n: number, seed: number) => {
  const r = rng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
};

test('crypto: round trip, wrong passphrase, tampering, wrong id', async () => {
  const { header, keys } = await createKeys('correct horse', 1000);
  const again = await unlockKeys(header, 'correct horse');
  const data = bytes(5000, 1);
  const sealed = await seal(keys, data, 'chunk-a', 1);
  const { plain, flag } = await open(again, sealed, 'chunk-a');
  assert.deepEqual(plain, data);
  assert.equal(flag, 1);
  assert.equal(await chunkId(keys, data), await chunkId(again, data));

  await assert.rejects(unlockKeys(header, 'wrong'), WrongPassphraseError);
  await assert.rejects(open(keys, sealed, 'chunk-b'), /authentication/);
  const flipped = sealed.slice();
  flipped[100] ^= 1;
  await assert.rejects(open(keys, flipped, 'chunk-a'), /authentication/);
  const reflagged = sealed.slice();
  reflagged[0] = 0;
  await assert.rejects(open(keys, reflagged, 'chunk-a'), /authentication/);

  const other = await createKeys('correct horse', 1000);
  assert.notEqual(await chunkId(other.keys, data), await chunkId(keys, data));
});

test('chunker: deterministic, bounded, and stable under an insertion', () => {
  const p = { min: 4096, avg: 16384, max: 65536 };
  const data = bytes(2_000_000, 2);
  const cuts = cutPoints(data, p);
  assert.deepEqual(cuts, cutPoints(data, p));
  assert.equal(cuts.at(-1), data.length);
  let prev = 0;
  for (const c of cuts.slice(0, -1)) {
    assert.ok(c - prev >= p.min && c - prev <= p.max, `chunk of ${c - prev}`);
    prev = c;
  }
  const avg = data.length / cuts.length;
  assert.ok(avg > p.avg / 2 && avg < p.avg * 2, `average chunk ${avg}`);

  const edited = new Uint8Array(data.length + 100);
  edited.set(data.subarray(0, 1_000_000));
  edited.set(bytes(100, 3), 1_000_000);
  edited.set(data.subarray(1_000_000), 1_000_100);
  const key = (d: Uint8Array, cs: number[]) => new Set(cs.map((end, i) => `${end - (i ? cs[i - 1] : 0)}:${d[end - 1]}:${d[i ? cs[i - 1] : 0]}`));
  const before = key(data, cuts);
  const after = key(edited, cutPoints(edited, p));
  const shared = [...after].filter((k) => before.has(k)).length;
  assert.ok(shared / after.size > 0.95, `only ${shared}/${after.size} chunks survived an insertion`);

  assert.deepEqual(cutPoints(new Uint8Array(0), p), []);
  assert.deepEqual(cutPoints(new Uint8Array(100), p), [100]);
});

test('merge3: independent edits combine, overlapping edits conflict', () => {
  const base = 'a\nb\nc\nd\ne\n';
  assert.equal(merge3(base, 'a\nB\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'), 'a\nB\nc\nd\nE\n');
  assert.equal(merge3(base, 'x\na\nb\nc\nd\ne\n', 'a\nb\nc\nd\ne\ny\n'), 'x\na\nb\nc\nd\ne\ny\n');
  assert.equal(merge3(base, 'a\nc\nd\ne\n', 'a\nb\nc\nd\ne\nf\n'), 'a\nc\nd\ne\nf\n');
  assert.equal(merge3(base, 'a\nB\nc\nd\ne\n', 'a\nB\nc\nd\ne\n'), 'a\nB\nc\nd\ne\n');
  assert.equal(merge3(base, 'a\nX\nc\nd\ne\n', 'a\nY\nc\nd\ne\n'), null);
  assert.equal(merge3(base, 'a\nb\nX\nc\nd\ne\n', 'a\nb\nY\nc\nd\ne\n'), null);
  assert.equal(merge3('', 'x\n', 'y\n'), null);
  assert.equal(merge3('a\n', '', 'a\nb\n'), null);
  assert.equal(merge3('one\ntwo', 'one\ntwo\nthree', 'zero\none\ntwo'), 'zero\none\ntwo\nthree');
});

test('merge3: fuzz against an independent oracle', () => {
  const r = rng(7);
  const pick = (n: number) => (r() * n) | 0;
  for (let iter = 0; iter < 3000; iter++) {
    const base = Array.from({ length: 5 + pick(40) }, (_, i) => `line ${i}`);
    // Each side edits its own half, so the correct merge is known by construction.
    const half = base.length >> 1;
    const edit = (lines: string[], tag: string) => {
      const out = [...lines];
      for (let n = pick(4); n > 0 && out.length; n--) {
        const at = pick(out.length);
        const kind = pick(3);
        if (kind === 0) out.splice(at, 0, `${tag} new ${iter}.${n}`);
        else if (kind === 1) out.splice(at, 1);
        else out[at] = `${tag} changed ${iter}.${n}`;
      }
      return out;
    };
    const keep = base[half];
    const left = edit(base.slice(0, half), 'A');
    const right = edit(base.slice(half + 1), 'B');
    const text = (ls: string[]) => ls.map((l) => `${l}\n`).join('');
    const ours = text([...left, keep, ...base.slice(half + 1)]);
    const theirs = text([...base.slice(0, half), keep, ...right]);
    const b = text(base);
    assert.equal(merge3(b, ours, theirs), text([...left, keep, ...right]), `iter ${iter}`);
    assert.equal(merge3(b, theirs, ours), text([...left, keep, ...right]), `iter ${iter} swapped`);
    assert.equal(merge3(b, ours, b), ours);
    assert.equal(merge3(b, ours, ours), ours);
  }
});

test('exclude patterns', () => {
  const ex = compileExcludes(['.obsidian/workspace*.json', '.trash/**', '.DS_Store', 'private/', '*.tmp']);
  for (const p of ['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.trash/a/b.md', '.DS_Store', 'a/b/.DS_Store', 'private/x/y.md', 'notes/x.tmp']) {
    assert.ok(ex(p), p);
  }
  for (const p of ['.obsidian/app.json', 'notes/workspace.json', 'trash/a.md', 'privateer/x.md', 'a.tmp.md']) {
    assert.ok(!ex(p), p);
  }
});

test('SigV4 matches the worked example in the AWS S3 documentation', async () => {
  const headers = await sign({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    query: {},
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('doctor passes on a conforming store and catches a store without create-if-absent', async () => {
  assert.ok((await checkStore(new MemoryStore())).ok);
  const broken = new MemoryStore();
  const put = broken.put.bind(broken);
  broken.put = (key, data) => put(key, data);
  const report = await checkStore(broken);
  assert.ok(!report.ok);
  assert.match(report.checks.find((c) => !c.ok)!.name, /overwrite/);
});

test('setup codes open only with the right passphrase', async () => {
  const { sealWithPassphrase, openWithPassphrase } = await import('../src/core/crypto.ts');
  const code = await sealWithPassphrase('{"bucket":"b","secret":"s3cr3t"}', 'pass', 1000);
  assert.ok(!code.includes('s3cr3t'));
  assert.equal(await openWithPassphrase(code, 'pass', 1000), '{"bucket":"b","secret":"s3cr3t"}');
  await assert.rejects(openWithPassphrase(code, 'nope', 1000), WrongPassphraseError);
  await assert.rejects(openWithPassphrase('not a code!', 'pass', 1000), /not a valid setup code/);
});
