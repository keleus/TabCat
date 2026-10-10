import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { handleNetworkMessage } from '../lib/network.js';
import { installWallpaperRotation } from '../lib/wallpaper-rotation.js';
import { loadState } from '../lib/storage.js';
import { pinCatalogSite } from '../lib/site-catalog.js';
import { mergeState, pinSite } from '../lib/state.js';

export default defineBackground(() => {
  installWallpaperRotation({ alarms: browser.alarms, storage: browser.storage, refresh: handleNetworkMessage });
  // Serialize writes from every new-tab page and popup in one place.
  let queue = Promise.resolve();
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== browser.runtime.id || (sender.url && !sender.url.startsWith(browser.runtime.getURL('/')))) return;
    if (['tabcat:suggest', 'tabcat:bing', 'tabcat:gallery', 'tabcat:icon-document'].includes(message?.type)) {
      handleNetworkMessage(message).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (!['tabcat:commit', 'tabcat:pin', 'tabcat:catalog-pin'].includes(message?.type)) return;
    queue = queue.then(async () => {
      try {
        const current = await loadState();
        if (message.type === 'tabcat:pin' || message.type === 'tabcat:catalog-pin') {
          const { state, site, duplicate } = message.type === 'tabcat:catalog-pin' ? pinCatalogSite(current, message.id) : pinSite(current, message.site);
          if (!duplicate) await browser.storage.local.set({ tabcat: state });
          respond({ ok: true, site, duplicate });
        } else {
          const state = mergeState(current, message.before, message.after);
          await browser.storage.local.set({ tabcat: state });
          respond({ ok: true });
        }
      } catch (error) { respond({ ok: false, error: error.message }); }
    });
    return true;
  });
});
