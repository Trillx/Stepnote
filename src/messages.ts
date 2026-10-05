import { isStep, type Recorder } from './recorder.ts';
import { summarize, validGuideId, type Library } from './library.ts';
import type { GuideSessions } from './guide-session.ts';

// Guide-addressed operations answer false when the guide is no longer the active one.
type Controls = Pick<Recorder, 'start' | 'status' | 'click'> & Partial<Pick<Recorder, 'pause' | 'resume' | 'input' | 'archive' | 'fullPage'>> & {
  delete(guideId?: string): Promise<boolean | void>;
  stop(guideId?: string): Promise<boolean | void>;
  edit?(command: unknown): Promise<boolean | void>;
  deleteStep?(stepId: string, guideId?: string): Promise<boolean | void>;
};
type Guides = Pick<Library, 'list' | 'get' | 'edit' | 'remove'>;
const edits = ['EDIT_GUIDE', 'EDIT_STEP', 'MOVE_STEP', 'INSERT_BLOCK', 'EDIT_SHOT'];
type Source = Omit<chrome.runtime.MessageSender, 'tab'> & { tab?: { id?: number } };
export async function route(message: unknown, sender: Source, id: string, recorder: Controls, library?: Guides, walkthroughs?: Pick<GuideSessions, 'start' | 'view' | 'move' | 'exit'>, options: { captureControls?(): boolean; launcher?: { count(host: string): Promise<number>; open(tabId: number): Promise<void>; hide(host: string): Promise<void> } } = {}): Promise<unknown> {
  const type = (message as { type?: unknown } | null)?.type;
  // Guide me overlay: the top document of a tab may read and drive only its
  // own walkthrough.
  const guideCommands: Record<string, (tabId: number) => Promise<unknown>> = {
    GUIDE_STATE: tabId => walkthroughs!.view(tabId),
    GUIDE_NEXT: tabId => walkthroughs!.move(tabId, 1),
    GUIDE_BACK: tabId => walkthroughs!.move(tabId, -1),
    GUIDE_EXIT: tabId => walkthroughs!.exit(tabId).then(() => null),
  };
  if (walkthroughs && typeof type === 'string' && guideCommands[type] && sender.id === id && sender.tab?.id !== undefined &&
      sender.frameId === 0 && /^https?:\/\//.test(sender.url ?? '')) return guideCommands[type](sender.tab.id);
  // On-screen button: answers for, opens beside, or hides on the sender's own tab and site.
  const launcherTypes = ['LAUNCHER_COUNT', 'LAUNCHER_OPEN', 'LAUNCHER_HIDE'];
  if (options.launcher && launcherTypes.includes(type as string) && sender.id === id && sender.tab?.id !== undefined &&
      sender.frameId === 0 && /^https?:\/\//.test(sender.url ?? '')) {
    const host = new URL(sender.url!).host;
    if (type === 'LAUNCHER_COUNT') return options.launcher.count(host);
    if (type === 'LAUNCHER_OPEN') { await options.launcher.open(sender.tab.id); return null; }
    await options.launcher.hide(host); return null;
  }
  const pageTypes = ['CLICK', 'INPUT', 'PING', 'CAPTURE_CONTROLS', 'CAPTURE_PAUSE', 'CAPTURE_STOP', 'CAPTURE_FULL'];
  if (pageTypes.includes(type as string) && sender.id === id && sender.tab?.id !== undefined &&
      sender.frameId === 0 && sender.documentId && /^https?:\/\//.test(sender.url ?? '')) {
    // On-page controls act only for the document being captured.
    const current = (await recorder.status()).recording;
    const armed = current?.status === 'recording' && current.tabId === sender.tab.id && current.documentId === sender.documentId;
    if (type === 'CAPTURE_CONTROLS') return { show: armed && (options.captureControls?.() ?? false), steps: armed ? current!.steps.filter(isStep).length : 0 };
    if (type === 'CAPTURE_PAUSE') { if (armed) await recorder.pause!(); return { active: false }; }
    if (type === 'CAPTURE_STOP') { if (armed) await recorder.stop(); return { active: false }; }
    if (type === 'CAPTURE_FULL') { if (armed) await recorder.fullPage!(); return { active: armed, steps: armed ? (await recorder.status()).recording!.steps.filter(isStep).length : 0 }; }
    if (type === 'CLICK') await recorder.click((message as { payload?: unknown }).payload,
      { tabId: sender.tab.id, frameId: 0, documentId: sender.documentId });
    if (type === 'INPUT') await recorder.input!((message as { payload?: unknown }).payload,
      { tabId: sender.tab.id, frameId: 0, documentId: sender.documentId });
    const { recording } = await recorder.status();
    const active = recording?.status === 'recording' && recording.tabId === sender.tab.id && recording.documentId === sender.documentId;
    // Only a step count, for the on-page bar; never step data.
    return { active, steps: active ? recording!.steps.filter(isStep).length : 0 };
  }
  const base = `chrome-extension://${id}/`;
  // Pages are identified by path; the editor and print pages carry ?guide=<id>.
  const page = (sender.url ?? '').split(/[?#]/)[0];
  const trusted = sender.id === id && (sender.frameId === undefined || sender.frameId === 0) &&
    (page === base + 'popup.html' || page === base + 'viewer.html' || page === base + 'sidepanel.html' || page === base + 'print.html');
  if (!trusted) throw new Error('Untrusted message source.');
  // The PDF print page renders a saved guide and nothing else.
  if (page === base + 'print.html' && type !== 'STATUS' && type !== 'GET_GUIDE') throw new Error('The print page is read-only.');
  const panel = page === base + 'sidepanel.html';
  // The guide editor (viewer) and the panel may edit; the legacy popup may not.
  const editor = panel || page === base + 'viewer.html';
  if (type === 'KEEP_ALIVE' && panel) return { alive: true };
  // Library: commands that name a guide go to the active guide when it is
  // that one, otherwise to the stored copy.
  const guideId = (message as { guideId?: unknown }).guideId;
  if (library && (editor || page === base + 'print.html')) {
    if (type === 'LIST_GUIDES') {
      const { recording } = await recorder.status();
      const stored = (await library.list()).filter(g => g.id !== recording?.id);
      return { guides: recording?.id ? [{ ...summarize(recording, Date.now()), active: true }, ...stored] : stored };
    }
    if (guideId !== undefined) {
      if (!validGuideId(guideId)) throw new Error('Invalid guide identity.');
      // The recorder decides inside its queue whether the guide is still the
      // active one; a Start queued meanwhile may have filed it in the library.
      // Every reply describes this guide, never whichever capture is active now.
      const guideState = async () => {
        const state = await recorder.status();
        if (state.recording?.id === guideId) return state;
        return library.get(guideId).catch(() => ({ recording: null, revision: Number.MAX_SAFE_INTEGER }));
      };
      if (type === 'GET_GUIDE') { const state = await recorder.status(); return state.recording?.id === guideId ? state : library.get(guideId); }
      if (type === 'DELETE_GUIDE') {
        if (await recorder.delete(guideId) === false) {
          await library.remove(guideId); // throws if storage refuses
          return { recording: null, revision: Number.MAX_SAFE_INTEGER };
        }
        // A failed save keeps the guide and reports the error with it.
        return guideState();
      }
      if (type === 'STOP') { await recorder.stop(guideId); return guideState(); }
      if (edits.includes(type as string) || type === 'DELETE_STEP') {
        let handled: boolean | void;
        if (type === 'DELETE_STEP') {
          const stepId = (message as { stepId?: unknown }).stepId;
          if (typeof stepId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(stepId)) throw new Error('Invalid step identity.');
          handled = await recorder.deleteStep!(stepId, guideId);
        } else handled = await recorder.edit!(message);
        return handled !== false ? guideState() : library.edit(guideId, message);
      }
    }
  }
  if (type === 'ARCHIVE' && panel) { await recorder.archive!(); return recorder.status(); }
  if (type === 'GUIDE_START' && panel && walkthroughs) {
    const { guideId, tabId } = message as { guideId?: unknown; tabId?: unknown };
    if (!validGuideId(guideId)) throw new Error('Invalid guide identity.');
    if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) throw new Error('Invalid tab.');
    return walkthroughs.start(guideId, tabId);
  }
  if (type === 'START' && (panel || page === base + 'popup.html')) {
    const tabId = (message as { tabId?: unknown }).tabId;
    if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) throw new Error('Invalid recording tab.');
    const windowId = (message as { windowId?: unknown }).windowId;
    if (panel && (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId < 0)) throw new Error('Invalid panel window.');
    const autoBlur = (message as { autoBlur?: unknown }).autoBlur;
    await recorder.start(tabId, typeof windowId === 'number' ? windowId : undefined, { autoBlur: autoBlur !== false });
  }
  else if (type === 'PAUSE' && panel) await recorder.pause!();
  else if (type === 'FULL_PAGE' && panel) await recorder.fullPage!();
  else if (type === 'RESUME' && panel) await recorder.resume!();
  else if (edits.includes(type as string) && editor) await recorder.edit!(message);
  else if (type === 'DELETE_STEP' && editor) {
    const stepId = (message as { stepId?: unknown }).stepId;
    if (typeof stepId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(stepId)) throw new Error('Invalid step identity.');
    await recorder.deleteStep!(stepId);
  }
  else if (type === 'STOP') await recorder.stop();
  else if (type === 'DELETE') await recorder.delete();
  else if (type !== 'STATUS') throw new Error('Unknown command.');
  return recorder.status();
}
