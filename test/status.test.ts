import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WrongPassphraseError } from '../src/core/crypto.ts';
import { HistoryError, SafetyError, StorageGoneError, type SyncResult } from '../src/core/engine.ts';
import { MissingFolderError } from '../src/core/scopedfs.ts';
import { plural } from '../src/core/text.ts';
import { connectError, describeFailure, inShare, isConflictProblem, keptNote, keysMissingProblem, leftInStorage, lostProblems, missingProblem, passphraseFailure, quietText, resultProblems, RunProgress, staleProblem, statusText, summarize, targetProblems, type Problem } from '../src/plugin/status.ts';

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflictCopies: [], skipped: 0, tooLarge: [], deferred: [], unsent: [], arrived: [], errors: [], commits: 0, rounds: 1, ...over,
});

test('summaries count in words that read right for one', () => {
  assert.equal(summarize(result()), 'everything is up to date');
  assert.equal(summarize(result({ pushed: 2, pulled: 1, conflictCopies: ['a'] })), '2 sent, 1 received, 1 conflict copy');
  assert.equal(summarize(result({ conflictCopies: ['a', 'b'], errors: [{ path: 'x', message: 'y' }] })), '2 conflict copies, 1 failed');
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(1200, 'file'), '1,200 files');
});

test('a summary says how many files the sync left in storage, also when it did nothing else', () => {
  assert.equal(summarize(result({ deferred: ['a.mov'] })), 'everything is up to date · 1 file left in storage');
  assert.equal(summarize(result({ deferred: ['a.mov', 'b.mov'] })), 'everything is up to date · 2 files left in storage');
  assert.equal(summarize(result({ pulled: 3, deferred: ['a.mov', 'b.mov'] })), '3 received, 2 left in storage');
});

test('what a cleanup found missing from storage: the current version of a file is critical and offers a repair, an earlier version only is a warning', () => {
  assert.deepEqual(lostProblems({ current: [], earlier: [] }), []);
  const [one] = lostProblems({ current: ['Notes/a.md'], earlier: [] });
  assert.deepEqual([one.severity, one.title, one.action], ['critical', 'Data for 1 file is missing from storage', 'repair']);
  assert.equal(
    one.detail,
    'Storage no longer holds data that this file needs, so other devices cannot download it. Run Repair from a device that has it to store its data again.\nNotes/a.md',
  );

  const many = Array.from({ length: 12 }, (_, i) => `n${String(i).padStart(2, '0')}.md`);
  const [current, earlier] = lostProblems({ current: many, earlier: ['old.md', 'x.md'] });
  assert.equal(current.title, 'Data for 12 files is missing from storage');
  assert.match(current.detail, /^Storage no longer holds data that these files need, so other devices cannot download them\. Run Repair from a device that has them to store their data again\.\n/);
  assert.deepEqual(current.detail.split('\n').slice(1), [...many.slice(0, 10), 'and 2 more']);
  assert.deepEqual([earlier.severity, earlier.title, earlier.action], ['warning', 'Earlier versions of 2 files can no longer be restored', undefined]);
  assert.equal(earlier.detail, 'Storage no longer holds data that earlier versions of these files need. Their current versions are whole and sync as before.\nold.md\nx.md');
  assert.notEqual(lostProblems({ current: ['a.md'], earlier: [] })[0].id, lostProblems({ current: ['a.md', 'b.md'], earlier: [] })[0].id, 'more files missing is told anew');
});

test('storage that no longer holds the vault is told apart for the vault and for a shared folder, also as opening a shared folder with members finds it', () => {
  const vault = describeFailure(new StorageGoneError());
  assert.deepEqual([vault.id, vault.severity, vault.title, vault.action], ['storage-gone', 'critical', "The vault's storage is gone", undefined]);
  assert.match(vault.detail, /Do not set up sync again until you know why\. Your files on this device are untouched\.$/);
  const share = describeFailure(new StorageGoneError(), undefined, true);
  assert.deepEqual([share.id, share.severity, share.title, share.action], ['storage-gone', 'critical', "This shared folder's storage is gone", 'stop-sharing']);
  assert.match(share.detail, /its owner may have stopped sharing it, or the storage was emptied\. .*remove it under Shared folders\.$/);
  const opening = new StorageGoneError('The shared folder is missing from storage: its key file, vault.json, is gone');
  assert.deepEqual(describeFailure(opening, { owner: false, ownerName: 'Vu' }, true), share);
  assert.notEqual(describeFailure(new Error(opening.message), { owner: false, ownerName: 'Vu' }, true).id, 'storage-gone', 'told by its type, not its words');
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

test('a history in storage other than the one this device saw offers to carry on from it; other damage does not', () => {
  const kind = (e: Error) => {
    const p = describeFailure(e);
    return [p.id, p.action ?? null];
  };
  const forked = [
    'Remote commit 3, the newest this device has seen, is missing: the log was rolled back or tampered with',
    'Remote commit 3 is not the one this device saw: the log was tampered with or forked',
    'Remote commit 4 does not follow the commit before it as this device saw it: the log was tampered with or forked',
  ];
  for (const message of forked) {
    assert.deepEqual(kind(new HistoryError(message)), ['history', 'accept-storage'], message);
    assert.deepEqual(kind(new Error(message)), ['damaged', null], `told by its type, not its words: ${message}`);
  }
  const p = describeFailure(new HistoryError('Remote commit 3 is not the one this device saw: the log was tampered with or forked'));
  assert.match(p.detail, /restored from a backup/);
  assert.match(p.detail, /If nobody did that on purpose, leave sync stopped/);
  const kindOf = (message: string) => kind(new Error(message));
  for (const message of [
    'Remote log has a gap before commit 7',
    'Commit 7 is listed but cannot be read',
    'Remote commit 100 is missing, though a snapshot was taken at it',
    'Remote snapshot 100 was taken at a different commit 100 than storage holds: the log was tampered with or forked',
    'Remote pack abc is missing',
    'Remote data failed authentication (x:pack/1): corrupted or tampered with',
  ]) {
    assert.deepEqual(kindOf(message), ['damaged', null], message);
  }
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

test('a conflict in a shared folder is still a conflict, so the problem list offers to resolve it', () => {
  const [vault] = resultProblems(result(), ['n (conflict phone 20261111-1200).md'], 200);
  assert.ok(isConflictProblem(vault));
  assert.ok(isConflictProblem(inShare(vault, { id: 'w1', folder: 'Work' })));
  assert.ok(!isConflictProblem(inShare(describeFailure(new WrongPassphraseError()), { id: 'w1', folder: 'Work' })));
});

test('one file too large reads as one file', () => {
  assert.match(resultProblems(result({ tooLarge: ['v.mov'] }), [], 200)[0].detail, /so it is not synced/);
  assert.match(resultProblems(result({ tooLarge: ['v.mov', 'w.mov'] }), [], 200)[0].detail, /so they are not synced/);
});

test('a failed storage check says what to check in the words of that kind of storage, then its own words', () => {
  const refused = 'WebDAV refused the login or the folder (HTTP 401)';
  assert.match(connectError(refused, 'webdav'), /user name and password/);
  assert.doesNotMatch(connectError(refused, 'webdav'), /keys|bucket/);
  assert.ok(connectError(refused, 'webdav').endsWith(refused));
  assert.match(connectError('S3 GET failed with HTTP 403 AccessDenied', 's3'), /keys/);
  assert.match(connectError('net::ERR_CONNECTION_REFUSED', 'webdav'), /^Can't reach the storage/);
  assert.match(connectError('something odd', 's3'), /^Connecting failed\.\nsomething odd$/);
  // Keys checked for reading only are not asked to write.
  assert.match(connectError(refused, 'webdav', false), /may read this folder\./);
  assert.match(connectError('S3 GET failed with HTTP 403 AccessDenied', 's3', false), /may read this bucket\./);
});

test('refused keys of a member: they came from the owner, so the owner is who to ask; the owner and other places check their own', () => {
  const refused = new Error('WebDAV refused the login or the folder (HTTP 401)');
  const member = describeFailure(refused, { owner: false, ownerName: 'Ann' });
  assert.equal(member.id, 'access');
  assert.match(member.detail, /Ask Ann for a new invite/);
  assert.doesNotMatch(member.detail, /turn on Only receive changes/);
  assert.match(describeFailure(refused, { owner: false, ownerName: '' }).detail, /Ask the owner for a new invite/);
  assert.match(describeFailure(refused, { owner: true, ownerName: 'Ann' }).detail, /turn on Only receive changes/);
  assert.match(describeFailure(refused).detail, /turn on Only receive changes/);
});

test('a day without a successful sync is a problem; never having synced is not this one', () => {
  const now = 1_800_000_000_000;
  assert.equal(staleProblem(0, now), undefined);
  assert.equal(staleProblem(now - 3_600_000, now), undefined);
  assert.equal(staleProblem(now - 2 * 86_400_000, now)?.severity, 'critical');
});

test('a missing shared folder is a critical problem that offers to download it again or stop', () => {
  const p = describeFailure(new MissingFolderError('Projects/Team'));
  assert.deepEqual([p.id, p.severity, p.action], ['missing-folder', 'critical', 'missing-folder']);
  assert.match(p.detail, /“Projects\/Team”/);
  assert.match(p.detail, /Nothing was deleted for the others/);
  assert.deepEqual(missingProblem('Projects/Team'), p);
  assert.equal(keysMissingProblem({ role: '', memberKeysSecret: '' }).severity, 'critical');
});

test("a shared folder's problems say which folder, stay apart from the vault's, and keep what they act on", () => {
  const vault = describeFailure(new WrongPassphraseError());
  const p = inShare(vault, { id: 'w1', folder: 'Work' });
  assert.deepEqual([p.id, p.title, p.share, p.action, p.severity], ['share:w1:passphrase', 'Shared folder “Work”: Wrong passphrase', 'w1', 'passphrase', 'critical']);
  assert.notEqual(inShare(vault, { id: 'w2', folder: 'Other' }).id, p.id);
  assert.equal(vault.share, undefined);
  const conflicts = resultProblems(result(), ['Work/n (conflict phone 20261111-1200).md'], 200).map((x) => inShare(x, { id: 'w1', folder: 'Work' }));
  assert.deepEqual(conflicts[0].files, ['Work/n (conflict phone 20261111-1200).md']);
});

test('one place\'s problems: offline only once it lasts a day, and conflict copies as they are now', () => {
  const now = 1_800_000_000_000;
  const offline = describeFailure(new Error('fetch failed'));
  const found = resultProblems(result(), ['a (conflict x 20261111-1200).md'], 200);
  assert.deepEqual(targetProblems({ failure: offline, found: [], conflictCopies: [], lastSuccess: now - 3_600_000, readOnly: false }, now), []);
  assert.deepEqual(targetProblems({ failure: offline, found: [], conflictCopies: [], lastSuccess: now - 2 * 86_400_000, readOnly: false }, now).map((x) => x.id), ['stale']);
  assert.deepEqual(targetProblems({ found, conflictCopies: [], lastSuccess: now, readOnly: false }, now), [], 'resolved since the sync');
  const failure: Problem = describeFailure(new Error('odd'));
  assert.deepEqual(targetProblems({ failure, found, conflictCopies: ['a (conflict x 20261111-1200).md'], lastSuccess: now, readOnly: false }, now).map((x) => x.severity), ['critical', 'warning']);
});

test('a status line names the worst problem, or when it synced and how much is left to review', () => {
  const critical = describeFailure(new WrongPassphraseError());
  const warning = resultProblems(result({ tooLarge: ['v.mov'] }), [], 200);
  assert.deepEqual(statusText([critical], 0, false), { text: 'Wrong passphrase', tone: 'critical' });
  assert.deepEqual(statusText([critical, critical], 0, false), { text: '2 problems need attention', tone: 'critical' });
  assert.deepEqual(statusText(warning, 0, false), { text: 'Not synced yet · 1 thing to review', tone: 'warning' });
  assert.deepEqual(statusText([], 0, true), { text: 'Not synced yet · offline', tone: 'ok' });
  assert.match(statusText([], 1_800_000_000_000, false).text, /^Synced /);
});

test('offline is told beside whatever else is listed, not instead of it', () => {
  const warning = resultProblems(result({ tooLarge: ['v.mov'] }), [], 200);
  assert.deepEqual(statusText(warning, 0, true), { text: 'Not synced yet · offline · 1 thing to review', tone: 'warning' });
  const two = resultProblems(result({ tooLarge: ['v.mov'], unsent: ['a.md'] }), [], 200);
  assert.match(statusText(two, 1_800_000_000_000, true).text, /^Synced .* · offline · 2 things to review$/);
});

test('files changed here are a problem of the place only while it only receives', () => {
  const now = 1_800_000_000_000;
  const found = resultProblems(result({ unsent: ['a.md'], tooLarge: ['v.mov'] }), [], 200);
  const ids = (readOnly: boolean) => targetProblems({ found, conflictCopies: [], lastSuccess: now, readOnly }, now).map((p) => p.id.split(':')[0]);
  assert.deepEqual(ids(true), ['too-large', 'unsent']);
  assert.deepEqual(ids(false), ['too-large'], 'turned off since that sync: the next one sends them');
});

test('the problems screen does not call it in sync while offline or while changes wait', () => {
  assert.equal(quietText(false, false), 'Everything is in sync.');
  assert.equal(quietText(false, true), 'Changes made here are waiting to be sent.');
  for (const waiting of [false, true]) assert.match(quietText(true, waiting), /^Can't reach the storage, so changes made here are not sent/);
});

test('files left in storage are counted once every place has said, and not before', () => {
  assert.equal(leftInStorage([2, 0, 1]), '3 files left in storage');
  assert.equal(leftInStorage([1]), '1 file left in storage');
  assert.equal(leftInStorage([0]), '0 files left in storage');
  assert.equal(leftInStorage([2, undefined]), 'Files left in storage', 'a place that has not synced since the app started may hold more');
  assert.equal(leftInStorage([undefined]), 'Files left in storage');
});

test('keeping all files says how many come back and how many stay in storage over the download limit', () => {
  assert.equal(keptNote(42, 0), '42 files will be copied back.');
  assert.equal(keptNote(1, 0), '1 file will be copied back.');
  assert.equal(keptNote(42, 3), '39 files will be copied back. 3 files over the download limit stay in storage until you choose them.');
  assert.equal(keptNote(2, 1), '1 file will be copied back. 1 file over the download limit stays in storage until you choose it.');
  assert.equal(keptNote(3, 3), '3 files over the download limit stay in storage until you choose them.');
});

test('a run shows the vault, then how many shared folders are left, then the last one, without jumping between the ones that sync side by side', () => {
  const vault = { id: '' };
  const [a, b, c] = ['Family', 'Work', 'Club'].map((folder, i) => ({ id: `s${i}`, folder }));
  const run = new RunProgress();
  run.plan([vault, a, b, c]);
  assert.equal(run.line(), 'Syncing…');
  run.start(vault);
  run.say(vault, 'Receiving 40 of 249');
  assert.equal(run.line(), 'Receiving 40 of 249');
  assert.equal(run.stateOf(''), 'syncing');
  assert.equal(run.stateOf('s0'), 'waiting');
  run.say(a, 'Sending 1 of 4');
  assert.equal(run.line(), 'Receiving 40 of 249', 'a place that is not the vault says nothing on the line while the vault syncs');
  run.end(vault);
  assert.equal(run.line(), 'Syncing 3 shared folders…');
  run.start(a);
  run.start(b);
  run.say(b, 'Receiving 3 of 9');
  run.say(a, 'Sending 2 of 4');
  assert.equal(run.line(), 'Syncing 3 shared folders…', 'what each says does not change the line');
  assert.deepEqual([a, b, c].map((p) => run.stateOf(p.id)), ['syncing', 'syncing', 'waiting']);
  run.end(a);
  assert.equal(run.line(), 'Syncing 2 shared folders…');
  assert.equal(run.stateOf('s0'), undefined, 'a place that has ended is not busy');
  run.end(c);
  assert.equal(run.line(), '“Work”: Receiving 3 of 9', 'the last one left is followed by name');
  run.say(b, 'Receiving 4 of 9');
  assert.equal(run.line(), '“Work”: Receiving 4 of 9');
  run.end(b);
  assert.equal(run.line(), 'Syncing…');
});

test('a lone shared folder that has not said anything yet reads as syncing; one vault says only what it is doing', () => {
  const run = new RunProgress();
  const a = { id: 'x', folder: 'Family' };
  run.plan([a]);
  assert.equal(run.line(), 'Syncing…');
  run.say(a, 'Sending 5 of 60');
  assert.equal(run.line(), '“Family”: Sending 5 of 60');
  const renamed = { id: 'y', folder: 'Old' };
  run.plan([renamed]);
  run.say(renamed, 'Receiving 1 of 2');
  renamed.folder = 'New';
  assert.equal(run.line(), '“New”: Receiving 1 of 2', 'a folder renamed during the run is named as it is now');
});

test('an engine that keeps working after its place ended says nothing that shows, and a place nobody planned still shows', () => {
  const run = new RunProgress();
  const a = { id: 'a', folder: 'A' };
  const b = { id: 'b', folder: 'B' };
  run.plan([a, b]);
  run.start(a);
  run.end(a);
  run.say(a, 'Sending 9 of 10');
  assert.equal(run.stateOf('a'), undefined);
  assert.equal(run.line(), 'Syncing…', 'one place left, and it has said nothing');
  run.clear();
  assert.equal(run.stateOf('b'), undefined);
  run.say(b, 'Receiving 1 of 3');
  assert.equal(run.stateOf('b'), 'syncing', 'a download of one folder outside a full run');
  assert.equal(run.line(), '“B”: Receiving 1 of 3');
  run.clear();
  assert.equal(run.line(), 'Syncing…');
});

test('a passphrase change that failed says the passphrase was not changed, in plain words when storage is out of reach', () => {
  assert.equal(passphraseFailure(new Error('WebDAV GET failed with HTTP 503')), "The passphrase was not changed: can't reach the storage. Try again when it is back. (WebDAV GET failed with HTTP 503)");
  assert.equal(passphraseFailure(new Error('WebDAV PUT failed with HTTP 403')), 'The passphrase was not changed: WebDAV PUT failed with HTTP 403');
});
