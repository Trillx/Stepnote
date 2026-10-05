import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const dist = resolve('dist');
assert.ok(existsSync(resolve(dist, 'manifest.json')), 'Build must produce a loadable extension manifest');
const artifacts = resolve('.test-artifacts');
await mkdir(artifacts, { recursive: true });
await rm(resolve(artifacts, 'smoke-result.json'), { force: true });
await rm(resolve(artifacts, 'recorded-procedure.html'), { force: true });
assert.deepEqual(JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8')), JSON.parse(await readFile('public/manifest.json', 'utf8')), 'Smoke loads the exact production manifest');
const profile = await mkdtemp(resolve(artifacts, 'profile-'));
// The sample page's own site icon, to check Stepnote keeps it with the guide.
const siteIcon = await readFile('public/icons/icon-32.png');
const server = createServer((req, res) => {
  if (req.url === '/favicon.png') { res.setHeader('Content-Type', 'image/png'); res.end(siteIcon); return; }
  res.setHeader('Content-Type', 'text/html');
  // Cross-origin frame content: served to the page from localhost, not 127.0.0.1.
  if (req.url === '/frame') { res.end('<!doctype html><p>Frame contact: frame@example.com</p>'); return; }
  res.end(`<!doctype html><title>SOP smoke fixture</title><link rel="icon" href="/favicon.png"><style>label{display:block;margin:8px}#editable{min-height:30px;border:1px solid #ccc}#excluded input{color:transparent;caret-color:transparent}</style><h1>Test procedure</h1><p id="contact">Support: jane.doe@example.com</p><button id="save">Save item</button><button id="next">Next step</button><input aria-label="Private field" value="do-not-collect"><label>Search <input id="query" type="search"></label><label>Notes <textarea id="notes"></textarea></label><div id="editable" contenteditable="true" aria-label="Description"></div><section id="excluded"><input id="password" type="password" aria-label="Protected"><input id="otp" autocomplete="one-time-code" aria-label="Protected"><input id="cardNumber" aria-label="Protected"></section><a href="/second">Navigate</a><div id="shadow-host"></div><script>document.getElementById('shadow-host').attachShadow({ mode: 'closed' }).innerHTML = '<p>Owner: owner@example.com</p>';</script><iframe id="same-frame" style="display:block;height:50px;border:1px solid #ccc" srcdoc="<p>Billing: billing@example.com</p>"></iframe><iframe id="other-frame" style="display:block;height:50px;border:1px solid #ccc" src="http://localhost:${server.address().port}/frame"></iframe><iframe id="scaled-frame" style="display:block;transform:scale(2);transform-origin:0 0;width:220px;height:30px;border:0;margin-bottom:34px" srcdoc="<input type='email' value='scaled@example.com' style='width:180px'>"></iframe><iframe id="rotated-frame" style="display:block;transform:rotate(4deg);width:260px;height:36px;border:1px solid #ccc;margin:10px" srcdoc="<p style='margin:4px'>Rotated: tilt@example.com</p>"></iframe><iframe id="turned-frame" style="display:block;rotate:90deg;width:200px;height:30px;border:0;margin:90px 0 90px 40px" srcdoc="<input type='email' value='turned@example.com'>"></iframe><iframe id="mirrored-frame" style="display:block;transform:scaleX(-1);width:220px;height:30px;border:0;margin-left:300px" srcdoc="<input type='email' value='mirror@example.com'>"></iframe>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false,
    // Real window size, not an emulated viewport: screenshots capture the real
    // window, so blur boxes and click markers must be measured against it.
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-extension-debugging', '--window-size=1100,860'],
    viewport: null, acceptDownloads: true,
  });
  context.setDefaultTimeout(12000);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 12000 });
  const id = new URL(worker.url()).host;
  worker.on('console', message => console.log('Worker:', message.text()));
  console.log('Worker ready', await worker.evaluate(async () => ({ listener: chrome.action.onClicked.hasListeners(), panel: await chrome.sidePanel.getOptions({}) })));
  assert.equal(await worker.evaluate(() => chrome.action.onClicked.hasListeners()), true);
  const page = context.pages()[0];
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const browser = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browser.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const target = targetInfos.find(t => t.url === page.url());
  assert.ok(target, 'Recorded page must have a tab target');
  await browser.send('Extensions.triggerAction', { id, targetId: target.targetId });
  console.log('Triggered real extension action', id);
  async function waitFor(get, predicate) {
    const deadline = Date.now() + 12000;
    let last;
    while (Date.now() < deadline) {
      const value = last = await get();
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for browser state: ' + JSON.stringify(last));
  }
  const panelTargets = await waitFor(async () => {
    const { targetInfos } = await browser.send('Target.getTargets', { filter: [{}] });
    return { target: targetInfos.find(t => t.type !== 'tab' && t.url === `chrome-extension://${id}/sidepanel.html`), all: targetInfos.map(t => ({ type: t.type, url: t.url })) };
  }, value => !!value.target);
  const panelTarget = panelTargets.target;
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: panelTarget.targetId, flatten: false });
  let commandId = 0;
  function panelCommand(method, params = {}) {
    const number = ++commandId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.off('Target.receivedMessageFromTarget', listener);
        reject(new Error(`Side panel CDP command timed out: ${method}`));
      }, 12000);
      const listener = event => {
        if (event.sessionId !== sessionId) return;
        const response = JSON.parse(event.message);
        if (response.id !== number) return;
        clearTimeout(timer);
        browser.off('Target.receivedMessageFromTarget', listener);
        response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result);
      };
      browser.on('Target.receivedMessageFromTarget', listener);
      browser.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: number, method, params }) }).catch(error => {
        clearTimeout(timer);
        browser.off('Target.receivedMessageFromTarget', listener);
        reject(error);
      });
    });
  }
  const panelEval = async expression => {
    const response = await panelCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  };
  async function panelClick(selector) {
    // Settle a dialog's entrance animation first, or the measured point is stale.
    const point = await panelEval(`(async () => { const element = document.querySelector(${JSON.stringify(selector)}); await Promise.all((element.closest('dialog')?.getAnimations() ?? []).map(a => a.finished)); element.scrollIntoView({block:'center',behavior:'instant'}); const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await panelCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await panelCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  await panelCommand('Page.enable');
  await waitFor(() => panelEval('!!document.querySelector("#start") && !document.querySelector("#start").disabled'), Boolean);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), 'Stepnote');
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().action.default_title), 'Open Stepnote');
  const bundledFont = await panelEval('(async () => { await document.fonts.ready; return { checked:document.fonts.check(\'800 24px "Nunito"\'), loaded:Array.from(document.fonts).some(face=>face.family.includes("Nunito")&&face.status==="loaded"), family:getComputedStyle(document.querySelector(".eyebrow")).fontFamily, origin:location.origin }; })()');
  assert.equal(bundledFont.checked, true); assert.equal(bundledFont.loaded, true); assert.match(bundledFont.family, /Nunito/);
  assert.equal(bundledFont.origin, `chrome-extension://${id}`);
  assert.equal(await panelEval('document.querySelector("#refresh") === null'), true);
  assert.equal(await panelEval('document.querySelector("#steps").clientHeight > 0'), true);
  const savePanelShot = async name => {
    const shot = await panelCommand('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(artifacts, name), Buffer.from(shot.data, 'base64'));
  };
  await savePanelShot('sidepanel-home.png');
  const sheetOpen = () => panelEval('!!document.querySelector("dialog.sheet[open]")');
  const sheetSettled = () => panelEval('Promise.all(document.querySelector("dialog.sheet").getAnimations().map(a => a.finished)).then(() => true)');
  async function startThisTabOnly() {
    await panelClick('#start');
    await waitFor(sheetOpen, Boolean);
    assert.match(await panelEval('document.querySelector("dialog.sheet").textContent'), /Read and change all your data on all websites/);
    await sheetSettled();
    await savePanelShot('sidepanel-access.png');
    await panelClick('dialog.sheet [data-action="tab"]');
    await waitFor(sheetOpen, open => !open);
  }
  const panelStatus = () => panelEval('({status: document.querySelector("#status").textContent, error: document.querySelector("#error").textContent, cards: document.querySelectorAll(".step-card").length})');
  async function statusStartsWith(status) {
    return waitFor(panelStatus, value => {
      if (value.error) throw new Error(`Panel failed: ${JSON.stringify(value)}`);
      return value.status.startsWith(status);
    });
  }
  await startThisTabOnly();
  await statusStartsWith('Recording');
  // The guide keeps the page's site icon, from Chrome's cache.
  const withIcon = await waitFor(() => worker.evaluate(async () => (await chrome.storage.local.get('sop')).sop), s => /^data:image\/png;base64,/.test(s?.recording?.favicon ?? ''));
  assert.ok(withIcon.recording.favicon.length > 100, 'a real icon image');
  // On-page capture controls (the default setting) appear on the captured page.
  await page.locator('[data-stepnote-ui]').waitFor({ state: 'attached' });
  await page.bringToFront();
  await page.screenshot({ path: resolve(artifacts, 'capture-bar.png') });
  await page.locator('#save').click();
  const saved = () => worker.evaluate(async () => (await chrome.storage.local.get('sop')).sop);
  const until = predicate => waitFor(saved, predicate);
  let state = await until(s => s?.recording?.steps.length === 1);
  assert.match(state.recording.steps[0].screenshot, /^data:image\/jpeg;base64,/);
  assert.equal(state.recording.steps[0].label, 'Click Save item');
  await waitFor(panelStatus, s => s.cards === 1);
  await page.waitForTimeout(700);
  await page.locator('#next').click();
  await waitFor(panelStatus, s => s.cards === 2);
  await panelClick('#pause');
  await statusStartsWith('Paused');
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), 'PAUSE');
  await page.locator('#save').click();
  await page.waitForTimeout(750);
  assert.equal((await saved()).recording.steps.length, 2, 'Paused clicks must be suppressed');
  await panelClick('#pause');
  await statusStartsWith('Recording');
  await page.locator('#next').click();
  await waitFor(panelStatus, s => s.cards === 3);
  await panelClick('.thumbnail');
  await statusStartsWith('Paused');
  assert.equal(await panelEval('document.querySelector("#preview").open'), true);
  await savePanelShot('sidepanel-preview.png');
  await page.locator('#save').click();
  await page.waitForTimeout(750);
  assert.equal((await saved()).recording.steps.length, 3);
  await panelClick('#close-preview');
  assert.equal((await saved()).recording.status, 'paused', 'Closing preview must not resume');
  await panelClick('#pause');
  await statusStartsWith('Recording');
  await page.locator('#save').click();
  await waitFor(panelStatus, s => s.cards === 4);
  state = await saved();
  assert.equal(state.recording.steps.length, 4);
  assert.ok(state.recording.steps.every(step => /^data:image\/jpeg;base64,/.test(step.screenshot)), 'Every captured click has a real image');
  await waitFor(() => panelEval('Array.from(document.querySelectorAll("#cards img"), img => img.naturalWidth).every(width => width > 0)'), Boolean);
  const firstId = state.recording.steps[0].id;
  await savePanelShot('sidepanel-live.png');
  await panelClick('.delete-step');
  await waitFor(panelStatus, s => s.cards === 3);
  state = await saved();
  assert.equal(state.recording.steps.some(step => step.id === firstId), false);
  assert.deepEqual(await panelEval('Array.from(document.querySelectorAll(".step-number"), el => el.textContent)'), ['1', '2', '3']);
  // Review suspends following. Resume only after returning to bottom and leaving.
  await page.waitForTimeout(700); // Separate real screenshot calls, not a flush acknowledgement.
  const listPoint = await panelEval('(() => { const r = document.querySelector("#steps").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+40}; })()');
  await panelCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...listPoint });
  await panelEval('document.querySelector("#steps").scrollTop = 0; true');
  await waitFor(() => panelEval('document.querySelector("#steps").scrollTop'), top => top === 0);
  const pageScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await page.locator('#query').click();
  await waitFor(panelStatus, s => s.cards === 4);
  assert.match((await saved()).recording.steps.at(-1).screenshot, /^data:image\/jpeg;base64,/);
  await waitFor(() => panelEval('Array.from(document.querySelectorAll("#cards img"), img => img.complete && img.naturalWidth > 0).every(Boolean)'), Boolean);
  assert.equal(await panelEval('document.querySelector("#steps").scrollTop'), 0, 'New steps and image loads must not fight upward review');
  await panelEval('document.querySelector("#steps").scrollTop = document.querySelector("#steps").scrollHeight; true');
  await panelCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  const latestLayout = () => panelEval(`(() => { const list = document.querySelector('#steps').getBoundingClientRect(); const card = document.querySelector('.step-card:last-child').getBoundingClientRect(); const heading = document.querySelector('.step-card:last-child h2').getBoundingClientRect(); const footer = document.querySelector('.panel-controls').getBoundingClientRect(); return {top:card.top,bottom:card.bottom,headingTop:heading.top,listTop:list.top,listBottom:list.bottom,footerTop:footer.top,scroll:document.querySelector('#steps').scrollTop}; })()`);
  const followedLayout = await waitFor(latestLayout, r => r.scroll > 0 && r.headingTop >= r.listTop && r.bottom <= r.listBottom + 1);
  assert.ok(followedLayout.bottom <= followedLayout.footerTop + 1, 'Followed newest card must not be clipped by controls');
  assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), pageScroll, 'Panel scrolling must not scroll the recorded page');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'query', 'New cards must not steal page typing focus');
  const firstInputAt = Date.now();
  await page.keyboard.type('H');
  await waitFor(() => panelEval('document.querySelector(".step-card:last-child h2").textContent'), label => label === 'Type "H"');
  const firstLiveCardMs = Date.now() - firstInputAt;
  assert.ok(firstLiveCardMs < 400, `Live entry must appear before the old idle boundary, observed ${firstLiveCardMs}ms`);
  let liveEntry = (await until(s => s.recording.steps.at(-1)?.label === 'Type "H"')).recording.steps.at(-1);
  const liveEntryId = liveEntry.id;
  assert.equal(liveEntry.final, false);
  assert.equal(liveEntry.screenshot, undefined, 'No early typing screenshot');
  const liveCount = (await saved()).recording.steps.length;
  await page.keyboard.type('ello everyone', { delay: 15 });
  await until(s => s.recording.steps.some(step => step.label === 'Type "Hello everyone"'));
  await waitFor(() => panelEval('Array.from(document.querySelectorAll(".step-card h2"), el => el.textContent).includes(\'Type "Hello everyone"\')'), Boolean);
  await savePanelShot('sidepanel-text-entry.png');
  await waitFor(latestLayout, r => r.headingTop >= r.listTop && r.headingTop < r.listBottom);
  await page.waitForTimeout(450);
  assert.equal((await saved()).recording.steps.length, liveCount, 'Idle never splits the focused entry');
  // Clipboard grants apply only to this isolated localhost fixture.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await page.evaluate(() => navigator.clipboard.writeText('Hello everyone corrected'));
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('ControlOrMeta+V');
  await until(s => s.recording.steps.at(-1)?.label === 'Type "Hello everyone corrected"');
  await waitFor(() => panelEval('document.querySelector(".step-card:last-child h2").textContent'), label => label === 'Type "Hello everyone corrected"');
  liveEntry = (await saved()).recording.steps.at(-1);
  assert.equal(liveEntry.id, liveEntryId); assert.equal((await saved()).recording.steps.length, liveCount);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'query');
  await page.keyboard.press('Enter');
  state = await until(s => s.recording.steps.at(-1)?.final && s.recording.steps.at(-1)?.screenshot);
  assert.equal(state.recording.steps.at(-1).id, liveEntryId);
  await waitFor(() => panelEval('document.querySelector(".step-card:last-child img")?.getAttribute("src")'), src => src === state.recording.steps.at(-1).screenshot);
  await savePanelShot('sidepanel-text-final.png');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('before pause');
  await panelClick('#pause');
  await statusStartsWith('Paused');
  // The panel can show Paused before Pause's text drain is written; wait for
  // storage. A lost entry still fails here, by timing out.
  state = await until(s => s?.recording?.status === 'paused' && s.recording.steps.at(-1)?.label === 'Type "before pause"');
  assert.equal(state.recording.steps.at(-1).label, 'Type "before pause"', 'Immediate Pause must retain final typing');
  const pausedCount = state.recording.steps.length;
  await page.locator('#query').click();
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('paused entry');
  await page.waitForTimeout(500);
  assert.equal((await saved()).recording.steps.length, pausedCount);
  await panelClick('#pause'); await statusStartsWith('Recording');
  // Clipboard permission is only a test-context grant on the localhost fixture.
  // It is not added to the extension manifest.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await page.evaluate(() => navigator.clipboard.writeText('pasted ordinary text'));
  await page.locator('#notes').click(); await page.keyboard.press('ControlOrMeta+V');
  await page.locator('#editable').click(); await page.keyboard.type('editable description');
  await page.locator('#query').click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter');
  await until(s => s.recording.steps.at(-1)?.label === 'Clear the "Search" field');
  const beforeExcluded = (await saved()).recording.steps.filter(step => step.kind === 'type').length;
  for (const selector of ['#password', '#otp', '#cardNumber']) {
    await page.locator(selector).click(); await page.keyboard.type('fixture-excluded-value');
    await page.keyboard.press('Tab');
  }
  await page.waitForTimeout(500);
  state = await saved();
  assert.equal(state.recording.steps.filter(step => step.kind === 'type').length, beforeExcluded, 'Known secrets never create text entries');
  assert.ok(!JSON.stringify(state).includes('fixture-excluded-value'));
  const beforeSynthetic = state.recording.steps.length;
  await page.evaluate(() => { const q = document.querySelector('#query'); q.value = 'synthetic entry'; q.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  await page.waitForTimeout(500); assert.equal((await saved()).recording.steps.length, beforeSynthetic);
  await page.locator('#query').click(); await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('final ordinary text');
  await panelClick('#complete');
  await statusStartsWith('Complete');
  // The panel can show a published state before its write lands, and status
  // turns stopped before the final drain and tidy-up finish: wait for them.
  await until(s => s?.recording?.status === 'stopped' && s.recording.tidied === 5);
  state = await saved();
  const labels = state.recording.steps.map(step => step.label);
  for (const label of ['Type "Hello everyone corrected"', 'Type "before pause"', 'Type "pasted ordinary text"', 'Type "editable description"', 'Clear the "Search" field', 'Type "final ordinary text"']) assert.ok(labels.includes(label), `Missing ordinary step: ${label}`);
  assert.equal(labels.at(-1), 'Type "final ordinary text"', 'Complete must acknowledge final typing');
  // "Tidy up steps" (on by default) merged each field click into the typing that followed it.
  assert.deepEqual(labels, ['Click Next step', 'Click Next step', 'Click Save item', 'Type "Hello everyone corrected"', 'Type "before pause"', 'Type "pasted ordinary text"', 'Type "editable description"', 'Clear the "Search" field', 'Click protected field', 'Click protected field', 'Click protected field', 'Type "final ordinary text"'], 'Persisted order keeps only final/latest text per editing session, tidied');
  assert.equal(state.recording.tidied, 5, 'five field clicks merged into their typing');
  assert.equal(state.recording.steps.at(-1).text, 'Type **"final ordinary text"** in the **Search** field');
  assert.ok(state.recording.steps.filter(step => step.kind === 'type').every(step => step.final));
  assert.ok(state.recording.steps.every(step => step.screenshot || step.reason));
  // Automatic blur: the fixture always shows three credential fields, an email,
  // an email in a closed shadow root, a same-origin frame, a cross-origin frame,
  // an email field in a 2x scaled frame, and frames that are rotated (by
  // transform and by the rotate property) or mirrored.
  const shots = state.recording.steps.filter(step => step.screenshot);
  assert.ok(shots.length && shots.every(step => step.blurred >= 11), `every screenshot is blurred: ${JSON.stringify(state.recording.steps.map(step => [step.blurred, step.reason]))}`);
  await writeFile(resolve(artifacts, 'auto-blur.jpg'), Buffer.from(shots[0].screenshot.split(',')[1], 'base64'));
  const retainedSteps = state.recording.steps.length;
  const inputSteps = state.recording.steps.filter(step => step.kind === 'type').length;
  const realScreenshots = state.recording.steps.filter(step => step.screenshot).length;
  await savePanelShot('sidepanel-review.png');
  for (const width of [320, 450]) {
    await panelCommand('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
    const layout = await panelEval('({width:innerWidth, overflow:document.documentElement.scrollWidth > innerWidth, list:document.querySelector("#steps").getBoundingClientRect().bottom, footer:document.querySelector(".panel-controls").getBoundingClientRect().top})');
    assert.equal(layout.width, width);
    assert.equal(layout.overflow, false);
    assert.ok(layout.list <= layout.footer, 'Footer cannot obscure scrollable cards');
    await savePanelShot(`sidepanel-${width}.png`);
  }
  await panelCommand('Emulation.clearDeviceMetricsOverride');
  // Download from the actual native panel, not a substitute extension tab.
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts, eventsEnabled: true });
  let download;
  const onDownload = event => { download = event; };
  browser.on('Browser.downloadProgress', onDownload);
  await panelClick('#export');
  await waitFor(async () => download, event => event?.state === 'completed');
  browser.off('Browser.downloadProgress', onDownload);
  const html = await readFile(resolve(artifacts, 'recorded-procedure.html'), 'utf8');
  await writeFile(resolve(artifacts, 'smoke-sop.html'), html);
  assert.match(html, /data:image\/jpeg;base64,/);
  assert.ok(!html.includes('do-not-collect'), 'Typed field value must not appear as metadata');
  assert.ok(html.includes('final ordinary text') && html.includes('pasted ordinary text'));
  assert.ok(html.includes('Hello everyone corrected') && !html.includes('Type &quot;Hello everyone&quot;') && !html.includes('Type &quot;H&quot;'), 'Export retains latest text, not partial versions');
  assert.ok(!html.includes('fixture-excluded-value') && !html.includes('paused entry') && !html.includes('synthetic entry'));
  // Guide editor on the real capture.
  const viewer = await context.newPage();
  await viewer.setViewportSize({ width: 1100, height: 900 });
  const guideId = state.recording.id;
  assert.ok(guideId, 'guides have identities');
  await viewer.goto(`chrome-extension://${id}/viewer.html?guide=${guideId}`);
  await viewer.locator('.entry[data-kind="step"]').nth(retainedSteps - 1).waitFor();
  assert.equal(await viewer.locator('.entry[data-kind="step"]').count(), retainedSteps);
  assert.equal(await viewer.locator('.marker').count(), realScreenshots);
  assert.equal(await viewer.locator('.step-text').last().inputValue(), 'Type **"final ordinary text"** in the **Search** field');
  await viewer.screenshot({ path: resolve(artifacts, 'editor.png') });
  // Title, description, instruction and note autosave; the side panel shows the edit live.
  await viewer.locator('#guide-title').fill('Smoke guide');
  await viewer.locator('#guide-description').fill('Checks the editor.');
  await viewer.locator('.step-text').first().fill('Go to the next step');
  await viewer.locator('.step-note').first().fill('Use the button at the top.');
  await viewer.locator('#guide-title').click();
  state = await until(s => s?.recording?.guideTitle === 'Smoke guide' && s.recording.description === 'Checks the editor.' &&
    s.recording.steps[0].text === 'Go to the next step' && s.recording.steps[0].note === 'Use the button at the top.');
  await waitFor(() => panelEval('document.querySelector(".step-card h2").textContent'), text => text === 'Go to the next step');
  // Insert a tip after step 1, then move step 2 to the top with the buttons.
  const gap = viewer.locator('.insert').nth(1);
  await gap.hover();
  await gap.locator('.insert-toggle').click();
  await gap.locator('[data-kind="tip"]').click();
  await viewer.locator('.block-tip .block-text:focus').waitFor();
  await viewer.keyboard.type('Wait for the page to load.');
  await viewer.locator('#guide-title').click();
  state = await until(s => s?.recording?.steps[1]?.kind === 'tip' && s.recording.steps[1].text === 'Wait for the page to load.');
  const secondId = state.recording.steps[2].id;
  const tipId = state.recording.steps[1].id;
  await viewer.locator(`[data-id="${secondId}"]`).hover();
  await viewer.locator(`[data-id="${secondId}"] .move-up`).click();
  await viewer.locator(`[data-id="${secondId}"] .move-up`).click();
  state = await until(s => s?.recording?.steps[0]?.id === secondId);
  assert.equal(await panelEval('document.querySelectorAll(".step-card").length'), retainedSteps, 'The panel lists steps only');
  // Drag the tip by its handle above the step before it: [2, 1, tip] becomes [2, tip, 1].
  assert.equal(state.recording.steps[2].id, tipId);
  // Real mouse steps: Chrome runs its own drag loop for HTML drag and drop.
  const above = viewer.locator('.entry').nth(1);
  await above.evaluate(node => node.scrollIntoView({ block: 'start' }));
  await viewer.locator(`[data-id="${tipId}"]`).hover();
  const handle = await viewer.locator(`[data-id="${tipId}"] .grip`).boundingBox();
  const aboveBox = await above.boundingBox();
  await viewer.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await viewer.mouse.down();
  await viewer.mouse.move(handle.x + 30, handle.y - 20, { steps: 6 });
  await viewer.mouse.move(aboveBox.x + 120, aboveBox.y + 12, { steps: 12 });
  await viewer.mouse.up();
  state = await until(s => s?.recording?.steps[1]?.id === tipId);
  // Blur and crop a real screenshot.
  const shotStep = state.recording.steps.find(s => s.screenshot);
  const shotCard = viewer.locator(`[data-id="${shotStep.id}"]`);
  await shotCard.scrollIntoViewIfNeeded();
  await shotCard.hover();
  await shotCard.locator('.edit-image').click();
  const canvas = viewer.locator('.image-editor canvas');
  await canvas.waitFor();
  const box = await canvas.boundingBox();
  const drag = async (x1, y1, x2, y2) => {
    await viewer.mouse.move(box.x + box.width * x1, box.y + box.height * y1); await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 6 }); await viewer.mouse.up();
  };
  await drag(0.02, 0.04, 0.4, 0.2);
  await viewer.locator('.image-editor [data-tool="crop"]').click();
  await drag(0.001, 0.001, 0.999, 0.75);
  await viewer.screenshot({ path: resolve(artifacts, 'image-editor.png') });
  await viewer.locator('.ie-apply').click();
  state = await until(s => s?.recording?.steps.find(x => x.id === shotStep.id).screenshot !== shotStep.screenshot);
  const cropped = state.recording.steps.find(x => x.id === shotStep.id);
  assert.ok(cropped.height < shotStep.height * 0.8 && Math.abs(cropped.width - shotStep.width) < shotStep.width * 0.01, `Crop keeps the top three quarters: ${JSON.stringify([shotStep.width, shotStep.height, cropped.width, cropped.height, cropped.x, cropped.y, cropped.hideMarker])}`);
  await viewer.screenshot({ path: resolve(artifacts, 'editor-edited.png') });
  // Word export: a real .docx with every screenshot.
  const exportAs = async format => { await viewer.locator('#export-toggle').click(); await viewer.locator(`[data-export="${format}"]`).click(); };
  // Downloads already go to the artifacts folder (Browser.setDownloadBehavior above).
  let wordDownload;
  const onWordDownload = event => { if (event.state === 'completed') wordDownload = event; };
  browser.on('Browser.downloadProgress', onWordDownload);
  await rm(resolve(artifacts, 'Smoke guide.docx'), { force: true });
  await exportAs('docx');
  await waitFor(async () => wordDownload, Boolean);
  browser.off('Browser.downloadProgress', onWordDownload);
  const docxBytes = await readFile(resolve(artifacts, 'Smoke guide.docx'));
  assert.equal(docxBytes.readUInt32LE(0), 0x04034b50, 'zip package');
  for (const text of ['Smoke guide', 'Go to the next step', 'Wait for the page to load.']) assert.ok(docxBytes.includes(Buffer.from(text)), text);
  assert.equal(docxBytes.toString('latin1').match(/word\/media\/image\d+\.jpeg/g).length / 2, realScreenshots, 'one embedded image per screenshot');
  // PDF: the print page renders the edited guide and opens the print dialog.
  // Chrome's real print dialog blocks the page it opens, so check that the
  // button opens the print page, then inspect a copy whose print call is recorded.
  const [opened] = await Promise.all([context.waitForEvent('page'), exportAs('pdf')]);
  assert.equal(opened.url(), `chrome-extension://${id}/print.html?guide=${guideId}`);
  await opened.close();
  const printPage = await context.newPage();
  await printPage.addInitScript(() => { window.print = () => { window.__printed = (window.__printed ?? 0) + 1; }; });
  await printPage.goto(`chrome-extension://${id}/print.html?guide=${guideId}`);
  await printPage.waitForFunction(() => window.__printed === 1);
  assert.equal(await printPage.title(), 'Smoke guide');
  assert.equal(await printPage.locator('h1').textContent(), 'Smoke guide');
  assert.equal(await printPage.locator('.tip').count(), 1);
  assert.equal(await printPage.locator('.step').count(), retainedSteps);
  await printPage.emulateMedia({ media: 'print' });
  await printPage.screenshot({ path: resolve(artifacts, 'print-preview.png') });
  await printPage.close();
  // Guide me: walk the recorded guide on the page it was captured on.
  await page.bringToFront();
  const guideTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const started = await panelEval(`chrome.runtime.sendMessage({ type: 'GUIDE_START', guideId: ${JSON.stringify(guideId)}, tabId: ${guideTab} })`);
  assert.ok(started?.ok, `Guide me starts: ${JSON.stringify(started)}`);
  assert.equal(started.result.index, 0);
  await page.locator('[data-stepnote-guide]').waitFor({ state: 'attached' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(artifacts, 'guide-me.png') });
  const walkthrough = () => worker.evaluate(async () => (await chrome.storage.session.get('walkthroughs')).walkthroughs);
  const firstStep = state.recording.steps.find(s => s.kind !== 'tip');
  assert.ok(firstStep.target, 'new captures record element fingerprints');
  // The first step's target is the real button; clicking it moves the walkthrough on.
  await page.locator(firstStep.target.id ? `#${firstStep.target.id}` : 'text=Next step').first().click();
  await waitFor(walkthrough, value => value?.[guideTab]?.index === 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(artifacts, 'guide-me-step-2.png') });
  // Close the overlay (the walkthrough's own Exit runs in its closed shadow root).
  await worker.evaluate(async tabId => {
    await chrome.storage.session.set({ walkthroughs: {} });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => (window).__stepnoteGuide?.destroy() });
  }, guideTab);
  await page.locator('[data-stepnote-guide]').waitFor({ state: 'detached' });
  // Library: Done files the guide; the open editor keeps editing the stored copy.
  await panelClick('#done');
  await statusStartsWith('Ready');
  assert.equal((await saved()).recording, null);
  const stored = () => worker.evaluate(async key => (await chrome.storage.local.get(['guides', key])), `guide:${guideId}`);
  await waitFor(() => panelEval('[...document.querySelectorAll("#home .guide-item .guide-title")].map(t => t.textContent)'), titles => titles.includes('Smoke guide'));
  await savePanelShot('sidepanel-library.png');
  await viewer.locator('#guide-title').fill('Smoke guide filed');
  await viewer.locator('#guide-description').click();
  await waitFor(stored, value => value.guides?.[0]?.title === 'Smoke guide filed' && value[`guide:${guideId}`]?.recording.guideTitle === 'Smoke guide filed');
  const shelf = await context.newPage();
  await shelf.setViewportSize({ width: 1100, height: 700 });
  await shelf.goto(`chrome-extension://${id}/viewer.html`);
  await shelf.locator('.guide-item').first().waitFor();
  assert.equal(await shelf.locator('.guide-title').first().textContent(), 'Smoke guide filed');
  await shelf.locator('input[type="search"]').fill('next step');
  assert.equal(await shelf.locator('.guide-list li:not([hidden])').count(), 1, 'search covers step text');
  await shelf.screenshot({ path: resolve(artifacts, 'library.png') });
  await shelf.close();
  await viewer.locator('#delete').click();
  await viewer.locator('dialog.sheet[open] [data-action="confirm"]').click();
  await viewer.getByRole('status').filter({ hasText: 'No saved guide' }).waitFor();
  const afterDelete = await stored();
  assert.deepEqual(afterDelete.guides, []);
  assert.equal(afterDelete[`guide:${guideId}`], undefined);
  // The panel's list drops the deleted guide without a reload.
  await waitFor(() => panelEval('[...document.querySelectorAll("#home .guide-item .guide-title")].map(t => t.textContent)'), titles => !titles.includes('Smoke guide filed'));
  // Reopening the deleted guide's editor shows the empty state, not an error.
  await viewer.reload();
  await viewer.getByRole('status').filter({ hasText: 'No saved guide' }).waitFor();
  assert.equal(await viewer.locator('#error').textContent(), '');
  await waitFor(panelStatus, s => s.status.startsWith('Ready'));
  await viewer.close();
  await page.bringToFront();
  await startThisTabOnly();
  await statusStartsWith('Recording');
  for (const accept of [false, true]) {
    await panelClick('#discard');
    await waitFor(sheetOpen, Boolean);
    if (!accept) { await sheetSettled(); await savePanelShot('sidepanel-discard.png'); }
    await panelClick(`dialog.sheet [data-action="${accept ? 'confirm' : 'cancel'}"]`);
    await waitFor(sheetOpen, open => !open);
    if (accept) await until(s => s.recording === null);
    else assert.equal((await saved()).recording.status, 'recording', 'Cancelled discard keeps capture');
  }
  await waitFor(panelStatus, s => s.status.startsWith('Ready'));
  await writeFile(resolve(artifacts, 'smoke-result.json'), JSON.stringify({ passed: true, extensionId: id, browser: context.browser().version(), sidePanelTargetType: panelTarget.type, initialRealClickScreenshots: 4, retainedSteps, inputSteps, realScreenshots, followedLatestLayout: followedLayout, reviewModeRespected: true, followResumesAtBottomLeave: true, immediateFocusedTypeCard: true, firstLiveCardMs, bundledNunitoLoaded: bundledFont, stableEntryIdAcrossIdleAndPaste: liveEntryId, finalEntryScreenshot: true, ordinaryKeyboardTyping: true, realClipboardPaste: true, editableEntry: true, clearEntry: true, finalPauseEntry: true, finalCompleteEntry: true, secretExclusion: true, syntheticSuppression: true, liveUpdates: true, pauseSuppression: true, resumeCapture: true, previewAutoPause: true, stepDeletion: true, complete: true, panelHtmlDownload: true, confirmedDiscard: true, styledAccessSheet: true, styledDeleteSheets: true, guideEditor: true, guideLibrary: true, automaticBlur: true, guideMe: true, captureBar: true, siteIcon: true, imageBlurCrop: true, wordExport: true, pdfPrintPage: true, action: 'CDP Extensions.triggerAction', permissionsModified: false, deleted: true }, null, 2));
  console.log(`PASS: native side panel, review-aware following, immediate same-identity live entries with final screenshots, real keyboard/paste/editable/clear entries, final Pause/Complete text, secret/synthetic/paused suppression, ${retainedSteps} retained steps (${inputSteps} entries), ${realScreenshots} real images, preview/delete/export/discard, guide library, guide editing, blur/crop, Word and PDF export. Production permissions unchanged.`);
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
