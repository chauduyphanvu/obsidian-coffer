import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzz } from '../src/testing/fuzz.ts';

test('random edits on three devices converge without losing a line', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = await fuzz(seed, { devices: 3, steps: 200, faultRate: 0, crashRate: 0 });
    assert.deepEqual(r.problems, [], `seed ${seed}`);
  }
});

test('the same holds with failing requests, lost replies and crashes', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = await fuzz(seed, { devices: 3, steps: 200, faultRate: 0.08, crashRate: 0.15 });
    assert.deepEqual(r.problems, [], `seed ${seed}`);
  }
});
