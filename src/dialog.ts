// Stepnote's own modal sheets. Styled by dialog.css; text is always set as
// text, never parsed as markup.
export interface DialogAction {
  value: string;
  label: string;
  tone?: 'primary' | 'danger';
  focus?: boolean;
  // Runs synchronously inside the click, while Chrome still sees a user gesture.
  run?: () => void;
}
export interface DialogOptions {
  title: string;
  body: string;
  points?: string[];
  note?: string;
  art?: SVGElement;
  actions: DialogAction[];
}

let sequence = 0;
export function openDialog(doc: Document, options: DialogOptions): Promise<string | null> {
  const opener = doc.activeElement as HTMLElement | null;
  const dialog = doc.createElement('dialog');
  dialog.className = 'sheet';
  const id = `sheet-title-${++sequence}`;
  dialog.setAttribute('aria-labelledby', id);
  const inner = doc.createElement('div'); inner.className = 'sheet-inner';
  if (options.art) inner.append(options.art);
  const title = doc.createElement('h2'); title.id = id; title.textContent = options.title;
  const body = doc.createElement('p'); body.className = 'sheet-body'; body.textContent = options.body;
  inner.append(title, body);
  if (options.points?.length) {
    const list = doc.createElement('ul'); list.className = 'sheet-points';
    for (const point of options.points) { const item = doc.createElement('li'); item.textContent = point; list.append(item); }
    inner.append(list);
  }
  if (options.note) { const note = doc.createElement('p'); note.className = 'sheet-note'; note.textContent = options.note; inner.append(note); }
  const actions = doc.createElement('div'); actions.className = 'sheet-actions';
  inner.append(actions);
  dialog.append(inner);
  return new Promise(resolve => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      dialog.remove();
      if (opener?.isConnected) opener.focus();
      resolve(value);
    };
    for (const action of options.actions) {
      const button = doc.createElement('button');
      button.type = 'button'; button.textContent = action.label; button.dataset.action = action.value;
      if (action.tone) button.classList.add(action.tone);
      button.addEventListener('click', () => { action.run?.(); finish(action.value); });
      actions.append(button);
    }
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    // The dialog element itself is only hit outside .sheet-inner, on the backdrop.
    dialog.addEventListener('click', event => { if (event.target === dialog) finish(null); });
    doc.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    const index = Math.max(0, options.actions.findIndex(action => action.focus));
    // preventScroll: focusing during the entrance animation must not scroll the sheet.
    actions.querySelectorAll('button')[index]?.focus({ preventScroll: true });
  });
}

export async function confirmDelete(doc: Document, { live, steps }: { live: boolean; steps: number }): Promise<boolean> {
  const what = steps === 1 ? 'The 1 step and its screenshot' : `All ${steps} steps and their screenshots`;
  const choice = await openDialog(doc, {
    title: live ? 'Discard this capture?' : 'Delete this recording?',
    body: steps === 0
      ? (live ? 'No steps have been captured yet. Discarding ends this capture.' : 'This recording has no steps. It will be removed from this device.')
      : `${what} will be removed from this device. Export first if you need a copy.`,
    actions: [
      { value: 'confirm', label: live ? 'Discard capture' : 'Delete recording', tone: 'danger' },
      { value: 'cancel', label: live ? 'Keep capturing' : 'Cancel', focus: true },
    ],
  });
  return choice === 'confirm';
}

export function askSiteAccess(doc: Document, request: () => void): Promise<'allow' | 'tab' | null> {
  return openDialog(doc, {
    art: followArt(doc),
    title: 'Keep capturing across tabs',
    body: 'Allow site access so Stepnote can follow you into new tabs, other windows and pages that reload.',
    points: [
      'Records only while a capture is running.',
      'Steps and screenshots stay on this device.',
      'Remove access anytime from the extension’s details page.',
    ],
    note: 'Chrome asks next and calls this “Read and change all your data on all websites.” It is the only access that lets Stepnote take screenshots in tabs you switch to.',
    actions: [
      { value: 'allow', label: 'Allow and start', tone: 'primary', run: request },
      { value: 'tab', label: 'Only this tab' },
    ],
  }) as Promise<'allow' | 'tab' | null>;
}

// A browser window whose active tab and click marker step across three tabs.
function followArt(doc: Document): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'sheet-art'); svg.setAttribute('viewBox', '0 0 240 92'); svg.setAttribute('aria-hidden', 'true');
  const add = (name: string, attributes: Record<string, string>, parent: Element = svg) => {
    const node = doc.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent.append(node); return node;
  };
  [12, 84, 156].forEach((x, index) => add('path', { class: `art-tab art-tab-${index + 1}`, d: `M${x} 30v-14a8 8 0 0 1 8-8h56a8 8 0 0 1 8 8v14` }));
  add('rect', { class: 'art-window', x: '2', y: '29', width: '236', height: '61', rx: '10' });
  for (const [y, width] of [[46, 120], [60, 168], [74, 92]]) add('rect', { class: 'art-line', x: '18', y: String(y), width: String(width), height: '6', rx: '3' });
  const marker = add('g', { class: 'art-marker' });
  add('circle', { class: 'art-ring', cx: '48', cy: '62', r: '11' }, marker);
  add('circle', { class: 'art-dot', cx: '48', cy: '62', r: '8' }, marker);
  return svg;
}
