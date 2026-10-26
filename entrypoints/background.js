import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { handleNetworkMessage } from '../lib/network.js';
import { installWallpaperRotation } from '../lib/wallpaper-rotation.js';
import { loadState, saveState, saveLocalState } from '../lib/storage.js';
import { pinCatalogSite } from '../lib/site-catalog.js';
import { mergeState, pinSite } from '../lib/state.js';
import { createSync, SYNC_CHUNK, SYNC_RETRY_ALARM } from '../lib/sync.js';
import { createIconSync, WEBDAV_RETRY_ALARM } from '../lib/webdav.js';

export default defineBackground(() => {
  installWallpaperRotation({ alarms: browser.alarms, storage: browser.storage, refresh: handleNetworkMessage });
  // Serialize writes from every new-tab page, popup and sync in one place.
  let queue = Promise.resolve();
  const enqueue = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };
  const sync = createSync({ storage: browser.storage, alarms: browser.alarms, enqueue, loadState, saveState });
  const icons = createIconSync({ storage: browser.storage, alarms: browser.alarms, fetch: (...args) => fetch(...args), enqueue, loadState, saveState });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.tabcat) { sync.schedule(); icons.schedule(); }
    if (area === 'sync' && Object.keys(changes).some(key => key.startsWith(SYNC_CHUNK))) void sync.reconcile();
  });
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === SYNC_RETRY_ALARM) void sync.reconcile({ retry: true });
    if (alarm.name === WEBDAV_RETRY_ALARM) void icons.reconcile({ retry: true });
  });
  // Sync runs only when something changed. Change events wake a suspended
  // worker, so a worker restart (e.g. for the wallpaper alarm) does not sync;
  // a browser launch or extension update catches up once.
  const catchUp = () => { void sync.reconcile(); void icons.reconcile(); };
  browser.runtime.onStartup.addListener(catchUp);
  browser.runtime.onInstalled.addListener(catchUp);
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== browser.runtime.id || (sender.url && !sender.url.startsWith(browser.runtime.getURL('/')))) return;
    if (['tabcat:suggest', 'tabcat:bing', 'tabcat:gallery', 'tabcat:icon-document', 'tabcat:icon-image'].includes(message?.type)) {
      handleNetworkMessage(message).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'tabcat:sync-peek') {
      sync.peek().then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'tabcat:sync-enable' || message?.type === 'tabcat:sync-now') {
      (message.type === 'tabcat:sync-now' ? sync.reconcile() : sync.setEnabled(Boolean(message.enabled), message.mode))
        .then(() => sync.settings()).then(settings => respond({ ok: true, settings }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (['tabcat:webdav-save', 'tabcat:webdav-sync', 'tabcat:webdav-clear'].includes(message?.type)) {
      const action = { 'tabcat:webdav-save': () => icons.save(message.config || {}), 'tabcat:webdav-sync': () => icons.reconcile(), 'tabcat:webdav-clear': () => icons.clear() }[message.type];
      action().then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (!['tabcat:commit', 'tabcat:pin', 'tabcat:catalog-pin'].includes(message?.type)) return;
    void enqueue(async () => {
      try {
        const current = await loadState();
        if (message.type === 'tabcat:pin' || message.type === 'tabcat:catalog-pin') {
          const { state, site, duplicate } = message.type === 'tabcat:catalog-pin' ? pinCatalogSite(current, message.id) : pinSite(current, message.site);
          if (!duplicate) await saveLocalState(current, state);
          respond({ ok: true, site, duplicate });
        } else {
          const state = mergeState(current, message.before, message.after);
          await saveLocalState(current, state);
          respond({ ok: true });
        }
      } catch (error) { respond({ ok: false, error: error.message }); }
    });
    return true;
  });
});
