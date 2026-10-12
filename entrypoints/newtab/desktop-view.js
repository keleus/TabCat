import { bindDesktopNavigation } from '../../lib/desktop-navigation.js';
import { engineIcon } from '../../lib/search.js';
import { catalogIcon } from '../../lib/site-catalog.js';
import { renderSiteIcon } from '../../lib/site-icons.js';
import { $, $$, app, state } from './app.js';
import { hideContextMenu } from './context-menu.js';
import { renderEngines, renderManagers } from './engines.js';
import { openSite, openSiteModal } from './sites.js';

const startupIcons = [];
let suppressClick = false;
let wheelLockUntil = 0, wheelTotal = 0, wheelLastAt = 0;

export function bindDesktopView() {
  window.addEventListener('resize', () => renderSites());
  $('#sitesPages').addEventListener('click', event => {
    if (suppressClick) return;
    if (event.target.closest('[data-add-site]')) return openSiteModal();
    const card = event.target.closest('[data-site]'); if (card) app.editMode ? openSiteModal(card.dataset.site) : openSite(card.dataset.site);
  });
  $('#pagination').addEventListener('click', event => { const dot = event.target.closest('[data-page]'); if (dot) goToPage(Number(dot.dataset.page)); });
  $('#previousPage').addEventListener('click', () => goToPage(app.currentPage - 1));
  $('#nextPage').addEventListener('click', () => goToPage(app.currentPage + 1));
  $('.app-shell').addEventListener('wheel', handleSiteWheel, { passive: false });
  app.desktopNavigation = bindDesktopNavigation({ section: $('.sites-section'), viewport: $('#sitesViewport'), pages: $('#sitesPages'), previous: $('#previousPage'), next: $('#nextPage'), getPage: () => app.currentPage, pageCount, goToPage, isEditing: () => app.editMode, suppress: () => suppressClicks(250) });
  $('#addSiteButton').addEventListener('click', () => openSiteModal());
  $('#editDesktopButton').addEventListener('click', () => setEditMode(true));
  $('#addWidgetButton').addEventListener('click', () => app.siteLibrary.open('widgets'));
  $('#finishEditing').addEventListener('click', () => setEditMode(false));
}

export function suppressClicks(duration) { suppressClick = true; setTimeout(() => { suppressClick = false; }, duration); }

export function renderAll() { renderEngines(); renderSites(); renderManagers(); }

export function preloadDesktopIcons() {
  window.tabcatStartup?.preloadIcons([
    ...state.sites.filter(site => !site.icon && !site.iconText).map(site => catalogIcon(site.url)),
    ...state.engines.map(engineIcon),
  ]);
}

export function renderDesktopIcon(container, site, options) {
  const ready = renderSiteIcon(container, site, options);
  if (app.starting) startupIcons.push(ready);
}

// Give already-preloaded local icons a frame to settle, with a strict bound
// so a remote/failed icon never stalls the usable desktop.
export async function settleStartupIcons() {
  let iconTimer;
  await Promise.race([Promise.allSettled(startupIcons), new Promise(resolve => { iconTimer = setTimeout(resolve, 100); })]);
  clearTimeout(iconTimer); startupIcons.length = 0;
}

function gridMetrics() {
  const gap = window.innerWidth < 620 ? Math.min(state.columnGap, 18) : state.columnGap;
  const tileWidth = Math.max(92, state.iconSize + 28);
  const sidebarWidth = $('#siteLibraryModal').open && window.innerWidth > 620 ? $('#siteLibraryModal').getBoundingClientRect().width : 0;
  const available = window.innerWidth - sidebarWidth - (window.innerWidth < 620 ? 48 : 120);
  const columns = Math.min(state.layoutColumns, Math.max(2, Math.floor((available + gap) / (tileWidth + gap))));
  return { columns, gap, width: columns * tileWidth + (columns - 1) * gap };
}

function pageCount() { return app.desktop?.pageCount() || 1; }

export function renderSites() {
  if (!app.desktop) return;
  app.desktopNavigation?.cancel();
  syncEditMode();
  const metrics = gridMetrics();
  document.documentElement.style.setProperty('--grid-width', `${metrics.width}px`);
  document.documentElement.style.setProperty('--column-gap', `${metrics.gap}px`);
  // Card edges follow the icon artwork, not the wider label cells.
  document.documentElement.style.setProperty('--widget-inset', `${(Math.max(92, state.iconSize + 28) - state.iconSize) / 2}px`);
  $('#sitesPages').style.setProperty('--site-cols', metrics.columns);
  const { pages } = app.desktop.render(metrics.columns, state.layoutRows);
  // Reserve the configured rows so a sparse desktop doesn't shift the clock and search down.
  const rows = Math.max(1, state.layoutRows, ...pages.flatMap(page => page.map(item => item.y + item.height)));
  document.documentElement.style.setProperty('--grid-row-height', `${state.iconSize + 38}px`);
  document.documentElement.style.setProperty('--page-height', `${rows * (state.iconSize + 38) + (rows - 1) * state.rowGap}px`);
  app.currentPage = Math.max(0, Math.min(app.currentPage, pages.length - 1));
  updatePagination();
  fitDesktopHeight();
}

export function fitDesktopHeight() {
  const shell = $('.app-shell'), content = $('.desktop-content');
  const style = getComputedStyle(shell);
  const available = Math.max(1, shell.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  // Read the untransformed height so repeated resize/settings updates never compound scaling.
  content.style.setProperty('--desktop-scale', Math.min(1, available / Math.max(1, content.offsetHeight)));
  // Help is an overlay: omit it when crowded instead of shrinking the desktop.
  const hint = $('#editingHint');
  hint.classList.toggle('is-crowded', app.editMode && hint.getBoundingClientRect().bottom + 12 > content.getBoundingClientRect().top);
}

function updatePagination() {
  $('#sitesPages').style.transform = `translateX(-${app.currentPage * 100}%)`;
  $$('.sites-page').forEach((page, i) => { page.inert = i !== app.currentPage && !page.querySelector('.dragging'); page.setAttribute('aria-hidden', String(i !== app.currentPage)); });
  $$('.page-dot').forEach((dot, i) => { dot.classList.toggle('active', i === app.currentPage); dot.setAttribute('aria-current', i === app.currentPage ? 'page' : 'false'); });
  app.desktop?.activateFrames();
  $('#previousPage').hidden = app.currentPage === 0;
  $('#nextPage').hidden = app.currentPage >= pageCount() - 1;
}

export function goToPage(page) { app.currentPage = Math.max(0, Math.min(page, pageCount() - 1)); updatePagination(); }

function handleSiteWheel(event) {
  if (event.ctrlKey || pageCount() < 2 || event.target.closest('input, textarea, .widget-card, .engine-menu, .suggestions')) return;
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if (!horizontal && !event.shiftKey && !event.target.closest('#sitesViewport')) return;
  event.preventDefault();
  const now = Date.now(); if (now < wheelLockUntil) return;
  if (now - wheelLastAt > 160) wheelTotal = 0;
  wheelLastAt = now;
  wheelTotal += (horizontal ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1);
  if (Math.abs(wheelTotal) < 45) return;
  goToPage(app.currentPage + Math.sign(wheelTotal)); wheelTotal = 0; wheelLockUntil = now + 400;
}

export function syncEditMode() {
  document.documentElement.classList.toggle('editing', app.editMode);
  $('#editDesktopButton').hidden = app.editMode;
  $('#addSiteButton').hidden = !app.editMode;
  $('#finishEditing').hidden = !app.editMode;
  $('#editingHint').hidden = !app.editMode;
}

export function setEditMode(enabled) {
  app.editMode = enabled;
  hideContextMenu(); renderSites();
  (app.editMode ? $('#finishEditing') : $('#settingsButton')).focus();
}
