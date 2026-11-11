import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = new URL('../src/node/cli.ts', import.meta.url).pathname;

/** A vault, a folder remote and a config file in a temporary folder, and the CLI pointed at them. */
function setup(sync: object) {
  const dir = mkdtempSync(join(tmpdir(), 'selfsync-cli-'));
  const vault = join(dir, 'vault');
  mkdirSync(vault);
  const config = join(dir, 'selfsync.json');
  writeFileSync(config, JSON.stringify({ vault, remote: { type: 'folder', path: join(dir, 'remote') }, sync: { kdfIterations: 1000, ...sync } }));
  const cli = (...args: string[]) =>
    spawnSync('node', [CLI, ...args, `--config=${config}`], { encoding: 'utf8', env: { ...process.env, SELFSYNC_PASSPHRASE: 'pw' } }).stdout;
  return { vault, cli, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cli: a custom exclude list never syncs the CLI's own state", () => {
  const t = setup({ exclude: ['*.tmp'] });
  try {
    writeFileSync(join(t.vault, 'note.md'), 'hello\n');
    assert.match(t.cli('sync'), /^sent 1,/);
    assert.match(t.cli('sync'), /^sent 0, received 0,/);
  } finally {
    t.done();
  }
});

test('cli: history finds a file whichever Unicode form its name is typed in', () => {
  const t = setup({});
  try {
    const name = 'ý tưởng.md';
    writeFileSync(join(t.vault, name), 'x\n');
    t.cli('sync');
    assert.match(t.cli('history', name.normalize('NFC')), /2 bytes/);
    assert.match(t.cli('history', name.normalize('NFD')), /2 bytes/);
  } finally {
    t.done();
  }
});
