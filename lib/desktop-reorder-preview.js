import { packDesktop } from './desktop.js';

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
  let signature;
  function reset() {
    signature = null; placeholder.hidden = true;
    container.classList.remove('reorder-preview');
    nodes.forEach(node => { node.style.removeProperty('translate'); });
  }
  return {
    // Use stationary slots, not moving cards, so a stationary pointer never
    // alternates between two insertion targets while their animations run.
    hitTest(event, pageIndex) {
      const rect = pages[pageIndex]?.getBoundingClientRect(); if (!rect) return null;
      const scale = rect.width / pageWidth;
      const x = (event.clientX - rect.left) / scale, y = (event.clientY - rect.top) / scale;
      if (x < 0 || x > pageWidth || y < 0 || y > rect.height / scale) return null;
      let nearest, distance = Infinity;
      for (const item of layout.pages[pageIndex]) {
        const left = item.x * (width + columnGap), top = item.y * (height + rowGap);
        const w = item.width * width + (item.width - 1) * columnGap;
        const h = item.height * height + (item.height - 1) * rowGap;
        const d = Math.hypot(Math.max(left - x, 0, x - left - w), Math.max(top - y, 0, y - top - h));
        if (d < distance) { distance = d; nearest = { tile: nodes.get(item.key), target: item.key, fraction: (x - left) / w, inside: d === 0 }; }
      }
      return nearest;
    },
    show(target, after) {
      const nextSignature = `${target}:${after}`; if (nextSignature === signature) return;
      signature = nextSignature;
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
    },
    reset,
    stop() { reset(); placeholder.remove(); },
  };
}
