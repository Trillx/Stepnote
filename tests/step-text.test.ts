import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { describeClick } from '../src/page-click.ts';
import { emphasis, exportHtml } from '../src/sop.ts';
import { buildDocx } from '../src/docx.ts';
import type { Recording, Step } from '../src/recorder.ts';

const step = (label: string, extra: Partial<Step> = {}): Step => ({ id: 'a', label, title: 'T', url: 'https://example.com/', x: 1, y: 1, width: 10, height: 10, at: 1, ...extra });
const show = (s: Step) => emphasis(s).map(part => part.bold ? `[${part.text}]` : part.text).join('');

test('recorded instructions put the control name in bold', () => {
  assert.equal(show(step('Click Save item')), 'Click [Save item]');
  assert.equal(show(step('Click the "Search" field')), 'Click the [Search] field');
  assert.equal(show(step('Clear the "Search" field')), 'Clear the [Search] field');
  assert.equal(show(step('Type "hello world"', { kind: 'type' })), 'Type ["hello world"]');
  assert.equal(show(step('Go to Billing settings')), 'Go to [Billing settings]');
  assert.equal(show(step('Click protected field')), 'Click protected field');
  assert.equal(show(step('Click field')), 'Click field');
});

test('edited instructions use **double asterisks** for bold', () => {
  assert.equal(show(step('Click Save', { text: 'Choose **Save** then **Close**' })), 'Choose [Save] then [Close]');
  assert.equal(show(step('Click Save', { text: 'Plain text, no ** pair' })), 'Plain text, no ** pair');
});

test('exports render bold names as markup and Word runs', () => {
  const recording: Recording = { id: 'g', tabId: 1, windowId: 1, documentId: 'd', title: 'T', url: 'https://example.com/', status: 'stopped', startedAt: 1,
    steps: [step('Click <Save>'), step('Click X', { id: 'b', text: 'Pick **<b>ok</b>**' })] };
  const doc = new JSDOM(exportHtml(recording)).window.document;
  assert.deepEqual([...doc.querySelectorAll('.step h2 strong')].map(s => s.textContent), ['<Save>', '<b>ok</b>']);
  assert.equal(doc.querySelectorAll('h2 b').length, 0);
  const xml = new TextDecoder().decode(buildDocx(recording, new Map()));
  assert.match(xml, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">&lt;Save&gt;<\/w:t><\/w:r>/);
});

test('icon buttons are named by their accessible label, title or image text; submit buttons are not fields', () => {
  const dom = new JSDOM(`<button id="a" aria-label="Close dialog"><svg></svg></button><a id="b" title="Settings" href="#"><i></i></a>
    <button id="c"><img alt="Search"></button><input id="d" type="submit" value="Send invoice"><div id="e" role="button"></div>`, { url: 'https://example.com/' });
  const label = (id: string) => describeClick(dom.window.document.getElementById(id)!, new dom.window.MouseEvent('click'), dom.window as unknown as Window).label;
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(label), ['Click Close dialog', 'Click Settings', 'Click Search', 'Click Send invoice', 'Click div']);
  dom.window.close();
});
