import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, type Port, type State, type Step } from '../src/recorder.ts';
import { routeTokenOf } from '../src/route.ts';

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

const click = { label: 'Click Save', x: 120, y: 50, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' };
// Tabs keyed by id, each set and focused separately; the test moves the clock.
function pages() {
  let saved: State | null = null; let clock = 0; let focused = 1;
  const tabs = new Map([[1, { url: 'https://example.com/start', title: 'Start', documentId: 'doc-1' }]]);
  const p: Port = {
    read: async () => structuredClone(saved), write: async state => { saved = structuredClone(state); },
    target: async tabId => { const t = tabs.get(tabId ?? focused)!; return { tabId: tabId ?? focused, windowId: 1, url: t.url, title: t.title }; },
    inject: async tabId => tabs.get(tabId)!.documentId,
    current: async tabId => ({ active: tabId === focused, documentId: tabs.get(tabId)!.documentId }),
    capture: async () => 'data:image/jpeg;base64,YQ==', now: () => clock,
  };
  return {
    port: p, tick: (ms: number) => { clock += ms; },
    set: (tabId: number, url: string, title: string, documentId: string) => { tabs.set(tabId, { url, title, documentId }); },
    focus: (tabId: number) => { focused = tabId; },
  };
}

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

test('capture records the route of a page it arrives at', async () => {
  let saved: State | null = null; let clock = 0; let focused = 1;
  const tabs = new Map([[1, { url: 'https://a.example.com/app', route: routeTokenOf('#/one'), documentId: 'd1' }]]);
  const port: Port = {
    read: async () => structuredClone(saved), write: async s => { saved = structuredClone(s); },
    target: async tabId => { const t = tabs.get(tabId ?? focused)!; return { tabId: tabId ?? focused, windowId: 1, url: t.url, title: 'App', route: t.route }; },
    inject: async tabId => tabs.get(tabId)!.documentId,
    current: async tabId => ({ active: tabId === focused, documentId: tabs.get(tabId)!.documentId }),
    capture: async () => 'data:image/jpeg;base64,YQ==', now: () => clock,
  };
  const recorder = new Recorder(port); await recorder.start(1, 1);
  clock += 20000;
  tabs.set(2, { url: 'https://a.example.com/app', route: routeTokenOf('#/two'), documentId: 'd2' }); focused = 2;
  await recorder.follow(2, true);
  clock += 20000;
  tabs.set(2, { url: 'https://a.example.com/app', route: routeTokenOf('#/three'), documentId: 'd2' });
  await recorder.follow(2); // same document, new hash route
  const steps = (await recorder.status()).recording!.steps as Step[];
  assert.deepEqual(steps.map(s => [s.kind, s.route]), [['page', routeTokenOf('#/two')], ['page', routeTokenOf('#/three')]]);
});

test('a single-page app route change and a new tab on the same address both add a Go to step', async () => {
  const h = pages();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  h.tick(20000);
  h.set(1, 'https://example.com/reports', 'Reports', 'doc-1'); // same document, new path
  await recorder.follow(1);
  h.tick(20000);
  h.set(2, 'https://example.com/reports', 'Reports', 'doc-2'); h.focus(2); // same address, new tab
  await recorder.follow(2, true);
  const labels = (await recorder.status()).recording!.steps.map(s => (s as Step).label);
  assert.deepEqual(labels, ['Go to Reports', 'Go to Reports']);
});

test('after a click-caused navigation, reloading the destination adds nothing', async () => {
  const h = pages();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  await recorder.click({ ...click, url: 'https://example.com/start' }, { tabId: 1, frameId: 0, documentId: 'doc-1' });
  h.tick(1000);
  h.set(1, 'https://example.com/next', 'Next', 'doc-2');
  await recorder.follow(1);
  h.tick(30000);
  h.set(1, 'https://example.com/next', 'Next', 'doc-3'); // reload
  await recorder.follow(1);
  assert.deepEqual((await recorder.status()).recording!.steps.map(s => (s as Step).label), ['Click Save']);
});

test('switching to an existing tab right after a click adds a step; a tab the click opened does not', async () => {
  const h = pages();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  h.set(2, 'https://example.com/other', 'Other', 'doc-2'); // already open
  await recorder.click({ ...click, url: 'https://example.com/start' }, { tabId: 1, frameId: 0, documentId: 'doc-1' });
  h.tick(1000);
  h.focus(2); await recorder.follow(2, true);
  assert.deepEqual((await recorder.status()).recording!.steps.map(s => (s as Step).label), ['Click Save', 'Go to Other']);
  await recorder.click({ ...click, url: 'https://example.com/other' }, { tabId: 2, frameId: 0, documentId: 'doc-2' });
  h.tick(1000);
  h.set(3, 'https://example.com/opened', 'Opened', 'doc-3');
  recorder.tabOpened(3, 2); // the captured tab opened it
  h.focus(3); await recorder.follow(3, true);
  assert.deepEqual((await recorder.status()).recording!.steps.map(s => (s as Step).label), ['Click Save', 'Go to Other', 'Click Save']);
});

test('a tab the click opened is attributed to that click only on its first visit', async () => {
  const h = pages();
  const recorder = new Recorder(h.port); await recorder.start(1, 1);
  await recorder.click({ ...click, url: 'https://example.com/start' }, { tabId: 1, frameId: 0, documentId: 'doc-1' });
  h.tick(500);
  h.set(2, 'https://example.com/b', 'B', 'doc-2'); recorder.tabOpened(2, 1);
  h.focus(2); await recorder.follow(2, true); // opened by the click: no step
  h.tick(500);
  h.focus(1); await recorder.follow(1, true); // back to A, by hand
  h.tick(500);
  await recorder.click({ ...click, url: 'https://example.com/start' }, { tabId: 1, frameId: 0, documentId: 'doc-1' });
  h.tick(500);
  h.focus(2); await recorder.follow(2, true); // back to B by hand, inside five seconds of opening it
  const labels = (await recorder.status()).recording!.steps.map(s => (s as Step).label);
  assert.deepEqual(labels, ['Click Save', 'Go to Start', 'Click Save', 'Go to B']);
});
