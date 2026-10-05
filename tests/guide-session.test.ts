import test from 'node:test';
import assert from 'node:assert/strict';
import { GuideSessions, guideSteps } from '../src/guide-session.ts';
import * as messages from '../src/messages.ts';
import type { Recording } from '../src/recorder.ts';

const step = (id: string, label: string, extra: object = {}) => ({ id, label, title: 'Orders', url: 'https://app.example.com/orders', x: 1, y: 1, width: 10, height: 10, at: 1, screenshot: 'data:image/jpeg;base64,YQ==', ...extra });
const recording: Recording = {
  id: 'g1', tabId: 1, windowId: 1, documentId: 'd', title: 'Orders', guideTitle: 'Create an order', url: 'https://app.example.com/orders', status: 'stopped', startedAt: 1,
  steps: [
    { id: 'h', kind: 'header', text: 'Start', at: 1 },
    step('a', 'Click New order', { target: { tag: 'button', name: 'New order', selector: '#new', rect: { x: 0, y: 0, width: 1, height: 1 } } }),
    { id: 't', kind: 'tip', text: 'Use the customer number.', at: 2 },
    { id: 'blank', kind: 'alert', text: '  ', at: 2 },
    step('b', 'Type "42"', { kind: 'type', text: 'Enter the **customer** number', note: 'Six digits.' }),
    step('c', 'Go to Review', { kind: 'page', url: 'https://app.example.com/review', hideMarker: true }),
  ],
};

test('a guide becomes walkthrough steps; tips and headers ride along on the next step', () => {
  const steps = guideSteps(recording);
  assert.deepEqual(steps.map(s => s.id), ['a', 'b', 'c']);
  assert.deepEqual(steps[0].tips, [{ kind: 'header', text: 'Start' }]);
  assert.deepEqual(steps[1].tips, [{ kind: 'tip', text: 'Use the customer number.' }], 'blank blocks are skipped');
  assert.deepEqual(steps[1].segments, [{ text: 'Enter the ', bold: false }, { text: 'customer', bold: true }, { text: ' number', bold: false }]);
  assert.equal(steps[1].note, 'Six digits.');
  assert.equal(steps[0].target?.name, 'New order');
  assert.equal(steps[2].kind, 'page');
});

function sessions() {
  const store = new Map<string, unknown>();
  const injected: number[] = [];
  const s = new GuideSessions({
    load: async id => { if (id !== 'g1') throw new Error('Guide not found.'); return structuredClone(recording); },
    inject: async tabId => { injected.push(tabId); },
    read: async () => (store.get('sessions') as Record<string, { guideId: string; index: number }>) ?? {},
    write: async value => { store.set('sessions', structuredClone(value)); },
  });
  return { s, injected, store };
}

test('a walkthrough starts in a tab, moves step by step, and ends after the last step', async () => {
  const { s, injected } = sessions();
  let view: Awaited<ReturnType<typeof s.move>> = await s.start('g1', 5);
  assert.deepEqual([view!.index, view!.total, view!.title, view!.step.id], [0, 3, 'Create an order', 'a']);
  assert.deepEqual(injected, [5]);
  view = await s.move(5, -1);
  assert.equal(view!.index, 0, 'Back stops at the first step');
  view = await s.move(5, 1); view = await s.move(5, 1);
  assert.equal(view!.step.id, 'c');
  assert.equal(await s.move(5, 1), null, 'Next on the last step finishes');
  assert.equal(await s.view(5), null);
});

test('a page load in the walkthrough tab brings the overlay back; other tabs are left alone', async () => {
  const { s, injected } = sessions();
  await s.start('g1', 5);
  await s.loaded(5); await s.loaded(6);
  assert.deepEqual(injected, [5, 5]);
  await s.exit(5);
  await s.loaded(5);
  assert.deepEqual(injected, [5, 5]);
  await s.closed(5);
});

test('walkthroughs survive the worker restarting', async () => {
  const first = sessions();
  await first.s.start('g1', 5); await first.s.move(5, 1);
  const again = new GuideSessions({
    load: async () => structuredClone(recording), inject: async () => {},
    read: async () => first.store.get('sessions') as Record<string, { guideId: string; index: number }>, write: async () => {},
  });
  assert.equal((await again.view(5))!.step.id, 'b');
});

test('only the walkthrough tab can drive it; only the side panel can start one', async () => {
  const id = 'ext';
  const { s } = sessions();
  const recorder = { start: async () => {}, stop: async () => {}, delete: async () => {}, click: async () => {}, status: async () => ({ recording: null }) };
  const panel = { id, url: `chrome-extension://${id}/sidepanel.html`, frameId: 0 };
  const page = (tabId: number) => ({ id, url: 'https://app.example.com/orders', tab: { id: tabId }, frameId: 0, documentId: 'doc' });
  const started = await messages.route({ type: 'GUIDE_START', guideId: 'g1', tabId: 5 }, panel, id, recorder, undefined, s) as { index: number };
  assert.equal(started.index, 0);
  assert.equal(((await messages.route({ type: 'GUIDE_NEXT' }, page(5), id, recorder, undefined, s)) as any).index, 1);
  assert.equal(((await messages.route({ type: 'GUIDE_STATE' }, page(5), id, recorder, undefined, s)) as any).step.id, 'b');
  assert.equal(await messages.route({ type: 'GUIDE_STATE' }, page(6), id, recorder, undefined, s), null, 'another tab sees no walkthrough');
  await assert.rejects(() => messages.route({ type: 'GUIDE_START', guideId: 'g1', tabId: 6 }, page(6), id, recorder, undefined, s), /Untrusted/);
  await assert.rejects(() => messages.route({ type: 'GUIDE_NEXT' }, { ...page(5), frameId: 2 }, id, recorder, undefined, s), /Untrusted/);
  assert.equal(await messages.route({ type: 'GUIDE_EXIT' }, page(5), id, recorder, undefined, s), null);
  assert.equal(await s.view(5), null);
});
