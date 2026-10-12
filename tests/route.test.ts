import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { routeToken, routeTokenOf } from '../src/route.ts';
import { describeClick } from '../src/page-click.ts';

const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });
const page = (html: string, url: string) => { const dom = new JSDOM(`<body>${html}</body>`, { url, pretendToBeVisual: true }); open.push(dom); return dom; };

test('route tokens tell hash routes apart without storing them', () => {
  const one = page('<button>Next</button>', 'https://a.example.com/app#/one?session=abc');
  const oneAgain = page('<button>Next</button>', 'https://a.example.com/app#/one?session=xyz');
  const two = page('<button>Next</button>', 'https://a.example.com/app#/two');
  const token = (dom: JSDOM) => routeToken(dom.window as unknown as Window);
  assert.match(token(one), /^[0-9a-f]{8}$/);
  assert.equal(token(one), token(oneAgain), 'fragment queries are ignored');
  assert.notEqual(token(one), token(two));
  const click = describeClick(one.window.document.querySelector('button')!, new one.window.MouseEvent('click'), one.window as unknown as Window);
  assert.equal(click.route, token(one));
  assert.doesNotMatch(JSON.stringify(click), /#\/one|session|abc/);
});

test('route tokens are the same in the page and in the worker', () => {
  const dom = page('', 'https://a.example.com/app#/two?x=1');
  assert.equal(routeToken(dom.window as unknown as Window), routeTokenOf('#/two?x=1'));
  assert.equal(routeTokenOf('#/two?x=1'), routeTokenOf('#/two'));
  assert.notEqual(routeTokenOf('#/one'), routeTokenOf('#/two'));
});

test('the real tab lookup reports the route of the tab address', async () => {
  const previous = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = { tabs: { get: async () => ({ id: 2, windowId: 1, active: true, title: 'App', url: 'https://a.example.com/app#/two?session=x' }) } };
  try {
    const { chromePort } = await import('../src/chrome-port.ts');
    const target = await chromePort.target(2, 1);
    assert.equal(target.url, 'https://a.example.com/app');
    assert.equal(target.route, routeTokenOf('#/two'));
  } finally { (globalThis as { chrome?: unknown }).chrome = previous; }
});
