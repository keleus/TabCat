// Shared new-tab state. `state` is a live binding: modules read the current
// value through the import and replace it with setState().
import { browser } from 'wxt/browser';
import { DEFAULTS } from '../../lib/defaults.js';
import { normalizeState } from '../../lib/state.js';
import { loadState, commitState } from '../../lib/storage.js';

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => [...document.querySelectorAll(selector)];

export let state = structuredClone(DEFAULTS);
export function setState(value) { state = value; }

// Page-level flags and the controllers created during init().
export const app = {
  starting: true,
  editMode: false,
  currentPage: 0,
  desktop: null,
  desktopNavigation: null,
  siteLibrary: null,
  bookmarkBar: null,
  suggestions: null,
};

let savedState;
let pendingSaves = 0;
let refreshView = () => {};
export function onStateAccepted(callback) { refreshView = callback; }
export function markSaved() { savedState = structuredClone(state); }
export function hasPendingSaves() { return pendingSaves > 0; }

export const storage = {
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

export function acceptState(value) {
  if (state.currentEngine !== value.currentEngine || !value.searchSuggestions) app.suggestions?.close();
  state = normalizeState(value);
  markSaved();
  refreshView();
}

export function showStatus(message, error = false) {
  const toast = $('#status');
  toast.textContent = message; toast.classList.toggle('error', error); toast.hidden = false;
  clearTimeout(showStatus.timer); showStatus.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}

export function navigate(url, openInNewTab = state.openInNewTab) {
  if (!url) return;
  const action = openInNewTab ? browser.tabs.create({ url }) : browser.tabs.update({ url });
  action.catch(error => showStatus(`无法打开链接：${error.message}`, true));
}

export function clampNumber(value, min, max) { return Math.max(min, Math.min(max, Number(value))); }
export function optionalNumber(value, min, max) { return value === '' ? null : clampNumber(value, min, max); }
export function pad(value) { return String(value).padStart(2, '0'); }
export function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(value || '') ? value : state.accentColor; }
export function hexRgb(hex) { const value = hex.replace('#',''); return `${parseInt(value.slice(0,2),16)}, ${parseInt(value.slice(2,4),16)}, ${parseInt(value.slice(4,6),16)}`; }
export function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
