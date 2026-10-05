import { mountSidePanel } from './sidepanel-ui.ts';
import { guideUrl, listGuides, request, saveFile, send, subscribe, subscribeGuides } from './client.ts';
import { confirmDelete } from './dialog.ts';
import { normalizeSettings } from './settings.ts';

const allSites = { origins: ['<all_urls>'] };

void mountSidePanel(document.querySelector<HTMLElement>('#app')!, request, subscribe, html => {
  saveFile(new Blob([html], { type: 'text/html;charset=utf-8' }), 'recorded-procedure.html');
}, summary => confirmDelete(document, summary), guideId => {
  void chrome.tabs.create({ url: guideUrl(guideId) });
}, {
  granted: () => chrome.permissions.contains(allSites),
  // <all_urls>, not http/https: captureVisibleTab rejects narrower grants on
  // tabs activeTab does not cover. Not awaited, so Start continues while
  // Chrome's prompt is open; activeTab already covers the starting page.
  request: () => { void chrome.permissions.request(allSites).catch(() => false); },
  onChange: listener => {
    const update = () => { void chrome.permissions.contains(allSites).then(listener, () => listener(false)); };
    chrome.permissions.onAdded.addListener(update);
    chrome.permissions.onRemoved.addListener(update);
  },
}, {
  list: listGuides,
  faviconFor: host => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(`https://${host}`)}&size=32`),
  open: guideId => { void chrome.tabs.create({ url: guideUrl(guideId) }); },
  // Guide changes, and moving to another tab or page, refresh the lists.
  subscribe: listener => {
    subscribeGuides(listener);
    chrome.tabs.onActivated.addListener(() => listener());
    chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.url || change.status === 'complete') listener(); });
  },
  // Walkthroughs follow page loads in the tab, which needs site access: ask
  // inside the click (no prompt when already granted), then start.
  guideMe: async guideId => {
    const granted = chrome.permissions.request(allSites).catch(() => false);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('Open the page the guide is for.');
    await granted;
    await send({ type: 'GUIDE_START', guideId, tabId: tab.id });
  },
  // Readable only with site access; otherwise "On this site" stays hidden.
  currentHost: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { return tab?.url ? new URL(tab.url).host : null; } catch { return null; }
  },
}, {
  load: async () => normalizeSettings((await chrome.storage.local.get('settings')).settings),
  save: settings => chrome.storage.local.set({ settings }),
});
// Lightweight heartbeat only. Never requests or repaints screenshot data.
const heartbeat = setInterval(() => {
  void chrome.runtime.sendMessage({ type: 'KEEP_ALIVE' }).catch(() => {});
}, 20000);
window.addEventListener('pagehide', () => clearInterval(heartbeat), { once: true });
