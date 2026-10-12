import { WIDGET_TYPES, normalizeTool } from './widget-tools.js';
import { validCoordinates } from './weather.js';
// Desktop references keep site records compatible with the popup and old backups.
const cleanText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const uniqueRecords = values => {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).filter(value => value && typeof value.id === 'string' && value.id && !seen.has(value.id) && seen.add(value.id));
};
export function normalizeDesktop(state, normalizeUrl) {
  const siteIds = new Set(state.sites.map(site => site.id));
  const assigned = new Set();
  state.folders = uniqueRecords(state.folders).map(folder => ({
    id: folder.id, name: cleanText(folder.name, 80).trim() || '新建文件夹',
    siteIds: [...new Set(Array.isArray(folder.siteIds) ? folder.siteIds : [])].filter(id => siteIds.has(id) && !assigned.has(id) && assigned.add(id)),
  })).filter(folder => folder.siteIds.length);
  state.widgets = uniqueRecords(state.widgets).filter(widget => Object.hasOwn(WIDGET_TYPES, widget.type)).map(widget => {
    const result = { id: widget.id, type: widget.type, name: cleanText(widget.name, 80).trim() || WIDGET_TYPES[widget.type][0], width: [2, 3, 4].includes(widget.width) ? widget.width : 2, height: [2, 3].includes(widget.height) ? widget.height : 2 };
    if (widget.type === 'note') result.text = cleanText(widget.text, 20000);
    if (widget.type === 'web') { result.url = normalizeUrl(widget.url); if (!result.url.startsWith('https://')) return null; }
    if (widget.type === 'weather') {
      result.locationMode = widget.locationMode === 'ip' ? 'ip' : 'manual';
      if (result.locationMode === 'manual') {
        if (!validCoordinates(widget)) return null;
        Object.assign(result, { city: cleanText(widget.city, 100), cityLabel: cleanText(widget.cityLabel || widget.city, 250), latitude: widget.latitude, longitude: widget.longitude });
      }
    }
    return Object.assign(result, normalizeTool(widget));
  }).filter(Boolean);
  const keys = [...state.sites.filter(site => !assigned.has(site.id)).map(site => `site:${site.id}`), ...state.folders.map(folder => `folder:${folder.id}`), ...state.widgets.map(widget => `widget:${widget.id}`)];
  const valid = new Set(keys);
  state.desktopOrder = [...new Set([...uniqueRecords(state.desktopOrder).map(item => item.id).filter(id => valid.has(id)), ...keys])].map(id => ({ id }));
}
export function desktopItems(state) {
  const items = new Map([
    ...state.sites.map(item => [`site:${item.id}`, { ...item, kind: 'site', key: `site:${item.id}`, width: 1, height: 1 }]),
    ...state.folders.map(item => [`folder:${item.id}`, { ...item, kind: 'folder', key: `folder:${item.id}`, width: 1, height: 1 }]),
    ...state.widgets.map(item => [`widget:${item.id}`, { ...item, kind: 'widget', key: `widget:${item.id}` }]),
  ]);
  return state.desktopOrder.map(ref => items.get(ref.id)).filter(Boolean);
}
export function packDesktop(items, columns, preferredRows) {
  // Grow the row count for a tall widget even when the old desktop used one row.
  const rows = Math.max(preferredRows, ...items.map(item => item.height || 1));
  const pages = [[]]; let occupied = new Set(); let cursor = 0;
  for (const item of items) {
    const width = Math.min(columns, item.width || 1), height = Math.min(rows, item.height || 1);
    let position;
    while (position === undefined) {
      for (let cell = cursor; cell < columns * rows; cell++) {
        const x = cell % columns, y = Math.floor(cell / columns);
        if (x + width > columns || y + height > rows) continue;
        const cells = Array.from({ length: height }, (_, dy) => Array.from({ length: width }, (_, dx) => (y + dy) * columns + x + dx)).flat();
        if (cells.some(index => occupied.has(index))) continue;
        cells.forEach(index => occupied.add(index)); position = { ...item, x, y, width, height }; cursor = cell + 1; break;
      }
      if (!position) { pages.push([]); occupied = new Set(); cursor = 0; }
    }
    pages.at(-1).push(position);
  }
  return { pages, rows };
}
// Removing the source reflows every later page, so the hovered tile is not a
// reliable insertion target across pages. Try each insertion and keep the one
// that lands the source on the hovered page with the lowest score (distance).
export function placeOnPage(items, source, columns, rows, pageIndex, score) {
  const moving = items.find(item => item.key === source); if (!moving) return null;
  const ordered = items.filter(item => item.key !== source && item.key !== 'add');
  const add = items.find(item => item.key === 'add');
  let best = null;
  for (let index = 0; index <= ordered.length; index++) {
    const next = [...ordered]; next.splice(index, 0, moving); if (add) next.push(add);
    const { pages } = packDesktop(next, columns, rows);
    const page = pages.findIndex(page => page.some(item => item.key === source));
    if (page < pageIndex) continue;
    if (page > pageIndex) break;
    const value = score(pages[page].find(item => item.key === source));
    if (!best || value < best.value) best = { index, value };
  }
  if (!best || !ordered.length) return null;
  const after = best.index === ordered.length;
  return { target: ordered[after ? best.index - 1 : best.index].key, after };
}
export function moveDesktopItem(state, source, target, after = false) {
  if (source === target || !state.desktopOrder.some(item => item.id === source)) return;
  const next = state.desktopOrder.filter(item => item.id !== source);
  const index = next.findIndex(item => item.id === target);
  next.splice(index < 0 ? next.length : index + Number(after), 0, { id: source });
  state.desktopOrder = next;
}
export function mergeDesktopSites(state, source, target, folderId) {
  if (!source.startsWith('site:') || source === target) return false;
  const id = source.slice(5);
  if (!state.sites.some(site => site.id === id)) return false;
  if (target.startsWith('folder:')) {
    const folder = state.folders.find(item => item.id === target.slice(7));
    if (!folder) return false;
    for (const item of state.folders) item.siteIds = item.siteIds.filter(value => value !== id);
    folder.siteIds.push(id);
    state.desktopOrder = state.desktopOrder.filter(item => item.id !== source);
  } else if (target.startsWith('site:') && state.sites.some(site => site.id === target.slice(5))) {
    for (const folder of state.folders) folder.siteIds = folder.siteIds.filter(value => value !== id && value !== target.slice(5));
    state.folders.push({ id: folderId, name: '新建文件夹', siteIds: [target.slice(5), id] });
    state.desktopOrder = state.desktopOrder.filter(item => item.id !== source).map(item => item.id === target ? { id: `folder:${folderId}` } : item);
  } else return false;
  state.folders = state.folders.filter(folder => folder.siteIds.length);
  return true;
}
