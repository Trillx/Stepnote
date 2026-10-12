import { build } from 'esbuild';
import { rm, cp, mkdir, readFile } from 'node:fs/promises';

// --release: minified, no source maps. Used by `npm run release`.
const release = process.argv.includes('--release');

// package.json owns the version; `npm version` copies it into the manifest.
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
if (manifest.version !== version) {
  throw new Error(`public/manifest.json version ${manifest.version} does not match package.json ${version}. Run: node scripts/sync-version.mjs`);
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/popup.ts', 'src/viewer.ts', 'src/sidepanel.ts', 'src/print.ts', 'src/guide.ts', 'src/launcher.ts'],
  outdir: 'dist', bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  sourcemap: !release, minify: release, logLevel: 'info',
});
