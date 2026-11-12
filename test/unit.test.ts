import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutPoints } from '../src/core/chunker.ts';
import { compileExcludes } from '../src/core/config.ts';
import { chunkId, createKeys, open, seal, unlockKeys, WrongPassphraseError } from '../src/core/crypto.ts';
import { merge3, mergeJson } from '../src/core/merge.ts';
import { conflictCopyName, conflictOriginal, ext, vaultKey } from '../src/core/paths.ts';
import { plural } from '../src/core/text.ts';
import { checkStore } from '../src/stores/doctor.ts';
import { uncachedHeaders } from '../src/stores/http.ts';
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

test('mergeJson: settings changed on two devices combine key by key; where both changed one, theirs wins', () => {
  const j = (v: unknown) => JSON.stringify(v, null, 2);
  const base = j({ theme: 'dark', spellcheck: true, hotkeys: { a: 1, b: 2 }, plugins: ['x', 'y'], gone: 1 });
  const ours = j({ theme: 'light', spellcheck: false, hotkeys: { a: 1, b: 3 }, plugins: ['x', 'y', 'mine'] });
  const theirs = j({ theme: 'moonstone', spellcheck: true, hotkeys: { a: 9, b: 2 }, plugins: ['y', 'theirs'], gone: 1, added: true });
  assert.deepEqual(JSON.parse(mergeJson(base, ours, theirs)!), {
    theme: 'moonstone', spellcheck: false, hotkeys: { a: 9, b: 3 }, plugins: ['y', 'theirs', 'mine'], added: true,
  });
  // No common version (two devices that set up their settings separately): every key from both, theirs where they differ.
  assert.deepEqual(JSON.parse(mergeJson(undefined, j({ a: 1, list: ['p'], same: 0 }), j({ a: 2, b: 3, list: ['q'], same: 0 }))!), { a: 2, b: 3, list: ['q', 'p'], same: 0 });
  // When the result equals one side, that side's bytes are kept as they are.
  assert.equal(mergeJson(base, base, '{"theme":"dark"}'), '{"theme":"dark"}');
  assert.equal(mergeJson(undefined, '{"x": 1}', '{ "x" : 1 }'), '{ "x" : 1 }');
  // Lists of objects are one value; a value type change is one value.
  assert.deepEqual(JSON.parse(mergeJson(j({ l: [{ k: 1 }] }), j({ l: [{ k: 2 }] }), j({ l: [{ k: 3 }] }))!), { l: [{ k: 3 }] });
  assert.deepEqual(JSON.parse(mergeJson(j({ v: 1 }), j({ v: { n: 1 } }), j({ v: 2 }))!), { v: 2 });
  // Unreadable JSON on either side is not merged; a damaged common version only loses the three-way view.
  assert.equal(mergeJson(base, '{', theirs), null);
  assert.equal(mergeJson(base, ours, 'not json'), null);
  assert.deepEqual(JSON.parse(mergeJson('{', j({ a: 1 }), j({ b: 2 }))!), { b: 2, a: 1 });
  // A key named like an object internal stays plain data.
  const proto = JSON.parse(mergeJson('{}', '{"__proto__": {"polluted": true}}', '{"x": 1}')!);
  assert.deepEqual(Object.keys(proto).sort(), ['__proto__', 'x']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
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

test('path rules: extensions, conflict copy names, Unicode forms', () => {
  assert.equal(ext('Notes/Photo.JPG'), 'jpg');
  assert.equal(ext('dir.v2/README'), '');
  assert.equal(ext('file.'), '');
  assert.equal(ext('.gitignore'), 'gitignore');
  const at = new Date(2026, 0, 2, 15, 4, 5);
  assert.equal(conflictCopyName('notes/a.md', 'B laptop/1', at), 'notes/a (conflict B_laptop_1 20260102-150405).md');
  assert.equal(conflictCopyName('notes/a.md', 'B', at, 2), 'notes/a (conflict B 20260102-150405 2).md');
  assert.equal(conflictCopyName('dir.v2/README', 'B', at), 'dir.v2/README (conflict B 20260102-150405)');
  assert.equal(vaultKey('Cafe\u0301.md'), 'Caf\u00e9.md');
});

test('reads neither store a response (iOS conditional deletes) nor answer from a stored one (desktop stale key header)', () => {
  assert.deepEqual(uncachedHeaders({ method: 'GET', url: 'https://s3/k', headers: { range: 'bytes=0-1' } }), { range: 'bytes=0-1', 'cache-control': 'no-store, no-cache' });
  assert.deepEqual(uncachedHeaders({ method: 'DELETE', url: 'https://s3/k', headers: { a: '1' } }), { a: '1' });
  assert.deepEqual(uncachedHeaders({ method: 'PUT', url: 'https://s3/k', headers: {} }), {});
});

test('a conflict copy leads back to the file it was made from', () => {
  const at = new Date(2026, 10, 11, 9, 5, 7);
  for (const key of ['a/b.md', 'Notes/no extension', 'x.y/z.tar.gz', 'Photo 02.png']) {
    assert.equal(conflictOriginal(conflictCopyName(key, 'my phone', at)), key);
    assert.equal(conflictOriginal(conflictCopyName(key, 'mobile-103c', at, 3)), key);
  }
  assert.equal(conflictOriginal('plain.md'), 'plain.md');
});

test('a count reads with its noun in the singular only for one', () => {
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(0, 'file'), '0 files');
  assert.equal(plural(2, 'conflict copy', 'conflict copies'), '2 conflict copies');
  assert.equal(plural(1204, 'change'), `${(1204).toLocaleString()} changes`);
});
