// Content script for the on-screen Stepnote button (registered dynamically).
import { mountLauncher } from './launcher-ui.ts';

const scope = window as Window & { __stepnoteLauncher?: { destroy(): void } };
// Top-level pages only, once per document.
if (window.top === window && !scope.__stepnoteLauncher) {
  const send = async (type: string) => {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error ?? 'Stepnote did not respond.');
    return response.result;
  };
  scope.__stepnoteLauncher = mountLauncher(window, {
    count: async () => Number(await send('LAUNCHER_COUNT')) || 0,
    open: () => { void send('LAUNCHER_OPEN').catch(() => {}); },
    hide: () => { void send('LAUNCHER_HIDE').catch(() => {}); },
  });
}
