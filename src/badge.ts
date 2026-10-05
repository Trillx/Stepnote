import type { State } from './recorder.ts';

// Toolbar badge: an error first, then the capture state, then how many of
// your guides match the site in the active tab.
export function badgeFor(state: State, siteGuides: number): { text: string; color: string } {
  if (state.error) return { text: '!', color: '#b4232c' };
  if (state.recording?.status === 'recording') return { text: 'REC', color: '#c2413a' };
  if (state.recording?.status === 'paused') return { text: 'PAUSE', color: '#6b5bd6' };
  return { text: siteGuides > 99 ? '99+' : siteGuides > 0 ? String(siteGuides) : '', color: '#3d63c9' };
}
