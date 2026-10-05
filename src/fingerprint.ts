// Element fingerprints: enough identity to find a clicked control again for
// Guide me, never what was typed into it.
import { fieldName, safeText, sensitiveField } from './fields.ts';

export interface Fingerprint {
  tag: string;
  role?: string;
  name?: string; // accessible name
  text?: string; // short visible text
  id?: string;
  testId?: string;
  attrs?: Partial<Record<(typeof attrNames)[number], string>>;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}
const attrNames = ['name', 'type', 'aria-label', 'title', 'placeholder', 'href'] as const;
const testIds = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
const clean = (value: string | null | undefined, max = 80) => {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
};

function implicitRole(el: Element): string | undefined {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0];
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (tag === 'button' || tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'input' && type === 'checkbox') return 'checkbox';
  if (tag === 'input' && type === 'radio') return 'radio';
  if (tag === 'input' || tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') return 'textbox';
  return undefined;
}
// A short, stable-looking selector: an id if it identifies the element,
// otherwise tag:nth-of-type steps up to the nearest such id or the body.
function selectorPath(el: Element): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== doc.body && node !== doc.documentElement && parts.length < 10; node = node.parentElement) {
    const id = node.id;
    if (id && /^[A-Za-z][\w-]{0,60}$/.test(id) && doc.querySelectorAll(`#${id}`).length === 1) { parts.unshift(`#${id}`); return parts.join(' > '); }
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement ? [...node.parentElement.children].filter(c => c.tagName === node!.tagName) : [];
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
  }
  return ['body', ...parts].join(' > ');
}

const isField = (el: Element) => el.matches('input, textarea, select') || (el as HTMLElement).isContentEditable || el.matches('[contenteditable]:not([contenteditable="false"])');
// Visible text without anything a person typed: field and editable
// descendants are removed before reading.
function visibleText(el: Element): string | undefined {
  if (isField(el)) return undefined;
  return clean(safeText(el));
}
// One accessible-name calculation for capture and for finding the control
// again. Recognized secret fields have no name.
export function accessibleName(el: Element): string | undefined {
  if (isField(el)) return sensitiveField(el) ? undefined : clean(el.getAttribute('aria-label')) ?? clean(fieldName(el));
  return clean(el.getAttribute('aria-label')) ?? visibleText(el) ?? clean(el.getAttribute('title')) ?? clean(el.querySelector('img[alt]')?.getAttribute('alt'));
}

export function fingerprint(el: Element, win: Window): Fingerprint {
  const r = el.getBoundingClientRect();
  // Recognized secret fields (native or editable) keep only tag, type, selector and position.
  const secret = isField(el) && sensitiveField(el);
  if (secret) {
    const type = el.getAttribute('type');
    return { tag: el.tagName.toLowerCase(), selector: selectorPath(el), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, ...(type ? { attrs: { type: type.slice(0, 200) } } : {}) };
  }
  const attrs: Fingerprint['attrs'] = {};
  for (const attr of attrNames) {
    if (secret && attr !== 'type') continue;
    let value = el.getAttribute(attr);
    if (!value) continue;
    if (attr === 'href') { try { const url = new URL(value, win.location.href); value = url.origin === win.location.origin ? url.pathname : url.origin + url.pathname; } catch { continue; } }
    attrs[attr] = value.slice(0, 200);
  }
  const visible = visibleText(el);
  const name = accessibleName(el);
  const testId = testIds.map(a => el.getAttribute(a)).find(Boolean) ?? undefined;
  const fp: Fingerprint = { tag: el.tagName.toLowerCase(), selector: selectorPath(el), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
  const role = implicitRole(el);
  if (role) fp.role = role;
  if (name) fp.name = name;
  if (visible && !secret) fp.text = visible;
  if (el.id && el.id.length <= 100) fp.id = el.id;
  if (testId && testId.length <= 100) fp.testId = testId;
  if (Object.keys(attrs).length) fp.attrs = attrs;
  return fp;
}

const short = (value: unknown, max: number) => value === undefined || typeof value === 'string' && value.length <= max;
export function validFingerprint(value: unknown): value is Fingerprint {
  const f = value as Fingerprint;
  if (!f || typeof f !== 'object' || typeof f.tag !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(f.tag)) return false;
  if (typeof f.selector !== 'string' || !f.selector || f.selector.length > 1000) return false;
  if (!f.rect || ![f.rect.x, f.rect.y, f.rect.width, f.rect.height].every(Number.isFinite)) return false;
  if (!short(f.role, 40) || !short(f.name, 200) || !short(f.text, 200) || !short(f.id, 100) || !short(f.testId, 100)) return false;
  if (f.attrs !== undefined) {
    if (typeof f.attrs !== 'object' || f.attrs === null) return false;
    for (const [key, val] of Object.entries(f.attrs)) if (!(attrNames as readonly string[]).includes(key) || !short(val, 200)) return false;
  }
  return true;
}

// The live element a fingerprint most likely describes, or null. Scores
// candidates on identity (id, test id), structure (selector) and meaning
// (tag, role, name, attributes); position only breaks ties.
const candidates = 'a, button, input, select, textarea, summary, label, [role], [tabindex], [contenteditable], [onclick], img, li, td, th, span, div';
export function findTarget(doc: Document, fp: Fingerprint): Element | null {
  const scored = new Map<Element, number>();
  const add = (el: Element | null | undefined, points: number) => { if (el) scored.set(el, (scored.get(el) ?? 0) + points); };
  if (fp.id) add(doc.getElementById(fp.id), 5);
  if (fp.testId) for (const a of testIds) { try { add(doc.querySelector(`[${a}="${CSS.escape(fp.testId)}"]`), 5); } catch { /* invalid */ } }
  let bySelector: Element | null = null;
  try { const all = doc.querySelectorAll(fp.selector); if (all.length === 1) bySelector = all[0]; } catch { /* invalid selector */ }
  add(bySelector, 2);
  // Recognized secret fields are fingerprinted with only tag, type and
  // selector: a unique selector match of the same kind is enough for them.
  const minimal = !fp.name && !fp.id && !fp.testId && !fp.text;
  if (minimal && bySelector && bySelector.tagName.toLowerCase() === fp.tag && (fp.attrs?.type ?? null) === bySelector.getAttribute('type')) add(bySelector, 2);
  for (const el of doc.querySelectorAll(candidates)) {
    if (el.tagName.toLowerCase() !== fp.tag) continue;
    let points = 0.5;
    const name = accessibleName(el);
    if (fp.name && name === fp.name) points += 4;
    else if (fp.name && name && name.toLowerCase().includes(fp.name.toLowerCase())) points += 1.5;
    if (fp.role && implicitRole(el) === fp.role) points += 1;
    for (const [key, value] of Object.entries(fp.attrs ?? {})) if (key !== 'href' && el.getAttribute(key) === value) points += 1;
    if (fp.attrs?.href && (el.getAttribute('href') ?? '').split(/[?#]/)[0].endsWith(fp.attrs.href)) points += 1.5;
    if (points > 0.5) add(el, points);
  }
  let best: Element | null = null; let bestScore = 0; let bestDistance = Infinity;
  for (const [el, score] of scored) {
    // Elements matching the name or identity outright only.
    if (score < 4) continue;
    const r = el.getBoundingClientRect();
    const distance = Math.hypot(r.x - fp.rect.x, r.y - fp.rect.y);
    if (score > bestScore || score === bestScore && distance < bestDistance) { best = el; bestScore = score; bestDistance = distance; }
  }
  return best;
}
