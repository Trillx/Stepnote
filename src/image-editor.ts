import type { Step } from './recorder.ts';
import type { ShotEdit } from './viewer-ui.ts';
import { pixelate as sharedPixelate } from './redact.ts';

export interface Rect { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }
interface Size { width: number; height: number }
type Geometry = Pick<Step, 'x' | 'y' | 'width' | 'height'>;
const round = (value: number) => Math.round(value * 100) / 100;

// Marker geometry after cropping. Step geometry is in viewport units; crop is
// in image pixels, which differ by the device pixel ratio.
export function cropGeometry(step: Geometry, natural: Size, crop: Rect | null, hidden: boolean): Geometry & { hideMarker: boolean } {
  if (!crop) return { x: step.x, y: step.y, width: step.width, height: step.height, hideMarker: hidden };
  const sx = step.width / natural.width; const sy = step.height / natural.height;
  const mx = step.x / step.width * natural.width; const my = step.y / step.height * natural.height;
  const inside = mx >= crop.x && mx <= crop.x + crop.width && my >= crop.y && my <= crop.y + crop.height;
  const width = round(crop.width * sx); const height = round(crop.height * sy);
  const x = round(Math.min(width, Math.max(0, (mx - crop.x) * sx)));
  const y = round(Math.min(height, Math.max(0, (my - crop.y) * sy)));
  return { x, y, width, height, hideMarker: hidden || !inside };
}
// A dragged rectangle with any direction, clipped to the image, in whole pixels.
export function normalizeRect(rect: Rect, natural: Size): Rect {
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value)));
  const x1 = clamp(Math.min(rect.x, rect.x + rect.width), natural.width), x2 = clamp(Math.max(rect.x, rect.x + rect.width), natural.width);
  const y1 = clamp(Math.min(rect.y, rect.y + rect.height), natural.height), y2 = clamp(Math.max(rect.y, rect.y + rect.height), natural.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
// Zoom: a half-size crop centred on the click (or the image centre), kept inside the image.
export function zoomRect(step: Geometry, natural: Size, hidden: boolean): Rect {
  const width = Math.round(natural.width / 2), height = Math.round(natural.height / 2);
  const cx = hidden ? natural.width / 2 : step.x / step.width * natural.width;
  const cy = hidden ? natural.height / 2 : step.y / step.height * natural.height;
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value)));
  return { x: clamp(cx - width / 2, natural.width - width), y: clamp(cy - height / 2, natural.height - height), width, height };
}
// The two back corners of an arrow head at `to`.
export function arrowHead(from: Point, to: Point, size: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x), spread = 0.45;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}
export { pixelSize } from './redact.ts';
const pixelate = (doc: Document, context: CanvasRenderingContext2D, rect: Rect) => sharedPixelate(context, rect, (w, h) => Object.assign(doc.createElement('canvas'), { width: w, height: h }));

type Tool = 'blur' | 'box' | 'arrow' | 'text' | 'crop';
type Action =
  | { tool: 'blur' | 'box' | 'crop'; rect: Rect }
  | { tool: 'arrow'; from: Point; to: Point }
  | { tool: 'text'; at: Point; text: string };
const ink = '#ff3d8b'; // annotation colour, shared with the click marker
const hints: Record<Tool, string> = {
  blur: 'Drag over anything private to blur it.',
  box: 'Drag to draw a box around something.',
  arrow: 'Drag from where the arrow starts to what it points at.',
  text: 'Type a label, then click where it goes.',
  crop: 'Drag to choose the area to keep.',
};

export async function openImageEditor(doc: Document, step: Step): Promise<ShotEdit | null> {
  const image = new Image();
  image.src = step.screenshot!;
  await image.decode();
  const natural = { width: image.naturalWidth, height: image.naturalHeight };
  const opener = doc.activeElement as HTMLElement | null;
  const dialog = doc.createElement('dialog');
  dialog.className = 'image-editor';
  dialog.setAttribute('aria-labelledby', 'image-editor-title');
  dialog.innerHTML = `<div class="ie-bar">
      <h2 id="image-editor-title">Edit screenshot</h2>
      <div class="ie-tools" role="group" aria-label="Tool">
        <button type="button" data-tool="blur" aria-pressed="true">Blur</button>
        <button type="button" data-tool="box" aria-pressed="false">Box</button>
        <button type="button" data-tool="arrow" aria-pressed="false">Arrow</button>
        <button type="button" data-tool="text" aria-pressed="false">Text</button>
        <button type="button" data-tool="crop" aria-pressed="false">Crop</button>
      </div>
      <button type="button" class="ie-zoom">Zoom to click</button>
      <button type="button" class="ie-undo" disabled>Undo</button>
      <input class="ie-text" type="text" maxlength="80" placeholder="Label text" aria-label="Label text" hidden>
      <p class="ie-hint" aria-live="polite"></p>
    </div>
    <div class="ie-stage"><canvas aria-label="Screenshot. Drag to mark an area."></canvas></div>
    <div class="ie-foot">
      <p class="ie-note">Blur, boxes, arrows and labels are drawn into the saved image. The original pixels are not kept.</p>
      <button type="button" class="ie-cancel">Cancel</button>
      <button type="button" class="ie-apply primary" disabled>Apply</button>
    </div>`;
  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const canvas = $<HTMLCanvasElement>('canvas');
  canvas.width = natural.width; canvas.height = natural.height;
  const context = canvas.getContext('2d')!;
  const label = $<HTMLInputElement>('.ie-text');
  let tool: Tool = 'blur';
  const actions: Action[] = [];
  let draft: Action | null = null;
  const crop = () => {
    for (let i = actions.length - 1; i >= 0; i--) { const a = actions[i]; if (a.tool === 'crop') return a.rect; }
    return null;
  };
  // Annotation sizes follow the image, so they read the same at any resolution.
  const unit = Math.max(2, natural.width / 400);

  function annotate(target: CanvasRenderingContext2D, action: Action) {
    target.save();
    target.strokeStyle = ink; target.fillStyle = ink; target.lineWidth = unit * 1.5; target.lineCap = 'round'; target.lineJoin = 'round';
    if (action.tool === 'box') {
      target.beginPath(); target.roundRect(action.rect.x, action.rect.y, action.rect.width, action.rect.height, unit * 2); target.stroke();
    } else if (action.tool === 'arrow') {
      const [left, right] = arrowHead(action.from, action.to, unit * 7);
      const base = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
      target.beginPath(); target.moveTo(action.from.x, action.from.y); target.lineTo(base.x, base.y); target.stroke();
      target.beginPath(); target.moveTo(action.to.x, action.to.y); target.lineTo(left.x, left.y); target.lineTo(right.x, right.y); target.closePath(); target.fill();
    } else if (action.tool === 'text') {
      const size = Math.max(14, unit * 7);
      target.font = `700 ${size}px "Nunito", "Segoe UI", system-ui, sans-serif`;
      const width = target.measureText(action.text).width, pad = size * 0.45;
      const x = Math.min(natural.width - width - pad * 2, Math.max(0, action.at.x)), y = Math.min(natural.height - size - pad * 2, Math.max(0, action.at.y - size / 2 - pad));
      target.beginPath(); target.roundRect(x, y, width + pad * 2, size + pad * 2, pad); target.fill();
      target.fillStyle = '#ffffff'; target.textBaseline = 'middle'; target.fillText(action.text, x + pad, y + pad + size / 2);
    }
    target.restore();
  }
  // Blur first, then drawings on top; crop is applied last.
  function paint(target: CanvasRenderingContext2D, extra: Action | null = null) {
    target.drawImage(image, 0, 0);
    const all = extra ? [...actions, extra] : actions;
    for (const action of all) if (action.tool === 'blur') pixelate(doc, target, action.rect);
    for (const action of all) annotate(target, action);
  }
  const scale = () => natural.width / Math.max(1, canvas.getBoundingClientRect().width);
  function draw() {
    paint(context, draft && draft.tool !== 'crop' ? draft : null);
    const k = scale();
    if (!step.hideMarker) {
      const mx = step.x / step.width * natural.width, my = step.y / step.height * natural.height;
      context.beginPath(); context.arc(mx, my, 11 * k, 0, Math.PI * 2);
      context.fillStyle = 'rgba(255, 61, 139, .45)'; context.fill();
      context.lineWidth = 3 * k; context.strokeStyle = '#ffffff'; context.stroke();
    }
    const area = draft?.tool === 'crop' ? draft.rect : crop();
    if (area) {
      context.save();
      context.fillStyle = 'rgba(6, 9, 13, .62)';
      context.beginPath(); context.rect(0, 0, natural.width, natural.height);
      context.rect(area.x, area.y, area.width, area.height);
      context.fill('evenodd');
      context.lineWidth = 2 * k; context.strokeStyle = '#ffffff'; context.setLineDash([8 * k, 6 * k]);
      context.strokeRect(area.x, area.y, area.width, area.height);
      context.restore();
    }
    if (draft?.tool === 'blur') {
      context.save(); context.lineWidth = 2 * k; context.strokeStyle = '#7aa2ff'; context.setLineDash([8 * k, 6 * k]);
      context.strokeRect(draft.rect.x, draft.rect.y, draft.rect.width, draft.rect.height); context.restore();
    }
    $<HTMLButtonElement>('.ie-undo').disabled = !actions.length;
    $<HTMLButtonElement>('.ie-apply').disabled = !actions.length;
    $('.ie-hint').textContent = hints[tool];
    label.hidden = tool !== 'text';
  }
  // Image pixels under the pointer, clamped, so drags may start or end
  // anywhere on the stage, including the image's rounded corners.
  const point = (event: PointerEvent): Point => {
    const box = canvas.getBoundingClientRect();
    const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
    return { x: clamp((event.clientX - box.left) / box.width * natural.width, natural.width), y: clamp((event.clientY - box.top) / box.height * natural.height, natural.height) };
  };
  let start: Point | null = null;
  const stage = $<HTMLElement>('.ie-stage');
  stage.addEventListener('pointerdown', event => {
    event.preventDefault();
    if (tool === 'text') {
      const text = label.value.trim();
      if (!text) { label.focus(); return; }
      actions.push({ tool: 'text', at: point(event), text }); draw(); return;
    }
    start = point(event); stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!start) return;
    const p = point(event);
    draft = tool === 'arrow' ? { tool, from: start, to: p }
      : { tool: tool as 'blur' | 'box' | 'crop', rect: normalizeRect({ x: start.x, y: start.y, width: p.x - start.x, height: p.y - start.y }, natural) };
    draw();
  });
  const end = () => {
    const big = draft && (draft.tool === 'arrow' ? Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) >= 12
      : draft.tool !== 'text' && draft.rect.width >= 8 && draft.rect.height >= 8);
    if (draft && big) actions.push(draft);
    start = null; draft = null; draw();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', () => { start = null; draft = null; draw(); });
  for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-tool]')) button.addEventListener('click', () => {
    tool = button.dataset.tool as Tool;
    for (const other of dialog.querySelectorAll('[data-tool]')) other.setAttribute('aria-pressed', String(other === button));
    draw();
    if (tool === 'text') label.focus();
  });
  $('.ie-zoom').addEventListener('click', () => { actions.push({ tool: 'crop', rect: zoomRect(step, natural, !!step.hideMarker) }); draw(); });
  $('.ie-undo').addEventListener('click', () => { actions.pop(); draw(); });

  doc.body.append(dialog);
  dialog.showModal();
  draw();
  $<HTMLButtonElement>('[data-tool="blur"]').focus();
  return new Promise(resolve => {
    const finish = (value: ShotEdit | null) => { dialog.close(); dialog.remove(); if (opener?.isConnected) opener.focus(); resolve(value); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    $('.ie-cancel').addEventListener('click', () => finish(null));
    $('.ie-apply').addEventListener('click', () => {
      const full = doc.createElement('canvas');
      full.width = natural.width; full.height = natural.height;
      paint(full.getContext('2d')!);
      const area = crop();
      let output = full;
      if (area) {
        output = doc.createElement('canvas');
        output.width = area.width; output.height = area.height;
        output.getContext('2d')!.drawImage(full, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
      }
      const geometry = cropGeometry(step, natural, area, !!step.hideMarker);
      finish({ screenshot: output.toDataURL('image/jpeg', 0.85), ...geometry });
    });
  });
}
