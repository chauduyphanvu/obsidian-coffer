// What the benchmark scripts share: their arguments (--name=value), what they print, timers, and a full garbage
// collection where Node was started with --expose-gc.
import { Console } from 'node:console';

export { clearInterval, setInterval } from 'node:timers';
export { say } from '../src/node/out.ts';

const out = new Console(process.stdout);
export const showTable = (rows: object): void => out.table(rows);

export const args: Record<string, string | undefined> = Object.fromEntries(
  process.argv.slice(2).map((a): [string, string | undefined] => {
    const [name, value] = a.replace(/^--/, '').split('=');
    return [name, value];
  }),
);

declare const gc: (() => void) | undefined;
export const collect = (): void => {
  if (typeof gc === 'function') gc();
};
