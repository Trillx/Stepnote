import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from '../src/client.ts';
import { route } from '../src/messages.ts';
import { Recorder } from '../src/recorder.ts';
import { chromePort } from '../src/chrome-port.ts';

test('production action opens a native panel without host permission expansion', async () => {
  const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'unlimitedStorage', 'favicon', 'sidePanel'], 'unlimitedStorage only lifts the local storage limit for the guide library');
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>'], 'web access is only requested at Start; captureVisibleTab accepts only <all_urls> or activeTab');
});

test('panel Start uses its own window and validates that identity in the worker', async t => {
  const original = globalThis.chrome;
  t.after(() => { globalThis.chrome = original; });
  const id = 'owned-extension';
  const tab = { id: 7, windowId: 2, active: true, status: 'complete', url: 'https://example.com/work', title: 'Work' };
  let message: any;
  let recorder: Recorder;
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 2 }) },
    tabs: { query: async (query: unknown) => { assert.deepEqual(query, { active: true, windowId: 2 }); return [tab]; }, get: async () => tab },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async () => [{ documentId: 'doc-1' }] },
    runtime: { sendMessage: async (value: unknown) => { message = value; return { ok: true, result: await route(value, { id, url: `chrome-extension://${id}/sidepanel.html` }, id, recorder) }; } },
  } as unknown as typeof chrome;
  recorder = new Recorder(chromePort);
  const state = await request('START');
  assert.deepEqual(message, { type: 'START', tabId: 7, windowId: 2 });
  assert.equal(state.recording?.windowId, 2);
  await recorder.delete();
  await assert.rejects(() => route({ type: 'START', tabId: 7, windowId: 3 }, { id, url: `chrome-extension://${id}/sidepanel.html` }, id, recorder), /window/i);
});

test('panel heartbeat keeps the worker alive without reading images', async () => {
  const id = 'owned-extension';
  const recorder = { start: async () => {}, stop: async () => {}, delete: async () => {}, click: async () => {}, status: async () => { throw new Error('Images must not be read'); } };
  assert.deepEqual(await route({ type: 'KEEP_ALIVE' }, { id, url: `chrome-extension://${id}/sidepanel.html` }, id, recorder), { alive: true });
});

test('panel-only pause, resume, and step deletion reject foreign sources and invalid IDs', async () => {
  const id = 'owned-extension';
  const calls: unknown[] = [];
  const recorder = {
    start: async () => {}, stop: async () => {}, delete: async () => {}, status: async () => ({ recording: null }), click: async () => {},
    pause: async () => { calls.push('pause'); }, resume: async () => { calls.push('resume'); }, deleteStep: async (id: string) => { calls.push(id); },
  };
  const owned = { id, url: `chrome-extension://${id}/sidepanel.html` };
  await route({ type: 'PAUSE' }, owned, id, recorder);
  await route({ type: 'RESUME' }, owned, id, recorder);
  await route({ type: 'DELETE_STEP', stepId: 'step-123' }, owned, id, recorder);
  assert.deepEqual(calls, ['pause', 'resume', 'step-123']);
  for (const stepId of [null, 0, '', 'x'.repeat(101)]) await assert.rejects(() => route({ type: 'DELETE_STEP', stepId }, owned, id, recorder), /Invalid step/i);
  for (const type of ['PAUSE', 'RESUME', 'DELETE_STEP']) await assert.rejects(() => route({ type, stepId: 'step-123' }, { id, url: 'https://example.com', tab: { id: 7 }, frameId: 0 }, id, recorder), /Untrusted/i);
});
