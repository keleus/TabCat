import { browser } from 'wxt/browser';
import { normalizeState } from './state.js';

export async function loadState() {
  const { tabcat } = await browser.storage.local.get('tabcat');
  return normalizeState(tabcat);
}

async function send(message) {
  const result = await browser.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台暂不可用，请重新加载扩展');
  return result;
}

export function commitState(before, after) {
  return send({ type: 'tabcat:commit', before, after });
}

export function addPinnedSite(site) {
  return send({ type: 'tabcat:pin', site });
}

export function watchState(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes.tabcat) callback(normalizeState(changes.tabcat.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export function addCatalogSite(id) {
  return send({ type: 'tabcat:catalog-pin', id });
}

export function setSyncEnabled(enabled) {
  return send({ type: 'tabcat:sync-enable', enabled });
}

export function syncNow() {
  return send({ type: 'tabcat:sync-now' });
}

export function saveWebdav(config) {
  return send({ type: 'tabcat:webdav-save', config });
}

export function syncWebdav() {
  return send({ type: 'tabcat:webdav-sync' });
}

export function clearWebdav() {
  return send({ type: 'tabcat:webdav-clear' });
}
