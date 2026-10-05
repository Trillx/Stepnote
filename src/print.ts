import { send } from './client.ts';
import { guideTitle, sopBody, sopStyles } from './sop.ts';

// Print-ready guide for Chrome's "Save as PDF". sopBody escapes all content.
async function main() {
  const style = document.createElement('style');
  style.textContent = sopStyles;
  document.head.append(style);
  const root = document.querySelector<HTMLElement>('main')!;
  document.querySelector('#print')!.addEventListener('click', () => window.print());
  try {
    const guideId = new URLSearchParams(location.search).get('guide');
    const { recording } = await send(guideId ? { type: 'GET_GUIDE', guideId } : { type: 'STATUS' });
    if (!recording) throw new Error('No saved guide to print.');
    document.title = guideTitle(recording);
    root.innerHTML = sopBody(recording);
    await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
    window.print();
  } catch (error) {
    root.textContent = String(error).replace(/^Error: /, '');
  }
}
void main();
