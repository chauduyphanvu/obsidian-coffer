import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadState, removeState, saveState, type StateFiles } from '../src/plugin/statefile.ts';

/** Files in memory. With `crashAt`, the operation of that number stops the app: a write leaves half its text, and nothing after it runs. */
class Files implements StateFiles {
  files = new Map<string, string>();
  ops = 0;
  crashAt = Infinity;
  private step(): void {
    if (this.ops++ >= this.crashAt) throw new Error('the app stopped');
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async read(path: string) {
    const t = this.files.get(path);
    if (t === undefined) throw new Error(`no file ${path}`);
    return t;
  }
  async write(path: string, data: string) {
    if (this.ops >= this.crashAt) {
      this.files.set(path, data.slice(0, data.length >> 1));
      this.step();
    }
    this.step();
    this.files.set(path, data);
  }
  async remove(path: string) {
    this.step();
    if (!this.files.delete(path)) throw new Error(`no file ${path}`);
  }
  async rename(from: string, to: string) {
    this.step();
    if (this.files.has(to)) throw new Error(`${to} exists`);
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
}

const OLD = JSON.stringify({ seq: 1, f: ['a', 'b', 'c'] });
const NEW = JSON.stringify({ seq: 2, f: ['a', 'b', 'c', 'd'] });

test('a state file stopped at any step of a save loads whole: the one before or the new one', async () => {
  for (let crashAt = 0; crashAt < 8; crashAt++) {
    const f = new Files();
    await saveState(f, 's.json', OLD);
    f.ops = 0;
    f.crashAt = crashAt;
    await saveState(f, 's.json', NEW).catch(() => undefined);
    f.crashAt = Infinity;
    const loaded = await loadState(f, 's.json');
    assert.ok(loaded === OLD || loaded === NEW, `stopped at step ${crashAt}: ${loaded}`);
    // The next save goes through, and leaves only the file itself.
    await saveState(f, 's.json', NEW);
    assert.equal(await loadState(f, 's.json'), NEW);
    assert.deepEqual([...f.files.keys()], ['s.json'], `stopped at step ${crashAt}`);
  }
});

test('a state file that is missing loads as none, and removing one takes a half-saved copy with it', async () => {
  const f = new Files();
  assert.equal(await loadState(f, 's.json'), null);
  await saveState(f, 's.json', OLD);
  f.files.set('s.json.tmp', NEW);
  await removeState(f, 's.json');
  assert.deepEqual([...f.files.keys()], []);
  assert.equal(await loadState(f, 's.json'), null);
  await removeState(f, 's.json');
});

test('a state file damaged in place loads the copy saved beside it, when that one is whole', async () => {
  const f = new Files();
  f.files.set('s.json', OLD.slice(0, 5));
  assert.equal(await loadState(f, 's.json'), OLD.slice(0, 5), 'nothing else to go by: the caller finds it damaged');
  f.files.set('s.json.tmp', NEW);
  assert.equal(await loadState(f, 's.json'), NEW);
});
