import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fingerprint, findTarget, validFingerprint } from '../src/fingerprint.ts';
import { describeClick } from '../src/page-click.ts';
import { Recorder, type Step } from '../src/recorder.ts';

const page = (html: string) => new JSDOM(`<body>${html}</body>`, { url: 'https://app.example.com/orders?id=7' });
// Rendered pages, closed after each test.
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });
const visualPage = (html: string, url = 'https://app.example.com/orders') => { const dom = new JSDOM(`<body>${html}</body>`, { url, pretendToBeVisual: true }); open.push(dom); return dom; };

test('a fingerprint names the control without collecting values', () => {
  const dom = page(`<form><label for="q">Customer</label><input id="q" name="customer" value="Jane Doe" placeholder="Search customers"></form>
    <button data-testid="save-order" class="btn">Save order</button><a href="/orders/new?ref=x" title="New">+</a>
    <input type="password" id="pw" name="password" value="hunter2" aria-label="Password">`);
  const doc = dom.window.document;
  const win = dom.window as unknown as Window;
  const field = fingerprint(doc.getElementById('q')!, win);
  assert.deepEqual([field.tag, field.role, field.name, field.id], ['input', 'textbox', 'Customer', 'q']);
  assert.equal(field.attrs?.placeholder, 'Search customers');
  assert.doesNotMatch(JSON.stringify(field), /Jane Doe/);
  const button = fingerprint(doc.querySelector('button')!, win);
  assert.deepEqual([button.role, button.name, button.testId], ['button', 'Save order', 'save-order']);
  const link = fingerprint(doc.querySelector('a')!, win);
  assert.equal(link.attrs?.href, '/orders/new', 'link path only, no query');
  const secret = fingerprint(doc.getElementById('pw')!, win);
  assert.equal(secret.name, undefined);
  assert.equal(secret.text, undefined);
  assert.doesNotMatch(JSON.stringify(secret), /hunter2|Password/);
  dom.window.close();
});

test('the selector path finds the same element again', () => {
  const dom = page('<ul><li><button>Edit</button></li><li><button>Edit</button></li></ul><div><span>x</span></div>');
  const doc = dom.window.document;
  const second = doc.querySelectorAll('button')[1];
  const fp = fingerprint(second, dom.window as unknown as Window);
  assert.equal(doc.querySelector(fp.selector), second);
  dom.window.close();
});

test('a target is found by id, test id, selector or accessible name, even after the page changes', () => {
  const before = page('<nav><button>Home</button></nav><main><div><button id="go">Submit request</button></div></main>');
  const fp = fingerprint(before.window.document.getElementById('go')!, before.window as unknown as Window);
  before.window.close();
  // Same page: by id.
  const same = page('<nav><button>Home</button></nav><main><div><button id="go">Submit request</button></div></main>');
  assert.equal(findTarget(same.window.document, fp)?.id, 'go');
  // Id and layout changed: still found by role and name.
  const moved = page('<header><button>Home</button></header><section><p>Intro</p><button id="submit-2">Submit request</button></section>');
  assert.equal(findTarget(moved.window.document, fp)?.textContent, 'Submit request');
  // Nothing like it: not found, rather than a wrong guess.
  const gone = page('<button>Cancel</button><button>Home</button>');
  assert.equal(findTarget(gone.window.document, fp), null);
  same.window.close(); moved.window.close(); gone.window.close();
});

test('fingerprints are validated and bounded before they are stored', () => {
  const ok = { tag: 'button', selector: 'body > button', rect: { x: 1, y: 2, width: 3, height: 4 } };
  assert.equal(validFingerprint(ok), true);
  for (const bad of [null, { ...ok, tag: 5 }, { ...ok, selector: 'x'.repeat(1001) }, { ...ok, name: 'x'.repeat(201) }, { ...ok, rect: { x: NaN, y: 0, width: 1, height: 1 } }, { ...ok, attrs: { onclick: 'x' } }]) {
    assert.equal(validFingerprint(bad), false, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('clicks and text entries carry their fingerprint into the saved step', async () => {
  const dom = page('<button id="save">Save</button><input id="q" aria-label="Search">');
  const win = dom.window as unknown as Window;
  const click = describeClick(dom.window.document.getElementById('save')!, new dom.window.MouseEvent('click', { clientX: 5, clientY: 5 }), win);
  assert.equal(click.target?.id, 'save');
  let saved: any = null;
  const recorder = new Recorder({
    read: async () => structuredClone(saved), write: async v => { saved = structuredClone(v); },
    target: async () => ({ tabId: 7, windowId: 2, url: 'https://app.example.com/orders', title: 'Orders' }),
    inject: async () => 'doc-1', current: async () => ({ active: true, documentId: 'doc-1' }),
    capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000,
  });
  await recorder.start();
  await recorder.click(click, { tabId: 7, frameId: 0, documentId: 'doc-1' });
  await recorder.click({ ...click, target: { tag: 'button', selector: 'x'.repeat(5000), rect: { x: 0, y: 0, width: 1, height: 1 } } }, { tabId: 7, frameId: 0, documentId: 'doc-1' });
  const steps = (await recorder.status()).recording!.steps as Step[];
  assert.equal(steps[0].target?.id, 'save');
  assert.equal(steps[1].target, undefined, 'an invalid fingerprint is dropped, the click is kept');
  dom.window.close();
});

test('fingerprints never keep text typed into editable descendants', () => {
  const dom = visualPage('<label id="customer">Customer <span contenteditable="true">Jane Private</span><textarea>Secret note</textarea></label>');
  const label = dom.window.document.getElementById('customer')!;
  const win = dom.window as unknown as Window;
  const fp = fingerprint(label, win);
  assert.doesNotMatch(JSON.stringify(fp), /Jane Private|Secret note/);
  assert.equal(fp.name, 'Customer');
  const click = describeClick(label, new dom.window.MouseEvent('click'), win);
  assert.doesNotMatch(JSON.stringify(click), /Jane Private|Secret note/);
});

test('a control named by its image is found again', () => {
  const dom = visualPage('<nav><a href="/">Home</a></nav><button><img alt="Save" src="x.png"></button>');
  const button = dom.window.document.querySelector('button')!;
  const fp = fingerprint(button, dom.window as unknown as Window);
  assert.equal(fp.name, 'Save');
  assert.equal(findTarget(dom.window.document, fp), button);
});

test('recognized secret fields keep only tag, type, selector and position', () => {
  const dom = visualPage('<div contenteditable="true" id="auth-token" aria-label="Token" title="Paste token" data-testid="token-box"></div><input type="password" id="pw" name="password" data-testid="pw" placeholder="Password">', 'https://a.example.com/');
  const win = dom.window as unknown as Window;
  for (const el of [dom.window.document.getElementById('auth-token')!, dom.window.document.getElementById('pw')!]) {
    const fp = fingerprint(el, win);
    assert.deepEqual(Object.keys(fp).sort(), el.id === 'pw' ? ['attrs', 'rect', 'selector', 'tag'] : ['rect', 'selector', 'tag']);
    if (el.id === 'pw') assert.deepEqual(fp.attrs, { type: 'password' });
  }
});

test('a minimal fingerprint does not match an element of another kind', () => {
  const before = visualPage('<form><input type="password" id="pw"></form>', 'https://a.example.com/app');
  const fp = fingerprint(before.window.document.getElementById('pw')!, before.window as unknown as Window);
  const after = visualPage('<form><input type="text" id="pw"></form>', 'https://a.example.com/app');
  assert.equal(findTarget(after.window.document, fp), null);
});
