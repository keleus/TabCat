import { isHomepageLogoUrl } from './page-logos.js';
import { catalogIcon, catalogLogo, catalogIconBackground, catalogFavicon, siteImageScale } from './site-catalog.js';
import { discoverArtwork } from './icon-discovery.js';
import { brandIcon } from './brand-icons.js';
import { engineIcon } from './search.js';
import { siteArtwork, contrastTextColor } from './appearance.js';
import { normalizeUrl, normalizeFavicon } from './state.js';
import { getResolvedIcon, rememberResolvedIcon, resolvedIconKey } from './resolved-icons.js';
import { iconImages } from './icon-images.js';

import { requiredFaviconPixels, isSharpFavicon } from './favicon-quality.js';

const renders = new WeakMap();
const decodedImages = new Map();

async function loadImage(url) {
  if (!decodedImages.has(url)) {
    const pending = new Promise(resolve => {
      const image = new Image();
      image.alt = ''; image.draggable = false; image.referrerPolicy = 'no-referrer';
      const finish = result => { clearTimeout(timer); image.onload = image.onerror = null; if (!result) image.removeAttribute('src'); resolve(result); };
      const timer = setTimeout(() => finish(null), 4000);
      image.onload = () => { image.decode().then(() => finish(image.naturalWidth ? image : null), () => finish(null)); };
      image.onerror = () => finish(null);
      image.src = url;
    });
    decodedImages.set(url, pending);
    if (decodedImages.size > 128) decodedImages.delete(decodedImages.keys().next().value);
    pending.then(image => { if (!image && decodedImages.get(url) === pending) decodedImages.delete(url); });
  }
  const loaded = await decodedImages.get(url);
  if (!loaded) return null;
  // Each container owns a node; all nodes share the decoded browser resource.
  const image = loaded.cloneNode();
  try { await image.decode(); return image; } catch { return null; }
}

// A render token prevents a slow logo from replacing a newer form preview.
export function renderSiteIcon(container, site, options = {}) {
  const size = container.getBoundingClientRect().width || Number(site.iconSize) || 72;
  const requiredPixels = requiredFaviconPixels(size, siteImageScale(site), window.devicePixelRatio || 1);
  options = { ...options, requiredPixels };
  const key = resolvedIconKey(site, options.engine, requiredPixels);
  const signature = JSON.stringify([key, site.name, site.color, Boolean(options.discover)]);
  const previous = renders.get(container);
  if (!options.refresh && previous?.signature === signature) return previous.task;
  const token = { signature }; renders.set(container, token);
  token.task = renderIcon(container, site, options, token, key);
  return token.task;
}

async function renderIcon(container, site, options, token, key) {
  const artwork = siteArtwork(site);
  const local = options.engine || site.iconText ? '' : catalogIcon(site.url);
  container.style.setProperty('--tile-color', artwork.color);
  container.style.setProperty('--auto-text-color', contrastTextColor(artwork.color));
  const fallback = () => {
    container.classList.remove('has-image', 'icon-loading');
    container.classList.toggle('text-icon', !artwork.markup);
    if (artwork.markup) container.innerHTML = artwork.markup;
    else container.textContent = artwork.text || '?';
  };
  if (site.iconText || (!site.icon && (site.builtin || !normalizeUrl(site.url)))) { fallback(); return; }
  // Never paint a temporary letter/colored tile. When switching an existing
  // image, keep it in place until its replacement has decoded.
  if (!container.querySelector('img')) {
    container.replaceChildren(); container.classList.remove('has-image', 'text-icon');
    container.classList.add('icon-loading');
  }
  const active = () => container.isConnected && renders.get(container) === token;
  const tried = new Set();
  let successfulSource = '';
  let successfulKind = 'logo';
  // An uploaded image is already stored with the site; repeating it in the
  // resolved-icon cache would only push smaller entries out.
  let remember = true;
  // How the user's own image was shown, for the editor's status line:
  // cache (downloaded address), inline (upload), direct (e.g. SVG) or auto.
  let origin = 'auto';
  const tryIcon = async (url, kind = 'manual') => {
    const isLogo = kind === 'logo';
    const attempt = `${kind}:${url}`;
    if (!url || (isLogo && !isHomepageLogoUrl(url)) || tried.has(attempt) || !active()) return false;
    tried.add(attempt);
    if (options.refresh) decodedImages.delete(url);
    const image = await loadImage(url);
    if (!image || !active()) return false;
    if (kind === 'favicon' && !isSharpFavicon(url, image.naturalWidth, image.naturalHeight, options.requiredPixels)) return false;
    // Header wordmarks remain valid branding; contain them instead of cropping
    // them or replacing them with an unrelated browser favicon.
    if (isLogo && Math.max(image.naturalWidth / image.naturalHeight, image.naturalHeight / image.naturalWidth) > 1.8) image.style.objectFit = 'contain';
    // Match the library card, which always contains bundled artwork.
    if (kind === 'catalog' && !site.imageFit) image.style.objectFit = 'contain';
    container.replaceChildren(image); container.classList.add('has-image');
    container.classList.remove('icon-loading', 'text-icon');
    if (kind !== 'manual' && !site.color) container.style.setProperty('--tile-color', url.startsWith('/catalog/') ? catalogIconBackground(site.url, url) : '#ffffff');
    successfulSource = url; successfulKind = kind;
    return true;
  };
  try {
    // User overrides win; automatic favicons must pass a decoded-size check.
    const custom = normalizeFavicon(site.icon);
    if (custom && !custom.startsWith('data:')) {
      // An address is downloaded once and afterwards served from this device,
      // so it keeps working offline and does not hit the host on every tab.
      const stored = await iconImages.get(custom, { refresh: options.refresh });
      if (stored && await tryIcon(stored)) { successfulSource = custom; origin = 'cache'; return; }
    }
    if (await tryIcon(custom)) { remember = !custom.startsWith('data:'); origin = remember ? 'direct' : 'inline'; return; }
    // Search controls use their dedicated compact artwork, even when a previous
    // version cached the catalog's full wordmark for the same engine.
    const bundled = options.engine ? engineIcon(site) : '';
    if (bundled && await tryIcon(bundled, catalogFavicon(site.url) === bundled ? 'favicon' : 'logo')) return;
    // Show the same bundled artwork the library card showed, ahead of stale
    // cached or discovered icons. Explicit discovery in the form still bypasses it.
    if (!options.discover && !options.refresh && await tryIcon(local, 'catalog')) return;
    const cached = !options.refresh && getResolvedIcon(key);
    if (cached && await tryIcon(cached.source, cached.kind)) {
      if (cached.kind === 'favicon' || !options.discover || cached.source !== local) return;
    }
    if (site.builtin || !normalizeUrl(site.url)) return;
    const localFavicon = catalogFavicon(site.url);
    if (!options.refresh && await tryIcon(localFavicon, 'favicon')) return;
    for (const icon of options.refresh ? [] : [...(site.iconCandidates || []), site.favicon]) {
      if (await tryIcon(normalizeFavicon(icon), 'favicon')) return;
    }
    for (const logo of options.refresh ? [] : site.logoCandidates || []) {
      if (await tryIcon(normalizeFavicon(logo), 'logo')) return;
    }
    const localLogo = catalogLogo(site.url);
    if (!options.refresh && !options.discover && await tryIcon(localLogo, 'logo')) return;
    const discovered = await discoverArtwork(site.url, undefined, { force: options.refresh });
    for (const icon of discovered.icons) {
      if (await tryIcon(icon, 'favicon')) return;
    }
    for (const logo of discovered.logos) {
      if (await tryIcon(logo, 'logo')) return;
    }
    if (await tryIcon(localFavicon, 'favicon')) return;
    if (await tryIcon(localLogo, 'logo')) return;
    if (!localFavicon && await tryIcon(local, 'logo')) return;
    await tryIcon(brandIcon(site.url), 'logo');
  } finally {
    if (active()) {
      container.dataset.iconOrigin = successfulSource ? origin : '';
      if (remember) rememberResolvedIcon(key, successfulSource, successfulKind);
      if (!successfulSource) fallback();
    }
  }
}
