// Regressions from .scratch/sidekick/audit-verification.md.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fingerprint, findTarget } from '../src/fingerprint.ts';
import { routeToken, routeTokenOf } from '../src/route.ts';
import { mountGuide } from '../src/guide-overlay.ts';
import type { GuideStep, GuideView } from '../src/guide-session.ts';
import { Recorder, type Port, type State, type Step } from '../src/recorder.ts';

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });
const page = (html: string, url: string) => { const dom = new JSDOM(`<body>${html}</body>`, { url, pretendToBeVisual: true }); open.push(dom); return dom; };

const view = (index: number, step: GuideStep, total = 2): GuideView => ({ guideId: 'g', title: 'Guide', index, total, step });
const step = (id: string, extra: Partial<GuideStep> = {}): GuideStep => ({ id, segments: [{ text: 'Do it', bold: false }], tips: [], url: 'https://a.example.com/app', title: 'App', ...extra });
function guide(views: GuideView[], html: string, url: string) {
  const dom = page(html, url);
  let index = 0;
  const calls: string[] = [];
  const g = mountGuide(dom.window as unknown as Window, {
    state: async () => views[index] ?? null,
    next: async () => { calls.push('next'); index++; return views[index] ?? null; },
    back: async () => views[index], exit: async () => {},
  }, { trusted: () => true, findTimeout: 10 });
  return { dom, g, calls, $: (s: string) => g.root.querySelector<HTMLElement>(s)! };
}

test('route tokens are the same in the page and in the worker', () => {
  const dom = page('', 'https://a.example.com/app#/two?x=1');
  assert.equal(routeToken(dom.window as unknown as Window), routeTokenOf('#/two?x=1'));
  assert.equal(routeTokenOf('#/two?x=1'), routeTokenOf('#/two'));
  assert.notEqual(routeTokenOf('#/one'), routeTokenOf('#/two'));
});

test('#1 a Go to step on a hash route needs that route', async () => {
  const goTwo = step('a', { kind: 'page', url: 'https://a.example.com/app', route: routeTokenOf('#/two'), title: 'Two' });
  const h = guide([view(0, goTwo), view(1, step('b'))], '<p>one</p>', 'https://a.example.com/app#/one');
  await h.g.ready; await wait(20);
  assert.deepEqual(h.calls, []);
  assert.match(h.$('.fallback-text').textContent!, /Two/);
  assert.equal(h.$('.open-page').textContent, 'Open the app', 'the link cannot open a hash route, and says so');
  const there = guide([view(0, goTwo), view(1, step('b'))], '<p>two</p>', 'https://a.example.com/app#/two');
  await there.g.ready; await wait(20);
  assert.deepEqual(there.calls, ['next']);
});

test('#1 capture records the route of a page it arrives at', async () => {
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

test('#2 secret controls are found from their minimal fingerprint, and clicking them advances', async () => {
  const html = '<form><input id="user" name="user"><input type="password" id="pw" name="password"><input id="otp" autocomplete="one-time-code"><div contenteditable="true" id="auth-token"></div></form>';
  const dom = page(html, 'https://a.example.com/app');
  const win = dom.window as unknown as Window;
  for (const id of ['pw', 'otp', 'auth-token']) {
    const el = dom.window.document.getElementById(id)!;
    const fp = fingerprint(el, win);
    assert.equal(fp.name, undefined, 'still minimal');
    assert.equal(findTarget(dom.window.document, fp), el, id);
  }
  const pw = fingerprint(dom.window.document.getElementById('pw')!, win);
  const h = guide([view(0, step('a', { target: pw, route: routeTokenOf('') })), view(1, step('b'))], html, 'https://a.example.com/app');
  await h.g.ready; await wait(20);
  assert.equal(h.$('.spot').hidden, false);
  h.dom.window.document.getElementById('pw')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, ['next']);
});

test('#2 a minimal fingerprint does not match an element of another kind', () => {
  const before = page('<form><input type="password" id="pw"></form>', 'https://a.example.com/app');
  const fp = fingerprint(before.window.document.getElementById('pw')!, before.window as unknown as Window);
  const after = page('<form><input type="text" id="pw"></form>', 'https://a.example.com/app');
  assert.equal(findTarget(after.window.document, fp), null);
});

test('#1 the real tab lookup reports the route of the tab address', async () => {
  const previous = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = { tabs: { get: async () => ({ id: 2, windowId: 1, active: true, title: 'App', url: 'https://a.example.com/app#/two?session=x' }) } };
  try {
    const { chromePort } = await import('../src/chrome-port.ts');
    const target = await chromePort.target(2, 1);
    assert.equal(target.url, 'https://a.example.com/app');
    assert.equal(target.route, routeTokenOf('#/two'));
  } finally { (globalThis as { chrome?: unknown }).chrome = previous; }
});
