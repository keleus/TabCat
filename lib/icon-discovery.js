import { browser } from 'wxt/browser';
import { normalizeUrl, normalizeFavicon } from './state.js';
import { collectPageLogos, rasterizeLogo, isHomepageLogoUrl } from './page-logos.js';

import { collectFaviconLinks, rankFavicons } from './favicon-quality.js';

const pending = new Map();
const cache = new Map();
function absolute(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try { return normalizeUrl(new URL(value, base).href); } catch { return ''; }
}
export function pageIconLinks(doc, url) {
  const base = absolute(doc.querySelector('base[href]')?.getAttribute('href') || url, url) || url;
  return { logos: collectPageLogos(doc, base, false), ...collectFaviconLinks(doc, base), base };
}

async function fetchDocument(url) {
  const result = await browser.runtime.sendMessage({ type: 'tabcat:icon-document', url });
  if (!result?.ok) throw new Error(result?.error || '无法读取图标');
  return result;
}

export async function discoverArtwork(url, livePage, { force = false } = {}) {
  url = normalizeUrl(url); if (!url) return { logos: [], icons: [] };
  if (!livePage && !force && cache.get(url)?.expires > Date.now()) return cache.get(url).artwork;
  if (!livePage && pending.has(url)) return pending.get(url);
  const task = (async () => {
    const key = `site-artwork-v4:${url}`;
    try {
      if (!livePage && !force) {
        const { tabcatIconCache = {} } = await browser.storage.local.get('tabcatIconCache');
        const stored = tabcatIconCache[key];
        if (stored?.expires > Date.now()) { cache.set(url, stored); return stored.artwork; }
      }
      let page = livePage;
      if (!page) {
        const result = await fetchDocument(url);
        // DOMParser creates an inert document; page scripts are never executed.
        page = pageIconLinks(new DOMParser().parseFromString(result.document, 'text/html'), result.url);
      }
      // A deep link may not carry the site's branding. Try its homepage too.
      if (!page.logos?.length && new URL(url).pathname !== '/') {
        try {
          const result = await fetchDocument(new URL('/', url).href);
          const homepage = pageIconLinks(new DOMParser().parseFromString(result.document, 'text/html'), result.url);
          page = { ...homepage, icons: [...(page.icons || []), ...homepage.icons], manifest: page.manifest || homepage.manifest };
        } catch {}
      }
      const logos = [];
      for (const candidate of (page.logos || []).slice(0, 16)) {
        const image = candidate.svg ? await rasterizeLogo(candidate.svg) : candidate.url;
        const safe = normalizeFavicon(image);
        if (safe && isHomepageLogoUrl(safe) && !logos.includes(safe)) logos.push(safe);
        if (logos.length >= 4) break;
      }
      const candidates = [...(page.icons || [])];
      if (page.manifest) {
        try {
          const result = await fetchDocument(page.manifest);
          const manifest = JSON.parse(result.document);
          for (const item of (Array.isArray(manifest.icons) ? manifest.icons : []).slice(0, 20)) {
            const source = absolute(item.src, result.url);
            if (source) candidates.push({ url: source, sizes: item.sizes, type: item.type });
          }
        } catch {}
      }
      if (!candidates.length) candidates.push({ url: new URL('/favicon.ico', page.base || url).href });
      const icons = rankFavicons(candidates).map(normalizeFavicon).filter(Boolean);
      const artwork = { logos, icons };
      const entry = { artwork, expires: Date.now() + (icons.length || logos.length ? 86400000 : 600000) };
      cache.set(url, entry);
      // Bound both count and bytes, since sanitized inline SVGs become PNG data.
      const { tabcatIconCache = {} } = await browser.storage.local.get('tabcatIconCache');
      const entries = [...Object.entries(tabcatIconCache).filter(([old]) => old !== key).slice(-99), [key, entry]];
      while (entries.length > 1 && JSON.stringify(entries).length > 800000) entries.shift();
      await browser.storage.local.set({ tabcatIconCache: Object.fromEntries(entries) }).catch(() => {});
      return artwork;
    } catch { return { logos: [], icons: [] }; }
  })().finally(() => pending.delete(url));
  pending.set(url, task); return task;
}

export async function collectTabIcons(tabId) {
  try {
    const [[logos], [links]] = await Promise.all([
      browser.scripting.executeScript({ target: { tabId }, func: collectPageLogos }),
      browser.scripting.executeScript({ target: { tabId }, func: collectFaviconLinks }),
    ]);
    return logos?.result ? { logos: logos.result, ...links?.result } : undefined;
  } catch { return undefined; }
}
