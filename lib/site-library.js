import { CATALOG_CATEGORIES, searchCatalog, catalogSiteAdded } from './site-catalog.js';
import { WIDGET_TYPES } from './widget-tools.js';
import { siteArtwork, UI_ICONS } from './appearance.js';

export function createSiteLibrary({ dialog, getState, add, custom, widgets, startDrag, endDrag, onToggle }) {
  const search = dialog.querySelector('#librarySearch');
  const categories = dialog.querySelector('#libraryCategories');
  const grid = dialog.querySelector('#libraryGrid');
  const status = dialog.querySelector('#libraryStatus');
  let category = 'all', kind = 'sites', returnFocus = null;
  // Icons and widgets keep their own search text so switching tabs never filters the other list.
  const queries = { sites: '', widgets: '' };
  const placeholders = { sites: '搜索图标或网址', widgets: '搜索小组件' };
  let dragging = false;
  const gallery = dialog.querySelector('.widget-gallery');
  const pending = new Set();

  for (const [id, label] of CATALOG_CATEGORIES) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.category = id;
    button.textContent = label; button.setAttribute('aria-pressed', String(id === category)); categories.append(button);
  }
  function refresh() {
    if (!dialog.open || dragging) return;
    const focusedId = grid.contains(document.activeElement) ? document.activeElement.dataset.catalogId : null;
    queries[kind] = search.value; search.placeholder = placeholders[kind];
    const results = kind === 'widgets' ? [] : searchCatalog(search.value, category);
    const query = search.value.trim().toLowerCase();
    const types = kind === 'sites' ? [] : Object.entries(WIDGET_TYPES).filter(([type, labels]) => [type, ...labels].join(' ').toLowerCase().includes(query));
    dialog.querySelector('#libraryCount').textContent = kind === 'widgets' ? `${types.length} 个小组件` : `${results.length} 个图标`;
    categories.hidden = kind === 'widgets';
    dialog.querySelector('#libraryWidgets').hidden = kind !== 'widgets' || !types.length;
    dialog.querySelector('#librarySites').hidden = kind !== 'sites' || !results.length;
    dialog.querySelectorAll('[data-library-kind]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.libraryKind === kind)));
    for (const button of categories.children) button.setAttribute('aria-pressed', String(button.dataset.category === category));
    const cards = results.map(site => {
      const added = catalogSiteAdded(getState().sites, site);
      const card = document.createElement('button'); card.type = 'button'; card.className = 'library-card'; card.dataset.catalogId = site.id;
      card.setAttribute('aria-label', `${added ? '已添加' : '添加'} ${site.name}`);
      card.setAttribute('aria-disabled', String(added || pending.has(site.id)));
      card.draggable = !added && !pending.has(site.id); card.classList.toggle('is-added', added); card.title = site.url;
      const icon = document.createElement('span'); icon.className = 'library-icon';
      const artwork = siteArtwork(site); icon.style.background = site.builtin ? artwork.color : site.iconBackground;
      if (artwork.markup) icon.innerHTML = artwork.markup;
      else if (site.iconPath) { const image = new Image(); image.alt = ''; image.src = site.iconPath; image.decoding = 'async'; image.draggable = false; image.style.width = image.style.height = `${site.defaultImageScale}%`; image.style.objectFit = 'contain'; icon.append(image); }
      else { icon.textContent = artwork.text; icon.style.background = artwork.color; }
      const info = document.createElement('span'); info.className = 'library-card-info';
      const name = document.createElement('strong'); name.textContent = site.name;
      const description = document.createElement('span'); description.textContent = site.description;
      const host = document.createElement('small'); host.textContent = site.builtin ? '浏览器内置' : new URL(site.url).hostname.replace(/^www\./, '');
      info.append(name, description, host);
      const action = document.createElement('span'); action.className = 'library-card-action';
      action.innerHTML = added ? UI_ICONS.check : pending.has(site.id) ? '…' : UI_ICONS.plus;
      const label = document.createElement('span'); label.textContent = added ? '已添加' : pending.has(site.id) ? '添加中' : '添加'; action.append(label);
      card.append(icon, info, action); return card;
    });
    grid.replaceChildren(...cards);
    // Keep widget buttons stable while an add is saved or another tab updates.
    const typeKey = types.map(([type]) => type).join(',');
    if (gallery.dataset.types !== typeKey) {
      gallery.dataset.types = typeKey;
      gallery.replaceChildren(...types.map(([type, [name, detail]]) => {
        const option = document.createElement('div'); option.className = 'widget-option';
        const preview = document.createElement('div'); preview.className = 'widget-option-preview'; preview.append(widgets().previewCard(type));
        const button = document.createElement('button'); button.type = 'button'; button.className = 'widget-option-button'; button.dataset.widgetType = type; button.draggable = true;
        button.setAttribute('aria-label', `添加 ${name}`);
        const title = document.createElement('strong'); title.textContent = name;
        const description = document.createElement('span'); description.textContent = type === 'web' ? '填写网页地址后添加' : detail;
        const plus = document.createElement('span'); plus.className = 'widget-option-add'; plus.textContent = '＋'; plus.setAttribute('aria-hidden', 'true');
        button.append(title, description, plus); option.append(preview, button); return option;
      }));
    }
    gallery.querySelectorAll('[data-widget-type]').forEach(button => { const busy = pending.has(`widget:${button.dataset.widgetType}`); button.setAttribute('aria-disabled', String(busy)); button.draggable = !busy; });
    const empty = dialog.querySelector('#libraryEmpty'); empty.hidden = results.length + types.length > 0;
    empty.querySelector('strong').textContent = kind === 'widgets' ? '没有找到匹配的小组件' : '没有找到匹配的图标';
    empty.querySelector('p').textContent = kind === 'widgets' ? '试试其他关键词。' : '试试其他关键词或分类，也可以手动添加网址。';
    if (focusedId) [...grid.children].find(card => card.dataset.catalogId === focusedId)?.focus({ preventScroll: true });
  }
  search.addEventListener('input', refresh);
  categories.addEventListener('click', event => { const button = event.target.closest('[data-category]'); if (button) { category = button.dataset.category; refresh(); } });
  dialog.querySelector('.library-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-library-kind]'); if (!button) return;
    if (button.dataset.libraryKind === kind) return;
    kind = button.dataset.libraryKind; search.value = queries[kind]; refresh(); dialog.querySelector('.library-results').scrollTop = 0; search.focus();
  });
  function candidateFor(target) {
    const button = target.closest('[data-catalog-id], [data-widget-type]');
    if (!button || button.getAttribute('aria-disabled') === 'true') return null;
    return button.dataset.widgetType ? { kind: 'widget', id: button.dataset.widgetType } : { kind: 'site', id: button.dataset.catalogId };
  }
  async function addCandidate(candidate, placement) {
    const isWidget = candidate.kind === 'widget';
    const entry = isWidget ? WIDGET_TYPES[candidate.id] : searchCatalog().find(site => site.id === candidate.id);
    if (!entry) return;
    const id = isWidget ? `widget:${candidate.id}` : candidate.id, name = isWidget ? entry[0] : entry.name;
    if (pending.has(id)) return;
    pending.add(id); refresh(); status.classList.remove('error'); status.textContent = `正在添加 ${name}…`;
    try {
      const result = isWidget ? await widgets().add(candidate.id, placement) : await add(candidate.id, placement);
      status.textContent = result?.configured ? '填写网页地址后即可添加。' : result?.duplicate ? `${name} 已在首页` : `已添加 ${name}，可以继续选择`;
    } catch (error) { status.textContent = `添加失败：${error.message}`; status.classList.add('error'); }
    finally { pending.delete(id); refresh(); }
  }
  dialog.querySelector('.library-results').addEventListener('click', event => {
    const candidate = candidateFor(event.target); if (candidate && !dragging) void addCandidate(candidate);
  });
  dialog.addEventListener('dragstart', event => {
    const candidate = candidateFor(event.target); if (!candidate) { event.preventDefault(); return; }
    dragging = true; event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('text/plain', `${candidate.kind}:${candidate.id}`);
    startDrag(candidate, event);
  });
  dialog.addEventListener('dragend', () => { dragging = false; endDrag(); refresh(); });
  function close() {
    if (!dialog.open) return;
    dialog.close(); gallery.replaceChildren(); delete gallery.dataset.types; onToggle(false);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  dialog.addEventListener('close', () => { if (!dialog.open) { dragging = false; gallery.replaceChildren(); delete gallery.dataset.types; endDrag(); onToggle(false); } });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dialog.open && !document.querySelector('dialog:modal')) { event.preventDefault(); close(); }
  });
  dialog.querySelector('#closeLibrary').addEventListener('click', close);
  dialog.querySelector('#libraryDone').addEventListener('click', close);
  dialog.querySelector('#libraryCustom').addEventListener('click', () => { close(); custom(); });
  return {
    refresh, close, addCandidate,
    open(initialKind = 'sites') {
      if (!dialog.open) returnFocus = document.activeElement;
      queries.sites = queries.widgets = ''; search.value = ''; category = 'all'; kind = initialKind; status.textContent = '点击添加，或拖到桌面指定位置。'; status.classList.remove('error');
      dialog.show(); onToggle(true); refresh(); dialog.querySelector('.library-results').scrollTop = 0; search.focus();
    },
  };
}
