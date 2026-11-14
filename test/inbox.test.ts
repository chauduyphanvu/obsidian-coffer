import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyPolicy } from '../src/core/policy.ts';
import type { Entry } from '../src/core/types.ts';
import { loadSettings, shareWith, type Share } from '../src/plugin/settings.ts';
import { asText, inShare, isUnsentProblem, resultProblems, type Snapshot } from '../src/plugin/status.ts';
import {
  canSuggest, filesLine, forgetSent, isRefused, moreWaitingText, movedTo, recordSent, refusedText, reviewSuggested, reviewText, sentBefore, sentNote, sentText, suggestable, type Review,
} from '../src/plugin/suggestions.ts';
import { memberShare } from './helpers.ts';

const file = (text: string): Snapshot => ({ size: text.length, mtime: 1, data: new TextEncoder().encode(text) });
const kind = (r: Review) => (r.kind === 'choose' ? `choose:${r.why}` : r.kind === 'whole' ? `whole:${r.why}` : r.kind === 'apply' ? `apply${r.merged ? ':merged' : ''}` : r.kind);

test('how a suggested note is taken in: as it is, combined with what changed here since, or change by change', () => {
  const base = 'title\n\none\ntwo\nthree\n';
  const theirs = 'title\n\none\ntwo\nthree, by Mai\n';
  // Nothing changed here since: taking it in writes what Mai wrote.
  const clean = reviewSuggested('n.md', theirs, base, file(base));
  assert.equal(kind(clean), 'apply');
  assert.equal(clean.kind === 'apply' && clean.result, theirs);
  assert.deepEqual(clean.kind === 'apply' && clean.lines?.filter((l) => l.kind !== 'same' && l.kind !== 'gap'), [
    { kind: 'removed', text: 'three' },
    { kind: 'added', text: 'three, by Mai' },
  ]);
  // The owner changed another line since: both changes are kept.
  const ours = 'title\n\none, by Vu\ntwo\nthree\n';
  const merged = reviewSuggested('n.md', theirs, base, file(ours));
  assert.equal(kind(merged), 'apply:merged');
  assert.equal(merged.kind === 'apply' && merged.result, 'title\n\none, by Vu\ntwo\nthree, by Mai\n');
  // Both changed the same line: chosen change by change, the folder's lines first.
  const clash = reviewSuggested('n.md', theirs, base, file('title\n\none\ntwo\nthree, by Vu\n'));
  assert.equal(kind(clash), 'choose:both');
  // Already taken in, or the same change made here: nothing to do.
  assert.equal(kind(reviewSuggested('n.md', theirs, base, file(theirs))), 'same');
  assert.equal(kind(reviewSuggested('n.md', theirs, base, file('title\n\none, by Vu\ntwo\nthree, by Mai\n'))), 'same');
  // The version Mai changed is no longer kept, or a file is here that Mai's device did not have.
  assert.equal(kind(reviewSuggested('n.md', theirs, null, file(ours))), 'choose:unknown');
  assert.equal(kind(reviewSuggested('n.md', theirs, undefined, file(ours))), 'choose:exists');
  // No file here: a new one, or one deleted (or moved and changed) since.
  assert.deepEqual(reviewSuggested('n.md', theirs, undefined, undefined), { kind: 'new', text: theirs });
  assert.deepEqual(reviewSuggested('n.md', theirs, base, undefined), { kind: 'gone', text: theirs });
  assert.deepEqual(reviewSuggested('n.md', theirs, null, undefined), { kind: 'gone', text: theirs });
  // Only whole: too large, not text, too different.
  assert.equal(kind(reviewSuggested('n.md', theirs, base, { size: 9e6, mtime: 1 })), 'whole:large');
  assert.equal(kind(reviewSuggested('n.md', theirs, base, { size: 2, mtime: 1, data: new Uint8Array([0xff, 0]) })), 'whole:binary');
  const many = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join('');
  const other = Array.from({ length: 3000 }, (_, i) => `other ${i}\n`).join('');
  assert.equal(kind(reviewSuggested('n.md', other, undefined, file(many))), 'whole:different');
});

test('a suggested canvas merges node by node, and is only replaced whole when both changed the same node', () => {
  const canvas = (nodes: [string, string][]) => JSON.stringify({ nodes: nodes.map(([id, text]) => ({ id, type: 'text', text, x: 0, y: 0, width: 1, height: 1 })), edges: [] });
  const base = canvas([['a', 'A'], ['b', 'B']]);
  const theirs = canvas([['a', 'A'], ['b', 'B by Mai']]);
  const merged = reviewSuggested('c.canvas', theirs, base, file(canvas([['a', 'A by Vu'], ['b', 'B']])));
  assert.equal(kind(merged), 'apply:merged');
  const out = JSON.parse((merged as Extract<Review, { kind: 'apply' }>).result) as { nodes: { text: string }[] };
  assert.deepEqual(out.nodes.map((n) => n.text), ['A by Vu', 'B by Mai']);
  assert.equal(kind(reviewSuggested('c.canvas', theirs, base, file(canvas([['a', 'A'], ['b', 'B by Vu']])))), 'whole:structured');
  assert.equal(kind(reviewSuggested('c.canvas', theirs, undefined, file(base))), 'whole:structured');
});

test('a file moved since is found by its content where it is now', () => {
  const e = (id: string): Entry => ({ size: 3, mtime: 1, chunks: [{ id, pack: 'p', off: 0, len: 3, size: 3 }] });
  const remote = new Map([['Old/plan.md', e('x')], ['b.md', e('y')]]);
  assert.equal(movedTo('plan.md', e('x'), remote), 'Old/plan.md');
  assert.equal(movedTo('plan.md', e('z'), remote), undefined, 'moved and changed: not found');
  assert.equal(movedTo('b.md', e('y'), remote), undefined, 'still where it was');
  assert.equal(movedTo('plan.md', undefined, remote), undefined);
});

test('what the owner reads above each suggested file, and its button', () => {
  const o = { name: 'Mai', file: 'Plan.md' };
  assert.deepEqual(reviewText({ kind: 'same' }, o), { intro: '“Plan.md” already has this text, so there is nothing to take in.' });
  assert.equal(reviewText({ kind: 'new', text: '' }, o).accept, 'Add it');
  assert.match(reviewText({ kind: 'new', text: '' }, { ...o, file: 'Board.canvas' }).intro, /a new file, “Board.canvas”/);
  assert.match(reviewText({ kind: 'apply', result: '', merged: true }, o).intro, /changed here after Mai's copy/);
  assert.equal(reviewText({ kind: 'gone', text: '' }, o).accept, 'Add it back');
  const moved = reviewText({ kind: 'apply', result: '', merged: false }, { ...o, moved: 'Old/Plan.md' });
  assert.match(moved.intro, /^It was moved to “Old\/Plan.md” since, and is taken in there. Taking it in changes/);
  assert.equal(reviewText({ kind: 'choose', why: 'unknown', regions: [] }, o).accept, 'Save');
  assert.equal(reviewText({ kind: 'whole', why: 'binary', text: '' }, o).accept, 'Replace it');
});

test('below the newest suggestions, one line says how many more wait and when they show', () => {
  assert.equal(moreWaitingText(1), 'One more suggestion is waiting. It shows here once you have dealt with these.');
  assert.equal(moreWaitingText(1200), `${(1200).toLocaleString()} more suggestions are waiting. They show here once you have dealt with these.`);
});

test('only a member’s device that may only read, with storage keys of its own, can suggest', () => {
  const base = { id: 's1', folder: 'Family', memberKeysSecret: 'k' };
  assert.ok(canSuggest(shareWith({ ...base, role: 'read' })));
  assert.ok(!canSuggest(shareWith({ ...base, role: 'read', followUrl: 'https://x.test/f' })), 'a follower has no keys');
  assert.ok(!canSuggest(shareWith({ ...base, role: 'write' })));
  assert.ok(!canSuggest(shareWith({ ...base, role: 'owner' })));
  assert.ok(!canSuggest(shareWith({ id: 's2', folder: 'Old', role: '' })), 'a folder shared with a passphrase has no owner to send to');
  const [old] = loadSettings({ shares: [{ id: 'x1', folder: 'Work' } as Share] }, false).shares;
  assert.deepEqual(old.suggested, [], 'a share saved by 0.3.0 has sent nothing');
});

test('the problem a read member’s unsent files make says they can be sent as a suggestion, and is told apart', () => {
  const [p] = resultProblems({ errors: [], tooLarge: [], unsent: ['Family/a.md'] }, [], 200, undefined, 'Vu');
  assert.match(p.detail, /^You may only read this shared folder, so what is changed here stays here\. Notes and canvases can be sent to Vu as a suggestion, for Vu to take in\./);
  assert.doesNotMatch(p.detail, /Turn off Only receive changes/, 'a member who may only read can not turn it off');
  assert.match(resultProblems({ errors: [], tooLarge: [], unsent: ['a.md'] }, [], 200)[0].detail, /Turn off Only receive changes/);
  assert.ok(isUnsentProblem(p));
  assert.ok(isUnsentProblem(inShare(p, { id: 's1', folder: 'Family' })));
  assert.ok(!isUnsentProblem({ ...p, id: 'conflicts:a' }));
});

test('what sending said, and why storage refused it', () => {
  assert.deepEqual(suggestable(['a.md', 'b.png', 'c.canvas']), { notes: ['a.md', 'c.canvas'], others: ['b.png'] });
  assert.equal(
    sentText({ key: 'k', sent: [{ path: 'a.md', sum: '1' }], skipped: [{ path: 'b.png', why: 'kind' }, { path: 'c.png', why: 'kind' }, { path: 'd.md', why: 'sent' }] }, 'Vu'),
    'Sent 1 note to Vu as a suggestion.\nNot sent, only notes and canvases can be suggested: b.png, c.png.\nNot sent, sent before, unchanged since: d.md.',
  );
  assert.equal(sentText({ sent: [], skipped: [{ path: 'x/a.md', why: 'same' }] }, ''), 'Nothing was sent.\nNot sent, the same as in the shared folder: a.md.');
  assert.ok(isRefused(new Error('S3 PUT inbox/x-1 failed with HTTP 403 (AccessDenied)')));
  assert.ok(isRefused(new Error('WebDAV refused the login or the folder (HTTP 403)')));
  assert.ok(!isRefused(new Error('S3 PUT inbox/x-1 failed with HTTP 503')));
  const rules = keyPolicy({ provider: 'aws', bucket: 'b', prefix: 'f' }, 'readAndInbox').title;
  assert.match(refusedText('Vu', rules), /Vu can send you a new invite with a key that may also send suggestions: at the storage provider, a key with the rules “Read, and send suggestions”/);
  assert.equal(filesLine({ files: ['a.md', 'b.md', 'c.md', 'd.md'].map((path) => ({ path, text: '' })) }), '4 notes: a.md, b.md, c.md and 1 more');
  assert.equal(filesLine({ files: [{ path: 'x/b.canvas', text: '' }] }), '1 file: b.canvas');
});

test('a suggestion from start to end: sent from a read member’s device, merged on the owner’s with what changed since, and then the reader has nothing unsent', async () => {
  const { owner, join, clock } = await memberShare();
  owner.fs.put('plan.md', 'title\n\none\ntwo\nthree\n');
  await owner.sync();
  const mai = await join('Mai', 'read');
  await mai.sync();
  const share = shareWith({ id: 's1', folder: 'Family', role: 'read', memberKeysSecret: 'k' });

  // Mai changes a line and sends it; asking again sends nothing new.
  mai.fs.put('plan.md', 'title\n\none\ntwo\nthree, by Mai\n');
  const unsent = (await mai.sync()).unsent;
  const out = await mai.engine.sendSuggestion(unsent, sentBefore(share));
  recordSent(share, out);
  assert.equal(share.suggested.length, 1);
  assert.equal(sentNote(share, unsent, 'Vu'), '1 file of these was sent to Vu as a suggestion. A note changed again since can be sent again.');
  assert.equal(sentNote(share, ['other.md'], 'Vu'), '');
  assert.equal((await mai.engine.sendSuggestion(unsent, sentBefore(share))).key, undefined);

  // Meanwhile the owner changed another line.
  clock.now += 60_000;
  owner.fs.put('plan.md', 'title\n\none, by Vu\ntwo\nthree\n');
  await owner.sync();
  const [w] = (await owner.engine.suggestions()).items;
  const f = w.suggestion!.files[0];
  const base = asText(await owner.engine.readVersion(f.base!))!;
  const current = owner.fs.files.get('plan.md')!;
  const review = reviewSuggested(f.path, f.text, base, { size: current.data.length, mtime: current.mtime, data: current.data });
  assert.equal(kind(review), 'apply:merged');
  owner.fs.put('plan.md', (review as Extract<Review, { kind: 'apply' }>).result);
  await owner.engine.settleSuggestion(w.key, f.path);
  assert.deepEqual(await owner.engine.inbox(), []);
  await owner.sync();

  // Mai's device receives the owner's change, which holds hers: nothing is left unsent, so what was sent is forgotten.
  const r = await mai.sync();
  assert.equal(mai.fs.text('plan.md'), 'title\n\none, by Vu\ntwo\nthree, by Mai\n');
  assert.deepEqual(r.unsent, []);
  assert.ok(forgetSent(share, r.unsent));
  assert.deepEqual(share.suggested, []);
});

test('what a member sent as a suggestion and did not change since takes the version the owner made of it, with no conflict copy; a note changed since keeps its change', async () => {
  const { owner, join, clock } = await memberShare();
  owner.fs.put('plan.md', 'title\n\none\n');
  owner.fs.put('list.md', 'a\n');
  await owner.sync();
  const mai = await join('Mai', 'read');
  await mai.sync();
  const share = shareWith({ id: 's1', folder: 'Family', role: 'read', memberKeysSecret: 'k' });

  // Mai adds a note and changes two, sends all three, then changes one of them again.
  mai.fs.put('Muffins.md', 'muffins\n');
  mai.fs.put('plan.md', 'title\n\none, by Mai\n');
  mai.fs.put('list.md', 'a\nb\n');
  recordSent(share, await mai.engine.sendSuggestion((await mai.sync()).unsent, sentBefore(share)));
  assert.equal(share.suggested.length, 3);
  mai.fs.put('list.md', 'a\nb\nc, not sent\n');

  // The owner takes each in, not quite as sent: a property added to the new note, a word to the others.
  clock.now += 60_000;
  owner.fs.put('Muffins.md', '---\nshare: Family\n---\nmuffins\n');
  owner.fs.put('plan.md', 'title\n\none, by Mai and Vu\n');
  owner.fs.put('list.md', 'a\nb, by Vu\n');
  await owner.sync();

  const r = await mai.engine.sync({ suggested: sentBefore(share) });
  assert.equal(mai.fs.text('Muffins.md'), '---\nshare: Family\n---\nmuffins\n');
  assert.equal(mai.fs.text('plan.md'), 'title\n\none, by Mai and Vu\n');
  assert.ok(!r.conflictCopies.some((p) => /Muffins|plan/.test(p)), `no copy of what was sent: ${r.conflictCopies.join(', ')}`);
  assert.ok(!r.unsent.includes('Muffins.md') && !r.unsent.includes('plan.md'));
  // What Mai wrote after sending was not sent: it is still on her device, merged or kept as a copy.
  assert.ok([...mai.fs.files.keys()].some((p) => p.startsWith('list') && mai.fs.text(p)!.includes('c, not sent')));
  forgetSent(share, r.unsent);
  assert.deepEqual(share.suggested.map(([p]) => p).filter((p) => p !== 'list.md'), []);
});
