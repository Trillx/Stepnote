import test from 'node:test';
import assert from 'node:assert/strict';
import * as messages from '../src/messages.ts';

test('content clicks and heartbeats receive no stored recording data', async () => {
  const calls: unknown[] = [];
  const recorder = {
    start: async () => {}, stop: async () => {}, delete: async () => {},
    status: async () => ({ recording: { status: 'recording', tabId: 7, documentId: 'doc-1', steps: ['private'] } } as any),
    click: async (payload: unknown, source: unknown) => { calls.push([payload, source]); },
  };
  const sender = { id, url: 'https://example.com', tab: { id: 7 }, frameId: 0, documentId: 'doc-1' };
  const response = await messages.route({ type: 'CLICK', payload: { label: 'Save' } }, sender, id, recorder);
  assert.deepEqual(response, { active: true, steps: 1 }, 'only a step count, never step data');
  assert.equal(calls.length, 1);
  assert.deepEqual(await messages.route({ type: 'PING' }, { ...sender, documentId: 'old' }, id, recorder), { active: false, steps: 0 });
  await assert.rejects(() => messages.route({ type: 'CLICK' }, { ...sender, id: 'foreign' }, id, recorder), /Untrusted/);
});

const id = 'test-extension';
test('INPUT replies expose only admission status and reject foreign or subframe senders', async () => {
  const calls: unknown[] = [];
  const recorder = { start: async () => {}, stop: async () => {}, delete: async () => {}, click: async () => {}, input: async (payload: unknown, sender: unknown) => { calls.push([payload, sender]); }, status: async () => ({ recording: { status: 'recording', tabId: 7, documentId: 'doc', steps: ['local-only'] } } as any) };
  const sender = { id, tab: { id: 7 }, frameId: 0, documentId: 'doc', url: 'https://example.com/' };
  assert.deepEqual(await messages.route({ type: 'INPUT', payload: { kind: 'type' } }, sender, id, recorder), { active: true, steps: 1 });
  assert.equal(calls.length, 1);
  for (const foreign of [{ ...sender, id: 'foreign' }, { ...sender, frameId: 1 }, { ...sender, url: 'chrome://settings' }, { ...sender, documentId: undefined }]) await assert.rejects(() => messages.route({ type: 'INPUT' }, foreign, id, recorder), /Untrusted/);
  for (const type of ['STATUS', 'STOP', 'PAUSE', 'FINALIZE_INPUT']) await assert.rejects(() => messages.route({ type }, sender, id, recorder), /Untrusted/);
});
const base = `chrome-extension://${id}/`;
test('only owned popup/viewer pages may send control commands or read recording data', async () => {
  assert.equal(typeof messages.route, 'function');
  const calls: string[] = [];
  const recorder = {
    start: async () => { calls.push('start'); },
    stop: async () => { calls.push('stop'); },
    delete: async () => { calls.push('delete'); },
    status: async () => ({ recording: null }),
    click: async () => { calls.push('click'); },
  };
  for (const sender of [
    { id, url: 'https://example.com', tab: { id: 1 }, frameId: 0 },
    { id: 'foreign', url: base + 'popup.html' },
    { id, url: base + 'other.html' },
    { id, url: base + 'popup.html', frameId: 2 },
  ]) {
    for (const type of ['START', 'STOP', 'DELETE', 'STATUS']) {
      await assert.rejects(() => messages.route({ type }, sender, id, recorder), /Untrusted/);
    }
  }
  assert.deepEqual(calls, []);
  const response = await messages.route({ type: 'START', tabId: 7 }, { id, url: base + 'popup.html' }, id, recorder);
  assert.deepEqual(calls, ['start']);
  assert.deepEqual(response, { recording: null });
});
