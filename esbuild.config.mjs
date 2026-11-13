import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/plugin/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  external: ['obsidian'],
  minify: process.argv.includes('--minify'),
  logLevel: 'info',
});
// The CLI as one file for the release. Unminified so it can be read, and ESM because the package's "type": "module"
// makes Node read a .js file that way (a CommonJS bundle would not run from a checkout).
const { version } = JSON.parse(await readFile('manifest.json', 'utf8'));
await build({
  entryPoints: ['src/node/cli.ts'],
  outfile: 'dist/coffer.js',
  bundle: true,
  format: 'esm',
  target: 'node22',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  define: { COFFER_VERSION: JSON.stringify(version) },
  logLevel: 'info',
});
await copyFile('manifest.json', 'dist/manifest.json');
await copyFile('styles.css', 'dist/styles.css');
