import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyncResult } from '../src/core/engine.ts';
import type { Why } from '../src/plugin/changes.ts';
import { Pauses, Retries, nextPollDelay, pollPlaces, receivedChanges } from '../src/plugin/polling.ts';

const S = 1000;
const MIN = 60 * S;
const T = 1_800_000_000_000;
const after = (pollSeconds: number, idleMs: number) => nextPollDelay(pollSeconds, T, T + idleMs);

test('polling is off when the setting is 0, whatever happened lately', () => {
  assert.equal(after(0, 0), undefined);
  assert.equal(after(0, 30 * MIN), undefined);
  assert.equal(after(-1, 0), undefined);
  assert.equal(after(Number.NaN, 0), undefined);
});

test('polling is fast for two minutes after activity', () => {
  assert.equal(after(30, 0), 5 * S);
  assert.equal(after(30, 119_999), 5 * S);
  assert.equal(after(300, 60 * S), 50 * S);
});

test('the fast spell polls six times as often as the setting, never faster than every 5 seconds', () => {
  assert.equal(after(30, 0), 5 * S);
  assert.equal(after(60, 0), 10 * S);
  assert.equal(after(300, 0), 50 * S);
  assert.equal(after(300, 2 * MIN - 1), 50 * S);
  assert.equal(after(300, 2 * MIN), 300 * S);
  assert.equal(after(12, 0), 5 * S);
  assert.equal(after(1, 0), 5 * S);
});

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, merged: 0, conflictCopies: [], skipped: 0, tooLarge: [], deferred: [], unsent: [], errors: [], commits: 0, rounds: 1, ...over,
});

test('a sync counts as activity only when it received changes from another device, not when it only sent this one\'s', () => {
  assert.equal(receivedChanges(result()), false);
  assert.equal(receivedChanges(result({ pushed: 3, deletedRemote: 1, commits: 1 })), false);
  for (const over of [{ pulled: 1 }, { deletedLocal: 1 }, { merged: 1 }, { conflictCopies: ['a (conflict phone 20261111-1200).md'] }]) {
    assert.equal(receivedChanges(result(over)), true, JSON.stringify(over));
  }
});

test('a place whose sync keeps failing waits 5 s, then 10, doubling to 5 minutes, and a success starts over', () => {
  const r = new Retries();
  let now = T;
  assert.equal(r.due(now), undefined);
  for (const wait of [5, 10, 20, 40, 80, 160, 300, 300]) {
    assert.equal(r.failed('', now), wait * S);
    assert.equal(r.due(now), now + wait * S);
    for (const why of ['poll', 'timer', 'resume', 'edit', 'start', 'retry'] as Why[]) assert.equal(r.includes('', why, now + wait * S - 1), false, `${why} before ${wait} s`);
    now += wait * S;
    assert.ok(r.includes('', 'retry', now), `tried again after ${wait} s`);
    assert.equal(r.due(now), undefined, 'nothing waits once the wait is over');
  }
  r.reset('');
  assert.ok(r.includes('', 'poll', now));
  assert.equal(r.failed('', now), 5 * S);
});

test('waiting after a failure holds back only that place, and never a sync the user asks for', () => {
  const r = new Retries();
  r.failed('', T);
  r.failed('', T + 5 * S);
  assert.ok(r.includes('', 'manual', T + 5 * S), 'Sync now tries at once');
  assert.ok(r.includes('w', 'poll', T + 5 * S), 'other places keep syncing');
  r.failed('w', T + 6 * S);
  assert.equal(r.due(T + 6 * S), T + 11 * S, 'the soonest wait to end, the shared folder’s');
  assert.equal(r.due(T + 11 * S), T + 15 * S, 'then the vault’s');
});

test('a poll does not ask a place that waits after failing, so a sync that keeps failing does not start again every poll', async () => {
  const r = new Retries();
  const pauses = new Pauses();
  let now = T;
  const gate = { includes: (id: string, why: Why) => pauses.includes(id, why) && r.includes(id, why, now) };
  const asked: string[] = [];
  const changed = async (id: string) => {
    asked.push(id);
    return true;
  };
  r.failed('', now);
  assert.equal(await pollPlaces(['', 'w'], gate, changed), true);
  assert.deepEqual(asked, ['w']);
  asked.length = 0;
  now += 5 * S;
  assert.equal(await pollPlaces(['', 'w'], gate, changed), true);
  assert.deepEqual(asked, ['']);
});

test('a retry, like any sync nobody asked for, leaves out a place paused before deleting many files', () => {
  const p = new Pauses();
  p.pause('');
  assert.equal(p.includes('', 'retry'), false);
});

test('after the fast spell it polls at the setting, and at twice the setting after ten quiet minutes', () => {
  assert.equal(after(30, 2 * MIN), 30 * S);
  assert.equal(after(30, 10 * MIN - 1), 30 * S);
  assert.equal(after(30, 10 * MIN), 60 * S);
  assert.equal(after(30, 3 * 60 * MIN), 60 * S);
});

test('the setting is never polled faster than every 5 seconds', () => {
  assert.equal(after(1, 3 * MIN), 5 * S);
  assert.equal(after(1, 11 * MIN), 10 * S);
  assert.equal(after(5, 3 * MIN), 5 * S);
});

test('activity in the future, from a clock that moved back, counts as recent', () => {
  assert.equal(nextPollDelay(30, T + 10 * MIN, T), 5 * S);
});

test('a place paused before deleting many files is left out of every sync nobody asked for, until the user acts or something in it changes', () => {
  const p = new Pauses();
  p.pause('');
  for (const why of ['poll', 'timer', 'resume', 'edit', 'start'] as Why[]) assert.equal(p.includes('', why), false, why);
  assert.ok(p.includes('', 'manual'), 'a sync the user asks for tries it again');
  assert.ok(p.includes('w', 'timer'), 'other places keep syncing');
  p.lift('w');
  assert.equal(p.includes('', 'edit'), false, 'a change elsewhere does not count');
  p.lift('');
  assert.ok(p.includes('', 'edit'), 'a change in it does');
});

test('a poll does not ask a paused place, so its storage, which keeps saying something changed, starts no sync and is no activity', async () => {
  const p = new Pauses();
  const asked: string[] = [];
  const changed = (ids: string[]) => async (id: string) => {
    asked.push(id);
    return ids.includes(id);
  };
  p.pause('');
  assert.equal(await pollPlaces(['', 'w'], p, changed(['', 'w'])), true, 'another place with changes still starts a sync');
  assert.deepEqual(asked, ['w']);
  asked.length = 0;
  assert.equal(await pollPlaces(['', 'w'], p, changed([''])), false);
  assert.deepEqual(asked, ['w']);
  assert.equal(await pollPlaces(['', 'w'], p, async () => Promise.reject(new Error('offline'))), false, 'a place that can not be asked counts as unchanged');
  p.lift('');
  asked.length = 0;
  assert.equal(await pollPlaces(['', 'w'], p, changed([''])), true);
  assert.deepEqual(asked, ['']);
});
