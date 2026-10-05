import { sameSite, type GuideSummary } from './library.ts';

export interface LibraryApi {
  list(): Promise<GuideSummary[]>;
  open(id: string): void;
  // Calls back when guides change elsewhere, such as a deletion in the editor.
  subscribe?(listener: () => void): void;
  // The site in the active tab, when it can be read; enables "On this site".
  currentHost?(): Promise<string | null>;
  // Chrome's icon for a site, for guides saved before icons were kept.
  faviconFor?(host: string): string;
  // Starts the on-screen walkthrough for a guide.
  guideMe?(id: string): void | Promise<void>;
}
// Searchable guide list for the side panel home and the editor page.
export async function mountLibrary(root: HTMLElement, api: LibraryApi): Promise<{ refresh(): Promise<void> }> {
  const doc = root.ownerDocument;
  const section = doc.createElement('section');
  section.className = 'library';
  section.setAttribute('aria-labelledby', 'library-title');
  section.innerHTML = `<section class="site-guides" aria-labelledby="site-title" hidden><h2 id="site-title">On this site</h2><ul class="guide-list site-list"></ul></section>
    <div class="library-head"><label class="library-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg><input type="search" placeholder="Search guides" aria-label="Search guides"></label>
    <h2 id="library-title">Your guides</h2></div>
    <ul class="guide-list"></ul><p class="library-empty" role="status"></p>`;
  root.append(section);
  const search = section.querySelector<HTMLInputElement>('input')!;
  const list = section.querySelector<HTMLElement>('.guide-list:not(.site-list)')!;
  const siteBlock = section.querySelector<HTMLElement>('.site-guides')!;
  const siteList = section.querySelector<HTMLElement>('.site-list')!;
  const empty = section.querySelector<HTMLElement>('.library-empty')!;
  let guides: GuideSummary[] = [];
  const date = (value: number) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  function filter() {
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const item of list.children as HTMLCollectionOf<HTMLElement>) {
      const guide = guides.find(g => g.id === item.dataset.id);
      item.hidden = !guide || !terms.every(term => guide.search.includes(term) || guide.title.toLowerCase().includes(term));
      if (!item.hidden) shown++;
    }
    empty.textContent = !guides.length ? 'Guides you complete are saved here.' : shown ? '' : `No guides match “${search.value.trim()}”.`;
  }
  async function refresh() {
    try { guides = await api.list(); }
    catch (error) { empty.textContent = `Guides could not be loaded: ${String(error).replace(/^Error: /, '')}`; return; }
    list.replaceChildren(...guides.map(guide => row(guide, false)));
    const host = await api.currentHost?.().catch(() => null) ?? null;
    const here = host ? guides.filter(guide => sameSite(guide.host, host)) : [];
    siteList.replaceChildren(...here.map(guide => row(guide, true)));
    siteBlock.hidden = !here.length;
    siteBlock.querySelector('h2')!.textContent = `On this site (${here.length})`;
    filter();
  }
  function row(guide: GuideSummary, withGuideMe: boolean): HTMLElement {
      const item = doc.createElement('li'); item.dataset.id = guide.id;
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'guide-item'; button.dataset.id = guide.id;
      // Monogram: the site's first letter (without www); for addresses with
      // no name (an IP address), the title's.
      const avatar = doc.createElement('span'); avatar.className = 'guide-avatar'; avatar.setAttribute('aria-hidden', 'true');
      const site = (guide.host ?? '').replace(/^www\./, '');
      const letter = (/^[a-z]/i.test(site) ? site : guide.title).trim().charAt(0).toUpperCase() || '·';
      const icon = guide.favicon ?? (guide.host && api.faviconFor ? api.faviconFor(guide.host) : undefined);
      if (icon) {
        // The site's icon; the letter again if it cannot be shown.
        const img = doc.createElement('img'); img.alt = ''; img.src = icon;
        img.addEventListener('error', () => { img.remove(); avatar.textContent = letter; avatar.classList.remove('has-icon'); });
        avatar.classList.add('has-icon'); avatar.append(img);
      } else avatar.textContent = letter;
      const title = doc.createElement('span'); title.className = 'guide-title'; title.textContent = guide.title;
      const meta = doc.createElement('span'); meta.className = 'guide-meta';
      const chip = doc.createElement('span'); chip.className = 'guide-chip';
      chip.textContent = `${guide.steps} ${guide.steps === 1 ? 'step' : 'steps'}`;
      meta.append(chip, doc.createTextNode(` ${date(guide.startedAt)}`));
      button.append(avatar, title, meta);
      if (guide.active) { const badge = doc.createElement('span'); badge.className = 'guide-badge'; badge.textContent = 'Current'; button.append(badge); }
      button.addEventListener('click', () => api.open(guide.id));
      item.append(button);
      if (withGuideMe && api.guideMe) {
        item.classList.add('with-action');
        const go = doc.createElement('button'); go.type = 'button'; go.className = 'guide-me'; go.dataset.guideMe = guide.id;
        go.textContent = 'Guide me'; go.setAttribute('aria-label', `Guide me through ${guide.title}`);
        go.addEventListener('click', () => {
          void Promise.resolve(api.guideMe!(guide.id)).catch(error => { empty.textContent = `Guide me could not start: ${String(error).replace(/^Error: /, '')}`; });
        });
        item.append(go);
      }
      return item;
  }
  search.addEventListener('input', filter);
  api.subscribe?.(() => void refresh());
  await refresh();
  return { refresh };
}
