import { isStep, type Entry, type Recording, type Step } from './recorder.ts';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
const paragraphs = (value: string) => value.split(/\n{1,}/).filter(line => line.trim()).map(line => `<p>${escape(line)}</p>`).join('');
export const guideTitle = (recording: Recording) => recording.guideTitle || recording.title || 'Recorded procedure';
export const stepText = (step: Step) => step.text ?? step.label;
export interface Segment { text: string; bold: boolean }
// Instruction text in plain and bold parts. Edited text marks bold with
// **double asterisks**; recorded labels put the control name in bold.
export function emphasis(step: Step): Segment[] {
  if (step.text !== undefined) {
    const parts = step.text.split(/\*\*(.+?)\*\*/g);
    return parts.map((text, index) => ({ text, bold: index % 2 === 1 })).filter(part => part.text);
  }
  const label = step.label;
  const named = label.match(/^(Click the |Clear the )"(.+)"( field)$/);
  if (named) return [{ text: named[1], bold: false }, { text: named[2], bold: true }, { text: named[3], bold: false }];
  const typed = label.match(/^(Type )(".*")$/s);
  if (typed) return [{ text: typed[1], bold: false }, { text: typed[2], bold: true }];
  const action = label.match(/^(Click |Go to )(.+)$/s);
  if (action && !/^(protected field|field)$/.test(action[2])) return [{ text: action[1], bold: false }, { text: action[2], bold: true }];
  return [{ text: label, bold: false }];
}
const richText = (step: Step) => emphasis(step).map(part => part.bold ? `<strong>${escape(part.text)}</strong>` : escape(part.text)).join('');
export const validImage =(step: Step) => !!step.screenshot && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(step.screenshot);
// Entries that appear in a shared guide: every step, and blocks with text.
export const visibleEntries = (recording: Recording): Entry[] => recording.steps.filter(entry => isStep(entry) || entry.text.trim());
export function guideMeta(recording: Recording): string {
  const count = recording.steps.filter(isStep).length;
  let host = recording.url;
  try { host = new URL(recording.url).host; } catch { /* keep the raw URL */ }
  const date = new Date(recording.startedAt).toLocaleDateString('en', { dateStyle: 'long' });
  return `${count} ${count === 1 ? 'step' : 'steps'}. Captured on ${host}, ${date}.`;
}

export const sopStyles = `
*{box-sizing:border-box}
body{margin:0;background:#f5f7f8;color:#202b33;font:16px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif}
main{max-width:800px;margin:0 auto;padding:48px 24px 64px}
h1,h2,p{overflow-wrap:anywhere}
.brand{margin:0 0 18px;color:#12675e;font-weight:800;font-size:14px;letter-spacing:-.2px}
h1{margin:0 0 10px;font-size:34px;line-height:1.15;letter-spacing:-.8px;font-weight:800}
.description{color:#3d4b55;font-size:17px}.description p{margin:0 0 8px}
.guide-meta{margin:14px 0 0;color:#5d6b75;font-size:14px}
.guide{list-style:none;margin:36px 0 0;padding:0}
.entry{margin:0 0 20px}
.step{padding:22px;background:#fff;border:1px solid #dde4e8;border-radius:16px}
.step-head{display:flex;gap:14px;align-items:flex-start}
.step-number{flex:0 0 auto;min-width:32px;height:32px;padding:0 6px;display:grid;place-items:center;border-radius:11px;background:#e9f3f1;color:#12675e;font-weight:800;font-size:15px;line-height:1}
.step h2{margin:3px 0 0;font-size:18px;line-height:1.4;font-weight:500}.step h2 strong{font-weight:800}
.note{margin:6px 0 0;color:#4d5c66;font-size:15px}
.shot{position:relative;width:fit-content;max-width:100%;margin:18px auto 0;line-height:0}
.shot img{display:block;max-width:100%;height:auto;border:1px solid #e3e8eb;border-radius:10px}
.marker{position:absolute;width:26px;height:26px;border:3px solid #fff;border-radius:50%;background:#ff3d8b73;box-shadow:0 0 0 2.5px #ff3d8b;transform:translate(-50%,-50%)}
.marker.box{width:46px;height:34px;border-radius:8px;background:#ff3d8b29}
.missing{margin:14px 0 0;color:#5d6b75;font-size:14px}
.section{margin:40px 0 16px}.section h2{margin:0;font-size:24px;line-height:1.25;letter-spacing:-.4px;font-weight:800}
.tip,.alert{padding:14px 18px;border-radius:12px;font-size:15px}
.tip{background:#e9f3f1;color:#174f48}.alert{background:#fff3d6;color:#5e4413}
.tip p,.alert p{margin:0}.tip strong,.alert strong{margin-right:6px}
@media print{
  @page{margin:16mm 14mm}
  body{background:#fff;font-size:11pt}
  main{max-width:none;padding:0}
  .step{border:0;padding:0 0 4mm;border-radius:0;break-inside:avoid}
  .shot img{max-height:120mm;width:auto}
  .step.full{break-inside:auto}.step.full .shot img{max-height:none;width:100%}
  .section{break-after:avoid}
  .tip,.alert{break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .step-number,.marker{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}`;

export function sopBody(recording: Recording): string {
  let number = 0;
  const entries = visibleEntries(recording).map(entry => {
    if (!isStep(entry)) {
      if (entry.kind === 'header') return `<li class="entry section"><h2>${escape(entry.text.trim())}</h2></li>`;
      return `<li class="entry ${entry.kind}"><p><strong>${entry.kind === 'tip' ? 'Tip' : 'Alert'}</strong>${escape(entry.text.trim())}</p></li>`;
    }
    const step = entry;
    number++;
    const x = Math.min(100, Math.max(0, step.x / step.width * 100));
    const y = Math.min(100, Math.max(0, step.y / step.height * 100));
    const position = step.kind === 'type' ? 'Input position' : 'Click position';
    const marker = step.hideMarker ? '' : `<span class="marker${recording.markerStyle === 'box' ? ' box' : ''}" role="img" aria-label="${position}" style="left:${x}%;top:${y}%"></span>`;
    const media = validImage(step)
      ? `<div class="shot"><img alt="Screenshot for step ${number}" src="${step.screenshot}">${marker}</div>`
      : `<p class="missing">${escape(step.reason ?? 'No screenshot for this step.')}</p>`;
    return `<li class="entry step${step.kind === 'full' ? ' full' : ''}"><div class="step-head"><span class="step-number">${number}</span><div><h2>${richText(step)}</h2>${step.note ? `<p class="note">${escape(step.note)}</p>` : ''}</div></div>${media}</li>`;
  }).join('');
  return `<p class="brand">Stepnote</p><h1>${escape(guideTitle(recording))}</h1>
    ${recording.description ? `<div class="description">${paragraphs(recording.description)}</div>` : ''}
    <p class="guide-meta">${escape(guideMeta(recording))}</p>
    <ol class="guide">${entries}</ol>`;
}
export function exportHtml(recording: Recording): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${escape(guideTitle(recording))}</title><style>${sopStyles}</style></head><body><main>${sopBody(recording)}</main></body></html>`;
}
