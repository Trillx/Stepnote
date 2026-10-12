import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountLauncher, launcherActions, launcherRegistration } from '../src/launcher-ui.ts';
import { defaultSettings } from '../src/settings.ts';
import * as messages from '../src/messages.ts';

const wait = () => new Promise(resolve => setTimeout(resolve, 0));

test('the on-screen button shows the guide count, opens the panel, and can hide itself on this site', async () => {
  const dom = new JSDOM('<body></body>', { url: 'https://app.example.com/' });
  const calls: string[] = [];
  const launcher = mountLauncher(dom.window as unknown as Window, { count: async () => 3, open: () => { calls.push('open'); }, hide: () => { calls.push('hide'); } }, { trusted: () => true });
  await launcher.ready;
  const host = dom.window.document.querySelector<HTMLElement>('[data-stepnote-ui]')!;
  assert.match(host.getAttribute('style')!, /pointer-events:\s*none/);
  const button = launcher.root.querySelector<HTMLButtonElement>('.open')!;
  assert.equal(button.getAttribute('aria-label'), 'Open Stepnote, 3 guides for this site');
  assert.equal(launcher.root.querySelector('.count')!.textContent, '3');
  button.click();
  launcher.root.querySelector<HTMLButtonElement>('.hide')!.click(); await wait();
  assert.deepEqual(calls, ['open', 'hide']);
  assert.equal(dom.window.document.querySelector('[data-stepnote-ui]'), null, 'hidden right away');
  dom.window.close();
});

test('with no guides for the site the count badge is hidden', async () => {
  const dom = new JSDOM('<body></body>', { url: 'https://app.example.com/' });
  const launcher = mountLauncher(dom.window as unknown as Window, { count: async () => 0, open: () => {}, hide: () => {} }, { trusted: () => true });
  await launcher.ready;
  assert.equal(launcher.root.querySelector<HTMLElement>('.count')!.hidden, true);
  assert.equal(launcher.root.querySelector('.open')!.getAttribute('aria-label'), 'Open Stepnote');
  dom.window.close();
});

test('the button is registered for web pages except excluded sites, only when on and allowed', () => {
  assert.equal(launcherRegistration({ ...defaultSettings, launcher: false }, true), null);
  assert.equal(launcherRegistration(defaultSettings, false), null, 'needs site access');
  const registration = launcherRegistration({ ...defaultSettings, excludedDomains: ['mail.google.com'] }, true)!;
  assert.deepEqual(registration.matches, ['http://*/*', 'https://*/*']);
  assert.deepEqual(registration.excludeMatches, ['*://mail.google.com/*']);
  assert.deepEqual(registration.js, ['launcher.js']);
});

test('changing the button setting reaches pages that are already open', () => {
  const tabs = [{ id: 1, url: 'https://mail.google.com/inbox' }, { id: 2, url: 'https://app.example.com/' }, { id: 3, url: 'chrome://settings/' }, { id: 4 }];
  assert.deepEqual(launcherActions(tabs, { ...defaultSettings, launcher: false }, true), [{ tabId: 1, action: 'remove' }, { tabId: 2, action: 'remove' }]);
  assert.deepEqual(launcherActions(tabs, { ...defaultSettings, excludedDomains: ['mail.google.com'] }, true), [{ tabId: 1, action: 'remove' }, { tabId: 2, action: 'inject' }]);
  assert.deepEqual(launcherActions(tabs, defaultSettings, false), [{ tabId: 1, action: 'remove' }, { tabId: 2, action: 'remove' }], 'no site access: remove');
});

test('launcher messages come only from a tab and act on that tab and its site', async () => {
  const id = 'ext';
  const calls: unknown[] = [];
  const recorder = { start: async () => {}, stop: async () => {}, delete: async () => {}, click: async () => {}, status: async () => ({ recording: null }) };
  const launcher = { count: async (host: string) => { calls.push(['count', host]); return 2; }, open: async (tabId: number) => { calls.push(['open', tabId]); }, hide: async (host: string) => { calls.push(['hide', host]); } };
  const page = { id, url: 'https://app.example.com/orders?id=1', tab: { id: 4 }, frameId: 0 };
  const route = (type: string, sender: object = page) => messages.route({ type }, sender as never, id, recorder, undefined, undefined, { launcher });
  assert.equal(await route('LAUNCHER_COUNT'), 2);
  await route('LAUNCHER_OPEN');
  await route('LAUNCHER_HIDE');
  assert.deepEqual(calls, [['count', 'app.example.com'], ['open', 4], ['hide', 'app.example.com']]);
  await assert.rejects(() => route('LAUNCHER_OPEN', { ...page, frameId: 3 }), /Untrusted/);
  await assert.rejects(() => route('LAUNCHER_OPEN', { ...page, id: 'other' }), /Untrusted/);
});
