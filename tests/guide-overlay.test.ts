import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fingerprint, findTarget } from '../src/fingerprint.ts';
import { mountGuide, samePage } from '../src/guide-overlay.ts';
import { guideSteps, type GuideView, type GuideStep } from '../src/guide-session.ts';
import type { Recording, Step } from '../src/recorder.ts';
import { routeToken, routeTokenOf } from '../src/route.ts';

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const step = (id: string, extra: Partial<GuideStep> = {}): GuideStep => ({
  id, segments: [{ text: 'Click ', bold: false }, { text: 'Save', bold: true }], tips: [], url: 'https://app.example.com/orders', title: 'Orders',
  screenshot: 'data:image/jpeg;base64,YQ==', ...extra,
});
// Close every page after each test, pass or fail, so overlay timers stop.
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });
function harness(views: GuideView[], html = '<button id="save">Save</button>', url = 'https://app.example.com/orders') {
  const dom = new JSDOM(`<body>${html}</body>`, { url, pretendToBeVisual: true });
  open.push(dom);
  const win = dom.window as unknown as Window;
  let index = 0;
  const calls: string[] = [];
  const api = {
    state: async () => views[index] ?? null,
    next: async () => { calls.push('next'); index++; return views[index] ?? null; },
    back: async () => { calls.push('back'); index = Math.max(0, index - 1); return views[index]; },
    exit: async () => { calls.push('exit'); },
  };
  const guide = mountGuide(win, api, { trusted: () => true, findTimeout: 20 });
  return { dom, win, guide, calls, $: <T extends HTMLElement = HTMLElement>(s: string) => guide.root.querySelector<T>(s)! };
}
const view = (index: number, s: GuideStep, total = 3): GuideView => ({ guideId: 'g1', title: 'Create an order', index, total, step: s });
const saveTarget = { tag: 'button', role: 'button', name: 'Save', id: 'save', selector: '#save', rect: { x: 0, y: 0, width: 10, height: 10 } };

test('the card shows the step, its bold names, tips and note, and walks with Next and Back', async () => {
  const h = harness([
    view(0, step('a', { target: saveTarget, note: 'Top right.', tips: [{ kind: 'header', text: 'Start' }, { kind: 'tip', text: 'Draft first.' }] })),
    view(1, step('b', { segments: [{ text: 'Type the name', bold: false }], kind: 'type' })),
  ]);
  await h.guide.ready;
  assert.equal(h.$('.count').textContent, 'Step 1 of 3');
  assert.equal(h.$('.title').textContent, 'Create an order');
  assert.equal(h.$('.instruction strong').textContent, 'Save');
  assert.equal(h.$('.note').textContent, 'Top right.');
  assert.deepEqual([...h.guide.root.querySelectorAll('.tips p')].map(p => p.textContent), ['Start', 'Tip Draft first.']);
  assert.equal(h.$<HTMLButtonElement>('.back').disabled, true);
  h.$('.next').click(); await wait();
  assert.equal(h.$('.count').textContent, 'Step 2 of 3');
  h.$('.back').click(); await wait();
  assert.equal(h.$('.count').textContent, 'Step 1 of 3');
  assert.deepEqual(h.calls, ['next', 'back']);
  h.dom.window.close();
});

test('the overlay never blocks the page: only the card takes clicks', async () => {
  const h = harness([view(0, step('a', { target: saveTarget }))]);
  await h.guide.ready;
  const host = h.dom.window.document.querySelector<HTMLElement>('[data-stepnote-guide]')!;
  assert.match(host.getAttribute('style')!, /pointer-events:\s*none/);
  assert.equal(h.$('.spot').hidden, false, 'the target is spotlighted');
  h.dom.window.close();
});

test('clicking the real target moves to the next step', async () => {
  const h = harness([view(0, step('a', { target: saveTarget })), view(1, step('b'))]);
  await h.guide.ready; await wait(5);
  h.dom.window.document.getElementById('save')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await wait();
  assert.deepEqual(h.calls, ['next']);
  h.dom.window.close();
});

test('finishing a text field moves on; typing alone does not', async () => {
  const field = { tag: 'input', role: 'textbox', name: 'Customer', id: 'customer', selector: '#customer', rect: { x: 0, y: 0, width: 10, height: 10 } };
  const h = harness([view(0, step('a', { kind: 'type', target: field })), view(1, step('b'))], '<input id="customer" aria-label="Customer">');
  await h.guide.ready; await wait(5);
  const input = h.dom.window.document.getElementById('customer')!;
  input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  await wait();
  assert.deepEqual(h.calls, []);
  input.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  await wait();
  assert.deepEqual(h.calls, ['next']);
  h.dom.window.close();
});

test('when the target is not on the page, the card shows the screenshot and a way to the right page', async () => {
  const h = harness([view(0, step('a', { target: saveTarget, url: 'https://app.example.com/billing', title: 'Billing' }))], '<p>Elsewhere</p>');
  await h.guide.ready; await wait(40);
  assert.equal(h.$('.spot').hidden, true);
  assert.equal(h.$('.fallback').hidden, false);
  assert.match(h.$('.fallback-text').textContent!, /Billing/);
  assert.equal(h.$<HTMLImageElement>('.fallback img').src, 'data:image/jpeg;base64,YQ==');
  assert.equal(h.$<HTMLAnchorElement>('.open-page').href, 'https://app.example.com/billing');
  assert.equal(h.$('.open-page').hidden, false);
  h.dom.window.close();
});

test('a Go to step on the page it names is already done', async () => {
  const h = harness([view(0, step('a', { kind: 'page', segments: [{ text: 'Go to ', bold: false }, { text: 'Orders', bold: true }] })), view(1, step('b'))]);
  await h.guide.ready; await wait(10);
  assert.deepEqual(h.calls, ['next']);
  h.dom.window.close();
});

test('Exit and finishing remove the overlay', async () => {
  const h = harness([view(0, step('a', { target: saveTarget }), 1)]);
  await h.guide.ready;
  assert.equal(h.$('.next').textContent, 'Done');
  h.$('.exit').click(); await wait();
  assert.deepEqual(h.calls, ['exit']);
  assert.equal(h.dom.window.document.querySelector('[data-stepnote-guide]'), null);
  const done = harness([view(0, step('a', { target: saveTarget }), 1)]);
  await done.guide.ready;
  done.$('.next').click(); await wait();
  assert.match(done.$('.instruction').textContent!, /All steps done/);
  h.dom.window.close(); done.dom.window.close();
});

// Minimal walkthroughs: "Do it" steps in a guide of three (plain) or two (pair) steps.
const page = (html: string, url = 'https://app.example.com/orders') => { const dom = new JSDOM(`<body>${html}</body>`, { url, pretendToBeVisual: true }); open.push(dom); return dom; };
function guide(views: GuideView[], html: string, url?: string) {
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
const plainView = (index: number, step: GuideStep, total = 3): GuideView => ({ guideId: 'g', title: 'Guide', index, total, step });
const pairView = (index: number, step: GuideStep, total = 2): GuideView => ({ guideId: 'g', title: 'Guide', index, total, step });
const plainStep = (id: string, extra: Partial<GuideStep> = {}): GuideStep => ({ id, segments: [{ text: 'Do it', bold: false }], tips: [], url: 'https://app.example.com/orders', title: 'Orders', screenshot: 'data:image/jpeg;base64,YQ==', ...extra });
const ordersStep = (id: string, extra: Partial<GuideStep> = {}): GuideStep => ({ id, segments: [{ text: 'Do it', bold: false }], tips: [], url: 'https://a.example.com/orders', title: 'Orders', ...extra });
const appStep = (id: string, extra: Partial<GuideStep> = {}): GuideStep => ({ id, segments: [{ text: 'Do it', bold: false }], tips: [], url: 'https://a.example.com/app', title: 'App', ...extra });

test('a previous step stops listening once the walkthrough moves on', async () => {
  const h = guide([plainView(0, plainStep('a', { target: saveTarget })), plainView(1, plainStep('b')), plainView(2, plainStep('c'))], '<button id="save">Save</button>');
  await h.g.ready; await wait(5);
  const button = h.dom.window.document.getElementById('save')!;
  button.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  button.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, ['next'], 'the second click belongs to no step');
});

test('a matching control on another page is not the step', async () => {
  const h = guide([plainView(0, plainStep('a', { target: saveTarget, url: 'https://app.example.com/billing', title: 'Billing' })), plainView(1, plainStep('b'))], '<button id="save">Save</button>');
  await h.g.ready; await wait(20);
  assert.equal(h.$('.spot').hidden, true);
  assert.match(h.$('.fallback-text').textContent!, /Billing/);
  h.dom.window.document.getElementById('save')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, []);
});

test('pages are the same when only record ids in the path differ', () => {
  assert.equal(samePage('https://app.example.com/tickets/48213/edit', 'https://app.example.com/tickets/50000/edit'), true);
  assert.equal(samePage('https://app.example.com/u/3f2b9c1e-7a4d-4e2b-9c1e-7a4d4e2b9c1e', 'https://app.example.com/u/0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6'), true);
  assert.equal(samePage('https://app.example.com/orders', 'https://app.example.com/billing'), false);
  assert.equal(samePage('https://app.example.com/orders', 'https://other.example.com/orders'), false);
  assert.equal(samePage('https://app.example.com/a/1', 'https://app.example.com/a/1/b'), false);
});

test('only clear record ids may differ between pages', () => {
  assert.equal(samePage('https://a.example.com/wizard/1', 'https://a.example.com/wizard/2'), false);
  assert.equal(samePage('https://a.example.com/settings-v1', 'https://a.example.com/settings-v2'), false);
  assert.equal(samePage('https://a.example.com/reports/2025', 'https://a.example.com/reports/2026'), false, 'years are not record ids');
  assert.equal(samePage('https://a.example.com/tickets/48213/edit', 'https://a.example.com/tickets/50000/edit'), true);
  assert.equal(samePage('https://a.example.com/u/3f2b9c1e-7a4d-4e2b-9c1e-7a4d4e2b9c1e', 'https://a.example.com/u/0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6'), true);
  assert.equal(samePage('https://a.example.com/doc/a8Kz29Qp0LmN7xYt4RwB', 'https://a.example.com/doc/Zq81LmN0p7Ty2XcV9bQe'), true, 'long opaque ids');
});

test('leaving an editable field after typing finishes the step', async () => {
  const field = { tag: 'div', role: 'textbox', name: 'Description', id: 'desc', selector: '#desc', rect: { x: 0, y: 0, width: 10, height: 10 } };
  const h = guide([plainView(0, plainStep('a', { kind: 'type', target: field })), plainView(1, plainStep('b'))], '<div id="desc" contenteditable="true" aria-label="Description"></div>');
  await h.g.ready; await wait(5);
  const desc = h.dom.window.document.getElementById('desc')!;
  desc.dispatchEvent(new h.dom.window.FocusEvent('focusout', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, [], 'leaving without typing is not finishing');
  desc.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  desc.dispatchEvent(new h.dom.window.FocusEvent('focusout', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, ['next']);
});

test('older guides without fingerprints point at the recorded position', async () => {
  const recording = { id: 'g', tabId: 1, windowId: 1, documentId: 'd', title: 'T', url: 'https://app.example.com/orders', status: 'stopped', startedAt: 1,
    steps: [{ id: 'a', label: 'Click Save', title: 'Orders', url: 'https://app.example.com/orders', x: 400, y: 300, width: 800, height: 600, at: 1 } as Step] } as Recording;
  const [legacy] = guideSteps(recording);
  assert.deepEqual(legacy.position, { x: 400, y: 300, width: 800, height: 600 });
  const h = guide([plainView(0, legacy)], '<p>page</p>');
  await h.g.ready; await wait(5);
  const ring = h.$('.approx');
  assert.equal(ring.hidden, false);
  assert.equal(ring.style.left, `${1024 / 2 - 22}px`, 'scaled to the current window, centred on the click');
  assert.match(h.$('.fallback-text').textContent!, /approximate/i);
});

test('a Go to step needs its exact page', async () => {
  const h = guide([pairView(0, ordersStep('a', { kind: 'page', url: 'https://a.example.com/wizard/2', title: 'Step two' })), pairView(1, ordersStep('b'))], '<p>one</p>', 'https://a.example.com/wizard/1');
  await h.g.ready; await wait(20);
  assert.deepEqual(h.calls, []);
});

test('a Go to step on a hash route needs that route', async () => {
  const goTwo = appStep('a', { kind: 'page', url: 'https://a.example.com/app', route: routeTokenOf('#/two'), title: 'Two' });
  const h = guide([pairView(0, goTwo), pairView(1, appStep('b'))], '<p>one</p>', 'https://a.example.com/app#/one');
  await h.g.ready; await wait(20);
  assert.deepEqual(h.calls, []);
  assert.match(h.$('.fallback-text').textContent!, /Two/);
  assert.equal(h.$('.open-page').textContent, 'Open the app', 'the link cannot open a hash route, and says so');
  const there = guide([pairView(0, goTwo), pairView(1, appStep('b'))], '<p>two</p>', 'https://a.example.com/app#/two');
  await there.g.ready; await wait(20);
  assert.deepEqual(there.calls, ['next']);
});

test('a control clicked after the app moved to another page does not count', async () => {
  const save = { tag: 'button', role: 'button', name: 'Save', id: 'save', selector: '#save', rect: { x: 0, y: 0, width: 1, height: 1 } };
  const h = guide([pairView(0, ordersStep('a', { target: save })), pairView(1, ordersStep('b'))], '<button id="save">Save</button>', 'https://a.example.com/orders');
  await h.g.ready; await wait(5);
  h.dom.window.history.pushState({}, '', '/billing');
  h.dom.window.document.getElementById('save')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, []);
});

test('Guide me treats another hash route as another page', async () => {
  const save = { tag: 'button', role: 'button', name: 'Save', id: 'save', selector: '#save', rect: { x: 0, y: 0, width: 1, height: 1 } };
  const two = page('', 'https://a.example.com/app#/two');
  const otherRoute = routeToken(two.window as unknown as Window);
  const h = guide([pairView(0, ordersStep('a', { target: save, url: 'https://a.example.com/app', route: otherRoute }))], '<button id="save">Save</button>', 'https://a.example.com/app#/one');
  await h.g.ready; await wait(20);
  h.dom.window.document.getElementById('save')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, []);
  assert.equal(h.g.root.querySelector<HTMLElement>('.spot')!.hidden, true);
});

test('secret controls are found from their minimal fingerprint, and clicking them advances', async () => {
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
  const h = guide([pairView(0, appStep('a', { target: pw, route: routeTokenOf('') })), pairView(1, appStep('b'))], html, 'https://a.example.com/app');
  await h.g.ready; await wait(20);
  assert.equal(h.$('.spot').hidden, false);
  h.dom.window.document.getElementById('pw')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, ['next']);
});
