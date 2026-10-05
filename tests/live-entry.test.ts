import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, type State } from '../src/recorder.ts';
import { JSDOM } from 'jsdom';
import { installPageCapture, type PageAction } from '../src/page-capture.ts';
import { mountSidePanel } from '../src/sidepanel-ui.ts';
import { exportHtml } from '../src/sop.ts';

const click = { label: 'Click Save', title: 'Work', url: 'https://example.com/', x: 1, y: 2, width: 800, height: 600 };
const sender = { tabId: 7, frameId: 0, documentId: 'doc' };
function harness() {
  let writes = 0; let captures = 0; let clock = 1000; const updates: State[] = [];
  const port = { read: async () => null, write: async () => { writes++; }, target: async () => ({ tabId: 7, windowId: 2, url: click.url, title: 'Work' }), inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }), capture: async () => { captures++; return 'data:image/jpeg;base64,YQ=='; }, now: () => clock, notify: (state: State) => updates.push(state) };
  return { port, updates, writes: () => writes, captures: () => captures, advance: () => { clock += 1000; } };
}

test('rapid entry updates remain live while an earlier screenshot blocks persistence, with one pending write', async () => {
  const h = harness(); let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: (value: string) => void; const shot = new Promise<string>(resolve => { release = resolve; });
  h.port.capture = async () => { enter(); return shot; };
  const recorder = new Recorder(h.port); await recorder.start();
  const captureId = (await recorder.status()).recording!.captureId;
  const pendingClick = recorder.click(click, sender); await entered;
  const replies: Promise<void>[] = [];
  const baseline = h.writes();
  try {
    for (let sequence = 1; sequence <= 200; sequence++) replies.push(recorder.input({ ...click, label: `Type "${sequence}"`, kind: 'type', actionId: 'entry', captureId, sequence, final: false }, sender));
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(h.updates.at(-1)!.recording!.steps.at(-1)!.label, 'Type "200"', 'The latest update must not wait for the screenshot queue');
    assert.equal(h.writes(), baseline, 'No per-key writes while the queue is held');
    assert.ok(h.updates.length <= 4, 'Rapid updates collapse instead of publishing full images per key');
  } finally { release('data:image/jpeg;base64,YQ=='); await Promise.all([pendingClick, ...replies]); }
  assert.equal(h.writes() - baseline, 2, 'One click write and one coalesced input write');
  assert.deepEqual((await recorder.status()).recording!.steps.map(step => step.label), ['Click Save', 'Type "200"']);
});

test('an accepted Enter final takes its final screenshot even when Pause closes admission behind a held click', async () => {
  const h = harness(); let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: (value: string) => void; const held = new Promise<string>(resolve => { release = resolve; }); let count = 0;
  h.port.capture = async () => { count++; if (count === 1) { enter(); return held; } return 'data:image/jpeg;base64,Yg=='; };
  const recorder = new Recorder(h.port); await recorder.start();
  const captureId = (await recorder.status()).recording!.captureId;
  const pending = recorder.click(click, sender); await entered; h.advance();
  const input = { ...click, kind: 'type', actionId: 'enter-before-pause', captureId, sequence: 1, final: false, label: 'Type "draft"' };
  const draft = recorder.input(input, sender);
  const final = recorder.input({ ...input, sequence: 2, final: true, label: 'Type "latest final"' }, sender);
  Object.assign(h.port, { finalize: async () => [{ ...input, sequence: 2, final: true, label: 'Type "latest final"' }] });
  const paused = recorder.pause(); release('data:image/jpeg;base64,YQ==');
  await Promise.all([pending, draft, final, paused]);
  const step = (await recorder.status()).recording!.steps[1];
  assert.equal(step.label, 'Type "latest final"'); assert.equal(step.final, true);
  assert.equal(step.screenshot, 'data:image/jpeg;base64,Yg==', 'Final screenshot must survive the acknowledged Pause race');
  assert.equal(count, 2);
});

test('failed document validation disarms the page with a notice but never stops or crosses a discarded capture', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const current = h.port.current;
  let release!: (value: { active: boolean; documentId: string }) => void;
  let entered!: () => void; const checking = new Promise<void>(resolve => { entered = resolve; });
  h.port.current = () => { h.port.current = current; return new Promise(resolve => { release = resolve; entered(); }); };
  const discardedCheck = recorder.follow(7);
  const replaced = recorder.delete().then(() => recorder.start());
  await checking; release({ active: false, documentId: 'different' }); await discardedCheck; await replaced;
  const fresh = (await recorder.status()).recording!;
  assert.equal(fresh.status, 'recording', 'Old recording validation must not affect Start');
  assert.equal(fresh.documentId, sender.documentId); assert.equal(fresh.notice, undefined);
  h.port.current = async () => { throw new Error('Permission revoked'); };
  await recorder.follow(7);
  const disarmed = (await recorder.status()).recording!;
  assert.equal(disarmed.status, 'recording'); assert.equal(disarmed.documentId, '');
  assert.match(disarmed.notice!, /web page/);
  await recorder.click(click, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
});

test('old acknowledgements cannot erase the latest outbox revision from finalization', () => {
  const dom = new JSDOM('<input>', { url: 'https://example.com/' }); const messages: PageAction[] = [];
  const capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true, 'arm');
  const field = dom.window.document.querySelector('input')!;
  field.value = 'draft'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  field.value = 'latest'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const first = messages[0].payload as any;
  capture.acknowledge(first.actionId, first.sequence);
  const drained = capture.finalize(); assert.equal(drained.length, 1); assert.equal(drained[0].label, 'Type "latest"'); assert.equal(drained[0].final, true);
  assert.deepEqual(capture.finalize(), []); dom.window.close();
});

test('worker rejects text beyond the 2000-character value cap before persistence', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const input = { ...click, kind: 'type', actionId: 'bounded-entry', captureId: (await recorder.status()).recording!.captureId, sequence: 1, final: false };
  await recorder.input({ ...input, label: `Type "${'x'.repeat(2001)}"` }, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
  await recorder.input({ ...input, label: `Type "${'x'.repeat(2000)}"` }, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 1);
});

test('entry sequences reject reordered drafts and late updates after a final-first delivery', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const input = { ...click, kind: 'type', actionId: 'ordered', captureId: (await recorder.status()).recording!.captureId, label: 'Type "latest"', sequence: 3, final: false };
  await recorder.input(input, sender);
  await recorder.input({ ...input, sequence: 2, label: 'Type "older"' }, sender);
  await recorder.input({ ...input, sequence: 3, label: 'Type "duplicate"' }, sender);
  assert.equal((await recorder.status()).recording!.steps[0].label, 'Type "latest"');
  h.advance(); await recorder.input({ ...input, sequence: 5, final: true, label: 'Type "final"' }, sender);
  await recorder.input({ ...input, sequence: 4, label: 'Type "late pending"' }, sender);
  await recorder.input({ ...input, sequence: 6, label: 'Type "after final"' }, sender);
  h.advance(); await recorder.input({ ...input, actionId: 'final-first', sequence: 9, final: true, label: 'Type "delivered final first"' }, sender);
  await recorder.input({ ...input, actionId: 'final-first', sequence: 1, label: 'Type "late first draft"' }, sender);
  const recording = (await recorder.status()).recording!;
  assert.deepEqual(recording.steps.map(step => [step.label, step.final]), [['Type "final"', true], ['Type "delivered final first"', true]]);
  assert.equal(h.captures(), 2);
  assert.ok(!exportHtml(recording).includes('late pending'));
});

test('deleting a live draft blocks corrections and final drain resurrection', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const input = { ...click, kind: 'type', actionId: 'deleted-live', captureId: (await recorder.status()).recording!.captureId, label: 'Type "draft"', sequence: 1, final: false };
  await recorder.input(input, sender); await recorder.deleteStep('deleted-live');
  await recorder.input({ ...input, sequence: 2, label: 'Type "correction"' }, sender);
  Object.assign(h.port, { finalize: async () => [{ ...input, sequence: 3, final: true, label: 'Type "final deleted"' }] });
  await recorder.stop();
  assert.equal((await recorder.status()).recording!.steps.length, 0);
  assert.equal(h.captures(), 0);
});

test('caret clicks and IME Enter keep the entry, plain Enter starts a new identity on subsequent input', () => {
  const dom = new JSDOM('<input aria-label="Search">', { url: 'https://example.com/' }); const messages: PageAction[] = [];
  const capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true, 'arm');
  const field = dom.window.document.querySelector('input')!;
  function input(value: string) { field.value = value; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true })); }
  input('first'); field.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  input('corrected');
  let entries = messages.filter(m => m.type === 'INPUT');
  assert.equal(entries.length, 2); assert.equal(entries[0].payload.actionId, entries[1].payload.actionId);
  assert.ok(entries.every(m => !m.payload.final));
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); field.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  input('next entry'); entries = messages.filter(m => m.type === 'INPUT');
  assert.equal(entries[2].payload.final, true); assert.equal(entries[2].payload.actionId, entries[0].payload.actionId);
  assert.notEqual(entries[3].payload.actionId, entries[0].payload.actionId);
  input('x'.repeat(2100)); assert.equal((messages.at(-1)!.payload.label.match(/x/g) ?? []).length, 2000);
  capture.cleanup(); dom.window.close();
});

test('mounted card title, final thumbnail, preview and export all use the latest safe snapshot', async () => {
  const dom = new JSDOM('<main></main>'); const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let update!: (state: State) => void; let exported = '';
  const state: State = { revision: 1, recording: { tabId: 7, windowId: 2, documentId: 'doc', url: click.url, title: 'Work', startedAt: 1, status: 'stopped', steps: [{ ...click, id: 'live', kind: 'type', at: 2, label: 'Type "old"', screenshot: 'data:image/jpeg;base64,YQ==' }] } };
  await mountSidePanel(root, async () => structuredClone(state), listener => { update = listener; return () => {}; }, html => { exported = html; }, () => true, () => {});
  const card = root.querySelector<HTMLElement>('.step-card')!;
  state.revision = 2; Object.assign(state.recording!.steps[0], { label: 'Type "<b>latest</b>"', screenshot: 'data:image/jpeg;base64,Yg==', final: true }); update(structuredClone(state));
  assert.equal(root.querySelector('.step-card'), card);
  assert.equal(card.querySelector('h2')!.textContent, 'Type "<b>latest</b>"'); assert.equal(card.querySelector('b'), null);
  card.querySelector<HTMLButtonElement>('.thumbnail')!.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector('#preview-shot img')!.getAttribute('src'), 'data:image/jpeg;base64,Yg==');
  root.querySelector<HTMLButtonElement>('#export')!.click();
  assert.ok(exported.includes('&lt;b&gt;latest&lt;/b&gt;')); assert.ok(!exported.includes('Type &quot;old&quot;'));
  assert.ok(exported.includes('data:image/jpeg;base64,Yg==')); assert.ok(!exported.includes('data:image/jpeg;base64,YQ=='));
  dom.window.close();
});
