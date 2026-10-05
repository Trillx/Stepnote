import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installPageCapture, type PageAction } from '../src/page-capture.ts';

for (const blocker of ['window-stop', 'document-immediate-stop'] as const) {
  test(`records clicks before an app's ${blocker} handler consumes them`, () => {
    const dom = new JSDOM('<button>Open channel</button>', { url: 'https://example.com/' });
    const messages: PageAction[] = [];
    let appClicks = 0;
    const target = blocker === 'window-stop' ? dom.window : dom.window.document;
    target.addEventListener('click', event => {
      appClicks++;
      if (blocker === 'window-stop') event.stopPropagation();
      else event.stopImmediatePropagation();
    }, true);
    // Only the trust predicate is replaced in this component test. Browser
    // coverage uses trusted clicks and the production permission model.
    const capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true, 'arm');
    try {
      dom.window.document.querySelector('button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.equal(appClicks, 1, 'The extension must not block the app handler');
      assert.equal(messages.length, 1, 'Consumed trusted clicks must still produce a step');
      assert.equal(messages[0].payload.label, 'Click Open channel');
      capture.cleanup();
      dom.window.document.querySelector('button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.equal(messages.length, 1, 'Cleanup must remove the early listener');
    } finally { capture.cleanup(); dom.window.close(); }
  });
}

test("clicks and typing on Stepnote's own on-page controls are never recorded", () => {
  const dom = new JSDOM('<button id="page">Save</button><div data-stepnote-ui><button id="ours">Next</button><input id="field"></div>', { url: 'https://example.com/' });
  const messages: PageAction[] = [];
  const capture = installPageCapture(dom.window as unknown as Window, message => messages.push(message), () => true, 'arm');
  const doc = dom.window.document;
  doc.getElementById('ours')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const field = doc.getElementById('field') as HTMLInputElement;
  field.value = 'x'; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  doc.getElementById('page')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(messages.map(m => m.payload.label), ['Click Save']);
  capture.cleanup(); dom.window.close();
});
