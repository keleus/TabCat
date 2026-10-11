import { browser } from 'wxt/browser';
import { ICON_FONTS, contrastTextColor } from '../../lib/appearance.js';
import { DEFAULTS } from '../../lib/defaults.js';
import { normalizeUrl } from '../../lib/state.js';
import { $, $$, app, state, setState, storage, showStatus, escapeHtml, hexRgb } from './app.js';
import { updateClock } from './clock.js';
import { hideContextMenu } from './context-menu.js';
import { renderAll, renderSites, setEditMode } from './desktop-view.js';
import { applyWallpaper } from './wallpaper.js';

const SETTING_KEYS = ['timezone','hour24','dateStyle','showLunar','layoutColumns','layoutRows','clockSize','clockWeight','fontFamily','accentColor','iconSize','iconRadius','iconTextSize','iconTextWeight','iconTextFont','iconTextColor','iconTextColorMode','theme','background','wallpaperRotation','backgroundUrl','backgroundDim','showClock','showSiteNames','openInNewTab','shortcutOpenInNewTab','rowGap','columnGap','searchWidth','searchHeight','searchRadius','searchOpacity','showSearch','showBookmarksBar','bookmarkBarTransparency','iconOpacity','backgroundBlur','backgroundFrost','searchSuggestions','labelColor'];
let settingsReturnFocus = null;

export function bindSettings() {
  $('#settingsButton').addEventListener('click', () => openSettings());
  $('#manageBookmarks').addEventListener('click', () => browser.tabs.create({ url: 'chrome://bookmarks/' }).catch(error => showStatus(error.message, true)));
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#scrim').addEventListener('click', closeSettings);
  $$('.settings-tabs button').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $('#editDesktopSettings').addEventListener('click', () => { closeSettings(); setEditMode(true); });
  $('#wallpaperButton').addEventListener('click', () => openSettings('wallpaper'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
  $('#backgroundUrl').addEventListener('input', () => $('#backgroundUrl').setCustomValidity(''));
  $('#resetButton').addEventListener('click', () => $('#resetModal').showModal());
  $('#resetForm').addEventListener('submit', resetAll);
  bindSettingsControls();
}

export function populateTimezones() {
  const common = ['Asia/Shanghai','Asia/Tokyo','Asia/Singapore','Europe/London','Europe/Paris','America/New_York','America/Chicago','America/Los_Angeles','Australia/Sydney','UTC'];
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : common;
  const zones = [...new Set([state.timezone, ...common, ...supported])].filter(Boolean);
  $('#timezone').innerHTML = zones.map(zone => `<option value="${escapeHtml(zone)}">${escapeHtml(zone.replaceAll('_',' '))}</option>`).join('');
}

export function decorateSettings() {
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

function bindSettingsControls() {
  SETTING_KEYS.forEach(key => {
    const el = $(`#${key === 'showSiteNames' ? 'namelessMode' : key}`);
    el.addEventListener(el.type === 'range' || el.type === 'color' ? 'input' : 'change', async () => {
      if (key === 'backgroundUrl' && el.value && !normalizeUrl(el.value)) { el.setCustomValidity('请输入有效的 HTTP/HTTPS 图片网址'); el.reportValidity(); return; }
      el.setCustomValidity('');
      if (key === 'background' && el.value === 'local' && !state.backgroundLocal) {
        el.value = state.background; $('#wallpaperFile').click(); return;
      }
      if (key === 'searchSuggestions') app.suggestions?.close();
      state[key] = el.type === 'checkbox' ? el.checked : (typeof DEFAULTS[key] === 'boolean' ? el.value === 'true' : (el.type === 'range' || ['layoutColumns','layoutRows'].includes(key) ? Number(el.value) : el.value));
      if (key === 'showSiteNames') state[key] = !el.checked;
      if (key === 'iconTextColor') { state.iconTextColorMode = 'custom'; $('#iconTextColorMode').value = 'custom'; }
      applyAppearance(); updateClock(); renderSites(); updateOutputs(); await storage.save();
    });
  });
}

export function syncControls() {
  SETTING_KEYS.forEach(key => { const input = $(`#${key === 'showSiteNames' ? 'namelessMode' : key}`); if (input.type === 'checkbox') input.checked = key === 'showSiteNames' ? !state[key] : state[key]; else input.value = state[key]; });
  updateOutputs();
}

export function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = state.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : state.theme;
  root.classList.toggle('hide-site-names', !state.showSiteNames);
  app.bookmarkBar?.setVisible(state.showBookmarksBar);
  root.style.setProperty('--bookmark-bar-opacity', `${100 - state.bookmarkBarTransparency}%`);
  $('.hero').hidden = !state.showClock;
  $('#searchForm').hidden = !state.showSearch;
  applyWallpaper();
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

function updateOutputs() {
  for (const input of $$('input[type="range"]')) input.style.setProperty('--range-progress', `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
  for (const key of ['bookmarkBarTransparency','clockSize','iconSize','iconRadius','iconTextSize','backgroundDim','backgroundBlur','backgroundFrost','rowGap','columnGap','searchWidth','searchHeight','searchRadius','searchOpacity','iconOpacity']) {
    const unit = ['bookmarkBarTransparency','iconRadius','backgroundFrost','backgroundDim','searchOpacity','iconOpacity'].includes(key) ? '%' : 'px';
    $(`#${key}Value`).textContent = `${state[key]}${unit}`;
  }
  $('#accentValue').textContent = state.accentColor.toUpperCase();
}

export function isSettingsOpen() { return $('#settingsPanel').classList.contains('open'); }

export function openSettings(tab) {
  app.siteLibrary?.close();
  settingsReturnFocus = document.activeElement;
  app.bookmarkBar?.close();
  hideContextMenu();
  if (tab) switchTab(tab);
  $('#settingsPanel').inert = false; $('#scrim').hidden = false;
  $('#settingsPanel').classList.add('open'); $('#settingsPanel').setAttribute('aria-hidden','false');
  for (const element of $$('.app-shell, .corner-tools, .desktop-footer, .bookmark-bar')) element.inert = true;
  $('#closeSettings').focus();
}

export function closeSettings() {
  $('#settingsPanel').inert = true; $('#settingsPanel').classList.remove('open'); $('#settingsPanel').setAttribute('aria-hidden','true'); $('#scrim').hidden = true;
  for (const element of $$('.app-shell, .corner-tools, .desktop-footer, .bookmark-bar')) element.inert = false;
  (settingsReturnFocus?.isConnected && settingsReturnFocus.getClientRects().length ? settingsReturnFocus : $('#settingsButton')).focus();
}

function switchTab(tab) { $$('.settings-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); $$('.settings-page').forEach(p => p.classList.toggle('active', p.dataset.page === tab)); }

async function resetAll(event) {
  event.preventDefault();
  $('#resetModal').close();
  if (event.submitter?.value !== 'confirm') return;
  setState(structuredClone(DEFAULTS)); app.currentPage = 0; syncControls(); applyAppearance(); renderAll(); updateClock(); await storage.save();
}
