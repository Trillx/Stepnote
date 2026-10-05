// route: token of the tab's fragment route, when its address is readable.
export interface Target { tabId: number; windowId: number; url: string; title: string; route?: string }
export interface Click {
  label: string; x: number; y: number; width: number; height: number; url: string; title: string;
  // The clicked control's identity, for finding it again in Guide me.
  target?: Fingerprint;
  // One-way token of the fragment route (hash-routed apps).
  route?: string;
}
export interface Sender { tabId: number; frameId: number; documentId: string }
// text and note are the author's edits; label stays the recorded instruction.
import type { Regions } from './redact.ts';
import { validFingerprint, type Fingerprint } from './fingerprint.ts';
import { tidySteps } from './tidy.ts';
import { noRoute, validRoute } from './route.ts';
// A page is its path plus, in hash-routed apps, its route.
const pageKey = (target: Target) => validRoute(target.route) && target.route !== noRoute ? `${target.url}#${target.route}` : target.url;
export interface Step extends Click { id?: string; kind?: 'type' | 'page' | 'full'; at: number; screenshot?: string; reason?: string; sequence?: number; final?: boolean; text?: string; note?: string; hideMarker?: boolean; blurred?: number }
// Unnumbered guide content placed between steps by the author.
export type BlockKind = 'header' | 'tip' | 'alert';
// Blocks never carry capture fields, so reading one from any entry is safe.
type NoCapture = { [K in Exclude<keyof Step, 'id' | 'kind' | 'text' | 'at'>]?: undefined };
export interface Block extends NoCapture { id: string; kind: BlockKind; text: string; at: number }
export type Entry = Step | Block;
const blockKinds: readonly string[] = ['header', 'tip', 'alert'];
export const isBlock = (entry: Entry): entry is Block => blockKinds.includes(entry.kind as string);
export const isStep = (entry: Entry): entry is Step => !isBlock(entry);
// url and title describe where capture started. tabId, windowId and documentId
// follow the focused tab; an empty documentId means no document is armed.
export interface Recording extends Target {
  // Guide identity across the active slot and the library.
  id?: string;
  documentId: string;
  captureId?: string;
  status: 'recording' | 'paused' | 'stopped';
  stoppedReason?: string;
  notice?: string;
  startedAt: number;
  steps: Entry[];
  guideTitle?: string;
  // Blur private details in screenshots before saving. Default on.
  autoBlur?: boolean;
  // Click marker drawn on screenshots; circle when unset.
  markerStyle?: 'box';
  // Steps removed by "Tidy up steps" when the capture completed.
  tidied?: number;
  // The start page's site icon, as a small image data URL.
  favicon?: string;
  description?: string;
}
export interface State { recording: Recording | null; error?: string; revision?: number }
export interface Port {
  read(): Promise<State | null>;
  write(state: State): Promise<void>;
  target(tabId?: number, windowId?: number): Promise<Target>;
  inject(tabId: number, captureId?: string): Promise<string>;
  current(tabId: number, windowId: number, allowLoading?: boolean): Promise<{ active: boolean; documentId: string }>;
  capture(windowId: number): Promise<string>;
  now(): number;
  notify?(state: State): void;
  finalize?(recording: Recording, cutoff: number): Promise<unknown[]>;
  // Moves a completed guide into the local library.
  archive?(recording: Recording, revision: number): Promise<void>;
  // Automatic blur: private regions in the captured document's viewport, and
  // a screenshot with those regions pixelated.
  sensitive?(recording: Recording): Promise<Regions>;
  redact?(screenshot: string, regions: Regions[]): Promise<string>;
  // Whether to tidy steps when a capture completes (a setting).
  tidy?(): boolean;
  // The browser's icon for a page, as an image data URL.
  favicon?(pageUrl: string): Promise<string>;
  // A scrolled, stitched screenshot of the whole page in the captured tab.
  fullPage?(recording: Recording, options: { blur: boolean }): Promise<{ screenshot: string; width: number; height: number; truncated: boolean }>;
  // Hide and restore Stepnote's on-page controls around a screenshot.
  beforeCapture?(recording: Recording): Promise<void>;
  afterCapture?(recording: Recording): Promise<void>;
}
function validClick(value: unknown, maxLabel = 160): value is Click {
  if (!value || typeof value !== 'object') return false;
  const p = value as Click;
  try { new URL(p.url); } catch { return false; }
  return typeof p.label === 'string' && p.label.length > 0 && p.label.length <= maxLabel &&
    typeof p.title === 'string' && p.title.length <= 200 &&
    typeof p.url === 'string' && p.url.length <= 2048 && /^https?:\/\//.test(p.url) &&
    [p.x, p.y, p.width, p.height].every(Number.isFinite) &&
    p.width > 0 && p.width <= 20000 && p.height > 0 && p.height <= 20000 &&
    p.x >= 0 && p.x <= p.width && p.y >= 0 && p.y <= p.height;
}
export class Recorder {
  private port: Port;
  private state: State = { recording: null };
  private ready: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private pauseSequence = 0;
  private admittedInputs = new Map<string, { step: Step; sequence: number; final: boolean }>();
  private deletedInputs = new Set<string>();
  private inputSave: Promise<void> | undefined;
  private inputVersion = 0;
  private inputPublish: ReturnType<typeof setTimeout> | undefined;
  private revision = Date.now();
  private enqueue<T = void>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  // Commands naming a guide act only if it is still the active one, checked
  // inside the queue: a Start queued meanwhile may have filed it. false means
  // the caller should use the library copy instead.
  private isActive(guideId: unknown): boolean {
    return guideId === undefined || (!!this.state.recording && this.state.recording.id === guideId);
  }

  start(tabId?: number, windowId?: number, options: { autoBlur?: boolean } = {}): Promise<void> { return this.enqueue(() => this.startNow(tabId, windowId, options)); }
  click(payload: unknown, sender: Sender): Promise<void> {
    const recording = this.state.recording;
    if (!recording || recording.status !== 'recording' || !validClick(payload) ||
        sender.tabId !== recording.tabId || sender.frameId !== 0 || sender.documentId !== recording.documentId) return Promise.resolve();
    const captureId = (payload as Click & { captureId?: unknown }).captureId;
    if (captureId !== undefined && captureId !== recording.captureId) return Promise.resolve();
    // Admit the click before queueing so navigation cannot erase received steps.
    const step: Step = {
      label: payload.label, title: payload.title, url: payload.url,
      x: payload.x, y: payload.y, width: payload.width, height: payload.height,
      at: this.port.now(), id: crypto.randomUUID(),
    };
    if (validFingerprint(payload.target)) step.target = payload.target;
    if (validRoute(payload.route)) step.route = payload.route;
    recording.steps.push(step);
    return this.enqueue(() => this.clickNow(step, recording));
  }
  input(payload: unknown, sender: Sender): Promise<void> {
    const r = this.state.recording;
    if (!r || r.status !== 'recording' || sender.tabId !== r.tabId || sender.frameId !== 0 || sender.documentId !== r.documentId) return Promise.resolve();
    const step = this.inputStep(payload);
    if (!step) return Promise.resolve();
    this.inputVersion++;
    if (step.final) return this.enqueue(() => this.clickNow(step, r, true));
    // Coalesce persistence even while a screenshot holds the control queue.
    if (!this.inputSave) {
      this.publish();
      this.inputSave = this.enqueue(async () => {
        let version: number;
        do {
          await new Promise(resolve => setTimeout(resolve, 40));
          version = this.inputVersion;
          if (this.state.recording !== r) return;
          await this.save();
        } while (version !== this.inputVersion);
      }).finally(() => { this.inputSave = undefined; });
    } else if (!this.inputPublish) {
      this.inputPublish = setTimeout(() => {
        this.inputPublish = undefined;
        if (this.state.recording === r) this.publish();
      }, 40);
    }
    return this.inputSave;
  }
  private inputStep(payload: unknown): Step | undefined {
    const p = payload as Click & { kind?: unknown; actionId?: unknown; captureId?: unknown; sequence?: unknown; final?: unknown };
    if (!validClick(payload, 2200) || p.kind !== 'type' || !/^(Type "[\s\S]{1,2000}"|Clear (field|the "[^\r\n]{1,120}" field))$/.test(p.label) ||
        typeof p.actionId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(p.actionId) ||
        !this.state.recording?.captureId || p.captureId !== this.state.recording.captureId ||
        !Number.isSafeInteger(p.sequence) || (p.sequence as number) < 1 || typeof p.final !== 'boolean' ||
        this.deletedInputs.has(p.actionId)) return;
    const previous = this.admittedInputs.get(p.actionId);
    if (previous && (previous.final || (p.sequence as number) <= previous.sequence)) return;
    const step: Step = previous?.step ?? { label: '', title: '', url: '', x: 0, y: 0, width: 1, height: 1, kind: 'type', id: p.actionId, at: this.port.now() };
    Object.assign(step, { label: p.label, title: p.title, url: p.url, x: p.x, y: p.y, width: p.width, height: p.height, sequence: p.sequence, final: p.final });
    if (validFingerprint(p.target)) step.target = p.target; else delete step.target;
    if (validRoute(p.route)) step.route = p.route; else delete step.route;
    delete step.screenshot; delete step.blurred;
    step.reason = p.final ? 'Final entry screenshot pending.' : 'Editing entry. Screenshot captured when you finish.';
    this.admittedInputs.set(p.actionId, { step, sequence: p.sequence as number, final: p.final });
    if (!previous) this.state.recording!.steps.push(step);
    return step;
  }
  // Author edits. Validated here; a failed write reverts the edit and throws
  // without stopping a live capture.
  edit(command: unknown): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ready;
      if (!this.isActive((command as { guideId?: unknown } | null)?.guideId)) return false;
      const r = this.state.recording;
      if (!r) throw new Error('No recording to edit.');
      const undo = applyEdit(r, command, this.port.now());
      this.state.revision = ++this.revision;
      try { await this.port.write(this.state); }
      catch (error) { undo(); throw new Error(`Edit not saved: ${String(error)}`); }
      this.port.notify?.(structuredClone(this.state));
      return true;
    });
  }
  // With a guide id, stops only if that guide is the active one. finish acts
  // on the current recording immediately, so the check is immediate too.
  // Full page: one tall, scrolled screenshot of the page in the captured tab,
  // added as its own step. Works while recording or paused.
  fullPage(): Promise<void> {
    return this.enqueue(async () => {
      await this.ready;
      const r = this.state.recording;
      if (!r || r.status === 'stopped') throw new Error('Start a capture first.');
      if (!this.port.fullPage) throw new Error('Full-page screenshots are not available here.');
      const page = await this.port.target(r.tabId, r.windowId);
      const shot = await this.port.fullPage(r, { blur: r.autoBlur !== false });
      this.lastCapture = this.port.now();
      if (typeof shot?.screenshot !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot.screenshot) ||
          ![shot.width, shot.height].every(n => Number.isFinite(n) && n > 0 && n <= 20000)) throw new Error('Invalid full-page screenshot.');
      if (this.state.recording !== r) return;
      const step: Step = {
        id: crypto.randomUUID(), kind: 'full', label: `Full page: ${page.title || new URL(page.url).host}${shot.truncated ? ' (top 12,000 px)' : ''}`.slice(0, 160),
        title: page.title, url: page.url, x: 0, y: 0, width: shot.width, height: shot.height, at: this.port.now(), hideMarker: true, screenshot: shot.screenshot,
      };
      r.steps.push(step);
      await this.save(step);
    });
  }
  stop(guideId?: string): Promise<boolean> {
    if (!this.isActive(guideId)) return Promise.resolve(false);
    return this.finish('stopped').then(() => true);
  }
  pause(): Promise<void> { return this.finish('paused'); }
  private finish(status: 'paused' | 'stopped'): Promise<void> {
    // Close admission and request the document-bound drain immediately,
    // before waiting for any previously accepted screenshot operations.
    this.pauseSequence++;
    const r = this.state.recording;
    const live = r?.status === 'recording';
    // Completing (from recording or paused) is when steps get tidied.
    const completing = !!r && r.status !== 'stopped' && status === 'stopped';
    if (r && (live || status === 'stopped')) r.status = status;
    const drained = live && r.documentId && this.port.finalize ?this.port.finalize(r, this.port.now()).catch(error => {
      this.state.error = `Final text could not be retrieved: ${String(error)}. Review the saved steps.`;
      return [];
    }) : Promise.resolve([]);
    return this.enqueue(async () => {
      await this.ready;
      const actions = await drained;
      if (r && this.state.recording === r) {
        for (const payload of actions) {
          const step = this.inputStep(payload);
          if (step) await this.clickNow(step, r, true);
        }
        if (r.status === 'recording' || status === 'stopped') r.status = status;
        if (completing && this.port.tidy?.()) {
          const { steps, removed } = tidySteps(r.steps);
          if (removed) { r.steps = steps; r.tidied = removed; }
        }
      }
      await this.save();
    });
  }
  resume(): Promise<void> { return this.enqueue(async () => {
    await this.ready;
    const r = this.state.recording;
    if (r?.status !== 'paused') throw new Error('Only a paused capture can resume.');
    const pauseSequence = this.pauseSequence;
    // Resume arms whichever web tab was followed while paused.
    const before = await this.port.current(r.tabId, r.windowId).catch(() => ({ active: false, documentId: '' }));
    if (pauseSequence !== this.pauseSequence) return;
    if (!before.active || r.status !== 'paused') {
      throw new Error('Switch to a loaded web page, then Resume.');
    }
    const captureId = crypto.randomUUID();
    const documentId = await this.port.inject(r.tabId, captureId);
    const after = await this.port.current(r.tabId, r.windowId);
    if (pauseSequence !== this.pauseSequence) return;
    if (documentId !== before.documentId || !after.active || after.documentId !== documentId || r.status !== 'paused') {
      throw new Error('The page changed while resuming. Try Resume again.');
    }
    r.status = 'recording';
    r.documentId = documentId;
    r.captureId = captureId;
    this.armedTab = r.tabId;
    delete r.notice;
    await this.save();
  }); }
  delete(guideId?: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ready;
      if (!this.isActive(guideId)) return false;
      await this.deleteNow();
      return true;
    });
  }
  // Done: file the completed guide in the library and clear the active slot.
  archive(): Promise<void> { return this.enqueue(async () => {
    await this.ready;
    if (!this.state.recording) return;
    await this.archiveNow();
    await this.save();
  }); }
  private async archiveNow(): Promise<void> {
    const r = this.state.recording!;
    if (r.status !== 'stopped') throw new Error('Complete the capture before starting another.');
    if (!this.port.archive) throw new Error('Delete the existing recording before starting another.');
    // Write the library copy first: a crash leaves a duplicate, never a loss.
    await this.port.archive(structuredClone(r), this.state.revision ?? this.revision);
    this.state = { recording: null };
  }
  deleteStep(id: string, guideId?: string): Promise<boolean> {
    this.deletedInputs.add(id);
    return this.enqueue(async () => {
      await this.ready;
      if (!this.isActive(guideId)) return false;
      const r = this.state.recording;
      if (!r) return true;
      r.steps = r.steps.filter(step => step.id !== id);
      await this.save();
      return true;
    });
  }
  private lastCapture = -Infinity;
  // Tab of the document capture last listened to; tabs it could not record
  // (browser pages) do not count as pages visited.
  private armedTab: number | undefined;
  // The page capture is on, for telling a reload from a new page. Kept apart
  // from the last step, which may be on a page left by a click.
  private currentPage: string | undefined;
  // Tabs the followed tab opened (a link in a new tab), with when.
  private openedTabs = new Map<number, number>();
  tabOpened(tabId: number, openerTabId: number): void {
    if (this.state.recording && this.state.recording.status !== 'stopped' && this.state.recording.tabId === openerTabId) this.openedTabs.set(tabId, this.port.now());
  }
  constructor(port: Port) {
    this.port = port;
    this.ready = port.read().then(async state => {
      if (state) this.state = state;
      // Seed each worker's sequence from the clock and advance beyond saved
      // revisions. This orders replies and live updates, not capture timestamps.
      this.revision = Math.max(this.revision, (this.state.revision ?? 0) + 1);
      this.state.revision = this.revision;
      // Add identities to starter recordings without changing their content or order.
      const migrated = this.state.recording?.steps.some(step => !step.id) || (this.state.recording && !this.state.recording.id);
      for (const step of this.state.recording?.steps ?? []) step.id ??= crypto.randomUUID();
      if (this.state.recording) this.state.recording.id ??= crypto.randomUUID();
      if (this.state.recording && this.state.recording.status !== 'stopped') {
        this.state.recording.status = 'stopped';
        this.state.recording.stoppedReason = 'Extension worker restarted. Recording ended for safety.';
        await this.save();
      }
      else if (migrated) await this.save();
    });
  }
  private async startNow(tabId?: number, windowId?: number, options: { autoBlur?: boolean } = {}): Promise<void> {
    await this.ready;
    if (this.state.recording) {
      if (!this.port.archive) throw new Error('Delete the existing recording before starting another.');
      if (this.state.recording.status !== 'stopped') throw new Error('Complete the capture before starting another.');
      await this.archiveNow();
    }
    const target = await this.port.target(tabId, windowId);
    const captureId = crypto.randomUUID();
    const documentId = await this.port.inject(target.tabId, captureId);
    this.admittedInputs.clear();
    this.deletedInputs.clear();
    this.armedTab = target.tabId;
    this.currentPage = pageKey(target);
    this.openedTabs.clear();
    const recording: Recording = { ...target, id: crypto.randomUUID(), documentId, captureId, status: 'recording', startedAt: this.port.now(), steps: [], autoBlur: options.autoBlur ?? true };
    this.state = { recording };
    await this.save();
    // The site icon follows outside the queue, so it delays neither Start nor screenshots.
    void this.siteIcon(target.url).then(icon => {
      if (icon) void this.enqueue(async () => {
        if (this.state.recording !== recording) return;
        recording.favicon = icon;
        await this.save();
      });
    });
  }
  // A slow, failing or unexpected icon is simply skipped.
  private async siteIcon(pageUrl: string): Promise<string | undefined> {
    if (!this.port.favicon) return undefined;
    const icon = await Promise.race([
      this.port.favicon(pageUrl).catch(() => undefined),
      new Promise<undefined>(resolve => setTimeout(resolve, 1000)),
    ]);
    return typeof icon === 'string' && icon.length <= 60000 && /^data:image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(icon) ? icon : undefined;
  }
  private async clickNow(step: Step, recording: Recording, finalizing = false): Promise<void> {
    await this.ready;
    if (this.state.recording !== recording) return;
    if (!recording.steps.includes(step) || step.id && this.deletedInputs.has(step.id)) return;
    delete step.reason;
    const safe = () => recording.status === 'recording' || finalizing && !recording.stoppedReason;
    if (!safe()) {
      step.reason = 'Recording ended before this queued click could be screenshotted.';
    } else try {
      const before = await this.port.current(recording.tabId, recording.windowId);
      if (this.port.now() - this.lastCapture < 650) step.reason = `Screenshot rate limit: ${step.kind === 'type' ? 'entry' : 'click'} recorded without an image.`;
      else if (safe() && before.active && before.documentId === recording.documentId) {
        this.lastCapture = this.port.now();
        // Check for private details on both sides of the capture, so content
        // that appears or moves during it is still covered.
        const blur = recording.autoBlur !== false && !!this.port.sensitive && !!this.port.redact;
        const check = () => blur ? this.port.sensitive!(recording).catch(() => null) : Promise.resolve(null);
        const regionsBefore = await check();
        await this.port.beforeCapture?.(recording).catch(() => {});
        let screenshot: string;
        try { screenshot = await this.port.capture(recording.windowId); }
        finally { void this.port.afterCapture?.(recording).catch(() => {}); }
        const regionsAfter = await check();
        const after = await this.port.current(recording.tabId, recording.windowId);
        if (!safe() || !after.active || after.documentId !== recording.documentId) step.reason = 'Tab or document changed during capture.';
        else if (!blur) step.screenshot = screenshot;
        // Fail closed: never keep an image that could not be checked.
        else if (!regionsBefore || !regionsAfter) step.reason = 'Automatic blur could not check this page, so the screenshot was not saved.';
        else {
          const count = regionsBefore.boxes.length + regionsAfter.boxes.length;
          if (!count) step.screenshot = screenshot;
          else try {
            step.screenshot = await this.port.redact!(screenshot, [regionsBefore, regionsAfter]);
            step.blurred = Math.max(regionsBefore.boxes.length, regionsAfter.boxes.length);
          } catch { step.reason = 'Automatic blur failed, so the screenshot was not saved.'; }
        }
      } else step.reason = 'Tab or document changed before capture.';
    } catch (error) { step.reason = `Screenshot unavailable: ${String(error)}`; }
    await this.save(step);
  }
  // Capture follows the focused tab. Activation may move it to any tab; load
  // and URL updates only matter for the tab already being followed.
  follow(tabId: number, activated = false): Promise<void> {
    return this.enqueue(() => this.followNow(tabId, activated));
  }
  closed(tabId: number): Promise<void> {
    return this.enqueue(async () => {
      await this.ready;
      const r = this.state.recording;
      if (!r || r.status === 'stopped' || r.tabId !== tabId) return;
      r.documentId = '';
      r.notice = 'The captured tab was closed. Switch to a web page to keep capturing.';
      await this.save();
    });
  }
  private async followNow(tabId: number, activated: boolean): Promise<void> {
    await this.ready;
    const r = this.state.recording;
    if (!r || r.status === 'stopped' || !activated && r.tabId !== tabId) return;
    const live = () => this.state.recording === r && r.status !== 'stopped';
    try {
      const target = await this.port.target(tabId);
      const probe = await this.port.current(target.tabId, target.windowId, true);
      // Same tab and document, including same-document routes: keep the
      // listener. A single-page app route change can still be a new page.
      if (probe.active && r.documentId && probe.documentId === r.documentId && target.tabId === r.tabId && target.windowId === r.windowId) {
        if (r.status === 'recording') await this.pageStep(r, target, false);
        else this.currentPage = pageKey(target);
        return;
      }
      await this.release(r);
      if (!live()) return;
      r.tabId = target.tabId; r.windowId = target.windowId; delete r.notice;
      // Pages visited while paused are not new pages after Resume.
      if (r.status !== 'recording') this.currentPage = pageKey(target);
      // Pause installs nothing; Resume arms the followed tab. A loading
      // document is armed by its completion update, never mid-replacement.
      if (r.status === 'recording' && (await this.port.current(target.tabId, target.windowId)).active && live() && r.status === 'recording') {
        const captureId = crypto.randomUUID();
        const documentId = await this.port.inject(target.tabId, captureId);
        const after = await this.port.current(target.tabId, target.windowId);
        if (live() && r.status === 'recording' && r.tabId === target.tabId && after.active && after.documentId === documentId) {
          r.documentId = documentId; r.captureId = captureId;
          const newTab = target.tabId !== this.armedTab;
          this.armedTab = target.tabId;
          await this.pageStep(r, target, newTab);
        }
      }
    } catch {
      if (!live()) return;
      await this.release(r);
      if (!live()) return;
      if (activated) r.tabId = tabId;
      r.notice = 'Not capturing this tab. Switch to a web page to keep capturing.';
    }
    if (live()) await this.save();
  }
  // "Go to <page>" when capture arrives at a different page by itself: an
  // address typed, a tab switch, a single-page app route. Navigation a
  // recorded click caused within five seconds (this tab navigating, or a tab
  // it opened) is already explained by that click, so it adds no step (a
  // deliberate choice, recorded in the spec).
  private async pageStep(r: Recording, target: Target, newTab: boolean): Promise<void> {
    const previous = this.currentPage ?? r.url;
    const key = pageKey(target);
    this.currentPage = key;
    // The same page in the same tab is a reload; in another tab it is a new page.
    if (!newTab && key === previous) return;
    // A click in the last five seconds caused this only if it navigated this
    // tab or opened this tab; switching to another tab yourself is a new page.
    const last = [...r.steps].reverse().find(isStep);
    const now = this.port.now();
    const clicked = !!last && last.kind === undefined && now - last.at < 5000;
    const opened = now - (this.openedTabs.get(target.tabId) ?? -Infinity) < 5000;
    // Only the first visit to an opened tab is the click's doing.
    this.openedTabs.delete(target.tabId);
    if (clicked && (!newTab || opened)) return;
    const step: Step = {
      id: crypto.randomUUID(), kind: 'page', label: `Go to ${target.title || new URL(target.url).host}`.slice(0, 160),
      title: target.title, url: target.url, x: 0, y: 0, width: 1, height: 1, at: this.port.now(), hideMarker: true,
    };
    if (validRoute(target.route)) step.route = target.route;
    r.steps.push(step);
    await this.clickNow(step, r);
  }
  // Drain pending text and remove the armed document's listener before capture moves on.
  private async release(r: Recording): Promise<void> {
    if (!r.documentId) return;
    if (r.status === 'recording' && this.port.finalize) {
      const actions = await this.port.finalize(r, this.port.now()).catch(() => []);
      for (const payload of actions) {
        const step = this.inputStep(payload);
        if (step) await this.clickNow(step, r, true);
      }
    }
    r.documentId = '';
  }
  invalidate(tabId: number, reason: string): void {
    if (this.state.recording?.tabId !== tabId) return;
    this.state.recording.status = 'stopped';
    this.state.recording.stoppedReason = reason;
    void this.enqueue(() => this.save());
  }

  private async deleteNow(): Promise<void> {
    await this.ready;
    if (this.state.recording) this.state.recording.status = 'stopped';
    this.state.revision = ++this.revision;
    try {
      const cleared = { recording: null, revision: this.revision };
      await this.port.write(cleared);
      this.state = cleared;
    } catch (error) { this.state.error = `Deletion failed: ${String(error)}. The recording is still available.`; }
    this.port.notify?.(structuredClone(this.state));
  }
  private async save(newImageStep?: Step): Promise<void> {
    this.state.revision = ++this.revision;
    try { await this.port.write(this.state); }
    catch (error) {
      // Only a confirmed image-size quota error is recoverable. Never evict
      // previous images, retry generic errors, or claim unsaved metadata is safe.
      if (/\b(?:Resource::kQuotaBytes|QUOTA_BYTES)\b[\s\S]*exceeded/i.test(String(error)) &&
          newImageStep?.screenshot && this.state.recording?.steps.includes(newImageStep)) {
        const screenshot = newImageStep.screenshot;
        const reason = newImageStep.reason;
        delete newImageStep.screenshot;
        newImageStep.reason = 'Storage quota: step recorded without an image.';
        try {
          await this.port.write(this.state);
          this.port.notify?.(structuredClone(this.state));
          return;
        } catch (retryError) {
          newImageStep.screenshot = screenshot;
          if (reason === undefined) delete newImageStep.reason; else newImageStep.reason = reason;
          error = retryError;
        }
      }
      if (this.state.recording) this.state.recording.status = 'stopped';
      this.state.error = `Changes not saved: ${String(error)}. Export now before the worker sleeps.`;
    }
    this.port.notify?.(structuredClone(this.state));
  }
  private publish(): void {
    this.state.revision = ++this.revision;
    this.port.notify?.(structuredClone(this.state));
  }
  async status(): Promise<State> { await this.ready; await this.queue; return structuredClone(this.state); }
}

const stepId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
function text(value: unknown, max: number, line = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text.');
  return line ? value.replace(/\s+/g, ' ').trim() : value.replace(/\r\n?/g, '\n').trim();
}
function index(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error('Invalid position.');
  return value as number;
}
// Set or clear an optional field; returns a function restoring the old value.
function assign<T extends object>(target: T, key: keyof T, value: unknown): () => void {
  const had = key in target; const old = target[key];
  if (value === undefined || value === '') delete target[key]; else (target as Record<keyof T, unknown>)[key] = value;
  return () => { if (had) target[key] = old; else delete target[key]; };
}
export function applyEdit(r: Recording, command: unknown, now: number): () => void {
  const c = (command ?? {}) as Record<string, unknown>;
  const find = () => {
    if (!stepId(c.stepId)) throw new Error('Invalid step identity.');
    const entry = r.steps.find(entry => entry.id === c.stepId);
    if (!entry) throw new Error('Step not found.');
    return entry;
  };
  switch (c.type) {
    case 'EDIT_GUIDE': {
      const title = text(c.title, 200, true); const description = text(c.description, 5000);
      if (c.markerStyle !== undefined && c.markerStyle !== 'circle' && c.markerStyle !== 'box') throw new Error('Invalid marker style.');
      const undo = [title !== undefined && assign(r, 'guideTitle', title), description !== undefined && assign(r, 'description', description),
        c.markerStyle !== undefined && assign(r, 'markerStyle', c.markerStyle === 'box' ? 'box' : undefined)];
      return () => { for (const u of undo) if (u) u(); };
    }
    case 'EDIT_STEP': {
      const entry = find();
      const value = text(c.text, 2000); const note = text(c.note, 5000);
      if (isBlock(entry)) {
        if (c.note !== undefined) throw new Error('Invalid field for a block.');
        if (value === undefined) return () => {};
        const old = entry.text; entry.text = value; return () => { entry.text = old; };
      }
      const undo = [value !== undefined && assign(entry, 'text', value === entry.label ? undefined : value), note !== undefined && assign(entry, 'note', note)];
      return () => { for (const u of undo) if (u) u(); };
    }
    case 'MOVE_STEP': {
      const entry = find(); const to = index(c.index, r.steps.length - 1);
      const from = r.steps.indexOf(entry);
      r.steps = r.steps.filter(e => e !== entry); r.steps.splice(to, 0, entry);
      // Undo only this move: steps captured while the save was pending stay.
      return () => {
        r.steps = r.steps.filter(e => e !== entry);
        r.steps.splice(Math.min(from, r.steps.length), 0, entry);
      };
    }
    case 'INSERT_BLOCK': {
      if (!blockKinds.includes(c.kind as string)) throw new Error('Invalid block kind.');
      const at = index(c.index, r.steps.length);
      const block: Block = { id: crypto.randomUUID(), kind: c.kind as BlockKind, text: text(c.text, 2000) ?? '', at: now };
      r.steps.splice(at, 0, block);
      return () => { r.steps = r.steps.filter(e => e !== block); };
    }
    case 'EDIT_SHOT': {
      const entry = find();
      if (isBlock(entry)) throw new Error('Invalid step for a screenshot.');
      const shot = c.screenshot;
      if (typeof shot !== 'string' || shot.length > 6_000_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(shot)) throw new Error('Invalid screenshot.');
      const [x, y, width, height] = [c.x, c.y, c.width, c.height] as number[];
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 20000 || height > 20000 ||
          x < 0 || x > width || y < 0 || y > height) throw new Error('Invalid marker geometry.');
      const old = { screenshot: entry.screenshot, x: entry.x, y: entry.y, width: entry.width, height: entry.height };
      const undoHide = assign(entry, 'hideMarker', c.hideMarker === true ? true : undefined);
      Object.assign(entry, { screenshot: shot, x, y, width, height });
      return () => { Object.assign(entry, old); undoHide(); };
    }
    default: throw new Error('Unknown edit.');
  }
}
