// Copies package.json's version into public/manifest.json.
// Runs from the npm "version" lifecycle, so `npm version patch` keeps both in step.
import { readFile, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
// Chrome accepts one to four dot-separated integers; npm pre-release tags like 1.0.0-beta.1 are rejected.
if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`Chrome cannot use version "${version}". Use plain numbers such as 1.2.3.`);

const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
manifest.version = version;
await writeFile('public/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`public/manifest.json version set to ${version}`);
