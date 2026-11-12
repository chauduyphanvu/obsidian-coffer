import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeLog, trustSeen, type Why } from '../src/plugin/changes.ts';
import { shareWith, type Share } from '../src/plugin/settings.ts';
import { followRename } from '../src/plugin/shares.ts';

const sorted = (s: Set<string> | undefined) => s && [...s].sort();

test('hints: only a sync after edits or a poll may look at the files events named, and not when settings or a folder go unseen', () => {
  const seen = { paths: new Set(['a.md']), unknown: false };
  for (const why of ['edit', 'poll'] as Why[]) assert.ok(trustSeen(seen, why), why);
  for (const why of ['start', 'manual', 'timer', 'resume'] as Why[]) assert.ok(!trustSeen(seen, why), why);
  assert.ok(!trustSeen({ ...seen, unknown: true }, 'edit'));
  assert.ok(!trustSeen(seen, 'edit', { settingsDue: true }), 'settings files fire no events');
  assert.ok(!trustSeen(seen, 'poll', { folderMissing: true }), 'only a listing notices a shared folder is gone');
});

test('hints: a place lists on its first sync, after a failure and after changes went unseen; otherwise a sync gets what happened since the last began', () => {
  const log = new ChangeLog(() => []);
  log.file('a.md');
  assert.equal(log.take(undefined, 'edit'), undefined, 'nothing listened before the plugin started');
  log.file('b.md');
  log.file('c/d.md');
  const first = log.take(undefined, 'edit');
  log.file('e.md');
  assert.deepEqual(sorted(first), ['b.md', 'c/d.md'], 'a change made during the sync is not in it');
  assert.deepEqual(sorted(log.take(undefined, 'poll')), ['e.md']);
  assert.deepEqual(sorted(log.take(undefined, 'edit')), []);

  log.file('f.md');
  log.failed(undefined);
  assert.equal(log.take(undefined, 'edit'), undefined);
  log.file('g.md');
  assert.equal(log.take(undefined, 'resume'), undefined);
  assert.deepEqual(sorted(log.take(undefined, 'edit')), [], 'the listing covered g.md');
  log.file('h.md');
  assert.equal(log.take(undefined, 'edit', { settingsDue: true }), undefined);
  log.lost();
  assert.equal(log.take(undefined, 'edit'), undefined);
});

test('hints: each event goes to the place it is in, by its path there, and a file moved into a shared folder touches both', () => {
  const work = shareWith({ id: 'w', folder: 'Work' });
  const inner = shareWith({ id: 'i', folder: 'Work/Inner' });
  const log = new ChangeLog(() => [work, inner]);
  for (const s of [undefined, work, inner]) log.take(s, 'manual');
  log.file('a.md');
  log.file('Work notes/n.md');
  log.file('Work/w.md');
  log.file('Work/Inner/deep/i.md');
  log.file('moved.md');
  log.file('Work/moved.md');
  assert.deepEqual(sorted(log.take(undefined, 'edit')), ['Work notes/n.md', 'a.md', 'moved.md'], 'never a path inside a shared folder');
  assert.deepEqual(sorted(log.take(work, 'edit')), ['moved.md', 'w.md']);
  assert.deepEqual(sorted(log.take(inner, 'edit')), ['deep/i.md']);
  log.file('Work/x.md');
  assert.equal(log.take(work, 'edit', { folderMissing: true }), undefined);
});

test('hints: each event says which places it is in, so a place paused before a mass delete knows something in it changed', () => {
  const work = shareWith({ id: 'w', folder: 'Work' });
  const log = new ChangeLog(() => [work]);
  assert.equal(log.file('a.md'), '');
  assert.equal(log.file('Work/w.md'), 'w');
  assert.deepEqual(log.folder('Notes', 'Work/Notes'), ['', 'w']);
  assert.deepEqual(log.folder('Work'), ['w'], 'the shared folder itself is in its own place');
});

test('hints: an event in the other Unicode form than the shared folder\'s name names the file inside it, in the form it has on disk', () => {
  const nfc = 'Café'.normalize('NFC');
  const nfd = 'Café'.normalize('NFD');
  for (const [stored, given] of [[nfc, nfd], [nfd, nfc]]) {
    const cafe = shareWith({ id: 'c', folder: stored });
    const log = new ChangeLog(() => [cafe]);
    log.take(cafe, 'manual');
    log.take(undefined, 'manual');
    log.file(`${given}/${given}.md`);
    assert.deepEqual(sorted(log.take(cafe, 'edit')), [`${given}.md`]);
    assert.deepEqual(sorted(log.take(undefined, 'edit')), []);
  }
});

test('hints: a folder renamed, moved or deleted makes the places it was and is in list, and every shared folder it is or holds', () => {
  const work = shareWith({ id: 'w', folder: 'Work' });
  const inner = shareWith({ id: 'i', folder: 'Work/Inner' });
  const other = shareWith({ id: 'o', folder: 'Other' });
  const shares = [work, inner, other];
  const log = new ChangeLog(() => shares);
  const places: (Share | undefined)[] = [undefined, ...shares];
  const fresh = () => places.forEach((s) => log.take(s, 'manual'));
  const listing = () => places.filter((s) => log.take(s, 'edit') === undefined).map((s) => s?.id ?? 'vault');

  fresh();
  // The shared folder itself, renamed into a folder of the vault: the event comes before the share follows it.
  log.folder('Work', 'Archive/Work');
  followRename(shares, 'Work', 'Archive/Work');
  log.file('Archive/Work/w.md');
  assert.deepEqual(listing(), ['vault', 'w', 'i']);

  fresh();
  log.folder('Archive/Work/Inner/sub', 'Archive/Work/Inner/sub2');
  assert.deepEqual(listing(), ['i']);
  fresh();
  log.folder('Notes', 'Old notes');
  assert.deepEqual(listing(), ['vault']);
  fresh();
  log.folder('Other');
  assert.deepEqual(listing(), ['o']);
  fresh();
  log.folder('Archive');
  assert.deepEqual(listing(), ['vault', 'w', 'i']);
});
