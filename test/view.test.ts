import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inUse, linksIn } from '../src/core/view.ts';

const DAY = 86_400_000;
const now = 1_800_000_000_000;
const old = now - 400 * DAY;
const rule = (o: Partial<Parameters<typeof inUse>[1]> = {}) => ({ now, days: 30, pins: [], opened: [], ...o });

test('a file is in use while a note changed lately links to it, by whole path, shortest path or a path from the note', () => {
  const notes = [
    { path: 'Trips/Japan.md', mtime: now - DAY, links: ['Files/map.pdf', 'tokyo.mov', './day1.mov', '../Shared/clip.mov', 'Sub/pic.png'] },
    { path: 'Old.md', mtime: old, links: ['Files/old.pdf'] },
  ];
  const used = inUse(notes, rule());
  for (const path of ['Files/map.pdf', 'Media/2019/tokyo.mov', 'Trips/day1.mov', 'Shared/clip.mov', 'Trips/Sub/pic.png', 'files/MAP.pdf']) assert.ok(used(path, old), path);
  for (const path of ['Files/old.pdf', 'Files/other.pdf', 'Media/nottokyo.mov', 'day1.mov']) assert.ok(!used(path, old), path);
});

test('a note that stops being recent lets go of its files, and one edited again takes them back', () => {
  const note = { path: 'a.md', mtime: now - 31 * DAY, links: ['big.mov'] };
  assert.ok(!inUse([note], rule())('big.mov', old));
  assert.ok(inUse([{ ...note, mtime: now }], rule())('big.mov', old));
});

test('a file changed or opened lately, or in a pinned folder, is in use without any link', () => {
  assert.ok(inUse([], rule())('new.mov', now - 29 * DAY));
  assert.ok(!inUse([], rule())('new.mov', now - 31 * DAY));
  const opened = inUse([], rule({ opened: [['Seen.mov', now - DAY], ['long ago.mov', now - 60 * DAY]] }));
  assert.ok(opened('seen.mov', old) && !opened('long ago.mov', old));
  const pinned = inUse([], rule({ pins: [' Work/Reference/ ', ''] }));
  assert.ok(pinned('Work/Reference/a/b.pdf', old));
  assert.ok(!pinned('Work/Reference.pdf', old) && !pinned('Work/Referenced/x.pdf', old) && !pinned('x.pdf', old), 'an empty line pins nothing');
  assert.ok(inUse([], rule({ pins: ['/'] }))('anything.bin', old));
});

test('linksIn finds wiki links, embeds and markdown links, and leaves web addresses out', () => {
  const text = [
    'See [[Folder/Note#Heading|shown]] and ![[clip.mov|300]] and ![[doc.pdf#page=2]].',
    '![alt](Files/my%20pic.png "title") [site](https://example.com/a.png) [mail](mailto:a@b.c)',
    '[angled](<Files/with space.pdf>) [anchor](other.pdf#page=3) [here](#section)',
  ].join('\n');
  assert.deepEqual(linksIn(text), ['Folder/Note', 'clip.mov', 'doc.pdf', 'Files/my pic.png', 'Files/with space.pdf', 'other.pdf']);
});
