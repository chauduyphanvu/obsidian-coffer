import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

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
await copyFile('manifest.json', 'dist/manifest.json');
await copyFile('styles.css', 'dist/styles.css');
