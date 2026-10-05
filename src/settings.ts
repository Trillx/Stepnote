// Extension settings, kept in chrome.storage.local under `settings`.
export interface Settings {
  // Toolbar badge with the number of guides for the current site.
  documentCount: boolean;
  // Floating on-screen Stepnote button on web pages.
  launcher: boolean;
  // Sites where the floating button is hidden.
  excludedDomains: string[];
  // 'page': side panel plus a Pause/Complete bar on the page; 'panel': side panel only.
  captureControls: 'page' | 'panel';
  // Tidy up steps when a capture completes.
  tidy: boolean;
}
export const defaultSettings: Settings = { documentCount: true, launcher: true, excludedDomains: [], captureControls: 'page', tidy: true };

// The host part of whatever was typed: a full address, a host, or host/path.
export function domainOf(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text || /\s/.test(text)) return null;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
    if (host === 'localhost') return host;
    // URL parsing already rejects out-of-range IPv4 parts.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    return /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(host) ? host : null;
  } catch { return null; }
}

export function normalizeSettings(value: unknown): Settings {
  const v = (value ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const bool = (key: 'documentCount' | 'launcher' | 'tidy') => typeof v[key] === 'boolean' ? v[key] as boolean : defaultSettings[key];
  const domains = Array.isArray(v.excludedDomains) ? v.excludedDomains : [];
  const excluded = [...new Set(domains.filter((d): d is string => typeof d === 'string').map(domainOf).filter((d): d is string => !!d))].slice(0, 200);
  return {
    documentCount: bool('documentCount'),
    launcher: bool('launcher'),
    excludedDomains: excluded,
    captureControls: v.captureControls === 'panel' ? 'panel' : 'page',
    tidy: bool('tidy'),
  };
}
