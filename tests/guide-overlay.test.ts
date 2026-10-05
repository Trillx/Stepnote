import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGuide } from '../src/guide-overlay.ts';
import type { GuideView, GuideStep } from '../src/guide-session.ts';

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
