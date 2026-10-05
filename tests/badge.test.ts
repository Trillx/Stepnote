import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeFor } from '../src/badge.ts';
import type { State } from '../src/recorder.ts';

const r = (status: 'recording' | 'paused' | 'stopped') => ({ recording: { status } } as unknown as State);
test('the badge shows errors, then capture state, then the guide count for the site', () => {
  assert.deepEqual(badgeFor({ recording: null, error: 'x' }, 3), { text: '!', color: '#b4232c' });
  assert.deepEqual(badgeFor(r('recording'), 3), { text: 'REC', color: '#c2413a' });
  assert.deepEqual(badgeFor(r('paused'), 3), { text: 'PAUSE', color: '#6b5bd6' });
  assert.deepEqual(badgeFor(r('stopped'), 3), { text: '3', color: '#3d63c9' });
  assert.deepEqual(badgeFor({ recording: null }, 0), { text: '', color: '#3d63c9' });
  assert.deepEqual(badgeFor({ recording: null }, 120), { text: '99+', color: '#3d63c9' });
});
