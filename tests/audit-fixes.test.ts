// Regressions from the 2026-10-02 Sidekick audit (.scratch/sidekick/audit.md).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fingerprint, findTarget } from '../src/fingerprint.ts';
import { describeClick } from '../src/page-click.ts';
import { mountGuide, samePage } from '../src/guide-overlay.ts';
import { guideSteps, type GuideStep, type GuideView } from '../src/guide-session.ts';
import { tidySteps } from '../src/tidy.ts';
import { launcherActions } from '../src/launcher-ui.ts';
import { defaultSettings } from '../src/settings.ts';
import type { Recording, Step } from '../src/recorder.ts';

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });
const page = (html: string, url = 'https://app.example.com/orders') => { const dom = new JSDOM(`<body>${html}</body>`, { url, pretendToBeVisual: true }); open.push(dom); return dom; };

test('#6 fingerprints never keep text typed into editable descendants', () => {
  const dom = page('<label id="customer">Customer <span contenteditable="true">Jane Private</span><textarea>Secret note</textarea></label>');
  const label = dom.window.document.getElementById('customer')!;
  const win = dom.window as unknown as Window;
  const fp = fingerprint(label, win);
  assert.doesNotMatch(JSON.stringify(fp), /Jane Private|Secret note/);
  assert.equal(fp.name, 'Customer');
  const click = describeClick(label, new dom.window.MouseEvent('click'), win);
  assert.doesNotMatch(JSON.stringify(click), /Jane Private|Secret note/);
});

test('#1 a control named by its image is found again', () => {
  const dom = page('<nav><a href="/">Home</a></nav><button><img alt="Save" src="x.png"></button>');
  const button = dom.window.document.querySelector('button')!;
  const fp = fingerprint(button, dom.window as unknown as Window);
  assert.equal(fp.name, 'Save');
  assert.equal(findTarget(dom.window.document, fp), button);
});

const view = (index: number, step: GuideStep, total = 3): GuideView => ({ guideId: 'g', title: 'Guide', index, total, step });
const step = (id: string, extra: Partial<GuideStep> = {}): GuideStep => ({ id, segments: [{ text: 'Do it', bold: false }], tips: [], url: 'https://app.example.com/orders', title: 'Orders', screenshot: 'data:image/jpeg;base64,YQ==', ...extra });
const save = { tag: 'button', role: 'button', name: 'Save', id: 'save', selector: '#save', rect: { x: 0, y: 0, width: 10, height: 10 } };
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

test('#2 a previous step stops listening once the walkthrough moves on', async () => {
  const h = guide([view(0, step('a', { target: save })), view(1, step('b')), view(2, step('c'))], '<button id="save">Save</button>');
  await h.g.ready; await wait(5);
  const button = h.dom.window.document.getElementById('save')!;
  button.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  button.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, ['next'], 'the second click belongs to no step');
});

test('#3 a matching control on another page is not the step', async () => {
  const h = guide([view(0, step('a', { target: save, url: 'https://app.example.com/billing', title: 'Billing' })), view(1, step('b'))], '<button id="save">Save</button>');
  await h.g.ready; await wait(20);
  assert.equal(h.$('.spot').hidden, true);
  assert.match(h.$('.fallback-text').textContent!, /Billing/);
  h.dom.window.document.getElementById('save')!.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, []);
});

test('#3 pages are the same when only record ids in the path differ', () => {
  assert.equal(samePage('https://app.example.com/tickets/48213/edit', 'https://app.example.com/tickets/50000/edit'), true);
  assert.equal(samePage('https://app.example.com/u/3f2b9c1e-7a4d-4e2b-9c1e-7a4d4e2b9c1e', 'https://app.example.com/u/0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6'), true);
  assert.equal(samePage('https://app.example.com/orders', 'https://app.example.com/billing'), false);
  assert.equal(samePage('https://app.example.com/orders', 'https://other.example.com/orders'), false);
  assert.equal(samePage('https://app.example.com/a/1', 'https://app.example.com/a/1/b'), false);
});

test('#4 leaving an editable field after typing finishes the step', async () => {
  const field = { tag: 'div', role: 'textbox', name: 'Description', id: 'desc', selector: '#desc', rect: { x: 0, y: 0, width: 10, height: 10 } };
  const h = guide([view(0, step('a', { kind: 'type', target: field })), view(1, step('b'))], '<div id="desc" contenteditable="true" aria-label="Description"></div>');
  await h.g.ready; await wait(5);
  const desc = h.dom.window.document.getElementById('desc')!;
  desc.dispatchEvent(new h.dom.window.FocusEvent('focusout', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, [], 'leaving without typing is not finishing');
  desc.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  desc.dispatchEvent(new h.dom.window.FocusEvent('focusout', { bubbles: true })); await wait();
  assert.deepEqual(h.calls, ['next']);
});

test('#5 older guides without fingerprints point at the recorded position', async () => {
  const recording = { id: 'g', tabId: 1, windowId: 1, documentId: 'd', title: 'T', url: 'https://app.example.com/orders', status: 'stopped', startedAt: 1,
    steps: [{ id: 'a', label: 'Click Save', title: 'Orders', url: 'https://app.example.com/orders', x: 400, y: 300, width: 800, height: 600, at: 1 } as Step] } as Recording;
  const [legacy] = guideSteps(recording);
  assert.deepEqual(legacy.position, { x: 400, y: 300, width: 800, height: 600 });
  const h = guide([view(0, legacy)], '<p>page</p>');
  await h.g.ready; await wait(5);
  const ring = h.$('.approx');
  assert.equal(ring.hidden, false);
  assert.equal(ring.style.left, `${1024 / 2 - 22}px`, 'scaled to the current window, centred on the click');
  assert.match(h.$('.fallback-text').textContent!, /approximate/i);
});

test('#7 tidy-up only merges or de-duplicates actions on the same page', () => {
  const next = { tag: 'button', role: 'button', name: 'Next', id: 'next', selector: '#next', rect: { x: 0, y: 0, width: 1, height: 1 } };
  const s = (id: string, url: string, at: number): Step => ({ id, label: 'Click Next', url, at, title: 'Wizard', x: 1, y: 1, width: 10, height: 10, target: next });
  const { steps, removed } = tidySteps([s('a', 'https://app.example.com/one', 1000), s('b', 'https://app.example.com/two', 1500)]);
  assert.equal(removed, 0);
  assert.deepEqual(steps.map(e => e.id), ['a', 'b']);
});

test('#8 changing the button setting reaches pages that are already open', () => {
  const tabs = [{ id: 1, url: 'https://mail.google.com/inbox' }, { id: 2, url: 'https://app.example.com/' }, { id: 3, url: 'chrome://settings/' }, { id: 4 }];
  assert.deepEqual(launcherActions(tabs, { ...defaultSettings, launcher: false }, true), [{ tabId: 1, action: 'remove' }, { tabId: 2, action: 'remove' }]);
  assert.deepEqual(launcherActions(tabs, { ...defaultSettings, excludedDomains: ['mail.google.com'] }, true), [{ tabId: 1, action: 'remove' }, { tabId: 2, action: 'inject' }]);
  assert.deepEqual(launcherActions(tabs, defaultSettings, false), [{ tabId: 1, action: 'remove' }, { tabId: 2, action: 'remove' }], 'no site access: remove');
});
