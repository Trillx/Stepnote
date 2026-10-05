import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, type Store } from '../src/library.ts';
import { Recorder, type Recording, type Step } from '../src/recorder.ts';
import * as messages from '../src/messages.ts';

function memoryStore() {
  const data = new Map<string, unknown>();
  const store: Store = {
    get: async keys => Object.fromEntries(keys.filter(k => data.has(k)).map(k => [k, structuredClone(data.get(k))])),
    set: async items => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); },
    remove: async keys => { for (const k of keys) data.delete(k); },
  };
  return { store, data };
}
const guide = (id: string, title: string, extra: Partial<Recording> = {}): Recording => ({
  id, tabId: 1, windowId: 1, documentId: 'd', title, url: 'https://example.com/a', status: 'stopped', startedAt: 1000,
  steps: [{ id: 's1', label: 'Click Save', text: 'Save the invoice', title: 'T', url: 'https://example.com/a', x: 1, y: 1, width: 10, height: 10, at: 1 }], ...extra,
});
const click = { label: 'Click Save', x: 120, y: 50, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' };
const sender = { tabId: 7, frameId: 0, documentId: 'doc-1' };
function recorderPort(library: Library) {
  let saved: any = null;
  return {
    port: {
      read: async () => structuredClone(saved), write: async (value: any) => { saved = structuredClone(value); },
      target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/work', title: 'Work' }),
      inject: async () => 'doc-1', current: async () => ({ active: true, documentId: 'doc-1' }),
      capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000,
      archive: (recording: Recording, revision: number) => library.put(recording, revision),
    },
    saved: () => saved,
  };
}

test('guides are stored, listed newest first with search text, read back and removed', async () => {
  const { store } = memoryStore();
  let clock = 100;
  const library = new Library(store, () => clock);
  await library.put(guide('g1', 'Create invoice'), 5);
  clock = 200;
  await library.put(guide('g2', 'Close ticket', { guideTitle: 'Close a support ticket', description: 'For agents' }), 9);
  const list = await library.list();
  assert.deepEqual(list.map(g => [g.id, g.title, g.steps, g.updatedAt]), [['g2', 'Close a support ticket', 1, 200], ['g1', 'Create invoice', 1, 100]]);
  assert.match(list[0].search, /close a support ticket.*for agents.*save the invoice/);
  assert.deepEqual(await library.get('g1'), { recording: guide('g1', 'Create invoice'), revision: 5 });
  await library.remove('g1');
  assert.deepEqual((await library.list()).map(g => g.id), ['g2']);
  await assert.rejects(() => library.get('g1'), /not found/);
});

test('library guides are edited with the same validated commands and bump their revision', async () => {
  const { store } = memoryStore();
  const library = new Library(store, () => 1);
  await library.put(guide('g1', 'Create invoice'), 5);
  let state = await library.edit('g1', { type: 'EDIT_GUIDE', title: 'Raise an invoice' });
  assert.equal(state.recording!.guideTitle, 'Raise an invoice');
  assert.equal(state.revision, 6);
  state = await library.edit('g1', { type: 'INSERT_BLOCK', kind: 'tip', text: 'Check the PO first.', index: 0 });
  assert.equal(state.recording!.steps[0].kind, 'tip');
  state = await library.edit('g1', { type: 'DELETE_STEP', stepId: 's1' });
  assert.equal(state.recording!.steps.length, 1);
  assert.equal((await library.list())[0].title, 'Raise an invoice', 'index follows edits');
  await assert.rejects(() => library.edit('g1', { type: 'EDIT_STEP', stepId: 'missing', text: 'x' }), /not found/);
  await assert.rejects(() => library.edit('g1', { type: 'STOP' }), /Unknown/);
});

test('a new capture moves the completed guide into the library instead of refusing', async () => {
  const library = new Library(memoryStore().store, () => 1);
  const h = recorderPort(library);
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click(click, sender);
  const first = (await recorder.status()).recording!;
  assert.ok(first.id, 'guides have identities');
  await assert.rejects(() => recorder.start(), /Delete the existing recording|Complete/, 'a live capture still blocks Start');
  await recorder.stop();
  await recorder.start();
  const second = (await recorder.status()).recording!;
  assert.notEqual(second.id, first.id);
  assert.equal(second.steps.length, 0);
  const stored = await library.get(first.id!);
  assert.equal((stored.recording.steps[0] as Step).label, 'Click Save');
  assert.equal(stored.recording.status, 'stopped');
});

test('Done archives a completed guide and clears the active one; a live capture cannot be archived', async () => {
  const library = new Library(memoryStore().store, () => 1);
  const h = recorderPort(library);
  const recorder = new Recorder(h.port);
  await recorder.start();
  await assert.rejects(() => recorder.archive(), /Complete/);
  await recorder.stop();
  const id = (await recorder.status()).recording!.id!;
  await recorder.archive();
  assert.equal((await recorder.status()).recording, null);
  assert.equal(h.saved().recording, null);
  assert.deepEqual((await library.list()).map(g => g.id), [id]);
});

test('a saved guide from before the library gets an identity on load', async () => {
  const library = new Library(memoryStore().store, () => 1);
  const h = recorderPort(library);
  await h.port.write({ recording: { ...guide('ignored', 'Old'), id: undefined }, revision: 3 });
  const recorder = new Recorder(h.port);
  const r = (await recorder.status()).recording!;
  assert.match(r.id!, /^[0-9a-f-]{36}$/);
  assert.equal(h.saved().recording.id, r.id);
});

test('guide-addressed commands go to the active guide or the library', async () => {
  const id = 'test-extension';
  const base = `chrome-extension://${id}/`;
  const library = new Library(memoryStore().store, () => 50);
  await library.put(guide('old', 'Old guide'), 4);
  const calls: unknown[] = [];
  const active = guide('live', 'Live guide', { status: 'recording' });
  const recorder = {
    start: async () => {}, stop: async () => {}, click: async () => {},
    delete: async (id?: string) => { if (id !== undefined && id !== 'live') return false; calls.push('delete-active'); return true; },
    archive: async () => { calls.push('archive'); },
    status: async () => ({ recording: structuredClone(active), revision: 10 }),
    edit: async (command: any) => { if (command?.guideId !== undefined && command.guideId !== 'live') return false; calls.push(['edit-active', command]); return true; },
    deleteStep: async (stepId: string, id?: string) => { if (id !== undefined && id !== 'live') return false; calls.push(['delete-step-active', stepId]); return true; },
  };
  const viewer = { id, url: base + 'viewer.html', frameId: 0 };
  const panel = { id, url: base + 'sidepanel.html', frameId: 0 };
  const route = (message: unknown, sender = viewer) => messages.route(message, sender, id, recorder, library);
  const listed = await route({ type: 'LIST_GUIDES' }) as { guides: { id: string; active?: boolean }[] };
  assert.deepEqual(listed.guides.map(g => [g.id, !!g.active]), [['live', true], ['old', false]]);
  assert.equal(((await route({ type: 'GET_GUIDE', guideId: 'old' })) as any).recording.title, 'Old guide');
  assert.equal(((await route({ type: 'GET_GUIDE', guideId: 'live' })) as any).recording.title, 'Live guide');
  const edited = await route({ type: 'EDIT_GUIDE', guideId: 'old', title: 'Renamed' }) as any;
  assert.equal(edited.recording.guideTitle, 'Renamed');
  await route({ type: 'EDIT_STEP', guideId: 'live', stepId: 's1', text: 'x' });
  await route({ type: 'DELETE_STEP', guideId: 'live', stepId: 's1' });
  await route({ type: 'DELETE_STEP', guideId: 'old', stepId: 's1' });
  assert.equal((await library.get('old')).recording.steps.length, 0);
  await route({ type: 'DELETE_GUIDE', guideId: 'old' });
  await assert.rejects(() => library.get('old'), /not found/);
  await route({ type: 'DELETE_GUIDE', guideId: 'live' });
  await route({ type: 'ARCHIVE' }, panel);
  assert.deepEqual(calls.map(c => Array.isArray(c) ? c[0] : c), ['edit-active', 'delete-step-active', 'delete-active', 'archive']);
  await assert.rejects(() => route({ type: 'GET_GUIDE', guideId: '../x' }), /Invalid guide/);
  await assert.rejects(() => route({ type: 'GET_GUIDE', guideId: 'missing' }), /not found/);
  await assert.rejects(() => route({ type: 'ARCHIVE' }), /Unknown/, 'only the panel archives');
  const print = { id, url: base + 'print.html', frameId: 0 };
  await library.put(guide('p', 'Printable'), 1);
  assert.equal(((await route({ type: 'GET_GUIDE', guideId: 'p' }, print)) as any).recording.title, 'Printable');
  await assert.rejects(() => route({ type: 'DELETE_GUIDE', guideId: 'p' }, print), /read-only/);
});

test('pages opened for a guide are trusted by path, not by their query string', async () => {
  const id = 'test-extension';
  const base = `chrome-extension://${id}/`;
  const library = new Library(memoryStore().store, () => 1);
  await library.put(guide('g1', 'Guide one'), 1);
  const recorder = { start: async () => {}, stop: async () => {}, delete: async () => {}, click: async () => {}, status: async () => ({ recording: null }) };
  for (const url of [base + 'viewer.html?guide=g1', base + 'print.html?guide=g1#top']) {
    const state = await messages.route({ type: 'GET_GUIDE', guideId: 'g1' }, { id, url, frameId: 0 }, id, recorder, library) as any;
    assert.equal(state.recording.title, 'Guide one');
  }
  await assert.rejects(() => messages.route({ type: 'STATUS' }, { id, url: base + 'other.html?viewer.html', frameId: 0 }, id, recorder, library), /Untrusted/);
  await assert.rejects(() => messages.route({ type: 'DELETE_GUIDE', guideId: 'g1' }, { id, url: base + 'print.html?guide=g1', frameId: 0 }, id, recorder, library), /read-only/);
});

test('guide summaries remember the site they were captured on', async () => {
  const library = new Library(memoryStore().store, () => 1);
  await library.put(guide('g1', 'Create invoice', { url: 'https://billing.example.com/invoices' }), 1);
  assert.equal((await library.list())[0].host, 'billing.example.com');
});

test('sites match ignoring a leading www', async () => {
  const { sameSite } = await import('../src/library.ts');
  assert.equal(sameSite('www.example.com', 'example.com'), true);
  assert.equal(sameSite('app.example.com', 'example.com'), false);
  assert.equal(sameSite(undefined, 'example.com'), false);
  assert.equal(sameSite('wwwa.com', 'a.com'), false, 'only a real www. prefix is ignored');
});
