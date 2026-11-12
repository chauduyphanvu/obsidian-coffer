import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Why } from '../src/plugin/changes.ts';
import { Pauses, nextPollDelay, pollPlaces } from '../src/plugin/polling.ts';

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
  assert.equal(after(300, 60 * S), 5 * S);
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
