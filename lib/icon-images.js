import { browser } from 'wxt/browser';
import { createIconCache } from './icon-cache.js';
import { resizeToDataUrl, dataUrlToBlob } from './image-resize.js';

// The extension downloads icon addresses itself (see handleNetworkMessage), so
// the host only sees one request and never the user's cookies or referrer.
export const iconImages = createIconCache({
  storage: browser.storage,
  async fetchImage(url) {
    const result = await browser.runtime.sendMessage({ type: 'tabcat:icon-image', url });
    if (!result?.ok) throw new Error(result?.error || '无法下载图标');
    return result.image;
  },
  shrink: image => resizeToDataUrl(dataUrlToBlob(image)),
});
