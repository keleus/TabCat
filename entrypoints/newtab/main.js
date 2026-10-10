import { createDesktop } from '../../lib/desktop-ui.js';
import { bindDesktopNavigation } from '../../lib/desktop-navigation.js';
import { browser } from 'wxt/browser';
import { bindSuggestions } from '../../lib/suggestions-ui.js';
import { renderSiteIcon } from '../../lib/site-icons.js';
import { WALLPAPERS, UI_ICONS, siteArtwork, ICON_FONTS, contrastTextColor, firstIconCharacter } from '../../lib/appearance.js';
import { createBackup, inspectBackup, MAX_BACKUP_BYTES } from '../../lib/backup.js';
import { DEFAULTS } from '../../lib/defaults.js';
import { normalizeUrl, normalizeState } from '../../lib/state.js';
import { loadState, commitState, watchState, addCatalogSite } from '../../lib/storage.js';
import { GALLERY_NAMES, galleryCacheKey } from '../../lib/wallpapers.js';
import { engineIcon } from '../../lib/search.js';
import { createSiteLibrary } from '../../lib/site-library.js';
import { siteImageScale, catalogIcon } from '../../lib/site-catalog.js';
import { createBookmarkBar } from '../../lib/bookmark-bar.js';
import { createWallpaperDisplay } from '../../lib/wallpaper-display.js';
import { wallpaperBrightness, wallpaperTextShadow } from '../../lib/wallpaper-contrast.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let state = structuredClone(DEFAULTS);
let currentPage = 0;
let editingSiteId = null;
let sitePreviewKey;
let siteIconSource = 'website';
let siteArtworkRefreshed = false;
let sitePreviewRequest = 0;
let dragState = null;
let desktop;
let desktopNavigation;
let suppressClick = false;
let contextSiteId = null;
let settingsReturnFocus = null;
let editMode = false;

let enginesRenderKey;
let suggestions;
let bookmarkBar;
let siteLibrary;
let bingWallpaper;
let bingLoading;
let bingCheckedAt = 0;
let galleryWallpaper;
let galleryRequest = 0;
let galleryCheckedAt = 0;
let galleryCheckedKey = '';
let galleryFailed = false;
let starting = true;
let displayedWallpaperImage;
let displayedWallpaperBrightness = null;
const startupIcons = [];
const wallpaperDisplay = createWallpaperDisplay({
  fallback: WALLPAPERS[0].image,
  apply: (source, image) => {
    const layer = $('.wallpaper-layer');
    // Keep the old painted frame above the fully decoded replacement while it
    // fades out. Hidden pages commit immediately, with no animation to resume.
    let previous;
    if (!document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      previous = layer.cloneNode(false);
      previous.classList.add('wallpaper-outgoing');
      previous.style.backgroundImage = getComputedStyle(layer).backgroundImage;
    }
    document.querySelectorAll('.wallpaper-outgoing').forEach(node => node.remove());
    if (previous) layer.after(previous);
    document.documentElement.style.setProperty('--wallpaper', `url(${JSON.stringify(source)})`);
    displayedWallpaperImage = image;
    updateWallpaperBrightness();
    if (previous) previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease-out', fill: 'forwards' }).finished.then(() => previous.remove(), () => previous.remove());
    window.tabcatStartup?.saveWallpaper(source, image);
  },
});
const wallpaperSession = crypto.randomUUID();
let pendingImportText = '';
const SETTING_KEYS = ['timezone','hour24','dateStyle','showLunar','layoutColumns','layoutRows','clockSize','clockWeight','fontFamily','accentColor','iconSize','iconRadius','iconTextSize','iconTextWeight','iconTextFont','iconTextColor','iconTextColorMode','theme','background','wallpaperRotation','backgroundUrl','backgroundDim','showClock','showSiteNames','openInNewTab','shortcutOpenInNewTab','rowGap','columnGap','searchWidth','searchHeight','searchRadius','searchOpacity','showSearch','showBookmarksBar','bookmarkBarTransparency','iconOpacity','backgroundBlur','backgroundFrost','searchSuggestions','labelColor'];

let savedState;
let pendingSaves = 0;
const storage = {
  async save() {
    const before = savedState;
    const after = structuredClone(state);
    savedState = after;
    pendingSaves++;
    let success = false;
    try { await commitState(before, after); success = true; }
    catch (error) { showStatus(`保存失败：${error.message}`, true); }
    finally {
      pendingSaves--;
      if (!pendingSaves) {
        try { const latest = await loadState(); if (!pendingSaves) acceptState(latest); }
        catch (error) { showStatus(`读取配置失败：${error.message}`, true); }
      }
    }
    return success;
  }
};

function acceptState(value) {
  if (state.currentEngine !== value.currentEngine || !value.searchSuggestions) suggestions?.close();
  state = normalizeState(value);
  savedState = structuredClone(state);
  preloadDesktopIcons();
  syncControls(); applyAppearance(); renderAll(); updateClock(); siteLibrary?.refresh();
}

function showStatus(message, error = false) {
  const toast = $('#status');
  toast.textContent = message; toast.classList.toggle('error', error); toast.hidden = false;
  clearTimeout(showStatus.timer); showStatus.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function init() {
  syncEditMode();
  new ResizeObserver(fitDesktopHeight).observe($('.desktop-content'));
  const [stored, initialTree] = await Promise.all([
    browser.storage.local.get(['tabcat', 'tabcatBing', 'tabcatGallery']),
    browser.bookmarks.getTree().catch(() => null),
  ]);
  state = normalizeState(stored.tabcat);
  bingWallpaper = stored.tabcatBing;
  galleryWallpaper = stored.tabcatGallery;
  savedState = structuredClone(state);
  preloadDesktopIcons();
  $$('[data-icon]').forEach(element => { element.innerHTML = UI_ICONS[element.dataset.icon] || ''; });
  renderWallpaperChoices();
  populateTimezones();
  decorateSettings();
  bookmarkBar = createBookmarkBar({ bar: $('#bookmarkBar'), items: $('#bookmarkBarItems'), menu: $('#bookmarkFolderMenu'), getState: () => state, report: showStatus, initialTree });
  siteLibrary = createSiteLibrary({ dialog: $('#siteLibraryModal'), getState: () => state, custom: () => openCustomSiteModal(), widgets: () => desktop.widgets,
    startDrag: item => desktop.startCandidate(item), endDrag: () => desktop.endCandidate(),
    onToggle: open => { document.documentElement.classList.toggle('library-open', open); renderSites(); },
    add: async (id, placement) => {
    const result = await addCatalogSite(id);
    acceptState(await loadState());
    if (result.site && !result.duplicate) await desktop.place(`site:${result.site.id}`, placement);
    return result;
  } });
  desktop = createDesktop({ addCandidate: (item, placement) => siteLibrary.addCandidate(item, placement), getState: () => state, isEditing: () => editMode, siteCard, renderIcon: renderDesktopIcon, render: renderAll, save: () => storage.save(), report: showStatus, openSite, editSite: openSiteModal, removeSite, goToPage, getPage: () => currentPage, suppress: () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 150); } });
  bindEvents();
  syncControls();
  applyAppearance();
  renderAll();
  suggestions = bindSuggestions({ input: $('#searchInput'), list: $('#suggestionList'), getState: () => state, submit: () => $('#searchForm').requestSubmit() });
  const refreshWallpaper = () => {
    if (state.background === 'bing') void loadBingWallpaper();
    if (GALLERY_NAMES[state.background]) void loadGalleryWallpaper();
  };
  setInterval(refreshWallpaper, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    // Do not start a new download when a tab becomes visible, or resume a fade
    // which began before it was hidden.
    if (document.hidden) document.querySelectorAll('.wallpaper-outgoing').forEach(node => node.remove());
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const bing = changes.tabcatBing?.newValue, gallery = changes.tabcatGallery?.newValue;
    if (state.background === 'bing' && bing?.image) {
      bingWallpaper = bing; bingCheckedAt = Date.now();
      $('#bingStatus').textContent = `${bing.title} · ${bing.copyright}`;
      applyAppearance();
    } else if (state.wallpaperRotation !== 'newtab' && gallery?.image && gallery.provider === state.background && gallery.key === galleryCacheKey(state.wallpaperRotation)) {
      galleryWallpaper = gallery;
      galleryCheckedKey = `${gallery.provider}:${gallery.key}`; galleryCheckedAt = Date.now(); galleryFailed = false;
      $('#galleryStatus').textContent = `${gallery.title} · ${gallery.copyright}`;
      applyAppearance();
    }
  });
  updateClock();
  setInterval(updateClock, 1000);
  watchState(value => { if (!pendingSaves) acceptState(value); });
  // The synchronous preview is already visible. Neither decoding the full image
  // nor the network should hold the controls (or the background) behind a blank screen.
  // Give already-preloaded local icons a frame to settle, with a strict bound
  // so a remote/failed icon never stalls the usable desktop.
  let iconTimer;
  await Promise.race([Promise.allSettled(startupIcons), new Promise(resolve => { iconTimer = setTimeout(resolve, 100); })]);
  clearTimeout(iconTimer); startupIcons.length = 0;
  document.documentElement.classList.remove('booting');
  starting = false;
  refreshWallpaper();
}

function populateTimezones() {
  const common = ['Asia/Shanghai','Asia/Tokyo','Asia/Singapore','Europe/London','Europe/Paris','America/New_York','America/Chicago','America/Los_Angeles','Australia/Sydney','UTC'];
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : common;
  const zones = [...new Set([state.timezone, ...common, ...supported])].filter(Boolean);
  $('#timezone').innerHTML = zones.map(zone => `<option value="${escapeHtml(zone)}">${escapeHtml(zone.replaceAll('_',' '))}</option>`).join('');
}

function decorateSettings() {
  for (const page of $$('.settings-page')) {
    if (page.querySelector('.settings-card') || page.dataset.page === 'data') continue;
    let card;
    for (const child of [...page.children]) {
      if (child.tagName === 'H2' || child.previousElementSibling?.tagName === 'H2' || child.classList.contains('appearance-preview') || child.id === 'wallpaperChoices') continue;
      if (!card || child.tagName === 'H3') {
        card = document.createElement('div'); card.className = 'settings-card';
        page.insertBefore(card, child);
      }
      card.append(child);
    }
  }
  for (const input of $$('input[type="range"]')) {
    const update = () => input.style.setProperty('--range-progress', `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
    input.addEventListener('input', update); update();
  }
}

function updateClock() {
  const now = new Date();
  const timeParts = new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone, hour: '2-digit', minute: '2-digit', hour12: !state.hour24 }).formatToParts(now);
  const hour = timeParts.find(p => p.type === 'hour')?.value || '';
  const minute = timeParts.find(p => p.type === 'minute')?.value || '';
  const period = timeParts.find(p => p.type === 'dayPeriod')?.value || '';
  $('#clock').textContent = state.hour24 ? `${hour}:${minute}` : `${hour}:${minute} ${period}`;
  const parts = getDateParts(now, state.timezone);
  if (state.dateStyle === 'full') $('#dateText').textContent = `${parts.year}年${parts.month}月${parts.day}日 ${parts.weekday}`;
  else if (state.dateStyle === 'iso') $('#dateText').textContent = `${parts.year}-${pad(parts.month)}-${pad(parts.day)} · ${parts.weekday}`;
  else $('#dateText').textContent = `${parts.month}月${parts.day}日 · ${parts.weekday}`;
  const lunar = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: state.timezone, month: 'long', day: 'numeric' }).format(now);
  $('#lunarText').textContent = `农历${lunar.replace(/\s/g, '')}`;
  $('#lunarText').style.display = state.showLunar ? '' : 'none';
  $('.date-line .separator').style.display = state.showLunar ? '' : 'none';
}

function getDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long' }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function renderAll() { renderEngines(); renderSites(); renderManagers(); }

function preloadDesktopIcons() {
  window.tabcatStartup?.preloadIcons([
    ...state.sites.filter(site => !site.icon && !site.iconText).map(site => catalogIcon(site.url)),
    ...state.engines.map(engineIcon),
  ]);
}

function renderDesktopIcon(container, site, options) {
  const ready = renderSiteIcon(container, site, options);
  if (starting) startupIcons.push(ready);
}

function renderEngines() {
  const active = state.engines.find(e => e.id === state.currentEngine) || state.engines[0];
  state.currentEngine = active.id;
  renderDesktopIcon($('#engineIcon'), { ...active, name: active.name[0], url: new URL(active.url).origin }, { engine: true });
  $('#engineIcon').style.color = safeColor(active.color);
  const renderKey = JSON.stringify([state.currentEngine, state.engines]);
  if (renderKey === enginesRenderKey) return;
  enginesRenderKey = renderKey;
  $('#engineMenu').innerHTML = state.engines.map(engine => `<button class="engine-option ${engine.id === active.id ? 'active' : ''}" type="button" data-engine="${escapeHtml(engine.id)}"><span class="engine-badge" style="background:${safeColor(engine.color)}">${escapeHtml(engine.name[0])}</span><span>${escapeHtml(engine.name)}</span></button>`).join('');
  $$('#engineMenu [data-engine]').forEach(button => {
    const engine = state.engines.find(item => item.id === button.dataset.engine);
    void renderSiteIcon(button.querySelector('.engine-badge'), { ...engine, name: engine.name[0], url: new URL(engine.url).origin }, { engine: true });
  });
}

function gridMetrics() {
  const gap = window.innerWidth < 620 ? Math.min(state.columnGap, 18) : state.columnGap;
  const tileWidth = Math.max(92, state.iconSize + 28);
  const sidebarWidth = $('#siteLibraryModal').open && window.innerWidth > 620 ? $('#siteLibraryModal').getBoundingClientRect().width : 0;
  const available = window.innerWidth - sidebarWidth - (window.innerWidth < 620 ? 48 : 120);
  const columns = Math.min(state.layoutColumns, Math.max(2, Math.floor((available + gap) / (tileWidth + gap))));
  return { columns, gap, width: columns * tileWidth + (columns - 1) * gap };
}
function pageCount() { return desktop?.pageCount() || 1; }

function renderSites() {
  if (!desktop) return;
  desktopNavigation?.cancel();
  syncEditMode();
  const metrics = gridMetrics();
  document.documentElement.style.setProperty('--grid-width', `${metrics.width}px`);
  document.documentElement.style.setProperty('--column-gap', `${metrics.gap}px`);
  $('#sitesPages').style.setProperty('--site-cols', metrics.columns);
  const { pages } = desktop.render(metrics.columns, state.layoutRows);
  // Configured rows are page capacity; empty trailing rows must not offset visual centering.
  const rows = Math.max(1, ...pages.flatMap(page => page.map(item => item.y + item.height)));
  document.documentElement.style.setProperty('--grid-row-height', `${state.iconSize + 38}px`);
  document.documentElement.style.setProperty('--page-height', `${rows * (state.iconSize + 38) + (rows - 1) * state.rowGap}px`);
  currentPage = Math.max(0, Math.min(currentPage, pages.length - 1));
  updatePagination();
  fitDesktopHeight();
}

function fitDesktopHeight() {
  const shell = $('.app-shell'), content = $('.desktop-content');
  const style = getComputedStyle(shell);
  const available = Math.max(1, shell.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  // Read the untransformed height so repeated resize/settings updates never compound scaling.
  content.style.setProperty('--desktop-scale', Math.min(1, available / Math.max(1, content.offsetHeight)));
}

function updatePagination() {
  $('#sitesPages').style.transform = `translateX(-${currentPage * 100}%)`;
  $$('.sites-page').forEach((page, i) => { page.inert = i !== currentPage && !page.querySelector('.dragging'); page.setAttribute('aria-hidden', String(i !== currentPage)); });
  $$('.page-dot').forEach((dot, i) => { dot.classList.toggle('active', i === currentPage); dot.setAttribute('aria-current', i === currentPage ? 'page' : 'false'); });
  desktop?.activateFrames();
  $('#previousPage').hidden = currentPage === 0;
  $('#nextPage').hidden = currentPage >= pageCount() - 1;
}

function siteCard(site) {
  const artwork = siteArtwork(site);
  const icon = artwork.markup || escapeHtml(artwork.text || site.name[0]);
  const styles = iconStyles(site);
  return `<button class="site-card" draggable="${editMode}" data-site="${escapeHtml(site.id)}" title="${escapeHtml(site.name)}" aria-label="${escapeHtml(site.name)}" style="${escapeHtml(styles)}"><span class="site-icon">${icon}</span><span class="site-name">${escapeHtml(site.name)}</span></button>`;
}

function iconStyles(site) {
  const artwork = siteArtwork(site);
  return [
    `--auto-text-color:${contrastTextColor(artwork.color)}`, `--tile-color:${artwork.color}`, `--tile-text:${artwork.textColor || '#ffffff'}`,
    `--image-scale:${clampNumber(siteImageScale(site), 40, 160)}%`, `--image-fit:${site.imageFit === 'contain' ? 'contain' : 'cover'}`,
    `--symbol-scale:${clampNumber(site.imageScale || 100, 40, 160) * .44}%`,
    site.iconSize ? `--icon-size:${clampNumber(site.iconSize, 36, 128)}px` : '',
    site.iconRadius != null && site.iconRadius !== '' ? `--icon-radius:${clampNumber(site.iconRadius, 0, 50)}%` : '',
    site.labelSize ? `--site-label-size:${clampNumber(site.labelSize, 10, 22)}px` : '',
    site.iconTextSize ? `--icon-text-size:${clampNumber(site.iconTextSize, 10, 72)}px` : '',
    site.iconTextWeight ? `--icon-text-weight:${clampNumber(site.iconTextWeight, 300, 800)}` : '',
    ICON_FONTS[site.iconTextFont] ? `--icon-text-font:${ICON_FONTS[site.iconTextFont]}` : '',
    /^#[0-9a-f]{6}$/i.test(site.iconTextColor || '') ? `--icon-text-color:${site.iconTextColor}` : '',
  ].filter(Boolean).join(';');
}

function renderManagers() {
  $('#engineList').innerHTML = state.engines.map(engine => sortItem(engine)).join('');
  $$('#engineList .sort-item').forEach(row => {
    const engine = state.engines.find(item => item.id === row.dataset.id);
    void renderSiteIcon(row.querySelector('.item-badge'), { ...engine, name: engine.name[0], url: new URL(engine.url).origin }, { engine: true });
  });
  bindDragItems();
}

function sortItem(item) {
  const selected = item.id === state.currentEngine;
  const badge = `<span class="item-badge" style="background:${safeColor(item.color)}">${escapeHtml(item.name[0])}</span>`;
  const actions = `<button class="mini-button" data-select-engine="${escapeHtml(item.id)}" title="设为默认">${selected ? `${UI_ICONS.check} 默认` : '设为默认'}</button>${state.engines.length > 1 ? `<button class="mini-button" data-delete-engine="${escapeHtml(item.id)}" title="删除" aria-label="删除 ${escapeHtml(item.name)}">${UI_ICONS.trash}</button>` : ''}`;
  return `<div class="sort-item" draggable="true" data-kind="engine" data-id="${escapeHtml(item.id)}"><span class="drag-handle">${UI_ICONS.grip}</span>${badge}<div class="item-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.url)}</small></div>${actions}</div>`;
}

function bindEvents() {
  bindDialogDismissal();
  window.addEventListener('resize', () => { renderSites(); hideContextMenu(); });
  $('#settingsButton').addEventListener('click', () => openSettings());
  $('#manageBookmarks').addEventListener('click', () => browser.tabs.create({ url: 'chrome://bookmarks/' }).catch(error => showStatus(error.message, true)));
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#scrim').addEventListener('click', closeSettings);
  $$('.settings-tabs button').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $('#engineButton').addEventListener('click', event => {
    event.stopPropagation(); $('#engineMenu').hidden = !$('#engineMenu').hidden;
    $('#engineButton').setAttribute('aria-expanded', String(!$('#engineMenu').hidden));
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.search')) { $('#engineMenu').hidden = true; $('#engineButton').setAttribute('aria-expanded', 'false'); }
    if (!event.target.closest('#siteContextMenu')) hideContextMenu();
  });
  $('#engineMenu').addEventListener('click', event => { const button = event.target.closest('[data-engine]'); if (button) selectEngine(button.dataset.engine); });
  $('#searchForm').addEventListener('submit', performSearch);
  $('#sitesPages').addEventListener('click', event => {
    if (suppressClick) return;
    if (event.target.closest('[data-add-site]')) return openSiteModal();
    const card = event.target.closest('[data-site]'); if (card) editMode ? openSiteModal(card.dataset.site) : openSite(card.dataset.site);
  });
  $('#pagination').addEventListener('click', event => { const dot = event.target.closest('[data-page]'); if (dot) goToPage(Number(dot.dataset.page)); });
  $('#previousPage').addEventListener('click', () => goToPage(currentPage - 1));
  $('#nextPage').addEventListener('click', () => goToPage(currentPage + 1));
  $('.app-shell').addEventListener('wheel', handleSiteWheel, { passive: false });
  desktopNavigation = bindDesktopNavigation({ section: $('.sites-section'), viewport: $('#sitesViewport'), pages: $('#sitesPages'), previous: $('#previousPage'), next: $('#nextPage'), getPage: () => currentPage, pageCount, goToPage, isEditing: () => editMode, suppress: () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 250); } });
  $('#addSiteButton').addEventListener('click', () => openSiteModal());
  $('#editDesktopButton').addEventListener('click', () => setEditMode(true));
  $('#editDesktopSettings').addEventListener('click', () => { closeSettings(); setEditMode(true); });
  $('#addWidgetButton').addEventListener('click', () => siteLibrary.open('widgets'));
  $('#finishEditing').addEventListener('click', () => setEditMode(false));
  $('#refreshBing').addEventListener('click', () => loadBingWallpaper(true));
  $('#refreshGallery').addEventListener('click', () => loadGalleryWallpaper(true));
  $('#addEngineButton').addEventListener('click', () => { $('#engineForm').reset(); $('#engineUrl').setCustomValidity(''); $('#engineModal').showModal(); });
  $('#siteForm').addEventListener('submit', saveSite);
  $('#engineForm').addEventListener('submit', saveEngine);
  $('#engineList').addEventListener('click', managerClick);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
  document.addEventListener('keydown', handleKeys);
  for (const input of $$('#siteForm input, #engineForm input, #backgroundUrl')) input.addEventListener('input', () => input.setCustomValidity(''));
  for (const input of $$('#siteImageScale, #siteImageFit, #siteName, #siteColor, #siteIconText, #siteIcon, #siteIconSize, #siteIconRadius, #siteIconTextSize, #siteIconTextWeight, #siteIconTextFont, #siteIconTextColor')) input.addEventListener('input', updateSitePreview);
  $('.icon-source-options').addEventListener('click', event => {
    const button = event.target.closest('[data-icon-source]');
    if (!button) return;
    siteIconSource = button.dataset.iconSource;
    updateSitePreview();
  });
  $('#siteIconText').addEventListener('change', () => {
    $('#siteIconText').value = firstIconCharacter($('#siteIconText').value);
    updateSitePreview();
  });
  $('#refreshSiteIcon').addEventListener('click', () => updateSitePreview(true));
  let previewTimer;
  $('#siteUrl').addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(updateSitePreview, 250); });
  document.addEventListener('contextmenu', event => {
    if (event.target.closest('.settings-panel, dialog, input, textarea, .widget-card, .context-menu, .bookmark-bar, .bookmark-folder-menu')) return;
    event.preventDefault();
    const card = event.target.closest('[data-site]');
    contextSiteId = card?.dataset.site || null;
    showContextMenu(event.clientX, event.clientY);
  });
  $('#siteContextMenu').addEventListener('click', contextAction);
  $('#wallpaperButton').addEventListener('click', () => openSettings('wallpaper'));
  $('#nextWallpaper').addEventListener('click', async () => {
    if (!GALLERY_NAMES[state.background]) state.background = state.background === 'bing' ? 'bing-gallery' : 'picsum';
    syncControls();
    await loadGalleryWallpaper(true);
    applyAppearance(); await storage.save();
  });
  $('#wallpaperChoices').addEventListener('click', async event => {
    const button = event.target.closest('[data-wallpaper]'); if (!button) return;
    state.background = button.dataset.wallpaper; syncControls(); applyAppearance(); await storage.save();
  });
  $('#uploadWallpaper').addEventListener('click', () => $('#wallpaperFile').click());
  $('#wallpaperFile').addEventListener('change', uploadWallpaper);
  $('#exportData').addEventListener('click', exportBackup);
  $('#importData').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', importBackup);
  $('#confirmImport').addEventListener('click', confirmImport);
  $('#cancelImport').addEventListener('click', () => $('#importPreviewModal').close());
  $('#importPreviewModal').addEventListener('close', () => { pendingImportText = ''; $('#importData').focus(); });
  $('#resetButton').addEventListener('click', () => $('#resetModal').showModal());
  $('#resetForm').addEventListener('submit', resetAll);
  bindSettingsControls();
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

function bindSettingsControls() {
  SETTING_KEYS.forEach(key => {
    const el = $(`#${key}`);
    el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', async () => {
      if (key === 'backgroundUrl' && el.value && !normalizeUrl(el.value)) { el.setCustomValidity('请输入有效的 HTTP/HTTPS 图片网址'); el.reportValidity(); return; }
      el.setCustomValidity('');
      if (key === 'background' && el.value === 'local' && !state.backgroundLocal) {
        el.value = state.background; $('#wallpaperFile').click(); return;
      }
      if (key === 'searchSuggestions') suggestions?.close();
      state[key] = el.type === 'checkbox' ? el.checked : (typeof DEFAULTS[key] === 'boolean' ? el.value === 'true' : (el.type === 'range' || ['layoutColumns','layoutRows'].includes(key) ? Number(el.value) : el.value));
      if (key === 'iconTextColor') { state.iconTextColorMode = 'custom'; $('#iconTextColorMode').value = 'custom'; }
      applyAppearance(); updateClock(); renderSites(); updateOutputs(); await storage.save();
    });
  });
}

function syncControls() {
  SETTING_KEYS.forEach(key => { const input = $(`#${key}`); if (input.type === 'checkbox') input.checked = state[key]; else input.value = state[key]; });
  updateOutputs();
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = state.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : state.theme;
  root.dataset.background = state.background;
  root.classList.toggle('hide-site-names', !state.showSiteNames);
  bookmarkBar?.setVisible(state.showBookmarksBar);
  root.style.setProperty('--bookmark-bar-opacity', `${100 - state.bookmarkBarTransparency}%`);
  $('.hero').hidden = !state.showClock;
  $('#searchForm').hidden = !state.showSearch;
  $('#backgroundUrlField').hidden = state.background !== 'custom';
  const wallpaper = WALLPAPERS.find(item => item.id === state.background) || WALLPAPERS[0];
  if (!starting && state.background === 'bing') void loadBingWallpaper();
  const gallery = Boolean(GALLERY_NAMES[state.background]);
  if (!starting && gallery) void loadGalleryWallpaper();
  $('#bingControls').hidden = state.background !== 'bing';
  $('#galleryControls').hidden = !gallery;
  const online = state.background === 'bing' ? bingWallpaper : gallery && galleryWallpaper?.provider === state.background ? galleryWallpaper : null;
  const source = gallery || state.background === 'bing' ? online?.image : state.background === 'custom' ? state.backgroundUrl || wallpaper.image : state.background === 'local' ? state.backgroundLocal : wallpaper.image;
  void wallpaperDisplay.show(source);
  root.style.setProperty('--background-frost', state.backgroundFrost / 100);
  root.style.setProperty('--background-dim', state.backgroundDim / 100);
  root.style.setProperty('--background-blur', `${state.backgroundBlur}px`);
  const text = state.labelColor === 'auto' ? wallpaper.text : state.labelColor;
  root.style.setProperty('--home-text', text === 'dark' ? '#38444e' : '#ffffff');
  updateWallpaperTextShadow();
  $('#wallpaperName').textContent = GALLERY_NAMES[state.background] || (state.background === 'bing' ? 'Bing 每日壁纸' : state.background === 'local' ? '我的壁纸' : state.background === 'custom' ? '自定义壁纸' : wallpaper.name);
  $('#wallpaperCredit').hidden = !online?.source;
  $('#wallpaperCredit').href = online?.source || '#';
  $('#wallpaperCredit').textContent = '查看图片来源 ↗';
  $('#localWallpaperName').textContent = state.backgroundLocalName || '支持 JPG、PNG、WebP，图片仅保存在本机。';
  $$('[data-wallpaper]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.wallpaper === state.background)));
  const fonts = { system: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif', serif: 'Georgia,"Songti SC",serif', rounded: 'ui-rounded,"Arial Rounded MT Bold","PingFang SC",sans-serif', mono: 'ui-monospace,SFMono-Regular,Menlo,monospace' };
  root.style.setProperty('--font', fonts[state.fontFamily] || fonts.system);
  root.style.setProperty('--accent', state.accentColor); root.style.setProperty('--accent-rgb', hexRgb(state.accentColor));
  root.style.setProperty('--clock-weight', state.clockWeight);
  for (const key of ['clockSize','iconSize','rowGap','searchWidth','searchHeight','searchRadius']) root.style.setProperty(`--${key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}`, `${state[key]}px`);
  root.style.setProperty('--icon-radius', `${state.iconRadius}%`);
  root.style.setProperty('--icon-text-size', `${state.iconTextSize}px`);
  root.style.setProperty('--icon-text-weight', state.iconTextWeight);
  root.style.setProperty('--icon-text-font', ICON_FONTS[state.iconTextFont]);
  if (state.iconTextColorMode === 'custom') root.style.setProperty('--icon-text-color', state.iconTextColor);
  else root.style.removeProperty('--icon-text-color');
  $('#iconTextColor').hidden = state.iconTextColorMode !== 'custom';
  $$('.preview-icon').forEach((icon, index) => icon.style.setProperty('--auto-text-color', contrastTextColor(['#568cc4', '#7ba899', '#d2a173'][index])));
  root.style.setProperty('--search-opacity', state.searchOpacity / 100);
  root.style.setProperty('--icon-opacity', state.iconOpacity / 100);
  window.tabcatStartup?.saveAppearance();
}

function updateWallpaperTextShadow() {
  const wallpaper = WALLPAPERS.find(item => item.id === state.background) || WALLPAPERS[0];
  const text = state.labelColor === 'auto' ? wallpaper.text : state.labelColor;
  document.documentElement.style.setProperty('--label-shadow', wallpaperTextShadow(text, displayedWallpaperBrightness, state.backgroundDim / 100, state.backgroundFrost / 100));
}

function updateWallpaperBrightness() {
  displayedWallpaperBrightness = displayedWallpaperImage ? wallpaperBrightness(displayedWallpaperImage, innerWidth, innerHeight) : null;
  updateWallpaperTextShadow();
}
window.addEventListener('resize', updateWallpaperBrightness);

function updateOutputs() {
  for (const input of $$('input[type="range"]')) input.style.setProperty('--range-progress', `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
  for (const key of ['bookmarkBarTransparency','clockSize','iconSize','iconRadius','iconTextSize','backgroundDim','backgroundBlur','backgroundFrost','rowGap','columnGap','searchWidth','searchHeight','searchRadius','searchOpacity','iconOpacity']) {
    const unit = ['bookmarkBarTransparency','iconRadius','backgroundFrost','backgroundDim','searchOpacity','iconOpacity'].includes(key) ? '%' : 'px';
    $(`#${key}Value`).textContent = `${state[key]}${unit}`;
  }
  $('#accentValue').textContent = state.accentColor.toUpperCase();
}

function renderWallpaperChoices() {
  $('#wallpaperChoices').innerHTML = WALLPAPERS.map(wallpaper => `<button type="button" class="wallpaper-choice" data-wallpaper="${wallpaper.id}" aria-label="${wallpaper.name}" aria-pressed="false"><span class="wallpaper-swatch" style="background-image:url('${wallpaper.image}')"></span><span>${wallpaper.name}</span></button>`).join('');
}

function performSearch(event) {
  event.preventDefault(); suggestions?.close(); const query = $('#searchInput').value.trim(); if (!query) return;
  const looksLikeUrl = /^(https?:\/\/|localhost[:/]|([\w-]+\.)+[a-z]{2,})(.*)$/i.test(query) && !query.includes(' ');
  if (looksLikeUrl) { navigate(normalizeUrl(query)); return; }
  const engine = state.engines.find(e => e.id === state.currentEngine) || state.engines[0];
  navigate(engine.url.replace('%s', encodeURIComponent(query)));
}

function openSite(id) {
  const site = state.sites.find(s => s.id === id); if (!site) return;
  navigate(site.url, state.shortcutOpenInNewTab);
}

function navigate(url, openInNewTab = state.openInNewTab) {
  if (!url) return;
  const action = openInNewTab ? browser.tabs.create({ url }) : browser.tabs.update({ url });
  action.catch(error => showStatus(`无法打开链接：${error.message}`, true));
}

function selectEngine(id) { suggestions?.close(); $('#engineButton').setAttribute('aria-expanded', 'false'); state.currentEngine = id; $('#engineMenu').hidden = true; renderEngines(); renderManagers(); storage.save(); if (document.activeElement === $('#searchInput')) suggestions?.update(); }
function goToPage(page) { currentPage = Math.max(0, Math.min(page, pageCount() - 1)); updatePagination(); }

let wheelLockUntil = 0, wheelTotal = 0, wheelLastAt = 0;
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
  goToPage(currentPage + Math.sign(wheelTotal)); wheelTotal = 0; wheelLockUntil = now + 400;
}


function openSettings(tab) {
  siteLibrary?.close();
  settingsReturnFocus = document.activeElement;
  bookmarkBar?.close();
  hideContextMenu();
  if (tab) switchTab(tab);
  $('#settingsPanel').inert = false; $('#scrim').hidden = false;
  $('#settingsPanel').classList.add('open'); $('#settingsPanel').setAttribute('aria-hidden','false');
  for (const element of $$('.app-shell, .corner-tools, .desktop-footer, .bookmark-bar')) element.inert = true;
  $('#closeSettings').focus();
}
function closeSettings() {
  $('#settingsPanel').inert = true; $('#settingsPanel').classList.remove('open'); $('#settingsPanel').setAttribute('aria-hidden','true'); $('#scrim').hidden = true;
  for (const element of $$('.app-shell, .corner-tools, .desktop-footer, .bookmark-bar')) element.inert = false;
  (settingsReturnFocus?.isConnected && settingsReturnFocus.getClientRects().length ? settingsReturnFocus : $('#settingsButton')).focus();
}
function switchTab(tab) { $$('.settings-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); $$('.settings-page').forEach(p => p.classList.toggle('active', p.dataset.page === tab)); }

function openSiteModal(siteId = null) {
  if (!siteId) { siteLibrary.open(); return; }
  openCustomSiteModal(siteId);
}

function openCustomSiteModal(siteId = null) {
  editingSiteId = siteId; const site = state.sites.find(s => s.id === siteId);
  $('#siteModalTitle').textContent = site ? '编辑快捷方式' : '添加网站'; $('#siteName').value = site?.name || ''; $('#siteUrl').value = site?.url || ''; $('#siteIcon').value = site?.icon || '';
  $('#siteIconSize').value = site?.iconSize || ''; $('#siteIconRadius').value = site?.iconRadius ?? ''; $('#siteLabelSize').value = site?.labelSize || '';
  $('#siteImageScale').value = siteImageScale(site || {}); $('#siteImageFit').value = site?.imageFit || 'cover';
  $('#siteIconText').value = site?.iconText || ''; $('#siteColor').value = siteArtwork(site || { name: 'A', url: '' }).color;
  for (const key of ['Size','Weight','Font','Color']) $(`#siteIconText${key}`).value = site?.[`iconText${key}`] || '';
  siteIconSource = site?.iconText ? 'text' : site?.icon ? 'custom' : 'website';
  sitePreviewKey = null; siteArtworkRefreshed = false;
  $('.advanced-fields').open = false; updateSitePreview();
  $('#siteUrl').readOnly = Boolean(site?.builtin);
  for (const input of $$('#siteForm input')) input.setCustomValidity('');
  $('#siteModal').showModal();
}

async function saveSite(event) {
  event.preventDefault(); if (!event.submitter || event.submitter.value === 'cancel') { $('#siteModal').close(); return; }
  const existing = state.sites.find(site => site.id === editingSiteId);
  if (editingSiteId && !existing) { showStatus('此网站已在其他标签页删除，请重新添加。', true); $('#siteModal').close(); return; }
  const name = $('#siteName').value.trim();
  const url = existing?.builtin ? existing.url : normalizeUrl($('#siteUrl').value);
  if (!name || !url) { const input = !name ? $('#siteName') : $('#siteUrl'); input.setCustomValidity(!name ? '请输入网站名称' : '请输入有效的 HTTP/HTTPS 网址'); input.reportValidity(); return; }
  if (state.sites.some(site => site.id !== editingSiteId && normalizeUrl(site.url) && normalizeUrl(site.url) === url)) { $('#siteUrl').setCustomValidity('此网址已在首页'); $('#siteUrl').reportValidity(); return; }
  const rawIcon = siteIconSource === 'custom' ? $('#siteIcon').value.trim() : '';
  if (siteIconSource === 'custom' && !rawIcon) { $('#siteIcon').setCustomValidity('请输入图标图片网址'); $('#siteIcon').reportValidity(); return; }
  const icon = rawIcon ? normalizeUrl(rawIcon) : '';
  if (rawIcon && !icon) { $('#siteIcon').setCustomValidity('请输入有效的 HTTP/HTTPS 图标地址'); $('#siteIcon').reportValidity(); return; }
  const textColor = $('#siteIconTextColor').value.trim();
  if (textColor && !/^#[0-9a-f]{6}$/i.test(textColor)) { $('#siteIconTextColor').setCustomValidity('请输入 #RRGGBB 格式的颜色，或留空跟随全局'); $('#siteIconTextColor').reportValidity(); return; }
  const appearance = {
    imageScale: optionalNumber($('#siteImageScale').value, 40, 160),
    imageFit: $('#siteImageFit').value,
    color: $('#siteColor').value,
    iconText: siteIconSource === 'text' ? ($('#siteIconText').value.trim() || firstIconCharacter(name)) : '',
    iconSize: optionalNumber($('#siteIconSize').value, 36, 128),
    iconRadius: optionalNumber($('#siteIconRadius').value, 0, 50),
    iconTextSize: optionalNumber($('#siteIconTextSize').value, 10, 72),
    iconTextWeight: optionalNumber($('#siteIconTextWeight').value, 300, 800),
    iconTextFont: $('#siteIconTextFont').value,
    iconTextColor: textColor,
    labelSize: optionalNumber($('#siteLabelSize').value, 10, 22),
  };
  if (editingSiteId) Object.assign(existing, { name, url, icon, favicon: url === existing.url && !siteArtworkRefreshed ? existing.favicon : '', iconCandidates: url === existing.url && !siteArtworkRefreshed ? existing.iconCandidates : [], logoCandidates: url === existing.url && !siteArtworkRefreshed ? existing.logoCandidates : [], ...appearance });
  else state.sites.push({ id: crypto.randomUUID(), name, url, ...(icon ? { icon } : {}), ...appearance });
  $('#siteModal').close(); $('#siteForm').reset(); editingSiteId = null; renderSites(); renderManagers(); await storage.save();
}

async function saveEngine(event) {
  event.preventDefault(); if (!event.submitter || event.submitter.value === 'cancel') { $('#engineModal').close(); return; }
  const name = $('#engineName').value.trim(); const url = $('#engineUrl').value.trim(); if (!name || !url.includes('%s') || !normalizeUrl(url)) { $('#engineUrl').setCustomValidity('请输入包含 %s 的有效 HTTP/HTTPS 搜索地址'); $('#engineUrl').reportValidity(); return; }
  const engine = { id: crypto.randomUUID(), name, url: normalizeUrl(url), color: state.accentColor }; state.engines.push(engine); state.currentEngine = engine.id;
  $('#engineModal').close(); $('#engineForm').reset(); renderEngines(); renderManagers(); await storage.save();
}

async function managerClick(event) {
  const select = event.target.closest('[data-select-engine]');
  const delEngine = event.target.closest('[data-delete-engine]');
  if (select) return selectEngine(select.dataset.selectEngine);
  if (!delEngine) return;
  state.engines = state.engines.filter(e => e.id !== delEngine.dataset.deleteEngine);
  if (!state.engines.some(e => e.id === state.currentEngine)) state.currentEngine = state.engines[0].id;
  renderAll(); await storage.save();
}

function bindDragItems() {
  $$('.sort-item').forEach(item => {
    item.addEventListener('dragstart', () => { dragState = { kind: item.dataset.kind, id: item.dataset.id }; item.classList.add('dragging'); });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); $$('.sort-item').forEach(i => i.classList.remove('drag-over')); dragState = null; });
    item.addEventListener('dragover', e => { if (dragState?.kind === item.dataset.kind) { e.preventDefault(); item.classList.add('drag-over'); } });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async e => { e.preventDefault(); if (!dragState || dragState.kind !== item.dataset.kind || dragState.id === item.dataset.id) return; const key = 'engines'; const from = state[key].findIndex(i => i.id === dragState.id); const to = state[key].findIndex(i => i.id === item.dataset.id); const [moved] = state[key].splice(from, 1); state[key].splice(to, 0, moved); renderAll(); await storage.save(); });
  });
}

async function resetAll(event) {
  event.preventDefault();
  $('#resetModal').close();
  if (event.submitter?.value !== 'confirm') return;
  state = structuredClone(DEFAULTS); currentPage = 0; syncControls(); applyAppearance(); renderAll(); updateClock(); await storage.save();
}
function clampNumber(value, min, max) { return Math.max(min, Math.min(max, Number(value))); }
function optionalNumber(value, min, max) { return value === '' ? null : clampNumber(value, min, max); }
function pad(value) { return String(value).padStart(2, '0'); }
function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(value || '') ? value : state.accentColor; }
function hexRgb(hex) { const value = hex.replace('#',''); return `${parseInt(value.slice(0,2),16)}, ${parseInt(value.slice(2,4),16)}, ${parseInt(value.slice(4,6),16)}`; }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }

init().catch(error => {
  starting = false;
  document.documentElement.classList.remove('booting');
  void wallpaperDisplay.show(WALLPAPERS[0].image);
  showStatus(`加载失败：${error.message}`, true);
});

function updateSitePreview(force = false) {
  if (force === true) siteArtworkRefreshed = true;
  const existing = state.sites.find(site => site.id === editingSiteId);
  const url = normalizeUrl($('#siteUrl').value);
  const preview = {
    name: $('#siteName').value.trim() || 'A', url,
    builtin: existing?.builtin,
    favicon: existing?.url === url && !siteArtworkRefreshed ? existing.favicon : '',
    iconCandidates: existing?.url === url && !siteArtworkRefreshed ? existing.iconCandidates : [],
    logoCandidates: existing?.url === url && !siteArtworkRefreshed ? existing.logoCandidates : [],
    imageScale: $('#siteImageScale').value, imageFit: $('#siteImageFit').value,
    icon: siteIconSource === 'custom' ? $('#siteIcon').value.trim() : '', iconText: siteIconSource === 'text' ? ($('#siteIconText').value.trim() || firstIconCharacter($('#siteName').value) || '字') : '', color: $('#siteColor').value,
    iconSize: $('#siteIconSize').value, iconRadius: $('#siteIconRadius').value,
    iconTextSize: $('#siteIconTextSize').value, iconTextWeight: $('#siteIconTextWeight').value,
    iconTextFont: $('#siteIconTextFont').value, iconTextColor: $('#siteIconTextColor').value,
  };
  for (const button of $$('[data-icon-source]')) button.setAttribute('aria-pressed', String(button.dataset.iconSource === siteIconSource));
  $('#siteTextFields').hidden = siteIconSource !== 'text';
  $('#siteCustomFields').hidden = siteIconSource !== 'custom';
  $('#siteIcon').disabled = siteIconSource !== 'custom';
  $('#siteIconText').disabled = siteIconSource !== 'text';
  $('.image-controls').hidden = siteIconSource === 'text';
  $('#sitePreview').style.cssText = iconStyles(preview);
  $('#siteImageScaleValue').textContent = `${preview.imageScale}%`;
  $('#siteImageScale').style.setProperty('--range-progress', `${(Number(preview.imageScale) - 40) / 120 * 100}%`);
  const key = JSON.stringify([siteIconSource, preview.name, preview.url, preview.builtin, preview.icon, preview.iconText, preview.favicon, preview.iconCandidates, preview.logoCandidates, preview.iconSize, preview.imageScale]);
  $('#refreshSiteIcon').hidden = siteIconSource !== 'website' || Boolean(preview.builtin);
  $('#refreshSiteIcon').disabled = !url;
  if (sitePreviewKey === key && force !== true) return;
  sitePreviewKey = key;
  const request = ++sitePreviewRequest;
  const status = $('#siteIconStatus');
  status.textContent = siteIconSource === 'text' ? '默认使用名称首字；字色跟随底色亮度，可在下方自定义。' : preview.builtin && !preview.icon ? '使用浏览器内置图标。' : !url && !preview.icon ? '输入网址后自动获取网站图标。' : '正在获取图标…';
  void renderSiteIcon($('#sitePreview'), preview, { refresh: force === true, discover: true }).then(() => {
    if (request !== sitePreviewRequest || siteIconSource === 'text' || (preview.builtin && !preview.icon) || (!url && !preview.icon)) return;
    status.textContent = $('#sitePreview').classList.contains('has-image') ? (siteIconSource === 'custom' ? '图片预览已更新。' : '已获取网站图标，也可以切换为单字图标。') : '暂未获取到图片，使用名称首字；也可以选择单字图标。';
  });
}

function hideContextMenu() { $('#siteContextMenu').hidden = true; }
function showContextMenu(x, y) {
  const menu = $('#siteContextMenu');
  const site = state.sites.find(site => site.id === contextSiteId);
  for (const button of menu.querySelectorAll('button')) {
    const action = button.dataset.contextAction;
    button.hidden = ['open','edit','delete'].includes(action) ? !site : Boolean(site);
  }
  $('[data-context-action=mode]').innerHTML = `${editMode ? '完成编辑' : '进入编辑模式'}<span>${editMode ? UI_ICONS.check : UI_ICONS.edit}</span>`;
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button:not([hidden])')?.focus();
}

async function contextAction(event) {
  const button = event.target.closest('[data-context-action]'); if (!button) return;
  const site = state.sites.find(site => site.id === contextSiteId);
  hideContextMenu();
  switch (button.dataset.contextAction) {
    case 'open': if (site) await browser.tabs.create({ url: site.url }); break;
    case 'edit': if (site) openSiteModal(site.id); break;
    case 'delete': if (site) await removeSite(site.id); break;
    case 'add': openSiteModal(); break;
    case 'mode': setEditMode(!editMode); break;
    case 'wallpaper': openSettings('wallpaper'); break;
    case 'settings': openSettings(); break;
  }
}

function handleKeys(event) {
  if (event.defaultPrevented) return;
  // Let the open select picker handle Escape and arrow keys before the drawer.
  if (CSS.supports('selector(select:open)') && document.querySelector('select:open')) return;
  if (event.target.closest('.bookmark-bar, .bookmark-folder-menu')) return;
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') {
    if (!$('#siteContextMenu').hidden) { hideContextMenu(); $$('.site-card').find(card => card.dataset.site === contextSiteId)?.focus(); }
    else if (!$('#engineMenu').hidden) { $('#engineMenu').hidden = true; $('#engineButton').setAttribute('aria-expanded', 'false'); $('#engineButton').focus(); }
    else if ($('#settingsPanel').classList.contains('open')) closeSettings();
    else if (editMode) setEditMode(false);
    return;
  }
  if (!$('#siteContextMenu').hidden && ['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault(); const buttons = [...$('#siteContextMenu').querySelectorAll('button:not([hidden])')];
    const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); return;
  }
  if ($('#settingsPanel').classList.contains('open')) {
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
  if (event.key === 'ArrowLeft') goToPage(currentPage - 1);
  if (event.key === 'ArrowRight') goToPage(currentPage + 1);
}

async function removeSite(id) {
  const index = state.sites.findIndex(site => site.id === id);
  const site = state.sites[index]; if (!site) return;
  const folderBefore = structuredClone(state.folders.find(folder => folder.siteIds.includes(id)));
  const orderBefore = state.desktopOrder.findIndex(item => item.id === (folderBefore ? `folder:${folderBefore.id}` : `site:${id}`));
  state.sites.splice(index, 1); renderAll(); if (!await storage.save()) return;
  showStatus(`已移除「${site.name}」`);
  const undo = document.createElement('button'); undo.textContent = '撤销';
  undo.addEventListener('click', async () => {
    if (!state.sites.some(item => item.id === site.id)) state.sites.splice(Math.min(index, state.sites.length), 0, site);
    if (folderBefore) {
      const folder = state.folders.find(item => item.id === folderBefore.id);
      if (folder) { if (!folder.siteIds.includes(id)) folder.siteIds.splice(folderBefore.siteIds.indexOf(id), 0, id); }
      else { state.folders.push({ ...folderBefore, siteIds: [id] }); state.desktopOrder.splice(Math.max(0, orderBefore), 0, { id: `folder:${folderBefore.id}` }); }
    } else state.desktopOrder.splice(Math.max(0, orderBefore), 0, { id: `site:${id}` });
    renderAll(); if (await storage.save()) $('#status').hidden = true;
  });
  $('#status').append(undo);
}

async function uploadWallpaper() {
  const file = $('#wallpaperFile').files[0]; if (!file) return;
  const button = $('#uploadWallpaper'); button.disabled = true; button.textContent = '正在处理图片…';
  try {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('请选择 10 MB 以内的 JPG、PNG 或 WebP 图片');
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 60000000) { bitmap.close(); throw new Error('图片分辨率过大，请选择 6000 万像素以内的图片'); }
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const data = canvas.toDataURL('image/webp', .85);
    if (data.length > 3 * 1024 * 1024) throw new Error('图片压缩后仍然过大，请选择较小的图片');
    state.backgroundLocal = data; state.backgroundLocalName = file.name; state.background = 'local';
    syncControls(); applyAppearance(); if (await storage.save()) showStatus('本地壁纸已应用');
  } catch (error) { showStatus(error.message || '无法读取这张图片', true); }
  finally { button.disabled = false; button.textContent = '从电脑选择图片'; $('#wallpaperFile').value = ''; }
}
function exportBackup() {
  const url = URL.createObjectURL(new Blob([createBackup(state)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tabcat-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importBackup() {
  const file = $('#backupFile').files[0]; if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 20 MB');
    const text = await file.text();
    const result = inspectBackup(text, state);
    pendingImportText = text;
    const { summary } = result;
    const name = { tabcat: 'TabCat', infinity: 'Infinity', itab: 'iTab' }[result.format];
    $('#importSource').textContent = `${name} · ${file.name}`;
    $('#importSummary').textContent = `网站 ${summary.sites.imported} 个 · 搜索引擎 ${summary.engines.imported} 个 · 设置 ${summary.settings.imported} 项`;
    $('#importMode').textContent = summary.mode === 'replace' ? '将用这份 TabCat 备份替换当前配置。' : '保留已有网站并追加导入，重复网址自动跳过；仅覆盖可兼容的设置。';
    $('#importWarnings').replaceChildren(...result.warnings.map(warning => { const item = document.createElement('li'); item.textContent = warning; return item; }));
    $('#importWarnings').hidden = !result.warnings.length;
    $('#importPreviewModal').showModal();
  } catch (error) { showStatus(error.message || '导入失败', true); }
  finally { $('#backupFile').value = ''; }
}

async function confirmImport() {
  if (!pendingImportText) return;
  try {
    const result = inspectBackup(pendingImportText, state);
    state = result.state; currentPage = 0;
    $('#importPreviewModal').close();
    populateTimezones(); syncControls(); applyAppearance(); renderAll(); updateClock();
    if (await storage.save()) showStatus(result.format === 'tabcat' ? '备份已恢复' : '兼容数据已导入');
  } catch (error) { showStatus(error.message || '导入失败', true); }
}

function syncEditMode() {
  document.documentElement.classList.toggle('editing', editMode);
  $('#editDesktopButton').hidden = editMode;
  $('#addSiteButton').hidden = !editMode;
  $('#finishEditing').hidden = !editMode;
  $('#editingHint').hidden = !editMode;
}

function setEditMode(enabled) {
  editMode = enabled;
  hideContextMenu(); renderSites();
  (editMode ? $('#finishEditing') : $('#settingsButton')).focus();
}

async function loadBingWallpaper(force = false) {
  if (bingLoading || (!force && Date.now() - bingCheckedAt < 60 * 60 * 1000)) return;
  bingCheckedAt = Date.now(); $('#bingStatus').textContent = '正在获取今日壁纸…';
  $('#refreshBing').disabled = true;
  bingLoading = true;
  try {
    const result = await browser.runtime.sendMessage({ type: 'tabcat:bing', force });
    if (!result?.ok) throw new Error(result?.error || '暂时无法获取 Bing 壁纸');
    bingWallpaper = result.wallpaper;
    $('#bingStatus').textContent = `${bingWallpaper.title} · ${bingWallpaper.copyright}${bingWallpaper.stale ? '（离线缓存）' : ''}`;
    if (state.background === 'bing') applyAppearance();
  } catch {
    $('#bingStatus').textContent = '暂时无法连接 Bing，显示已有壁纸，可稍后重试。';
  } finally { bingLoading = false; $('#refreshBing').disabled = false; }
}

async function loadGalleryWallpaper(force = false) {
  const provider = state.background;
  if (!GALLERY_NAMES[provider]) return;
  const rotation = state.wallpaperRotation;
  const key = `${provider}:${galleryCacheKey(rotation, Date.now(), wallpaperSession)}`;
  if (!force && galleryCheckedKey === key && (!galleryFailed || Date.now() - galleryCheckedAt < 60 * 1000)) return;
  galleryCheckedKey = key; galleryCheckedAt = Date.now();
  galleryFailed = false;
  const request = ++galleryRequest;
  const active = () => request === galleryRequest && state.background === provider;
  $('#galleryStatus').textContent = '正在加载照片…';
  $('#refreshGallery').disabled = true; $('#nextWallpaper').disabled = true;
  try {
    // The current image stays painted until the replacement is decoded.
    const result = await browser.runtime.sendMessage({ type: 'tabcat:gallery', provider, rotation, session: wallpaperSession, force });
    if (!result?.ok) throw new Error(result?.error || '暂时无法获取照片');
    if (!active()) return;
    const image = new Image(); image.src = result.wallpaper.image; await image.decode();
    if (!active()) return;
    galleryWallpaper = result.wallpaper;
    galleryFailed = Boolean(galleryWallpaper.stale);
    $('#galleryStatus').textContent = `${galleryWallpaper.title} · ${galleryWallpaper.copyright}${galleryWallpaper.stale ? '（连接失败，使用上次缓存）' : ''}`;
    applyAppearance();
  } catch {
    if (active()) { galleryFailed = true; $('#galleryStatus').textContent = '暂时无法连接图库，保留已缓存的照片或远山壁纸，可点击重试。'; }
  } finally {
    if (request === galleryRequest) { $('#refreshGallery').disabled = false; $('#nextWallpaper').disabled = false; }
  }
}
