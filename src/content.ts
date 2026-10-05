import { installPageCapture } from './page-capture.ts';
import { findSensitive } from './sensitive.ts';
import { mountCaptureBar } from './capture-bar.ts';
import { beginFullPage, type FullPageSession } from './fullpage.ts';

// This property lives in Chrome's isolated world, not the website's JavaScript world.
const scope = window as Window & { __localSopCleanup?: () => void; __localSopCaptureId?: string };
scope.__localSopCleanup?.();
// On-page Pause/Complete bar, when the capture controls setting asks for it.
let bar: ReturnType<typeof mountCaptureBar> | undefined;
// A full-page screenshot in progress: scroll position and styles to put back.
let fullPage: FullPageSession | undefined;
function cleanup() {
  fullPage?.restore(); fullPage = undefined;
  showControls();
  bar?.destroy(); bar = undefined;
  capture.cleanup();
  chrome.runtime.onMessage.removeListener(onMessage);
  window.clearInterval(heartbeat);
}
async function send(message: unknown) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    const action = message as { type?: string; payload?: { actionId?: string; sequence?: number } };
    if (response?.ok && action.type === 'INPUT' && action.payload?.actionId) capture.acknowledge(action.payload.actionId, action.payload.sequence);
    if (response?.ok && typeof response.result?.steps === 'number') bar?.setCount(response.result.steps);
    if (!response?.ok || !response.result?.active) cleanup();
  } catch { cleanup(); }
}

// Errors from Full page stay on the bar; the capture keeps running.
async function requestFullPage() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_FULL' });
    if (!response?.ok) bar?.notice('Full page failed', response?.error);
    else if (typeof response.result?.steps === 'number') bar?.setCount(response.result.steps);
    if (response?.ok && !response.result?.active) cleanup();
  } catch { cleanup(); }
}
let hidden: [HTMLElement, string, string][] = [];
function showControls() {
  for (const [el, value, priority] of hidden) value ? el.style.setProperty('visibility', value, priority) : el.style.removeProperty('visibility');
  hidden = [];
}
const painted = (reply: (response: unknown) => void, value: unknown) => requestAnimationFrame(() => requestAnimationFrame(() => reply(value)));

function onMessage(message: { type?: string; cutoff?: number; top?: number; hideFixed?: boolean }, sender: chrome.runtime.MessageSender, reply: (response: unknown) => void) {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message?.type === 'FINALIZE_INPUT' && Number.isFinite(message.cutoff)) {
    reply({ actions: capture.finalize(message.cutoff) }); cleanup();
  }
  else if (message?.type === 'DISARM') cleanup();
  else if (message?.type === 'SENSITIVE_REGIONS') reply(findSensitive(window));
  // Out of the screenshot: Stepnote's bar and on-screen button. Reply once
  // the page has painted without them, or at once when none were showing.
  else if (message?.type === 'CONTROLS_HIDE') {
    showControls();
    const shown = [...document.querySelectorAll<HTMLElement>('[data-stepnote-ui]')].filter(el => el.style.visibility !== 'hidden');
    hidden = shown.map(el => [el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    for (const el of shown) el.style.setProperty('visibility', 'hidden', 'important');
    if (!shown.length) { reply({ hidden: true }); return; }
    painted(reply, { hidden: true });
    return true;
  }
  else if (message?.type === 'CONTROLS_SHOW') { showControls(); reply({ shown: true }); }
  else if (message?.type === 'FULLPAGE_BEGIN') {
    fullPage?.restore();
    fullPage = beginFullPage(window);
    painted(reply, fullPage.measure);
    return true;
  }
  else if (message?.type === 'FULLPAGE_SCROLL' && fullPage && Number.isFinite(message.top)) {
    if (message.hideFixed) fullPage.hideFixed();
    const top = fullPage.scroll(message.top!);
    painted(reply, { top });
    return true;
  }
  else if (message?.type === 'FULLPAGE_END') { fullPage?.restore(); fullPage = undefined; reply({ done: true }); }
}
const heartbeat = window.setInterval(() => void send({ type: 'PING' }), 20000);
const capture = installPageCapture(window, message => void send(message), undefined, scope.__localSopCaptureId);
chrome.runtime.onMessage.addListener(onMessage);
scope.__localSopCleanup = cleanup;
void chrome.runtime.sendMessage({ type: 'CAPTURE_CONTROLS' }).then(response => {
  if (!response?.ok || !response.result?.show || bar) return;
  bar = mountCaptureBar(window, { pause: () => void send({ type: 'CAPTURE_PAUSE' }), complete: () => void send({ type: 'CAPTURE_STOP' }), fullPage: () => void requestFullPage() });
  bar.setCount(response.result.steps ?? 0);
}).catch(() => {});
