// Finds private details visible in the viewport so screenshots can be
// blurred before they are saved. Runs in the page's content script.
import { sensitiveField } from './fields.ts';
import type { Rect, Regions } from './redact.ts';

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
const rules: { pattern: RegExp; accept?: (match: string) => boolean }[] = [
  { pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { pattern: /\b(?:\d[ -]?){12,18}\d\b/g, accept: m => luhn(m.replace(/\D/g, '')) },
  // Not inside a longer digit run, such as a card number that failed Luhn.
  { pattern: /(?<!\d[ .-]?)(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\b\d{2,4}[ .-])\d{3,4}[ .-]?\d{3,4}\b(?![ .-]?\d)/g, accept: m => m.replace(/\D/g, '').length >= 10 },
];
// [start, end) ranges of private details in text, without overlaps.
export function sensitiveMatches(text: string): [number, number][] {
  const found: [number, number][] = [];
  for (const { pattern, accept } of rules) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!, end = start + match[0].length;
      if (accept && !accept(match[0])) continue;
      if (found.some(([s, e]) => start < e && end > s)) continue;
      found.push([start, end]);
    }
  }
  return found.sort((a, b) => a[0] - b[0]);
}

type Measure = (target: Element | Range) => ArrayLike<DOMRect>;
export interface Scanner {
  measure?: Measure;
  // Content scripts can open closed shadow roots through chrome.dom.
  shadowRoot?: (element: Element) => ShadowRoot | null;
  // A frame's document when it is same-origin and loaded, otherwise null.
  frameDocument?: (frame: HTMLIFrameElement | HTMLFrameElement) => Document | null;
  // How much larger the frame is drawn than its layout size, or null when it
  // is rotated or skewed and its content cannot be mapped with a box.
  frameScale?: (frame: HTMLIFrameElement | HTMLFrameElement, box: DOMRect) => { x: number; y: number } | null;
}
const defaultMeasure: Measure = target => 'getBoundingClientRect' in target && !('getClientRects' in target && target instanceof Range) && (target as Element).nodeType === 1
  ? [(target as Element).getBoundingClientRect()] : (target as Range).getClientRects();
const defaultShadowRoot = (element: Element): ShadowRoot | null => {
  const dom = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } } }).chrome?.dom;
  try { return dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot; } catch { return element.shadowRoot; }
};
const defaultFrameDocument = (frame: HTMLIFrameElement | HTMLFrameElement): Document | null => {
  try { const doc = frame.contentDocument; return doc?.body || doc?.documentElement ? doc : null; } catch { return null; }
};
// Computed transform styles of one element. Content can be mapped through it
// with a box only for a positive, axis-aligned scale plus movement. Rotation,
// skew, mirroring, 3D and motion paths all mean whole-frame blur.
export interface TransformStyle { transform: string; rotate: string; scale: string; offsetPath: string }
export function mappableTransform(style: TransformStyle): boolean {
  const transform = style.transform.trim();
  if (transform && transform !== 'none') {
    const match = transform.match(/^matrix\(([^)]*)\)$/);
    if (!match) return false; // matrix3d or anything unexpected
    const [m11, m12, m21, m22] = match[1].split(',').map(Number);
    if (![m11, m12, m21, m22].every(Number.isFinite) || m11 <= 0 || m22 <= 0 || Math.abs(m12) > 1e-6 || Math.abs(m21) > 1e-6) return false;
  }
  const rotate = style.rotate.trim();
  if (rotate && rotate !== 'none' && parseFloat(rotate.split(/\s+/).at(-1)!) !== 0) return false;
  const scale = style.scale.trim();
  if (scale && scale !== 'none' && !scale.split(/\s+/).every(part => parseFloat(part) > 0)) return false;
  const offsetPath = style.offsetPath.trim();
  return !offsetPath || offsetPath === 'none';
}
const defaultFrameScale = (frame: HTMLIFrameElement | HTMLFrameElement, box: DOMRect): { x: number; y: number } | null => {
  const view = frame.ownerDocument.defaultView;
  // Every transform on the frame and its ancestors must be mappable.
  for (let el: Element | null = frame; el; el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null)) {
    const style = view?.getComputedStyle(el);
    if (style && !mappableTransform({ transform: style.transform ?? '', rotate: style.rotate ?? '', scale: style.scale ?? '', offsetPath: style.offsetPath ?? '' })) return null;
  }
  const width = frame.offsetWidth, height = frame.offsetHeight;
  return width && height ? { x: box.width / width, y: box.height / height } : { x: 1, y: 1 };
};
const maxBoxes = 400, maxTextNodes = 50000, maxDepth = 8;
interface Box { x: number; y: number; width: number; height: number }
interface Map { x: number; y: number; sx: number; sy: number }

// Scans the document, every shadow root and every same-origin frame. A
// visible frame that cannot be read (cross-origin) is reported whole, so its
// content is blurred rather than saved unchecked.
export function findSensitive(win: Window, options: Scanner | Measure = {}): Regions {
  const scanner = typeof options === 'function' ? { measure: options } : options;
  const measure = scanner.measure ?? defaultMeasure;
  const shadowRootOf = scanner.shadowRoot ?? defaultShadowRoot;
  const frameDocumentOf = scanner.frameDocument ?? defaultFrameDocument;
  const frameScaleOf = scanner.frameScale ?? defaultFrameScale;
  const width = win.innerWidth, height = win.innerHeight;
  const boxes: Box[] = [];
  let visited = 0;
  // map takes a frame's own coordinates into the top viewport (origin plus
  // scale); clip is the visible part of that frame in the top viewport.
  const place = (r: { x: number; y: number; width: number; height: number }, map: Map) =>
    ({ x: map.x + r.x * map.sx, y: map.y + r.y * map.sy, width: r.width * map.sx, height: r.height * map.sy });
  const add = (rects: ArrayLike<DOMRect>, map: Map, clip: Box) => {
    for (const rect of Array.from(rects)) {
      if (boxes.length >= maxBoxes || rect.width <= 0 || rect.height <= 0) continue;
      const r = place(rect, map);
      const x1 = Math.max(clip.x, r.x), y1 = Math.max(clip.y, r.y);
      const x2 = Math.min(clip.x + clip.width, r.x + r.width), y2 = Math.min(clip.y + clip.height, r.y + r.height);
      if (x2 > x1 && y2 > y1) boxes.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }
  };
  const scan = (root: Document | ShadowRoot, offset: Map, clip: Box, depth: number) => {
    if (depth > maxDepth || boxes.length >= maxBoxes) return;
    const doc = (root as Document).nodeType === 9 ? root as Document : root.ownerDocument!;
    const view = (doc.defaultView ?? win) as Window & typeof globalThis;
    for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      if (field.matches('input[type="hidden"]')) continue;
      const value = field.value ?? '';
      const contact = field.matches('input[type="email"], input[type="tel"]') && value.trim() !== '';
      if (sensitiveField(field) || contact || (value && sensitiveMatches(value).length)) add(measure(field), offset, clip);
    }
    const start = (root as Document).nodeType === 9 ? (root as Document).body ?? (root as Document).documentElement : root;
    if (start) {
      const walker = doc.createTreeWalker(start, view.NodeFilter.SHOW_TEXT, {
        acceptNode: node => node.parentElement?.closest('script, style, noscript, template, textarea') ? view.NodeFilter.FILTER_REJECT : view.NodeFilter.FILTER_ACCEPT,
      });
      for (let node = walker.nextNode() as Text | null; node && visited < maxTextNodes && boxes.length < maxBoxes; node = walker.nextNode() as Text | null) {
        visited++;
        for (const [from, to] of sensitiveMatches(node.data)) {
          const range = doc.createRange();
          range.setStart(node, from); range.setEnd(node, to);
          add(measure(range), offset, clip);
        }
      }
    }
    for (const element of root.querySelectorAll('*')) {
      const shadow = shadowRootOf(element);
      if (shadow) scan(shadow, offset, clip, depth + 1);
      if (element.matches('iframe, frame')) {
        const frame = element as HTMLIFrameElement;
        const [box] = Array.from(measure(frame));
        if (!box || box.width <= 0 || box.height <= 0) continue;
        const outer = place(box, offset);
        const visible = { x: Math.max(clip.x, outer.x), y: Math.max(clip.y, outer.y), width: 0, height: 0 };
        visible.width = Math.min(clip.x + clip.width, outer.x + outer.width) - visible.x;
        visible.height = Math.min(clip.y + clip.height, outer.y + outer.height) - visible.y;
        if (visible.width <= 0 || visible.height <= 0) continue;
        const content = frameDocumentOf(frame);
        const scale = content ? frameScaleOf(frame, box) : null;
        // Unreadable or unmappable frames are blurred whole.
        if (!content || !scale) { if (boxes.length < maxBoxes) boxes.push(visible); continue; }
        const inner: Map = {
          x: outer.x + (frame.clientLeft || 0) * scale.x * offset.sx, y: outer.y + (frame.clientTop || 0) * scale.y * offset.sy,
          sx: offset.sx * scale.x, sy: offset.sy * scale.y,
        };
        scan(content, inner, visible, depth + 1);
      }
    }
  };
  scan(win.document, { x: 0, y: 0, sx: 1, sy: 1 }, { x: 0, y: 0, width, height }, 0);
  return { width, height, boxes };
}
