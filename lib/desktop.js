import { WIDGET_TYPES, normalizeTool } from './widget-tools.js';
import { validCoordinates } from './weather.js';
// Desktop references keep site records compatible with the popup and old backups.
const cleanText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const uniqueRecords = values => {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).filter(value => value && typeof value.id === 'string' && value.id && !seen.has(value.id) && seen.add(value.id));
};
// Folders were removed; `legacyFolders` expands an old folder tile back into
// its sites at the folder's place on the desktop.
export function normalizeDesktop(state, normalizeUrl, legacyFolders) {
  const members = new Map(uniqueRecords(legacyFolders).map(folder => [`folder:${folder.id}`, Array.isArray(folder.siteIds) ? folder.siteIds : []]));
  const order = uniqueRecords(state.desktopOrder).flatMap(item => members.has(item.id) ? members.get(item.id).map(id => ({ id: `site:${id}` })) : [item]);
  state.widgets = uniqueRecords(state.widgets).filter(widget => Object.hasOwn(WIDGET_TYPES, widget.type)).map(widget => {
    const result = { id: widget.id, type: widget.type, name: cleanText(widget.name, 80).trim() || WIDGET_TYPES[widget.type][0], width: [2, 3, 4].includes(widget.width) ? widget.width : 2, height: [2, 3].includes(widget.height) ? widget.height : 2 };
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
  const keys = [...state.sites.map(site => `site:${site.id}`), ...state.widgets.map(widget => `widget:${widget.id}`)];
  const valid = new Set(keys);
  state.desktopOrder = [...new Set([...order.map(item => item?.id).filter(id => valid.has(id)), ...keys])].map(id => ({ id }));
}
export function desktopItems(state) {
  const items = new Map([
    ...state.sites.map(item => [`site:${item.id}`, { ...item, kind: 'site', key: `site:${item.id}`, width: 1, height: 1 }]),
    ...state.widgets.map(item => [`widget:${item.id}`, { ...item, kind: 'widget', key: `widget:${item.id}` }]),
  ]);
  return state.desktopOrder.map(ref => items.get(ref.id)).filter(Boolean);
}
// Dense packing: each item takes the first free slot on any page, so a widget
// that wraps to the next row or page never leaves a permanent hole behind it.
export function packDesktop(items, columns, preferredRows) {
  // Grow the row count for a tall widget even when the old desktop used one row.
  const rows = Math.max(preferredRows, ...items.map(item => item.height || 1));
  const pages = [], occupied = [];
  const fits = (page, x, y, width, height) => {
    if (x + width > columns || y + height > rows) return false;
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) if (occupied[page].has((y + dy) * columns + x + dx)) return false;
    return true;
  };
  const freeCell = (page, width, height) => {
    if (occupied[page].size === columns * rows) return -1;
    for (let index = 0; index < columns * rows; index++) if (fits(page, index % columns, Math.floor(index / columns), width, height)) return index;
    return -1;
  };
  for (const item of items) {
    const width = Math.min(columns, item.width || 1), height = Math.min(rows, item.height || 1);
    let page = 0, cell;
    for (;; page++) {
      if (!pages[page]) { pages.push([]); occupied.push(new Set()); }
      cell = freeCell(page, width, height); if (cell >= 0) break;
    }
    const x = cell % columns, y = Math.floor(cell / columns);
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) occupied[page].add((y + dy) * columns + x + dx);
    pages[page].push({ ...item, x, y, width, height });
  }
  return { pages: pages.length ? pages : [[]], rows };
}
// Removing the source reflows the grid, so the hovered tile is not a reliable
// insertion target. Try each insertion and keep the one that lands the source
// on the hovered page with the lowest score (distance to the pointer).
export function placeOnPage(items, source, columns, rows, pageIndex, score) {
  const moving = items.find(item => item.key === source); if (!moving) return null;
  const ordered = items.filter(item => item.key !== source && item.key !== 'add');
  const add = items.find(item => item.key === 'add');
  let best = null;
  for (let index = 0; index <= ordered.length; index++) {
    const next = [...ordered]; next.splice(index, 0, moving); if (add) next.push(add);
    const { pages } = packDesktop(next, columns, rows);
    const page = pages.findIndex(page => page.some(item => item.key === source));
    if (page !== pageIndex) continue;
    const slot = pages[page].find(item => item.key === source), value = score(slot);
    if (!best || value < best.value) best = { index, value, slot };
  }
  if (!best || !ordered.length) return null;
  const after = best.index === ordered.length;
  return { target: ordered[after ? best.index - 1 : best.index].key, after, value: best.value, slot: best.slot };
}
export function moveDesktopItem(state, source, target, after = false) {
  if (source === target || !state.desktopOrder.some(item => item.id === source)) return;
  const next = state.desktopOrder.filter(item => item.id !== source);
  const index = next.findIndex(item => item.id === target);
  next.splice(index < 0 ? next.length : index + Number(after), 0, { id: source });
  state.desktopOrder = next;
}
