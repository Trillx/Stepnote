import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findSensitive, sensitiveMatches } from '../src/sensitive.ts';
import { imageBoxes, matchesViewport } from '../src/redact.ts';
import { Recorder } from '../src/recorder.ts';

const found = (text: string) => sensitiveMatches(text).map(([start, end]) => text.slice(start, end));

test('private details in text are matched; ordinary numbers are not', () => {
  assert.deepEqual(found('Mail jane.doe+work@example.co.uk today'), ['jane.doe+work@example.co.uk']);
  assert.deepEqual(found('Card 4111 1111 1111 1111 on file'), ['4111 1111 1111 1111']);
  assert.deepEqual(found('Order 4111 1111 1111 1112 failed'), [], 'fails the Luhn check');
  assert.deepEqual(found('Call (555) 123-4567 or +44 20 7946 0958'), ['(555) 123-4567', '+44 20 7946 0958']);
  assert.deepEqual(found('SSN 123-45-6789'), ['123-45-6789']);
  assert.deepEqual(found('IBAN GB82 WEST 1234 5698 7654 32'), ['GB82 WEST 1234 5698 7654 32']);
  assert.deepEqual(found('Released 2026-10-02, version 4.12.1, total $1,234.56, ticket 48213'), []);
});

// jsdom has no layout: every element and range gets the box its test id or text implies.
function page(html: string) {
  const dom = new JSDOM(`<body>${html}</body>`, { pretendToBeVisual: true });
  const win = dom.window as unknown as Window;
  Object.defineProperty(win, 'innerWidth', { value: 1000 }); Object.defineProperty(win, 'innerHeight', { value: 600 });
  const measure = (target: Element | Range) => {
    const node = target instanceof dom.window.Range ? target.startContainer.parentElement! : target as Element;
    const y = Number(node.getAttribute('data-y') ?? 10);
    return [{ x: 20, y, width: 200, height: 20 } as DOMRect];
  };
  return { dom, regions: () => findSensitive(win, measure) };
}

test('credential, payment and filled contact fields are boxed; ordinary fields are not', () => {
  const { dom, regions } = page(`
    <input type="password" value="hunter2" data-y="10">
    <input autocomplete="cc-number" data-y="40">
    <input type="email" value="me@example.com" data-y="70">
    <input type="email" value="" data-y="100">
    <input type="text" value="Quarterly report" data-y="130">
    <input type="text" value="555-123-4567 x" data-y="160">
    <textarea data-y="190">Notes only</textarea>`);
  const r = regions();
  assert.deepEqual([r.width, r.height], [1000, 600]);
  assert.deepEqual(r.boxes.map(b => b.y), [10, 40, 70, 160]);
  dom.window.close();
});

test('matching visible text is boxed, scripts and off-screen text are skipped', () => {
  const { dom, regions } = page(`
    <p data-y="50">Contact jane@example.com for access</p>
    <p data-y="80">Nothing private here</p>
    <p data-y="900">Off screen 4111 1111 1111 1111</p>
    <script>const email = "x@example.com";</script>
    <style>.a{content:"y@example.com"}</style>`);
  assert.deepEqual(regions().boxes.map(b => b.y), [50]);
  dom.window.close();
});

test('viewport boxes scale to screenshot pixels with padding and clipping', () => {
  const boxes = imageBoxes([{ width: 800, height: 600, boxes: [{ x: 100, y: 50, width: 200, height: 20 }, { x: 790, y: 590, width: 50, height: 50 }] }], { width: 1600, height: 1200 });
  assert.deepEqual(boxes[0], { x: 192, y: 92, width: 416, height: 56 });
  assert.deepEqual(boxes[1], { x: 1572, y: 1172, width: 28, height: 28 });
  assert.deepEqual(imageBoxes([{ width: 0, height: 0, boxes: [{ x: 1, y: 1, width: 1, height: 1 }] }], { width: 10, height: 10 }), [], 'invalid viewports are ignored');
});

const click = { label: 'Click Save', x: 120, y: 50, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' };
const sender = { tabId: 7, frameId: 0, documentId: 'doc-1' };
function harness(sensitive: () => Promise<any>) {
  let saved: any = null;
  const calls: string[] = [];
  const port = {
    read: async () => structuredClone(saved), write: async (value: any) => { saved = structuredClone(value); },
    target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/work', title: 'Work' }),
    inject: async () => 'doc-1', current: async () => ({ active: true, documentId: 'doc-1' }),
    capture: async () => { calls.push('capture'); return 'data:image/jpeg;base64,YQ=='; }, now: () => 1000,
    sensitive: async () => { calls.push('sensitive'); return sensitive(); },
    redact: async (shot: string, regions: unknown[]) => { calls.push(`redact:${regions.length}`); return 'data:image/jpeg;base64,QkxVUg=='; },
  };
  return { port, calls };
}
const region = { width: 800, height: 600, boxes: [{ x: 1, y: 1, width: 10, height: 10 }, { x: 50, y: 50, width: 10, height: 10 }] };

test('with automatic blur, regions found before and after the screenshot are blurred before saving', async () => {
  const h = harness(async () => region);
  const recorder = new Recorder(h.port); await recorder.start(undefined, undefined, { autoBlur: true });
  await recorder.click(click, sender);
  const step = (await recorder.status()).recording!.steps[0];
  assert.deepEqual(h.calls, ['sensitive', 'capture', 'sensitive', 'redact:2']);
  assert.equal(step.screenshot, 'data:image/jpeg;base64,QkxVUg==');
  assert.equal(step.blurred, 2);
});

test('nothing found keeps the screenshot; a failed check drops it rather than risk private data', async () => {
  const clean = harness(async () => ({ width: 800, height: 600, boxes: [] }));
  let recorder = new Recorder(clean.port); await recorder.start();
  await recorder.click(click, sender);
  let step = (await recorder.status()).recording!.steps[0];
  assert.equal(step.screenshot, 'data:image/jpeg;base64,YQ==');
  assert.equal(step.blurred, undefined);
  assert.ok(!clean.calls.some(c => c.startsWith('redact')));
  const broken = harness(async () => { throw new Error('No receiver'); });
  recorder = new Recorder(broken.port); await recorder.start();
  await recorder.click(click, sender);
  step = (await recorder.status()).recording!.steps[0];
  assert.equal(step.screenshot, undefined);
  assert.match(step.reason!, /Automatic blur could not check this page/);
});

test('turning automatic blur off skips detection entirely', async () => {
  const h = harness(async () => region);
  const recorder = new Recorder(h.port); await recorder.start(undefined, undefined, { autoBlur: false });
  await recorder.click(click, sender);
  assert.deepEqual(h.calls, ['capture']);
  assert.equal((await recorder.status()).recording!.autoBlur, false);
});

test('blur refuses a screenshot whose shape does not match the page viewport', () => {
  assert.equal(matchesViewport([{ width: 1000, height: 700, boxes: [] }], { width: 2000, height: 1400 }), true);
  assert.equal(matchesViewport([{ width: 1000, height: 700, boxes: [] }], { width: 1250, height: 876 }), true, 'fractional device pixel ratios round');
  assert.equal(matchesViewport([{ width: 1000, height: 700, boxes: [] }], { width: 772, height: 917 }), false);
});
