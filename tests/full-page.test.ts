import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { planSlices, placements, maxPageHeight, type PageMeasure } from '../src/fullpage.ts';
import { Recorder, type Port, type State, type Step } from '../src/recorder.ts';
import * as messages from '../src/messages.ts';
import { mountSidePanel } from '../src/sidepanel-ui.ts';
import { mountCaptureBar } from '../src/capture-bar.ts';
import { mountGuide } from '../src/guide-overlay.ts';

const windowPage: PageMeasure = { mode: 'window', rect: { x: 0, y: 0, width: 1000, height: 700 }, scrollTop: 300, scrollHeight: 2000, clientHeight: 700, innerWidth: 1000, innerHeight: 700, background: '#ffffff' };
// An app that scrolls a main panel (below a 60 px header, right of a 200 px menu, above a 40 px footer).
const appPage: PageMeasure = { mode: 'element', rect: { x: 200, y: 60, width: 800, height: 600 }, scrollTop: 0, scrollHeight: 1500, clientHeight: 600, innerWidth: 1000, innerHeight: 700, background: '#101419' };

test('slices cover the whole scroll height, the last one aligned to the end', () => {
  assert.deepEqual(planSlices(windowPage), { positions: [0, 700, 1300], extra: 1300, truncated: false });
  assert.deepEqual(planSlices({ ...windowPage, scrollHeight: 700 }), { positions: [0], extra: 0, truncated: false });
  const huge = planSlices({ ...windowPage, scrollHeight: 50000 });
  assert.equal(huge.truncated, true);
  assert.equal(windowPage.innerHeight + huge.extra, maxPageHeight);
  assert.equal(huge.positions.at(-1), huge.extra);
});

test('an app panel is extended in place: menu and header once, footer moved below', () => {
  const plan = planSlices(appPage);
  assert.deepEqual(plan, { positions: [0, 600, 900], extra: 900, truncated: false });
  const ops = placements(appPage, plan, [0, 600, 900]);
  // First slice down to the panel's bottom (not the footer), then each slice's
  // panel area at its scroll offset, then the footer.
  assert.deepEqual(ops[0], { slice: 0, sx: 0, sy: 0, sw: 1000, sh: 660, dx: 0, dy: 0 });
  assert.deepEqual(placements(windowPage, planSlices({ ...windowPage, scrollHeight: 700 }), [0]), [{ slice: 0, sx: 0, sy: 0, sw: 1000, sh: 700, dx: 0, dy: 0 }]);
  assert.deepEqual(ops.slice(1, 3), [
    { slice: 1, sx: 200, sy: 60, sw: 800, sh: 600, dx: 200, dy: 660 },
    { slice: 2, sx: 200, sy: 60, sw: 800, sh: 600, dx: 200, dy: 960 },
  ]);
  assert.deepEqual(ops.at(-1), { slice: 0, sx: 0, sy: 660, sw: 1000, sh: 40, dx: 0, dy: 1560 });
});

function port(fullPage?: Port['fullPage']) {
  let saved: State | null = null;
  return {
    read: async () => structuredClone(saved), write: async (s: State) => { saved = structuredClone(s); },
    target: async () => ({ tabId: 1, windowId: 1, url: 'https://app.example.com/orders', title: 'Orders' }),
    inject: async () => 'doc', current: async () => ({ active: true, documentId: 'doc' }),
    capture: async () => 'data:image/jpeg;base64,YQ==', now: () => 1000, fullPage,
  } as Port;
}

test('Full page adds a step with the tall screenshot, blurred when automatic blur is on', async () => {
  const asked: unknown[] = [];
  const recorder = new Recorder(port(async (_r, options) => { asked.push(options); return { screenshot: 'data:image/jpeg;base64,VEFMTA==', width: 1000, height: 2000, truncated: false }; }));
  await recorder.start(1, 1);
  await recorder.fullPage();
  const step = (await recorder.status()).recording!.steps[0] as Step;
  assert.deepEqual([step.kind, step.label, step.width, step.height, step.hideMarker], ['full', 'Full page: Orders', 1000, 2000, true]);
  assert.equal(step.screenshot, 'data:image/jpeg;base64,VEFMTA==');
  assert.deepEqual(asked, [{ blur: true }]);
});

test('Full page says when the page was cut off, works while paused, and never runs without a capture', async () => {
  const recorder = new Recorder(port(async () => ({ screenshot: 'data:image/jpeg;base64,VEFMTA==', width: 1000, height: 12000, truncated: true })));
  await assert.rejects(() => recorder.fullPage(), /Start a capture/);
  await recorder.start(1, 1); await recorder.pause();
  await recorder.fullPage();
  assert.equal(((await recorder.status()).recording!.steps[0] as Step).label, 'Full page: Orders (top 12,000 px)');
  await recorder.stop();
  await assert.rejects(() => recorder.fullPage(), /Start a capture/);
});

test('a failed or invalid full-page capture adds nothing and reports why', async () => {
  for (const fullPage of [async () => { throw new Error('Automatic blur could not check this page.'); }, async () => ({ screenshot: 'data:text/html;base64,PGI+', width: 1, height: 1, truncated: false })]) {
    const recorder = new Recorder(port(fullPage as Port['fullPage']));
    await recorder.start(1, 1);
    await assert.rejects(() => recorder.fullPage(), /blur could not|Invalid/);
    assert.equal((await recorder.status()).recording!.steps.length, 0);
    assert.equal((await recorder.status()).recording!.status, 'recording');
  }
});

test('the panel and the captured page can ask for a full page', async () => {
  const id = 'ext'; const calls: string[] = [];
  const recorder = {
    start: async () => {}, stop: async () => {}, delete: async () => {}, click: async () => {},
    fullPage: async () => { calls.push('full'); },
    status: async () => ({ recording: { status: 'recording', tabId: 7, documentId: 'doc-1', steps: [] } } as any),
  };
  await messages.route({ type: 'FULL_PAGE' }, { id, url: `chrome-extension://${id}/sidepanel.html`, frameId: 0 }, id, recorder);
  await messages.route({ type: 'CAPTURE_FULL' }, { id, url: 'https://example.com/', tab: { id: 7 }, frameId: 0, documentId: 'doc-1' }, id, recorder);
  await messages.route({ type: 'CAPTURE_FULL' }, { id, url: 'https://example.com/', tab: { id: 7 }, frameId: 0, documentId: 'other' }, id, recorder);
  assert.deepEqual(calls, ['full', 'full']);
});

test('the side panel and the on-page bar offer Full page while capturing', async () => {
  const dom = new JSDOM('<main id="app"></main>');
  const root = dom.window.document.querySelector<HTMLElement>('#app')!;
  const sent: string[] = [];
  const state = { recording: { id: 'g', tabId: 1, windowId: 1, documentId: 'd', title: 'T', url: 'https://a.example.com/', status: 'recording', startedAt: 1, steps: [] } } as State;
  await mountSidePanel(root, async type => { sent.push(type); return structuredClone(state); }, () => () => {}, () => {}, () => true, () => {});
  const button = root.querySelector<HTMLButtonElement>('#full-page')!;
  assert.equal(button.hidden, false);
  assert.match(button.textContent!, /Full page/);
  button.click(); await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(sent, ['STATUS', 'FULL_PAGE']);
  const page = new JSDOM('<body></body>', { url: 'https://a.example.com/' });
  const calls: string[] = [];
  const bar = mountCaptureBar(page.window as unknown as Window, { pause: () => {}, complete: () => {}, fullPage: () => { calls.push('full'); } }, { trusted: () => true });
  bar.root.querySelector<HTMLButtonElement>('.full')!.click();
  assert.deepEqual(calls, ['full']);
  dom.window.close(); page.window.close();
});

test('Guide me shows a full-page step as a reference', async () => {
  const dom = new JSDOM('<body></body>', { url: 'https://a.example.com/orders', pretendToBeVisual: true });
  const view = { guideId: 'g', title: 'G', index: 0, total: 1, step: { id: 'f', kind: 'full' as const, segments: [{ text: 'Full page: Orders', bold: false }], tips: [], url: 'https://a.example.com/orders', title: 'Orders', screenshot: 'data:image/jpeg;base64,YQ==', position: { x: 0, y: 0, width: 1000, height: 2000 } } };
  const g = mountGuide(dom.window as unknown as Window, { state: async () => view, next: async () => null, back: async () => view, exit: async () => {} }, { trusted: () => true, findTimeout: 5 });
  await g.ready; await new Promise(r => setTimeout(r, 20));
  assert.equal(g.root.querySelector<HTMLElement>('.approx')!.hidden, true);
  assert.match(g.root.querySelector('.fallback-text')!.textContent!, /whole page/i);
  dom.window.close();
});
