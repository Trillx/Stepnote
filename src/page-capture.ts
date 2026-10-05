import { describeClick } from './page-click.ts';
import { fieldControl, fieldName, sensitiveField } from './fields.ts';
import type { Click } from './recorder.ts';

export type InputAction = Click & { kind: 'type'; actionId: string; captureId: string; sequence: number; final: boolean };
export type PageAction = { type: 'CLICK'; payload: Click & { captureId: string } } | { type: 'INPUT'; payload: InputAction };

export function installPageCapture(win: Window, publish: (message: PageAction) => void, trusted: (event: Event) => boolean = event => event.isTrusted, captureId = '') {
  const doc = win.document;
  let pending: { field: Element; value: string; at: number; payload: InputAction } | undefined;
  let composing: EventTarget | null = null;
  const lastValues = new WeakMap<Element, string>();
  const outbox = new Map<string, { payload: InputAction; at: number }>();
  function deliver(payload: InputAction, at: number, send = true) {
    outbox.set(payload.actionId, { payload, at });
    if (send) publish({ type: 'INPUT', payload });
  }
  function flush(send = true) {
    if (!pending) return;
    const entry = pending; pending = undefined;
    if (sensitiveField(entry.field)) return;
    deliver({ ...entry.payload, sequence: entry.payload.sequence + 1, final: true }, entry.at, send);
  }
  // Stepnote's own on-page UI (walkthrough card, capture bar) is not the procedure.
  const ours = (target: Element) => !!target.closest('[data-stepnote-ui]');
  function onInput(event: Event) {
    if (!trusted(event) || !(event.target instanceof doc.defaultView!.Element) || ours(event.target)) return;
    if (composing === event.target || (event as InputEvent).isComposing) return;
    const field = fieldControl(event.target);
    if (!field || sensitiveField(field) || field.matches('select') || field.matches('input') && !['text', 'search', 'email', 'url', 'tel'].includes((field as HTMLInputElement).type)) return;
    if (pending && pending.field !== field) flush();
    const value = (field.matches('input,textarea') ? (field as HTMLInputElement).value : field.textContent ?? '').slice(0, 2000);
    if (lastValues.get(field) === value) return;
    lastValues.set(field, value);
    const r = field.getBoundingClientRect();
    const metadata = describeClick(field, { clientX: Math.max(0, Math.min(win.innerWidth, r.x + r.width / 2)), clientY: Math.max(0, Math.min(win.innerHeight, r.y + r.height / 2)) } as MouseEvent, win);
    const name = fieldName(field);
    const payload: InputAction = { ...metadata, kind: 'type', actionId: pending?.payload.actionId ?? crypto.randomUUID(), captureId, sequence: (pending?.payload.sequence ?? 0) + 1, final: false, label: value ? `Type "${value}"` : name ? `Clear the "${name}" field` : 'Clear field' };
    pending = { field, value, at: Date.now(), payload };
    deliver(payload, pending.at);
  }
  function onClick(event: MouseEvent) {
    if (!trusted(event) || !(event.target instanceof doc.defaultView!.Element) || ours(event.target)) return;
    if (pending && fieldControl(event.target) !== pending.field) flush();
    publish({ type: 'CLICK', payload: { ...describeClick(event.target, event, win), captureId } });
  }
  function onBlur(event: Event) {
    if (trusted(event) && event.target === pending?.field && composing !== pending.field) flush();
  }
  function onKey(event: KeyboardEvent) {
    // Enter is only a submission boundary, never a recorded keystroke.
    if (trusted(event) && event.key === 'Enter' && !event.isComposing && !composing && !event.shiftKey && event.target === pending?.field) flush();
  }
  function onComposition(event: CompositionEvent) {
    if (!trusted(event)) return;
    if (event.type === 'compositionstart') composing = event.target;
    else { composing = null; onInput(event); }
  }
  doc.addEventListener('input', onInput, true);
  // Observe clicks before app document handlers consume propagation. Do not
  // cancel or modify the event: the application's own behavior stays intact.
  win.addEventListener('click', onClick, true);
  doc.addEventListener('blur', onBlur, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('compositionstart', onComposition, true);
  doc.addEventListener('compositionend', onComposition, true);
  function cleanup() {
    pending = undefined; composing = null; outbox.clear();
    doc.removeEventListener('input', onInput, true); win.removeEventListener('click', onClick, true);
    doc.removeEventListener('blur', onBlur, true); doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('compositionstart', onComposition, true); doc.removeEventListener('compositionend', onComposition, true);
  }
  return {
    cleanup,
    acknowledge(id: string, sequence?: number) { if (sequence === undefined || outbox.get(id)?.payload.sequence === sequence) outbox.delete(id); },
    finalize(cutoff = Infinity) {
      // Return pending and unacknowledged entries directly. Never await an
      // INPUT reply here: that reply may be waiting for the control queue.
      flush(false); const actions = [...outbox.values()].filter(entry => entry.at <= cutoff).map(entry => entry.payload);
      outbox.clear(); cleanup(); return actions;
    },
  };
}
