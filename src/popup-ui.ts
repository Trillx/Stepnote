import type { State } from './recorder.ts';
export type Request = (type: string) => Promise<State>;

export async function mountPopup(root: HTMLElement, request: Request, openViewer: () => void): Promise<void> {
  root.innerHTML = `<p class="eyebrow">Stepnote</p><h1>Capture your steps</h1>
    <p id="status" role="status" aria-live="polite">Loading...</p>
    <p id="error" role="alert"></p>
    <div class="actions"><button id="start" disabled>Start recording</button><button id="stop" disabled>Stop recording</button></div>
    <button id="view">View saved SOP</button>
    <p>Records clicks and ordinary text entry in the tab in focus, following new tabs and page loads when web access is allowed. No iframe recording.</p>
    <p class="warning">Ordinary typed entries are saved locally and included in exports. Recognized credential and payment fields are excluded from entry metadata. Screenshots can still contain sensitive information. No automatic redaction. Review before sharing.</p>
    <p>One local recording at a time. Export and delete it before starting another.</p>`;
  const start = root.querySelector<HTMLButtonElement>('#start')!;
  const stop = root.querySelector<HTMLButtonElement>('#stop')!;
  const status = root.querySelector<HTMLElement>('#status')!;
  const error = root.querySelector<HTMLElement>('#error')!;
  async function run(type: string) {
    start.disabled = stop.disabled = true;
    try {
      const state = await request(type);
      const r = state.recording;
      status.textContent = r ? `${r.status === 'recording' ? 'Recording' : 'Stopped'}: ${r.steps.length} steps. ${r.stoppedReason ?? ''}` : 'Ready. Open a normal HTTP or HTTPS page to record.';
      error.textContent = state.error ?? '';
      start.disabled = !!r;
      stop.disabled = r?.status !== 'recording';
    } catch (cause) { error.textContent = String(cause); start.disabled = false; }
  }
  start.addEventListener('click', () => void run('START'));
  stop.addEventListener('click', () => void run('STOP'));
  root.querySelector('#view')!.addEventListener('click', openViewer);
  await run('STATUS');
}
