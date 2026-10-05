import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, type Port, type State, type Step } from '../src/recorder.ts';

// Tabs keyed by id; each has a page and a document. The test moves the clock.
function harness() {
  let saved: State | null = null;
  let clock = 0;
  let focused = 1;
  const tabs = new Map<number, { url: string; title: string; documentId: string }>([[1, { url: 'https://example.com/start', title: 'Start', documentId: 'doc-1' }]]);
  const port: Port = {
    read: async () => structuredClone(saved), write: async state => { saved = structuredClone(state); },
    target: async tabId => { const tab = tabs.get(tabId ?? focused)!; return { tabId: tabId ?? focused, windowId: 1, url: tab.url, title: tab.title }; },
    inject: async tabId => tabs.get(tabId)!.documentId,
    current: async tabId => ({ active: tabId === focused, documentId: tabs.get(tabId)!.documentId }),
    capture: async () => 'data:image/jpeg;base64,YQ==',
    now: () => clock,
  };
  return {
    port,
    tick: (ms: number) => { clock += ms; },
    open: (tabId: number, url: string, title: string) => { tabs.set(tabId, { url, title, documentId: `doc-${tabId}-${url}` }); focused = tabId; },
    navigate: (tabId: number, url: string, title: string) => { tabs.set(tabId, { url, title, documentId: `doc-${tabId}-${url}` }); },
    click: (url: string) => ({ label: 'Click Next', x: 1, y: 1, width: 10, height: 10, url, title: 'T' }),
  };
}
const labels = async (recorder: Recorder) => (await recorder.status()).recording!.steps.map(step => (step as Step).label);

test('switching to another page adds a "Go to" step with its screenshot and no click marker', async () => {
  const h = harness();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  h.tick(10000);
  h.open(2, 'https://example.com/billing', 'Billing settings');
  await recorder.follow(2, true);
  const steps = (await recorder.status()).recording!.steps as Step[];
  assert.deepEqual(steps.map(s => s.label), ['Go to Billing settings']);
  assert.equal(steps[0].kind, 'page');
  assert.equal(steps[0].url, 'https://example.com/billing');
  assert.equal(steps[0].hideMarker, true);
  assert.equal(steps[0].screenshot, 'data:image/jpeg;base64,YQ==');
});

test('navigation right after a recorded click does not add a redundant step', async () => {
  const h = harness();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  await recorder.click(h.click('https://example.com/start'), { tabId: 1, frameId: 0, documentId: 'doc-1' });
  h.tick(1500);
  h.navigate(1, 'https://example.com/next', 'Next page');
  await recorder.follow(1);
  assert.deepEqual(await labels(recorder), ['Click Next']);
});

test('typing an address later, or returning to an earlier tab, adds a step; the same page does not', async () => {
  const h = harness();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  await recorder.click(h.click('https://example.com/start'), { tabId: 1, frameId: 0, documentId: 'doc-1' });
  h.tick(20000);
  h.navigate(1, 'https://example.com/reports', 'Reports');
  await recorder.follow(1);
  h.tick(20000);
  h.open(2, 'https://example.com/help', 'Help');
  await recorder.follow(2, true);
  h.tick(20000);
  h.open(1, 'https://example.com/reports', 'Reports');
  await recorder.follow(1, true);
  assert.deepEqual(await labels(recorder), ['Click Next', 'Go to Reports', 'Go to Help', 'Go to Reports']);
  h.tick(20000);
  await recorder.follow(1);
  assert.equal((await labels(recorder)).length, 4, 'reloading the same page adds nothing');
});

test('page steps are not added while paused', async () => {
  const h = harness();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  await recorder.pause();
  h.tick(20000);
  h.open(2, 'https://example.com/help', 'Help');
  await recorder.follow(2, true);
  assert.deepEqual(await labels(recorder), []);
});
