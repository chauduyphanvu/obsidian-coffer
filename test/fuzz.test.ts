import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzz } from '../src/testing/fuzz.ts';

test('random edits, cleanups and time jumps on three devices converge without losing a line', async () => {
  let combined = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = await fuzz(seed, { devices: 3, steps: 200, faultRate: 0, crashRate: 0 });
    assert.deepEqual(r.problems, [], `seed ${seed}`);
    combined += r.packsCombined;
  }
  assert.ok(combined > 100, `cleanups compacted ${combined} packs`);
});

test('the same holds with failing requests, lost replies and crashes', async () => {
  let combined = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = await fuzz(seed, { devices: 3, steps: 200, faultRate: 0.08, crashRate: 0.15 });
    assert.deepEqual(r.problems, [], `seed ${seed}`);
    combined += r.packsCombined;
  }
  assert.ok(combined > 100, `cleanups compacted ${combined} packs`);
});
