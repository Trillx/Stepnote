// On-page capture controls: a small pill with the step count, Full page,
// Pause and Complete. Hidden while each screenshot is taken; never recorded as a step.
interface Options { trusted?: (event: Event) => boolean }
const styles = `
:host { all: initial; }
.bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border: 1px solid #2a3440; border-radius: 999px; background: #171d24; color: #e8edf2; box-shadow: 0 12px 34px rgba(0, 0, 0, .45); font: 600 13px/1.2 "Segoe UI", system-ui, -apple-system, sans-serif; pointer-events: auto; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ff7a6b; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.count { color: #9ba7b3; font-weight: 600; min-width: 4.5em; }
button { min-height: 30px; padding: 5px 12px; border: 1px solid #3b4756; border-radius: 999px; background: #1f2731; color: #e8edf2; font: 700 12.5px/1 "Segoe UI", system-ui, sans-serif; cursor: pointer; }
button:hover { background: #26303c; }
.complete { background: #eef1f4; border-color: #eef1f4; color: #0f1318; }
.complete:hover { background: #ffffff; }
button:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
`;
export function mountCaptureBar(win: Window, api: { pause(): void; complete(): void; fullPage?(): void }, options: Options = {}) {
  const doc = win.document;
  const trusted = options.trusted ?? ((event: Event) => event.isTrusted);
  const host = doc.createElement('div');
  host.dataset.stepnoteUi = '';
  host.setAttribute('style', 'position: fixed; inset: auto 0 0 0; height: 0; z-index: 2147483646; pointer-events: none;');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${styles}</style><div class="bar" role="toolbar" aria-label="Stepnote capture"><span class="dot" aria-hidden="true"></span><span class="label">Recording</span><span class="count" aria-live="polite">0 steps</span><button class="full" type="button" title="Scroll and capture the whole page">Full page</button><button class="pause" type="button">Pause</button><button class="complete" type="button">Complete</button></div>`;
  doc.documentElement.append(host);
  root.querySelector('.pause')!.addEventListener('click', event => { if (trusted(event)) api.pause(); });
  root.querySelector('.full')!.addEventListener('click', event => { if (trusted(event)) api.fullPage?.(); });
  root.querySelector('.complete')!.addEventListener('click', event => { if (trusted(event)) api.complete(); });
  return {
    root,
    setCount(n: number) { root.querySelector('.count')!.textContent = `${n} ${n === 1 ? 'step' : 'steps'}`; },
    // A short message in place of the count, with the detail on hover.
    notice(text: string, detail = '') {
      const count = root.querySelector<HTMLElement>('.count')!, previous = count.textContent;
      count.textContent = text; count.title = detail;
      win.setTimeout(() => { if (count.textContent === text) { count.textContent = previous; count.title = ''; } }, 5000);
    },
    hide() { host.style.visibility = 'hidden'; },
    show() { host.style.visibility = ''; },
    destroy() { host.remove(); },
  };
}
