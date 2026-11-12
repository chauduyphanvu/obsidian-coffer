import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuzz } from '../src/testing/fuzz.ts';

test('random edits, cleanups and time jumps on three devices converge without losing a line', async () => {
  let combined = 0;
  let hinted = 0;
  let unlisted = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = await fuzz(seed, { devices: 3, steps: 200, faultRate: 0, crashRate: 0 });
    assert.deepEqual(r.problems, [], `seed ${seed}`);
    combined += r.packsCombined;
    hinted += r.hinted;
    unlisted += r.unlisted;
  }
  assert.ok(combined > 100, `cleanups compacted ${combined} packs`);
  // Syncs told what changed mostly did without listing the vault, so the convergence above covers them.
  assert.ok(hinted > 500 && unlisted > hinted * 0.8, `${unlisted} of ${hinted} hinted syncs did not list`);
});

test('the same holds with failing requests, lost replies and crashes', async () => {
  let combined = 0;
  let unlisted = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = await fuzz(seed, { devices: 3, steps: 200, faultRate: 0.08, crashRate: 0.15 });
    assert.deepEqual(r.problems, [], `seed ${seed}`);
    combined += r.packsCombined;
    unlisted += r.unlisted;
  }
  assert.ok(combined > 100, `cleanups compacted ${combined} packs`);
  assert.ok(unlisted > 200, `${unlisted} hinted syncs did not list`);
});
