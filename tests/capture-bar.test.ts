import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCaptureBar } from '../src/capture-bar.ts';
import { Recorder } from '../src/recorder.ts';
import * as messages from '../src/messages.ts';

test('the on-page bar shows the step count and pauses or completes the capture', () => {
  const dom = new JSDOM('<body></body>', { url: 'https://example.com/' });
  const calls: string[] = [];
  const bar = mountCaptureBar(dom.window as unknown as Window, { pause: () => { calls.push('pause'); }, complete: () => { calls.push('complete'); } }, { trusted: () => true });
  const host = dom.window.document.querySelector<HTMLElement>('[data-stepnote-ui]')!;
  assert.match(host.getAttribute('style')!, /pointer-events:\s*none/);
  bar.setCount(3);
  assert.equal(bar.root.querySelector('.count')!.textContent, '3 steps');
  bar.setCount(1);
  assert.equal(bar.root.querySelector('.count')!.textContent, '1 step');
  bar.root.querySelector<HTMLButtonElement>('.pause')!.click();
  bar.root.querySelector<HTMLButtonElement>('.complete')!.click();
  assert.deepEqual(calls, ['pause', 'complete']);
  bar.hide();
  assert.equal(host.style.visibility, 'hidden');
  bar.show();
  assert.equal(host.style.visibility, '');
  bar.destroy();
  assert.equal(dom.window.document.querySelector('[data-stepnote-ui]'), null);
  dom.window.close();
});

test('controls are hidden for exactly the moment of each screenshot', async () => {
  const order: string[] = [];
  let saved: any = null;
  const recorder = new Recorder({
    read: async () => structuredClone(saved), write: async v => { saved = structuredClone(v); },
    target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/', title: 'T' }),
    inject: async () => 'doc-1', current: async () => ({ active: true, documentId: 'doc-1' }),
    capture: async () => { order.push('capture'); return 'data:image/jpeg;base64,YQ=='; }, now: () => 1000,
    beforeCapture: async () => { order.push('hide'); }, afterCapture: async () => { order.push('show'); },
  });
  await recorder.start();
  await recorder.click({ label: 'Click Save', x: 1, y: 1, width: 10, height: 10, url: 'https://example.com/', title: 'T' }, { tabId: 7, frameId: 0, documentId: 'doc-1' });
  assert.deepEqual(order, ['hide', 'capture', 'show']);
});

test('only the captured document can pause or complete from the page', async () => {
  const id = 'ext';
  const calls: string[] = [];
  const recorder = {
    start: async () => {}, delete: async () => {}, click: async () => {},
    stop: async () => { calls.push('stop'); }, pause: async () => { calls.push('pause'); },
    status: async () => ({ recording: { status: 'recording', tabId: 7, documentId: 'doc-1', steps: [{}, {}] } } as any),
  };
  const page = (documentId: string, tabId = 7) => ({ id, url: 'https://example.com/', tab: { id: tabId }, frameId: 0, documentId });
  const route = (type: string, sender = page('doc-1'), controls = true) => messages.route({ type }, sender, id, recorder, undefined, undefined, { captureControls: () => controls });
  assert.deepEqual(await route('CAPTURE_CONTROLS'), { show: true, steps: 2 });
  assert.deepEqual(await route('CAPTURE_CONTROLS', page('doc-1'), false), { show: false, steps: 2 });
  assert.deepEqual(await route('CAPTURE_CONTROLS', page('old')), { show: false, steps: 0 });
  await route('CAPTURE_PAUSE');
  await route('CAPTURE_STOP');
  await route('CAPTURE_PAUSE', page('old'));
  await route('CAPTURE_STOP', page('doc-1', 8));
  assert.deepEqual(calls, ['pause', 'stop']);
  assert.deepEqual(await route('CLICK'), { active: true, steps: 2 }, 'replies carry the step count for the bar');
});
