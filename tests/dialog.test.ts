import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { askSiteAccess, confirmDelete, openDialog } from '../src/dialog.ts';
import { mountSidePanel, type SiteAccess } from '../src/sidepanel-ui.ts';
import type { State } from '../src/recorder.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sheet = (doc: Document) => doc.querySelector<HTMLDialogElement>('dialog.sheet');
const action = (doc: Document, value: string) => doc.querySelector<HTMLButtonElement>(`dialog.sheet [data-action="${value}"]`)!;

test('dialog shows plain text, resolves with the chosen action, then removes itself and restores focus', async () => {
  const dom = new JSDOM('<button id="origin">Origin</button>');
  const doc = dom.window.document;
  doc.querySelector<HTMLButtonElement>('#origin')!.focus();
  const result = openDialog(doc, { title: '<b>Title</b>', body: 'Body <i>text</i>', actions: [{ value: 'yes', label: 'Yes', tone: 'primary' }, { value: 'no', label: 'No' }] });
  const dialog = sheet(doc)!;
  assert.ok(dialog.hasAttribute('open'));
  assert.equal(dialog.querySelector('h2')!.textContent, '<b>Title</b>');
  assert.equal(dialog.querySelectorAll('b, i').length, 0, 'text is never parsed as markup');
  assert.equal(dialog.getAttribute('aria-labelledby'), dialog.querySelector('h2')!.id);
  assert.equal(doc.activeElement, action(doc, 'yes'), 'first action is focused by default');
  action(doc, 'no').click();
  assert.equal(await result, 'no');
  assert.equal(sheet(doc), null);
  assert.equal(doc.activeElement?.id, 'origin');
  dom.window.close();
});

test('Escape and backdrop clicks dismiss without choosing', async () => {
  const dom = new JSDOM('');
  const doc = dom.window.document;
  const escaped = openDialog(doc, { title: 'One', body: 'Body', actions: [{ value: 'ok', label: 'OK' }] });
  const cancel = new dom.window.Event('cancel', { cancelable: true });
  sheet(doc)!.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(await escaped, null);
  const clickedOutside = openDialog(doc, { title: 'Two', body: 'Body', actions: [{ value: 'ok', label: 'OK' }] });
  sheet(doc)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(await clickedOutside, null);
  dom.window.close();
});

test('delete confirmation focuses the safe choice and names what will be removed', async () => {
  const dom = new JSDOM('');
  const doc = dom.window.document;
  const live = confirmDelete(doc, { live: true, steps: 4 });
  assert.match(sheet(doc)!.textContent!, /Discard this capture\?/);
  assert.match(sheet(doc)!.textContent!, /All 4 steps and their screenshots/);
  assert.equal(doc.activeElement, action(doc, 'cancel'));
  assert.equal(action(doc, 'confirm').textContent, 'Discard capture');
  assert.ok(action(doc, 'confirm').classList.contains('danger'));
  action(doc, 'cancel').click();
  assert.equal(await live, false);
  const stopped = confirmDelete(doc, { live: false, steps: 1 });
  assert.match(sheet(doc)!.textContent!, /Delete this recording\?/);
  assert.match(sheet(doc)!.textContent!, /The 1 step and its screenshot/);
  action(doc, 'confirm').click();
  assert.equal(await stopped, true);
  dom.window.close();
});

test('site access sheet requests access synchronously inside the Allow click', async () => {
  const dom = new JSDOM('');
  const doc = dom.window.document;
  let requested = 0;
  const allowed = askSiteAccess(doc, () => { requested++; });
  assert.match(sheet(doc)!.textContent!, /Read and change all your data on all websites/);
  assert.ok(sheet(doc)!.querySelector('svg[aria-hidden="true"]'), 'illustration is decorative');
  action(doc, 'allow').click();
  assert.equal(requested, 1, 'Chrome needs the request inside the click gesture');
  assert.equal(await allowed, 'allow');
  const tabOnly = askSiteAccess(doc, () => { requested++; });
  action(doc, 'tab').click();
  assert.equal(await tabOnly, 'tab');
  assert.equal(requested, 1);
  dom.window.close();
});

function panelHarness(granted: boolean) {
  const dom = new JSDOM('<main id="app"></main>');
  const doc = dom.window.document;
  const root = doc.querySelector<HTMLElement>('#app')!;
  const calls: string[] = [];
  let state: State = { recording: null };
  const request = async (type: string) => {
    calls.push(type);
    if (type === 'START') state = { recording: { tabId: 1, windowId: 1, documentId: 'doc', title: 'T', url: 'https://example.com/', status: 'recording', startedAt: 1, steps: [] } } as State;
    if (type === 'DELETE') state = { recording: null };
    return structuredClone(state);
  };
  let requests = 0;
  const access: SiteAccess = { granted: async () => granted, request: () => { requests++; } };
  return { dom, doc, root, calls, request, access, requests: () => requests };
}

test('Start asks for site access with a styled sheet before Chrome prompts', async () => {
  const h = panelHarness(false);
  await mountSidePanel(h.root, h.request, () => () => {}, () => {}, () => true, () => {}, h.access);
  h.root.querySelector<HTMLButtonElement>('#start')!.click(); await tick();
  assert.ok(sheet(h.doc), 'explains access first');
  assert.deepEqual(h.calls, ['STATUS']);
  sheet(h.doc)!.dispatchEvent(new h.dom.window.Event('cancel', { cancelable: true })); await tick();
  assert.deepEqual(h.calls, ['STATUS'], 'dismissing does not start');
  h.root.querySelector<HTMLButtonElement>('#start')!.click(); await tick();
  action(h.doc, 'allow').click(); await tick();
  assert.equal(h.requests(), 1);
  assert.deepEqual(h.calls, ['STATUS', 'START']);
  h.dom.window.close();
});

test('Only this tab starts without requesting access, and granted access skips the sheet', async () => {
  const declined = panelHarness(false);
  await mountSidePanel(declined.root, declined.request, () => () => {}, () => {}, () => true, () => {}, declined.access);
  declined.root.querySelector<HTMLButtonElement>('#start')!.click(); await tick();
  action(declined.doc, 'tab').click(); await tick();
  assert.equal(declined.requests(), 0);
  assert.deepEqual(declined.calls, ['STATUS', 'START']);
  declined.dom.window.close();
  const granted = panelHarness(true);
  await mountSidePanel(granted.root, granted.request, () => () => {}, () => {}, () => true, () => {}, granted.access);
  granted.root.querySelector<HTMLButtonElement>('#start')!.click(); await tick();
  assert.equal(sheet(granted.doc), null);
  assert.deepEqual(granted.calls, ['STATUS', 'START']);
  granted.dom.window.close();
});

test('discard waits for an asynchronous confirmation and passes what will be removed', async () => {
  const h = panelHarness(true);
  let answer!: (value: boolean) => void;
  const asked: unknown[] = [];
  await mountSidePanel(h.root, h.request, () => () => {}, () => {}, summary => { asked.push(summary); return new Promise<boolean>(resolve => { answer = resolve; }); }, () => {}, h.access);
  h.root.querySelector<HTMLButtonElement>('#start')!.click(); await tick();
  h.root.querySelector<HTMLButtonElement>('#discard')!.click(); await tick();
  assert.deepEqual(asked, [{ live: true, steps: 0 }]);
  assert.deepEqual(h.calls, ['STATUS', 'START']);
  answer(true); await tick();
  assert.deepEqual(h.calls, ['STATUS', 'START', 'DELETE']);
  h.dom.window.close();
});

test('an empty capture is described without counting zero steps', async () => {
  const dom = new JSDOM('');
  const doc = dom.window.document;
  const result = confirmDelete(doc, { live: true, steps: 0 });
  assert.match(sheet(doc)!.textContent!, /No steps have been captured yet/);
  assert.doesNotMatch(sheet(doc)!.textContent!, /0 steps/);
  action(doc, 'cancel').click();
  assert.equal(await result, false);
  dom.window.close();
});
