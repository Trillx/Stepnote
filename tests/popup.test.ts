import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as ui from '../src/popup-ui.ts';
import type { State } from '../src/recorder.ts';

test('popup exposes explicit start/stop with visible state and privacy warning', async () => {
  const dom = new JSDOM('<main></main>');
  assert.equal(typeof ui.mountPopup, 'function');
  let state: State = { recording: null };
  const commands: string[] = [];
  let opened = false;
  const request = async (type: string) => {
    commands.push(type);
    if (type === 'START') state = { recording: { title: 'Test', status: 'recording', steps: [] } as any };
    if (type === 'STOP') state.recording!.status = 'stopped';
    return structuredClone(state);
  };
  const main = dom.window.document.querySelector('main')!;
  await ui.mountPopup(main, request, () => { opened = true; });
  const button = (id: string) => main.querySelector<HTMLButtonElement>(id)!;
  assert.equal(button('#stop').disabled, true);
  assert.match(main.textContent!, /screenshots.*sensitive/i);
  button('#start').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(main.querySelector('#status')!.textContent!, /Recording/);
  assert.equal(button('#start').disabled, true);
  button('#stop').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(main.querySelector('#status')!.textContent!, /Stopped/);
  button('#view').click();
  assert.equal(opened, true);
  assert.deepEqual(commands, ['STATUS', 'START', 'STOP']);
  dom.window.close();
});
