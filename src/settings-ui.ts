import { domainOf, normalizeSettings, type Settings } from './settings.ts';

export interface SettingsApi {
  load(): Promise<Settings>;
  save(settings: Settings): Promise<void>;
}
const toggle = (name: keyof Settings, title: string, help: string) =>
  `<label class="setting"><span class="setting-text"><span class="setting-name">${title}</span><span class="setting-help">${help}</span></span><input type="checkbox" role="switch" name="${name}"></label>`;
const choice = (value: Settings['captureControls'], title: string, help: string) =>
  `<label class="choice"><input type="radio" name="captureControls" value="${value}"><span class="setting-text"><span class="setting-name">${title}</span><span class="setting-help">${help}</span></span></label>`;

// Settings view inside the side panel. Every change saves immediately.
export async function mountSettings(section: HTMLElement, api: SettingsApi, close: () => void): Promise<void> {
  const doc = section.ownerDocument;
  section.innerHTML = `<div class="settings-top"><button id="settings-back" type="button" aria-label="Back to Stepnote"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg></button><h2 id="settings-title">Settings</h2></div>
    <section class="setting-group"><h3>Extension</h3>
      ${toggle('documentCount', 'Guide count', 'Show how many of your guides match the current site on the toolbar icon.')}
    </section>
    <section class="setting-group"><h3>On-screen button</h3>
      ${toggle('launcher', 'Stepnote button', 'Show a small button on web pages that opens the side panel.')}
      <div class="setting"><span class="setting-text"><span class="setting-name" id="excluded-count">Hidden on sites (0)</span><span class="setting-help">Sites where the on-screen button is not shown.</span></span><button id="manage-domains" type="button" aria-expanded="false" aria-controls="domains">Manage</button></div>
      <div id="domains" hidden>
        <ul id="domain-list"></ul>
        <form id="domain-form"><input id="domain-input" type="text" placeholder="example.com" aria-label="Site to hide the button on" autocomplete="off"><button type="submit">Add</button></form>
        <p id="domain-error" role="alert"></p>
      </div>
    </section>
    <section class="setting-group"><h3>Capture controls</h3>
      ${choice('page', 'Side panel and on-screen controls', 'Show a small Pause and Complete bar on the page while capturing.')}
      ${choice('panel', 'Side panel only', 'Control capture from the side panel only.')}
    </section>
    <section class="setting-group">
      ${toggle('tidy', 'Tidy up steps', 'When a capture completes, merge a field click with the typing that follows it and remove accidental double clicks. Runs on this device.')}
    </section>
    <p class="settings-note">Guide count, the on-screen button and walkthroughs across pages use the site access Stepnote asks for when you start a capture.</p>`;
  const $ = <T extends HTMLElement>(selector: string) => section.querySelector<T>(selector)!;
  let settings = normalizeSettings(await api.load().catch(() => undefined));
  const save = async (next: Settings) => {
    settings = normalizeSettings(next);
    render();
    try { await api.save(settings); } catch (error) { $('#domain-error').textContent = `Settings not saved: ${String(error).replace(/^Error: /, '')}`; }
  };
  function render() {
    for (const input of section.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) input.checked = settings[input.name as 'documentCount' | 'launcher' | 'tidy'];
    for (const input of section.querySelectorAll<HTMLInputElement>('input[name="captureControls"]')) input.checked = input.value === settings.captureControls;
    $('#excluded-count').textContent = `Hidden on sites (${settings.excludedDomains.length})`;
    $('#domain-list').replaceChildren(...settings.excludedDomains.map(domain => {
      const item = doc.createElement('li');
      const name = doc.createElement('span'); name.textContent = domain;
      const remove = doc.createElement('button'); remove.type = 'button'; remove.dataset.remove = domain; remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Show the button on ${domain} again`);
      remove.addEventListener('click', () => void save({ ...settings, excludedDomains: settings.excludedDomains.filter(d => d !== domain) }));
      item.append(name, remove);
      return item;
    }));
  }
  section.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.type === 'checkbox') void save({ ...settings, [input.name]: input.checked });
    if (input.name === 'captureControls' && input.checked) void save({ ...settings, captureControls: input.value as Settings['captureControls'] });
  });
  $('#manage-domains').addEventListener('click', () => {
    const open = $('#domains').hidden;
    $('#domains').hidden = !open; $('#manage-domains').setAttribute('aria-expanded', String(open));
    if (open) $<HTMLInputElement>('#domain-input').focus();
  });
  $('#domain-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = $<HTMLInputElement>('#domain-input');
    const domain = domainOf(input.value);
    if (!domain) { $('#domain-error').textContent = 'Enter a site domain, like example.com.'; return; }
    $('#domain-error').textContent = '';
    input.value = '';
    if (!settings.excludedDomains.includes(domain)) void save({ ...settings, excludedDomains: [...settings.excludedDomains, domain] });
  });
  $('#settings-back').addEventListener('click', close);
  render();
}
