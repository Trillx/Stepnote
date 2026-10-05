import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as ui from '../src/viewer-ui.ts';
import type { Recording, State, Step } from '../src/recorder.ts';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const shot = 'data:image/jpeg;base64,YQ==';
const step = (id: string, label: string, extra: Partial<Step> = {}): Step => ({ id, label, title: 'Work', url: 'https://example.com/work', x: 200, y: 150, width: 800, height: 600, at: 1, screenshot: shot, ...extra });
function guide(extra: Partial<Recording> = {}): Recording {
  return { tabId: 1, windowId: 1, documentId: 'doc', title: 'Work page', url: 'https://example.com/work', status: 'stopped', startedAt: Date.UTC(2026, 9, 2),
    steps: [step('a', 'Click Save'), { id: 'h', kind: 'header', text: 'Finish up', at: 2 }, step('b', 'Click Done', { text: 'Close the dialog', note: 'Optional.' })], ...extra };
}
// A fake worker that applies the commands the editor sends.
function harness(recording: Recording | null = guide(), options: Partial<ui.ViewerApi> = {}) {
  const dom = new JSDOM('<main id="app"></main>');
  const doc = dom.window.document;
  const root = doc.querySelector<HTMLElement>('#app')!;
  let state: State = { recording, revision: 1 };
  const sent: any[] = [];
  let listener: (state: State) => void = () => {};
  let fail = false;
  const send = async (message: any) => {
    sent.push(message);
    if (fail) throw new Error('Edit not saved: QUOTA_BYTES quota exceeded');
    const r = state.recording!;
    const find = () => r.steps.find(entry => entry.id === message.stepId)!;
    if (message.type === 'EDIT_GUIDE') { if (message.title !== undefined) r.guideTitle = message.title || undefined; if (message.description !== undefined) r.description = message.description || undefined; }
    if (message.type === 'EDIT_STEP') { const e: any = find(); if (message.text !== undefined) e.text = message.text || undefined; if (message.note !== undefined) e.note = message.note || undefined; }
    if (message.type === 'MOVE_STEP') { const e = find(); r.steps = r.steps.filter(x => x !== e); r.steps.splice(message.index, 0, e); }
    if (message.type === 'INSERT_BLOCK') r.steps.splice(message.index, 0, { id: `new-${sent.length}`, kind: message.kind, text: message.text, at: 3 });
    if (message.type === 'DELETE_STEP') r.steps = r.steps.filter(e => e.id !== message.stepId);
    if (message.type === 'EDIT_SHOT') Object.assign(find(), { screenshot: message.screenshot, x: message.x, y: message.y, width: message.width, height: message.height, hideMarker: message.hideMarker || undefined });
    if (message.type === 'STOP') r.status = 'stopped';
    if (message.type === 'DELETE') state = { recording: null };
    state = { ...structuredClone(state), revision: (state.revision ?? 0) + 1 };
    return structuredClone(state);
  };
  const downloads: string[] = [];
  const api: ui.ViewerApi = { send, subscribe: l => { listener = l; return () => {}; }, download: html => { downloads.push(html); }, confirmDelete: () => true, saveDelay: 5, ...options };
  return {
    dom, doc, root, sent, api, downloads,
    mount: () => ui.mountViewer(root, api),
    push: (next: (r: Recording) => void) => { next(state.recording!); state = { ...structuredClone(state), revision: (state.revision ?? 0) + 1 }; listener(structuredClone(state)); },
    failNext: (value: boolean) => { fail = value; },
    $: <T extends Element = HTMLElement>(selector: string) => root.querySelector<T & HTMLElement>(selector)!,
    $$: (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)],
    type: (field: HTMLTextAreaElement, value: string) => { field.focus(); field.value = value; field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); },
    blur: (field: HTMLElement) => { field.blur(); field.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })); },
  };
}

test('editor shows the guide with editable title, description, instructions, notes and unnumbered blocks', async () => {
  const h = harness(); await h.mount();
  assert.equal(h.$('.eyebrow').textContent, 'Stepnote');
  assert.equal(h.$<HTMLTextAreaElement>('#guide-title').value, 'Work page', 'falls back to the captured title');
  assert.equal(h.$<HTMLTextAreaElement>('#guide-description').placeholder, 'Add a description');
  const entries = h.$$('.entry');
  assert.deepEqual(entries.map(e => e.dataset.kind), ['step', 'header', 'step']);
  assert.deepEqual(h.$$('.step-number').map(n => n.textContent), ['1', '2'], 'blocks are not numbered');
  assert.equal(h.$<HTMLTextAreaElement>('[data-id="a"] .step-text').value, 'Click Save');
  assert.equal(h.$<HTMLTextAreaElement>('[data-id="b"] .step-text').value, 'Close the dialog');
  assert.equal(h.$<HTMLTextAreaElement>('[data-id="b"] .step-note').value, 'Optional.');
  assert.equal(h.$<HTMLTextAreaElement>('[data-id="h"] .block-text').value, 'Finish up');
  assert.ok(h.$('[data-id="a"] .marker'));
  assert.match(h.$('#status').textContent!, /Complete: 2 steps/);
  h.dom.window.close();
});

test('typing autosaves after a pause and flushes on blur; the indicator reports Saved', async () => {
  const h = harness(); await h.mount();
  const title = h.$<HTMLTextAreaElement>('#guide-title');
  h.type(title, 'Close a ticket');
  assert.equal(h.$('#save-state').textContent, 'Saving…');
  await tick(20);
  assert.deepEqual(h.sent.at(-1), { type: 'EDIT_GUIDE', title: 'Close a ticket' });
  assert.equal(h.$('#save-state').textContent, 'Saved');
  const note = h.$<HTMLTextAreaElement>('[data-id="a"] .step-note');
  h.type(note, 'Wait for the toast.'); h.blur(note); await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'EDIT_STEP', stepId: 'a', note: 'Wait for the toast.' });
  const count = h.sent.length; await tick(20);
  assert.equal(h.sent.length, count, 'a flushed edit is not sent again');
  h.dom.window.close();
});

test('an edited instruction can be reset to the recorded text', async () => {
  const h = harness(); await h.mount();
  assert.equal(h.$('[data-id="a"] .reset-text').hidden, true);
  const reset = h.$<HTMLButtonElement>('[data-id="b"] .reset-text');
  assert.equal(reset.hidden, false);
  assert.match(reset.title, /Click Done/);
  reset.click(); await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'EDIT_STEP', stepId: 'b', text: '' });
  assert.equal(h.$<HTMLTextAreaElement>('[data-id="b"] .step-text').value, 'Click Done');
  assert.equal(h.$('[data-id="b"] .reset-text').hidden, true);
  h.dom.window.close();
});

test('live updates add steps and refresh fields without overwriting the one being edited', async () => {
  const h = harness(guide({ status: 'recording' })); await h.mount();
  const text = h.$<HTMLTextAreaElement>('[data-id="a"] .step-text');
  h.type(text, 'My unsaved draft');
  h.push(r => { (r.steps[0] as Step).label = 'Click Save now'; (r.steps[2] as Step).note = 'Updated elsewhere'; r.steps.push(step('c', 'Click New')); });
  assert.equal(text.value, 'My unsaved draft');
  assert.equal(h.doc.activeElement, text);
  assert.equal(h.$<HTMLTextAreaElement>('[data-id="b"] .step-note').value, 'Updated elsewhere');
  assert.equal(h.$$('.entry').length, 4);
  assert.deepEqual(h.$$('.step-number').map(n => n.textContent), ['1', '2', '3']);
  assert.match(h.$('#status').textContent!, /Recording: 3 steps/);
  h.dom.window.close();
});

test('entries move up and down, and the first and last cannot move further', async () => {
  const h = harness(); await h.mount();
  assert.equal(h.$<HTMLButtonElement>('[data-id="a"] .move-up').disabled, true);
  assert.equal(h.$<HTMLButtonElement>('[data-id="b"] .move-down').disabled, true);
  h.$<HTMLButtonElement>('[data-id="a"] .move-down').click(); await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'MOVE_STEP', stepId: 'a', index: 1 });
  assert.deepEqual(h.$$('.entry').map(e => e.dataset.id), ['h', 'a', 'b']);
  assert.deepEqual(h.$$('.step-number').map(n => n.textContent), ['1', '2']);
  assert.equal(h.doc.activeElement, h.$('[data-id="a"] .move-down'), 'focus follows the moved entry');
  h.dom.window.close();
});

test('header, tip and alert blocks are inserted at the chosen gap and focused for typing', async () => {
  const h = harness(); await h.mount();
  const gaps = h.$$('.insert');
  assert.equal(gaps.length, 4, 'a gap before each entry and one at the end');
  gaps[1].querySelector<HTMLButtonElement>('.insert-toggle')!.click();
  const menu = gaps[1].querySelector<HTMLElement>('.insert-menu')!;
  assert.equal(menu.hidden, false);
  assert.deepEqual([...menu.querySelectorAll('button')].map(b => b.textContent), ['Header', 'Tip', 'Alert']);
  menu.querySelector<HTMLButtonElement>('[data-kind="tip"]')!.click(); await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'INSERT_BLOCK', kind: 'tip', text: '', index: 1 });
  const tip = h.$$('.entry')[1];
  assert.equal(tip.dataset.kind, 'tip');
  assert.equal(h.doc.activeElement, tip.querySelector('.block-text'));
  assert.equal(menu.hidden, true);
  h.dom.window.close();
});

test('steps and blocks are deleted from the editor', async () => {
  const h = harness(); await h.mount();
  h.$<HTMLButtonElement>('[data-id="h"] .delete-entry').click(); await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'DELETE_STEP', stepId: 'h' });
  assert.deepEqual(h.$$('.entry').map(e => e.dataset.id), ['a', 'b']);
  h.dom.window.close();
});

test('a failed save shows the error and keeps the typed text', async () => {
  const h = harness(); await h.mount();
  h.failNext(true);
  const text = h.$<HTMLTextAreaElement>('[data-id="a"] .step-text');
  h.type(text, 'Kept locally'); h.blur(text); await tick();
  assert.match(h.$('#save-state').textContent!, /Not saved/);
  assert.match(h.$('#error').textContent!, /QUOTA_BYTES/);
  assert.equal(text.value, 'Kept locally');
  h.dom.window.close();
});

test('screenshot edits go through the image editor and save the new image', async () => {
  const edited = { screenshot: 'data:image/jpeg;base64,QkxVUg==', x: 10, y: 10, width: 400, height: 300, hideMarker: true };
  let opened: Step | undefined;
  const h = harness(guide(), { editImage: async s => { opened = s; return edited; } }); await h.mount();
  h.$<HTMLButtonElement>('[data-id="a"] .edit-image').click(); await tick();
  assert.equal(opened?.id, 'a');
  assert.deepEqual(h.sent.at(-1), { type: 'EDIT_SHOT', stepId: 'a', ...edited });
  assert.equal(h.$<HTMLImageElement>('[data-id="a"] img').src, edited.screenshot);
  assert.equal(h.$('[data-id="a"] .marker'), null, 'hidden marker is not drawn');
  const cancelled = harness(guide(), { editImage: async () => null }); await cancelled.mount();
  const before = cancelled.sent.length;
  cancelled.$<HTMLButtonElement>('[data-id="a"] .edit-image').click(); await tick();
  assert.equal(cancelled.sent.length, before);
  assert.equal(cancelled.$('[data-id="h"] .edit-image'), null, 'blocks have no image');
  h.dom.window.close(); cancelled.dom.window.close();
});

test('export menu offers Word, PDF and HTML; delete confirms; complete stops a live capture', async () => {
  let word = 0; let pdf = 0; let confirmed = false;
  const h = harness(guide({ status: 'paused' }), { exportWord: () => { word++; }, printPdf: () => { pdf++; }, confirmDelete: () => confirmed }); await h.mount();
  h.$<HTMLButtonElement>('#export-toggle').click();
  assert.deepEqual([...h.$('#export-menu').querySelectorAll('button')].map(b => b.textContent), ['Word document (.docx)', 'PDF', 'Web page (.html)']);
  h.$<HTMLButtonElement>('[data-export="docx"]').click(); await tick();
  h.$<HTMLButtonElement>('[data-export="pdf"]').click(); await tick();
  h.$<HTMLButtonElement>('[data-export="html"]').click(); await tick();
  assert.deepEqual([word, pdf], [1, 1]);
  assert.match(h.downloads[0], /<!doctype html>/);
  assert.match(h.$('#status').textContent!, /^Paused/);
  h.$<HTMLButtonElement>('#stop').click(); await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'STOP' });
  assert.equal(h.$<HTMLButtonElement>('#stop').hidden, true);
  h.$<HTMLButtonElement>('#delete').click(); await tick();
  assert.notDeepEqual(h.sent.at(-1), { type: 'DELETE' });
  confirmed = true;
  h.$<HTMLButtonElement>('#delete').click(); await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'DELETE' });
  assert.match(h.root.textContent!, /No saved guide/);
  assert.match(h.root.textContent!, /side panel/i);
  h.dom.window.close();
});

test('the editor says how many areas were blurred automatically', async () => {
  const h = harness(guide({ steps: [step('a', 'Click Save', { blurred: 2 }), step('b', 'Click Done', { blurred: 1 }), step('c', 'Click Next')] })); await h.mount();
  assert.equal(h.$('[data-id="a"] .shot-note').textContent, '2 areas blurred automatically.');
  assert.equal(h.$('[data-id="b"] .shot-note').textContent, '1 area blurred automatically.');
  assert.equal(h.$('[data-id="c"] .shot-note'), null);
  h.dom.window.close();
});

test('the editor switches the click marker between circle and box', async () => {
  const h = harness(); await h.mount();
  const select = h.$<HTMLSelectElement>('#marker-style');
  assert.equal(select.value, 'circle');
  assert.equal(h.$('[data-id="a"] .marker').classList.contains('box'), false);
  select.value = 'box'; select.dispatchEvent(new h.dom.window.Event('change'));
  await tick();
  assert.deepEqual(h.sent.at(-1), { type: 'EDIT_GUIDE', markerStyle: 'box' });
  h.push(r => { r.markerStyle = 'box'; });
  assert.equal(h.$('[data-id="a"] .marker').classList.contains('box'), true);
  h.dom.window.close();
});
