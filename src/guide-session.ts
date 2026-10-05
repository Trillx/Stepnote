// Guide me walkthroughs: which guide each tab is following and which step
// it is on. State lives in session storage so it survives the worker
// sleeping between page loads.
import { isStep, type Recording } from './recorder.ts';
import { emphasis, guideTitle, type Segment } from './sop.ts';
import type { Fingerprint } from './fingerprint.ts';

export interface GuideStep {
  id: string;
  kind?: 'type' | 'page' | 'full';
  segments: Segment[];
  note?: string;
  // Headers, tips and alerts placed just before this step.
  tips: { kind: 'header' | 'tip' | 'alert'; text: string }[];
  url: string;
  title: string;
  target?: Fingerprint;
  // Fragment route token, for hash-routed apps.
  route?: string;
  // Recorded click position (viewport units), for guides without a fingerprint.
  position?: { x: number; y: number; width: number; height: number };
  screenshot?: string;
}
export interface GuideView { guideId: string; title: string; index: number; total: number; step: GuideStep }
type Sessions = Record<string, { guideId: string; index: number }>;
export interface GuidePort {
  load(guideId: string): Promise<Recording>;
  // Puts the overlay script into the tab's top document.
  inject(tabId: number): Promise<void>;
  read(): Promise<Sessions>;
  write(sessions: Sessions): Promise<void>;
}

export function guideSteps(recording: Recording): GuideStep[] {
  const steps: GuideStep[] = [];
  let tips: GuideStep['tips'] = [];
  for (const entry of recording.steps) {
    if (!isStep(entry)) { if (entry.text.trim()) tips.push({ kind: entry.kind, text: entry.text.trim() }); continue; }
    steps.push({
      id: entry.id!, kind: entry.kind, segments: emphasis(entry), tips, url: entry.url, title: entry.title,
      position: { x: entry.x, y: entry.y, width: entry.width, height: entry.height },
      ...(entry.note ? { note: entry.note } : {}), ...(entry.target ? { target: entry.target } : {}), ...(entry.route ? { route: entry.route } : {}), ...(entry.screenshot ? { screenshot: entry.screenshot } : {}),
    });
    tips = [];
  }
  return steps;
}

export class GuideSessions {
  private port: GuidePort;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(port: GuidePort) { this.port = port; }
  // Session changes are read-modify-write; run them one at a time.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private async build(tabId: number, sessions: Sessions): Promise<GuideView | null> {
    const session = sessions[tabId];
    if (!session) return null;
    const recording = await this.port.load(session.guideId);
    const steps = guideSteps(recording);
    if (!steps.length) return null;
    const index = Math.min(Math.max(0, session.index), steps.length - 1);
    return { guideId: session.guideId, title: guideTitle(recording), index, total: steps.length, step: steps[index] };
  }
  start(guideId: string, tabId: number): Promise<GuideView> {
    return this.serial(async () => {
      const recording = await this.port.load(guideId);
      if (!guideSteps(recording).length) throw new Error('This guide has no steps to walk through.');
      const sessions = await this.port.read();
      sessions[tabId] = { guideId, index: 0 };
      await this.port.write(sessions);
      await this.port.inject(tabId);
      return (await this.build(tabId, sessions))!;
    });
  }
  async view(tabId: number): Promise<GuideView | null> {
    await this.queue;
    return this.build(tabId, await this.port.read()).catch(() => null);
  }
  // Next (+1) or Back (-1). Next on the last step finishes the walkthrough.
  move(tabId: number, by: 1 | -1): Promise<GuideView | null> {
    return this.serial(async () => {
      const sessions = await this.port.read();
      const view = await this.build(tabId, sessions).catch(() => null);
      if (!view) return null;
      const index = view.index + by;
      if (index >= view.total) { delete sessions[tabId]; await this.port.write(sessions); return null; }
      sessions[tabId] = { guideId: view.guideId, index: Math.max(0, index) };
      await this.port.write(sessions);
      return this.build(tabId, sessions);
    });
  }
  exit(tabId: number): Promise<void> {
    return this.serial(async () => {
      const sessions = await this.port.read();
      if (!sessions[tabId]) return;
      delete sessions[tabId];
      await this.port.write(sessions);
    });
  }
  closed(tabId: number): Promise<void> { return this.exit(tabId); }
  // A page finished loading: bring the overlay back if this tab is guided.
  async loaded(tabId: number): Promise<void> {
    await this.queue;
    if ((await this.port.read())[tabId]) await this.port.inject(tabId).catch(() => {});
  }
}
