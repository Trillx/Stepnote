import { build } from 'esbuild';
import { rm, cp, mkdir } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/popup.ts', 'src/viewer.ts', 'src/sidepanel.ts', 'src/print.ts', 'src/guide.ts', 'src/launcher.ts'],
  outdir: 'dist', bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  sourcemap: true, logLevel: 'info',
});
