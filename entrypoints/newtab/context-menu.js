import { browser } from 'wxt/browser';
import { UI_ICONS } from '../../lib/appearance.js';
import { $, $$, app, state } from './app.js';
import { setEditMode } from './desktop-view.js';
import { openSettings } from './settings.js';
import { openSiteModal, removeSite } from './sites.js';

let contextSiteId = null;

export function bindContextMenu() {
  window.addEventListener('resize', hideContextMenu);
  document.addEventListener('click', event => { if (!event.target.closest('#siteContextMenu')) hideContextMenu(); });
  document.addEventListener('contextmenu', event => {
    if (event.target.closest('.settings-panel, dialog, input, textarea, .widget-card, .context-menu, .bookmark-bar, .bookmark-folder-menu')) return;
    event.preventDefault();
    const card = event.target.closest('[data-site]');
    contextSiteId = card?.dataset.site || null;
    showContextMenu(event.clientX, event.clientY);
  });
  $('#siteContextMenu').addEventListener('click', contextAction);
}

export function isContextMenuOpen() { return !$('#siteContextMenu').hidden; }
export function hideContextMenu() { $('#siteContextMenu').hidden = true; }

// Escape returns focus to the shortcut the menu was opened from.
export function dismissContextMenu() {
  hideContextMenu(); $$('.site-card').find(card => card.dataset.site === contextSiteId)?.focus();
}

export function moveContextMenuFocus(step) {
  const buttons = [...$('#siteContextMenu').querySelectorAll('button:not([hidden])')];
  const index = buttons.indexOf(document.activeElement); buttons[(index + step + buttons.length) % buttons.length].focus();
}

function showContextMenu(x, y) {
  const menu = $('#siteContextMenu');
  const site = state.sites.find(site => site.id === contextSiteId);
  for (const button of menu.querySelectorAll('button')) {
    const action = button.dataset.contextAction;
    button.hidden = ['open','edit','delete'].includes(action) ? !site : Boolean(site);
  }
  $('[data-context-action=mode]').innerHTML = `${app.editMode ? '完成编辑' : '进入编辑模式'}<span>${app.editMode ? UI_ICONS.check : UI_ICONS.edit}</span>`;
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
    case 'mode': setEditMode(!app.editMode); break;
    case 'wallpaper': openSettings('wallpaper'); break;
    case 'settings': openSettings(); break;
  }
}
