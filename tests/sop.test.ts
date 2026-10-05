import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as sop from '../src/sop.ts';
import type { Recording, Step } from '../src/recorder.ts';

export const recording: Recording = {
  tabId: 7, windowId: 2, documentId: 'doc-1', status: 'stopped', startedAt: 1000,
  title: '<img src=x onerror=alert(1)>', url: 'https://example.com/',
  steps: [
    { label: '<script>alert(1)</script>', title: 'Work', url: 'https://example.com/', x: 200, y: 150, width: 800, height: 600, at: 1001, screenshot: 'data:image/jpeg;base64,YQ==' },
    { label: 'Click next', title: 'Work', url: 'https://example.com/', x: 1, y: 2, width: 800, height: 600, at: 1002, reason: 'Screenshot rate limit.' },
  ],
};
test('type steps escape entered text and distinguish input position in portable HTML and live cards', async () => {
  const typed: Recording = { ...recording, steps: [{ ...(recording.steps[0] as Step), id: 'typed', kind: 'type', label: 'Type "<img onerror=alert(1)> & draft"' }] };
  const dom = new JSDOM(sop.exportHtml(typed));
  assert.equal(dom.window.document.querySelector('h2')!.textContent, typed.steps[0].label);
  assert.equal(dom.window.document.querySelectorAll('[onerror],script').length, 0);
  assert.equal(dom.window.document.querySelector('.marker')!.getAttribute('aria-label'), 'Input position');
  assert.doesNotMatch(dom.window.document.body.textContent!, /viewport|Ordinary typed entries/, 'shared guides omit capture coordinates and author warnings');
  const panel = await import('../src/sidepanel-ui.ts');
  const root = dom.window.document.createElement('main'); dom.window.document.body.append(root);
  await panel.mountSidePanel(root, async () => ({ recording: typed }), () => () => {}, () => {}, () => true, () => {});
  assert.equal(root.querySelector('.marker')!.getAttribute('aria-label'), 'Input position');
  assert.match(root.querySelector('.warning')!.textContent!, /Ordinary typed entries.*exports/);
  dom.window.close();
});

test('portable SOP embeds ordered images and markers while escaping page text', () => {
  assert.equal(typeof sop.exportHtml, 'function');
  const html = sop.exportHtml(recording);
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('li').length, 2);
  assert.equal(doc.querySelectorAll('script').length, 0);
  assert.equal(doc.querySelector('h1')!.textContent, recording.title);
  assert.equal(doc.querySelector('img')!.getAttribute('src'), recording.steps[0].screenshot);
  assert.equal(doc.querySelector<HTMLElement>('.marker')!.style.left, '25%');
  assert.equal(doc.querySelector<HTMLElement>('.marker')!.style.top, '25%');
  assert.match(doc.body.textContent!, /Screenshot rate limit/);
  assert.equal(doc.querySelectorAll('[onerror],link,iframe').length, 0);
  assert.match(doc.querySelector('meta[http-equiv]')!.getAttribute('content')!, /default-src 'none'/);
  dom.window.close();
});

test('export uses the edited guide: title, description, instructions, notes and blocks', () => {
  const edited: Recording = { ...recording, guideTitle: 'Close a <ticket>', description: 'For support.\nSecond paragraph.', steps: [
    { id: 'h', kind: 'header', text: 'Open the queue', at: 1 },
    { ...(recording.steps[0] as Step), id: 'a', text: 'Choose <b>Save</b>', note: 'Top right.', hideMarker: true },
    { id: 't', kind: 'tip', text: 'Use filters.', at: 2 },
    { id: 'empty', kind: 'alert', text: '   ', at: 3 },
    { ...(recording.steps[1] as Step), id: 'b' },
  ] };
  const doc = new JSDOM(sop.exportHtml(edited)).window.document;
  assert.equal(doc.title, 'Close a <ticket>');
  assert.equal(doc.querySelector('h1')!.textContent, 'Close a <ticket>');
  assert.deepEqual([...doc.querySelectorAll('.description p')].map(p => p.textContent), ['For support.', 'Second paragraph.']);
  assert.match(doc.querySelector('.guide-meta')!.textContent!, /2 steps/);
  assert.deepEqual([...doc.querySelectorAll('.entry')].map(e => e.className.replace('entry ', '')), ['section', 'step', 'tip', 'step'], 'empty blocks are skipped');
  assert.deepEqual([...doc.querySelectorAll('.step-number')].map(n => n.textContent), ['1', '2']);
  assert.equal(doc.querySelector('.step h2')!.textContent, 'Choose <b>Save</b>');
  assert.equal(doc.querySelectorAll('b').length, 0);
  assert.equal(doc.querySelector('.step .note')!.textContent, 'Top right.');
  assert.equal(doc.querySelector('.section h2')!.textContent, 'Open the queue');
  assert.match(doc.querySelector('.tip')!.textContent!, /Tip.*Use filters./);
  assert.equal(doc.querySelectorAll('.marker').length, 0, 'hidden marker is not drawn');
  assert.equal([...doc.querySelectorAll('.step h2')][1].textContent, 'Click next', 'unedited steps use the recorded label');
});

test('box markers are drawn as boxes in exports', () => {
  const doc = new JSDOM(sop.exportHtml({ ...recording, markerStyle: 'box' })).window.document;
  assert.ok(doc.querySelector('.marker.box'));
  assert.match(sop.sopStyles, /\.marker\.box\{/);
});
