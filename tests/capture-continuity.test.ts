import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, type Port, type State } from '../src/recorder.ts';

const sender = { tabId: 7, frameId: 0, documentId: 'original-document' };
const click = { label: 'Click ordinary control', x: 100, y: 100, width: 1000, height: 700, url: 'https://example.test/procedure', title: 'Procedure' };

function quotaPort() {
  let persisted: State | null = null;
  let clock = 1000;
  let calls = 0;
  const image = 'data:image/jpeg;base64,' + 'a'.repeat(2500);
  const limit = 6500; // Two screenshots fit, three exceed quota; metadata still fits.
  const port: Port = {
    read: async () => null,
    write: async state => {
      calls++;
      if (Buffer.byteLength(JSON.stringify(state)) > limit) throw new Error('Resource::kQuotaBytes quota exceeded.');
      persisted = structuredClone(state);
    },
    target: async () => ({ tabId: 7, windowId: 2, url: click.url, title: click.title }),
    inject: async () => sender.documentId,
    current: async () => ({ active: true, documentId: sender.documentId }),
    capture: async () => image,
    now: () => clock += 1000,
  };
  return { port, saved: () => persisted!, calls: () => calls, image };
}

test('a third screenshot exceeding storage quota keeps metadata and capture admission after two persisted steps', async () => {
  const h = quotaPort();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click({ ...click, label: 'Click One' }, sender);
  await recorder.click({ ...click, label: 'Click Two' }, sender);
  assert.equal(h.saved().recording!.steps.length, 2);
  assert.equal(h.saved().recording!.status, 'recording');
  await recorder.click({ ...click, label: 'Click Three' }, sender);
  const state = await recorder.status();
  assert.equal(state.recording!.status, 'recording', 'quota from a new image must not silently disarm otherwise safe capture');
  assert.equal(state.error, undefined);
  assert.deepEqual(h.saved().recording!.steps.map(step => step.label), ['Click One', 'Click Two', 'Click Three']);
  assert.deepEqual(h.saved().recording!.steps.slice(0, 2).map(step => step.screenshot), [h.image, h.image], 'already persisted images must remain untouched');
  assert.equal(h.saved().recording!.steps[2].screenshot, undefined);
  assert.match(h.saved().recording!.steps[2].reason!, /storage.*quota|quota.*storage/i);
  await recorder.click({ ...click, label: 'Click Four' }, sender);
  assert.equal(h.saved().recording!.steps.length, 4, 'content active replies must continue to admit subsequent actions');
  assert.equal((await recorder.status()).recording!.status, 'recording');
});

test('quota fallback must still stop if metadata cannot be persisted', async () => {
  const h = quotaPort(); const recorder = new Recorder(h.port);
  await recorder.start();
  h.port.write = async () => { throw new Error('Resource::kQuotaBytes quota exceeded.'); };
  await recorder.click(click, sender);
  const state = await recorder.status();
  assert.equal(state.recording!.status, 'stopped');
  assert.match(state.error!, /not saved.*quota/i);
  assert.equal(state.recording!.steps[0].screenshot, h.image, 'failed fallback must retain the unsaved image for immediate export');
});

test('finalized live Type image can exceed quota without losing latest text or earlier images', async () => {
  const h = quotaPort(); const recorder = new Recorder(h.port); await recorder.start();
  await recorder.click({ ...click, label: 'Click One' }, sender);
  await recorder.click({ ...click, label: 'Click Two' }, sender);
  const input = { ...click, kind: 'type', actionId: 'live-quota', captureId: (await recorder.status()).recording!.captureId, sequence: 1, final: false, label: 'Type "draft"' };
  await recorder.input(input, sender);
  await recorder.input({ ...input, sequence: 2, final: true, label: 'Type "latest final"' }, sender);
  await recorder.input({ ...input, sequence: 3, label: 'Type "late stale"' }, sender);
  const state = await recorder.status();
  assert.equal(state.recording!.status, 'recording'); assert.equal(state.error, undefined);
  assert.deepEqual(h.saved().recording!.steps.slice(0, 2).map(step => step.screenshot), [h.image, h.image]);
  const step = h.saved().recording!.steps[2];
  assert.equal(step.label, 'Type "latest final"'); assert.equal(step.final, true); assert.equal(step.screenshot, undefined);
  assert.match(step.reason!, /Storage quota/);
});

test('unrelated storage errors must not be treated as recoverable screenshot quota', async () => {
  const h = quotaPort(); const recorder = new Recorder(h.port);
  await recorder.start();
  let writes = 0;
  h.port.write = async () => { writes++; throw new Error('Storage backend unavailable'); };
  await recorder.click(click, sender);
  const state = await recorder.status();
  assert.equal(writes, 1, 'do not retry unrelated write failures');
  assert.equal(state.recording!.status, 'stopped');
  assert.match(state.error!, /not saved.*backend unavailable/i);
  assert.equal(state.recording!.steps[0].screenshot, h.image);
});
