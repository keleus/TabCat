import { desktopItems, packDesktop, moveDesktopItem, mergeDesktopSites, normalizeDesktop } from './desktop.js';
import { normalizeUrl } from './state.js';
import { createWidgets } from './widgets.js';
import { UI_ICONS } from './icons.js';
import { createDragFeedback, tilePositions, animateTiles } from './drag-feedback.js';
import { createReorderPreview } from './desktop-reorder-preview.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function createDesktop({ initialWeather, getState, isEditing, siteCard, renderIcon, render, save, report, openSite, editSite, removeSite, goToPage, getPage, suppress, addCandidate }) {
  const container = document.querySelector('#sitesPages');
  const feedback = createDragFeedback();
  let layout = { pages: [[]], rows: 2 }, renderKey, drag = null, candidate = null, pageTimer, folderId = null;
  let gridColumns, reorderPreview, settlingPositions;
  const widgets = createWidgets({ initialWeather, getState, render, save, report, reveal: key => goToPage(layout.pages.findIndex(page => page.some(item => item.key === key))) });
  const folderDialog = document.createElement('dialog'); folderDialog.id = 'desktopFolder'; folderDialog.className = 'modal desktop-folder';
  folderDialog.innerHTML = `<div class="modal-header"><h2 id="folderTitle"></h2><button class="icon-button" data-folder-close aria-label="关闭文件夹">${UI_ICONS.close}</button></div><div class="folder-editor"><label for="folderName">文件夹名称</label><input id="folderName" maxlength="80"><button class="secondary-button" data-folder-dissolve>解散文件夹</button><p class="helper">拖动调整文件夹内顺序；点击“移出”放回桌面。</p></div><div class="folder-members"></div>`;
  folderDialog.setAttribute('aria-labelledby', 'folderTitle'); document.body.append(folderDialog);
  folderDialog.addEventListener('close', () => folderDialog.querySelector('.folder-members').replaceChildren());
  folderDialog.querySelector('[data-folder-close]').onclick = () => folderDialog.close();
  folderDialog.querySelector('#folderName').onchange = async event => {
    const folder = getState().folders.find(item => item.id === folderId); if (!folder) return;
    folder.name = event.target.value.trim() || '新建文件夹'; render(); await save();
  };
  folderDialog.querySelector('[data-folder-dissolve]').onclick = async () => {
    const state = getState(), folder = state.folders.find(item => item.id === folderId); if (!folder) return;
    state.desktopOrder = state.desktopOrder.flatMap(item => item.id === `folder:${folderId}` ? folder.siteIds.map(id => ({ id: `site:${id}` })) : [item]);
    state.folders = state.folders.filter(item => item.id !== folderId); folderDialog.close(); render(); await save();
  };
  function renderFolder() {
    if (!folderDialog.open) return;
    const state = getState(), folder = state.folders.find(item => item.id === folderId); if (!folder) { folderDialog.close(); return; }
    folderDialog.querySelector('#folderTitle').textContent = folder.name;
    const input = folderDialog.querySelector('#folderName'); if (document.activeElement !== input) input.value = folder.name;
    folderDialog.querySelector('.folder-editor').hidden = !isEditing();
    folderDialog.querySelector('.folder-members').innerHTML = folder.siteIds.map(id => {
      const site = state.sites.find(item => item.id === id); if (!site) return '';
      return `<div class="folder-member" data-member="${escape(id)}" draggable="${isEditing()}">${siteCard(site)}${isEditing() ? `<div class="folder-member-actions"><button data-member-out="${escape(id)}">移出</button><button data-member-edit="${escape(id)}">编辑</button><button data-member-remove="${escape(id)}" aria-label="移除 ${escape(site.name)}">${UI_ICONS.close}</button></div>` : ''}</div>`;
    }).join('');
    folderDialog.querySelectorAll('[data-site]').forEach(card => renderIcon(card.querySelector('.site-icon'), state.sites.find(item => item.id === card.dataset.site)));
  }
  folderDialog.addEventListener('click', async event => {
    const out = event.target.closest('[data-member-out]'), edit = event.target.closest('[data-member-edit]'), remove = event.target.closest('[data-member-remove]'), site = event.target.closest('[data-site]');
    if (out) {
      const state = getState(), folder = state.folders.find(item => item.id === folderId); if (!folder) return;
      folder.siteIds = folder.siteIds.filter(id => id !== out.dataset.memberOut);
      state.desktopOrder.splice(state.desktopOrder.findIndex(item => item.id === `folder:${folderId}`) + 1, 0, { id: `site:${out.dataset.memberOut}` });
      render(); renderFolder(); await save();
    } else if (edit) { folderDialog.close(); editSite(edit.dataset.memberEdit); }
    else if (remove) await removeSite(remove.dataset.memberRemove);
    else if (site) { if (isEditing()) { folderDialog.close(); editSite(site.dataset.site); } else openSite(site.dataset.site); }
  });
  let memberDrag;
  folderDialog.addEventListener('dragstart', event => { const member = event.target.closest('[data-member]'); if (!member || !isEditing()) { event.preventDefault(); return; } memberDrag = member.dataset.member; event.dataTransfer.setData('text/plain', memberDrag); });
  folderDialog.addEventListener('dragover', event => { if (memberDrag && event.target.closest('[data-member]')) event.preventDefault(); });
  folderDialog.addEventListener('dragend', () => { memberDrag = null; });
  folderDialog.addEventListener('drop', async event => {
    event.preventDefault(); const target = event.target.closest('[data-member]')?.dataset.member;
    const folder = getState().folders.find(item => item.id === folderId); if (!folder || !memberDrag || !target || target === memberDrag) return;
    const from = folder.siteIds.indexOf(memberDrag), to = folder.siteIds.indexOf(target); if (from < 0 || to < 0) return;
    folder.siteIds.splice(to, 0, ...folder.siteIds.splice(from, 1)); memberDrag = null; render(); await save();
  });
  function renderGrid(columns, preferredRows) {
    gridColumns = columns;
    const state = getState(); normalizeDesktop(state, normalizeUrl);
    const items = desktopItems(state);
    layout = packDesktop(items, columns, preferredRows);
    if (isEditing()) {
      // Keep the grid add button only when it fits; the toolbar always offers it.
      // An extra row or pagination strip would shrink the existing desktop.
      const visibleRows = Math.max(1, ...layout.pages.flatMap(page => page.map(item => item.y + item.height)));
      const withAdd = packDesktop([...items, { kind: 'add', key: 'add', width: 1, height: 1 }], columns, preferredRows);
      if (withAdd.pages.length === layout.pages.length && withAdd.pages.every(page => page.every(item => item.y + item.height <= visibleRows))) layout = withAdd;
    }
    const key = JSON.stringify([columns, layout.rows, isEditing(), state.desktopOrder, state.folders, state.widgets.map(({ text, items, timer, ...widget }) => widget), state.sites.map(site => [siteCard(site), site.url, site.icon, site.favicon, site.iconCandidates, site.logoCandidates])]);
    if (key !== renderKey) {
      if (drag) finish();
      renderKey = key;
      const previous = settlingPositions || tilePositions(container); settlingPositions = null;
      container.innerHTML = layout.pages.map(page => `<div class="sites-page">${page.map(item => {
        let content;
        if (item.kind === 'site') content = `${siteCard(item)}${isEditing() ? `<button class="tile-remove" data-desktop-remove="${escape(item.id)}" aria-label="移除 ${escape(item.name)}">${UI_ICONS.close}</button>` : ''}`;
        else if (item.kind === 'folder') content = `<button class="site-card folder-card" data-folder="${escape(item.id)}" aria-label="打开文件夹 ${escape(item.name)}"><span class="site-icon folder-icon">${item.siteIds.slice(0, 4).map(id => `<span class="folder-mini" data-mini-site="${escape(id)}"></span>`).join('')}</span><span class="site-name">${escape(item.name)}</span><span class="folder-count">${item.siteIds.length}</span></button>`;
        else if (item.kind === 'widget') content = `${widgets.card(item, isEditing())}<span class="site-name widget-name" title="${escape(item.name)}">${escape(item.name)}</span>${isEditing() ? `<button class="tile-remove widget-remove" data-widget-remove="${escape(item.id)}" aria-label="移除 ${escape(item.name)}" title="移除小组件">${UI_ICONS.close}</button><button class="tile-remove widget-settings" data-widget-edit="${escape(item.id)}" aria-label="编辑 ${escape(item.name)}" title="设置小组件">${UI_ICONS.settings}</button>` : ''}`;
        else content = `<button class="site-card site-add" data-add-site aria-label="添加网站"><span class="site-icon">＋</span><span class="site-name">添加网站</span></button>`;
        return `<div class="desktop-tile ${item.kind === 'widget' ? 'desktop-widget' : ''}" data-desktop-key="${escape(item.key)}" style="grid-column:${item.x + 1} / span ${item.width};grid-row:${item.y + 1} / span ${item.height}" draggable="${isEditing() && item.kind !== 'add'}" ${isEditing() && item.kind !== 'add' ? `tabindex="0" aria-label="移动 ${escape(item.name)}，按住 Alt 使用方向键排序"` : ''}>${isEditing() && item.kind !== 'add' ? '<span class="tile-edit-frame" aria-hidden="true"></span>' : ''}${content}</div>`;
      }).join('')}</div>`).join('');
      container.querySelectorAll('[data-site], [data-mini-site]').forEach(card => {
        const site = state.sites.find(item => item.id === (card.dataset.site || card.dataset.miniSite));
        if (site) renderIcon(card.matches('[data-site]') ? card.querySelector('.site-icon') : card, site);
      });
      animateTiles(container, previous);
      document.querySelector('#pagination').innerHTML = layout.pages.length > 1 ? layout.pages.map((_, i) => `<button class="page-dot" data-page="${i}" aria-label="第 ${i + 1} 页"></button>`).join('') : '';
    }
    widgets.hydrate(); renderFolder(); return layout;
  }
  container.addEventListener('click', event => {
    if (drag) return;
    const folder = event.target.closest('[data-folder]'), remove = event.target.closest('[data-desktop-remove]');
    if (folder) { folderId = folder.dataset.folder; folderDialog.showModal(); renderFolder(); }
    if (remove) void removeSite(remove.dataset.desktopRemove);
  });
  const clearDrop = () => container.querySelectorAll('.drop-before,.drop-after,.drop-merge').forEach(node => { node.classList.remove('drop-before', 'drop-after', 'drop-merge'); node.removeAttribute('data-drop-hint'); });
  function dropIntent(event) {
    if (reorderPreview) {
      const hit = reorderPreview.hitTest(event, getPage()); if (!hit) return null;
      const { tile, target, fraction, inside } = hit;
      if (inside && target !== drag && drag.startsWith('site:') && /^(site|folder):/.test(target) && fraction > .28 && fraction < .72) return { tile, target, merge: true };
      const placement = reorderPreview.place(event, getPage()); if (!placement) return null;
      return { tile: container.querySelector(`[data-desktop-key="${CSS.escape(placement.target)}"]`) || tile, ...placement, merge: false };
    }
    const tile = event.target.closest('[data-desktop-key]'); if (!tile || tile.dataset.desktopKey === drag) return null;
    const target = tile.dataset.desktopKey, rect = tile.getBoundingClientRect(), fraction = (event.clientX - rect.left) / rect.width;
    const merge = !candidate && drag?.startsWith('site:') && /^(site|folder):/.test(target) && fraction > .28 && fraction < .72;
    return { tile, target, merge, after: fraction >= .5 };
  }
  // Hovering just inside or beyond a grid edge turns the page while dragging;
  // the arrows alone are too small a target to find mid-drag.
  const viewport = document.querySelector('#sitesViewport');
  const arrows = { [-1]: document.getElementById('previousPage'), 1: document.getElementById('nextPage') };
  let edgeDirection = 0;
  function armEdge(direction) {
    if (direction === edgeDirection) return;
    clearTimeout(pageTimer); pageTimer = null; edgeDirection = direction;
    for (const [key, arrow] of Object.entries(arrows)) arrow.classList.toggle('drag-over', Number(key) === direction);
    if (direction) pageTimer = setTimeout(() => {
      pageTimer = null;
      if (drag || candidate) { goToPage(getPage() + direction); reorderPreview?.reset(); clearDrop(); }
      armEdge(0);
    }, 550);
  }
  document.addEventListener('dragover', event => {
    if (!drag && !candidate) return;
    const rect = viewport.getBoundingClientRect(), inside = 24, outside = 120;
    const band = event.clientY >= rect.top && event.clientY <= rect.bottom;
    const direction = !band ? 0 : event.clientX < rect.left + inside && event.clientX > rect.left - outside ? -1 : event.clientX > rect.right - inside && event.clientX < rect.right + outside ? 1 : 0;
    const page = getPage() + direction;
    armEdge(direction && page >= 0 && page < layout.pages.length ? direction : 0);
    if (direction && event.target.closest?.('.page-arrow')) event.preventDefault();
  });
  function finish() { reorderPreview?.stop(); reorderPreview = null; feedback.stop(); drag = null; candidate = null; container.classList.remove('candidate-drop'); armEdge(0); clearDrop(); container.querySelectorAll('.dragging').forEach(node => node.classList.remove('dragging')); goToPage(getPage()); suppress(); }
  container.addEventListener('dragstart', event => {
    const tile = event.target.closest('[data-desktop-key]');
    if (!isEditing() || !tile || tile.dataset.desktopKey === 'add' || event.target.closest('input,textarea,iframe,a,[data-widget-edit],[data-widget-remove],[data-weather-refresh],[data-desktop-remove]')) { event.preventDefault(); return; }
    drag = tile.dataset.desktopKey;
    reorderPreview = createReorderPreview(container, layout, gridColumns, drag);
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', drag); feedback.start(event, tile);
  });
  container.addEventListener('dragenter', event => { if (drag || candidate) event.preventDefault(); });
  container.addEventListener('dragover', event => {
    if (!drag && !candidate) return; event.preventDefault(); event.dataTransfer.dropEffect = candidate ? 'copy' : 'move'; clearDrop();
    container.classList.toggle('candidate-drop', Boolean(candidate));
    const intent = dropIntent(event); if (!intent || intent.target === drag) { reorderPreview?.reset(); return; }
    if (intent.merge) reorderPreview?.reset();
    else reorderPreview?.show(intent.target, intent.after);
    intent.tile.classList.add(intent.merge ? 'drop-merge' : intent.after ? 'drop-after' : 'drop-before');
    intent.tile.dataset.dropHint = intent.merge ? (intent.target.startsWith('folder:') ? '移入文件夹' : '合并为文件夹') : candidate ? '添加到这里' : '移动到这里';
  });
  container.addEventListener('dragleave', event => { if (!container.contains(event.relatedTarget)) { reorderPreview?.reset(); clearDrop(); container.classList.remove('candidate-drop'); } });
  container.addEventListener('dragend', finish);
  window.addEventListener('blur', () => { if (drag || candidate) finish(); });
  container.addEventListener('drop', async event => {
    if (!drag && !candidate) return; event.preventDefault();
    const state = getState(), intent = dropIntent(event);
    if (candidate) {
      const item = candidate;
      const last = layout.pages[getPage()]?.filter(item => item.key !== 'add').at(-1);
      const placement = intent && intent.target !== 'add' ? { target: intent.target, after: intent.after } : { target: last?.key, after: true };
      finish(); await addCandidate(item, placement); return;
    }
    if (intent?.merge) mergeDesktopSites(state, drag, intent.target, crypto.randomUUID());
    else if (intent) moveDesktopItem(state, drag, intent.target, intent.after);
    else { const last = layout.pages[getPage()]?.filter(item => item.key !== 'add').at(-1); if (last) moveDesktopItem(state, drag, last.key, true); }
    if (container.classList.contains('reorder-preview')) settlingPositions = tilePositions(container);
    finish(); render(); settlingPositions = null; await save();
  });
  container.addEventListener('keydown', async event => {
    if (!isEditing() || !event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const tile = event.target.closest('[data-desktop-key]'); if (!tile || tile.dataset.desktopKey === 'add') return;
    event.preventDefault(); event.stopPropagation(); const state = getState(), key = tile.dataset.desktopKey, index = state.desktopOrder.findIndex(item => item.id === key);
    const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1; const target = state.desktopOrder[index + direction]; if (!target) return;
    moveDesktopItem(state, key, target.id, direction > 0); render(); goToPage(layout.pages.findIndex(page => page.some(item => item.key === key))); await save();
    [...container.querySelectorAll('[data-desktop-key]')].find(node => node.dataset.desktopKey === key)?.focus();
  });
  for (const button of Object.values(arrows)) button.addEventListener('drop', event => { event.preventDefault(); finish(); });
  return { render: renderGrid, pageCount: () => layout.pages.length, activateFrames: widgets.activateFrames, widgets,
    startCandidate: (item, event) => { candidate = item; feedback.start(event, event.target.closest('[draggable="true"]')); }, endCandidate: finish,
    async place(key, placement) {
      if (placement) { moveDesktopItem(getState(), key, placement.target, placement.after); render(); }
      goToPage(layout.pages.findIndex(page => page.some(item => item.key === key)));
      if (placement && !await save()) throw new Error('未能保存位置，请重试');
    },
  };
}
