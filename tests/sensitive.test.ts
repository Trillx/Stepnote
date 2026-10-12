import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findSensitive, mappableTransform, sensitiveMatches } from '../src/sensitive.ts';
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

// jsdom has no layout: an element's box comes from its data-box attribute (x,y,w,h).
function layout(dom: JSDOM) {
  return (target: Element | Range) => {
    const node = target instanceof dom.window.Range ? target.startContainer.parentElement! : target as Element;
    const host = (node.closest('[data-box]') ?? node) as Element;
    const [x, y, width, height] = (host.getAttribute('data-box') ?? '0,0,10,10').split(',').map(Number);
    return [{ x, y, width, height } as DOMRect];
  };
}
test('automatic blur looks inside shadow roots and same-origin frames, and blurs frames it cannot read', () => {
  const dom = new JSDOM('<body><div id="host" data-box="10,10,300,20"></div><iframe id="same" data-box="0,100,400,200"></iframe><iframe id="other" data-box="500,100,300,200"></iframe><iframe id="hidden" data-box="0,0,0,0"></iframe></body>', { pretendToBeVisual: true });
  const win = dom.window as unknown as Window;
  Object.defineProperty(win, 'innerWidth', { value: 1000 }); Object.defineProperty(win, 'innerHeight', { value: 600 });
  const shadow = dom.window.document.getElementById('host')!.attachShadow({ mode: 'closed' });
  shadow.innerHTML = '<p data-box="10,10,300,20">Owner: jane@example.com</p>';
  const inner = new JSDOM('<body><p data-box="20,30,200,20">Card 4111 1111 1111 1111</p><input type="password" data-box="20,150,100,20"></body>');
  const regions = findSensitive(win, {
    measure: (target: Element | Range) => {
      const owner = target instanceof inner.window.Range ? target.startContainer.ownerDocument : (target as Element).ownerDocument;
      return owner === inner.window.document ? layout(inner)(target) : layout(dom)(target);
    },
    shadowRoot: element => element.id === 'host' ? shadow : null,
    frameDocument: frame => frame.id === 'same' ? inner.window.document : null,
  });
  const boxes = regions.boxes.map(b => [b.x, b.y, b.width, b.height]);
  assert.deepEqual(boxes, [
    [10, 10, 300, 20], // shadow text
    [20, 250, 100, 20], // frame password field, offset by the frame
    [20, 130, 200, 20], // frame text
    [500, 100, 300, 200], // unreadable frame, blurred whole
  ]);
  dom.window.close(); inner.window.close();
});

test('frame content is mapped through the frame scale; frames that cannot be mapped are blurred whole', () => {
  const dom = new JSDOM('<body><iframe id="scaled" data-box="0,100,400,200"></iframe><iframe id="rotated" data-box="500,100,300,200"></iframe></body>', { pretendToBeVisual: true });
  const win = dom.window as unknown as Window;
  Object.defineProperty(win, 'innerWidth', { value: 1000 }); Object.defineProperty(win, 'innerHeight', { value: 600 });
  const inner = new JSDOM('<body><input type="email" value="me@example.com" data-box="10,20,80,10"></body>');
  const regions = findSensitive(win, {
    measure: (target: Element | Range) => {
      const owner = target instanceof inner.window.Range ? target.startContainer.ownerDocument : (target as Element).ownerDocument;
      return owner === inner.window.document ? layout(inner)(target) : layout(dom)(target);
    },
    frameDocument: () => inner.window.document,
    // The scaled frame is drawn at twice its layout size; the rotated one cannot be mapped.
    frameScale: frame => frame.id === 'scaled' ? { x: 2, y: 2 } : null,
  });
  assert.deepEqual(regions.boxes.map(b => [b.x, b.y, b.width, b.height]), [[20, 140, 160, 20], [500, 100, 300, 200]]);
  dom.window.close(); inner.window.close();
});

test('only positive axis-aligned scale and movement can be mapped; any other transform blurs the frame whole', () => {
  const none = { transform: 'none', rotate: 'none', scale: 'none', offsetPath: 'none' };
  assert.equal(mappableTransform(none), true);
  assert.equal(mappableTransform({ ...none, transform: 'matrix(2, 0, 0, 2, 10, 20)' }), true);
  assert.equal(mappableTransform({ ...none, scale: '2 1.5' }), true);
  assert.equal(mappableTransform({ ...none, transform: 'matrix(-1, 0, 0, 1, 0, 0)' }), false, 'mirrored');
  assert.equal(mappableTransform({ ...none, transform: 'matrix(0, 1, -1, 0, 0, 0)' }), false, 'rotated');
  assert.equal(mappableTransform({ ...none, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1)' }), false, '3D');
  assert.equal(mappableTransform({ ...none, rotate: '90deg' }), false, 'rotate property');
  assert.equal(mappableTransform({ ...none, rotate: '0deg' }), true);
  assert.equal(mappableTransform({ ...none, scale: '-1 1' }), false, 'mirrored by the scale property');
  assert.equal(mappableTransform({ ...none, offsetPath: 'path("M0,0 L100,100")' }), false, 'motion path');
  assert.equal(mappableTransform({ ...none, transform: 'garbage(' }), false, 'unparseable');
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
