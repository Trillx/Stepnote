import type { State } from './recorder.ts';
import type { GuideSummary } from './library.ts';
export async function request(type: string, stepId?: string, extra: Record<string, unknown> = {}): Promise<State> {
  const message: { type: string; tabId?: number; windowId?: number; stepId?: string } & Record<string, unknown> = { ...extra, type };
  if (stepId !== undefined) message.stepId = stepId;
  if (type === 'START') {
    const window = await chrome.windows.getCurrent();
    if (window.id === undefined) throw new Error('Cannot identify the panel window. Invoke the toolbar action on a web page.');
    const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
    if (tab?.id === undefined) throw new Error('Open a web page and use its extension toolbar button.');
    message.tabId = tab.id;
    message.windowId = window.id;
  }
  return send(message);
}
export async function send(message: { type: string } & Record<string, unknown>): Promise<State> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'Extension did not respond. Reopen this page.');
  return response.result as State;
}
export async function listGuides(): Promise<GuideSummary[]> {
  const response = await chrome.runtime.sendMessage({ type: 'LIST_GUIDES' });
  if (!response?.ok) throw new Error(response?.error ?? 'Extension did not respond. Reopen this page.');
  return (response.result as { guides: GuideSummary[] }).guides;
}
export const guideUrl = (guideId?: string) => chrome.runtime.getURL(guideId ? `viewer.html?guide=${encodeURIComponent(guideId)}` : 'viewer.html');
// Live state pushed by the worker. Ignores messages from any other sender.
export function subscribe(listener: (state: State) => void): () => void {
  const onMessage = (message: { type?: string; state?: State }, sender: chrome.runtime.MessageSender) => {
    if (sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('background.js') && message?.type === 'STATE_CHANGED' && message.state) listener(message.state);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  return () => chrome.runtime.onMessage.removeListener(onMessage);
}
// Guide list changes: a stored guide added, edited or removed, or the active
// guide starting, finishing or being deleted.
export function subscribeGuides(listener: () => void): () => void {
  let active: string | undefined;
  const onMessage = (message: { type?: string; state?: State }, sender: chrome.runtime.MessageSender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('background.js')) return;
    if (message?.type === 'GUIDES_CHANGED') listener();
    else if (message?.type === 'STATE_CHANGED' && message.state) {
      const r = message.state.recording;
      const key = r ? `${r.id}:${r.status}` : 'none';
      if (key !== active) { active = key; listener(); }
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  return () => chrome.runtime.onMessage.removeListener(onMessage);
}
// Saves a generated file through a temporary link.
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
