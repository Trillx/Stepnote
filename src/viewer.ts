import { mountViewer } from './viewer-ui.ts';
import { guideUrl, listGuides, saveFile, send, subscribe, subscribeGuides } from './client.ts';
import { bindGuide } from './guide-client.ts';
import { mountLibrary } from './library-ui.ts';
import { confirmDelete } from './dialog.ts';
import { openImageEditor } from './image-editor.ts';
import { buildDocx, type DocxImage } from './docx.ts';
import { guideTitle, validImage } from './sop.ts';
import { isStep, type Recording, type Step } from './recorder.ts';

const fileName = (recording: Recording, extension: string) =>
  `${guideTitle(recording).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Stepnote guide'}.${extension}`;

// Word cannot overlay the marker, so draw it into the screenshot.
async function markedJpeg(step: Step, style?: 'box'): Promise<DocxImage> {
  const image = new Image(); image.src = step.screenshot!; await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  if (!step.hideMarker) {
    const r = Math.max(12, canvas.width / 70);
    const x = step.x / step.width * canvas.width, y = step.y / step.height * canvas.height;
    if (style === 'box') {
      context.beginPath(); context.roundRect(x - r * 1.8, y - r * 1.3, r * 3.6, r * 2.6, r / 2);
      context.fillStyle = 'rgba(255, 61, 139, .16)'; context.fill();
      context.lineWidth = r / 4; context.strokeStyle = '#ff3d8b'; context.stroke();
    } else {
    context.beginPath(); context.arc(x, y, r, 0, Math.PI * 2);
    context.fillStyle = 'rgba(255, 61, 139, .45)'; context.fill();
    context.lineWidth = r / 4; context.strokeStyle = '#ffffff'; context.stroke();
    context.beginPath(); context.arc(x, y, r + r / 4, 0, Math.PI * 2);
    context.lineWidth = r / 5; context.strokeStyle = '#ff3d8b'; context.stroke();
    }
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Image encoding failed.')), 'image/jpeg', 0.88));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}

const app = document.querySelector<HTMLElement>('#app')!;
const guideId = new URLSearchParams(location.search).get('guide');
if (!guideId) {
  // No guide named: show the library.
  app.innerHTML = '<header class="toolbar"><div class="toolbar-inner"><p class="eyebrow">Stepnote</p></div></header><div class="library-page"></div>';
  document.title = 'Stepnote guides';
  void mountLibrary(app.querySelector<HTMLElement>('.library-page')!, { list: listGuides, faviconFor: host => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(`https://${host}`)}&size=32`), open: id => { location.href = guideUrl(id); }, subscribe: listener => { subscribeGuides(listener); } });
} else {
  const bound = bindGuide(send, subscribe, guideId);
  void mountEditor(bound.send, bound.subscribe, guideId);
}

function mountEditor(send: ReturnType<typeof bindGuide>['send'], subscribe: ReturnType<typeof bindGuide>['subscribe'], guideId: string) { return mountViewer(app, {
  send, subscribe,
  openLibrary: () => { location.href = guideUrl(); },
  download: html => saveFile(new Blob([html], { type: 'text/html;charset=utf-8' }), 'recorded-procedure.html'),
  confirmDelete: summary => confirmDelete(document, summary),
  printPdf: () => { window.open(chrome.runtime.getURL(`print.html?guide=${encodeURIComponent(guideId)}`), '_blank'); },
  exportWord: async recording => {
    const images = new Map<string, DocxImage>();
    for (const step of recording.steps.filter(isStep)) if (step.id && validImage(step)) images.set(step.id, await markedJpeg(step, recording.markerStyle));
    const bytes = buildDocx(recording, images);
    saveFile(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), fileName(recording, 'docx'));
  },
  editImage: step => openImageEditor(document, step),
}); }
