import { UI_ICONS } from '../../lib/appearance.js';
import { renderSiteIcon } from '../../lib/site-icons.js';
import { normalizeUrl } from '../../lib/state.js';
import { $, $$, app, state, storage, navigate, escapeHtml, safeColor } from './app.js';
import { renderAll, renderDesktopIcon } from './desktop-view.js';

let enginesRenderKey;
let dragState = null;

export function bindEngines() {
  $('#engineButton').addEventListener('click', event => {
    event.stopPropagation(); $('#engineMenu').hidden = !$('#engineMenu').hidden;
    $('#engineButton').setAttribute('aria-expanded', String(!$('#engineMenu').hidden));
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.search')) { $('#engineMenu').hidden = true; $('#engineButton').setAttribute('aria-expanded', 'false'); }
  });
  $('#engineMenu').addEventListener('click', event => { const button = event.target.closest('[data-engine]'); if (button) selectEngine(button.dataset.engine); });
  $('#searchForm').addEventListener('submit', performSearch);
  $('#addEngineButton').addEventListener('click', () => { $('#engineForm').reset(); $('#engineUrl').setCustomValidity(''); $('#engineModal').showModal(); });
  $('#engineForm').addEventListener('submit', saveEngine);
  $('#engineList').addEventListener('click', managerClick);
  for (const input of $$('#engineForm input')) input.addEventListener('input', () => input.setCustomValidity(''));
}

export function isEngineMenuOpen() { return !$('#engineMenu').hidden; }
export function closeEngineMenu() { $('#engineMenu').hidden = true; $('#engineButton').setAttribute('aria-expanded', 'false'); $('#engineButton').focus(); }

export function renderEngines() {
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

export function renderManagers() {
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

function bindDragItems() {
  $$('.sort-item').forEach(item => {
    item.addEventListener('dragstart', () => { dragState = { kind: item.dataset.kind, id: item.dataset.id }; item.classList.add('dragging'); });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); $$('.sort-item').forEach(i => i.classList.remove('drag-over')); dragState = null; });
    item.addEventListener('dragover', e => { if (dragState?.kind === item.dataset.kind) { e.preventDefault(); item.classList.add('drag-over'); } });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async e => { e.preventDefault(); if (!dragState || dragState.kind !== item.dataset.kind || dragState.id === item.dataset.id) return; const key = 'engines'; const from = state[key].findIndex(i => i.id === dragState.id); const to = state[key].findIndex(i => i.id === item.dataset.id); const [moved] = state[key].splice(from, 1); state[key].splice(to, 0, moved); renderAll(); await storage.save(); });
  });
}

function performSearch(event) {
  event.preventDefault(); app.suggestions?.close(); const query = $('#searchInput').value.trim(); if (!query) return;
  const looksLikeUrl = /^(https?:\/\/|localhost[:/]|([\w-]+\.)+[a-z]{2,})(.*)$/i.test(query) && !query.includes(' ');
  if (looksLikeUrl) { navigate(normalizeUrl(query)); return; }
  const engine = state.engines.find(e => e.id === state.currentEngine) || state.engines[0];
  navigate(engine.url.replace('%s', encodeURIComponent(query)));
}

function selectEngine(id) { app.suggestions?.close(); $('#engineButton').setAttribute('aria-expanded', 'false'); state.currentEngine = id; $('#engineMenu').hidden = true; renderEngines(); renderManagers(); storage.save(); if (document.activeElement === $('#searchInput')) app.suggestions?.update(); }

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
