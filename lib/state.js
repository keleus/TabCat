import { mergeNotes, mergeTodoItems } from './widget-tools.js';
import { normalizeDesktop } from './desktop.js';
import { BUILTIN_SITES, DEFAULTS } from './defaults.js';
import { isIconRef } from './icon-refs.js';

export function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) return '';
  // A hostname with a numeric port is not a URI scheme.
  if (/^[a-z][\w+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw) && !/^[\w.-]+:\d+(?:\/|$)/.test(raw)) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// Captured tab favicons can be small inline raster images as well as URLs.
export function normalizeFavicon(value) {
  if (typeof value === 'string' && value.length <= 256 * 1024 && /^data:image\/(png|jpeg|webp|gif|x-icon|vnd.microsoft.icon);base64,[a-zA-Z0-9+/=]+$/.test(value)) return value;
  return normalizeUrl(value);
}

export function normalizeState(saved = {}) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const known = Object.fromEntries(Object.keys(DEFAULTS).filter(key => key in saved).map(key => [key, saved[key]]));
  const state = { ...structuredClone(DEFAULTS), ...known };
  // Upgrade only the former stock appearance; custom values and site data stay intact.
  if (saved.designVersion !== 2) {
    const previous = { background: 'mist', backgroundDim: 20, iconSize: 62, iconRadius: 19, accentColor: '#5f6fff' };
    for (const [key, oldDefault] of Object.entries(previous)) if (saved[key] === oldDefault) state[key] = key === 'iconRadius' ? 36 : DEFAULTS[key];
    if (saved.clockSize === 112) { state.clockSize = DEFAULTS.clockSize; if (saved.showClock === true) state.showClock = false; }
  }
  state.designVersion = 2;
  if (!['auto', 'custom'].includes(saved.iconTextColorMode)) state.iconTextColorMode = /^#[0-9a-f]{6}$/i.test(saved.iconTextColor || '') && saved.iconTextColor.toLowerCase() !== '#ffffff' ? 'custom' : 'auto';
  // Defaults must have the same canonical shape as persisted sites. Otherwise
  // the first settings acknowledgement looks like a change to every shortcut.
  state.sites = (Array.isArray(saved.sites) ? saved.sites : DEFAULTS.sites).filter(site => site && typeof site.id === 'string' && typeof site.name === 'string').map(site => {
    const builtin = BUILTIN_SITES.find(item => item.builtin === site.builtin);
    return builtin ? { ...site, url: builtin.url, builtin: builtin.builtin } : { ...site, name: site.name.slice(0, 80), url: normalizeUrl(site.url), icon: isIconRef(site.icon) ? site.icon : normalizeFavicon(site.icon), favicon: normalizeFavicon(site.favicon), logoCandidates: Array.isArray(site.logoCandidates) ? site.logoCandidates.map(normalizeFavicon).filter(Boolean).slice(0, 4) : [], iconCandidates: Array.isArray(site.iconCandidates) ? site.iconCandidates.map(normalizeFavicon).filter(Boolean).slice(0, 10) : [], iconText: typeof site.iconText === 'string' ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(site.iconText)].slice(0, 2).map(item => item.segment).join('') : '', builtin: undefined };
  }).filter(site => site.url);
  // An explicit sites array is authoritative, including an empty desktop.
  // Older backups stored radii in px; migrate once using each icon's size.
  if (saved.iconRadiusUnit !== 'percent') {
    const size = Math.max(44, Math.min(128, Number(state.iconSize) || DEFAULTS.iconSize));
    const hasRadius = Number.isFinite(Number(saved.iconRadius)) && saved.iconRadius != null;
    const radius = hasRadius ? Number(state.iconRadius) : null;
    const percent = (pixels, side) => Math.round(Math.max(0, Math.min(50, pixels / side * 100)) * 100) / 100;
    if (hasRadius) state.iconRadius = percent(radius, size);
    if (Array.isArray(saved.sites)) for (const site of state.sites) {
      const ownRadius = site.iconRadius != null && site.iconRadius !== '' && Number.isFinite(Number(site.iconRadius));
      if (ownRadius || (hasRadius && site.iconSize)) site.iconRadius = percent(ownRadius ? Number(site.iconRadius) : radius, Math.max(36, Math.min(128, Number(site.iconSize) || size)));
    }
  }
  state.iconRadiusUnit = 'percent';
  for (const site of state.sites) {
    for (const [key, min, max] of [['imageScale',40,160],['iconSize',36,128],['iconRadius',0,50],['labelSize',10,22],['iconTextSize',10,72],['iconTextWeight',300,800]]) {
      if (site[key] == null || site[key] === '' || !Number.isFinite(Number(site[key]))) delete site[key];
      else site[key] = Math.max(min, Math.min(max, Number(site[key])));
    }
    if (!['cover','contain'].includes(site.imageFit)) delete site.imageFit;
    if (!['system','serif','rounded','mono'].includes(site.iconTextFont)) delete site.iconTextFont;
    if (!/^#[0-9a-f]{6}$/i.test(site.iconTextColor || '')) delete site.iconTextColor;
    site.iconText = typeof site.iconText === 'string' ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(site.iconText)].slice(0, 2).map(item => item.segment).join('') : '';
  }
  state.engines = Array.isArray(saved.engines) ? saved.engines.filter(engine => engine && typeof engine.id === 'string' && typeof engine.name === 'string' && typeof engine.url === 'string' && engine.url.includes('%s') && normalizeUrl(engine.url)) : structuredClone(DEFAULTS.engines);
  if (!state.engines.length) state.engines = structuredClone(DEFAULTS.engines);
  if (!state.engines.some(engine => engine.id === state.currentEngine)) state.currentEngine = state.engines[0].id;
  for (const [key, min, max] of [['layoutColumns',2,12],['layoutRows',1,6],['clockSize',48,160],['clockWeight',300,600],['iconSize',44,128],['iconRadius',0,50],['iconTextSize',10,72],['iconTextWeight',300,800],['bookmarkBarTransparency',0,100],['backgroundDim',0,70],['backgroundBlur',0,40],['backgroundFrost',0,60],['rowGap',16,72],['columnGap',16,80],['contentOffset',8,35],['searchWidth',360,760],['searchHeight',40,64],['searchRadius',0,32],['searchOpacity',60,100],['iconOpacity',30,100]]) {
    state[key] = Number.isFinite(Number(state[key])) ? Math.max(min, Math.min(max, Number(state[key]))) : DEFAULTS[key];
  }
  state.layoutColumns = Math.round(state.layoutColumns); state.layoutRows = Math.round(state.layoutRows);
  if (!/^#[0-9a-f]{6}$/i.test(state.iconTextColor)) state.iconTextColor = DEFAULTS.iconTextColor;
  if (!/^#[0-9a-f]{6}$/i.test(state.accentColor)) state.accentColor = DEFAULTS.accentColor;
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone }); } catch { state.timezone = DEFAULTS.timezone; }
  for (const key of ['showBookmarksBar','showSearch','searchSuggestions','showClock','showLunar','hour24','showSiteNames','openInNewTab','shortcutOpenInNewTab']) if (typeof state[key] !== 'boolean') state[key] = DEFAULTS[key];
  for (const [key, options] of Object.entries({ theme: ['system','light','dark'], background: ['bing','bing-gallery','picsum','fjord','custom','local'], wallpaperRotation: ['daily','hourly','newtab','manual'], labelColor: ['auto','light','dark'], fontFamily: ['system','serif','rounded','mono'], iconTextFont: ['system','serif','rounded','mono'], dateStyle: ['cn','full','iso'] })) if (!options.includes(state[key])) state[key] = DEFAULTS[key];
  state.backgroundUrl = normalizeUrl(state.backgroundUrl);
  state.backgroundLocal = typeof state.backgroundLocal === 'string' && state.backgroundLocal.length <= 3 * 1024 * 1024 && /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(state.backgroundLocal) ? state.backgroundLocal : '';
  state.backgroundLocalName = typeof state.backgroundLocalName === 'string' ? state.backgroundLocalName.slice(0, 200) : '';
  if (state.background === 'local' && !state.backgroundLocal) state.background = 'fjord';
  normalizeDesktop(state, normalizeUrl, saved.folders);
  return state;
}

// Apply only local changes to the newest stored data. A popup addition must not
// be overwritten by a settings page which was opened before that addition.
export function mergeState(current, before, after) {
  const result = structuredClone(current);
  for (const key of Object.keys(DEFAULTS)) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (!['sites', 'engines', 'widgets', 'desktopOrder'].includes(key)) { result[key] = after[key]; continue; }
    const oldItems = before[key] || []; const nextItems = after[key] || [];
    const removed = new Set(oldItems.filter(item => !nextItems.some(next => next.id === item.id)).map(item => item.id));
    const items = new Map((current[key] || []).filter(item => !removed.has(item.id)).map(item => [item.id, item]));
    for (const item of nextItems) {
      const old = oldItems.find(value => value.id === item.id);
      if (old && key === 'widgets') {
        // A stale title/size edit must not erase a newer note or resurrect a deletion.
        if (!items.has(item.id)) continue;
        const merged = { ...items.get(item.id) };
        for (const field of new Set([...Object.keys(old), ...Object.keys(item)])) {
          if (JSON.stringify(old[field]) !== JSON.stringify(item[field])) merged[field] = item.type === 'todo' && field === 'items' ? mergeTodoItems(merged.items, old.items, item.items) : item.type === 'note' && field === 'notes' ? mergeNotes(merged.notes, old.notes, item.notes) : item[field];
        }
        items.set(item.id, merged);
      } else if (!old || JSON.stringify(old) !== JSON.stringify(item)) items.set(item.id, item);
    }
    const retained = new Set(nextItems.filter(item => oldItems.some(old => old.id === item.id)).map(item => item.id));
    const reordered = JSON.stringify(oldItems.filter(item => retained.has(item.id)).map(item => item.id)) !== JSON.stringify(nextItems.filter(item => retained.has(item.id)).map(item => item.id));
    const order = reordered || key === 'desktopOrder' ? [...nextItems.map(item => item.id), ...items.keys()] : [...items.keys()];
    result[key] = [...new Set(order)].filter(id => items.has(id)).map(id => items.get(id));
  }
  return normalizeState(result);
}

export function pinSite(state, input) {
  const url = normalizeUrl(input.url);
  const name = String(input.name || '').trim().slice(0, 80);
  if (!url || !name) throw new Error('请输入有效的网站名称和 HTTP/HTTPS 网址');
  const existing = state.sites.find(site => normalizeUrl(site.url) === url);
  if (existing) return { state, site: existing, duplicate: true };
  const icon = normalizeUrl(input.icon);
  const favicon = normalizeFavicon(input.favicon);
  const iconCandidates = Array.isArray(input.iconCandidates) ? input.iconCandidates.map(normalizeFavicon).filter(Boolean).slice(0, 10) : [];
  const logoCandidates = Array.isArray(input.logoCandidates) ? input.logoCandidates.map(normalizeFavicon).filter(Boolean).slice(0, 4) : [];
  const site = { id: crypto.randomUUID(), name, url, ...(logoCandidates.length ? { logoCandidates } : {}), ...(icon ? { icon } : {}), ...(favicon ? { favicon } : {}), ...(iconCandidates.length ? { iconCandidates } : {}) };
  return { state: { ...state, sites: [...state.sites, site] }, site, duplicate: false };
}
