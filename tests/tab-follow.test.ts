import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, type Port, type State } from '../src/recorder.ts';

const click = { label: 'Click Open', x: 10, y: 10, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' };

// A small browser model: tabs with documents, one focused tab, and listeners.
function browser() {
  let saved: State | null = null;
  let documents = 0;
  let clock = 0;
  const tabs = new Map<number, { windowId: number; url: string; complete: boolean; documentId: string; armed?: string }>();
  let focused = 7;
  const injected: number[] = [];
  const finalized: string[] = [];
  const add = (tabId: number, url: string, windowId = 2, complete = true) => {
    tabs.set(tabId, { windowId, url, complete, documentId: `doc-${++documents}` });
  };
  add(7, 'https://example.com/work');
  const port: Port = {
    read: async () => structuredClone(saved),
    write: async state => { saved = structuredClone(state); },
    target: async tabId => {
      const tab = tabs.get(tabId!);
      if (!tab || tabId !== focused || !/^https?:/.test(tab.url)) throw new Error('Open a normal HTTP or HTTPS page.');
      return { tabId: tabId!, windowId: tab.windowId, url: tab.url, title: 'Page' };
    },
    inject: async (tabId, captureId) => {
      const tab = tabs.get(tabId)!;
      if (!/^https?:/.test(tab.url)) throw new Error('Cannot access contents of the page.');
      tab.armed = captureId; injected.push(tabId); return tab.documentId;
    },
    current: async (tabId, windowId, allowLoading = false) => {
      const tab = tabs.get(tabId);
      if (!tab || !/^https?:/.test(tab.url)) throw new Error('Cannot access contents of the page.');
      return { active: tabId === focused && tab.windowId === windowId && (allowLoading || tab.complete), documentId: tab.documentId };
    },
    capture: async () => 'data:image/jpeg;base64,YQ==',
    finalize: async recording => {
      finalized.push(recording.documentId);
      const tab = [...tabs.values()].find(t => t.documentId === recording.documentId);
      if (tab) tab.armed = undefined;
      return [];
    },
    now: () => clock += 1000,
  };
  return {
    port, tabs, injected, finalized, add, saved: () => saved!,
    focus(tabId: number) { focused = tabId; },
    navigate(tabId: number, url: string, complete = true) {
      const tab = tabs.get(tabId)!;
      Object.assign(tab, { url, complete, documentId: `doc-${++documents}`, armed: undefined });
    },
    sender(tabId: number) { return { tabId, frameId: 0, documentId: tabs.get(tabId)!.documentId }; },
  };
}

test('a newly opened and focused tab is followed and keeps capturing with screenshots', async () => {
  const b = browser();
  // A finer clock than the harness default: the click and the tab it opens are
  // moments apart, while screenshots stay past the 650 ms limit.
  let time = 0; b.port.now = () => (time += 200);
  const recorder = new Recorder(b.port); await recorder.start(7, 2);
  await recorder.click(click, b.sender(7));
  b.add(8, 'https://example.com/report', 2, false); recorder.tabOpened(8, 7); b.focus(8); // the click opened it
  await recorder.follow(8, true);
  assert.equal((await recorder.status()).recording!.status, 'recording');
  assert.deepEqual(b.finalized, ['doc-1'], 'the previous document listener is drained and removed');
  b.tabs.get(8)!.complete = true;
  await recorder.follow(8);
  const state = await recorder.status();
  assert.equal(state.recording!.tabId, 8);
  assert.equal(state.recording!.documentId, b.tabs.get(8)!.documentId);
  assert.equal(b.tabs.get(8)!.armed, state.recording!.captureId);
  await recorder.click({ ...click, label: 'Click Report', url: 'https://example.com/report' }, b.sender(8));
  const steps = (await recorder.status()).recording!.steps;
  assert.deepEqual(steps.map(step => step.label), ['Click Open', 'Click Report']);
  assert.equal(steps[1].screenshot, 'data:image/jpeg;base64,YQ==');
  await recorder.click(click, b.sender(7));
  assert.equal((await recorder.status()).recording!.steps.length, 2, 'the tab left behind no longer adds steps');
});

test('switching back to an earlier tab re-arms it with a fresh capture identity', async () => {
  const b = browser(); const recorder = new Recorder(b.port); await recorder.start(7, 2);
  const first = (await recorder.status()).recording!.captureId;
  b.add(8, 'https://example.com/other'); b.focus(8); await recorder.follow(8, true);
  b.focus(7); await recorder.follow(7, true);
  const state = (await recorder.status()).recording!;
  assert.equal(state.tabId, 7);
  assert.notEqual(state.captureId, first);
  assert.deepEqual(b.injected, [7, 8, 7]);
});

test('full navigation and reload in the followed tab continue capture in the new document', async () => {
  const b = browser(); const recorder = new Recorder(b.port); await recorder.start(7, 2);
  b.navigate(7, 'https://example.com/next', false);
  await recorder.follow(7);
  assert.equal((await recorder.status()).recording!.status, 'recording');
  assert.equal((await recorder.status()).recording!.documentId, '', 'a loading document is not armed yet');
  await recorder.click(click, b.sender(7));
  assert.equal((await recorder.status()).recording!.steps.length, 0);
  b.tabs.get(7)!.complete = true; await recorder.follow(7);
  await recorder.click({ ...click, url: 'https://example.com/next' }, b.sender(7));
  assert.deepEqual((await recorder.status()).recording!.steps.map(step => step.kind ?? 'click'), ['page', 'click'], 'arriving without a click adds a Go to step');
  const injections = b.injected.length;
  await recorder.follow(7);
  assert.equal(b.injected.length, injections, 'an unchanged document is never reinjected');
});

test('an uncapturable focused tab shows a notice, then capture continues on a web tab', async () => {
  const b = browser(); const recorder = new Recorder(b.port); await recorder.start(7, 2);
  b.add(9, 'chrome://settings/'); b.focus(9); await recorder.follow(9, true);
  let state = (await recorder.status()).recording!;
  assert.equal(state.status, 'recording');
  assert.match(state.notice!, /web page/i);
  await recorder.click(click, b.sender(7));
  assert.equal((await recorder.status()).recording!.steps.length, 0);
  b.focus(7); await recorder.follow(7, true);
  state = (await recorder.status()).recording!;
  assert.equal(state.notice, undefined);
  await recorder.click(click, b.sender(7));
  assert.equal((await recorder.status()).recording!.steps.length, 1);
});

test('updates from a tab that is not followed are ignored', async () => {
  const b = browser(); const recorder = new Recorder(b.port); await recorder.start(7, 2);
  b.add(8, 'https://example.com/background', 3);
  await recorder.follow(8);
  assert.equal((await recorder.status()).recording!.tabId, 7);
  assert.deepEqual(b.injected, [7]);
});

test('paused capture tracks the focused tab without listening and Resume arms it', async () => {
  const b = browser(); const recorder = new Recorder(b.port); await recorder.start(7, 2);
  await recorder.pause();
  b.add(8, 'https://example.com/paused'); b.focus(8); await recorder.follow(8, true);
  assert.deepEqual(b.injected, [7], 'pause never installs listeners');
  assert.equal((await recorder.status()).recording!.status, 'paused');
  await recorder.resume();
  const state = (await recorder.status()).recording!;
  assert.equal(state.status, 'recording'); assert.equal(state.tabId, 8);
  await recorder.click(click, b.sender(8));
  assert.equal((await recorder.status()).recording!.steps.length, 1);
});

test('closing the followed tab waits for the next focused tab instead of stopping', async () => {
  const b = browser(); const recorder = new Recorder(b.port); await recorder.start(7, 2);
  b.add(8, 'https://example.com/after'); b.tabs.delete(7);
  await recorder.closed(7);
  assert.equal((await recorder.status()).recording!.status, 'recording');
  b.focus(8); await recorder.follow(8, true);
  await recorder.click(click, b.sender(8));
  assert.deepEqual((await recorder.status()).recording!.steps.map(step => step.kind ?? 'click'), ['page', 'click']);
});
