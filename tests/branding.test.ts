import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountSidePanel } from '../src/sidepanel-ui.ts';
import { mountPopup } from '../src/popup-ui.ts';
import { mountViewer } from '../src/viewer-ui.ts';

test('Stepnote is consistently named in the extension and its existing views', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'Stepnote');
  assert.equal(manifest.action.default_title, 'Open Stepnote');
  const status = async () => ({ recording: null });
  for (const mount of [
    (root: HTMLElement) => mountSidePanel(root, status, () => () => {}, () => {}, () => false, () => {}),
    (root: HTMLElement) => mountPopup(root, status, () => {}),
    (root: HTMLElement) => mountViewer(root, { send: status, download: () => {}, confirmDelete: () => false }),
  ]) {
    const dom = new JSDOM('<main id="app"></main>');
    try {
      const root = dom.window.document.querySelector<HTMLElement>('#app')!;
      await mount(root);
      assert.equal(root.querySelector('.eyebrow')?.textContent, 'Stepnote');
    } finally { dom.window.close(); }
  }
});

test('rounded Nunito typography is bundled locally with its license', () => {
  const css = readFileSync(new URL('../public/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*['"]Nunito['"]/);
  assert.match(css, /url\(['"]?fonts\/Nunito-Variable\.ttf['"]?\)/);
  assert.doesNotMatch(css, /@import|https?:\/\//);
  const font = new URL('../public/fonts/Nunito-Variable.ttf', import.meta.url);
  assert.ok(existsSync(font), 'The display font must ship with the extension');
  assert.deepEqual([...readFileSync(font).subarray(0, 4)], [0, 1, 0, 0]);
  const license = readFileSync(new URL('../public/fonts/OFL-Nunito.txt', import.meta.url), 'utf8');
  assert.match(license, /SIL OPEN FONT LICENSE/);
});

test('home stays brief and keeps privacy details in a closed accessible disclosure', async () => {
  const dom = new JSDOM('<main id="app"></main>');
  try {
    const root = dom.window.document.querySelector<HTMLElement>('#app')!;
    await mountSidePanel(root, async () => ({ recording: null }), () => () => {}, () => {}, () => false, () => {});
    const details = root.querySelector<HTMLDetailsElement>('#capture-details');
    assert.ok(details, 'Long explanations belong in a disclosure');
    assert.equal(details.open, false);
    assert.equal(details.querySelector('summary')?.textContent, 'Privacy & limits');
    assert.match(details.textContent!, /Ordinary typed entries.*exports/);
    assert.match(details.textContent!, /Automatic blur.*can miss/);
    assert.equal(root.querySelector('#status')?.textContent, 'Ready');
    assert.equal(root.querySelector('h1')?.textContent, 'Stepnote');
    assert.ok(root.querySelector('#home')!.textContent!.length < 120);
    assert.equal(root.querySelector('#privacy-note')?.textContent, 'Text and screenshots are saved. Review before sharing.');
    assert.equal(root.querySelector<HTMLButtonElement>('#start')!.disabled, false);
  } finally { dom.window.close(); }
});

test('the extension ships its own icon at every size Chrome uses, for the toolbar too', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  for (const size of ['16', '32', '48', '128']) {
    const path = manifest.icons?.[size];
    assert.equal(path, `icons/icon-${size}.png`);
    const png = readFileSync(new URL(`../public/${path}`, import.meta.url));
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], `${size} is a PNG`);
    assert.equal(png.readUInt32BE(16), Number(size), `${size} has the right width`);
    assert.equal(png.readUInt32BE(20), Number(size), `${size} has the right height`);
  }
  assert.deepEqual(manifest.action.default_icon, { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' });
});
