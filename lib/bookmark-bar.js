import { browser } from 'wxt/browser';
import { UI_ICONS } from './icons.js';

// Modern Chrome can expose both local and account bookmark bars.
export function bookmarkBarRoots(tree) {
  const roots = tree.flatMap(root => root.children || []);
  const bars = roots.filter(node => node.folderType === 'bookmarks-bar');
  return bars.length ? bars : roots.filter(node => node.id === '1' || node.id === 'toolbar_____');
}

export function bookmarkUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'chrome:', 'edge:', 'about:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function createBookmarkBar({ bar, items, menu, getState, report, initialTree }) {
  let enabled = false, revision = 0, nodes = new Map(), path = [], anchor;
  let timer, anchorLeft, viewportWidth, viewportHeight;
  const scrollPositions = new Map();
  const compact = () => innerWidth < 560;
  const events = ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded'];

  function close(restoreFocus = false) {
    menu.hidden = true; path = []; menu.replaceChildren(); scrollPositions.clear();
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus();
    anchor = null;
  }

  function entry(node, inMenu = false) {
    const folder = !node.url;
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'bookmark-entry'; button.dataset.bookmarkId = node.id;
    button.title = node.title || node.url || '未命名文件夹';
    if (inMenu) button.setAttribute('role', 'menuitem');
    const icon = document.createElement('span'); icon.className = 'bookmark-icon';
    icon.innerHTML = folder ? UI_ICONS.folder : UI_ICONS.bookmark;
    if (!folder && /^https?:/.test(node.url)) {
      icon.classList.add('icon-loading');
      const image = new Image(); image.alt = ''; image.referrerPolicy = 'no-referrer';
      const favicon = new URL(browser.runtime.getURL('/_favicon/'));
      favicon.searchParams.set('pageUrl', node.url); favicon.searchParams.set('size', '32');
      image.onload = async () => {
        try { await image.decode(); icon.replaceChildren(image); } catch {}
        icon.classList.remove('icon-loading');
      };
      image.onerror = () => icon.classList.remove('icon-loading');
      image.src = favicon.href;
    }
    const name = document.createElement('span'); name.className = 'bookmark-label'; name.textContent = node.title || node.url || '未命名文件夹';
    button.append(icon, name);
    if (folder) {
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      const arrow = document.createElement('span'); arrow.className = 'bookmark-arrow'; arrow.innerHTML = inMenu ? UI_ICONS.arrow : UI_ICONS.chevronDown;
      button.append(arrow);
    } else if (!bookmarkUrl(node.url)) {
      button.disabled = true; button.title += '（不支持此书签地址）';
    }
    return button;
  }

  function rememberScroll() {
    for (const list of menu.querySelectorAll('.bookmark-folder-list')) scrollPositions.set(list.dataset.folderId, list.scrollTop);
  }

  function focusEntry(id) {
    const panel = menu.lastElementChild;
    const button = [...(panel?.querySelectorAll('.bookmark-entry') || [])].find(button => button.dataset.bookmarkId === id);
    (button || panel?.querySelector('.bookmark-entry:not(:disabled)') || panel?.querySelector('.bookmark-back:not(:disabled)') || panel)?.focus({ preventScroll: true });
  }

  function goBack(depth = path.length - 1) {
    if (depth < 1) { close(true); return; }
    const previous = path[depth];
    rememberScroll(); path = path.slice(0, depth); renderFolder(); focusEntry(previous);
  }

  function renderFolder() {
    if (!nodes.has(path.at(-1)) || !anchor?.isConnected) { close(); return; }
    rememberScroll(); menu.replaceChildren(); menu.hidden = false;
    const start = compact() ? path.length - 1 : 0;
    for (let depth = start; depth < path.length; depth++) {
      const folder = nodes.get(path[depth]);
      const panel = document.createElement('div'); panel.className = 'bookmark-menu-panel'; panel.dataset.depth = depth;
      panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', folder.title || '文件夹'); panel.tabIndex = -1;
      const back = document.createElement('button'); back.type = 'button'; back.className = 'bookmark-back';
      back.textContent = `${depth > 0 ? '‹ 返回 · ' : ''}${folder.title || '文件夹'}`;
      back.title = path.slice(0, depth + 1).map(id => nodes.get(id)?.title || '文件夹').join(' / ');
      back.disabled = depth === 0;
      back.addEventListener('click', () => goBack(depth));
      panel.append(back);
      const list = document.createElement('div'); list.className = 'bookmark-folder-list'; list.dataset.folderId = folder.id;
      for (const child of folder.children || []) {
        const button = entry(child, true);
        if (child.id === path[depth + 1]) button.setAttribute('aria-expanded', 'true');
        list.append(button);
      }
      if (!folder.children?.length) {
        const empty = document.createElement('p'); empty.className = 'bookmark-empty'; empty.textContent = '此文件夹为空'; list.append(empty);
      }
      panel.append(list); menu.append(panel);
      const rootBounds = anchor.getBoundingClientRect();
      let left = rootBounds.left, top = rootBounds.bottom + 7;
      if (depth > start) {
        const parent = panel.previousElementSibling;
        const row = [...parent.querySelectorAll('.bookmark-entry')].find(button => button.dataset.bookmarkId === folder.id);
        const bounds = parent.getBoundingClientRect();
        const right = bounds.right + 4, leftward = bounds.left - panel.offsetWidth - 4;
        const openLeft = parent.dataset.direction === 'left' ? leftward >= 8 : right + panel.offsetWidth > innerWidth - 8;
        left = openLeft ? leftward : right;
        panel.dataset.direction = openLeft ? 'left' : 'right';
        top = row.getBoundingClientRect().top - 6;
      }
      panel.style.left = `${Math.max(8, Math.min(left, innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.max(rootBounds.bottom + 7, Math.min(top, innerHeight - panel.offsetHeight - 8))}px`;
      list.scrollTop = scrollPositions.get(folder.id) || 0;
      list.addEventListener('scroll', () => {
        if (!list.isConnected || scrollPositions.get(folder.id) === list.scrollTop) return;
        scrollPositions.set(folder.id, list.scrollTop);
        // A submenu must not remain detached from a row that has scrolled away.
        if (path.length > depth + 1) { path = path.slice(0, depth + 1); renderFolder(); }
      });
    }
  }

  async function activate(event) {
    const button = event.target.closest('[data-bookmark-id]'); if (!button || button.disabled) return;
    const node = nodes.get(button.dataset.bookmarkId); if (!node) return;
    if (!node.url) {
      if (event.type === 'auxclick') return;
      if (menu.contains(button)) {
        rememberScroll();
        const depth = Number(button.closest('.bookmark-menu-panel').dataset.depth);
        path = [...path.slice(0, depth + 1), node.id];
      }
      else {
        if (anchor === button && !menu.hidden) { close(); return; }
        close(); anchor = button; path = [node.id]; anchor.setAttribute('aria-expanded', 'true');
        anchorLeft = anchor.getBoundingClientRect().left; viewportWidth = innerWidth; viewportHeight = innerHeight;
      }
      renderFolder(); focusEntry(); return;
    }
    const url = bookmarkUrl(node.url); if (!url) return;
    close();
    try {
      const newTab = event.button === 1 || event.ctrlKey || event.metaKey || getState().openInNewTab;
      if (newTab) await browser.tabs.create({ url, active: !(event.button === 1 || event.ctrlKey || event.metaKey) });
      else await browser.tabs.update({ url });
    } catch (error) { report(`无法打开书签：${error.message}`, true); }
  }

  async function refresh() {
    if (!enabled) return;
    const request = ++revision;
    try {
      const tree = initialTree || await browser.bookmarks.getTree();
      initialTree = null;
      if (!enabled || request !== revision) return;
      nodes = new Map();
      const visit = node => { nodes.set(node.id, node); for (const child of node.children || []) visit(child); };
      for (const root of tree) visit(root);
      const entries = bookmarkBarRoots(tree).flatMap(root => root.children || []);
      close(); items.replaceChildren(...entries.map(node => entry(node)));
      if (!entries.length) items.textContent = '书签栏还没有内容，可在 Chrome 中添加书签。';
    } catch {
      if (enabled && request === revision) items.textContent = '无法读取 Chrome 书签，请重新加载扩展并允许书签权限。';
    }
  }

  const changed = () => { clearTimeout(timer); timer = setTimeout(refresh, 80); };
  for (const surface of [items, menu]) {
    surface.addEventListener('click', activate);
    surface.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); void activate(event); } });
    surface.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      const panel = event.target.closest('.bookmark-menu-panel');
      if (surface === menu && event.key === 'ArrowLeft') {
        event.preventDefault(); event.stopPropagation(); goBack(Number(panel?.dataset.depth || 0)); return;
      }
      if ((event.key === 'ArrowRight' && surface === menu) || (event.key === 'ArrowDown' && surface === items)) {
        const button = event.target.closest('[aria-haspopup="menu"]');
        if (button) { event.preventDefault(); event.stopPropagation(); void activate({ target: button, type: 'click' }); }
        return;
      }
      const arrows = surface === menu ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
      if (![...arrows, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...(panel || surface).querySelectorAll('.bookmark-entry:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === arrows[0] ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
  }
  document.addEventListener('click', event => { if (!event.composedPath().includes(menu) && !event.composedPath().includes(items)) close(); });
  document.addEventListener('focusin', event => { if (!menu.contains(event.target) && !bar.contains(event.target)) close(); });
  window.addEventListener('resize', () => { if (innerWidth !== viewportWidth || innerHeight !== viewportHeight) close(); });
  items.addEventListener('scroll', () => {
    // Scroll-into-view can queue its event before a folder is opened.
    if (anchor && Math.abs(anchor.getBoundingClientRect().left - anchorLeft) > 1) close();
  });

  return {
    close,
    setVisible(value) {
      if (!value) initialTree = null;
      bar.hidden = !value;
      document.documentElement.classList.toggle('has-bookmarks-bar', value);
      if (enabled === value) return;
      enabled = value; revision++;
      for (const name of events) browser.bookmarks?.[name]?.[value ? 'addListener' : 'removeListener'](changed);
      if (value) { items.textContent = '正在读取书签…'; void refresh(); }
      else { clearTimeout(timer); close(); items.replaceChildren(); nodes.clear(); }
    },
  };
}
