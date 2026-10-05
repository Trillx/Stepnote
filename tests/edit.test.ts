import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, isStep, type Block, type Step } from '../src/recorder.ts';
import * as messages from '../src/messages.ts';

const click = { label: 'Click Save', x: 120, y: 50, width: 800, height: 600, url: 'https://example.com/work', title: 'Work' };
const sender = { tabId: 7, frameId: 0, documentId: 'doc-1' };
function harness() {
  let saved: any = null;
  let failWrites = false;
  const port = {
    read: async () => structuredClone(saved),
    write: async (value: any) => { if (failWrites) throw new Error('QUOTA_BYTES quota exceeded'); saved = structuredClone(value); },
    target: async () => ({ tabId: 7, windowId: 2, url: 'https://example.com/work', title: 'Work' }),
    inject: async () => 'doc-1',
    current: async () => ({ active: true, documentId: 'doc-1' }),
    capture: async () => 'data:image/jpeg;base64,YQ==',
    now: () => 1000,
  };
  return { port, saved: () => saved, failWrites: (value: boolean) => { failWrites = value; } };
}
async function recorderWithSteps(count = 2) {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  for (let i = 0; i < count; i++) await recorder.click({ ...click, label: `Click Step ${i + 1}` }, sender);
  const ids = (await recorder.status()).recording!.steps.map(step => step.id!);
  return { h, recorder, ids };
}
const entries = async (recorder: Recorder) => (await recorder.status()).recording!.steps;

test('guide title and description are edited, trimmed and reset to the captured title when empty', async () => {
  const { h, recorder } = await recorderWithSteps(0);
  await recorder.edit({ type: 'EDIT_GUIDE', title: '  Create an invoice\n', description: 'For the finance team.\nSecond line.' });
  let r = (await recorder.status()).recording!;
  assert.equal(r.guideTitle, 'Create an invoice');
  assert.equal(r.description, 'For the finance team.\nSecond line.');
  assert.equal(r.title, 'Work', 'captured page title is kept');
  assert.equal(h.saved().recording.guideTitle, 'Create an invoice');
  await recorder.edit({ type: 'EDIT_GUIDE', title: '   ', description: '' });
  r = (await recorder.status()).recording!;
  assert.equal(r.guideTitle, undefined);
  assert.equal(r.description, undefined);
});

test('step instruction and note are edited; empty or unchanged text resets to the recorded label', async () => {
  const { recorder, ids } = await recorderWithSteps(1);
  await recorder.edit({ type: 'EDIT_STEP', stepId: ids[0], text: 'Save your changes', note: 'The button is top right.' });
  let step = (await entries(recorder))[0] as Step;
  assert.equal(step.text, 'Save your changes');
  assert.equal(step.label, 'Click Step 1', 'recorded label is kept for reset');
  assert.equal(step.note, 'The button is top right.');
  await recorder.edit({ type: 'EDIT_STEP', stepId: ids[0], text: 'Click Step 1' });
  step = (await entries(recorder))[0] as Step;
  assert.equal(step.text, undefined);
  assert.equal(step.note, 'The button is top right.', 'omitted fields are unchanged');
  await recorder.edit({ type: 'EDIT_STEP', stepId: ids[0], text: 'Again', note: '  ' });
  await recorder.edit({ type: 'EDIT_STEP', stepId: ids[0], text: '' });
  step = (await entries(recorder))[0] as Step;
  assert.equal(step.text, undefined);
  assert.equal(step.note, undefined);
});

test('blocks are inserted, edited, moved and deleted, and are not steps', async () => {
  const { recorder, ids } = await recorderWithSteps(2);
  await recorder.edit({ type: 'INSERT_BLOCK', kind: 'header', text: 'Sign in', index: 0 });
  await recorder.edit({ type: 'INSERT_BLOCK', kind: 'tip', text: '', index: 3 });
  let list = await entries(recorder);
  assert.deepEqual(list.map(entry => entry.kind ?? 'click'), ['header', 'click', 'click', 'tip']);
  const header = list[0] as Block;
  assert.ok(header.id && !isStep(header));
  assert.ok(isStep(list[1]));
  await recorder.edit({ type: 'EDIT_STEP', stepId: list[3].id!, text: 'Use a test account.' });
  assert.equal((await entries(recorder))[3].text, 'Use a test account.');
  await recorder.edit({ type: 'MOVE_STEP', stepId: ids[1], index: 0 });
  list = await entries(recorder);
  assert.deepEqual(list.map(entry => entry.id), [ids[1], header.id, ids[0], list[3].id]);
  await recorder.edit({ type: 'MOVE_STEP', stepId: header.id, index: 3 });
  assert.equal((await entries(recorder))[3].id, header.id);
  await recorder.deleteStep(header.id);
  assert.equal((await entries(recorder)).length, 3);
});

test('edit commands reject unknown ids and invalid shapes without changing anything', async () => {
  const { h, recorder, ids } = await recorderWithSteps(1);
  const before = JSON.stringify(h.saved());
  for (const command of [
    null, { type: 'NOPE' },
    { type: 'EDIT_GUIDE', title: 'x'.repeat(201) }, { type: 'EDIT_GUIDE', description: 'x'.repeat(5001) }, { type: 'EDIT_GUIDE', title: 5 },
    { type: 'EDIT_STEP', stepId: 'missing', text: 'x' }, { type: 'EDIT_STEP', stepId: ids[0], text: 'x'.repeat(2001) }, { type: 'EDIT_STEP', stepId: ids[0], note: 'x'.repeat(5001) },
    { type: 'MOVE_STEP', stepId: ids[0], index: 5 }, { type: 'MOVE_STEP', stepId: ids[0], index: 0.5 }, { type: 'MOVE_STEP', stepId: ids[0], index: -1 },
    { type: 'INSERT_BLOCK', kind: 'script', text: 'x', index: 0 }, { type: 'INSERT_BLOCK', kind: 'tip', text: 'x', index: 9 }, { type: 'INSERT_BLOCK', kind: 'tip', text: 'x'.repeat(2001), index: 0 },
    { type: 'EDIT_SHOT', stepId: ids[0], screenshot: 'data:text/html;base64,PGI+', x: 1, y: 1, width: 10, height: 10 },
    { type: 'EDIT_SHOT', stepId: ids[0], screenshot: 'data:image/jpeg;base64,YQ==', x: 11, y: 1, width: 10, height: 10 },
    { type: 'EDIT_SHOT', stepId: ids[0], screenshot: 'data:image/jpeg;base64,' + 'A'.repeat(6_000_001), x: 1, y: 1, width: 10, height: 10 },
  ]) await assert.rejects(() => recorder.edit(command), /Invalid|Unknown|not found/i, JSON.stringify(command)?.slice(0, 80));
  assert.equal(JSON.stringify(h.saved()), before);
});

test('an edited screenshot replaces the image and marker geometry, and can hide the marker', async () => {
  const { recorder, ids } = await recorderWithSteps(1);
  await recorder.edit({ type: 'EDIT_SHOT', stepId: ids[0], screenshot: 'data:image/jpeg;base64,QkxVUg==', x: 20, y: 10, width: 400, height: 300, hideMarker: true });
  const step = (await entries(recorder))[0] as Step;
  assert.equal(step.screenshot, 'data:image/jpeg;base64,QkxVUg==');
  assert.deepEqual([step.x, step.y, step.width, step.height, step.hideMarker], [20, 10, 400, 300, true]);
  await recorder.edit({ type: 'EDIT_SHOT', stepId: ids[0], screenshot: 'data:image/jpeg;base64,QkxVUg==', x: 20, y: 10, width: 400, height: 300, hideMarker: false });
  assert.equal(((await entries(recorder))[0] as Step).hideMarker, undefined);
});

test('a failed save reverts the edit, reports it, and leaves a live capture recording', async () => {
  const { h, recorder, ids } = await recorderWithSteps(1);
  h.failWrites(true);
  await assert.rejects(() => recorder.edit({ type: 'EDIT_STEP', stepId: ids[0], text: 'Lost edit' }), /Edit not saved.*QUOTA/);
  await assert.rejects(() => recorder.edit({ type: 'INSERT_BLOCK', kind: 'tip', text: 'Lost', index: 0 }), /Edit not saved/);
  await assert.rejects(() => recorder.edit({ type: 'MOVE_STEP', stepId: ids[0], index: 0 }), /Edit not saved/);
  const r = (await recorder.status()).recording!;
  assert.equal(r.status, 'recording');
  assert.equal(r.steps.length, 1);
  assert.equal((r.steps[0] as Step).text, undefined);
  h.failWrites(false);
  await recorder.click(click, sender);
  assert.equal((await entries(recorder)).length, 2, 'capture continues after a failed edit');
});

test('live text-entry updates keep an edited instruction and note', async () => {
  const h = harness(); const recorder = new Recorder(h.port); await recorder.start();
  const captureId = (await recorder.status()).recording!.captureId;
  const input = { ...click, kind: 'type', sequence: 1, final: false, actionId: 'entry-1', label: 'Type "draf"', captureId };
  await recorder.input(input, sender);
  await recorder.edit({ type: 'EDIT_STEP', stepId: 'entry-1', text: 'Enter the customer name', note: 'Use the legal name.' });
  await recorder.input({ ...input, sequence: 2, label: 'Type "draft"' }, sender);
  const step = (await entries(recorder))[0] as Step;
  assert.equal(step.label, 'Type "draft"');
  assert.equal(step.text, 'Enter the customer name');
  assert.equal(step.note, 'Use the legal name.');
});

test('edits from the viewer and side panel reach the recorder; other sources are rejected', async () => {
  const id = 'test-extension';
  const base = `chrome-extension://${id}/`;
  const edits: unknown[] = []; const deleted: string[] = [];
  const recorder = {
    start: async () => {}, stop: async () => {}, delete: async () => {}, click: async () => {},
    status: async () => ({ recording: null }),
    edit: async (command: unknown) => { edits.push(command); },
    deleteStep: async (stepId: string) => { deleted.push(stepId); },
  };
  for (const page of ['viewer.html', 'sidepanel.html']) {
    const sender = { id, url: base + page, frameId: 0 };
    for (const type of ['EDIT_GUIDE', 'EDIT_STEP', 'MOVE_STEP', 'INSERT_BLOCK', 'EDIT_SHOT']) await messages.route({ type, stepId: 'a' }, sender, id, recorder);
    await messages.route({ type: 'DELETE_STEP', stepId: 'block-1' }, sender, id, recorder);
  }
  assert.equal(edits.length, 10);
  assert.deepEqual(deleted, ['block-1', 'block-1']);
  await assert.rejects(() => messages.route({ type: 'EDIT_STEP' }, { id, url: base + 'popup.html', frameId: 0 }, id, recorder), /Unknown command/);
  await assert.rejects(() => messages.route({ type: 'EDIT_STEP' }, { id, url: 'https://example.com/', tab: { id: 1 }, frameId: 0, documentId: 'd' }, id, recorder), /Untrusted/);
});

test('the PDF print page may only read the guide', async () => {
  const id = 'test-extension';
  const calls: string[] = [];
  const recorder = {
    start: async () => {}, stop: async () => { calls.push('stop'); }, delete: async () => { calls.push('delete'); }, click: async () => {},
    status: async () => ({ recording: null }), edit: async () => { calls.push('edit'); },
  };
  const sender = { id, url: `chrome-extension://${id}/print.html`, frameId: 0 };
  assert.deepEqual(await messages.route({ type: 'STATUS' }, sender, id, recorder), { recording: null });
  for (const type of ['STOP', 'DELETE', 'EDIT_STEP', 'START', 'DELETE_STEP']) await assert.rejects(() => messages.route({ type }, sender, id, recorder), /read-only|Unknown/);
  assert.deepEqual(calls, []);
});

test('the click marker style is a guide setting: circle or box', async () => {
  const { recorder } = await recorderWithSteps(1);
  await recorder.edit({ type: 'EDIT_GUIDE', markerStyle: 'box' });
  assert.equal((await recorder.status()).recording!.markerStyle, 'box');
  await recorder.edit({ type: 'EDIT_GUIDE', markerStyle: 'circle' });
  assert.equal((await recorder.status()).recording!.markerStyle, undefined, 'circle is the default');
  await assert.rejects(() => recorder.edit({ type: 'EDIT_GUIDE', markerStyle: 'star' }), /Invalid/);
});
