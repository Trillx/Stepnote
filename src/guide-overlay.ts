// Guide me overlay, drawn in the page by a content script. A closed shadow
// root keeps the page's styles and scripts out. The overlay takes no clicks
// except on its card, so the page stays fully usable.
import { findTarget } from './fingerprint.ts';
import { noRoute, routeToken } from './route.ts';
import type { GuideView } from './guide-session.ts';

export interface GuideOverlayApi {
  state(): Promise<GuideView | null>;
  next(): Promise<GuideView | null>;
  back(): Promise<GuideView | null>;
  exit(): Promise<void>;
}
// Record ids in paths (numbers, UUIDs, long codes with digits) may differ.
// Only clear record ids: long numbers (5+ digits, so not years or wizard
// pages), UUIDs, and long opaque tokens mixing letters and digits.
const idLike = (segment: string) => /^\d{5,}$/.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
  segment.length >= 16 && /^[\w-]+$/.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment);
// Whether two addresses are the same page of the same site.
export function samePage(recorded: string, current: string): boolean {
  try {
    const a = new URL(recorded), b = new URL(current);
    if (a.origin !== b.origin) return false;
    const p = a.pathname.split('/').filter(Boolean), q = b.pathname.split('/').filter(Boolean);
    return p.length === q.length && p.every((segment, i) => segment === q[i] || idLike(segment) && idLike(q[i]));
  } catch { return false; }
}
interface Options {
  // Only real user input moves a walkthrough on.
  trusted?: (event: Event) => boolean;
  // How long to look for the target before showing the screenshot instead.
  findTimeout?: number;
}

const styles = `
:host { all: initial; }
* { box-sizing: border-box; }
.spot { position: fixed; border-radius: 10px; box-shadow: 0 0 0 100vmax rgba(8, 11, 15, .5); outline: 2px solid #7aa2ff; outline-offset: 2px; transition: left .12s, top .12s, width .12s, height .12s; pointer-events: none; }
.spot::after { content: ""; position: absolute; inset: -8px; border-radius: 14px; border: 2px solid #7aa2ff; opacity: 0; animation: ring 1.6s ease-out infinite; }
@keyframes ring { 0% { opacity: .8; transform: scale(.96); } 100% { opacity: 0; transform: scale(1.08); } }
.card { position: fixed; width: min(340px, calc(100vw - 24px)); padding: 14px 16px 12px; border: 1px solid #2a3440; border-radius: 14px; background: #171d24; color: #e8edf2; box-shadow: 0 18px 50px rgba(0, 0, 0, .55); font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; pointer-events: auto; }
.top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.count { flex: 0 0 auto; padding: 2px 8px; border-radius: 999px; background: rgba(122, 162, 255, .16); color: #a9c2ff; font-size: 12px; font-weight: 700; }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9ba7b3; font-size: 12px; }
.exit { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #9ba7b3; font: 400 20px/1 system-ui, sans-serif; cursor: pointer; }
.exit:hover { background: #26303c; color: #e8edf2; }
.tips p { margin: 0 0 6px; padding: 6px 10px; border-radius: 8px; background: rgba(99, 199, 178, .12); color: #b9ecdf; font-size: 13px; }
.tips p.header { padding: 0; background: none; color: #e8edf2; font-weight: 700; }
.tips p.alert { background: rgba(255, 143, 163, .12); color: #ffd3db; }
.tips b { margin-right: 4px; }
.instruction { margin: 0; font-size: 15px; font-weight: 500; overflow-wrap: anywhere; }
.instruction strong { color: #a9c2ff; font-weight: 800; }
.note { margin: 6px 0 0; color: #9ba7b3; font-size: 13px; overflow-wrap: anywhere; }
.note:empty { display: none; }
.fallback { margin-top: 10px; }
.fallback-text { margin: 0 0 8px; color: #c3ccd5; font-size: 13px; }
.fallback img { display: block; max-width: 100%; max-height: 180px; margin: 0 auto 8px; border-radius: 8px; border: 1px solid #2a3440; }
.open-page { display: inline-block; margin-bottom: 4px; color: #a9c2ff; font-weight: 700; font-size: 13px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.actions button { min-height: 32px; padding: 5px 14px; border: 1px solid #3b4756; border-radius: 9px; background: #1f2731; color: #e8edf2; font: 700 13px/1.2 "Segoe UI", system-ui, sans-serif; cursor: pointer; }
.actions button:hover:enabled { background: #26303c; }
.actions button:disabled { opacity: .4; cursor: default; }
.actions .next { background: #eef1f4; border-color: #eef1f4; color: #0f1318; }
.actions .next:hover:enabled { background: #ffffff; }
button:focus-visible, a:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; }
.approx { position: fixed; width: 44px; height: 44px; border: 2px dashed #7aa2ff; border-radius: 50%; background: rgba(122, 162, 255, .12); pointer-events: none; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { .spot { transition: none; } .spot::after { animation: none; } }
`;

export function mountGuide(win: Window, api: GuideOverlayApi, options: Options = {}): { root: ShadowRoot; ready: Promise<void>; destroy(): void } {
  const doc = win.document;
  const trusted = options.trusted ?? ((event: Event) => event.isTrusted);
  const findTimeout = options.findTimeout ?? 1500;
  const host = doc.createElement('div');
  host.dataset.stepnoteGuide = '';
  host.dataset.stepnoteUi = '';
  host.setAttribute('style', 'position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${styles}</style><div class="spot" hidden></div><div class="approx" hidden></div>
    <section class="card" role="dialog" aria-label="Stepnote guide">
      <div class="top"><span class="count"></span><span class="title"></span><button class="exit" type="button" aria-label="Exit guide">×</button></div>
      <div class="tips"></div>
      <p class="instruction" aria-live="polite"></p>
      <p class="note"></p>
      <div class="fallback" hidden><p class="fallback-text"></p><img alt=""><a class="open-page" hidden>Open page</a></div>
      <div class="actions"><button class="back" type="button">Back</button><button class="next" type="button">Next</button></div>
    </section>`;
  doc.documentElement.append(host);
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const spot = $('.spot'); const card = $('.card'); const approx = $('.approx');
  let view: GuideView | null = null;
  let target: Element | null = null;
  let since = 0;
  let scrolled = false;
  let busy = false;
  let alive = true;
  const here = () => { const l = win.location; return l.origin + l.pathname; };
  // Is the browser on this step's page right now? Go to steps need the exact
  // page; other steps allow record ids to differ, and hash routes must match.
  const onStepPage = (step: GuideView['step']) => (step.kind === 'page' ? step.url === here() : samePage(step.url, here())) &&
    (!step.route || step.route === routeToken(win));

  async function act(call: () => Promise<GuideView | null>) {
    if (busy || !alive) return;
    busy = true;
    try { const next = await call(); if (next) show(next); else finish(); }
    catch { /* the worker may be restarting; the next page load re-syncs */ }
    finally { busy = false; }
  }
  function show(next: GuideView) {
    // The previous step's control stops counting as soon as the step changes.
    bind(null); approx.hidden = true;
    view = next; since = Date.now(); scrolled = false;
    $('.count').textContent = `Step ${next.index + 1} of ${next.total}`;
    $('.title').textContent = next.title;
    $('.tips').replaceChildren(...next.step.tips.map(tip => {
      const p = doc.createElement('p'); p.className = tip.kind;
      if (tip.kind !== 'header') { const b = doc.createElement('b'); b.textContent = tip.kind === 'tip' ? 'Tip' : 'Alert'; p.append(b, doc.createTextNode(' ')); }
      p.append(doc.createTextNode(tip.text));
      return p;
    }));
    $('.instruction').replaceChildren(...next.step.segments.map(part => {
      if (!part.bold) return doc.createTextNode(part.text);
      const strong = doc.createElement('strong'); strong.textContent = part.text; return strong;
    }));
    $('.note').textContent = next.step.note ?? '';
    $<HTMLButtonElement>('.back').disabled = next.index === 0;
    $('.next').textContent = next.index === next.total - 1 ? 'Done' : 'Next';
    locate();
    // Re-check right when the search time is up, not at the next poll.
    const shown = next;
    win.setTimeout(() => { if (view === shown) locate(); }, findTimeout + 1);
  }
  function finish() {
    view = null; target = null; spot.hidden = true;
    $('.count').textContent = 'Done'; $('.tips').replaceChildren(); $('.note').textContent = '';
    $('.instruction').textContent = 'All steps done. Nice work.';
    $('.fallback').hidden = true; $('.actions').hidden = true;
    place(null);
    win.setTimeout(destroy, 2500);
  }
  // Finds the target, or explains where the step is after a short search.
  function locate() {
    if (!view || !alive) return;
    const step = view.step;
    if (step.kind === 'page') {
      if (onStepPage(step)) { void act(api.next); return; }
      fallback(`Go to ${step.title || 'the next page'}.`, true);
      return;
    }
    // A full-page screenshot is a reference, not an action.
    if (step.kind === 'full') {
      bind(null); approx.hidden = true;
      fallback('A screenshot of the whole page, for reference. Scroll the page to compare, then choose Next.', !onStepPage(step));
      return;
    }
    // A matching control on another page is not this step.
    if (!onStepPage(step)) {
      bind(null); approx.hidden = true;
      fallback(`This step is on ${step.title || 'another page'}.`, true);
      return;
    }
    const found = step.target ? findTarget(doc, step.target) : null;
    if (found !== target) bind(found);
    if (found) {
      $('.fallback').hidden = true; approx.hidden = true;
      if (!scrolled) {
        scrolled = true;
        const r = found.getBoundingClientRect();
        if (r.bottom < 0 || r.top > win.innerHeight) found.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      }
      return;
    }
    // Guides captured before fingerprints: point at the recorded position.
    if (!step.target) {
      fallback('Approximate position from the capture. Compare with the screenshot, then choose Next.', false);
      const p = step.position;
      approx.hidden = !p || !(p.width > 0 && p.height > 0);
      if (p && !approx.hidden) Object.assign(approx.style, { left: `${p.x / p.width * win.innerWidth - 22}px`, top: `${p.y / p.height * win.innerHeight - 22}px` });
      return;
    }
    if (Date.now() - since >= findTimeout) fallback('Can’t find this on the page. Follow the screenshot, then choose Next.', false);
  }
  function fallback(text: string, offerPage: boolean) {
    spot.hidden = true;
    $('.fallback').hidden = false;
    $('.fallback-text').textContent = text;
    const img = $<HTMLImageElement>('.fallback img');
    if (view?.step.screenshot) { img.src = view.step.screenshot; img.hidden = false; } else img.hidden = true;
    const link = $<HTMLAnchorElement>('.open-page');
    link.hidden = !offerPage || !view;
    if (view) link.href = view.step.url;
    // A hash route is stored only as a token, so the link reaches the app, not the section.
    const section = !!view?.step.route && view.step.route !== noRoute;
    link.textContent = section ? 'Open the app' : 'Open page';
    if (section && offerPage) $('.fallback-text').textContent += ` Then go to ${view!.step.title || 'that section'} in the app.`;
    place(null);
  }
  // Watches the target: a click (or finishing a field) completes the step.
  let unbind = () => {};
  function bind(el: Element | null) {
    unbind();
    target = el;
    if (!el) { unbind = () => {}; return; }
    const typing = view?.step.kind === 'type';
    // Checked at the moment of the event: the app may have changed page since the last poll.
    const inside = (event: Event) => trusted(event) && el.contains(event.target as Node) && !!view && onStepPage(view.step);
    // Text steps finish where capture finishes an entry: change, Enter
    // (not mid-composition), or leaving the field after typing.
    let typed = false;
    const onClick = (event: Event) => { if (!typing && inside(event)) void act(api.next); };
    const onChange = (event: Event) => { if (typing && inside(event)) void act(api.next); };
    const onInput = (event: Event) => { if (typing && inside(event)) typed = true; };
    const onLeave = (event: Event) => { if (typing && typed && inside(event)) void act(api.next); };
    const onKey = (event: KeyboardEvent) => { if (typing && inside(event) && event.key === 'Enter' && !event.isComposing && !event.shiftKey) void act(api.next); };
    const listeners: [string, EventListener][] = [['click', onClick], ['change', onChange], ['input', onInput], ['focusout', onLeave], ['keydown', onKey as EventListener]];
    for (const [type, listener] of listeners) doc.addEventListener(type, listener, true);
    unbind = () => { for (const [type, listener] of listeners) doc.removeEventListener(type, listener, true); };
    position();
  }
  function position() {
    if (!target || !alive) return;
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.hidden = false;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    place(r);
  }
  // The card sits below the target, above it when there is no room, or in
  // the corner when there is no target.
  function place(r: DOMRect | null) {
    const w = card.offsetWidth || 340, h = card.offsetHeight || 180, gap = 14, edge = 12;
    let left = win.innerWidth - w - 20, top = win.innerHeight - h - 20;
    if (r) {
      left = Math.min(win.innerWidth - w - edge, Math.max(edge, r.left));
      top = r.bottom + gap + h < win.innerHeight ? r.bottom + gap : Math.max(edge, r.top - gap - h);
    }
    Object.assign(card.style, { left: `${Math.max(edge, left)}px`, top: `${Math.max(edge, top)}px` });
  }
  const onClickCard = (handler: () => void) => (event: Event) => { if (trusted(event)) handler(); };
  $('.next').addEventListener('click', onClickCard(() => void act(api.next)));
  $('.back').addEventListener('click', onClickCard(() => void act(api.back)));
  $('.exit').addEventListener('click', onClickCard(() => { void api.exit().catch(() => {}); destroy(); }));
  const reposition = () => position();
  win.addEventListener('scroll', reposition, true);
  win.addEventListener('resize', reposition);
  // Pages render late and change: keep looking and following the target.
  const timer = win.setInterval(() => { if (view) locate(); if (target) position(); }, 400);
  function destroy() {
    if (!alive) return;
    alive = false;
    unbind(); win.clearInterval(timer);
    win.removeEventListener('scroll', reposition, true); win.removeEventListener('resize', reposition);
    host.remove();
  }
  const ready = api.state().then(initial => { if (initial) show(initial); else destroy(); }, () => destroy());
  return { root, ready, destroy };
}
