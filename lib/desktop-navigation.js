// Blank-space gestures share the same pagination as the buttons and keyboard.
export function bindDesktopNavigation({ section, viewport, pages, previous, next, getPage, pageCount, goToPage, isEditing, suppress }) {
  let gesture = null;
  const clearEdges = () => { previous.classList.remove('edge-active'); next.classList.remove('edge-active'); };
  const showEdges = event => {
    if (event.pointerType === 'touch') return;
    const rect = viewport.getBoundingClientRect();
    const near = Math.min(72, rect.width * .2);
    const withinHeight = event.clientY >= rect.top && event.clientY <= rect.bottom;
    previous.classList.toggle('edge-active', withinHeight && event.clientX <= rect.left + near);
    next.classList.toggle('edge-active', withinHeight && event.clientX >= rect.right - near);
  };
  function cancel() {
    const current = gesture; gesture = null;
    section.classList.remove('page-panning');
    pages.style.transform = `translateX(-${getPage() * 100}%)`;
    if (current && section.hasPointerCapture(current.id)) section.releasePointerCapture(current.id);
  }
  section.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || pageCount() < 2 || gesture) return;
    const touch = event.pointerType === 'touch';
    // Mouse dragging is reserved for empty space; cards keep their own actions.
    if (touch ? isEditing() || event.target.closest('.widget-card, .page-arrow, #pagination')
      : event.target.closest('[data-desktop-key], button, a, input, textarea, select, .widget-card')) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, page: getPage(), width: viewport.getBoundingClientRect().width, active: false };
    if (!touch) { event.preventDefault(); section.setPointerCapture(event.pointerId); }
  });
  section.addEventListener('pointermove', event => {
    showEdges(event);
    if (!gesture || event.pointerId !== gesture.id) return;
    if (event.buttons === 0 || getPage() !== gesture.page) { cancel(); return; }
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.active) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      gesture.active = true; section.setPointerCapture(event.pointerId); section.classList.add('page-panning');
    }
    event.preventDefault();
    const atBoundary = (gesture.page === 0 && dx > 0) || (gesture.page === pageCount() - 1 && dx < 0);
    const offset = Math.max(-gesture.width, Math.min(gesture.width, dx)) * (atBoundary ? .2 : 1);
    pages.style.transform = `translateX(calc(-${gesture.page * 100}% + ${offset / gesture.width * 100}%))`;
  });
  section.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const current = gesture, dx = event.clientX - current.x;
    cancel();
    if (!current.active) return;
    suppress();
    if (getPage() === current.page && Math.abs(dx) >= 45) goToPage(current.page + (dx < 0 ? 1 : -1));
  });
  section.addEventListener('pointercancel', event => { if (event.pointerId === gesture?.id) cancel(); });
  // Touch starts with implicit capture on a child; transferring it to the dock
  // emits a bubbling lostpointercapture for that child, not a cancelled swipe.
  section.addEventListener('lostpointercapture', event => { if (event.target === section && event.pointerId === gesture?.id) cancel(); });
  section.addEventListener('pointerleave', clearEdges);
  section.addEventListener('dragstart', cancel);
  section.addEventListener('dragend', clearEdges);
  window.addEventListener('blur', () => { cancel(); clearEdges(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && gesture) { event.preventDefault(); cancel(); } });
  return { cancel };
}
