import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountLibrary } from '../src/library-ui.ts';
import { bindGuide } from '../src/guide-client.ts';
import { mountSidePanel } from '../src/sidepanel-ui.ts';
import type { GuideSummary } from '../src/library.ts';
import type { State } from '../src/recorder.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const guides: GuideSummary[] = [
  { id: 'live', title: 'Current capture', steps: 2, startedAt: Date.UTC(2026, 9, 2), updatedAt: 300, search: 'current capture click save', active: true },
  { id: 'g2', title: 'Close a <ticket>', steps: 1, startedAt: Date.UTC(2026, 8, 30), updatedAt: 200, search: 'close a <ticket> resolve the ticket' },
  { id: 'g1', title: 'Create invoice', steps: 5, startedAt: Date.UTC(2026, 8, 1), updatedAt: 100, search: 'create invoice enter the amount' },
];

test('the library lists guides as safe text, marks the current one, and opens a guide', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  const opened: string[] = [];
  await mountLibrary(root, { list: async () => guides, open: id => { opened.push(id); } });
  const items = [...root.querySelectorAll<HTMLButtonElement>('.guide-item')];
  assert.deepEqual(items.map(i => i.dataset.id), ['live', 'g2', 'g1']);
  assert.equal(items[1].querySelector('.guide-title')!.textContent, 'Close a <ticket>');
  assert.equal(root.querySelectorAll('ticket').length, 0);
  assert.match(items[2].querySelector('.guide-meta')!.textContent!, /5 steps/);
  assert.match(items[1].querySelector('.guide-meta')!.textContent!, /1 step\b/);
  assert.equal(items[0].querySelector('.guide-badge')!.textContent, 'Current');
  items[2].click();
  assert.deepEqual(opened, ['g1']);
  dom.window.close();
});

test('search matches every word in titles and step text, and explains empty results', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  await mountLibrary(root, { list: async () => guides, open: () => {} });
  const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
  const visible = () => [...root.querySelectorAll<HTMLElement>('.guide-item')].filter(i => !i.closest('li')!.hidden).map(i => i.dataset.id);
  search.value = 'AMOUNT invoice'; search.dispatchEvent(new dom.window.Event('input'));
  assert.deepEqual(visible(), ['g1']);
  search.value = 'payroll'; search.dispatchEvent(new dom.window.Event('input'));
  assert.deepEqual(visible(), []);
  assert.match(root.querySelector('.library-empty')!.textContent!, /No guides match “payroll”/);
  const empty = new JSDOM('<main></main>');
  await mountLibrary(empty.window.document.querySelector('main')!, { list: async () => [], open: () => {} });
  assert.match(empty.window.document.querySelector('.library-empty')!.textContent!, /Guides you complete are saved here/);
  dom.window.close(); empty.window.close();
});

test('an editor bound to a guide addresses every command to it and follows it into the library', async () => {
  const sent: any[] = [];
  let push!: (state: State) => void;
  const send = async (message: any) => { sent.push(message); return { recording: { id: 'g1' } as any, revision: 7 }; };
  const bound = bindGuide(send, listener => { push = listener; return () => {}; }, 'g1');
  await bound.send({ type: 'STATUS' });
  await bound.send({ type: 'EDIT_STEP', stepId: 's', text: 'x' });
  await bound.send({ type: 'DELETE' });
  await bound.send({ type: 'STOP' });
  assert.deepEqual(sent, [{ type: 'GET_GUIDE', guideId: 'g1' }, { type: 'EDIT_STEP', stepId: 's', text: 'x', guideId: 'g1' }, { type: 'DELETE_GUIDE', guideId: 'g1' }, { type: 'STOP', guideId: 'g1' }]);
  const seen: State[] = [];
  bound.subscribe!(state => { seen.push(state); });
  push({ recording: { id: 'other' } as any, revision: 1 });
  assert.equal(seen.length, 0, 'updates for other guides are ignored');
  push({ recording: { id: 'g1' } as any, revision: 2 });
  assert.equal(seen.length, 1);
  sent.length = 0;
  push({ recording: null, revision: 3 });
  await tick();
  assert.deepEqual(sent, [{ type: 'GET_GUIDE', guideId: 'g1' }], 'when the active guide leaves, reload it from the library');
  assert.equal(seen.at(-1)!.revision, 7);
});

test('panel home lists guides; Done files a completed capture and returns home', async () => {
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  let state: State = { recording: { id: 'live', tabId: 1, windowId: 1, documentId: 'd', title: 'T', url: 'https://example.com/', status: 'stopped', startedAt: 1, steps: [] } };
  const calls: string[] = [];
  const request = async (type: string) => { calls.push(type); if (type === 'ARCHIVE') state = { recording: null }; return structuredClone(state); };
  let lists = 0; const opened: string[] = [];
  await mountSidePanel(root, request, () => () => {}, () => {}, () => true, () => {}, undefined, { list: async () => { lists++; return guides.slice(1); }, open: id => { opened.push(id); } });
  assert.equal(root.querySelector<HTMLElement>('#home')!.hidden, true);
  const done = root.querySelector<HTMLButtonElement>('#done')!;
  assert.equal(done.textContent, 'Done');
  done.click(); await tick(); await tick();
  assert.deepEqual(calls, ['STATUS', 'ARCHIVE']);
  assert.equal(root.querySelector<HTMLElement>('#home')!.hidden, false);
  assert.ok(lists >= 1);
  assert.deepEqual([...root.querySelectorAll<HTMLElement>('#home .guide-item')].map(i => i.dataset.id), ['g2', 'g1']);
  root.querySelector<HTMLButtonElement>('#home .guide-item')!.click();
  assert.deepEqual(opened, ['g2']);
  dom.window.close();
});

test('automatic blur is on by default, sent with Start, and remembered when turned off', async () => {
  const dom = new JSDOM('<main id="app"></main>', { url: 'https://stepnote.test/sidepanel.html' });
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  const starts: unknown[] = [];
  const request = async (type: string, _stepId?: string, extra?: Record<string, unknown>) => { if (type === 'START') starts.push(extra); return { recording: null } as State; };
  await mountSidePanel(root, request, () => () => {}, () => {}, () => true, () => {});
  const toggle = root.querySelector<HTMLInputElement>('#auto-blur')!;
  assert.equal(toggle.checked, true);
  assert.match(toggle.closest('label')!.textContent!, /Blur private info automatically/);
  root.querySelector<HTMLButtonElement>('#start')!.click(); await tick();
  toggle.checked = false; toggle.dispatchEvent(new dom.window.Event('change'));
  root.querySelector<HTMLButtonElement>('#start')!.click(); await tick();
  assert.deepEqual(starts, [{ autoBlur: true }, { autoBlur: false }]);
  assert.equal(dom.window.localStorage.getItem('stepnote.autoBlur'), 'off');
  root.remove();
  const again = dom.window.document.createElement('main'); dom.window.document.body.append(again);
  await mountSidePanel(again, request, () => () => {}, () => {}, () => true, () => {});
  assert.equal(again.querySelector<HTMLInputElement>('#auto-blur')!.checked, false, 'remembered on this device');
  dom.window.close();
});

test('the guide list refreshes when guides change elsewhere', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  let current = guides.slice(1);
  let changed!: () => void;
  await mountLibrary(root, { list: async () => current, open: () => {}, subscribe: listener => { changed = listener; } });
  assert.equal(root.querySelectorAll('.guide-item').length, 2);
  current = current.filter(g => g.id !== 'g2'); // deleted in the editor
  changed(); await tick();
  assert.deepEqual([...root.querySelectorAll<HTMLElement>('.guide-item')].map(i => i.dataset.id), ['g1']);
  dom.window.close();
});

test('an editor for a guide that no longer exists shows the empty state, not an error', async () => {
  const bound = bindGuide(async () => { throw new Error('Guide not found.'); }, () => () => {}, 'gone');
  const state = await bound.send({ type: 'STATUS' });
  assert.equal(state.recording, null);
  await assert.rejects(() => bindGuide(async () => { throw new Error('Disk unavailable'); }, () => () => {}, 'g').send({ type: 'STATUS' }), /Disk unavailable/, 'other errors still surface');
});

test('guide rows show a site monogram, the title, a step chip and the date', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  await mountLibrary(root, { list: async () => [
    { ...guides[1], host: 'www.zendesk.com' },
    { ...guides[2], host: undefined },
    { ...guides[2], id: 'ip', title: 'Router setup', host: '127.0.0.1:8080' },
  ], open: () => {} });
  const [first, second] = [...root.querySelectorAll<HTMLElement>('.guide-item')];
  assert.equal(first.querySelector('.guide-avatar')!.textContent, 'Z', 'first letter of the site, without www');
  assert.equal(first.querySelector('.guide-avatar')!.getAttribute('aria-hidden'), 'true');
  assert.equal(second.querySelector('.guide-avatar')!.textContent, 'C', 'falls back to the title');
  assert.equal(root.querySelector('[data-id="ip"] .guide-avatar')!.textContent, 'R', 'an address without a name uses the title');
  assert.equal(first.querySelector('.guide-chip')!.textContent, '1 step');
  assert.ok(root.querySelector('.library-search svg'), 'search field has an icon');
  dom.window.close();
});

test('Start Capture is a single clear action with a record icon', async () => {
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  await mountSidePanel(root, async () => ({ recording: null } as State), () => () => {}, () => {}, () => true, () => {});
  const start = root.querySelector<HTMLButtonElement>('#start')!;
  assert.equal(start.textContent!.trim(), 'Start Capture');
  assert.ok(start.querySelector('svg[aria-hidden="true"]'));
  assert.ok(root.querySelector('.brand-mark[aria-hidden="true"]'), 'header carries the logo mark');
  dom.window.close();
});

test('guides for the current site are listed first with Guide me', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main')!;
  const started: string[] = [];
  let host: string | null = 'app.example.com';
  const shelf = await mountLibrary(root, {
    list: async () => [{ ...guides[1], host: 'app.example.com' }, { ...guides[2], host: 'www.app.example.com' }, { ...guides[0], host: 'other.org' }],
    open: () => {}, currentHost: async () => host, guideMe: id => { started.push(id); },
  });
  const site = root.querySelector<HTMLElement>('.site-guides')!;
  assert.equal(site.hidden, false);
  assert.match(site.querySelector('h2')!.textContent!, /On this site \(2\)/);
  assert.deepEqual([...site.querySelectorAll<HTMLElement>('.guide-item')].map(i => i.dataset.id), ['g2', 'g1'], 'www is ignored');
  site.querySelector<HTMLButtonElement>('[data-guide-me="g1"]')!.click();
  assert.deepEqual(started, ['g1']);
  assert.equal(root.querySelectorAll('.guide-list:not(.site-list) .guide-item').length, 3, 'all guides stay listed below');
  host = null; await shelf.refresh();
  assert.equal(site.hidden, true, 'hidden when the site is unknown');
  dom.window.close();
});
