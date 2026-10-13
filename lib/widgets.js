import { UI_ICONS } from './icons.js';
import { WIDGET_TYPES, normalizeTool, validDate, localDate, latestNote } from './widget-tools.js';
import { createWidgetTools } from './widget-tools-ui.js';
import { moveDesktopItem } from './desktop.js';
import { normalizeUrl } from './state.js';
import { WEATHER_CACHE_MS, cityLabel, rankCities, weatherAppearance } from './weather.js';
import { browser } from 'wxt/browser';
import { createWeatherCache, weatherCacheFresh, weatherDaylight, weatherMoon, weatherUpdatedTime } from './weather-cache.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const weatherScene = '<div class="weather-scene" aria-hidden="true"><i class="weather-sun"></i><i class="weather-moon"></i><i class="weather-cloud"></i><i class="weather-cloud weather-cloud-back"></i><div class="weather-particles">' + Array.from({ length: 8 }, (_, i) => `<i style="--particle:${i}"></i>`).join('') + '</div><i class="weather-mist"></i><i class="weather-bolt"></i></div>';
function setWeatherScene(node, current) {
  const appearance = weatherAppearance(current.weather_code, current.is_day);
  const card = node.closest('.widget-weather');
  card.className = `widget-card widget-weather compact-widget weather-${appearance.scene}${appearance.night ? ' weather-night' : ''}`;
  return appearance.label;
}
// A note's first non-empty line is its title; the rest previews below it.
const noteLines = text => text.trim().split('\n');
const noteTitle = text => noteLines(text)[0].trim().slice(0, 80) || '新备忘';
const noteBody = text => noteLines(text).slice(1).join('\n').trim();
function noteTime(time) {
  if (!time) return '';
  const date = new Date(time), now = new Date();
  if (localDate(date) === localDate(now)) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日` : localDate(date);
}
function notePreview(widget) {
  const written = widget.notes.filter(note => note.text.trim()), latest = latestNote(written);
  if (!latest) return '<span class="note-preview-body note-preview-empty">点击记下第一条备忘</span><small class="note-status"><span>还没有备忘</span></small>';
  return `<strong class="note-preview-title">${escape(noteTitle(latest.text))}</strong><span class="note-preview-body">${escape(noteBody(latest.text))}</span><small class="note-status"><span>${escape(noteTime(latest.updatedAt))}</span><span>共 ${written.length} 条</span></small>`;
}
async function json(url) {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('服务暂不可用，请稍后重试');
  return response.json();
}

export function createWidgets({ initialWeather, getState, isEditing, save, render, report, reveal }) {
  const tools = createWidgetTools({ getState, save, report });
  let editingId = null, selectedCity = null, cityRequest = 0, selectedType = 'note', pendingPlacement = null;
  const weatherRequests = new WeakMap(), displayedWeather = new WeakMap();
  const weather = createWeatherCache({ initial: initialWeather, storage: browser.storage.local, request: json, lock: run => navigator.locks ? navigator.locks.request('tabcat-weather-cache', run) : run() });
  const dialog = document.createElement('dialog'); dialog.id = 'widgetModal'; dialog.className = 'modal form-modal widget-modal'; dialog.setAttribute('aria-labelledby', 'widgetModalTitle');
  dialog.innerHTML = `<form id="widgetForm"><div class="modal-header"><h2 id="widgetModalTitle">添加小组件</h2><button type="button" class="icon-button" data-close aria-label="关闭小组件设置">${UI_ICONS.close}</button></div><div class="modal-body">
    <div id="widgetConfiguration"><div class="widget-config-layout"><div class="widget-preview-column"><div id="widgetSelectedPreview"></div><p class="helper">样式预览 · 示例内容</p></div><div class="widget-config-fields">
    <div class="field"><label for="widgetName">标题</label><input id="widgetName" maxlength="80" required placeholder="例如：今天要做的事"></div>
    <div class="field"><label for="widgetSize">网格尺寸</label><select id="widgetSize"><option value="2,2">2 × 2 · 小</option><option value="3,2">3 × 2 · 中</option><option value="4,3">4 × 3 · 大</option></select></div>
    <div id="weatherFields" hidden><div class="field"><label for="widgetLocationMode">天气位置</label><select id="widgetLocationMode"><option value="ip">自动定位（IP）</option><option value="manual">手动选择城市</option></select></div><p id="widgetIpHint" class="helper">添加后按当前网络 IP 自动定位城市；代理或 VPN 可能影响结果，可切换为手动选城。定位由 ipwho.is 提供。</p><div id="widgetManualLocation" hidden><label for="widgetCity">城市</label><div class="city-search"><input id="widgetCity" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="widgetCityResults" autocomplete="off" placeholder="输入城市名称，如杭州、Hangzhou" maxlength="100"><button class="secondary-button" type="button" id="findWidgetCity">搜索</button><div id="widgetCityDropdown" class="city-dropdown" popover="manual"><p id="widgetCitySearchStatus" class="helper" role="status"></p><div id="widgetCityResults" class="city-results" role="listbox" aria-label="城市搜索结果"></div></div></div><p id="widgetCityStatus" class="helper" role="status"></p><p class="helper">同名地点请核对省份和所属地区。</p></div><p class="helper">天气由 Open-Meteo 提供，每 15 分钟更新；使用定位或所选城市的坐标查询。</p></div>
    <div id="webFields" hidden><div class="field"><label for="widgetUrl">HTTPS 网页地址</label><input id="widgetUrl" type="url" placeholder="https://example.com"></div><p class="helper">填写网站提供的嵌入地址。部分网站禁止 iframe 嵌入，或需要另开页面登录，可使用组件内的“独立打开”。</p></div>
    <div id="clockFields" hidden><div class="field"><label for="widgetTimezone">时区</label><select id="widgetTimezone">${[...new Set(['Asia/Shanghai', 'UTC', ...Intl.supportedValuesOf('timeZone')])].map(zone => `<option value="${zone}">${zone.replaceAll('_', ' ')}</option>`).join('')}</select></div><div class="field"><label for="widgetHour24">时间格式</label><select id="widgetHour24"><option value="true">24 小时制</option><option value="false">12 小时制</option></select></div></div>
    <div id="countdownFields" hidden><div class="field"><label for="widgetTargetDate">目标日期</label><input id="widgetTargetDate" type="date" min="0001-01-01" max="9999-12-31"></div><p class="helper">当天显示“就是今天”，过去的日期显示已经过了多少天。</p></div>
    <div id="pomodoroFields" hidden><div class="field-row"><div class="field"><label for="widgetFocusMinutes">专注分钟</label><input id="widgetFocusMinutes" type="number" min="1" max="120" value="25"></div><div class="field"><label for="widgetBreakMinutes">休息分钟</label><input id="widgetBreakMinutes" type="number" min="1" max="60" value="5"></div></div><p class="helper">支持开始、暂停和重置，刷新后继续计时。结束时在组件内提示；切换模式或修改时长会重置本轮，不发送系统通知。</p></div>
    <p id="widgetError" class="helper danger-text" role="alert"></p>
    </div></div></div></div><div class="modal-actions"><button class="secondary-button" type="button" data-close>取消</button><button class="primary-button" id="saveWidget" type="submit" hidden>保存组件</button></div></form>`;
  document.body.append(dialog);
  function clearPreviews() { closeCityDropdown(); $('#widgetSelectedPreview').replaceChildren(); }
  function close() { dialog.close(); clearPreviews(); }
  dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = close);
  dialog.addEventListener('close', () => { if (!dialog.open) clearPreviews(); });
  const syncType = () => {
    const type = selectedType;
    for (const kind of ['weather', 'web', 'clock', 'countdown', 'pomodoro']) {
      const fields = $(`#${kind}Fields`); fields.hidden = type !== kind;
      fields.querySelectorAll('input,select,button').forEach(input => { input.disabled = type !== kind; });
    }
    $('#widgetUrl').required = type === 'web'; $('#widgetTargetDate').required = type === 'countdown';
    $('#widgetFocusMinutes').required = $('#widgetBreakMinutes').required = type === 'pomodoro';
    syncLocationMode();
  };
  function syncLocationMode() {
    const manual = selectedType === 'weather' && $('#widgetLocationMode').value === 'manual';
    $('#widgetManualLocation').hidden = !manual; $('#widgetIpHint').hidden = manual;
    $('#widgetManualLocation').querySelectorAll('input,button').forEach(input => { input.disabled = !manual; });
  }
  $('#widgetLocationMode').onchange = () => { closeCityDropdown(); $('#widgetError').textContent = ''; syncLocationMode(); };
  function sampleWidget(type) {
    const target = new Date(); target.setDate(target.getDate() + 10);
    const widget = { id: `preview-${type}`, type, name: WIDGET_TYPES[type][0], timezone: getState().timezone, hour24: true, targetDate: localDate(target), items: [{ id: 'one', text: '整理今天的计划', done: true }, { id: 'two', text: '留一点时间给自己', done: false }], notes: [{ id: 'one', text: '今天的灵感\n把想做的事，慢慢变成日常。', updatedAt: Date.now() }] };
    return { ...widget, ...normalizeTool(widget) };
  }
  function previewCard(type) {
    const widget = sampleWidget(type), host = document.createElement('div');
    host.innerHTML = card(widget, false);
    const article = host.firstElementChild;
    // Fill the same markup used on the desktop without registering live widgets.
    if (type === 'weather') { setWeatherScene(article.querySelector('.weather-content'), { weather_code: 2, is_day: 1 }); article.querySelector('.weather-content').innerHTML = '<span class="weather-city">杭州</span><strong class="weather-temperature">24°</strong><span>多云 · 湿度 65%</span><small>更新于 09:41</small>'; }
    else if (type === 'web') {
      const placeholder = document.createElement('div'); placeholder.className = 'widget-web-sample';
      placeholder.innerHTML = '<span>▤</span><strong>你的常用工具</strong><small>在桌面中打开网页</small>';
      article.querySelector('iframe').replaceWith(placeholder);
    } else tools.preview(article, widget);
    // Preview forms must not nest inside the settings form or submit real actions.
    article.querySelectorAll('form').forEach(form => { const body = document.createElement('div'); body.className = form.className; body.append(...form.childNodes); form.replaceWith(body); });
    for (const node of [article, ...article.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) if (attribute.name.startsWith('data-') || ['id', 'name', 'required', 'href'].includes(attribute.name)) node.removeAttribute(attribute.name);
      if (node.matches('input,textarea,select,button')) { node.disabled = true; node.tabIndex = -1; }
    }
    article.inert = true; article.setAttribute('aria-hidden', 'true');
    return article;
  }
  function showConfiguration() {
    $('#saveWidget').hidden = false;
    $('#widgetSelectedPreview').replaceChildren(previewCard(selectedType));
    const title = $('#widgetSelectedPreview .widget-header strong'); if (title) title.textContent = $('#widgetName').value;
    dialog.querySelector('.modal-body').scrollTop = 0;
  }
  async function add(type, placement) {
    if (!Object.hasOwn(WIDGET_TYPES, type)) return;
    if (type === 'web') { open(null, type, placement); return { configured: true }; }
    const state = getState();
    const widget = { id: crypto.randomUUID(), type, name: WIDGET_TYPES[type][0], width: 2, height: 2, locationMode: 'ip', timezone: state.timezone, hour24: state.hour24, targetDate: localDate() };
    Object.assign(widget, normalizeTool(widget));
    state.widgets.push(widget); state.desktopOrder.push({ id: `widget:${widget.id}` });
    if (placement) moveDesktopItem(state, `widget:${widget.id}`, placement.target, placement.after);
    render(); reveal(`widget:${widget.id}`);
    if (!await save()) throw new Error('未能保存组件，请重试');
    return { widget };
  }
  $('#widgetName').addEventListener('input', () => { const title = $('#widgetSelectedPreview .widget-header strong'); if (title) title.textContent = $('#widgetName').value.trim() || WIDGET_TYPES[selectedType][0]; });
  const cityInput = $('#widgetCity'), cityDropdown = $('#widgetCityDropdown'), cityResults = $('#widgetCityResults');
  const citySearchStatus = $('#widgetCitySearchStatus'), citySearch = cityInput.closest('.city-search');
  let cityTimer, activeCity = -1;
  function closeCityDropdown() {
    clearTimeout(cityTimer); cityRequest++;
    cityDropdown.hidePopover(); cityInput.setAttribute('aria-expanded', 'false');
    cityInput.removeAttribute('aria-activedescendant'); activeCity = -1;
    cityResults.querySelectorAll('[aria-selected]').forEach(option => option.setAttribute('aria-selected', 'false'));
  }
  function positionCityDropdown() {
    if (!cityDropdown.matches(':popover-open')) return;
    const rect = citySearch.getBoundingClientRect(), gap = 6, edge = 12;
    const below = window.innerHeight - rect.bottom - gap - edge, above = rect.top - gap - edge;
    const upwards = below < 180 && above > below;
    cityDropdown.style.width = `${Math.min(rect.width, window.innerWidth - edge * 2)}px`;
    cityDropdown.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - rect.width - edge))}px`;
    cityDropdown.style.maxHeight = `${Math.max(0, Math.min(260, upwards ? above : below))}px`;
    cityDropdown.style.top = upwards ? 'auto' : `${rect.bottom + gap}px`;
    cityDropdown.style.bottom = upwards ? `${window.innerHeight - rect.top + gap}px` : 'auto';
  }
  function showCityDropdown() {
    cityDropdown.showPopover(); cityInput.setAttribute('aria-expanded', 'true'); positionCityDropdown();
  }
  async function searchCities() {
    closeCityDropdown(); cityResults.replaceChildren();
    const name = cityInput.value.trim();
    citySearchStatus.textContent = name.length < 2 ? '请输入至少两个字符' : '正在查找城市…';
    showCityDropdown();
    if (name.length < 2) return;
    const request = cityRequest;
    try {
      const data = await json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=zh&format=json`);
      if (request !== cityRequest || !dialog.open) return;
      const cities = rankCities(data.results, name);
      citySearchStatus.textContent = cities.length ? '请选择城市，并核对所属地区' : '没有找到城市，请尝试英文名称';
      for (const [index, city] of cities.entries()) {
        const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
        button.id = `widgetCityOption-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
        button.textContent = cityLabel(city);
        button.onpointerdown = event => event.preventDefault();
        button.onclick = () => {
          selectedCity = city; cityInput.value = city.name;
          $('#widgetCityStatus').textContent = `已选择：${button.textContent}`; $('#widgetError').textContent = '';
          closeCityDropdown(); cityResults.replaceChildren(); cityInput.focus();
        };
        cityResults.append(button);
      }
    } catch (error) { if (request === cityRequest) citySearchStatus.textContent = error.message; }
  }
  cityInput.oninput = event => {
    selectedCity = null; closeCityDropdown(); cityResults.replaceChildren(); $('#widgetCityStatus').textContent = '';
    if (!event.isComposing && cityInput.value.trim().length >= 2) cityTimer = setTimeout(searchCities, 300);
  };
  cityInput.addEventListener('compositionend', () => cityInput.dispatchEvent(new Event('input')));
  $('#findWidgetCity').onclick = searchCities;
  cityInput.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (cityDropdown.matches(':popover-open') && activeCity >= 0) cityResults.children[activeCity]?.click();
      else searchCities();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (!cityDropdown.matches(':popover-open')) { searchCities(); return; }
      const options = [...cityResults.children]; if (!options.length) return;
      activeCity = (activeCity + (event.key === 'ArrowDown' ? 1 : activeCity < 0 ? 0 : -1) + options.length) % options.length;
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === activeCity)));
      cityInput.setAttribute('aria-activedescendant', options[activeCity].id); options[activeCity].scrollIntoView({ block: 'nearest' });
    }
  };
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && cityDropdown.matches(':popover-open')) { event.preventDefault(); event.stopPropagation(); closeCityDropdown(); }
  });
  document.addEventListener('pointerdown', event => { if (!citySearch.contains(event.target)) closeCityDropdown(); });
  citySearch.addEventListener('focusout', () => { queueMicrotask(() => { if (!citySearch.contains(document.activeElement)) closeCityDropdown(); }); });
  dialog.querySelector('.modal-body').addEventListener('scroll', positionCityDropdown);
  window.addEventListener('resize', positionCityDropdown);
  $('#widgetForm').onsubmit = async event => {
    event.preventDefault(); const type = selectedType; const state = getState(); const existing = state.widgets.find(widget => widget.id === editingId);
    if (editingId && !existing) { $('#widgetError').textContent = '此组件已在其他标签页删除，请重新添加。'; return; }
    const widget = { ...existing, id: editingId || crypto.randomUUID(), type, name: $('#widgetName').value.trim() };
    [widget.width, widget.height] = $('#widgetSize').value.split(',').map(Number);
    if (!widget.name) { $('#widgetError').textContent = '请输入组件标题'; return; }
    if (type === 'weather') {
      widget.locationMode = $('#widgetLocationMode').value;
      if (widget.locationMode === 'manual') {
        if (!selectedCity) { $('#widgetError').textContent = '请搜索并选择一座城市'; return; }
        Object.assign(widget, { city: selectedCity.name, cityLabel: selectedCity.cityLabel || cityLabel(selectedCity), latitude: selectedCity.latitude, longitude: selectedCity.longitude });
      } else { delete widget.city; delete widget.cityLabel; delete widget.latitude; delete widget.longitude; }
    }
    if (type === 'web') {
      widget.url = normalizeUrl($('#widgetUrl').value);
      if (!widget.url.startsWith('https://')) { $('#widgetError').textContent = '请输入有效的 HTTPS 网页地址'; return; }
    }
    if (type === 'clock') Object.assign(widget, { timezone: $('#widgetTimezone').value, hour24: $('#widgetHour24').value === 'true' });
    if (type === 'countdown') {
      widget.targetDate = $('#widgetTargetDate').value;
      if (!validDate(widget.targetDate)) { $('#widgetError').textContent = '请选择有效的目标日期'; return; }
    }
    if (type === 'pomodoro') {
      widget.focusMinutes = Number($('#widgetFocusMinutes').value); widget.breakMinutes = Number($('#widgetBreakMinutes').value);
      if (widget.focusMinutes !== existing?.focusMinutes || widget.breakMinutes !== existing?.breakMinutes) delete widget.timer;
    }
    Object.assign(widget, normalizeTool(widget));
    if (existing) Object.assign(existing, widget); else { state.widgets.push(widget); state.desktopOrder.push({ id: `widget:${widget.id}` }); }
    if (!existing && pendingPlacement) moveDesktopItem(state, `widget:${widget.id}`, pendingPlacement.target, pendingPlacement.after);
    close(); render(); reveal(`widget:${widget.id}`); await save();
  };
  function open(id, type = 'note', placement = null) {
    pendingPlacement = placement;
    const widget = getState().widgets.find(item => item.id === id); editingId = widget?.id || null;
    closeCityDropdown(); $('#widgetForm').reset(); selectedType = widget?.type || type;
    $('#widgetName').value = widget?.name || WIDGET_TYPES[selectedType][0]; $('#widgetSize').value = `${widget?.width || 2},${widget?.height || 2}`;
    $('#widgetUrl').value = widget?.url || ''; $('#widgetCity').value = widget?.city || '';
    const timezone = widget?.timezone || getState().timezone || 'Asia/Shanghai';
    if (![...$('#widgetTimezone').options].some(option => option.value === timezone)) $('#widgetTimezone').add(new Option(timezone.replaceAll('_', ' '), timezone));
    $('#widgetTimezone').value = timezone;
    $('#widgetHour24').value = String(widget?.hour24 !== false); $('#widgetTargetDate').value = widget?.targetDate || localDate();
    $('#widgetFocusMinutes').value = widget?.focusMinutes || 25; $('#widgetBreakMinutes').value = widget?.breakMinutes || 5;
    $('#widgetLocationMode').value = widget?.type === 'weather' ? widget.locationMode || 'manual' : 'ip';
    selectedCity = widget?.type === 'weather' && widget.locationMode !== 'ip' ? { name: widget.city, cityLabel: widget.cityLabel || widget.city, latitude: widget.latitude, longitude: widget.longitude } : null;
    $('#widgetCityStatus').textContent = selectedCity ? `已选择：${selectedCity.cityLabel}` : ''; $('#widgetCityResults').replaceChildren(); $('#widgetError').textContent = '';
    $('#widgetModalTitle').textContent = widget ? '编辑小组件' : '添加小组件'; syncType(); showConfiguration(); dialog.showModal();
  }
  function card(widget, editing, withHeader = true) {
    const content = tools.content(widget, editing) ?? (widget.type === 'note' ? `<button type="button" class="note-preview" data-note-preview="${escape(widget.id)}" aria-label="打开${escape(widget.name)}">${notePreview(widget)}</button>`
      : widget.type === 'weather' ? `${weatherScene}<div class="weather-content" data-weather="${escape(widget.id)}" role="status">正在获取天气…</div><div class="weather-footer"><a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a><button data-weather-refresh="${escape(widget.id)}" aria-label="刷新天气">刷新</button></div>`
      : `<iframe title="${escape(widget.name)}" data-web-url="${escape(widget.url)}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer" loading="lazy"></iframe><div class="web-footer"><span class="web-origin" title="${escape(widget.url)}">${escape(widget.url ? new URL(widget.url).hostname : '网页工具')}</span><a href="${escape(widget.url)}" target="_blank" rel="noopener noreferrer">独立打开 ↗</a><small>无法显示？网站可能禁止嵌入</small></div>`);
    const compact = widget.type === 'weather' || (['clock', 'calendar', 'pomodoro', 'calculator'].includes(widget.type) && widget.name === WIDGET_TYPES[widget.type][0]);
    const header = compact || !withHeader ? '' : `<header class="widget-header" ${editing ? 'title="拖动标题栏调整位置"' : ''}><strong>${escape(widget.name)}</strong></header>`;
    return `<article class="widget-card widget-${widget.type}${compact ? ' compact-widget' : ''}" aria-label="${escape(widget.name)}小组件">${header}${content}</article>`;
  }
  function hydrate() {
    tools.hydrate();
    paintNotePreviews();
    if (expanded.open) syncExpanded();
    document.querySelectorAll('[data-weather]').forEach(node => {
      const widget = getState().widgets.find(item => item.id === node.dataset.weather);
      const cached = widget && weather.peek(widget);
      if (cached) paintWeather(node, cached, widget.locationMode === 'ip');
      void loadWeather(node);
    });
  }
  function activateFrames() {
    document.querySelectorAll('.sites-page:not([inert]) iframe[data-web-url]').forEach(frame => { if (!frame.src) frame.src = frame.dataset.webUrl; });
  }
  function paintWeather(node, entry, automatic, status = '') {
    const current = entry.current, location = entry.location;
    const label = setWeatherScene(node, { ...current, is_day: weatherDaylight(entry) });
    node.closest('.widget-weather').classList.add(...weatherMoon(entry).split(' '));
    node.innerHTML = `<span class="weather-city" title="${escape(location.cityLabel || location.city)}">${escape(location.city)}</span><strong class="weather-temperature">${Math.round(current.temperature_2m)}°</strong><span>${label} · 湿度 ${Number.isFinite(current.relative_humidity_2m) ? escape(current.relative_humidity_2m) + '%' : '—'}</span><small>${automatic ? 'IP 定位 · ' : ''}更新于 ${escape(weatherUpdatedTime(entry))}</small>${status ? `<small class="weather-cache-state">${status}</small>` : ''}`;
    displayedWeather.set(node, { entry, automatic, status });
  }
  async function loadWeather(node, force = false) {
    const widget = getState().widgets.find(item => item.id === node.dataset.weather); if (!widget) return;
    const request = (weatherRequests.get(node) || 0) + 1; weatherRequests.set(node, request);
    const currentRequest = () => node.isConnected && weatherRequests.get(node) === request;
    const automatic = widget.locationMode === 'ip';
    const cached = await weather.snapshot(widget);
    if (!currentRequest()) return;
    if (cached) paintWeather(node, cached, automatic);
    else { displayedWeather.delete(node); setWeatherScene(node, {}); node.textContent = automatic ? '正在按 IP 定位城市…' : '正在获取天气…'; }
    if (!force && cached && weatherCacheFresh(cached.at)) { node.removeAttribute('aria-busy'); return; }
    node.setAttribute('aria-busy', 'true');
    try {
      const entry = await weather.refresh(widget, force);
      if (currentRequest()) paintWeather(node, entry, automatic);
    } catch (error) {
      if (!currentRequest()) return;
      const locationError = error.phase === 'location';
      const settings = locationError ? `，或<button class="weather-location-action" data-weather-settings="${escape(widget.id)}">手动选城</button>` : '';
      if (cached) paintWeather(node, cached, automatic, `${locationError ? '暂时无法按 IP 定位' : '暂时无法刷新'}，保留上次天气${settings}`);
      else node.innerHTML = `${locationError ? '暂时无法按 IP 定位' : '暂时无法获取天气'}，请点击刷新重试${settings}。`;
    } finally { if (currentRequest()) node.removeAttribute('aria-busy'); }
  }
  async function remove(id) {
    const state = getState(), index = state.widgets.findIndex(widget => widget.id === id); if (index < 0) return;
    if (expandedId === id) expanded.close();
    const [widget] = state.widgets.splice(index, 1); const order = state.desktopOrder.findIndex(item => item.id === `widget:${widget.id}`);
    state.desktopOrder = state.desktopOrder.filter(item => item.id !== `widget:${widget.id}`); render();
    if (await save()) {
      report(`已移除「${widget.name}」`); const undo = document.createElement('button'); undo.textContent = '撤销';
      undo.onclick = async () => { const latest = getState(); if (!latest.widgets.some(item => item.id === widget.id)) { latest.widgets.push(widget); latest.desktopOrder.splice(Math.max(0, order), 0, { id: `widget:${widget.id}` }); render(); await save(); } $('#status').hidden = true; }; $('#status').append(undo);
    }
  }
  function widgetAction(event) {
    const edit = event.target.closest('[data-widget-edit]'), removing = event.target.closest('[data-widget-remove]'), refresh = event.target.closest('[data-weather-refresh]');
    const locationSettings = event.target.closest('[data-weather-settings]');
    if (edit) open(edit.dataset.widgetEdit);
    else if (locationSettings) { expanded.close(); open(locationSettings.dataset.weatherSettings); $('#widgetLocationMode').value = 'manual'; syncLocationMode(); $('#widgetCity').focus(); }
    else if (removing) void remove(removing.dataset.widgetRemove);
    else if (refresh) { const node = refresh.closest('.widget-card').querySelector('[data-weather]'); void loadWeather(node, true); }
    else return false;
    return true;
  }
  document.querySelector('#sitesPages').addEventListener('click', event => {
    if (widgetAction(event) || isEditing()) return;
    // Like a phone widget, a click opens its details; its own controls still work in place.
    const card = event.target.closest('.widget-card'), tile = card?.closest('[data-desktop-key^="widget:"]');
    if (tile && (event.target.closest('[data-note-preview]') || !event.target.closest('button, a, input, textarea, select, label, iframe, form'))) expand(tile.dataset.desktopKey.slice(7));
  });

  // The detail popup: a note list with an editor, or the card's content with
  // room to work. No title bar; its buttons float above the panel.
  const expanded = document.createElement('dialog'); expanded.id = 'widgetDetail'; expanded.className = 'widget-detail';
  expanded.innerHTML = `<div class="widget-detail-actions"><button type="button" data-expanded-settings aria-label="小组件设置" title="小组件设置">${UI_ICONS.settings}</button><button type="button" data-expanded-close aria-label="关闭" title="关闭">${UI_ICONS.close}</button></div><div class="widget-detail-body"></div>`;
  document.body.append(expanded);
  const expandedBody = expanded.querySelector('.widget-detail-body');
  let expandedId = null, selectedNote = null, deletedNote = null, noteSaveTimer;
  const expandedWidget = () => getState().widgets.find(item => item.id === expandedId);
  const editor = () => expanded.querySelector('.note-editor');
  function expand(id) {
    const widget = getState().widgets.find(item => item.id === id); if (!widget) return;
    // Its close event runs later and would clear a view opened in between.
    if (expanded.open) return;
    expandedId = id; deletedNote = null;
    expanded.setAttribute('aria-label', widget.name); expanded.dataset.type = widget.type;
    if (widget.type === 'note') {
      expandedBody.innerHTML = `<div class="note-manager"><aside class="note-sidebar"><button type="button" class="secondary-button note-new" data-note-new>＋ 新建备忘</button><div class="note-list" role="listbox" aria-label="备忘列表"></div></aside><section class="note-detail"><textarea class="note-editor" aria-label="备忘内容" placeholder="记下此刻的想法…" maxlength="20000"></textarea><footer class="note-status"><span data-note-state role="status">自动保存在本机</span><span data-note-count>0 字</span><button type="button" class="note-delete" data-note-delete>删除</button></footer></section></div>`;
      selectedNote = latestNote(widget.notes)?.id ?? null;
      expanded.showModal();
      if (selectedNote) { renderNotes(); showNote(); editor().focus(); } else void createNote();
    } else {
      expandedBody.innerHTML = card(widget, false, false);
      expandedBody.querySelector('iframe[data-web-url]')?.setAttribute('src', widget.url);
      expanded.showModal(); hydrate();
    }
  }
  function syncExpanded() {
    const widget = expandedWidget(); if (!widget) { expanded.close(); return; }
    expanded.setAttribute('aria-label', widget.name);
    if (widget.type !== 'note') return;
    if (!widget.notes.some(note => note.id === selectedNote)) { selectedNote = latestNote(widget.notes)?.id ?? null; showNote(); }
    else if (document.activeElement !== editor()) showNote();
    renderNotes();
  }
  function renderNotes() {
    const widget = expandedWidget(), list = expanded.querySelector('.note-list'); if (!widget || !list) return;
    const notes = [...widget.notes].sort((a, b) => b.updatedAt - a.updatedAt);
    list.innerHTML = notes.map(note => `<button type="button" role="option" class="note-item" data-note-pick="${escape(note.id)}" aria-selected="${note.id === selectedNote}"><strong>${escape(noteTitle(note.text))}</strong><span>${escape(noteBody(note.text).slice(0, 80)) || '&nbsp;'}</span><small>${escape(noteTime(note.updatedAt))}</small></button>`).join('');
  }
  function showNote() {
    const note = expandedWidget()?.notes.find(item => item.id === selectedNote), input = editor(); if (!input) return;
    input.value = note?.text || ''; input.disabled = !note;
    expanded.querySelector('[data-note-count]').textContent = `${[...input.value].length} 字`;
    expanded.querySelector('[data-note-delete]').disabled = !note;
    if (!deletedNote) expanded.querySelector('[data-note-state]').textContent = '自动保存在本机';
  }
  // Notes that were opened but never written are not kept.
  function pruneNotes(keep) {
    const widget = expandedWidget(); if (!widget) return false;
    const count = widget.notes.length;
    widget.notes = widget.notes.filter(note => note.id === keep || note.text.trim());
    return widget.notes.length !== count;
  }
  function paintNotePreviews() {
    for (const node of document.querySelectorAll('[data-note-preview]')) {
      const widget = getState().widgets.find(item => item.id === node.dataset.notePreview); if (!widget) continue;
      const markup = notePreview(widget); if (node.dataset.markup !== markup) { node.dataset.markup = markup; node.innerHTML = markup; }
    }
  }
  async function createNote() {
    const widget = expandedWidget(); if (!widget) return;
    pruneNotes();
    if (widget.notes.length >= 200) { expanded.querySelector('[data-note-state]').textContent = '每个备忘组件最多保存 200 条'; return; }
    const note = { id: crypto.randomUUID(), text: '', updatedAt: Date.now() };
    widget.notes.push(note); selectedNote = note.id;
    renderNotes(); showNote(); editor().focus();
    await save();
  }
  expanded.querySelector('[data-expanded-close]').onclick = () => expanded.close();
  expanded.querySelector('[data-expanded-settings]').onclick = () => { const id = expandedId; expanded.close(); open(id); };
  expanded.addEventListener('close', () => {
    const changed = pruneNotes();
    clearTimeout(noteSaveTimer); expandedBody.replaceChildren(); expandedId = selectedNote = deletedNote = null;
    if (changed) { paintNotePreviews(); void save(); }
  });
  expanded.addEventListener('click', async event => {
    if (widgetAction(event)) return;
    const pick = event.target.closest('[data-note-pick]');
    if (pick) {
      selectedNote = pick.dataset.notePick; deletedNote = null;
      const pruned = pruneNotes(selectedNote); renderNotes(); showNote(); editor().focus();
      if (pruned) await save();
    } else if (event.target.closest('[data-note-new]')) { deletedNote = null; await createNote(); }
    else if (event.target.closest('[data-note-delete]')) {
      const widget = expandedWidget(), index = widget?.notes.findIndex(note => note.id === selectedNote) ?? -1; if (index < 0) return;
      const [note] = widget.notes.splice(index, 1);
      deletedNote = note.text.trim() ? note : null;
      selectedNote = latestNote(widget.notes)?.id ?? null;
      renderNotes(); showNote(); paintNotePreviews();
      if (!await save()) { expanded.querySelector('[data-note-state]').textContent = '删除未能保存，请重试'; return; }
      if (deletedNote) expanded.querySelector('[data-note-state]').innerHTML = `已删除「${escape(noteTitle(note.text))}」<button type="button" data-note-undo>撤销</button>`;
      if (!selectedNote) await createNote();
    } else if (event.target.closest('[data-note-undo]')) {
      const widget = expandedWidget(), note = deletedNote; if (!widget || !note) return;
      if (!widget.notes.some(item => item.id === note.id)) widget.notes.push(note);
      deletedNote = null; selectedNote = note.id; pruneNotes(note.id);
      renderNotes(); showNote(); paintNotePreviews(); await save();
    }
  });
  expanded.addEventListener('input', event => {
    if (!event.target.matches('.note-editor')) return;
    const note = expandedWidget()?.notes.find(item => item.id === selectedNote); if (!note) return;
    note.text = event.target.value; note.updatedAt = Date.now(); deletedNote = null;
    const status = expanded.querySelector('[data-note-state]');
    status.textContent = '正在保存…'; expanded.querySelector('[data-note-count]').textContent = `${[...note.text].length} 字`;
    renderNotes(); paintNotePreviews();
    // Persist on each input so closing a tab cannot lose a pending debounce.
    clearTimeout(noteSaveTimer);
    const promise = save();
    noteSaveTimer = setTimeout(async () => { const ok = await promise; if (status.isConnected) status.textContent = ok ? '已保存到本机' : '保存失败，请重试'; }, 250);
  });
  const visibleWeather = () => document.querySelectorAll('.sites-page:not([inert]) [data-weather]');
  // Network refreshes follow :00/:15/:30/:45; scene changes need no request.
  function scheduleWeather() {
    setTimeout(() => { if (!document.hidden) visibleWeather().forEach(node => { void loadWeather(node); }); scheduleWeather(); }, WEATHER_CACHE_MS - Date.now() % WEATHER_CACHE_MS + 50);
  }
  scheduleWeather();
  setInterval(() => {
    if (document.hidden) return;
    visibleWeather().forEach(node => { const shown = displayedWeather.get(node); if (shown) { setWeatherScene(node, { ...shown.entry.current, is_day: weatherDaylight(shown.entry) }); node.closest('.widget-weather').classList.add(...weatherMoon(shown.entry).split(' ')); } });
  }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) visibleWeather().forEach(node => { void loadWeather(node); }); });
  return { open, add, remove, expand, previewCard, card, hydrate, activateFrames };
}
