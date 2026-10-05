import type { Port, State } from './recorder.ts';
import { imageBoxes, matchesViewport, pixelate, type Regions } from './redact.ts';
import { routeTokenOf } from './route.ts';
import { planSlices, placements, type PageMeasure } from './fullpage.ts';

const validRegions = (value: unknown): value is Regions => {
  const r = value as Regions;
  return !!r && Number.isFinite(r.width) && Number.isFinite(r.height) && Array.isArray(r.boxes) && r.boxes.length <= 400 &&
    r.boxes.every(b => [b?.x, b?.y, b?.width, b?.height].every(Number.isFinite));
};
const validMeasure = (value: unknown): value is PageMeasure => {
  const m = value as PageMeasure;
  return !!m && (m.mode === 'window' || m.mode === 'element') && typeof m.background === 'string' &&
    [m.rect?.x, m.rect?.y, m.rect?.width, m.rect?.height, m.scrollTop, m.scrollHeight, m.innerWidth, m.innerHeight].every(Number.isFinite) &&
    m.clientHeight > 0 && m.innerWidth > 0 && m.innerHeight > 0;
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function dataUrl(canvas: OffscreenCanvas, quality: number) {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return `data:image/jpeg;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const chromePort: Port = {
  async read() {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return ((await chrome.storage.local.get('sop')).sop as State | undefined) ?? null;
  },
  async write(state) { await chrome.storage.local.set({ sop: state }); },
  async target(tabId, windowId) {
    if (tabId === undefined) throw new Error('No recording tab selected.');
    const tab = await chrome.tabs.get(tabId);
    if (windowId !== undefined && tab.windowId !== windowId) throw new Error('Selected tab moved out of the panel window. Invoke the toolbar action again.');
    if (tab.id === undefined || !tab.active || !tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('Open a normal HTTP or HTTPS page, then use the extension toolbar button.');
    const url = new URL(tab.url);
    return { tabId: tab.id, windowId: tab.windowId, title: (tab.title || 'Recorded procedure').slice(0, 200), url: (url.origin + url.pathname).slice(0, 2048), route: routeTokenOf(url.hash) };
  },
  async inject(tabId, captureId) {
    const initialized = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, args: [captureId ?? ''], func: (id: string) => { (window as Window & { __localSopCaptureId?: string }).__localSopCaptureId = id; } });
    const documentId = initialized[0]?.documentId;
    if (!documentId) throw new Error('Chrome did not allow recording in this document.');
    const results = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files: ['content.js'] });
    if (!results[0]?.documentId) throw new Error('Chrome did not allow recording in this document.');
    return results[0].documentId;
  },
  async current(tabId, windowId, allowLoading = false) {
    const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => location.href });
    const tab = await chrome.tabs.get(tabId);
    return { active: tab.active && (allowLoading || tab.status === 'complete') && tab.windowId === windowId, documentId: results[0]?.documentId ?? '' };
  },
  async capture(windowId) { return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 65 }); },
  async finalize(recording, cutoff) {
    const response = await chrome.tabs.sendMessage(recording.tabId, { type: 'FINALIZE_INPUT', cutoff }, { documentId: recording.documentId, frameId: 0 });
    if (!response || !Array.isArray(response.actions)) throw new Error('The original document did not acknowledge finalization.');
    return response.actions;
  },
  async sensitive(recording) {
    const regions = await chrome.tabs.sendMessage(recording.tabId, { type: 'SENSITIVE_REGIONS' }, { documentId: recording.documentId, frameId: 0 });
    if (!validRegions(regions)) throw new Error('The page did not report private regions.');
    return regions;
  },
  async redact(screenshot, regions) {
    const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
    if (!matchesViewport(regions, bitmap)) throw new Error('The screenshot does not match the page viewport.');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    for (const box of imageBoxes(regions, canvas)) pixelate(context, box, (w, h) => new OffscreenCanvas(w, h));
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.65 });
    return `data:image/jpeg;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
  },
  async beforeCapture(recording) {
    await chrome.tabs.sendMessage(recording.tabId, { type: 'CONTROLS_HIDE' }, { documentId: recording.documentId, frameId: 0 });
  },
  async afterCapture(recording) {
    await chrome.tabs.sendMessage(recording.tabId, { type: 'CONTROLS_SHOW' }, { documentId: recording.documentId, frameId: 0 });
  },
  // Scroll the page a viewport at a time and stitch the slices. Chrome allows
  // about two screenshots a second; each slice is blurred before it is drawn.
  async fullPage(recording, { blur }) {
    const to = { documentId: recording.documentId, frameId: 0 };
    const send = (message: unknown) => chrome.tabs.sendMessage(recording.tabId, message, to);
    let last = Date.now();
    await send({ type: 'CONTROLS_HIDE' });
    try {
      const m = await send({ type: 'FULLPAGE_BEGIN' });
      if (!validMeasure(m)) throw new Error('The page did not report its size.');
      const plan = planSlices(m), height = m.innerHeight + plan.extra, tops: number[] = [];
      let out: OffscreenCanvas | undefined, scale = 1;
      for (const [index, position] of plan.positions.entries()) {
        const moved = await send({ type: 'FULLPAGE_SCROLL', top: position, hideFixed: index > 0 });
        if (!Number.isFinite(moved?.top)) throw new Error('The page did not scroll.');
        tops.push(moved.top);
        await wait(Math.max(0, last + 550 - Date.now()));
        const tab = await chrome.tabs.get(recording.tabId);
        if (!tab.active || tab.windowId !== recording.windowId) throw new Error('Keep the captured tab in front until the full page is done.');
        const regions = blur ? await chromePort.sensitive!(recording) : undefined;
        const shot = await chrome.tabs.captureVisibleTab(recording.windowId, { format: 'jpeg', quality: 90 });
        last = Date.now();
        const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
        if (regions && !matchesViewport([regions], bitmap)) throw new Error('The screenshot does not match the page viewport.');
        const slice = new OffscreenCanvas(bitmap.width, bitmap.height), context = slice.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        if (regions) for (const box of imageBoxes([regions], slice)) pixelate(context, box, (w, h) => new OffscreenCanvas(w, h));
        // Device pixels per CSS pixel in the slices; the output is capped for size.
        const device = bitmap.width / m.innerWidth;
        if (!out) {
          scale = Math.min(device, 1.5, 16000 / height);
          out = new OffscreenCanvas(Math.round(m.innerWidth * scale), Math.round(height * scale));
          const o = out.getContext('2d')!;
          o.fillStyle = m.background; o.fillRect(0, 0, out.width, out.height);
        }
        const o = out.getContext('2d')!;
        for (const op of placements(m, plan, tops).filter(op => op.slice === index))
          o.drawImage(slice, op.sx * device, op.sy * device, op.sw * device, op.sh * device, op.dx * scale, op.dy * scale, op.sw * scale, op.sh * scale);
      }
      return { screenshot: await dataUrl(out!, 0.75), width: m.innerWidth, height, truncated: plan.truncated };
    } finally {
      await send({ type: 'FULLPAGE_END' }).catch(() => {});
      await send({ type: 'CONTROLS_SHOW' }).catch(() => {});
    }
  },
  async favicon(pageUrl) {
    const response = await fetch(chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`));
    if (!response.ok) throw new Error('No icon.');
    // Chrome may label the cached icon as BMP; decode it and keep a 32 px PNG.
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(32, 32);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, 32, 32);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    return `data:image/png;base64,${base64(new Uint8Array(await png.arrayBuffer()))}`;
  },
  now: () => Date.now(),
};
