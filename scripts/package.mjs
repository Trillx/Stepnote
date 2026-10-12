// Zips dist/ into release/stepnote-<version>.zip for the Chrome Web Store or a GitHub release.
// Run through `npm run release`, which builds dist/ with --release first.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { zip } from '../src/zip.ts';

const files = (await readdir('dist', { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile())
  .map(entry => relative('dist', join(entry.parentPath, entry.name)).split(sep).join('/'))
  .sort();
if (!files.includes('manifest.json')) throw new Error('dist/manifest.json is missing. Run npm run release.');
if (files.some(name => name.endsWith('.map'))) throw new Error('dist/ holds a development build with source maps. Run npm run release.');

const { version } = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const archive = zip(await Promise.all(files.map(async name => ({ name, data: new Uint8Array(await readFile(join('dist', name))) }))));
await mkdir('release', { recursive: true });
const out = `release/stepnote-${version}.zip`;
await writeFile(out, archive);
console.log(`${out}: ${files.length} files, ${(archive.length / 1024).toFixed(1)} KB`);
