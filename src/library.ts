// Local guide library: completed guides that are no longer the active one.
// Layout: `guides` holds the summaries; `guide:<id>` holds each guide.
import { applyEdit, isStep, type Recording, type State } from './recorder.ts';
import { guideTitle, stepText } from './sop.ts';

export interface Store {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
export interface GuideSummary {
  id: string; title: string; steps: number; startedAt: number; updatedAt: number;
  // Lower-case title, description and step text for local search.
  search: string;
  // Site the guide was captured on, for the row monogram.
  host?: string;
  // Saved site icon (small image data URL).
  favicon?: string;
  active?: boolean;
}
interface Stored { recording: Recording; revision: number }

// Same site, ignoring a leading www.
export const sameSite = (a?: string | null, b?: string | null) => !!a && !!b && a.replace(/^www\./, '') === b.replace(/^www\./, '');
export const validGuideId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
export function summarize(recording: Recording, updatedAt: number): GuideSummary {
  const text = [guideTitle(recording), recording.description ?? '', ...recording.steps.map(entry => isStep(entry) ? `${stepText(entry)} ${entry.note ?? ''}` : entry.text)];
  let host: string | undefined;
  try { host = new URL(recording.url).host; } catch { host = undefined; }
  return {
    id: recording.id!, title: guideTitle(recording), host, ...(recording.favicon ? { favicon: recording.favicon } : {}), steps: recording.steps.filter(isStep).length,
    startedAt: recording.startedAt, updatedAt, search: text.join(' ').toLowerCase().replace(/\s+/g, ' ').slice(0, 4000),
  };
}

export class Library {
  private queue: Promise<unknown> = Promise.resolve();
  private store: Store;
  private now: () => number;
  private changed: () => void;
  // changed runs after every stored change, so open guide lists can refresh.
  constructor(store: Store, now: () => number = Date.now, changed: () => void = () => {}) { this.store = store; this.now = now; this.changed = changed; }
  // Index updates are read-modify-write, so library writes run one at a time.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  private async index(): Promise<GuideSummary[]> {
    return ((await this.store.get(['guides'])).guides as GuideSummary[] | undefined) ?? [];
  }
  async list(): Promise<GuideSummary[]> {
    await this.queue;
    return (await this.index()).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(id: string): Promise<Stored> {
    if (!validGuideId(id)) throw new Error('Invalid guide identity.');
    const stored = (await this.store.get([`guide:${id}`]))[`guide:${id}`] as Stored | undefined;
    if (!stored) throw new Error('Guide not found.');
    return stored;
  }
  put(recording: Recording, revision: number): Promise<void> {
    return this.serial(() => this.write(recording, revision));
  }
  private async write(recording: Recording, revision: number) {
    if (!validGuideId(recording.id)) throw new Error('Invalid guide identity.');
    const guides = (await this.index()).filter(g => g.id !== recording.id);
    guides.push(summarize(recording, this.now()));
    await this.store.set({ [`guide:${recording.id}`]: { recording, revision }, guides });
    this.changed();
  }
  edit(id: string, command: unknown): Promise<State> {
    return this.serial(async () => {
      const { recording, revision } = await this.get(id);
      const c = (command ?? {}) as { type?: unknown; stepId?: unknown };
      if (c.type === 'DELETE_STEP') {
        if (!recording.steps.some(entry => entry.id === c.stepId)) throw new Error('Step not found.');
        recording.steps = recording.steps.filter(entry => entry.id !== c.stepId);
      } else applyEdit(recording, command, this.now());
      await this.write(recording, revision + 1);
      return { recording, revision: revision + 1 };
    });
  }
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (!validGuideId(id)) throw new Error('Invalid guide identity.');
      await this.store.set({ guides: (await this.index()).filter(g => g.id !== id) });
      await this.store.remove([`guide:${id}`]);
      this.changed();
    });
  }
}
