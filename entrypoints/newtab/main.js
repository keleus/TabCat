import { browser } from 'wxt/browser';
import { UI_ICONS } from '../../lib/appearance.js';
import { createBookmarkBar } from '../../lib/bookmark-bar.js';
import { createDesktop } from '../../lib/desktop-ui.js';
import { createSiteLibrary } from '../../lib/site-library.js';
import { normalizeState } from '../../lib/state.js';
import { loadState, watchState, addCatalogSite } from '../../lib/storage.js';
import { bindSuggestions } from '../../lib/suggestions-ui.js';
import { WEATHER_STORAGE_KEY } from '../../lib/weather-cache.js';
import { $, $$, app, state, setState, markSaved, hasPendingSaves, onStateAccepted, acceptState, storage, showStatus } from './app.js';
import { bindBackup } from './backup.js';
import { bindSync } from './sync.js';
import { updateClock } from './clock.js';
import { bindContextMenu, dismissContextMenu, isContextMenuOpen, moveContextMenuFocus } from './context-menu.js';
import { bindDesktopView, fitDesktopHeight, goToPage, preloadDesktopIcons, renderAll, renderDesktopIcon, renderSites, setEditMode, settleStartupIcons, suppressClicks, syncEditMode } from './desktop-view.js';
import { bindEngines, closeEngineMenu, isEngineMenuOpen } from './engines.js';
import { applyAppearance, bindSettings, closeSettings, decorateSettings, isSettingsOpen, populateTimezones, syncControls } from './settings.js';
import { bindSites, openCustomSiteModal, removeSite, siteCard } from './sites.js';
import { bindWallpaper, refreshWallpaper, renderWallpaperChoices, setStoredWallpapers, showFallbackWallpaper, watchWallpapers } from './wallpaper.js';

onStateAccepted(() => {
  preloadDesktopIcons();
  syncControls(); applyAppearance(); renderAll(); updateClock(); app.siteLibrary?.refresh();
});

async function init() {
  syncEditMode();
  new ResizeObserver(fitDesktopHeight).observe($('.desktop-content'));
  const [stored, initialTree] = await Promise.all([
    browser.storage.local.get(['tabcat', 'tabcatBing', 'tabcatGallery', WEATHER_STORAGE_KEY]),
    browser.bookmarks.getTree().catch(() => null),
  ]);
  setState(normalizeState(stored.tabcat));
  setStoredWallpapers(stored);
  markSaved();
  preloadDesktopIcons();
  $$('[data-icon]').forEach(element => { element.innerHTML = UI_ICONS[element.dataset.icon] || ''; });
  renderWallpaperChoices();
  populateTimezones();
  decorateSettings();
  app.bookmarkBar = createBookmarkBar({ bar: $('#bookmarkBar'), items: $('#bookmarkBarItems'), menu: $('#bookmarkFolderMenu'), getState: () => state, report: showStatus, initialTree });
  app.siteLibrary = createSiteLibrary({ dialog: $('#siteLibraryModal'), getState: () => state, custom: () => openCustomSiteModal(), widgets: () => app.desktop.widgets,
    startDrag: (item, event) => app.desktop.startCandidate(item, event), endDrag: () => app.desktop.endCandidate(),
    onToggle: open => { document.documentElement.classList.toggle('library-open', open); renderSites(); },
    add: async (id, placement) => {
    const result = await addCatalogSite(id);
    acceptState(await loadState());
    if (result.site && !result.duplicate) await app.desktop.place(`site:${result.site.id}`, placement);
    return result;
  } });
  app.desktop = createDesktop({ initialWeather: stored[WEATHER_STORAGE_KEY], addCandidate: (item, placement) => app.siteLibrary.addCandidate(item, placement), getState: () => state, isEditing: () => app.editMode, siteCard, renderIcon: renderDesktopIcon, render: renderAll, save: () => storage.save(), report: showStatus, removeSite, goToPage, getPage: () => app.currentPage, suppress: () => suppressClicks(150) });
  bindEvents();
  syncControls();
  applyAppearance();
  renderAll();
  app.suggestions = bindSuggestions({ input: $('#searchInput'), list: $('#suggestionList'), getState: () => state, submit: () => $('#searchForm').requestSubmit() });
  watchWallpapers();
  updateClock();
  setInterval(updateClock, 1000);
  watchState(value => { if (!hasPendingSaves()) acceptState(value); });
  // The synchronous preview is already visible. Neither decoding the full image
  // nor the network should hold the controls (or the background) behind a blank screen.
  await settleStartupIcons();
  document.documentElement.classList.remove('booting');
  app.starting = false;
  refreshWallpaper();
}

function bindEvents() {
  bindDialogDismissal();
  bindSettings();
  bindEngines();
  bindDesktopView();
  bindSites();
  bindContextMenu();
  bindWallpaper();
  bindBackup();
  bindSync();
  document.addEventListener('keydown', handleKeys);
}

function bindDialogDismissal() {
  for (const dialog of $$('dialog')) {
    let startedOutside = false;
    const isOutside = event => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    dialog.addEventListener('pointerdown', event => { startedOutside = event.button === 0 && isOutside(event); });
    dialog.addEventListener('pointercancel', () => { startedOutside = false; });
    dialog.addEventListener('close', () => { startedOutside = false; });
    dialog.addEventListener('click', event => {
      // A drag that begins inside the dialog must not dismiss it on release.
      const dismiss = startedOutside && isOutside(event);
      startedOutside = false;
      if (dismiss) dialog.close('cancel');
    });
  }
}

function handleKeys(event) {
  if (event.defaultPrevented) return;
  // Let the open select picker handle Escape and arrow keys before the drawer.
  if (CSS.supports('selector(select:open)') && document.querySelector('select:open')) return;
  if (event.target.closest('.bookmark-bar, .bookmark-folder-menu')) return;
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') {
    if (isContextMenuOpen()) dismissContextMenu();
    else if (isEngineMenuOpen()) closeEngineMenu();
    else if (isSettingsOpen()) closeSettings();
    else if (app.editMode) setEditMode(false);
    return;
  }
  if (isContextMenuOpen() && ['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault(); moveContextMenuFocus(event.key === 'ArrowDown' ? 1 : -1); return;
  }
  if (isSettingsOpen()) {
    if (event.key === 'Tab') {
      const focusable = [...$('#settingsPanel').querySelectorAll('button,input,select,summary')].filter(element => !element.disabled && element.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if (event.target.closest('input,textarea,select') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '/' && state.showSearch) { event.preventDefault(); $('#searchInput').focus(); }
  if (event.key === 'ArrowLeft') goToPage(app.currentPage - 1);
  if (event.key === 'ArrowRight') goToPage(app.currentPage + 1);
}

init().catch(error => {
  app.starting = false;
  document.documentElement.classList.remove('booting');
  showFallbackWallpaper();
  showStatus(`加载失败：${error.message}`, true);
});
