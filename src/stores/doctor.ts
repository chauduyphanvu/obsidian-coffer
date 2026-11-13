import type { RemoteStore } from '../core/types.ts';

/**
 * Exercises every operation the sync engine relies on and reports the first thing that does not behave. For a device
 * that only reads (`readOnly`), only the reads: it never writes, and its keys may not be allowed to.
 */
export async function checkStore(store: RemoteStore, readOnly = false): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] }> {
  const key = `doctor/${Math.random().toString(36).slice(2)}`;
  const data = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = async (name: string, fn: () => Promise<boolean | string>) => {
    try {
      const r = await fn();
      checks.push({ name, ok: r === true, detail: r === true ? undefined : r || 'unexpected result' });
    } catch (e) {
      checks.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };
  await check('read a missing object', async () => (await store.get(key)) === null);
  // Unreachable or refusing storage fails every check the same way, each after its own retries: say so at once.
  if (!checks[0].ok) return { ok: false, checks };
  if (readOnly) {
    await check('list log/', async () => Array.isArray(await store.list('log/')));
    return { ok: checks.every((c) => c.ok), checks };
  }
  await check('create an object', async () => store.put(key, data, { ifNoneMatch: true }));
  await check('refuse to overwrite on create-if-absent', async () =>
    (await store.put(key, data, { ifNoneMatch: true })) === false ||
    'the store overwrote an existing object; two devices could corrupt each other (needs If-None-Match support)');
  await check('read it back', async () => {
    const got = await store.get(key);
    return !!got && got.length === data.length && got.every((b, i) => b === data[i]);
  });
  await check('read a byte range', async () => {
    const got = await store.get(key, { start: 100, end: 300 });
    return !!got && got.length === 200 && got[0] === data[100] && got[199] === data[299];
  });
  await check('list', async () => {
    const all = await store.list('doctor/');
    const after = await store.list('doctor/', key);
    return all.some((o) => o.key === key && o.size === data.length && o.modified > 0) && !after.some((o) => o.key === key);
  });
  await check('delete', async () => {
    await store.delete(key);
    return (await store.get(key)) === null;
  });
  return { ok: checks.every((c) => c.ok), checks };
}
