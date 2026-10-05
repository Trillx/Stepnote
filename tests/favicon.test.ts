import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { Recorder, type Port, type State } from '../src/recorder.ts';
import { Library, summarize } from '../src/library.ts';
import { mountLibrary } from '../src/library-ui.ts';
import type { GuideSummary } from '../src/library.ts';

const png = 'data:image/png;base64,iVBORw0KGgo=';
function port(favicon: Port['favicon']) {
  let saved: State | null = null;
  return {
    read: async () => structuredClone(saved), write: async (s: State) => { saved = structuredClone(s); },
    target: async () => ({ tabId: 1, windowId: 1, url: 'https://app.example.com/orders', title: 'Orders' }),
    inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }),
    capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000, favicon,
  } as Port;
}

test('a capture keeps the icon of the page it started on', async () => {
  const asked: string[] = [];
  const recorder = new Recorder(port(async url => { asked.push(url); return png; }));
  await recorder.start(1, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(asked, ['https://app.example.com/orders']);
  assert.equal((await recorder.status()).recording!.favicon, png);
});

test('a missing, failing or unexpected icon never blocks a capture', async () => {
  for (const favicon of [undefined, async () => { throw new Error('no icon'); }, async () => 'data:text/html;base64,PGI+', async () => 'data:image/png;base64,' + 'A'.repeat(70000), async () => 'https://evil.example/x.png']) {
    const recorder = new Recorder(port(favicon as Port['favicon']));
    await recorder.start(1, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    const r = (await recorder.status()).recording!;
    assert.equal(r.status, 'recording');
    assert.equal(r.favicon, undefined);
  }
});

test('guide summaries carry the saved icon', () => {
  const summary = summarize({ id: 'g', tabId: 1, windowId: 1, documentId: 'd', title: 'T', url: 'https://app.example.com/', status: 'stopped', startedAt: 1, steps: [], favicon: png }, 1);
  assert.equal(summary.favicon, png);
});

test('guide rows show the site icon; older guides ask Chrome; a broken icon falls back to the letter', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  const guides: GuideSummary[] = [
    { id: 'saved', title: 'Sales Order', steps: 2, startedAt: 1, updatedAt: 3, search: '', host: 'rivercityind.fulcrumpro.com', favicon: png },
    { id: 'old', title: 'Change orders', steps: 1, startedAt: 1, updatedAt: 2, search: '', host: 'app.example.com' },
    { id: 'none', title: 'Notes', steps: 1, startedAt: 1, updatedAt: 1, search: '' },
  ];
  await mountLibrary(root, { list: async () => guides, open: () => {}, faviconFor: host => `chrome-extension://x/_favicon/?pageUrl=https%3A%2F%2F${host}&size=32` });
  const avatar = (id: string) => root.querySelector<HTMLElement>(`[data-id="${id}"] .guide-avatar`)!;
  assert.equal(avatar('saved').querySelector('img')!.getAttribute('src'), png);
  assert.equal(avatar('saved').querySelector('img')!.getAttribute('alt'), '');
  assert.match(avatar('old').querySelector('img')!.getAttribute('src')!, /_favicon\/\?pageUrl=https%3A%2F%2Fapp\.example\.com/);
  assert.equal(avatar('none').querySelector('img'), null);
  assert.equal(avatar('none').textContent, 'N');
  avatar('old').querySelector('img')!.dispatchEvent(new dom.window.Event('error'));
  assert.equal(avatar('old').querySelector('img'), null);
  assert.equal(avatar('old').textContent, 'A', 'falls back to the site letter');
  dom.window.close();
});

test('the manifest asks for Chrome\'s favicon access', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('favicon'));
});

test('the editor shows the site icon beside "Captured on"', async () => {
  const { mountViewer } = await import('../src/viewer-ui.ts');
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  const recording = { id: 'g', tabId: 1, windowId: 1, documentId: 'd', title: 'Orders', url: 'https://app.example.com/', status: 'stopped', startedAt: 1, steps: [], favicon: png };
  await mountViewer(root, { send: async () => ({ recording, revision: 1 }) as State, download: () => {}, confirmDelete: () => true });
  const meta = root.querySelector('#guide-meta')!;
  assert.equal(meta.querySelector('img')!.getAttribute('src'), png);
  assert.match(meta.textContent!, /Captured on app\.example\.com/);
  dom.window.close();
});
