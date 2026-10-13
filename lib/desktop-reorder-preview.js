import { packDesktop, placeOnPage } from './desktop.js';

// Tiles make way only after the pointer rests on a slot this long, so sweeping
// across the grid doesn't shuffle every tile it passes.
const SETTLE_MS = 160;
// A new slot must be this much closer (in cells) than the current one before
// the target changes; pointer jitter on a boundary keeps the current slot.
const HYSTERESIS = .3;

// Project the packed grid without replacing the native drag source or saving state.
export function createReorderPreview(container, layout, columns, source) {
  const pages = [...container.children];
  const style = getComputedStyle(pages[0]);
  const columnGap = parseFloat(style.columnGap) || 0, rowGap = parseFloat(style.rowGap) || 0;
  const width = (pages[0].offsetWidth - columnGap * (columns - 1)) / columns;
  const height = parseFloat(style.gridAutoRows);
  const pageWidth = pages[0].offsetWidth;
  const items = layout.pages.flat();
  const positions = new Map(layout.pages.flatMap((page, index) => page.map(item => [item.key, { ...item, page: index }])));
  const nodes = new Map([...container.querySelectorAll('[data-desktop-key]')].map(node => [node.dataset.desktopKey, node]));
  const point = item => ({ x: item.page * pageWidth + item.x * (width + columnGap), y: item.y * (height + rowGap) });
  const placeholder = document.createElement('div');
  placeholder.className = 'desktop-drop-slot'; placeholder.hidden = true; placeholder.setAttribute('aria-hidden', 'true');
  container.append(placeholder);
  let signature, wanted, settleTimer, placeKey, placed;
  // Pointer position in unscaled page coordinates, or null outside the page.
  function local(event, pageIndex) {
    const rect = pages[pageIndex]?.getBoundingClientRect(); if (!rect) return null;
    const scale = rect.width / pageWidth;
    const x = (event.clientX - rect.left) / scale, y = (event.clientY - rect.top) / scale;
    return x < 0 || x > pageWidth || y < 0 || y > rect.height / scale ? null : { x, y };
  }
  const center = slot => ({
    x: slot.x * (width + columnGap) + (slot.width * width + (slot.width - 1) * columnGap) / 2,
    y: slot.y * (height + rowGap) + (slot.height * height + (slot.height - 1) * rowGap) / 2,
  });
  const distance = (slot, pointer) => { const c = center(slot); return Math.hypot(c.x - pointer.x, c.y - pointer.y); };
  function apply(target, after) {
    signature = `${target}:${after}`;
    const ordered = items.filter(item => item.key !== source && item.key !== 'add');
    const index = ordered.findIndex(item => item.key === target);
    ordered.splice(index < 0 ? ordered.length : index + Number(after), 0, positions.get(source));
    const add = items.find(item => item.key === 'add'); if (add) ordered.push(add);
    const projected = packDesktop(ordered, columns, layout.rows);
    container.classList.add('reorder-preview'); placeholder.hidden = false;
    projected.pages.forEach((page, pageIndex) => page.forEach(item => {
      const to = point({ ...item, page: pageIndex }), from = point(positions.get(item.key));
      nodes.get(item.key).style.translate = `${to.x - from.x}px ${to.y - from.y}px`;
      if (item.key === source) Object.assign(placeholder.style, {
        left: `${to.x}px`, top: `${to.y}px`,
        width: `${item.width * width + (item.width - 1) * columnGap}px`,
        height: `${item.height * height + (item.height - 1) * rowGap}px`,
      });
    }));
  }
  function reset() {
    clearTimeout(settleTimer); signature = wanted = placeKey = placed = null; placeholder.hidden = true;
    container.classList.remove('reorder-preview');
    nodes.forEach(node => { node.style.removeProperty('translate'); });
  }
  return {
    // Insertion that lands the source on this page nearest the pointer. Slots
    // come from the stationary layout, not moving cards, so a still pointer
    // never alternates between two targets while their animations run.
    place(event, pageIndex) {
      const pointer = local(event, pageIndex); if (!pointer) return null;
      const key = `${pageIndex}:${Math.round(pointer.x / 12)}:${Math.round(pointer.y / 12)}`;
      if (key === placeKey) return placed;
      placeKey = key;
      const next = placeOnPage(items, source, columns, layout.rows, pageIndex, slot => distance(slot, pointer));
      const keep = placed?.page === pageIndex && next && distance(placed.slot, pointer) - next.value < HYSTERESIS * Math.min(width + columnGap, height + rowGap);
      if (!keep) placed = next && { ...next, page: pageIndex };
      return placed;
    },
    show(target, after) {
      const next = `${target}:${after}`; if (next === wanted) return;
      wanted = next; clearTimeout(settleTimer);
      if (next !== signature) settleTimer = setTimeout(() => apply(target, after), SETTLE_MS);
    },
    reset,
    stop() { reset(); placeholder.remove(); },
  };
}
