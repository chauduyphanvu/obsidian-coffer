import type { RemoteStore } from '../core/types.ts';

/** A failure that trying again cannot fix, such as refused credentials: `withRetry` gives up at once. */
export function permanentError(message: string): Error {
  const err = new Error(message) as Error & { permanent: boolean };
  err.permanent = true;
  return err;
}

/** Retries failed requests with exponential backoff and jitter. */
export function withRetry(store: RemoteStore, attempts = 5, baseMs = 300): RemoteStore {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i + 1 >= attempts || (e as { permanent?: boolean }).permanent) throw e;
        await new Promise((r) => setTimeout(r, baseMs * 2 ** i * (0.5 + Math.random())));
      }
    }
  };
  return {
    get: (key, range) => run(() => store.get(key, range)),
    put: (key, data, opts) => run(() => store.put(key, data, opts)),
    delete: (key, opts) => (opts?.once ? store.delete(key) : run(() => store.delete(key))),
    list: (prefix, startAfter) => run(() => store.list(prefix, startAfter)),
  };
}
