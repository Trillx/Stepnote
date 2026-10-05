// Regressions from the 2026-10-02 review of the local-features change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Library, type Store } from '../src/library.ts';
import { Recorder, type Port, type State, type Step } from '../src/recorder.ts';
import * as messages from '../src/messages.ts';
import { findSensitive, mappableTransform } from '../src/sensitive.ts';
import { mountViewer } from '../src/viewer-ui.ts';

const click = { label: 'Click Save', x: 120, y: 50, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' };
const sender = { tabId: 7, frameId: 0, documentId: 'doc-1' };
function memoryStore(): Store {
  const data = new Map<string, unknown>();
  return {
    get: async keys => Object.fromEntries(keys.filter(k => data.has(k)).map(k => [k, structuredClone(data.get(k))])),
    set: async items => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); },
    remove: async keys => { for (const k of keys) data.delete(k); },
  };
}
function port(library?: Library) {
  let saved: State | null = null;
  let gate: Promise<void> | undefined;
  let slow = 0;
  const p: Port = {
    read: async () => structuredClone(saved),
    write: async state => {
      if (gate) { const wait = gate; gate = undefined; await wait; throw new Error('QUOTA_BYTES quota exceeded'); }
      if (slow) { const ms = slow; slow = 0; await new Promise(resolve => setTimeout(resolve, ms)); }
      saved = structuredClone(state);
    },
    target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/work', title: 'Work' }),
    inject: async () => 'doc-1', current: async () => ({ active: true, documentId: 'doc-1' }),
    capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000,
    ...(library ? { archive: (recording, revision) => library.put(recording, revision) } : {}),
  };
  // The next write waits for `release`, then fails.
  const failNextWrite = () => { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); return () => release(); };
  return { port: p, failNextWrite, slowNextWrite: (ms: number) => { slow = ms; } };
}

test('deleting a guide while a new capture starts deletes that guide, not the new capture', async () => {
  const id = 'ext'; const viewer = { id, url: `chrome-extension://${id}/viewer.html?guide=x`, frameId: 0 };
  const library = new Library(memoryStore(), () => 1);
  const h = port(library);
  const recorder = new Recorder(h.port);
  await recorder.start(); await recorder.click(click, sender); await recorder.stop();
  const first = (await recorder.status()).recording!.id!;
  // Busy queue: the router's lookup waits on it, a Start is queued behind it,
  // and the lookup answers before that Start runs.
  h.slowNextWrite(20);
  const busy = recorder.edit({ type: 'EDIT_GUIDE', description: 'busy' });
  const deleting = messages.route({ type: 'DELETE_GUIDE', guideId: first }, viewer, id, recorder, library);
  await new Promise(resolve => setTimeout(resolve, 5));
  const starting = recorder.start();
  await busy;
  await Promise.all([deleting, starting]);
  const active = (await recorder.status()).recording!;
  assert.notEqual(active.id, first, 'the new capture survives');
  assert.equal(active.status, 'recording');
  await assert.rejects(() => library.get(first), /not found/, 'the named guide is gone');
});

test('an edit to a guide that was filed meanwhile goes to the library, not the new capture', async () => {
  const id = 'ext'; const viewer = { id, url: `chrome-extension://${id}/viewer.html?guide=x`, frameId: 0 };
  const library = new Library(memoryStore(), () => 1);
  const h = port(library);
  const recorder = new Recorder(h.port);
  await recorder.start(); await recorder.stop();
  const first = (await recorder.status()).recording!.id!;
  h.slowNextWrite(20);
  const busy = recorder.edit({ type: 'EDIT_GUIDE', description: 'busy' });
  const editing = messages.route({ type: 'EDIT_GUIDE', guideId: first, title: 'Renamed' }, viewer, id, recorder, library);
  await new Promise(resolve => setTimeout(resolve, 5));
  const starting = recorder.start();
  await busy;
  await Promise.all([editing, starting]);
  assert.equal((await recorder.status()).recording!.guideTitle, undefined);
  assert.equal((await library.get(first)).recording.guideTitle, 'Renamed');
});

// jsdom has no layout: an element's box comes from its data-box attribute (x,y,w,h).
function layout(dom: JSDOM) {
  return (target: Element | Range) => {
    const node = target instanceof dom.window.Range ? target.startContainer.parentElement! : target as Element;
    const host = (node.closest('[data-box]') ?? node) as Element;
    const [x, y, width, height] = (host.getAttribute('data-box') ?? '0,0,10,10').split(',').map(Number);
    return [{ x, y, width, height } as DOMRect];
  };
}
test('automatic blur looks inside shadow roots and same-origin frames, and blurs frames it cannot read', () => {
  const dom = new JSDOM('<body><div id="host" data-box="10,10,300,20"></div><iframe id="same" data-box="0,100,400,200"></iframe><iframe id="other" data-box="500,100,300,200"></iframe><iframe id="hidden" data-box="0,0,0,0"></iframe></body>', { pretendToBeVisual: true });
  const win = dom.window as unknown as Window;
  Object.defineProperty(win, 'innerWidth', { value: 1000 }); Object.defineProperty(win, 'innerHeight', { value: 600 });
  const shadow = dom.window.document.getElementById('host')!.attachShadow({ mode: 'closed' });
  shadow.innerHTML = '<p data-box="10,10,300,20">Owner: jane@example.com</p>';
  const inner = new JSDOM('<body><p data-box="20,30,200,20">Card 4111 1111 1111 1111</p><input type="password" data-box="20,150,100,20"></body>');
  const regions = findSensitive(win, {
    measure: (target: Element | Range) => {
      const owner = target instanceof inner.window.Range ? target.startContainer.ownerDocument : (target as Element).ownerDocument;
      return owner === inner.window.document ? layout(inner)(target) : layout(dom)(target);
    },
    shadowRoot: element => element.id === 'host' ? shadow : null,
    frameDocument: frame => frame.id === 'same' ? inner.window.document : null,
  });
  const boxes = regions.boxes.map(b => [b.x, b.y, b.width, b.height]);
  assert.deepEqual(boxes, [
    [10, 10, 300, 20], // shadow text
    [20, 250, 100, 20], // frame password field, offset by the frame
    [20, 130, 200, 20], // frame text
    [500, 100, 300, 200], // unreadable frame, blurred whole
  ]);
  dom.window.close(); inner.window.close();
});

test('export waits for a save that is already running', async () => {
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  let state: State = { revision: 1, recording: { id: 'g', tabId: 1, windowId: 1, documentId: 'd', title: 'Old title', url: 'https://example.com/', status: 'stopped', startedAt: 1, steps: [] } };
  const downloads: string[] = [];
  await mountViewer(root, {
    send: async (message: any) => {
      if (message.type === 'EDIT_GUIDE') {
        await new Promise(resolve => setTimeout(resolve, 30));
        state = { ...structuredClone(state), revision: 2 }; state.recording!.guideTitle = message.title;
      }
      return structuredClone(state);
    },
    download: html => { downloads.push(html); }, confirmDelete: () => true, saveDelay: 5,
  });
  const title = root.querySelector<HTMLTextAreaElement>('#guide-title')!;
  title.focus(); title.value = 'New title'; title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  title.blur(); title.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
  root.querySelector<HTMLButtonElement>('#export-toggle')!.click();
  root.querySelector<HTMLButtonElement>('[data-export="html"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(downloads.length, 1);
  assert.match(downloads[0], /<title>New title<\/title>/);
  dom.window.close();
});

test('a failed reorder keeps clicks captured while it was saving', async () => {
  const h = port();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click({ ...click, label: 'Click One' }, sender);
  await recorder.click({ ...click, label: 'Click Two' }, sender);
  const [one, two] = (await recorder.status()).recording!.steps.map(s => s.id!);
  const release = h.failNextWrite();
  const moving = recorder.edit({ type: 'MOVE_STEP', stepId: two, index: 0 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const arriving = recorder.click({ ...click, label: 'Click Three' }, sender); // admitted while the move is saving
  release();
  await assert.rejects(moving, /Edit not saved/);
  await arriving;
  const steps = (await recorder.status()).recording!.steps as Step[];
  assert.deepEqual(steps.map(s => s.label), ['Click One', 'Click Two', 'Click Three']);
  assert.deepEqual(steps.slice(0, 2).map(s => s.id), [one, two]);
});

// Tabs keyed by id; the test moves the clock.
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

// Second review.
test('frame content is mapped through the frame scale; frames that cannot be mapped are blurred whole', () => {
  const dom = new JSDOM('<body><iframe id="scaled" data-box="0,100,400,200"></iframe><iframe id="rotated" data-box="500,100,300,200"></iframe></body>', { pretendToBeVisual: true });
  const win = dom.window as unknown as Window;
  Object.defineProperty(win, 'innerWidth', { value: 1000 }); Object.defineProperty(win, 'innerHeight', { value: 600 });
  const inner = new JSDOM('<body><input type="email" value="me@example.com" data-box="10,20,80,10"></body>');
  const regions = findSensitive(win, {
    measure: (target: Element | Range) => {
      const owner = target instanceof inner.window.Range ? target.startContainer.ownerDocument : (target as Element).ownerDocument;
      return owner === inner.window.document ? layout(inner)(target) : layout(dom)(target);
    },
    frameDocument: () => inner.window.document,
    // The scaled frame is drawn at twice its layout size; the rotated one cannot be mapped.
    frameScale: frame => frame.id === 'scaled' ? { x: 2, y: 2 } : null,
  });
  assert.deepEqual(regions.boxes.map(b => [b.x, b.y, b.width, b.height]), [[20, 140, 160, 20], [500, 100, 300, 200]]);
  dom.window.close(); inner.window.close();
});

test('commands for a guide answer about that guide, and Complete cannot stop a newer capture', async () => {
  const id = 'ext'; const viewer = { id, url: `chrome-extension://${id}/viewer.html?guide=x`, frameId: 0 };
  const library = new Library(memoryStore(), () => 1);
  const h = port(library);
  const recorder = new Recorder(h.port);
  await recorder.start(); await recorder.stop();
  const a = (await recorder.status()).recording!.id!;
  // Delete A while B starts right behind it: the reply is about A (gone), not B.
  h.slowNextWrite(20);
  const busy = recorder.edit({ type: 'EDIT_GUIDE', description: 'busy' });
  const deleting = messages.route({ type: 'DELETE_GUIDE', guideId: a }, viewer, id, recorder, library);
  await new Promise(resolve => setTimeout(resolve, 5));
  const starting = recorder.start();
  await busy; await starting;
  assert.equal(((await deleting) as State).recording, null);
  const b = (await recorder.status()).recording!.id!;
  assert.notEqual(b, a);
  // An editor still showing A sends Complete for A: B keeps recording.
  const stopped = await messages.route({ type: 'STOP', guideId: a }, viewer, id, recorder, library) as State;
  assert.equal((await recorder.status()).recording!.status, 'recording');
  assert.notEqual(stopped.recording?.id, b);
  await messages.route({ type: 'STOP', guideId: b }, viewer, id, recorder, library);
  assert.equal((await recorder.status()).recording!.status, 'stopped');
});

test('an edit reply is about the edited guide even if a capture starts right after it', async () => {
  const id = 'ext'; const viewer = { id, url: `chrome-extension://${id}/viewer.html?guide=x`, frameId: 0 };
  const library = new Library(memoryStore(), () => 1);
  const h = port(library);
  const recorder = new Recorder(h.port);
  await recorder.start(); await recorder.stop();
  const a = (await recorder.status()).recording!.id!;
  h.slowNextWrite(20);
  const editing = messages.route({ type: 'EDIT_GUIDE', guideId: a, title: 'Renamed' }, viewer, id, recorder, library);
  await new Promise(resolve => setTimeout(resolve, 5));
  const starting = recorder.start();
  const reply = await editing as State; await starting;
  assert.equal(reply.recording!.id, a);
  assert.equal(reply.recording!.guideTitle, 'Renamed');
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

// Third review.
test('only positive axis-aligned scale and movement can be mapped; any other transform blurs the frame whole', () => {
  const none = { transform: 'none', rotate: 'none', scale: 'none', offsetPath: 'none' };
  assert.equal(mappableTransform(none), true);
  assert.equal(mappableTransform({ ...none, transform: 'matrix(2, 0, 0, 2, 10, 20)' }), true);
  assert.equal(mappableTransform({ ...none, scale: '2 1.5' }), true);
  assert.equal(mappableTransform({ ...none, transform: 'matrix(-1, 0, 0, 1, 0, 0)' }), false, 'mirrored');
  assert.equal(mappableTransform({ ...none, transform: 'matrix(0, 1, -1, 0, 0, 0)' }), false, 'rotated');
  assert.equal(mappableTransform({ ...none, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1)' }), false, '3D');
  assert.equal(mappableTransform({ ...none, rotate: '90deg' }), false, 'rotate property');
  assert.equal(mappableTransform({ ...none, rotate: '0deg' }), true);
  assert.equal(mappableTransform({ ...none, scale: '-1 1' }), false, 'mirrored by the scale property');
  assert.equal(mappableTransform({ ...none, offsetPath: 'path("M0,0 L100,100")' }), false, 'motion path');
  assert.equal(mappableTransform({ ...none, transform: 'garbage(' }), false, 'unparseable');
});

test('a guide deletion that fails to save reports the error and keeps the guide', async () => {
  const id = 'ext'; const viewer = { id, url: `chrome-extension://${id}/viewer.html?guide=x`, frameId: 0 };
  const library = new Library(memoryStore(), () => 1);
  const h = port(library);
  const recorder = new Recorder(h.port);
  await recorder.start(); await recorder.stop();
  const a = (await recorder.status()).recording!.id!;
  const release = h.failNextWrite(); release();
  const reply = await messages.route({ type: 'DELETE_GUIDE', guideId: a }, viewer, id, recorder, library) as State;
  assert.equal(reply.recording?.id, a, 'the guide is still there');
  assert.match(reply.error!, /Deletion failed/);
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
