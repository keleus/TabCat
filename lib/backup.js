import { BUILTIN_SITES } from './defaults.js';
import { normalizeState, normalizeUrl, normalizeFavicon } from './state.js';

// Backups are user supplied files. Keep the limit high enough for a local
// wallpaper while still bounding JSON parsing and traversal work.
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

const TABCAT_VERSION = 1;
const BUILTIN_SITE_TYPES = new Set(BUILTIN_SITES.map(site => site.builtin));
const KNOWN_INFINITY_COMPONENTS = new Set(['site', 'setting', 'searcher', 'wallpaper', 'weather', 'todo', 'note']);
const KNOWN_ITAB_COMPONENTS = new Set(['baseConfig', 'navConfig', 'notes', 'todo', 'todoFolder', 'stocks', 'exchangerate']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function byteLength(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
  // TextEncoder is available in supported browsers and Node versions. The
  // fallback is deliberately conservative for older extension runtimes.
  return text.length * 2;
}

function assertText(text) {
  if (typeof text !== 'string') throw new Error('备份内容必须是文本');
  if (byteLength(text) > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 20 MB');
}

function parseJson(text) {
  assertText(text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('无法读取 JSON 文件');
  }
}

function unsupportedFormat() {
  throw new Error('请选择 TabCat、Infinity v2 或 iTab 导出的 JSON 备份文件');
}

function isInternalUrl(value) {
  return typeof value === 'string' && /^(?:infinity|itab):/i.test(value.trim());
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function finiteNumber(value) {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function validHex(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function addWarning(stats, warning) {
  if (warning && !stats.warnings.includes(warning)) stats.warnings.push(warning);
}

function addSkippedComponent(stats, name) {
  const component = stringValue(name);
  if (!component || stats.skippedComponents.includes(component)) return;
  stats.skippedComponents.push(component);
}

function makeStats(format, options = {}) {
  return {
    format,
    keepInfinityIcons: Boolean(options.keepInfinityIcons),
    sitesImported: 0,
    sitesSkipped: 0,
    enginesImported: 0,
    enginesSkipped: 0,
    settingsImported: 0,
    settingsSkipped: 0,
    foldersExpanded: 0,
    // Site URL -> icon address that Infinity hosts on its own CDN.
    infinityIcons: new Map(),
    infinityIconSites: 0,
    skippedComponents: [],
    warnings: [],
    siteUrls: new Set(),
    engineUrls: new Set(),
    usedIds: new Set(),
  };
}

function stableId(prefix, value, usedIds) {
  // A deterministic ID makes an import preview and a confirmed import agree,
  // while avoiding any dependency on crypto in older extension contexts.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let id = `${prefix}-${(hash >>> 0).toString(36)}`;
  let suffix = 2;
  while (usedIds.has(id)) id = `${prefix}-${(hash >>> 0).toString(36)}-${suffix++}`;
  usedIds.add(id);
  return id;
}

function siteUrl(value) {
  return normalizeUrl(value);
}

function engineUrl(value) {
  const raw = stringValue(value);
  if (!raw) return '';
  const candidate = raw.includes('%s') ? raw : `${raw}%s`;
  return normalizeUrl(candidate);
}

function imageValue(value) {
  return normalizeFavicon(value);
}

// Infinity serves both its icon library and uploaded custom icons from its own
// CDN. Keeping those links would make every migrated shortcut request images
// from a third-party host, so the new tab discovers each icon from the site.
function isInfinityIcon(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'infinitynewtab.com' || host.endsWith('.infinitynewtab.com');
  } catch { return false; }
}

function addSite(stats, sites, item, format) {
  const rawTarget = item.target ?? item.url ?? item.href ?? item.link;
  if (isInternalUrl(rawTarget)) {
    stats.sitesSkipped += 1;
    addSkippedComponent(stats, `${format} 内部入口`);
    return;
  }
  const url = siteUrl(rawTarget);
  const name = stringValue(item.name ?? item.title ?? item.label);
  if (!url || !name) {
    stats.sitesSkipped += 1;
    return;
  }
  if (stats.siteUrls.has(url)) {
    stats.sitesSkipped += 1;
    return;
  }
  stats.siteUrls.add(url);
  const mapped = {
    id: stableId(`${format}-site`, url, stats.usedIds),
    name: name.slice(0, 80),
    url,
  };
  let infinityIcon = '';
  const siteImage = value => {
    const image = imageValue(value);
    if (image && isInfinityIcon(image)) { infinityIcon ||= image; return ''; }
    return image;
  };
  const manualIcon = imageValue(item.icon);
  if (manualIcon && /^data:image\//i.test(manualIcon)) mapped.icon = manualIcon;
  const favicon = siteImage(item.favicon ?? item.faviconUrl ?? item.favIcon);
  if (favicon) mapped.favicon = favicon;
  const candidateValues = [
    ...(Array.isArray(item.iconCandidates) ? item.iconCandidates : []),
    item.iconUrl,
    item.bgImage,
    item.src,
  ];
  const iconCandidates = [...new Set(candidateValues.map(siteImage).filter(Boolean))];
  if (iconCandidates.length) mapped.iconCandidates = iconCandidates;
  if (infinityIcon) {
    stats.infinityIcons.set(url, infinityIcon);
    // Opting in keeps the address as the shortcut's own icon. The new tab then
    // downloads it once and serves it from this device.
    if (stats.keepInfinityIcons && !mapped.icon) mapped.icon = infinityIcon;
  }
  sites.push(mapped);
  stats.sitesImported += 1;
}

function collectSites(value, sites, stats, format, seen = new Set()) {
  if (Array.isArray(value)) {
    value.forEach(item => collectSites(item, sites, stats, format, seen));
    return;
  }
  if (!isRecord(value)) return;
  if (seen.has(value)) return;
  seen.add(value);

  const children = Array.isArray(value.children) ? value.children : null;
  const type = stringValue(value.type).toLowerCase();
  if (children || type === 'folder' || type === 'group') {
    stats.foldersExpanded += 1;
    if (children) children.forEach(item => collectSites(item, sites, stats, format, seen));
    return;
  }

  const target = value.target ?? value.url ?? value.href ?? value.link;
  if (isInternalUrl(target) || value.component || ['app', 'component', 'widget', 'text'].includes(type)) {
    stats.sitesSkipped += 1;
    addSkippedComponent(stats, value.component ? `${format} 组件` : `${format} 内部入口`);
    return;
  }
  addSite(stats, sites, value, format);
}

function mapSettings(source, stats, format) {
  if (!isRecord(source)) return {};
  const patch = {};
  const set = (key, value) => {
    if (value === undefined || value === null) return;
    patch[key] = value;
    stats.settingsImported += 1;
  };
  const setNumber = (key, value) => {
    const number = finiteNumber(value);
    if (number !== null) set(key, number);
  };
  const setBoolean = (key, value) => {
    if (typeof value === 'boolean') set(key, value);
    else if (value === 0 || value === 1) set(key, Boolean(value));
  };

  if (format === 'itab') {
    const theme = isRecord(source.theme) ? source.theme : {};
    if (theme.system === true) set('theme', 'system');
    else if (['light', 'dark', 'system'].includes(theme.mode)) set('theme', theme.mode);
    const accent = validHex(theme.color);
    if (accent) set('accentColor', accent);

    const wallpaper = isRecord(source.wallpaper) ? source.wallpaper : {};
    const wallpaperUrl = siteUrl(wallpaper.src);
    if (wallpaperUrl) {
      set('background', 'custom');
      set('backgroundUrl', wallpaperUrl);
    } else if (typeof wallpaper.src === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(wallpaper.src)) {
      set('background', 'local');
      set('backgroundLocal', wallpaper.src);
      if (wallpaper.name) set('backgroundLocalName', stringValue(wallpaper.name).slice(0, 200));
    }
    const mask = finiteNumber(wallpaper.mask);
    if (mask !== null) setNumber('backgroundDim', mask <= 1 ? mask * 100 : mask);
    setNumber('backgroundBlur', wallpaper.blur);

    const search = isRecord(source.search) ? source.search : {};
    setBoolean('showSearch', search.show);
    setNumber('searchHeight', search.height);
    setNumber('searchRadius', search.radius);
    const searchOpacity = finiteNumber(search.bgColor);
    if (searchOpacity !== null) setNumber('searchOpacity', searchOpacity <= 1 ? searchOpacity * 100 : searchOpacity);

    const time = isRecord(source.time) ? source.time : {};
    setBoolean('showClock', time.show);
    setNumber('clockSize', time.size);
    setNumber('clockWeight', time.fontWeight);
    setBoolean('hour24', time.hour24);
    if (typeof time.lunar === 'boolean') set('showLunar', time.lunar);
    else if (typeof time.lunar === 'string') set('showLunar', !['none', 'hidden', ''].includes(time.lunar));

    const icon = isRecord(source.icon) ? source.icon : {};
    setNumber('iconSize', icon.iconSize);
    setNumber('iconRadius', icon.iconRadius);
    setNumber('columnGap', icon.iconX);
    setNumber('rowGap', icon.iconY);
    setBoolean('showSiteNames', icon.name);
    setBoolean('shortcutOpenInNewTab', source.open && source.open.iconBlank);
  } else {
    // Infinity stores a nested `setting` object under the `setting` component.
    // Only its `icon` group is imported, matching TabCat's "图标外观" page.
    // Grid layout, search box, link behaviour and wallpaper describe a desktop
    // the user has already arranged in TabCat, so they are left untouched.
    const setting = isRecord(source.setting) ? source.setting : source;
    const icon = isRecord(setting.icon) ? setting.icon : {};

    // Infinity stores the icon size as a scale and the radius and opacity as
    // fractions; TabCat uses pixel and percent ranges.
    setNumber('iconSize', icon.scale === undefined ? undefined : Number(icon.scale) * 144);
    setNumber('iconRadius', icon.radius === undefined ? undefined : Number(icon.radius) * 48);
    setNumber('iconOpacity', icon.opacity === undefined ? undefined : Number(icon.opacity) * 100);
    setBoolean('showSiteNames', icon.isHideIconName === undefined ? undefined : !icon.isHideIconName);
  }
  return patch;
}

function mapEngines(source, stats, format) {
  if (!isRecord(source)) return { engines: [], currentUrl: '' };
  const engines = [];
  const add = item => {
    if (!isRecord(item)) return;
    const name = stringValue(item.name ?? item.title);
    // Infinity v2 emits `target` for custom/add-on engines and
    // `types[0].url` for built-ins. iTab uses `href`.
    const rawUrl = item.url ?? item.href ?? item.target ?? item.types?.[0]?.url;
    if (isInternalUrl(rawUrl)) {
      stats.enginesSkipped += 1;
      addSkippedComponent(stats, `${format} 内部搜索引擎`);
      return;
    }
    const url = engineUrl(rawUrl);
    if (!name || !url || stats.engineUrls.has(url)) {
      stats.enginesSkipped += 1;
      return;
    }
    stats.engineUrls.add(url);
    engines.push({
      id: stableId(`${format}-engine`, url, stats.usedIds),
      name: name.slice(0, 80),
      url,
      ...(validHex(item.color) ? { color: item.color } : {}),
    });
    stats.enginesImported += 1;
  };
  if (format === 'itab') {
    if (Array.isArray(source)) source.forEach(add);
    else if (Array.isArray(source.searchEngine)) source.searchEngine.forEach(add);
    const current = source.useSearch;
    if (typeof current === 'string') {
      const selected = (source.searchEngine || []).find(item => item?.key === current);
      return { engines, currentUrl: selected?.href || '' };
    }
    return { engines, currentUrl: '' };
  }

  const searchEngine = isRecord(source.searchEngine) ? source.searchEngine : source;
  for (const key of ['custom', 'addList', 'all']) {
    if (Array.isArray(searchEngine[key])) searchEngine[key].forEach(add);
  }
  const current = searchEngine.current;
  const currentUrl = isRecord(current) ? (current.url ?? current.href ?? current.target ?? current.types?.[0]?.url ?? '') : stringValue(current);
  return { engines, currentUrl };
}

function mappedState(partial, currentState, stats) {
  const base = normalizeState(currentState === undefined ? {} : currentState);
  // External adapters yield pixel radii; convert only their imported setting.
  if (partial.settings.iconRadius != null) {
    const size = Math.max(44, Math.min(128, Number(partial.settings.iconSize) || base.iconSize));
    partial.settings.iconRadius = Math.round(Math.max(0, Math.min(50, Number(partial.settings.iconRadius) / size * 100)) * 100) / 100;
  }
  const existingIds = new Set(base.sites.map(site => site.id));
  const existingSiteUrls = new Set(base.sites.map(site => normalizeUrl(site.url)).filter(Boolean));
  const importedSites = [];
  for (const site of partial.sites || []) {
    const url = normalizeUrl(site.url);
    if (!url || existingSiteUrls.has(url)) {
      stats.sitesSkipped += 1;
      continue;
    }
    existingSiteUrls.add(url);
    let id = site.id;
    if (!id || existingIds.has(id)) id = stableId(stats.format, url, existingIds);
    existingIds.add(id);
    importedSites.push({ ...site, id, url });
  }

  const engines = [...base.engines];
  const existingEngineUrls = new Set(engines.map(engine => normalizeUrl(engine.url)).filter(Boolean));
  const importedEngines = [];
  for (const engine of partial.engines || []) {
    const url = normalizeUrl(engine.url);
    if (!url || existingEngineUrls.has(url)) {
      stats.enginesSkipped += 1;
      continue;
    }
    existingEngineUrls.add(url);
    let id = engine.id;
    const existingEngineIds = new Set(engines.map(item => item.id));
    if (!id || existingEngineIds.has(id)) id = stableId(stats.format, url, existingEngineIds);
    importedEngines.push({ ...engine, id, url });
  }
  engines.push(...importedEngines);

  const next = normalizeState({
    ...base,
    ...partial.settings,
    sites: [...base.sites, ...importedSites],
    engines,
  });
  const selectedUrl = engineUrl(partial.currentEngineUrl || '');
  if (selectedUrl) {
    const selected = next.engines.find(engine => normalizeUrl(engine.url) === selectedUrl);
    if (selected) next.currentEngine = selected.id;
  }
  stats.sitesImported = importedSites.length;
  stats.enginesImported = importedEngines.length;
  stats.infinityIconSites = importedSites.filter(site => stats.infinityIcons.has(site.url)).length;
  return next;
}

function finishExternal(stats, state) {
  if (stats.foldersExpanded) {
    addWarning(stats, `已展开 ${stats.foldersExpanded} 个文件夹，仅保留其中可映射的网站，文件夹层级不会保留。`);
  }
  if (stats.sitesSkipped) addWarning(stats, `已跳过 ${stats.sitesSkipped} 个无法导入的网站项目（仅接受 HTTP/HTTPS 网址且会去重）。`);
  if (stats.enginesSkipped) addWarning(stats, `已跳过 ${stats.enginesSkipped} 个无法导入的搜索引擎（仅接受 HTTP/HTTPS 搜索地址）。`);
  if (stats.skippedComponents.length) addWarning(stats, `已跳过组件或内部入口：${stats.skippedComponents.join('、')}。`);
  if (stats.settingsSkipped) addWarning(stats, `有 ${stats.settingsSkipped} 项设置未映射，未导入未知字段。`);
  const skippedComponents = [...stats.skippedComponents];
  const imported = stats.sitesImported + stats.enginesImported + stats.settingsImported;
  const skipped = stats.sitesSkipped + stats.enginesSkipped + stats.settingsSkipped;
  return {
    state,
    format: stats.format,
    summary: {
      format: stats.format,
      sites: { imported: stats.sitesImported, skipped: stats.sitesSkipped },
      engines: { imported: stats.enginesImported, skipped: stats.enginesSkipped },
      settings: { imported: stats.settingsImported, skipped: stats.settingsSkipped },
      foldersExpanded: stats.foldersExpanded,
      infinityIcons: { sites: stats.infinityIconSites, kept: stats.keepInfinityIcons },
      skippedComponents,
      imported,
      skipped,
      mode: 'merge',
    },
    warnings: [...stats.warnings],
  };
}

function detectItab(root) {
  if (!isRecord(root)) return null;
  if (typeof root.iTabConfig === 'string') {
    try {
      const nested = JSON.parse(root.iTabConfig);
      return isRecord(nested) ? nested : null;
    } catch {
      throw new Error('iTab 备份中的配置内容无法读取');
    }
  }
  if (hasOwn(root, 'baseConfig') || hasOwn(root, 'navConfig')) return root;
  return null;
}

function inspectTabcat(root) {
  const state = root?.state;
  if (root?.format !== 'tabcat' || root.version !== TABCAT_VERSION || !isRecord(state)) unsupportedFormat();
  if (!Array.isArray(state.sites) || !Array.isArray(state.engines) || !state.engines.length) throw new Error('备份缺少网站或搜索引擎数据');
  const ids = new Set();
  for (const site of state.sites) {
    if (!site || typeof site.id !== 'string' || ids.has(site.id) || typeof site.name !== 'string' || !site.name.trim() || (!BUILTIN_SITE_TYPES.has(site.builtin) && !normalizeUrl(site.url))) throw new Error('备份中的网站数据无效');
    ids.add(site.id);
  }
  ids.clear();
  for (const engine of state.engines) {
    if (!engine || typeof engine.id !== 'string' || ids.has(engine.id) || typeof engine.name !== 'string' || !engine.name.trim() || typeof engine.url !== 'string' || !engine.url.includes('%s') || !normalizeUrl(engine.url)) throw new Error('备份中的搜索引擎数据无效');
    ids.add(engine.id);
  }
  const normalized = normalizeState(state);
  const importedSettings = Object.keys(normalized).filter(key => !['sites', 'engines', 'designVersion', 'currentEngine'].includes(key)).length;
  return {
    state: normalized,
    format: 'tabcat',
    summary: {
      format: 'tabcat',
      sites: { imported: normalized.sites.length, skipped: 0 },
      engines: { imported: normalized.engines.length, skipped: 0 },
      settings: { imported: importedSettings, skipped: 0 },
      foldersExpanded: 0,
      skippedComponents: [],
      imported: normalized.sites.length + normalized.engines.length + importedSettings,
      skipped: 0,
      mode: 'replace',
    },
    warnings: [],
  };
}

function inspectInfinity(root, currentState, options) {
  if (root.version !== 'v2' || !isRecord(root.data)) unsupportedFormat();
  const data = root.data;
  const stats = makeStats('infinity', options);
  const sites = [];
  const siteComponent = isRecord(data.site) ? data.site : null;
  collectSites(siteComponent?.sites, sites, stats, 'Infinity');
  const settingComponent = isRecord(data.setting) ? data.setting : null;
  const searchComponent = isRecord(data.searcher) ? data.searcher : null;
  const settings = mapSettings(settingComponent, stats, 'infinity');
  const { engines, currentUrl } = mapEngines(searchComponent, stats, 'infinity');
  for (const key of Object.keys(data)) {
    if (!KNOWN_INFINITY_COMPONENTS.has(key)) addSkippedComponent(stats, `Infinity:${key}`);
    else if (!['site', 'setting', 'searcher'].includes(key)) addSkippedComponent(stats, `Infinity:${key}`);
  }
  if (siteComponent && !Array.isArray(siteComponent.sites)) addSkippedComponent(stats, 'Infinity:site（缺少 sites）');
  if (!settingComponent) stats.settingsSkipped += 1;
  else addWarning(stats, '仅导入 Infinity 的图标外观（大小、圆角、不透明度、名称显示）；桌面布局、搜索框、链接打开方式和壁纸等设置不会导入。');
  const state = mappedState({ sites, engines, settings, currentEngineUrl: currentUrl }, currentState, stats);
  if (stats.infinityIconSites) {
    addWarning(stats, stats.keepInfinityIcons
      ? 'Infinity 图标将按图标地址保留：首次显示时由扩展下载并缓存到本机，此后不再访问其服务器。'
      : 'Infinity 图标库和自定义图标托管在其服务器上，不会导入；导入后将从各网站自动获取图标。');
  }
  return finishExternal(stats, state);
}

function inspectItab(root, currentState) {
  const config = detectItab(root);
  if (!config) unsupportedFormat();
  const stats = makeStats('itab');
  const sites = [];
  if (Array.isArray(config.navConfig)) {
    // iTab's top-level navConfig entries are pages/groups used for paging;
    // only an item explicitly marked as a folder represents a user folder.
    config.navConfig.forEach(page => {
      if (isRecord(page) && Array.isArray(page.children) && !['folder', 'group'].includes(stringValue(page.type).toLowerCase())) {
        page.children.forEach(item => collectSites(item, sites, stats, 'iTab'));
      } else collectSites(page, sites, stats, 'iTab');
    });
  }
  const baseConfig = isRecord(config.baseConfig) ? config.baseConfig : {};
  const settings = mapSettings(baseConfig, stats, 'itab');
  const { engines, currentUrl } = mapEngines(baseConfig, stats, 'itab');
  for (const key of Object.keys(config)) {
    if (!KNOWN_ITAB_COMPONENTS.has(key) && key !== 'iTabConfig') addSkippedComponent(stats, `iTab:${key}`);
    else if (!['baseConfig', 'navConfig'].includes(key)) addSkippedComponent(stats, `iTab:${key}`);
  }
  if (!isRecord(config.baseConfig)) stats.settingsSkipped += 1;
  if (!Array.isArray(config.navConfig)) stats.sitesSkipped += 1;
  const state = mappedState({ sites, engines, settings, currentEngineUrl: currentUrl }, currentState, stats);
  return finishExternal(stats, state);
}

export function createBackup(state) {
  return JSON.stringify({ format: 'tabcat', version: TABCAT_VERSION, exportedAt: new Date().toISOString(), state }, null, 2);
}

// `options.keepInfinityIcons` keeps the icon addresses of an Infinity backup
// instead of rediscovering each icon from its website.
export function inspectBackup(text, currentState, options = {}) {
  const root = parseJson(text);
  if (!isRecord(root)) unsupportedFormat();
  if (root.encrypted === true || hasOwn(root, 'ciphertext') || hasOwn(root, 'iv')) throw new Error('不支持加密备份文件');
  if (root.format === 'tabcat') return inspectTabcat(root);
  if (root.version === 'v2' && isRecord(root.data)) return inspectInfinity(root, currentState, options);
  if (detectItab(root)) return inspectItab(root, currentState);
  unsupportedFormat();
}

export function parseBackup(text) {
  return inspectBackup(text).state;
}
