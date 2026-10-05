import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('a delayed stopped badge update cannot disarm a newly started capture', async t => {
  const original = globalThis.chrome;
  t.after(() => { globalThis.chrome = original; });
  let listener: any;
  let updated!: (tabId: number, change: { url?: string; status?: string }) => void;
  let activated!: (info: { tabId: number; windowId: number }) => void;
  let documentId = 'doc-1';
  let armed = false;
  let validationFails = false;
  let injections = 0;
  let holdStopped = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let holding!: () => void;
  const startedHolding = new Promise<void>(resolve => { holding = resolve; });
  const id = 'owned-extension';
  const tab = { id: 7, windowId: 2, active: true, status: 'complete', url: 'https://example.com/work', title: 'Work' };
  globalThis.chrome = {
    action: {
      onClicked: { addListener: () => {} },
      setBadgeText: async ({ text }: { text: string }) => {
        if (holdStopped && text === '') { holdStopped = false; holding(); await held; }
      },
      setBadgeBackgroundColor: async () => {},
    },
    sidePanel: { open: async () => {} },
    runtime: { id, onMessage: { addListener: (fn: any) => { listener = fn; } }, sendMessage: async () => {} },
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } },
    tabs: {
      get: async () => tab,
      sendMessage: async (_id: number, message: { type: string }) => {
        if (message.type === 'DISARM') armed = false;
        if (message.type === 'FINALIZE_INPUT') { armed = false; return { actions: [] }; }
      },
      onUpdated: { addListener: (fn: typeof updated) => { updated = fn; } }, onRemoved: { addListener: () => {} }, onCreated: { addListener: () => {} },
      onActivated: { addListener: (fn: typeof activated) => { activated = fn; } },
      query: async () => [tab],
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: () => {} } },
    scripting: { executeScript: async ({ files }: { files?: string[] }) => {
      if (validationFails) throw new Error('Document access lost');
      if (files) { armed = true; injections++; }
      return [{ documentId }];
    } },
  } as unknown as typeof chrome;
  await import('../src/background.ts');
  const command = (type: string) => new Promise<any>((resolve, reject) => {
    listener({ type, tabId: 7, windowId: 2 }, { id, url: `chrome-extension://${id}/sidepanel.html` }, (reply: any) => reply.ok ? resolve(reply.result) : reject(new Error(reply.error)));
  });
  await command('STATUS'); await tick();
  await command('START'); await tick();
  holdStopped = true;
  await command('STOP'); await startedHolding;
  await command('DELETE');
  const next = await command('START');
  assert.equal(next.recording.status, 'recording');
  assert.equal(armed, true);
  release(); await tick(); await tick();
  assert.equal(armed, true, 'An old stop must not remove the new content listener');
  await t.test('loading-only then URL and complete preserve the original document', async () => {
    updated(7, { status: 'loading' }); await tick(); await tick();
    assert.equal((await command('STATUS')).recording.status, 'recording', 'Same-document loading without URL must not stop capture');
    updated(7, { status: 'complete' }); await tick(); await tick();
    updated(7, { url: 'https://example.com/work#client-details', status: 'loading' }); await tick(); await tick();
    updated(7, { status: 'complete' }); await tick(); await tick();
    assert.equal((await command('STATUS')).recording.status, 'recording');
  });
  await t.test('a replacement document is followed once it completes', async () => {
    const before = injections;
    updated(7, { url: 'https://example.com/route-two', status: 'loading' }); await tick(); await tick();
    assert.equal((await command('STATUS')).recording.status, 'recording');
    documentId = 'new-document'; tab.status = 'loading';
    updated(7, { url: 'https://example.com/new-document', status: 'loading' }); await tick(); await tick();
    assert.equal((await command('STATUS')).recording.documentId, '', 'a loading replacement is not armed');
    tab.status = 'complete';
    updated(7, { status: 'complete' }); await tick(); await tick();
    const followed = await command('STATUS');
    assert.equal(followed.recording.status, 'recording');
    assert.equal(followed.recording.documentId, 'new-document');
    assert.equal(injections, before + 1);
  });
  await t.test('reload can still expose the old document at loading and is re-armed at complete', async () => {
    await command('DELETE'); documentId = 'doc-1'; await command('START');
    const before = injections;
    tab.status = 'loading';
    updated(7, { status: 'loading' }); await tick(); await tick();
    assert.equal(injections, before);
    documentId = 'reloaded-document'; tab.status = 'complete';
    updated(7, { status: 'complete' }); await tick(); await tick();
    const reloaded = await command('STATUS');
    assert.equal(reloaded.recording.status, 'recording');
    assert.equal(reloaded.recording.documentId, 'reloaded-document');
    assert.equal(injections, before + 1);
  });
  await t.test('failed page access keeps capture alive with a visible notice', async () => {
    await command('DELETE'); documentId = 'doc-1'; await command('START');
    validationFails = true;
    updated(7, { status: 'loading' }); await tick(); await tick();
    const failed = await command('STATUS');
    assert.equal(failed.recording.status, 'recording');
    assert.equal(failed.recording.documentId, '');
    assert.match(failed.recording.notice, /web page/);
    validationFails = false;
    updated(7, { status: 'complete' }); await tick(); await tick();
    assert.equal((await command('STATUS')).recording.notice, undefined);
  });
  await t.test('a tab moved to a different window is followed there', async () => {
    await command('DELETE'); await command('START');
    tab.windowId = 9;
    activated({ tabId: 7, windowId: 9 }); await tick(); await tick();
    const moved = await command('STATUS');
    assert.equal(moved.recording.status, 'recording');
    assert.equal(moved.recording.windowId, 9);
  });
});

test('failed commands reply with the message only, without an "Error:" prefix', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../src/background.ts', import.meta.url), 'utf8');
  assert.match(source, /error: error instanceof Error \? error\.message : String\(error\)/);
});
