import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WrongPassphraseError } from '../src/core/crypto.ts';
import { SafetyError, type SyncResult } from '../src/core/engine.ts';
import { describeFailure, plural, resultProblems, staleProblem, summarize } from '../src/plugin/status.ts';

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflictCopies: [], skipped: 0, tooLarge: [], errors: [], commits: 0, rounds: 1, ...over,
});

test('summaries count in words that read right for one', () => {
  assert.equal(summarize(result()), 'everything is up to date');
  assert.equal(summarize(result({ pushed: 2, pulled: 1, conflictCopies: ['a'] })), '2 sent, 1 received, 1 conflict copy');
  assert.equal(summarize(result({ conflictCopies: ['a', 'b'], errors: [{ path: 'x', message: 'y' }] })), '2 conflict copies, 1 failed');
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(1200, 'file'), '1,200 files');
});

test('failures are described by what the user can do about them', () => {
  const kind = (e: unknown) => {
    const p = describeFailure(e);
    return [p.id.split(':')[0], p.severity, p.action ?? null];
  };
  assert.deepEqual(kind(new WrongPassphraseError()), ['passphrase', 'critical', 'passphrase']);
  assert.deepEqual(kind(new SafetyError(0, 106)), ['deletes', 'critical', 'resolve-deletes']);
  assert.match(describeFailure(new SafetyError(3, 106)).detail, /3 files on this device and 106 files from storage/);
  assert.deepEqual(kind(new Error('S3 PUT log/00000000000000000123 failed with HTTP 403 (AccessDenied)')), ['access', 'critical', 'settings']);
  assert.deepEqual(kind(new Error('WebDAV refused the login or the folder (HTTP 401)')), ['access', 'critical', 'settings']);
  assert.deepEqual(kind(new Error('S3 list failed with HTTP 404 (NoSuchBucket)')), ['bucket', 'critical', 'settings']);
  assert.deepEqual(kind(new Error('Remote data failed authentication (x:pack/1): corrupted or tampered with')), ['damaged', 'critical', null]);
  assert.deepEqual(kind(new Error('Remote pack abc is missing')), ['damaged', 'critical', null]);
  assert.deepEqual(kind(new Error('fetch failed')), ['offline', 'warning', 'retry']);
  assert.deepEqual(kind(new Error('Request failed. The Internet connection appears to be offline.')), ['offline', 'warning', 'retry']);
  assert.deepEqual(kind(new Error('S3 GET x failed with HTTP 503')), ['offline', 'warning', 'retry']);
  assert.deepEqual(kind(new Error('net::ERR_NAME_NOT_RESOLVED')), ['offline', 'warning', 'retry']);
  assert.deepEqual(kind(new Error('Request failed. A server with the specified hostname could not be found.')), ['offline', 'warning', 'retry']);
  assert.match(describeFailure(new SafetyError(0, 25)).detail, /^This sync would delete 25 files from storage\./);
  assert.deepEqual(kind(new Error('Remote vault uses format 3; this version reads format 2')), ['format', 'critical', null]);
  assert.deepEqual(kind(new Error('something odd')), ['failed', 'critical', 'retry']);
});

test('failed, conflicting and oversized files each become one problem, keyed by the files involved', () => {
  const r = result({ errors: [{ path: 'a.md', message: 'EACCES' }], tooLarge: ['v.mov'] });
  const ps = resultProblems(r, ['n (conflict phone 20261111-1200).md'], 200);
  assert.deepEqual(ps.map((p) => [p.id, p.severity, p.title]), [
    ['failed-files:a.md', 'critical', '1 file could not sync'],
    ['conflicts:n (conflict phone 20261111-1200).md', 'warning', '1 file changed on two devices'],
    ['too-large:v.mov', 'warning', '1 file too large to sync here'],
  ]);
  assert.match(ps[2].detail, /200 MB/);
  assert.deepEqual(resultProblems(result(), [], 200), []);
});

test('a day without a successful sync is a problem; never having synced is not this one', () => {
  const now = 1_800_000_000_000;
  assert.equal(staleProblem(0, now), undefined);
  assert.equal(staleProblem(now - 3_600_000, now), undefined);
  assert.equal(staleProblem(now - 2 * 86_400_000, now)?.severity, 'critical');
});
