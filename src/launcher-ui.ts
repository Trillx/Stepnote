// The floating on-screen Stepnote button: opens the side panel and shows how
// many of your guides match the page. Closed shadow root; never captured.
import type { Settings } from './settings.ts';

interface Options { trusted?: (event: Event) => boolean }
const styles = `
:host { all: initial; }
.wrap { position: fixed; right: 18px; bottom: 84px; pointer-events: auto; }
.open { position: relative; width: 46px; height: 46px; padding: 0; border: 1px solid #3b4756; border-radius: 14px; background: #171d24; box-shadow: 0 10px 28px rgba(0, 0, 0, .4); cursor: pointer; display: grid; place-items: center; transition: transform .12s; }
.open:hover { transform: translateY(-1px); }
.open svg { width: 34px; height: 34px; }
.count { position: absolute; top: -6px; right: -6px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 999px; background: #7aa2ff; color: #0b1430; font: 800 11px/20px "Segoe UI", system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px #101419; }
.hide { position: absolute; top: -8px; left: -8px; width: 20px; height: 20px; padding: 0; border: 1px solid #3b4756; border-radius: 50%; background: #1f2731; color: #9ba7b3; font: 400 13px/1 system-ui, sans-serif; cursor: pointer; opacity: 0; transition: opacity .12s; }
.wrap:hover .hide, .hide:focus-visible { opacity: 1; }
.hide:hover { color: #e8edf2; }
button:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { .open, .hide { transition: none; } }
`;
const mark = '<svg viewBox="0 0 128 128" aria-hidden="true"><rect x="4" y="4" width="120" height="120" rx="28" fill="#1f2731"/><path d="M28 94H52V70H76V46H90" fill="none" stroke="#7aa2ff" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/><circle cx="96" cy="40" r="13" fill="#ff3d8b" stroke="#fff" stroke-width="5"/></svg>';

export function mountLauncher(win: Window, api: { count(): Promise<number>; open(): void; hide(): void }, options: Options = {}) {
  const doc = win.document;
  const trusted = options.trusted ?? ((event: Event) => event.isTrusted);
  const host = doc.createElement('div');
  host.dataset.stepnoteUi = '';
  host.setAttribute('style', 'position: fixed; inset: auto 0 0 auto; width: 0; height: 0; z-index: 2147483645; pointer-events: none;');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${styles}</style><div class="wrap"><button class="open" type="button" aria-label="Open Stepnote">${mark}<span class="count" hidden></span></button><button class="hide" type="button" aria-label="Hide the Stepnote button on this site" title="Hide on this site">×</button></div>`;
  doc.documentElement.append(host);
  const open = root.querySelector<HTMLButtonElement>('.open')!;
  open.addEventListener('click', event => { if (trusted(event)) api.open(); });
  root.querySelector('.hide')!.addEventListener('click', event => { if (!trusted(event)) return; api.hide(); host.remove(); });
  const ready = api.count().then(n => {
    const count = root.querySelector<HTMLElement>('.count')!;
    count.hidden = n <= 0;
    count.textContent = n > 99 ? '99+' : String(n);
    open.setAttribute('aria-label', n > 0 ? `Open Stepnote, ${n} ${n === 1 ? 'guide' : 'guides'} for this site` : 'Open Stepnote');
  }, () => {});
  return { root, ready, destroy: () => host.remove() };
}

// Dynamic content script for the button: on, with site access, minus excluded sites.
export function launcherRegistration(settings: Settings, siteAccess: boolean): chrome.scripting.RegisteredContentScript | null {
  if (!settings.launcher || !siteAccess) return null;
  return {
    id: 'stepnote-launcher', js: ['launcher.js'], matches: ['http://*/*', 'https://*/*'],
    excludeMatches: settings.excludedDomains.map(domain => `*://${domain}/*`),
    runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
  };
}

// What to do with the button on tabs that are already open: remove it where
// it should no longer be, add it where it should now be.
export function launcherActions(tabs: { id?: number; url?: string }[], settings: Settings, siteAccess: boolean): { tabId: number; action: 'inject' | 'remove' }[] {
  const actions: { tabId: number; action: 'inject' | 'remove' }[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url || !/^https?:\/\//.test(tab.url)) continue;
    let host = '';
    try { host = new URL(tab.url).hostname; } catch { continue; }
    const wanted = !!launcherRegistration(settings, siteAccess) && !settings.excludedDomains.includes(host);
    actions.push({ tabId: tab.id, action: wanted ? 'inject' : 'remove' });
  }
  return actions;
}
