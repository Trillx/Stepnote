import { Recorder, type State } from './recorder.ts';
import { chromePort } from './chrome-port.ts';
import { route } from './messages.ts';
import { Library, sameSite } from './library.ts';
import { badgeFor } from './badge.ts';
import { GuideSessions } from './guide-session.ts';
import { launcherActions, launcherRegistration } from './launcher-ui.ts';
import { defaultSettings, normalizeSettings } from './settings.ts';

// Keep open() in the action gesture. Do not await a worker-side window lookup.
chrome.action.onClicked.addListener(tab => {
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
});
const library = new Library({
  get: keys => chrome.storage.local.get(keys),
  set: items => chrome.storage.local.set(items),
  remove: keys => chrome.storage.local.remove(keys),
}, Date.now, () => {
  void chrome.runtime.sendMessage({ type: 'GUIDES_CHANGED' }).catch(() => {});
  refreshSite();
});
// Settings, kept current as they change in the panel.
let settings = defaultSettings;
const settingsLoaded = chrome.storage.local.get('settings').then(value => { settings = normalizeSettings(value.settings); }, () => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) { settings = normalizeSettings(changes.settings.newValue); refreshSite(); void syncLauncher(); }
});
// The on-screen button is a dynamic content script: present only when it is
// on and site access is granted, and never on excluded sites.
async function syncLauncher() {
  try {
    await settingsLoaded;
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    const registration = launcherRegistration(settings, granted);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['stepnote-launcher'] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['stepnote-launcher'] });
    if (registration) await chrome.scripting.registerContentScripts([registration]);
    // Registration only covers future page loads; bring open tabs in line.
    for (const { tabId, action } of launcherActions(await chrome.tabs.query({}), settings, granted)) {
      const target = { tabId, frameIds: [0] };
      const run = action === 'inject'
        ? chrome.scripting.executeScript({ target, files: ['launcher.js'] })
        : chrome.scripting.executeScript({ target, func: () => { const scope = window as Window & { __stepnoteLauncher?: { destroy(): void } }; scope.__stepnoteLauncher?.destroy(); delete scope.__stepnoteLauncher; } });
      await run.catch(() => {});
    }
  } catch (error) { console.error('Stepnote button', error); }
}
chrome.permissions?.onAdded?.addListener(() => void syncLauncher());
chrome.permissions?.onRemoved?.addListener(() => void syncLauncher());
void syncLauncher();
const launcher = {
  count: async (host: string) => settings.documentCount || settings.launcher ? (await library.list()).filter(guide => sameSite(guide.host, host)).length : 0,
  // A click on the page button is a user gesture Chrome carries to this call.
  open: async (tabId: number) => { await chrome.sidePanel.open({ tabId }); },
  hide: async (host: string) => {
    const domain = host.split(':')[0];
    if (settings.excludedDomains.includes(domain)) return;
    await chrome.storage.local.set({ settings: { ...settings, excludedDomains: [...settings.excludedDomains, domain] } });
  },
};
// Guides for the site in the active tab, for the badge. The address is only
// readable with site access; otherwise the count is 0.
let siteGuides = 0;
let siteTimer: ReturnType<typeof setTimeout> | undefined;
function refreshSite() {
  clearTimeout(siteTimer);
  // Cosmetic only: any failure leaves the badge as it was.
  siteTimer = setTimeout(() => void countSiteGuides().catch(() => {}), 150);
}
async function countSiteGuides() {
    await settingsLoaded;
    let count = 0;
    if (settings.documentCount) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      let host: string | null = null;
      try { host = tab?.url ? new URL(tab.url).host : null; } catch { host = null; }
      if (host) count = (await library.list().catch(() => [])).filter(guide => sameSite(guide.host, host)).length;
    }
    siteGuides = count;
    await updateBadge();
}
// Guide me walkthroughs, kept in session storage across worker restarts.
const walkthroughs = new GuideSessions({
  load: async guideId => {
    const { recording } = await recorder.status();
    return recording?.id === guideId ? recording : (await library.get(guideId)).recording;
  },
  inject: async tabId => { await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['guide.js'] }); },
  read: async () => ((await chrome.storage.session.get('walkthroughs')).walkthroughs ?? {}) as Record<string, { guideId: string; index: number }>,
  write: async value => { await chrome.storage.session.set({ walkthroughs: value }); },
});
const recorder = new Recorder({ ...chromePort, tidy: () => settings.tidy,
  // On-page controls only exist with that setting; skip the round trip otherwise.
  // Stepnote's own on-page controls never appear in screenshots.
  beforeCapture: recording => chromePort.beforeCapture!(recording),
  afterCapture: recording => chromePort.afterCapture!(recording), archive: (recording, revision) => library.put(recording, revision), notify(state) {
  void updateBadge(state).catch(console.error);
  void chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state }).catch(() => {});
} });
async function updateBadge(state?: State) {
  state ??= await recorder.status();
  const badge = badgeFor(state, siteGuides);
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  // The recorder rejects inactive clicks; content listeners clean up on their
  // next inactive reply. Never send delayed teardown from a cosmetic badge
  // update: a newer capture may already own this document's listener.
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'STATE_CHANGED') return false;
  void route(message, sender, chrome.runtime.id, recorder, library, walkthroughs, { captureControls: () => settings.captureControls === 'page', launcher })
    .then(result => { reply({ ok: true, result }); })
    .catch(error => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Chromium reports loading even for pushState with an unchanged URL, followed
  // by complete and possibly a later hash/URL update. Status is not document
  // identity: the recorder compares document IDs, keeps same-document routes,
  // and arms a replacement document only once it is complete. Screenshot
  // pre/post checks remain strict about loading.
  if (change.url || change.status === 'loading' || change.status === 'complete') {
    void recorder.follow(tabId);
  }
  if (change.url || change.status === 'complete') refreshSite();
  if (change.status === 'complete') void walkthroughs.loaded(tabId).catch(() => {});
});
// Capture follows the tab in focus: tab switches, new tabs and other windows.
chrome.tabs.onActivated.addListener(({ tabId }) => { void recorder.follow(tabId, true); refreshSite(); });
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  refreshSite();
  void chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (tab?.id !== undefined) return recorder.follow(tab.id, true);
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => { void recorder.closed(tabId); void walkthroughs.closed(tabId).catch(() => {}); });
// A tab opened from the followed tab (a link opening in a new tab) is caused by
// the click, not a separate "Go to" step.
chrome.tabs.onCreated.addListener(tab => { if (tab.id !== undefined && tab.openerTabId !== undefined) recorder.tabOpened(tab.id, tab.openerTabId); });
void updateBadge().catch(() => chrome.action.setBadgeText({ text: '!' }));
refreshSite();
