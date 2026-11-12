import { fuzz } from '../src/testing/fuzz.ts';

const arg = (name: string, def: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? def);
const seeds = arg('seeds', 300);
const o = { devices: arg('devices', 3), steps: arg('steps', 300), faultRate: arg('faults', 0.08), crashRate: arg('crashes', 0.15) };

const total = { syncs: 0, failedSyncs: 0, hinted: 0, unlisted: 0, merges: 0, conflictCopies: 0, tokens: 0, cleanups: 0, packsCombined: 0, failed: 0 };
for (let seed = 1; seed <= seeds; seed++) {
  const r = await fuzz(seed, o);
  total.syncs += r.syncs;
  total.failedSyncs += r.failedSyncs;
  total.hinted += r.hinted;
  total.unlisted += r.unlisted;
  total.merges += r.merges;
  total.conflictCopies += r.conflictCopies;
  total.tokens += r.tokens;
  total.cleanups += r.cleanups;
  total.packsCombined += r.packsCombined;
  if (!r.ok) {
    total.failed++;
    console.log(`seed ${seed} FAILED: ${r.problems.slice(0, 5).join('; ')}`);
  }
}
console.log(JSON.stringify({ seeds, ...o, ...total }));
process.exit(total.failed ? 1 : 0);
