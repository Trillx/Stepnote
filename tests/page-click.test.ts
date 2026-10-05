import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as capture from '../src/page-click.ts';

test('page click describes a control without collecting typed or editable values', () => {
  const dom = new JSDOM(`<title>Work</title><button id="save">Save</button><input value="secret"><textarea>private</textarea><div contenteditable="true">draft</div>`, { url: 'https://example.com/work?token=secret#draft' });
  assert.equal(typeof capture.describeClick, 'function');
  const win = dom.window;
  const click = new win.MouseEvent('click', { clientX: 50, clientY: 30 });
  const { target, route, ...result } = capture.describeClick(win.document.querySelector('button')!, click, win as unknown as Window);
  assert.deepEqual(result, { label: 'Click Save', x: 50, y: 30, width: 1024, height: 768, title: 'Work', url: 'https://example.com/work' });
  assert.deepEqual([target?.tag, target?.name], ['button', 'Save'], 'the control fingerprint travels with the click');
  assert.match(route!, /^[0-9a-f]{8}$/, 'a one-way route token, not the URL fragment');
  for (const selector of ['input', 'textarea', '[contenteditable]']) {
    const field = capture.describeClick(win.document.querySelector(selector)!, click, win as unknown as Window);
    assert.doesNotMatch(JSON.stringify(field), /secret|private|draft/);
    assert.match(field.label, /field/);
  }
  dom.window.close();
});

test('recognized payment metadata also excludes cardholder and expiry names', () => {
  const dom = new JSDOM('<input name="cardholderName" aria-label="excluded"><input id="cc-exp" aria-label="excluded"><input name="exp_month" aria-label="excluded"><input name="csc" aria-label="excluded">', { url: 'https://example.com/' });
  for (const field of dom.window.document.querySelectorAll('input')) {
    assert.equal(capture.describeClick(field, new dom.window.MouseEvent('click'), dom.window as unknown as Window).label, 'Click protected field');
  }
  dom.window.close();
});

test('field clicks use accessible names but recognized secrets never expose names or values', () => {
  const dom = new JSDOM(`<label for="query">Search</label><input id="query" value="draft"><textarea aria-label="Notes">draft</textarea><div contenteditable="true" aria-label="Description">draft</div><input type="password" aria-label="excluded"><input autocomplete="one-time-code" aria-label="excluded"><input name="cardNumber" aria-label="excluded"><input id="api-key" aria-label="excluded"><input autocomplete="username" aria-label="excluded">`, { url: 'https://example.com/' });
  const win = dom.window;
  const click = new win.MouseEvent('click');
  const labels = [...win.document.querySelectorAll('input,textarea,[contenteditable]')].map(field => capture.describeClick(field, click, win as unknown as Window).label);
  assert.deepEqual(labels.slice(0, 3), ['Click the "Search" field', 'Click the "Notes" field', 'Click the "Description" field']);
  assert.ok(labels.slice(3).every(label => label === 'Click protected field'));
  assert.doesNotMatch(JSON.stringify(labels), /draft|excluded/);
  dom.window.close();
});
