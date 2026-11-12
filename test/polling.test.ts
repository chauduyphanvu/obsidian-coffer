import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextPollDelay } from '../src/plugin/polling.ts';

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
