import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Recorder } from '../src/recorder.ts';
import { chromePort } from '../src/chrome-port.ts';
import { route } from '../src/messages.ts';
import { installPageCapture, type PageAction } from '../src/page-capture.ts';
import { mountSidePanel } from '../src/sidepanel-ui.ts';

test('focused editing publishes one live card immediately and updates its identity across idle gaps', async () => {
  const dom = new JSDOM('<input aria-label="Search"><main></main>', { url: 'https://example.com/' });
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  let update!: (state: any) => void;
  let captures = 0;
  const recorder = new Recorder({ read: async () => null, write: async () => {}, target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/', title: 'Work' }), inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }), capture: async () => { captures++; return 'data:image/jpeg;base64,YQ=='; }, now: () => Date.now(), notify: state => update(state) });
  await mountSidePanel(root, async () => recorder.status(), listener => { update = listener; return () => {}; }, () => {}, () => true, () => {});
  await recorder.start();
  const replies: Promise<void>[] = [];
  const capture = installPageCapture(dom.window as unknown as Window, message => {
    if (message.type === 'INPUT') replies.push(recorder.input(message.payload, { tabId: 7, frameId: 0, documentId: 'doc' }));
  }, () => true, (await recorder.status()).recording!.captureId);
  try {
    const field = dom.window.document.querySelector('input')!;
    field.value = 'Hello'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    assert.equal(root.querySelector('.step-card h2')?.textContent, 'Type "Hello"', 'First trusted input must publish before any idle timeout');
    const card = root.querySelector<HTMLElement>('.step-card')!;
    await new Promise(resolve => setTimeout(resolve, 450));
    field.value = 'Hello everyone'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    await Promise.all(replies);
    assert.equal(root.querySelectorAll('.step-card').length, 1);
    assert.equal(root.querySelector('.step-card'), card, 'Corrections keep the mounted card');
    assert.equal(card.querySelector('h2')!.textContent, 'Type "Hello everyone"');
    assert.equal(captures, 0, 'Live input must not take early screenshots');
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.all(replies);
    assert.equal((await recorder.status()).recording!.steps.length, 1);
    assert.equal(captures, 1, 'Only the final entry takes a screenshot');
    assert.equal(card.querySelector('img')!.getAttribute('src'), 'data:image/jpeg;base64,YQ==');
  } finally { capture.cleanup(); dom.window.close(); }
});

test('listener injection binds the capture identity and script to the same original document', async t => {
  const original = globalThis.chrome; t.after(() => { globalThis.chrome = original; });
  const calls: any[] = [];
  globalThis.chrome = { scripting: { executeScript: async (options: any) => { calls.push(options); return [{ documentId: 'original-doc' }]; } } } as unknown as typeof chrome;
  assert.equal(await chromePort.inject(7, 'arm'), 'original-doc');
  assert.deepEqual(calls[0].args, ['arm']);
  assert.deepEqual(calls[1].target, { tabId: 7, documentIds: ['original-doc'] });
  assert.deepEqual(calls[1].files, ['content.js']);
});

test('text finalization targets the original document and requires an acknowledgement', async t => {
  const original = globalThis.chrome; t.after(() => { globalThis.chrome = original; });
  const calls: unknown[] = [];
  let response: unknown = { actions: [] };
  globalThis.chrome = { tabs: { sendMessage: async (...args: unknown[]) => { calls.push(args); return response; } } } as unknown as typeof chrome;
  const recording: any = { tabId: 7, windowId: 2, documentId: 'doc' };
  assert.deepEqual(await chromePort.finalize!(recording, 1000), []);
  assert.deepEqual(calls, [[7, { type: 'FINALIZE_INPUT', cutoff: 1000 }, { documentId: 'doc', frameId: 0 }]]);
  response = undefined;
  await assert.rejects(() => chromePort.finalize!(recording, 1000), /acknowledge/);
});
test('blur and Enter finalize entry before the next field click, including paste and clear', () => {
  const dom = new JSDOM('<input aria-label="Search"><textarea aria-label="Notes"></textarea>', { url: 'https://example.com/' });
  const messages: PageAction[] = [];
  const capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true);
  const input = dom.window.document.querySelector('input')!;
  const notes = dom.window.document.querySelector('textarea')!;
  input.value = 'pasted text'; input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  input.dispatchEvent(new dom.window.FocusEvent('blur'));
  assert.deepEqual(messages.map(m => [m.payload.label, (m.payload as any).final]), [['Type "pasted text"', false], ['Type "pasted text"', true]]);
  assert.equal((messages[0].payload as any).actionId, (messages[1].payload as any).actionId);
  notes.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  notes.value = 'note'; notes.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  notes.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  assert.equal(messages.length, 4, 'Shift+Enter continues multiline entry');
  notes.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal((messages.at(-1)!.payload as any).final, true, 'Plain Enter finalizes multiline entry');
  input.value = ''; input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(messages.filter(m => m.type === 'CLICK' || m.payload.final).map(m => m.payload.label), ['Type "pasted text"', 'Click the "Notes" field', 'Type "note"', 'Clear the "Search" field']);
  capture.cleanup(); dom.window.close();
});

test('synthetic input is ignored and excluded controls never read values', async () => {
  const dom = new JSDOM('<input id="ordinary"><input type="password"><input autocomplete="one-time-code"><input name="cardNumber"><input type="hidden"><input type="number"><input id="api-key"><input autocomplete="username">', { url: 'https://example.com/' });
  const messages: PageAction[] = [];
  let capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message));
  const ordinary = dom.window.document.querySelector<HTMLInputElement>('#ordinary')!;
  ordinary.value = 'synthetic'; ordinary.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(messages.length, 0);
  capture.cleanup();
  capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true);
  for (const field of [...dom.window.document.querySelectorAll('input')].slice(1)) {
    Object.defineProperty(field, 'value', { get: () => { throw new Error('Excluded value must never be read'); } });
    field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  }
  await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(messages.length, 0);
  capture.cleanup(); dom.window.close();
});

test('IME only publishes committed content and repeated unchanged input is coalesced', async () => {
  const dom = new JSDOM('<div contenteditable="true" aria-label="Description"></div>', { url: 'https://example.com/' });
  const messages: PageAction[] = [];
  const capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true);
  const field = dom.window.document.querySelector('div')!;
  field.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  field.textContent = 'half'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, isComposing: true }));
  await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(messages.length, 0);
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  assert.equal(messages.length, 0);
  field.textContent = '日本語'; field.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(messages.map(m => m.payload.label), ['Type "日本語"']);
  field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  field.dispatchEvent(new dom.window.FocusEvent('blur'));
  assert.equal(messages.length, 2, 'Blur publishes the final revision of the same entry');
  assert.equal((messages[0].payload as any).actionId, (messages[1].payload as any).actionId);
  assert.equal((messages[1].payload as any).final, true);
  capture.cleanup(); dom.window.close();
});

test('unacknowledged entries drain once while INPUT replies await the control queue', { timeout: 2000 }, async () => {
  const dom = new JSDOM('<input aria-label="Search">', { url: 'https://example.com/' });
  let capture: ReturnType<typeof installPageCapture>;
  let entered!: () => void; const capturing = new Promise<void>(resolve => { entered = resolve; });
  let release!: (value: string) => void; const image = new Promise<string>(resolve => { release = resolve; });
  const recorder = new Recorder({ read: async () => null, write: async () => {}, target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/', title: 'Work' }), inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }), capture: async () => { entered(); return image; }, now: () => Date.now(), finalize: async () => capture.finalize() });
  await recorder.start();
  const sender = { id: 'test', tab: { id: 7 }, frameId: 0, documentId: 'doc', url: 'https://example.com/' };
  const replies: Promise<unknown>[] = [];
  capture = installPageCapture(dom.window as unknown as Window, message => {
    replies.push(route(message, sender, 'test', recorder).then(response => {
      if (message.type === 'INPUT') capture.acknowledge(message.payload.actionId);
      return response;
    }));
  }, () => true, (await recorder.status()).recording!.captureId);
  const field = dom.window.document.querySelector('input')!;
  field.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await capturing;
  field.value = 'ordinary'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  field.dispatchEvent(new dom.window.FocusEvent('blur'));
  const stopped = recorder.stop(); release('data:image/jpeg;base64,YQ==');
  await Promise.all([stopped, ...replies]);
  assert.deepEqual((await recorder.status()).recording!.steps.map(step => step.label), ['Click the "Search" field', 'Type "ordinary"']);
  assert.deepEqual(capture.finalize(), []);
  dom.window.close();
});

test('cleanup discards pending composition and acknowledged entries never drain again', () => {
  const dom = new JSDOM('<input>', { url: 'https://example.com/' });
  const messages: PageAction[] = [];
  const capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true);
  const field = dom.window.document.querySelector('input')!;
  field.value = 'ordinary'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  field.dispatchEvent(new dom.window.FocusEvent('blur'));
  assert.equal(messages[0].type, 'INPUT');
  capture.acknowledge((messages[0].payload as any).actionId);
  field.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  field.value = 'unfinished'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, isComposing: true }));
  assert.deepEqual(capture.finalize(), []);
  dom.window.close();
});

test('delayed finalization cannot include input entered after Pause admission closed', t => {
  let clock = 100; t.mock.method(Date, 'now', () => clock);
  const dom = new JSDOM('<input>', { url: 'https://example.com/' });
  const capture = installPageCapture(dom.window as unknown as Window, () => {}, () => true);
  const field = dom.window.document.querySelector('input')!;
  field.value = 'before pause'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  clock = 101;
  field.value = 'after pause'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  assert.deepEqual(capture.finalize(100), []);
  dom.window.close();
});

test('Pause and Complete finalize the live entry through an acknowledged document-bound drain', async () => {
  for (const control of ['pause', 'stop'] as const) {
    const dom = new JSDOM('<input aria-label="Search">', { url: 'https://example.com/' });
    const messages: Promise<unknown>[] = [];
    let capture: any;
    const recorder = new Recorder({ read: async () => null, write: async () => {}, target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/', title: 'Work' }), inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }), capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000,
      finalize: async (r: any) => { assert.equal(r.documentId, 'doc'); return capture.finalize(); },
    } as any);
    await recorder.start();
    const sender = { id: 'test', tab: { id: 7 }, frameId: 0, documentId: 'doc', url: 'https://example.com/' };
    capture = installPageCapture(dom.window as unknown as Window, message => { messages.push(route(message, sender, 'test', recorder)); }, () => true, (await recorder.status()).recording!.captureId);
    const field = dom.window.document.querySelector('input')!;
    field.value = 'final ordinary text'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    await recorder[control]();
    await Promise.all(messages);
    let state = await recorder.status();
    assert.deepEqual(state.recording!.steps.map(step => step.label), ['Type "final ordinary text"']);
    assert.match(state.recording!.steps[0].screenshot!, /^data:image/);
    field.value = 'paused content'; field.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 450));
    state = await recorder.status(); assert.equal(state.recording!.steps.length, 1);
    capture.cleanup(); dom.window.close();
  }
});

test('a trusted ordinary live entry follows its field click through local persistence and finalization', async () => {
  const module = await import('../src/page-capture.ts').catch(() => ({} as any));
  assert.equal(typeof module.installPageCapture, 'function');
  let saved: any;
  const recorder = new Recorder({ read: async () => null, write: async state => { saved = structuredClone(state); }, target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/', title: 'Work' }), inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }), capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000 });
  await recorder.start();
  const sender = { id: 'test', tab: { id: 7 }, frameId: 0, documentId: 'doc', url: 'https://example.com/' };
  const dom = new JSDOM('<input aria-label="Search">', { url: 'https://example.com/' });
  const responses: Promise<unknown>[] = [];
  // jsdom cannot produce trusted input. Replace only that DOM boundary here;
  // the shipped default and real Chromium smoke enforce actual isTrusted.
  const capture = module.installPageCapture(dom.window as unknown as Window, (message: unknown) => { responses.push(route(message, sender, 'test', recorder)); }, () => true, (await recorder.status()).recording!.captureId);
  const input = dom.window.document.querySelector('input')!;
  input.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  for (const value of ['H', 'Hello', 'Hello everyone']) {
    input.value = value; input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  await Promise.all(responses);
  assert.deepEqual(saved.recording.steps.map((step: any) => step.label), ['Click the "Search" field', 'Type "Hello everyone"']);
  assert.equal(saved.recording.steps[1].kind, 'type');
  assert.equal(saved.recording.steps[1].final, false, 'Idle never finalizes a live entry');
  assert.match(saved.recording.steps[1].reason, /Editing entry/);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await Promise.all(responses);
  assert.equal(saved.recording.steps.length, 2);
  assert.equal(saved.recording.steps[1].final, true);
  assert.match(saved.recording.steps[1].reason, /rate limit/i);
  assert.match(saved.recording.steps[1].reason, /entry recorded/);
  capture.cleanup(); dom.window.close();
});
