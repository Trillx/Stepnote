import { isStep, type State, type Step } from './recorder.ts';
import { emphasis, exportHtml } from './sop.ts';
import { askSiteAccess } from './dialog.ts';
import { mountLibrary, type LibraryApi } from './library-ui.ts';
import { mountSettings, type SettingsApi } from './settings-ui.ts';

type Request = (type: string, stepId?: string, extra?: Record<string, unknown>) => Promise<State>;
type Subscribe = (listener: (state: State) => void) => () => void;
type ConfirmDelete = (summary: { live: boolean; steps: number }) => boolean | Promise<boolean>;
// Optional access that lets capture follow other tabs. Without it, Start
// records only the tab activeTab covers.
export interface SiteAccess {
  granted(): Promise<boolean>;
  // Must call chrome.permissions.request synchronously, inside the click.
  request(): void;
  onChange?(listener: (granted: boolean) => void): void;
}
export async function mountSidePanel(root: HTMLElement, request: Request, subscribe: Subscribe, download: (html: string) => void, confirmDelete: ConfirmDelete, openViewer: (guideId?: string) => void, access?: SiteAccess, library?: LibraryApi, settings?: SettingsApi): Promise<() => void> {
  root.innerHTML = `<header class="panel-header"><div class="brand"><svg class="brand-mark" viewBox="0 0 128 128" aria-hidden="true"><rect x="4" y="4" width="120" height="120" rx="28" fill="#1f2731" stroke="#3b4756" stroke-width="3"/><path d="M28 94H52V70H76V46H90" fill="none" stroke="#7aa2ff" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="96" cy="40" r="13" fill="#ff3d8b" stroke="#fff" stroke-width="5"/></svg><h1 class="eyebrow">Stepnote</h1><button id="settings-toggle" class="icon-button" type="button" aria-label="Settings" aria-expanded="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button></div>
    <p id="status" role="status" aria-live="polite">Loading...</p><p id="error" role="alert"></p></header>
    <section id="steps" aria-label="Captured steps" tabindex="0">
      <section id="settings" hidden aria-labelledby="settings-title"></section>
      <section id="home"><button id="start" disabled><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><circle cx="10" cy="10" r="3.6" class="dot"/></svg>Start Capture</button>
        <label class="switch"><input type="checkbox" id="auto-blur" checked><span>Blur private info automatically</span></label>
        <p>Saved on this device.</p></section>
      <section id="empty" hidden><div class="capture-orbit" aria-hidden="true">◎</div><h2>Capturing your screen</h2><p>Click the web page to begin capturing.</p></section>
      <ol id="cards" aria-label="Captured action steps"></ol>
      <p id="privacy-note">Text and screenshots are saved. Review before sharing.</p>
      <details id="capture-details"><summary>Privacy &amp; limits</summary>
      <p class="scope">Local-only. No uploads or accounts. One saved guide at a time.</p>
      <p id="location" class="location" hidden></p>
      <p class="scope">Capture follows the tab in focus, including new tabs, page loads and other windows, when you allow Stepnote to access web pages at Start. Without that access, only the starting page is captured. Browser pages such as settings are skipped.</p>
      <p class="warning">Ordinary typed entries are saved locally and included in exports. Recognized credential and payment fields are excluded from entry metadata. Automatic blur covers recognized emails, phone, card and account numbers, and credential fields, but it can miss things. Screenshots may still contain sensitive information. Review every step before sharing.</p>
      </details>
    </section>
    <footer class="panel-controls"><div class="control-row"><button id="pause" disabled>Pause</button><button id="discard" disabled>Discard Capture</button></div>
      <button id="full-page" type="button" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="2.5" width="12" height="15" rx="2"/><path d="M7 6.5h6M7 10h6M7 13.5h4"/></svg>Full page screenshot</button>
      <button id="complete" class="primary" disabled>Complete Capture</button>
      <div id="review" hidden><p>Review your screenshots before sharing.</p><div class="control-row"><button id="view">Edit guide</button><button id="export">Export HTML</button></div><button id="done">Done</button></div>
    </footer>
    <dialog id="preview" aria-labelledby="preview-title"><div class="preview-heading"><h2 id="preview-title">Screenshot preview</h2><button id="close-preview" aria-label="Close preview">Close</button></div>
      <p>Capture stays paused when you close this preview. Use Resume to continue. This image is not redacted.</p><div class="shot" id="preview-shot"></div></dialog>`;
  const doc = root.ownerDocument;
  const element = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  const button = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!;
  const cards = element('#cards');
  const scroll = element('#steps');
  const dialog = root.querySelector<HTMLDialogElement>('#preview')!;
  let state: State = { recording: null };
  let busy = false;
  let accessGranted = !access || await access.granted().catch(() => false);
  // Automatic blur setting, remembered on this device. Storage can be blocked.
  const blurToggle = root.querySelector<HTMLInputElement>('#auto-blur')!;
  const storage = (() => { try { return doc.defaultView?.localStorage; } catch { return undefined; } })();
  try { blurToggle.checked = storage?.getItem('stepnote.autoBlur') !== 'off'; } catch { /* keep default */ }
  blurToggle.addEventListener('change', () => { try { storage?.setItem('stepnote.autoBlur', blurToggle.checked ? 'on' : 'off'); } catch { /* not remembered */ } });
  // The guide list sits on the home screen and refreshes whenever home shows.
  const shelf = library ? await mountLibrary(element('#home'), library) : undefined;
  let homeShown = true;
  let settingsOpen = false;
  const settingsView = element('#settings');
  const gear = button('#settings-toggle');
  function showSettings(open: boolean) {
    settingsOpen = open;
    settingsView.hidden = !open;
    root.dataset.view = open ? 'settings' : '';
    gear.setAttribute('aria-expanded', String(open));
    render(state);
    (open ? settingsView.querySelector<HTMLElement>('#settings-back') : gear)?.focus();
  }
  if (settings) {
    gear.hidden = false;
    await mountSettings(settingsView, settings, () => showSettings(false));
    gear.addEventListener('click', () => showSettings(!settingsOpen));
  }
  access?.onChange?.(granted => { accessGranted = granted; });
  let previewSource: HTMLButtonElement | undefined;
  const nodes = new Map<string, HTMLElement>();
  let latestReveal: string | undefined;
  let following = true;
  let hovering = false;
  let lastScrollTop = scroll.scrollTop;
  const atBottom = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2;
  scroll.addEventListener('pointerenter', () => { hovering = true; });
  scroll.addEventListener('pointerleave', () => {
    hovering = false;
    if (atBottom()) { following = true; revealLatest(); }
  });
  scroll.addEventListener('scroll', () => {
    if (scroll.scrollTop < lastScrollTop - 1) following = false;
    lastScrollTop = scroll.scrollTop;
  });
  scroll.addEventListener('wheel', () => { following = false; }, { passive: true });
  scroll.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) following = false;
  });
  function revealLatest() {
    if (!following || hovering) return;
    const card = latestReveal ? nodes.get(latestReveal) : undefined;
    if (!card?.isConnected) return;
    const box = card.getBoundingClientRect();
    const viewport = scroll.getBoundingClientRect();
    // Scroll this container only. Whole short cards fit above the footer;
    // tall screenshots reveal the heading instead of scrolling it offscreen.
    const padding = Math.min(20, Math.max(0, (scroll.clientHeight - box.height) / 2));
    scroll.scrollTop += box.height > scroll.clientHeight ? box.top - viewport.top : box.bottom - viewport.bottom + padding;
    lastScrollTop = scroll.scrollTop;
  }
  function image(step: Step, label: string): HTMLElement | null {
    if (!step.screenshot || !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(step.screenshot)) return null;
    const shot = doc.createElement('div'); shot.className = 'shot';
    const img = doc.createElement('img'); img.src = step.screenshot; img.alt = label;
    const marker = doc.createElement('span'); marker.className = state.recording?.markerStyle === 'box' ? 'marker box' : 'marker'; marker.setAttribute('role', 'img'); marker.setAttribute('aria-label', step.kind === 'type' ? 'Input position' : 'Click position');
    marker.style.left = `${Math.min(100, Math.max(0, step.x / step.width * 100))}%`;
    marker.style.top = `${Math.min(100, Math.max(0, step.y / step.height * 100))}%`;
    shot.append(img, marker); return shot;
  }
  function render(next: State) {
    if ((next.revision ?? 0) < (state.revision ?? 0)) return;
    state = next;
    const r = state.recording;
    // The panel lists captured steps only; author blocks live in the editor.
    const steps = r?.steps.filter(isStep) ?? [];
    root.dataset.recordingStatus = r?.status ?? 'ready';
    const live = !!r && r.status !== 'stopped';
    element('#status').textContent = r ? `${r.status === 'recording' ? 'Recording' : r.status === 'paused' ? 'Paused' : r.stoppedReason || state.error ? 'Stopped' : 'Complete'}: ${steps.length} steps. ${r.stoppedReason ?? (r.status !== 'stopped' ? r.notice : r.tidied ? `Tidied ${r.tidied} ${r.tidied === 1 ? 'step' : 'steps'}.` : undefined) ?? ''}` : 'Ready';
    element('#error').textContent = state.error ?? '';
    element('#home').hidden = !!r || settingsOpen;
    if (!r && !homeShown) void shelf?.refresh();
    homeShown = !r;
    element('.panel-controls').hidden = !r;
    element('#empty').hidden = !r || steps.length > 0 || r.status === 'stopped';
    element('#empty h2').textContent = r?.status === 'paused' ? 'Capture paused' : 'Capturing your screen';
    element('#empty p').textContent = r?.status === 'paused' ? 'Use Resume to capture more clicks.' : 'Click the web page to begin capturing.';
    element('#location').hidden = !r;
    element('#location').textContent = r ? `Navigate to ${r.url}` : '';
    button('#start').disabled = busy || !!r;
    button('#pause').disabled = busy || !live;
    button('#pause').textContent = r?.status === 'paused' ? 'Resume' : 'Pause';
    button('#discard').disabled = busy || !r;
    button('#discard').textContent = live ? 'Discard Capture' : 'Delete recording';
    button('#complete').disabled = busy || !live;
    button('#full-page').hidden = !live;
    button('#full-page').disabled = busy;
    element('#complete').hidden = !!r && !live;
    element('#review').hidden = !r || live;
    button('#export').disabled = busy || !r;
    button('#done').disabled = busy || !r;
    let added = false;
    const identities = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const id = step.id ?? `legacy-${index}`;
      identities.add(id);
      let card = nodes.get(id);
      if (!card) {
        added = true;
        latestReveal = id;
        card = doc.createElement('li'); card.className = 'step-card'; card.dataset.stepId = id;
        const heading = doc.createElement('div'); heading.className = 'card-heading';
        const number = doc.createElement('span'); number.className = 'step-number';
        const title = doc.createElement('h2');
        const remove = doc.createElement('button'); remove.className = 'delete-step'; remove.textContent = 'Delete';
        remove.addEventListener('click', () => void run('DELETE_STEP', step.id));
        heading.append(number, title, remove); card.append(heading);
        nodes.set(id, card);
      }
      const heading = card.querySelector('h2')!;
      const text = step.text ?? step.label;
      if (heading.dataset.text !== text) {
        heading.dataset.text = text;
        heading.replaceChildren(...emphasis(step).map(part => {
          if (!part.bold) return doc.createTextNode(part.text);
          const strong = doc.createElement('strong'); strong.textContent = part.text; return strong;
        }));
      }
      if (card.dataset.screenshot !== (step.screenshot ?? '') || card.dataset.reason !== (step.reason ?? '')) {
        card.querySelector('.thumbnail')?.remove();
        card.querySelector('p')?.remove();
        card.dataset.screenshot = step.screenshot ?? '';
        card.dataset.reason = step.reason ?? '';
        const shot = image(step, `Screenshot for step ${index + 1}`);
        if (shot) {
          shot.querySelector('img')!.addEventListener('load', () => {
            if (nodes.get(id)?.isConnected) revealLatest();
          }, { once: true });
          const thumb = doc.createElement('button'); thumb.className = 'thumbnail'; thumb.append(shot);
          thumb.addEventListener('click', () => void preview(id, thumb)); card.append(thumb);
        } else { const reason = doc.createElement('p'); reason.textContent = step.reason ?? 'Screenshot unavailable.'; card.append(reason); }
      }
      card.querySelector('.step-number')!.textContent = String(index + 1);
      card.querySelector<HTMLButtonElement>('.delete-step')!.disabled = busy || !step.id;
      card.querySelector('.delete-step')!.setAttribute('aria-label', `Delete step ${index + 1}`);
      card.querySelector('.thumbnail')?.setAttribute('aria-label', `Preview screenshot for step ${index + 1}`);
      card.querySelector('img')?.setAttribute('alt', `Screenshot for step ${index + 1}`);
      // Existing cards stay mounted. Only append new cards, without resetting scroll or focus.
      if (card.parentElement !== cards) cards.append(card);
    }
    for (const [id, node] of nodes) if (!identities.has(id)) { node.remove(); nodes.delete(id); }
    if (latestReveal && !identities.has(latestReveal)) latestReveal = undefined;
    if (added) revealLatest();
  }
  async function run(type: string, stepId?: string, extra?: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    busy = true; render(state);
    try { render(await (extra ? request(type, stepId, extra) : request(type, stepId))); return true; }
    catch (error) { element('#error').textContent = String(error); return false; }
    finally {
      busy = false;
      // Keep command errors visible, while restoring controls from the last valid state.
      const error = element('#error').textContent;
      render(state);
      if (error) element('#error').textContent = error;
    }
  }
  async function preview(id: string, source: HTMLButtonElement) {
    if (busy || !state.recording?.steps.some(s => s.id === id)) return;
    if (state.recording.status === 'recording' && !await run('PAUSE')) return;
    const step = state.recording?.steps.find(s => s.id === id);
    if (!step || !isStep(step)) return;
    previewSource = source;
    element('#preview-shot').replaceChildren();
    const shot = image(step, step.kind === 'type' ? 'Larger screenshot with input position' : 'Larger screenshot with click position');
    if (shot) element('#preview-shot').append(shot);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    button('#close-preview').focus();
  }
  function closePreview() {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    previewSource?.focus();
  }
  button('#start').addEventListener('click', async () => {
    if (busy) return;
    if (!accessGranted && access && !await askSiteAccess(doc, () => access.request())) return;
    void run('START', undefined, { autoBlur: blurToggle.checked });
  });
  button('#pause').addEventListener('click', () => void run(state.recording?.status === 'paused' ? 'RESUME' : 'PAUSE'));
  button('#complete').addEventListener('click', () => void run('STOP'));
  button('#full-page').addEventListener('click', () => void run('FULL_PAGE'));
  button('#discard').addEventListener('click', async () => {
    const r = state.recording;
    if (busy || !r) return;
    if (await confirmDelete({ live: r.status !== 'stopped', steps: r.steps.length })) void run('DELETE');
  });
  button('#view').addEventListener('click', () => openViewer(state.recording?.id));
  button('#done').addEventListener('click', () => void run('ARCHIVE'));
  button('#export').addEventListener('click', () => { if (state.recording) download(exportHtml(state.recording)); });
  button('#close-preview').addEventListener('click', closePreview);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
  const unsubscribe = subscribe(render);
  await run('STATUS');
  return unsubscribe;
}
