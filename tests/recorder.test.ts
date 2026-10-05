import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../src/recorder.ts';

test('late text from an old capture or pre-pause listener cannot enter a new arm in the same document', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const old = { ...click, kind: 'type', sequence: 1, final: false, actionId: 'old-entry', label: 'Type "discarded"', captureId: (await recorder.status()).recording!.captureId };
  await recorder.stop(); await recorder.delete(); await recorder.start();
  await recorder.input(old, sender);
  await recorder.click({ ...click, captureId: old.captureId }, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
  const paused = { ...old, actionId: 'paused-entry', captureId: (await recorder.status()).recording!.captureId };
  await recorder.pause(); await recorder.resume();
  await recorder.input(paused, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
});

test('a document drain cannot duplicate an admitted entry or resurrect it after deletion', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const input = { ...click, kind: 'type', sequence: 1, final: false, actionId: 'entry-1', label: 'Type "ordinary"', captureId: (await recorder.status()).recording!.captureId };
  await recorder.input(input, sender);
  const step = (await recorder.status()).recording!.steps[0];
  await recorder.deleteStep(step.id!);
  Object.assign(h.port, { finalize: async () => [input] });
  await recorder.pause();
  assert.equal((await recorder.status()).recording!.steps.length, 0);
  await recorder.resume();
  await recorder.input(input, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
});

test('failed text drain stops safely with a visible final-entry warning', async () => {
  const h = harness(); Object.assign(h.port, { finalize: async () => { throw new Error('Document unavailable'); } });
  const recorder = new Recorder(h.port); await recorder.start(); await recorder.stop();
  const state = await recorder.status();
  assert.equal(state.recording!.status, 'stopped');
  assert.match(state.error!, /Final text.*Document unavailable/);
});

test('input validates its action kind, bounded label, identity and document, and whitelists metadata', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const input = { ...click, kind: 'type', sequence: 1, final: false, actionId: 'entry-1', label: 'Type "ordinary"', captureId: (await recorder.status()).recording!.captureId };
  for (const payload of [null, { ...input, kind: 'click' }, { ...input, actionId: '../bad' }, { ...input, label: 'unrelated label' }, { ...input, label: 'x'.repeat(2201) }, { ...input, x: NaN }, { ...input, url: 'https://' }]) await recorder.input(payload, sender);
  for (const source of [{ ...sender, tabId: 99 }, { ...sender, frameId: 1 }, { ...sender, documentId: 'old' }]) await recorder.input(input, source);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
  await recorder.input({ ...input, password: 'excluded', rawKeys: ['excluded'] }, sender);
  assert.equal(h.saved().recording.steps[0].kind, 'type');
  assert.doesNotMatch(JSON.stringify(h.saved()), /excluded|rawKeys|password/);
});

test('stopping preserves steps across reload until explicit deletion', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  assert.equal(typeof recorder.stop, 'function');
  await recorder.stop();
  const reopened = new Recorder(h.port);
  assert.equal((await reopened.status()).recording?.status, 'stopped');
  await reopened.delete();
  assert.equal((await new Recorder(h.port).status()).recording, null);
});

const click = { label: 'Click Save', x: 120, y: 50, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' };
const sender = { tabId: 7, frameId: 0, documentId: 'doc-1' };

test('a click becomes an ordered persisted step with a screenshot', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  assert.equal(typeof recorder.click, 'function');
  await recorder.click(click, sender);
  const step = (await recorder.status()).recording!.steps[0];
  assert.equal(step.label, 'Click Save');
  assert.equal(step.x, 120);
  assert.equal(step.screenshot, 'data:image/jpeg;base64,YQ==');
  assert.equal(h.saved().recording.steps.length, 1);
});

test('invalid or foreign click messages cannot create steps', async () => {
  for (const [payload, source] of [
    [click, { ...sender, tabId: 9 }], [click, { ...sender, frameId: 1 }],
    [click, { ...sender, documentId: 'old' }], [{ ...click, x: -1 }, sender],
    [{ ...click, x: NaN }, sender], [{ ...click, height: 0 }, sender],
    [{ ...click, label: 'x'.repeat(161) }, sender], [{ ...click, url: 'javascript:alert(1)' }, sender],
    [{ ...click, title: 4 }, sender], [null, sender],
  ] as any[]) {
    const h = harness();
    const recorder = new Recorder(h.port);
    await recorder.start();
    await recorder.click(payload, source);
    assert.equal((await recorder.status()).recording!.steps.length, 0);
  }
});

test('capture skips a different active tab and discards stale document images', async () => {
  for (const changedAfter of [false, true]) {
    const h = harness();
    let checks = 0;
    let captures = 0;
    h.port.current = async () => {
      checks++;
      return { active: changedAfter || false, documentId: changedAfter && checks > 1 ? 'new-doc' : 'doc-1' };
    };
    h.port.capture = async () => { captures++; return 'data:image/jpeg;base64,YQ=='; };
    const recorder = new Recorder(h.port);
    await recorder.start();
    await recorder.click(click, sender);
    const step = (await recorder.status()).recording!.steps[0];
    assert.equal(step.screenshot, undefined);
    assert.match(step.reason!, /tab or document changed/i);
    assert.equal(captures, changedAfter ? 1 : 0);
  }
});

test('rapid clicks remain visible while screenshot calls are rate limited', async () => {
  const h = harness();
  let captures = 0;
  h.port.capture = async () => { captures++; return 'data:image/jpeg;base64,YQ=='; };
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click(click, sender);
  await recorder.click(click, sender);
  assert.equal(captures, 1);
  assert.match((await recorder.status()).recording!.steps[1].reason!, /rate limit/i);
  h.port.now = () => 1650;
  await recorder.click(click, sender);
  assert.equal(captures, 2);
});

test('capture API errors keep the click with a visible reason', async () => {
  for (const operation of ['capture', 'current'] as const) {
    const h = harness();
    h.port[operation] = async () => { throw new Error('Permission denied'); };
    const recorder = new Recorder(h.port);
    await recorder.start();
    await recorder.click(click, sender);
    const step = (await recorder.status()).recording!.steps[0];
    assert.equal(step.screenshot, undefined);
    assert.match(step.reason!, /Permission denied/);
  }
});

test('storage failure stops capture and exposes unsaved state without losing memory', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  h.port.write = async () => { throw new Error('Quota exceeded'); };
  await recorder.click(click, sender);
  const state = await recorder.status();
  assert.equal(state.recording!.status, 'stopped');
  assert.equal(state.recording!.steps.length, 1);
  assert.match(state.error!, /not saved.*Quota exceeded/i);
});

test('navigation invalidates an in-flight screenshot and stops the document session', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  assert.equal(typeof recorder.invalidate, 'function');
  h.port.capture = async () => {
    recorder.invalidate(7, 'Navigation ended recording.');
    return 'data:image/jpeg;base64,YQ==';
  };
  await recorder.click(click, sender);
  const state = await recorder.status();
  assert.equal(state.recording!.status, 'stopped');
  assert.equal(state.recording!.steps[0].screenshot, undefined);
  assert.match(state.recording!.stoppedReason!, /Navigation/);
  await recorder.click(click, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 1);
});

test('simultaneous starts serialize so only one recording is created', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  const results = await Promise.allSettled([recorder.start(), recorder.start()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('worker restart restores saved steps but does not resume recording', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click(click, sender);
  const state = await new Recorder(h.port).status();
  assert.equal(state.recording!.status, 'stopped');
  assert.match(state.recording!.stoppedReason!, /worker restarted/i);
  assert.equal(state.recording!.steps.length, 1);
});

test('persisted steps whitelist metadata instead of copying unexpected field values', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click({ ...click, value: 'private', password: 'secret' }, sender);
  assert.doesNotMatch(JSON.stringify(h.saved()), /private|secret/);
});

test('navigation during the pre-capture check prevents the screenshot API call', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  let captures = 0;
  h.port.capture = async () => { captures++; return 'data:image/jpeg;base64,YQ=='; };
  h.port.current = async () => {
    recorder.invalidate(7, 'Navigation ended recording.');
    return { active: true, documentId: 'doc-1' };
  };
  await recorder.start();
  await recorder.click(click, sender);
  assert.equal(captures, 0);
  assert.equal((await recorder.status()).recording!.steps.length, 1);
});

test('failed deletion keeps the saved recording visible and blocks overwrite', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  h.port.write = async () => { throw new Error('Disk unavailable'); };
  await recorder.delete();
  const state = await recorder.status();
  assert.ok(state.recording);
  assert.match(state.error!, /Deletion failed/);
  await assert.rejects(() => recorder.start(), /Delete the existing recording/);
});

test('malformed HTTP URLs in click payloads are rejected', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click({ ...click, url: 'https://' }, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
});

test('navigation preserves clicks received while an earlier screenshot was pending', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  let captureStarted!: () => void;
  const capturing = new Promise<void>(resolve => { captureStarted = resolve; });
  let releaseCapture!: (image: string) => void;
  const release = new Promise<string>(resolve => { releaseCapture = resolve; });
  let captures = 0;
  h.port.capture = async () => { captures++; captureStarted(); return release; };
  const first = recorder.click(click, sender);
  await capturing;
  const second = recorder.click({ ...click, label: 'Click Navigate' }, sender);
  recorder.invalidate(7, 'Navigation ended recording.');
  releaseCapture('data:image/jpeg;base64,YQ==');
  await Promise.all([first, second]);
  const state = await recorder.status();
  assert.deepEqual(state.recording!.steps.map(step => step.label), ['Click Save', 'Click Navigate']);
  assert.equal(state.recording!.steps[1].screenshot, undefined);
  assert.match(state.recording!.steps[1].reason!, /ended|changed/i);
  assert.equal(captures, 1);
  await recorder.click(click, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 2);
});

test('pause suppresses clicks, persists steps, and resume arms the page in focus', async () => {
  const h = harness();
  let injections = 0;
  h.port.inject = async () => { injections++; return 'doc-1'; };
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click(click, sender);
  assert.equal(typeof recorder.pause, 'function');
  await recorder.pause();
  await recorder.click(click, sender);
  assert.equal((await recorder.status()).recording!.status, 'paused');
  assert.equal(h.saved().recording.steps.length, 1);
  await recorder.resume();
  assert.equal(injections, 2);
  await recorder.click(click, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 2);
  await recorder.pause();
  h.port.current = async () => ({ active: false, documentId: 'doc-1' });
  await assert.rejects(() => recorder.resume(), /Switch to a loaded web page/i);
  assert.equal(injections, 2);
  assert.equal((await recorder.status()).recording!.status, 'paused');
  h.port.current = async () => ({ active: true, documentId: 'new-document' });
  h.port.inject = async () => { injections++; return 'new-document'; };
  await recorder.resume();
  assert.equal((await recorder.status()).recording!.documentId, 'new-document', 'a page loaded while paused is armed on Resume');
  await recorder.click(click, { ...sender, documentId: 'new-document' });
  assert.equal((await recorder.status()).recording!.steps.length, 3);
});

test('pause closes click admission immediately while an earlier screenshot is pending', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  let started!: () => void;
  const capturing = new Promise<void>(resolve => { started = resolve; });
  let release!: (image: string) => void;
  h.port.capture = async () => { started(); return new Promise<string>(resolve => { release = resolve; }); };
  const first = recorder.click(click, sender);
  await capturing;
  const pause = recorder.pause();
  const later = recorder.click({ ...click, label: 'Paused click' }, sender);
  release('data:image/jpeg;base64,YQ==');
  await Promise.all([first, pause, later]);
  assert.equal((await recorder.status()).recording!.steps.length, 1);
  assert.equal((await recorder.status()).recording!.status, 'paused');
});

test('step deletion uses stable IDs so stale actions cannot delete a neighbor', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.click(click, sender);
  await recorder.click({ ...click, label: 'Click Next' }, sender);
  const steps = (await recorder.status()).recording!.steps;
  assert.equal(typeof steps[0].id, 'string');
  assert.notEqual(steps[0].id, steps[1].id);
  await Promise.all([recorder.deleteStep(steps[0].id!), recorder.deleteStep(steps[0].id!)]);
  assert.deepEqual(h.saved().recording.steps.map((s: any) => s.label), ['Click Next']);
  await recorder.deleteStep(steps[1].id!);
  assert.equal(h.saved().recording.steps.length, 0);
});

test('change notifications include unsaved memory but status reads do not republish images', async () => {
  const h = harness();
  const changes: any[] = [];
  Object.assign(h.port, { notify: (state: any) => changes.push(structuredClone(state)) });
  const recorder = new Recorder(h.port);
  await recorder.start();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].revision, (await recorder.status()).revision);
  assert.ok(Number.isSafeInteger(changes[0].revision));
  await recorder.status();
  assert.equal(changes.length, 1);
  h.port.write = async () => { throw new Error('Quota exceeded'); };
  await recorder.click(click, sender);
  assert.equal(changes.at(-1).recording.steps.length, 1);
  assert.match(changes.at(-1).error, /not saved/i);
  assert.ok(changes.at(-1).revision > changes[0].revision);
  assert.equal(changes.at(-1).revision, (await recorder.status()).revision);
});

test('starter recordings keep their data and acquire persisted stable step identities', async () => {
  const h = harness();
  const first = new Recorder(h.port);
  await first.start();
  await first.click(click, sender);
  await first.stop();
  const legacy = h.saved();
  delete legacy.recording.steps[0].id;
  await h.port.write(legacy);
  const restored = (await new Recorder(h.port).status()).recording!;
  assert.equal(restored.steps[0].label, click.label);
  assert.equal(restored.steps[0].screenshot, 'data:image/jpeg;base64,YQ==');
  assert.equal(typeof restored.steps[0].id, 'string');
  assert.equal(h.saved().recording.steps[0].id, restored.steps[0].id);
});

test('a pause arriving during resume still wins when the queued commands finish', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await recorder.pause();
  let entered!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let checks = 0;
  h.port.current = async () => {
    if (++checks === 1) { entered(); await gate; }
    return { active: true, documentId: 'doc-1' };
  };
  const resume = recorder.resume();
  await checking;
  const pause = recorder.pause();
  release();
  await Promise.all([resume, pause]);
  assert.equal((await recorder.status()).recording!.status, 'paused');
  await recorder.click(click, sender);
  assert.equal((await recorder.status()).recording!.steps.length, 0);
});

function harness() {
  let saved: any = null;
  const port = {
    read: async () => structuredClone(saved),
    write: async (value: any) => { saved = structuredClone(value); },
    target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/work', title: 'Work' }),
    inject: async () => 'doc-1',
    current: async () => ({ active: true, documentId: 'doc-1' }),
    capture: async () => 'data:image/jpeg;base64,YQ==',
    now: () => 1000,
  };
  return { port, saved: () => saved };
}

test('explicit start persists a recording bound to the selected document', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  const state = await recorder.status();
  assert.equal(state.recording?.status, 'recording');
  assert.equal(state.recording?.tabId, 7);
  assert.equal(state.recording?.documentId, 'doc-1');
  assert.deepEqual(state.recording?.steps, []);
  assert.equal(h.saved().recording.title, 'Work');
});

test('starting again cannot overwrite an existing local recording', async () => {
  const h = harness();
  const recorder = new Recorder(h.port);
  await recorder.start();
  await assert.rejects(() => recorder.start(), /Delete the existing recording/);
  assert.equal(h.saved().recording.startedAt, 1000);
});
