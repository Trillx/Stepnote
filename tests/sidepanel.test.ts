import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { State } from '../src/recorder.ts';
import { mountSidePanel } from '../src/sidepanel-ui.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('unexpected stops show Stopped and the reason, while explicit completion stays Complete', async () => {
  const dom = new JSDOM('<main></main>'); const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let update!: (state: State) => void;
  const state: State = { revision: 1, recording: { tabId: 7, windowId: 2, documentId: 'doc', title: 'Work', url: 'https://example.com/', status: 'stopped', stoppedReason: 'Navigation ended recording.', startedAt: 1, steps: [] } };
  await mountSidePanel(root, async () => state, listener => { update = listener; return () => {}; }, () => {}, () => true, () => {});
  assert.match(root.querySelector('#status')!.textContent!, /^Stopped:.*Navigation ended recording/);
  assert.equal(root.dataset.recordingStatus, 'stopped');
  assert.equal(root.querySelector<HTMLButtonElement>('#pause')!.disabled, true);
  state.revision = 2; delete state.recording!.stoppedReason; update(structuredClone(state));
  assert.match(root.querySelector('#status')!.textContent!, /^Complete:/);
  dom.window.close();
});
test('following yields to hover and upward review, including delayed images, and resumes on bottom leave', async () => {
  const dom = new JSDOM('<main></main>'); const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let listener!: (state: State) => void;
  const state: State = { revision: 1, recording: { tabId: 7, windowId: 2, documentId: 'doc', title: 'Work', url: 'https://example.com/', status: 'recording', startedAt: 1, steps: [] } };
  await mountSidePanel(root, async () => state, update => { listener = update; return () => {}; }, () => {}, () => true, () => {});
  const scroll = root.querySelector<HTMLElement>('#steps')!;
  Object.defineProperties(scroll, { scrollHeight: { get: () => 2000 }, clientHeight: { get: () => 500 } });
  const bounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === scroll) return { ...bounds.call(this), top: 0, bottom: 500, height: 500 };
    if (this.classList.contains('step-card')) return { ...bounds.call(this), top: 1880 - scroll.scrollTop, bottom: 1980 - scroll.scrollTop, height: 100 };
    return bounds.call(this);
  };
  function add(id: string) {
    state.recording!.steps.push({ id, at: 2, label: 'Click Save', title: 'Work', url: 'https://example.com/', x: 1, y: 2, width: 800, height: 600, screenshot: 'data:image/jpeg;base64,YQ==' });
    state.revision!++; listener(structuredClone(state));
  }
  scroll.focus(); add('default'); assert.equal(scroll.scrollTop, 1500);
  scroll.dispatchEvent(new dom.window.Event('pointerenter'));
  add('hover'); assert.equal(scroll.scrollTop, 1500, 'Hover suspends following');
  scroll.scrollTop = 20; scroll.dispatchEvent(new dom.window.Event('scroll'));
  add('review'); assert.equal(scroll.scrollTop, 20, 'New steps respect review position');
  root.querySelector('img')!.dispatchEvent(new dom.window.Event('load'));
  assert.equal(scroll.scrollTop, 20, 'Delayed images cannot fight review');
  scroll.dispatchEvent(new dom.window.Event('pointerleave')); add('left-above-bottom');
  assert.equal(scroll.scrollTop, 20, 'Leaving above bottom does not resume');
  scroll.scrollTop = 1500; scroll.dispatchEvent(new dom.window.Event('scroll'));
  scroll.dispatchEvent(new dom.window.Event('pointerenter')); scroll.dispatchEvent(new dom.window.Event('pointerleave'));
  scroll.scrollTop = 0; add('resumed'); assert.equal(scroll.scrollTop, 1500);
  scroll.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 20 }));
  scroll.scrollTop = 200; add('wheel-review'); assert.equal(scroll.scrollTop, 200, 'Wheel review yields before scroll events settle');
  scroll.scrollTop = 1500; scroll.dispatchEvent(new dom.window.Event('pointerenter')); scroll.dispatchEvent(new dom.window.Event('pointerleave'));
  scroll.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown' }));
  scroll.scrollTop = 300; add('keyboard-review'); assert.equal(scroll.scrollTop, 300, 'Keyboard review yields before scroll events settle');
  assert.equal(dom.window.document.activeElement, scroll, 'Following never steals focus');
  dom.window.close();
});
test('default following reveals new identities without focus theft or status-only jumps', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let listener!: (state: State) => void;
  const state: State = { revision: 1, recording: { tabId: 7, windowId: 2, documentId: 'doc', title: 'Work', url: 'https://example.com/', status: 'recording', startedAt: 1, steps: [] } };
  await mountSidePanel(root, async () => structuredClone(state), update => { listener = update; return () => {}; }, () => {}, () => true, () => {});
  const scroll = root.querySelector<HTMLElement>('#steps')!;
  Object.defineProperties(scroll, { scrollHeight: { get: () => 2000 }, clientHeight: { get: () => 500 } });
  const bounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === scroll) return { ...bounds.call(this), top: 0, bottom: 500, height: 500 };
    if (this.classList.contains('step-card')) return { ...bounds.call(this), top: 2380 - scroll.scrollTop, bottom: 2480 - scroll.scrollTop, height: 100 };
    return bounds.call(this);
  };
  scroll.scrollTop = 0; scroll.focus();
  const step = { id: 'new', at: 2, label: 'Click Save', title: 'Work', url: 'https://example.com/', x: 1, y: 2, width: 800, height: 600, screenshot: 'data:image/jpeg;base64,YQ==' };
  state.recording!.steps.push(step); state.revision = 2; listener(structuredClone(state));
  assert.equal(scroll.scrollTop, 2000);
  assert.equal(dom.window.document.activeElement, scroll);
  scroll.scrollTop = 20; state.revision = 3; listener(structuredClone(state));
  assert.equal(scroll.scrollTop, 20, 'Heartbeats must not scroll');
  root.querySelector('img')!.dispatchEvent(new dom.window.Event('load'));
  assert.equal(scroll.scrollTop, 2000, 'A new thumbnail settling must reveal its card');
  scroll.scrollTop = 30; state.recording!.status = 'paused'; state.revision = 4; listener(structuredClone(state));
  assert.equal(scroll.scrollTop, 30);
  listener({ revision: 1, recording: null }); assert.equal(scroll.scrollTop, 30);
  state.recording!.steps = []; state.revision = 5; listener(structuredClone(state));
  assert.equal(scroll.scrollTop, 30, 'Deletion must not scroll');
  dom.window.close();
});
test('late earlier thumbnails also keep the newest identity revealed', async () => {
  const dom = new JSDOM('<main></main>'); const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let listener!: (state: State) => void;
  const state: State = { recording: { tabId: 7, windowId: 2, documentId: 'doc', title: 'Work', url: 'https://example.com/', status: 'recording', startedAt: 1, steps: [] } };
  await mountSidePanel(root, async () => state, update => { listener = update; return () => {}; }, () => {}, () => true, () => {});
  const scroll = root.querySelector<HTMLElement>('#steps')!; let shift = 0;
  Object.defineProperty(scroll, 'clientHeight', { get: () => 500 });
  const bounds = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === scroll) return { ...bounds.call(this), top: 0, bottom: 500, height: 500 };
    if (this.classList.contains('step-card')) return { ...bounds.call(this), top: 1380 + shift - scroll.scrollTop, bottom: 1480 + shift - scroll.scrollTop, height: 100 };
    return bounds.call(this);
  };
  const step = { at: 2, label: 'Click Save', title: 'Work', url: 'https://example.com/', x: 1, y: 2, width: 800, height: 600, screenshot: 'data:image/jpeg;base64,YQ==' };
  state.recording!.steps = [{ ...step, id: 'first' }, { ...step, id: 'latest' }]; listener(structuredClone(state));
  assert.equal(scroll.scrollTop, 1000); shift = 100;
  root.querySelector('img')!.dispatchEvent(new dom.window.Event('load'));
  assert.equal(scroll.scrollTop, 1100);
  dom.window.close();
});

test('an older command response cannot replace newer live cards or exported data', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let listener!: (state: State) => void;
  let resolveStatus!: (state: State) => void;
  let exported = '';
  const status = new Promise<State>(resolve => { resolveStatus = resolve; });
  const mounted = mountSidePanel(root, async () => status, update => { listener = update; return () => {}; }, html => { exported = html; }, () => true, () => {});
  listener({ revision: 2, recording: {
    tabId: 7, windowId: 2, documentId: 'doc', title: 'Latest procedure', url: 'https://example.com/work',
    status: 'stopped', startedAt: 1, steps: [{ id: 'latest', at: 2, label: 'Click Latest', title: 'Work', url: 'https://example.com/work', x: 1, y: 2, width: 800, height: 600 }],
  } } as State);
  resolveStatus({ revision: 1, recording: null } as State);
  await mounted;
  assert.equal(root.querySelectorAll('.step-card').length, 1);
  assert.match(root.querySelector('#status')!.textContent!, /Complete: 1/);
  root.querySelector<HTMLButtonElement>('#export')!.click();
  assert.match(exported, /Click <strong>Latest<\/strong>/);
  dom.window.close();
});

test('panel shows live safe cards, pauses preview, explicitly resumes, completes and confirms deletion', async () => {
  const path = '../src/sidepanel-ui.ts';
  const module = await import(path).catch(() => ({}));
  assert.equal(typeof module.mountSidePanel, 'function');
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let state: State = { recording: null };
  let listener: (state: State) => void = () => {};
  const calls: unknown[] = [];
  let confirm = false;
  let exported = '';
  let opened = false;
  const request = async (type: string, stepId?: string) => {
    calls.push([type, stepId]);
    if (type === 'START') state = { recording: { tabId: 7, windowId: 2, documentId: 'doc', title: '<script>private</script>', url: 'https://example.com/work', status: 'recording', startedAt: 1, steps: [] } };
    if (type === 'PAUSE') state.recording!.status = 'paused';
    if (type === 'RESUME') state.recording!.status = 'recording';
    if (type === 'STOP') state.recording!.status = 'stopped';
    if (type === 'DELETE_STEP') state.recording!.steps = state.recording!.steps.filter(step => step.id !== stepId);
    if (type === 'DELETE') state = { recording: null };
    return structuredClone(state);
  };
  await module.mountSidePanel(root, request, (update: typeof listener) => { listener = update; return () => {}; }, (html: string) => { exported = html; }, () => confirm, () => { opened = true; });
  const button = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!;
  assert.match(root.textContent!, /Saved on this device/);
  assert.match(root.querySelector('.warning')!.textContent!, /saved locally/);
  assert.match(root.textContent!, /sensitive/i);
  assert.equal(root.querySelector<HTMLElement>('.panel-controls')!.hidden, true);
  assert.equal(root.dataset.recordingStatus, 'ready');
  button('#start').click(); await tick();
  assert.match(root.textContent!, /Capturing your screen/);
  assert.equal(root.querySelector<HTMLElement>('.panel-controls')!.hidden, false);
  assert.match(root.querySelector('#location')!.textContent!, /Navigate to.*example.com/);
  state.recording!.steps.push({ id: 'first', at: 2, label: 'Click <img onerror=alert(1)>', title: 'Work', url: 'https://example.com/work', x: 200, y: 100, width: 800, height: 600, screenshot: 'data:image/jpeg;base64,YQ==' });
  listener(structuredClone(state));
  assert.equal(root.querySelectorAll('.step-card').length, 1);
  assert.equal(root.querySelectorAll('script').length, 0);
  assert.equal(root.querySelector('.marker')!.getAttribute('style')!.includes('25%'), true);
  button('.thumbnail').click(); await tick();
  assert.equal(state.recording!.status, 'paused');
  assert.equal(root.querySelector('dialog')!.hasAttribute('open'), true);
  assert.equal(root.dataset.recordingStatus, 'paused');
  button('#close-preview').click(); await tick();
  assert.equal(state.recording!.status, 'paused');
  assert.equal(button('#pause').textContent, 'Resume');
  button('#pause').click(); await tick();
  assert.equal(state.recording!.status, 'recording');
  button('#complete').click(); await tick();
  assert.equal(state.recording!.status, 'stopped');
  button('#view').click(); assert.equal(opened, true);
  button('#export').click(); assert.match(exported, /data:image\/jpeg;base64/);
  button('.delete-step').click(); await tick();
  assert.deepEqual(calls.at(-1), ['DELETE_STEP', 'first']);
  assert.equal(root.querySelectorAll('.step-card').length, 0);
  button('#discard').click(); await tick(); assert.ok(state.recording);
  confirm = true; button('#discard').click(); await tick(); assert.equal(state.recording, null);
  dom.window.close();
});
