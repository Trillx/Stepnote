import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { defaultSettings, domainOf, normalizeSettings, type Settings } from '../src/settings.ts';
import { mountSidePanel } from '../src/sidepanel-ui.ts';
import type { State } from '../src/recorder.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('settings default sensibly and reject anything malformed', () => {
  assert.deepEqual(defaultSettings, { documentCount: true, launcher: true, excludedDomains: [], captureControls: 'page', tidy: true });
  assert.deepEqual(normalizeSettings(undefined), defaultSettings);
  assert.deepEqual(normalizeSettings({ documentCount: false, launcher: 'yes', excludedDomains: ['Mail.Google.com', 'bad domain', 5, 'mail.google.com'], captureControls: 'nope', tidy: false }),
    { documentCount: false, launcher: true, excludedDomains: ['mail.google.com'], captureControls: 'page', tidy: false });
});

test('domains are taken from whatever is typed: an address, a host, or a host with a path', () => {
  assert.equal(domainOf('https://www.Example.com/path?q=1'), 'www.example.com');
  assert.equal(domainOf('portal.acme.io'), 'portal.acme.io');
  assert.equal(domainOf('portal.acme.io/login'), 'portal.acme.io');
  assert.equal(domainOf('not a domain'), null);
  assert.equal(domainOf('http://10.0.0.12:8080/admin'), '10.0.0.12', 'intranet addresses can be excluded');
  assert.equal(domainOf('localhost'), 'localhost');
  assert.equal(domainOf('999.1.1.1'), null);
  assert.equal(domainOf(''), null);
});

function panel(initial: Partial<Settings> = {}) {
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  let stored: Settings = { ...defaultSettings, ...initial };
  const saves: Settings[] = [];
  const api = { load: async () => structuredClone(stored), save: async (next: Settings) => { stored = structuredClone(next); saves.push(structuredClone(next)); } };
  return { dom, root, api, saves, mount: () => mountSidePanel(root, async () => ({ recording: null } as State), () => () => {}, () => {}, () => true, () => {}, undefined, undefined, api) };
}

test('the gear opens settings; toggles and capture controls save immediately', async () => {
  const h = panel(); await h.mount();
  const gear = h.root.querySelector<HTMLButtonElement>('#settings-toggle')!;
  assert.equal(gear.getAttribute('aria-label'), 'Settings');
  assert.equal(h.root.querySelector<HTMLElement>('#settings')!.hidden, true);
  gear.click(); await tick();
  assert.equal(h.root.querySelector<HTMLElement>('#settings')!.hidden, false);
  assert.equal(h.root.querySelector<HTMLElement>('#home')!.hidden, true, 'settings replace the home screen');
  const count = h.root.querySelector<HTMLInputElement>('[name="documentCount"]')!;
  assert.equal(count.checked, true);
  assert.equal(count.getAttribute('role'), 'switch');
  count.checked = false; count.dispatchEvent(new h.dom.window.Event('change', { bubbles: true })); await tick();
  assert.equal(h.saves.at(-1)!.documentCount, false);
  const panelOnly = h.root.querySelector<HTMLInputElement>('[name="captureControls"][value="panel"]')!;
  panelOnly.checked = true; panelOnly.dispatchEvent(new h.dom.window.Event('change', { bubbles: true })); await tick();
  assert.equal(h.saves.at(-1)!.captureControls, 'panel');
  h.root.querySelector<HTMLButtonElement>('#settings-back')!.click(); await tick();
  assert.equal(h.root.querySelector<HTMLElement>('#home')!.hidden, false);
  h.dom.window.close();
});

test('excluded domains are managed in a list', async () => {
  const h = panel({ excludedDomains: ['mail.google.com'] }); await h.mount();
  h.root.querySelector<HTMLButtonElement>('#settings-toggle')!.click(); await tick();
  assert.match(h.root.querySelector('#excluded-count')!.textContent!, /\(1\)/);
  h.root.querySelector<HTMLButtonElement>('#manage-domains')!.click();
  const input = h.root.querySelector<HTMLInputElement>('#domain-input')!;
  input.value = 'https://intranet.acme.io/home'; h.root.querySelector<HTMLFormElement>('#domain-form')!.dispatchEvent(new h.dom.window.Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(h.saves.at(-1)!.excludedDomains, ['mail.google.com', 'intranet.acme.io']);
  input.value = 'not a domain'; h.root.querySelector<HTMLFormElement>('#domain-form')!.dispatchEvent(new h.dom.window.Event('submit', { cancelable: true })); await tick();
  assert.match(h.root.querySelector('#domain-error')!.textContent!, /domain/i);
  h.root.querySelector<HTMLButtonElement>('[data-remove="mail.google.com"]')!.click(); await tick();
  assert.deepEqual(h.saves.at(-1)!.excludedDomains, ['intranet.acme.io']);
  assert.match(h.root.querySelector('#excluded-count')!.textContent!, /\(1\)/);
  h.dom.window.close();
});
