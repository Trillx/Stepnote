import { mountPopup } from './popup-ui.ts';
import { request } from './client.ts';
void mountPopup(document.querySelector<HTMLElement>('#app')!, request,
  () => { void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }); });
