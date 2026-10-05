// Regressions from the follow-up audit (.scratch/sidekick/audit-followup.md).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fingerprint } from '../src/fingerprint.ts';
import { describeClick, routeToken } from '../src/page-click.ts';
import { mountGuide, samePage } from '../src/guide-overlay.ts';
import type { GuideStep, GuideView } from '../src/guide-session.ts';
import { Recorder, type Step } from '../src/recorder.ts';

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });
const page = (html: string, url: string) => { const dom = new JSDOM(`<body>${html}</body>`, { url, pretendToBeVisual: true }); open.push(dom); return dom; };

test('#1 only clear record ids may differ between pages', () => {
  assert.equal(samePage('https://a.example.com/wizard/1', 'https://a.example.com/wizard/2'), false);
  assert.equal(samePage('https://a.example.com/settings-v1', 'https://a.example.com/settings-v2'), false);
  assert.equal(samePage('https://a.example.com/reports/2025', 'https://a.example.com/reports/2026'), false, 'years are not record ids');
  assert.equal(samePage('https://a.example.com/tickets/48213/edit', 'https://a.example.com/tickets/50000/edit'), true);
  assert.equal(samePage('https://a.example.com/u/3f2b9c1e-7a4d-4e2b-9c1e-7a4d4e2b9c1e', 'https://a.example.com/u/0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6'), true);
  assert.equal(samePage('https://a.example.com/doc/a8Kz29Qp0LmN7xYt4RwB', 'https://a.example.com/doc/Zq81LmN0p7Ty2XcV9bQe'), true, 'long opaque ids');
});

const view = (index: number, step: GuideStep, total = 2): GuideView => ({ guideId: 'g', title: 'Guide', index, total, step });
const step = (id: string, extra: Partial<GuideStep> = {}): GuideStep => ({ id, segments: [{ text: 'Do it', bold: false }], tips: [], url: 'https://a.example.com/orders', title: 'Orders', ...extra });
function guide(views: GuideView[], html: string, url: string) {
  const dom = page(html, url);
  let index = 0;
  const calls: string[] = [];
  const g = mountGuide(dom.window as unknown as Window, {
    state: async () => views[index] ?? null,
    next: async () => { calls.push('next'); index++; return views[index] ?? null; },
    back: async () => views[index], exit: async () => {},
  }, { trusted: () => true, findTimeout: 10 });
  return { dom, g, calls };
}

test('#1 a Go to step needs its exact page', async () => {
  const h = guide([view(0, step('a', { kind: 'page', url: 'https://a.example.com/wizard/2', title: 'Step two' })), view(1, step('b'))], '<p>one</p>', 'https://a.example.com/wizard/1');
  await h.g.ready; await wait(20);
  assert.deepEqual(h.calls, []);
});

test('#2 a control clicked after the app moved to another page does not count', async () => {
  const save = { tag: 'button', role: 'button', name: 'Save', id: 'save', selector: '#save', rect: { x: 0, y: 0, width: 1, height: 1 } };
  const h = guide([view(0, step('a', { target: save })), view(1, step('b'))], '<button id="save">Save</button>', 'https://a.example.com/orders');
  await h.g.ready; await wait(5);
  h.dom.window.history.pushState({}, '', '/billing');
  h.dom.window.document.getElementById('save')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, []);
});

test('#3 route tokens tell hash routes apart without storing them', () => {
  const one = page('<button>Next</button>', 'https://a.example.com/app#/one?session=abc');
  const oneAgain = page('<button>Next</button>', 'https://a.example.com/app#/one?session=xyz');
  const two = page('<button>Next</button>', 'https://a.example.com/app#/two');
  const token = (dom: JSDOM) => routeToken(dom.window as unknown as Window);
  assert.match(token(one), /^[0-9a-f]{8}$/);
  assert.equal(token(one), token(oneAgain), 'fragment queries are ignored');
  assert.notEqual(token(one), token(two));
  const click = describeClick(one.window.document.querySelector('button')!, new one.window.MouseEvent('click'), one.window as unknown as Window);
  assert.equal(click.route, token(one));
  assert.doesNotMatch(JSON.stringify(click), /#\/one|session|abc/);
});

test('#3 tidy-up keeps consecutive clicks on different hash routes', async () => {
  let saved: any = null;
  const recorder = new Recorder({
    read: async () => structuredClone(saved), write: async v => { saved = structuredClone(v); },
    target: async () => ({ tabId: 1, windowId: 1, url: 'https://a.example.com/app', title: 'App' }),
    inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }),
    capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000, tidy: () => true,
  });
  await recorder.start();
  const next = (url: string) => { const dom = page('<button id="next">Next</button>', url); return describeClick(dom.window.document.getElementById('next')!, new dom.window.MouseEvent('click'), dom.window as unknown as Window); };
  await recorder.click(next('https://a.example.com/app#/one'), { tabId: 1, frameId: 0, documentId: 'doc' });
  await recorder.click(next('https://a.example.com/app#/two'), { tabId: 1, frameId: 0, documentId: 'doc' });
  await recorder.stop();
  const r = (await recorder.status()).recording!;
  assert.equal(r.steps.length, 2);
  assert.equal(r.tidied, undefined);
  assert.equal((r.steps[0] as Step).route?.length, 8);
});

test('#3 Guide me treats another hash route as another page', async () => {
  const save = { tag: 'button', role: 'button', name: 'Save', id: 'save', selector: '#save', rect: { x: 0, y: 0, width: 1, height: 1 } };
  const two = page('', 'https://a.example.com/app#/two');
  const otherRoute = routeToken(two.window as unknown as Window);
  const h = guide([view(0, step('a', { target: save, url: 'https://a.example.com/app', route: otherRoute }))], '<button id="save">Save</button>', 'https://a.example.com/app#/one');
  await h.g.ready; await wait(20);
  h.dom.window.document.getElementById('save')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, []);
  assert.equal(h.g.root.querySelector<HTMLElement>('.spot')!.hidden, true);
});

test('#4 recognized secret fields keep only tag, type, selector and position', () => {
  const dom = page('<div contenteditable="true" id="auth-token" aria-label="Token" title="Paste token" data-testid="token-box"></div><input type="password" id="pw" name="password" data-testid="pw" placeholder="Password">', 'https://a.example.com/');
  const win = dom.window as unknown as Window;
  for (const el of [dom.window.document.getElementById('auth-token')!, dom.window.document.getElementById('pw')!]) {
    const fp = fingerprint(el, win);
    assert.deepEqual(Object.keys(fp).sort(), el.id === 'pw' ? ['attrs', 'rect', 'selector', 'tag'] : ['rect', 'selector', 'tag']);
    if (el.id === 'pw') assert.deepEqual(fp.attrs, { type: 'password' });
  }
});
