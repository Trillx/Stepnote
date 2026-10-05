// Full-page screenshots: plan the scroll positions and where each slice goes
// in the stitched image. All values are CSS pixels of the captured window.
export interface PageMeasure {
  // 'window' when the document scrolls; 'element' for an app's inner panel.
  mode: 'window' | 'element';
  // The scrolling area's visible box in the viewport.
  rect: { x: number; y: number; width: number; height: number };
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  innerWidth: number;
  innerHeight: number;
  // Fill for areas beside an inner panel in the extended image.
  background: string;
}
export interface SlicePlan { positions: number[]; extra: number; truncated: boolean }
export interface DrawOp { slice: number; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number }

// Tall enough for long pages, small enough for Chrome's canvas limits.
export const maxPageHeight = 12000;

export function planSlices(m: PageMeasure): SlicePlan {
  const full = Math.max(0, m.scrollHeight - m.clientHeight);
  const extra = Math.min(full, Math.max(0, maxPageHeight - m.innerHeight));
  const positions: number[] = [];
  for (let top = 0; top < extra; top += m.clientHeight) positions.push(top);
  if (!positions.length || positions.at(-1) !== extra) positions.push(extra);
  return { positions: extra ? positions : [0], extra, truncated: extra < full };
}

// The first slice is drawn down to the bottom of the scrolling area (menus
// and headers once). Each slice then
// contributes its scrolling area at its scroll offset. What sat below the
// scrolling area moves down by the extra height.
export function placements(m: PageMeasure, plan: SlicePlan, tops: number[]): DrawOp[] {
  const r = m.rect;
  const fold = plan.extra > 0 ? r.y + r.height : m.innerHeight;
  const ops: DrawOp[] = [{ slice: 0, sx: 0, sy: 0, sw: m.innerWidth, sh: fold, dx: 0, dy: 0 }];
  tops.forEach((top, slice) => {
    if (slice === 0) return;
    ops.push({ slice, sx: r.x, sy: r.y, sw: r.width, sh: r.height, dx: r.x, dy: r.y + top });
  });
  const below = m.innerHeight - (r.y + r.height);
  if (plan.extra > 0 && below > 0) ops.push({ slice: 0, sx: 0, sy: r.y + r.height, sw: m.innerWidth, sh: below, dx: 0, dy: r.y + r.height + plan.extra });
  return ops;
}

// Page side. The scroller is the window when the document scrolls, otherwise
// the largest visible scrolling panel (apps that scroll an inner area).
const scrolls = (win: Window, el: Element) => el.scrollHeight - el.clientHeight > 1 && /auto|scroll|overlay/.test(win.getComputedStyle(el).overflowY);
export function pickScroller(win: Window): Element | null {
  const doc = win.document, root = doc.scrollingElement ?? doc.documentElement;
  const locked = [doc.documentElement, doc.body].some(el => el && /hidden|clip/.test(win.getComputedStyle(el).overflowY));
  if (!locked && root.scrollHeight - root.clientHeight > 100) return null;
  let best: Element | null = null, bestArea = 0.15 * win.innerWidth * win.innerHeight;
  for (const el of doc.querySelectorAll('body *')) {
    if (el.scrollHeight - el.clientHeight < 2 || el.closest('[data-stepnote-ui]') || !scrolls(win, el)) continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
    if (area > bestArea) { best = el; bestArea = area; }
  }
  return best;
}

function backgroundOf(win: Window): string {
  for (const el of [win.document.body, win.document.documentElement]) {
    const color = el && win.getComputedStyle(el).backgroundColor;
    if (color && !/^(transparent|rgba\(.*,\s*0\))$/.test(color)) return color;
  }
  return '#ffffff';
}

export interface FullPageSession { measure: PageMeasure; scroll(top: number): number; hideFixed(): void; restore(): void }
export function beginFullPage(win: Window): FullPageSession {
  const doc = win.document, root = doc.scrollingElement ?? doc.documentElement;
  const panel = pickScroller(win);
  const target = panel ?? root;
  const original = target.scrollTop;
  let rect = { x: 0, y: 0, width: doc.documentElement.clientWidth || win.innerWidth, height: root.clientHeight || win.innerHeight };
  if (panel) {
    const r = panel.getBoundingClientRect();
    const x = Math.max(0, r.left + panel.clientLeft), y = Math.max(0, r.top + panel.clientTop);
    rect = { x, y, width: Math.min(panel.clientWidth, win.innerWidth - x), height: Math.min(panel.clientHeight, win.innerHeight - y) };
  }
  // Sticky headers sit in their natural place instead of repeating on every slice.
  const changed: [HTMLElement, string, string, string][] = [];
  const set = (el: HTMLElement, prop: string, value: string) => {
    changed.push([el, prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
    el.style.setProperty(prop, value, 'important');
  };
  const floating = [...doc.querySelectorAll<HTMLElement>('body *')].filter(el => !el.closest('[data-stepnote-ui]') && /fixed|sticky/.test(win.getComputedStyle(el).position));
  for (const el of floating) if (win.getComputedStyle(el).position === 'sticky') { set(el, 'position', 'relative'); set(el, 'inset', 'auto'); }
  let hidden = false;
  return {
    measure: { mode: panel ? 'element' : 'window', rect, scrollTop: original, scrollHeight: target.scrollHeight, clientHeight: rect.height, innerWidth: win.innerWidth, innerHeight: win.innerHeight, background: backgroundOf(win) },
    scroll(top) { target.scrollTo({ top, behavior: 'instant' as ScrollBehavior }); return target.scrollTop; },
    // Fixed bars and widgets appear once, in the first slice. A fixed shell
    // that holds the scrolling panel stays.
    hideFixed() {
      if (hidden) return;
      hidden = true;
      for (const el of floating) if (!(panel && el.contains(panel)) && win.getComputedStyle(el).position === 'fixed') set(el, 'opacity', '0');
    },
    restore() {
      for (const [el, prop, value, priority] of changed.reverse()) value ? el.style.setProperty(prop, value, priority) : el.style.removeProperty(prop);
      changed.length = 0;
      target.scrollTo({ top: original, behavior: 'instant' as ScrollBehavior });
    },
  };
}
