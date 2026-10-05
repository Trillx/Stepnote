import test from 'node:test';
import assert from 'node:assert/strict';
import { tidySteps } from '../src/tidy.ts';
import { Recorder, type Entry, type Step } from '../src/recorder.ts';

const field = { tag: 'input', role: 'textbox', name: 'Customer', id: 'customer', selector: '#customer', rect: { x: 0, y: 0, width: 1, height: 1 } };
const save = { tag: 'button', role: 'button', name: 'Save', selector: 'body > button', rect: { x: 0, y: 0, width: 1, height: 1 } };
const s = (id: string, label: string, at: number, extra: Partial<Step> = {}): Step => ({ id, label, at, title: 'T', url: 'https://example.com/', x: 1, y: 1, width: 10, height: 10, ...extra });

test('a field click followed by typing in that field becomes one step', () => {
  const { steps, removed } = tidySteps([
    s('a', 'Click the "Customer" field', 1000, { target: field }),
    s('b', 'Type "Acme Ltd"', 1500, { kind: 'type', target: field, screenshot: 'data:image/jpeg;base64,YQ==' }),
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(steps.map(e => e.id), ['b']);
  assert.equal((steps[0] as Step).text, 'Type **"Acme Ltd"** in the **Customer** field');
});

test('repeated clicks on the same control within a second keep only the first', () => {
  const { steps, removed } = tidySteps([s('a', 'Click Save', 1000, { target: save }), s('b', 'Click Save', 1400, { target: save }), s('c', 'Click Save', 3000, { target: save })]);
  assert.equal(removed, 1);
  assert.deepEqual(steps.map(e => e.id), ['a', 'c']);
});

test('edited steps, other fields and blocks are left alone; an edited click still absorbs its double click', () => {
  const other = { ...field, id: 'other', selector: '#other', name: 'Other' };
  const input: Entry[] = [
    s('a', 'Click the "Customer" field', 1000, { target: field, note: 'Mine' }),
    s('b', 'Type "x"', 1200, { kind: 'type', target: field }),
    s('c', 'Click the "Customer" field', 2000, { target: field }),
    s('d', 'Type "y"', 2200, { kind: 'type', target: other }),
    { id: 'tip', kind: 'tip', text: 'Note', at: 2300 },
    s('e', 'Click Save', 2400, { target: save, text: 'Press **Save**' }),
    s('f', 'Click Save', 2500, { target: save }),
  ];
  const { steps, removed } = tidySteps(input);
  assert.equal(removed, 1);
  assert.deepEqual(steps.map(e => e.id), ['a', 'b', 'c', 'd', 'tip', 'e'], 'f is the accidental second click on Save');
  assert.equal((steps[5] as Step).text, 'Press **Save**');
});

test('completing a capture tidies it when the setting is on, and says so', async () => {
  for (const tidy of [true, false]) {
    let saved: any = null;
    const recorder = new Recorder({
      read: async () => structuredClone(saved), write: async v => { saved = structuredClone(v); },
      target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/', title: 'T' }),
      inject: async () => 'doc-1', current: async () => ({ active: true, documentId: 'doc-1' }),
      capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000, tidy: () => tidy,
    });
    await recorder.start();
    const sender = { tabId: 7, frameId: 0, documentId: 'doc-1' };
    await recorder.click({ label: 'Click Save', x: 1, y: 1, width: 10, height: 10, url: 'https://example.com/', title: 'T', target: save }, sender);
    await recorder.click({ label: 'Click Save', x: 1, y: 1, width: 10, height: 10, url: 'https://example.com/', title: 'T', target: save }, sender);
    await recorder.stop();
    const r = (await recorder.status()).recording!;
    assert.equal(r.steps.length, tidy ? 1 : 2);
    assert.equal(r.tidied, tidy ? 1 : undefined);
  }
});
