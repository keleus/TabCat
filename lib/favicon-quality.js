// 16/32 px browser-tab icons are unsuitable for desktop tiles. Accept the
// existing crisp 64/96 px assets at normal sizes; larger tiles and >2x displays
// raise the bar. Declared HTML sizes only order candidates, never prove quality.
export function requiredFaviconPixels(cssSize = 72, scale = 100, dpr = 1) {
  return Math.ceil(Math.max(64, cssSize * scale / 100 / 1.125) * Math.max(1, dpr / 2));
}
export function isSharpFavicon(url, width, height, required = 64) {
  if (!width || !height) return false;
  if (/\.svg(?:[?#]|$)|^data:image\/svg\+xml[;,]/i.test(url)) return true;
  return Math.min(width, height) >= required;
}

// Self-contained so the same function can inspect a live tab via scripting.
export function collectFaviconLinks(doc = document, base = doc.baseURI) {
  const icons = [];
  let manifest = '';
  for (const link of doc.querySelectorAll('link[rel][href]')) {
    const rel = link.getAttribute('rel').toLowerCase().split(/\s+/);
    let url;
    try { url = new URL(link.getAttribute('href'), base).href; } catch { continue; }
    if (!/^https?:/i.test(url)) continue;
    if (rel.includes('manifest')) manifest ||= url;
    if (!rel.some(value => ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'].includes(value))) continue;
    icons.push({ url, sizes: link.getAttribute('sizes') || '', type: link.getAttribute('type') || '' });
  }
  return { icons, manifest, base };
}
export function rankFavicons(icons = []) {
  const score = icon => /svg/i.test(icon.type || '') || /\.svg(?:[?#]|$)/i.test(icon.url) || icon.sizes === 'any' ? 10000 : Math.max(0, ...[...String(icon.sizes || '').matchAll(/(\d+)x(\d+)/g)].map(match => Math.min(+match[1], +match[2])));
  return [...new Set([...icons].sort((a, b) => score(b) - score(a)).map(icon => icon.url))].slice(0, 10);
}
