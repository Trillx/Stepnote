import { isStep, type BlockKind, type Entry, type Recording, type State, type Step } from './recorder.ts';
import { exportHtml } from './sop.ts';

export interface ShotEdit { screenshot: string; x: number; y: number; width: number; height: number; hideMarker: boolean }
export interface ViewerApi {
  send(message: { type: string } & Record<string, unknown>): Promise<State>;
  subscribe?(listener: (state: State) => void): () => void;
  download(html: string): void;
  confirmDelete(summary: { live: boolean; steps: number }): boolean | Promise<boolean>;
  printPdf?(): void;
  exportWord?(recording: Recording): void | Promise<void>;
  editImage?(step: Step): Promise<ShotEdit | null>;
  // Shows an "All guides" control that returns to the library.
  openLibrary?(): void;
  // Autosave pause in milliseconds.
  saveDelay?: number;
}
type Message = { type: string } & Record<string, unknown>;

const icons = {
  grip: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="3.5" r="1.3"/><circle cx="10.5" cy="3.5" r="1.3"/><circle cx="5.5" cy="8" r="1.3"/><circle cx="10.5" cy="8" r="1.3"/><circle cx="5.5" cy="12.5" r="1.3"/><circle cx="10.5" cy="12.5" r="1.3"/></svg>',
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4 7l4-3.5L12 7"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M4 9l4 3.5L12 9"/></svg>',
  image: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5v10.5h10.5M1.5 4H12v10.5"/></svg>',
  reset: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3"/></svg>',
  remove: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
};
const blockCopy: Record<BlockKind, { label: string; placeholder: string }> = {
  header: { label: 'Header', placeholder: 'Section title' },
  tip: { label: 'Tip', placeholder: 'Write a tip' },
  alert: { label: 'Alert', placeholder: 'Write a warning' },
};

export async function mountViewer(root: HTMLElement, api: ViewerApi): Promise<void> {
  const doc = root.ownerDocument;
  const delay = api.saveDelay ?? 600;
  root.innerHTML = `<header class="toolbar"><div class="toolbar-inner">
      <p class="eyebrow">Stepnote</p>
      <button id="all-guides" class="quiet" hidden>All guides</button>
      <p id="status" role="status" aria-live="polite">Loading...</p>
      <p id="save-state" aria-live="polite"></p>
      <div class="toolbar-actions">
        <button id="stop" class="quiet" hidden>Complete capture</button>
        <div class="menu-wrap"><button id="export-toggle" class="primary" aria-haspopup="menu" aria-expanded="false" aria-controls="export-menu" disabled>Export</button>
          <div id="export-menu" class="menu" role="menu" hidden>
            <button role="menuitem" data-export="docx">Word document (.docx)</button>
            <button role="menuitem" data-export="pdf">PDF</button>
            <button role="menuitem" data-export="html">Web page (.html)</button>
          </div></div>
        <button id="delete" class="quiet danger" disabled>Delete</button>
      </div></div></header>
    <p id="error" role="alert"></p>
    <article id="guide" hidden>
      <textarea id="guide-title" rows="1" maxlength="200" aria-label="Guide title" placeholder="Name this guide"></textarea>
      <textarea id="guide-description" rows="1" maxlength="5000" aria-label="Guide description" placeholder="Add a description"></textarea>
      <p id="guide-meta"></p>
      <label class="marker-setting">Click marker <select id="marker-style"><option value="circle">Circle</option><option value="box">Box</option></select></label>
      <p class="privacy">Screenshots can show private information. Blur anything sensitive before you share.</p>
      <div id="entries"></div>
    </article>
    <section id="empty" hidden><h1>No saved guide</h1><p>Open the Stepnote side panel from the toolbar on a web page, then choose Start Capture.</p></section>`;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const entriesBox = $('#entries');
  const exportMenu = $('#export-menu');
  const exportToggle = $<HTMLButtonElement>('#export-toggle');
  if (!api.exportWord) exportMenu.querySelector<HTMLElement>('[data-export="docx"]')!.hidden = true;
  if (api.openLibrary) { $('#all-guides').hidden = false; $('#all-guides').addEventListener('click', () => api.openLibrary!()); }
  if (!api.printPdf) exportMenu.querySelector<HTMLElement>('[data-export="pdf"]')!.hidden = true;

  let state: State = { recording: null };
  const nodes = new Map<string, HTMLElement>();
  const gaps: HTMLElement[] = [];
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; message: Message }>();
  let inflight = 0;
  let failed = false;

  // ---- saving -------------------------------------------------------------
  function showSaveState() {
    const el = $('#save-state');
    el.textContent = pending.size || inflight ? 'Saving…' : failed ? 'Not saved' : el.dataset.touched ? 'Saved' : '';
    el.dataset.state = failed && !pending.size && !inflight ? 'error' : '';
  }
  // Commands still on their way to the worker; export and reorder wait for them.
  const running = new Set<Promise<boolean>>();
  function send(message: Message): Promise<boolean> {
    const work = sendNow(message);
    running.add(work);
    void work.finally(() => running.delete(work));
    return work;
  }
  async function sendNow(message: Message): Promise<boolean> {
    inflight++; $('#save-state').dataset.touched = '1'; showSaveState();
    try {
      render(await api.send(message));
      failed = false; $('#error').textContent = state.error ?? '';
      return true;
    } catch (error) {
      failed = true; $('#error').textContent = String(error).replace(/^Error: /, '');
      return false;
    } finally { inflight--; showSaveState(); }
  }
  function schedule(key: string, message: Message) {
    clearTimeout(pending.get(key)?.timer);
    pending.set(key, { message, timer: setTimeout(() => void flush(key), delay) });
    showSaveState();
  }
  async function flush(key: string) {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(key);
    await send(entry.message);
  }
  // Sends every scheduled edit, then waits for all saves still running.
  async function flushAll() {
    await Promise.all([...pending.keys()].map(flush));
    while (running.size) await Promise.allSettled([...running]);
  }

  // ---- fields -------------------------------------------------------------
  const fieldSizing = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
  const fit = (field: HTMLTextAreaElement) => {
    if (fieldSizing) return;
    field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`;
  };
  // Binds a textarea to a command. singleLine fields commit on Enter.
  function bind(field: HTMLTextAreaElement, key: string, message: (value: string) => Message, singleLine = false) {
    field.dataset.key = key;
    field.addEventListener('input', () => { fit(field); schedule(key, message(field.value)); });
    field.addEventListener('focusout', () => void flush(key));
    if (singleLine) field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); field.blur(); }
    });
  }
  // A live update never overwrites a field being edited or waiting to save.
  function setField(field: HTMLTextAreaElement, value: string) {
    if (doc.activeElement === field || pending.has(field.dataset.key!)) return;
    if (field.value !== value) { field.value = value; fit(field); }
  }
  bind($('#guide-title'), 'guide:title', value => ({ type: 'EDIT_GUIDE', title: value }), true);
  bind($('#guide-description'), 'guide:description', value => ({ type: 'EDIT_GUIDE', description: value }));
  $('#marker-style').addEventListener('change', () => void send({ type: 'EDIT_GUIDE', markerStyle: $<HTMLSelectElement>('#marker-style').value }));

  // ---- entries ------------------------------------------------------------
  function tool(className: string, icon: string, label: string): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button'; button.className = `tool ${className}`; button.innerHTML = icon;
    button.setAttribute('aria-label', label); button.title = label;
    return button;
  }
  function textarea(className: string, placeholder: string): HTMLTextAreaElement {
    const field = doc.createElement('textarea');
    field.className = className; field.rows = 1; field.placeholder = placeholder;
    return field;
  }
  function entryTools(entry: Entry, includeImage: boolean): HTMLElement {
    const tools = doc.createElement('div'); tools.className = 'entry-tools';
    const up = tool('move-up', icons.up, 'Move up');
    const down = tool('move-down', icons.down, 'Move down');
    up.addEventListener('click', () => void move(entry.id!, -1, 'move-up'));
    down.addEventListener('click', () => void move(entry.id!, 1, 'move-down'));
    tools.append(up, down);
    if (includeImage) {
      const image = tool('edit-image', icons.image, 'Blur or crop screenshot');
      image.addEventListener('click', () => void editImage(entry.id!));
      tools.append(image);
    }
    const remove = tool('delete-entry', icons.remove, isStep(entry) ? 'Delete step' : 'Delete block');
    remove.addEventListener('click', () => void send({ type: 'DELETE_STEP', stepId: entry.id! }));
    tools.append(remove);
    return tools;
  }
  // Only the handle is draggable, so text in the fields stays selectable.
  // Chrome does not drag buttons; keyboard users have Move up and Move down.
  function grip(): HTMLElement {
    const handle = doc.createElement('span');
    handle.className = 'tool grip'; handle.innerHTML = icons.grip;
    handle.draggable = true; handle.title = 'Drag to reorder'; handle.setAttribute('aria-hidden', 'true');
    return handle;
  }
  function createStep(step: Step): HTMLElement {
    const id = step.id!;
    const node = doc.createElement('section');
    node.className = 'entry step-card'; node.dataset.kind = 'step'; node.dataset.id = id;
    const head = doc.createElement('div'); head.className = 'entry-head';
    const number = doc.createElement('span'); number.className = 'step-number';
    const fields = doc.createElement('div'); fields.className = 'entry-fields';
    const text = textarea('step-text', 'Describe this step');
    const note = textarea('step-note', 'Add a note');
    bind(text, `step:${id}:text`, value => ({ type: 'EDIT_STEP', stepId: id, text: value }), true);
    bind(note, `step:${id}:note`, value => ({ type: 'EDIT_STEP', stepId: id, note: value }));
    const reset = tool('reset-text', icons.reset, 'Reset to recorded text');
    reset.addEventListener('click', async () => {
      clearTimeout(pending.get(`step:${id}:text`)?.timer); pending.delete(`step:${id}:text`);
      if (await send({ type: 'EDIT_STEP', stepId: id, text: '' })) text.focus();
    });
    const textRow = doc.createElement('div'); textRow.className = 'text-row';
    textRow.append(text, reset);
    fields.append(textRow, note);
    head.append(grip(), number, fields, entryTools(step, true));
    const media = doc.createElement('div'); media.className = 'media';
    node.append(head, media);
    return node;
  }
  function createBlock(entry: Entry & { kind: BlockKind }): HTMLElement {
    const id = entry.id!;
    const node = doc.createElement('section');
    node.className = `entry block block-${entry.kind}`; node.dataset.kind = entry.kind; node.dataset.id = id;
    const head = doc.createElement('div'); head.className = 'entry-head';
    const fields = doc.createElement('div'); fields.className = 'entry-fields';
    if (entry.kind !== 'header') {
      const label = doc.createElement('span'); label.className = 'block-label'; label.textContent = blockCopy[entry.kind].label;
      fields.append(label);
    }
    const text = textarea('block-text', blockCopy[entry.kind].placeholder);
    text.setAttribute('aria-label', blockCopy[entry.kind].label);
    bind(text, `block:${id}`, value => ({ type: 'EDIT_STEP', stepId: id, text: value }), entry.kind === 'header');
    fields.append(text);
    head.append(grip(), fields, entryTools(entry, false));
    node.append(head);
    return node;
  }
  function renderMedia(node: HTMLElement, step: Step, number: number) {
    const media = node.querySelector<HTMLElement>('.media')!;
    const signature = `${state.recording?.markerStyle ?? ''}:${step.blurred ?? 0}:${step.screenshot?.length ?? 0}:${step.screenshot?.slice(-24)}:${step.x}:${step.y}:${step.width}:${step.height}:${step.hideMarker}:${step.reason}`;
    if (media.dataset.signature === signature) return;
    media.dataset.signature = signature;
    media.classList.toggle('tall', step.kind === 'full');
    media.replaceChildren();
    if (step.screenshot && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(step.screenshot)) {
      const shot = doc.createElement('div'); shot.className = 'shot';
      const img = doc.createElement('img'); img.src = step.screenshot; img.alt = `Screenshot for step ${number}`;
      shot.append(img);
      if (!step.hideMarker) {
        const marker = doc.createElement('span'); marker.className = state.recording?.markerStyle === 'box' ? 'marker box' : 'marker'; marker.setAttribute('role', 'img');
        marker.setAttribute('aria-label', step.kind === 'type' ? 'Input position' : 'Click position');
        marker.style.left = `${Math.min(100, Math.max(0, step.x / step.width * 100))}%`;
        marker.style.top = `${Math.min(100, Math.max(0, step.y / step.height * 100))}%`;
        shot.append(marker);
      }
      media.append(shot);
      if (step.blurred) {
        const note = doc.createElement('p'); note.className = 'shot-note';
        note.textContent = `${step.blurred} ${step.blurred === 1 ? 'area' : 'areas'} blurred automatically.`;
        media.append(note);
      }
    } else {
      const missing = doc.createElement('p'); missing.className = 'shot-missing';
      missing.textContent = step.reason ?? 'No screenshot for this step.';
      media.append(missing);
    }
    node.querySelector<HTMLButtonElement>('.edit-image')!.disabled = !media.querySelector('img') || !api.editImage;
  }
  function gap(index: number): HTMLElement {
    let node = gaps[index];
    if (node) return node;
    node = doc.createElement('div'); node.className = 'insert';
    const toggle = tool('insert-toggle', icons.plus, 'Add a header, tip or alert here');
    const menu = doc.createElement('div'); menu.className = 'insert-menu'; menu.hidden = true;
    for (const kind of ['header', 'tip', 'alert'] as BlockKind[]) {
      const choice = doc.createElement('button'); choice.type = 'button'; choice.dataset.kind = kind;
      choice.textContent = blockCopy[kind].label;
      choice.addEventListener('click', () => void insert(gaps.indexOf(node!), kind));
      menu.append(choice);
    }
    toggle.addEventListener('click', () => {
      const open = menu.hidden === true;
      closeMenus(); menu.hidden = !open; node!.classList.toggle('open', open);
      if (open) menu.querySelector('button')!.focus();
    });
    node.append(toggle, menu);
    gaps[index] = node;
    return node;
  }
  function closeMenus() {
    for (const g of gaps) { g.querySelector<HTMLElement>('.insert-menu')!.hidden = true; g.classList.remove('open'); }
    exportMenu.hidden = true; exportToggle.setAttribute('aria-expanded', 'false');
  }

  // ---- render -------------------------------------------------------------
  function render(next: State) {
    if ((next.revision ?? 0) < (state.revision ?? 0)) return;
    state = next;
    const r = state.recording;
    root.dataset.recordingStatus = r?.status ?? 'none';
    $('#guide').hidden = !r;
    $('#empty').hidden = !!r;
    $('#error').textContent = state.error ?? $('#error').textContent ?? '';
    const steps = r?.steps.filter(isStep) ?? [];
    $('#status').textContent = r ? `${r.status === 'recording' ? 'Recording' : r.status === 'paused' ? 'Paused' : 'Complete'}: ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}` : 'No saved guide';
    $('#stop').hidden = !r || r.status === 'stopped';
    exportToggle.disabled = $<HTMLButtonElement>('#delete').disabled = !r;
    if (!r) { for (const node of nodes.values()) node.remove(); nodes.clear(); return; }
    setField($('#guide-title'), r.guideTitle ?? r.title);
    setField($('#guide-description'), r.description ?? '');
    const markerStyle = $<HTMLSelectElement>('#marker-style');
    if (doc.activeElement !== markerStyle) markerStyle.value = r.markerStyle ?? 'circle';
    let host = r.url;
    try { host = new URL(r.url).host; } catch { /* keep the raw URL */ }
    const meta = doc.createTextNode(`Captured on ${host}, ${new Date(r.startedAt).toLocaleDateString(undefined, { dateStyle: 'long' })}.`);
    const icon = $('#guide-meta').querySelector('img');
    if (r.favicon) {
      const img = icon ?? Object.assign(doc.createElement('img'), { className: 'site-icon', alt: '' });
      if (img.getAttribute('src') !== r.favicon) img.src = r.favicon;
      $('#guide-meta').replaceChildren(img, meta);
    } else $('#guide-meta').replaceChildren(meta);
    const order: HTMLElement[] = [];
    const seen = new Set<string>();
    let number = 0;
    r.steps.forEach((entry, index) => {
      const id = entry.id ?? `legacy-${index}`;
      seen.add(id);
      let node = nodes.get(id);
      if (node && node.dataset.kind !== (isStep(entry) ? 'step' : entry.kind)) { node.remove(); node = undefined; }
      if (!node) { node = isStep(entry) ? createStep(entry) : createBlock(entry as Entry & { kind: BlockKind }); nodes.set(id, node); }
      if (isStep(entry)) {
        number++;
        node.querySelector('.step-number')!.textContent = String(number);
        node.setAttribute('aria-label', `Step ${number}`);
        const text = node.querySelector<HTMLTextAreaElement>('.step-text')!;
        setField(text, entry.text ?? entry.label);
        text.setAttribute('aria-label', `Step ${number} instruction`);
        setField(node.querySelector<HTMLTextAreaElement>('.step-note')!, entry.note ?? '');
        node.querySelector<HTMLTextAreaElement>('.step-note')!.setAttribute('aria-label', `Step ${number} note`);
        const reset = node.querySelector<HTMLButtonElement>('.reset-text')!;
        reset.hidden = entry.text === undefined;
        reset.title = `Reset to “${entry.label}”`;
        renderMedia(node, entry, number);
      } else {
        setField(node.querySelector<HTMLTextAreaElement>('.block-text')!, entry.text);
        node.setAttribute('aria-label', blockCopy[entry.kind].label);
      }
      node.querySelector<HTMLButtonElement>('.move-up')!.disabled = index === 0;
      node.querySelector<HTMLButtonElement>('.move-down')!.disabled = index === r.steps.length - 1;
      order.push(gap(index), node);
    });
    order.push(gap(r.steps.length));
    for (const [id, node] of nodes) if (!seen.has(id)) { node.remove(); nodes.delete(id); }
    for (const extra of gaps.splice(r.steps.length + 1)) extra.remove();
    // Move only nodes that are out of place, so focused fields stay focused.
    let cursor = entriesBox.firstElementChild;
    for (const node of order) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      else entriesBox.insertBefore(node, cursor);
    }
  }

  // ---- commands -----------------------------------------------------------
  async function move(id: string, by: number, focusClass: string) {
    const steps = state.recording?.steps ?? [];
    const index = steps.findIndex(entry => entry.id === id);
    if (index < 0 || index + by < 0 || index + by >= steps.length) return;
    await flushAll();
    if (!await send({ type: 'MOVE_STEP', stepId: id, index: index + by })) return;
    const node = nodes.get(id);
    const button = node?.querySelector<HTMLButtonElement>(`.${focusClass}`);
    (button && !button.disabled ? button : node?.querySelector<HTMLButtonElement>('.move-up:not(:disabled), .move-down:not(:disabled)'))?.focus();
  }
  async function insert(index: number, kind: BlockKind) {
    closeMenus();
    const before = new Set(state.recording?.steps.map(entry => entry.id));
    if (!await send({ type: 'INSERT_BLOCK', kind, text: '', index })) return;
    const added = state.recording?.steps.find(entry => !before.has(entry.id));
    if (added) nodes.get(added.id!)?.querySelector<HTMLTextAreaElement>('.block-text')?.focus();
  }
  async function editImage(id: string) {
    const step = state.recording?.steps.find(entry => entry.id === id);
    if (!step || !isStep(step) || !api.editImage) return;
    const result = await api.editImage(structuredClone(step));
    if (result) await send({ type: 'EDIT_SHOT', stepId: id, ...result });
  }

  // ---- drag and drop ------------------------------------------------------
  let dragged: string | undefined;
  entriesBox.addEventListener('dragstart', event => {
    const handle = (event.target as HTMLElement).closest?.('.grip');
    const node = handle?.closest<HTMLElement>('.entry');
    if (!node) return;
    dragged = node.dataset.id;
    node.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', dragged ?? '');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setDragImage?.(node, 24, 24);
    }
  });
  const clearDrop = () => { for (const node of nodes.values()) node.classList.remove('drop-before', 'drop-after'); };
  const dropTarget = (event: DragEvent) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>('.entry');
    if (!node || node.dataset.id === dragged) return undefined;
    const box = node.getBoundingClientRect();
    return { node, after: event.clientY > box.top + box.height / 2 };
  };
  entriesBox.addEventListener('dragover', event => {
    if (!dragged) return;
    event.preventDefault();
    const target = dropTarget(event);
    clearDrop();
    target?.node.classList.add(target.after ? 'drop-after' : 'drop-before');
  });
  entriesBox.addEventListener('drop', event => {
    if (!dragged) return;
    event.preventDefault();
    const target = dropTarget(event);
    const id = dragged;
    clearDrop();
    if (!target) return;
    const ids = (state.recording?.steps ?? []).map(entry => entry.id).filter(other => other !== id);
    const index = ids.indexOf(target.node.dataset.id) + (target.after ? 1 : 0);
    void flushAll().then(() => send({ type: 'MOVE_STEP', stepId: id, index }));
  });
  entriesBox.addEventListener('dragend', () => {
    clearDrop();
    for (const node of nodes.values()) node.classList.remove('dragging');
    dragged = undefined;
  });

  // ---- toolbar ------------------------------------------------------------
  exportToggle.addEventListener('click', () => {
    const open = exportMenu.hidden === true;
    closeMenus(); exportMenu.hidden = !open; exportToggle.setAttribute('aria-expanded', String(open));
    if (open) exportMenu.querySelector<HTMLButtonElement>('button:not([hidden])')?.focus();
  });
  exportMenu.addEventListener('click', async event => {
    const format = (event.target as HTMLElement).closest<HTMLElement>('[data-export]')?.dataset.export;
    if (!format) return;
    closeMenus();
    await flushAll();
    const r = state.recording;
    if (!r) return;
    if (format === 'html') api.download(exportHtml(r));
    if (format === 'pdf') api.printPdf?.();
    if (format === 'docx') {
      try { await api.exportWord?.(r); }
      catch (error) { $('#error').textContent = `Word export failed: ${String(error).replace(/^Error: /, '')}`; }
    }
  });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
  doc.addEventListener('click', event => {
    if (!(event.target as HTMLElement).closest?.('.menu-wrap, .insert')) closeMenus();
  });
  $('#stop').addEventListener('click', async () => { await flushAll(); await send({ type: 'STOP' }); });
  $('#delete').addEventListener('click', async () => {
    const r = state.recording;
    if (!r || !await api.confirmDelete({ live: r.status !== 'stopped', steps: r.steps.filter(isStep).length })) return;
    for (const key of [...pending.keys()]) { clearTimeout(pending.get(key)!.timer); pending.delete(key); }
    await send({ type: 'DELETE' });
  });
  // Save what is typed if the tab closes mid-pause.
  doc.defaultView?.addEventListener('pagehide', () => { for (const { message } of pending.values()) void api.send(message).catch(() => {}); });

  api.subscribe?.(render);
  try { render(await api.send({ type: 'STATUS' })); }
  catch (error) { $('#error').textContent = String(error); }
}
