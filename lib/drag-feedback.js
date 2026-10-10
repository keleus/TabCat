// Keep the native drag/drop semantics while presenting one consistent preview.
export function createDragFeedback() {
  let preview, source, offsetX = 0, offsetY = 0;
  const blank = document.createElement('canvas'); blank.width = blank.height = 1;
  function move(event) {
    if (!preview || (!event.clientX && !event.clientY)) return;
    preview.style.left = `${event.clientX - offsetX}px`;
    preview.style.top = `${event.clientY - offsetY}px`;
  }
  function stop() {
    preview?.remove(); preview = null;
    source?.classList.remove('dragging'); source = null;
    document.body.classList.remove('desktop-drag-active');
  }
  document.addEventListener('dragover', move);
  document.addEventListener('dragend', stop);
  document.addEventListener('drop', stop);
  window.addEventListener('blur', stop);
  return {
    start(event, element) {
      stop(); if (!element || !event.dataTransfer) return;
      source = element;
      const rect = element.getBoundingClientRect();
      offsetX = event.clientX - rect.left; offsetY = event.clientY - rect.top;
      preview = element.cloneNode(true);
      for (const node of [preview, ...preview.querySelectorAll('*')]) {
        for (const attribute of [...node.attributes]) {
          if (attribute.name === 'id' || attribute.name.startsWith('data-') || attribute.name === 'draggable') node.removeAttribute(attribute.name);
        }
      }
      preview.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-merge');
      preview.classList.add('desktop-drag-preview'); preview.inert = true; preview.setAttribute('aria-hidden', 'true');
      Object.assign(preview.style, { width: `${rect.width}px`, height: `${rect.height}px` });
      document.body.append(preview); move(event);
      event.dataTransfer.setDragImage(blank, 0, 0);
      document.body.classList.add('desktop-drag-active');
      source.classList.add('dragging');
    },
    stop,
  };
}

export function tilePositions(container) {
  return new Map([...container.querySelectorAll('[data-desktop-key]')].map(node => [node.dataset.desktopKey, {
    rect: node.getBoundingClientRect(), page: [...container.children].indexOf(node.parentElement),
  }]));
}

export function animateTiles(container, previous) {
  if (!previous.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  container.querySelectorAll('[data-desktop-key]').forEach(node => {
    const before = previous.get(node.dataset.desktopKey), after = node.getBoundingClientRect();
    if (after.right < 0 || after.left > innerWidth) return;
    if (!before) {
      node.animate([{ opacity: 0, transform: 'scale(.88)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
    } else if (before.page === [...container.children].indexOf(node.parentElement)) {
      const x = before.rect.left - after.left, y = before.rect.top - after.top;
      if (Math.abs(x) + Math.abs(y) > 1) node.animate([
        { transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' },
      ], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  });
}
