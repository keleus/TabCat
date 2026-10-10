// Remember the successful choice, so reopening a tab does not repeat website
// discovery before it can even request the image. Image bytes use browser caching.
const CACHE_KEY = 'tabcat:resolved-icons:quality-v3';
const entries = new Map();
let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (Array.isArray(saved)) for (const [key, entry] of saved) {
      if (typeof key === 'string' && typeof entry?.source === 'string' && entry.expires > Date.now()) entries.set(key, entry);
    }
  } catch {}
}
export function resolvedIconKey(site, engine = false, requiredPixels = 64) {
  return JSON.stringify([Boolean(engine), requiredPixels, site.url, site.builtin, site.icon, site.iconText, site.favicon, site.logoCandidates, site.iconCandidates]);
}
export function getResolvedIcon(key) {
  load();
  const entry = entries.get(key);
  return entry?.expires > Date.now() ? entry : null;
}
export function rememberResolvedIcon(key, source, kind = 'logo') {
  load();
  const existing = getResolvedIcon(key);
  if (existing?.source === source && existing.kind === kind) return;
  entries.delete(key);
  if (source) entries.set(key, { source, kind, expires: Date.now() + 7 * 86400000 });
  while (entries.size > 100 || JSON.stringify([...entries]).length > 400000) entries.delete(entries.keys().next().value);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify([...entries])); } catch {}
}
