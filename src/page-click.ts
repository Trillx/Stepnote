import type { Click } from './recorder.ts';
import { fieldControl, fieldName, safeText, sensitiveField } from './fields.ts';
import { fingerprint } from './fingerprint.ts';
import { routeToken } from './route.ts';
export { routeToken } from './route.ts';

export function describeClick(target: Element, event: MouseEvent, win: Window): Click {
  const control = target.closest('button, a, input, textarea, select, [role="button"], [contenteditable]') ?? target;
  const buttonInput = control.matches('input[type="submit"], input[type="button"], input[type="reset"]');
  const isField = !buttonInput && (control.matches('input, textarea, select') || !!control.closest('[contenteditable]:not([contenteditable="false"])'));
  const field = fieldControl(control);
  const name = field ? fieldName(field) : '';
  // Visible text first, then the accessible name an icon-only control carries.
  const visible = safeText(control);
  const accessible = control.getAttribute('aria-label')?.trim() || visible || control.getAttribute('title')?.trim() ||
    control.querySelector('img[alt]')?.getAttribute('alt')?.trim() || (buttonInput ? (control as HTMLInputElement).value.trim() : '');
  const text = !buttonInput && field && sensitiveField(field) ? 'protected field' : isField ? (name ? `the "${name}" field` : 'field') : (accessible || control.tagName.toLowerCase());
  const url = new URL(win.location.href);
  return {
    label: `Click ${text}`.slice(0, 160),
    x: event.clientX, y: event.clientY, width: win.innerWidth, height: win.innerHeight,
    title: win.document.title.slice(0, 200), url: (url.origin + url.pathname).slice(0, 2048),
    target: fingerprint(control, win),
    route: routeToken(win),
  };
}

