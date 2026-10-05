import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/client.ts';
import { route } from '../src/messages.ts';
import { Recorder } from '../src/recorder.ts';
import { chromePort } from '../src/chrome-port.ts';

test('Start binds the UI-selected tab instead of querying a worker current window', async t => {
  const original = globalThis.chrome;
  t.after(() => { globalThis.chrome = original; });
  let queries = 0;
  let saved: unknown;
  let requested: unknown;
  let recorder: Recorder;
  const id = 'owned-extension';
  const tab = { id: 7, windowId: 2, active: true, url: 'https://example.com/work', title: 'Work' };
  globalThis.chrome = {
    windows: { getCurrent: async () => ({ id: 2 }) },
    tabs: {
      query: async () => ++queries === 1 ? [tab] : [],
      get: async (tabId: number) => { assert.equal(tabId, 7); return tab; },
    },
    storage: { local: {
      setAccessLevel: async () => {}, get: async () => ({}),
      set: async (value: unknown) => { saved = value; },
    } },
    scripting: { executeScript: async () => [{ documentId: 'doc-1' }] },
    runtime: { sendMessage: async (message: unknown) => {
      requested = message;
      try { return { ok: true, result: await route(message, { id, url: `chrome-extension://${id}/popup.html` }, id, recorder) }; }
      catch (error) { return { ok: false, error: String(error) }; }
    } },
  } as unknown as typeof chrome;
  recorder = new Recorder(chromePort);
  const state = await request('START');
  assert.deepEqual(requested, { type: 'START', tabId: 7, windowId: 2 });
  assert.equal(queries, 1);
  assert.equal(state.recording?.tabId, 7);
  assert.equal(state.recording?.status, 'recording');
  assert.ok(saved);
});

test('moving a recorded tab between windows never retains an unrelated screenshot', async t => {
  const original = globalThis.chrome;
  t.after(() => { globalThis.chrome = original; });
  for (const moveDuringCapture of [false, true]) {
    let windowId = 2;
    let captures = 0;
    globalThis.chrome = {
      tabs: {
        get: async () => ({ id: 7, windowId, active: true, status: 'complete', url: 'https://example.com/work', title: 'Work' }),
        captureVisibleTab: async () => { captures++; windowId = 3; return 'data:image/jpeg;base64,YQ=='; },
      },
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} } },
      scripting: { executeScript: async () => [{ documentId: 'doc-1' }] },
    } as unknown as typeof chrome;
    const recorder = new Recorder(chromePort);
    await recorder.start(7);
    if (!moveDuringCapture) windowId = 3;
    await recorder.click({ label: 'Click Save', x: 10, y: 20, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' },
      { tabId: 7, frameId: 0, documentId: 'doc-1' });
    const step = (await recorder.status()).recording!.steps[0];
    assert.equal(step.screenshot, undefined);
    assert.match(step.reason!, /Tab or document changed/);
    assert.equal(captures, moveDuringCapture ? 1 : 0);
  }
});
