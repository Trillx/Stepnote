// Guide me content script: draws the walkthrough overlay for this tab.
// Injected again after each page load; a re-injection replaces the overlay.
import { mountGuide } from './guide-overlay.ts';
import type { GuideView } from './guide-session.ts';

const scope = window as Window & { __stepnoteGuide?: { destroy(): void } };
scope.__stepnoteGuide?.destroy();
async function send(type: string): Promise<GuideView | null> {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error ?? 'Stepnote did not respond.');
  return response.result as GuideView | null;
}
scope.__stepnoteGuide = mountGuide(window, {
  state: () => send('GUIDE_STATE'),
  next: () => send('GUIDE_NEXT'),
  back: () => send('GUIDE_BACK'),
  exit: () => send('GUIDE_EXIT').then(() => {}),
});
