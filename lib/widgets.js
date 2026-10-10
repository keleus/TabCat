import { WIDGET_TYPES, normalizeTool, validDate, localDate } from './widget-tools.js';
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
async function json(url) {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('服务暂不可用，请稍后重试');
  return response.json();
}

export function createWidgets({ initialWeather, getState, save, render, report, reveal }) {
  const tools = createWidgetTools({ getState, save, report });
  let editingId = null, selectedCity = null, cityRequest = 0, selectedType = 'note', pendingPlacement = null;
  const weatherRequests = new WeakMap(), displayedWeather = new WeakMap(), noteTimers = new Map();
  const weather = createWeatherCache({ initial: initialWeather, storage: browser.storage.local, request: json, lock: run => navigator.locks ? navigator.locks.request('tabcat-weather-cache', run) : run() });
  const dialog = document.createElement('dialog'); dialog.id = 'widgetModal'; dialog.className = 'modal form-modal widget-modal'; dialog.setAttribute('aria-labelledby', 'widgetModalTitle');
  dialog.innerHTML = `<form id="widgetForm"><div class="modal-header"><h2 id="widgetModalTitle">添加小组件</h2><button type="button" class="icon-button" data-close aria-label="关闭小组件设置">×</button></div><div class="modal-body">
    <div id="widgetConfiguration"><div class="widget-config-layout"><div class="widget-preview-column"><div id="widgetSelectedPreview"></div><p class="helper">样式预览 · 示例内容</p></div><div class="widget-config-fields">
    <div class="field"><label for="widgetName">标题</label><input id="widgetName" maxlength="80" required placeholder="例如：今天要做的事"></div>
    <div class="field"><label for="widgetSize">网格尺寸</label><select id="widgetSize"><option value="2,2">2 × 2 · 小</option><option value="3,2">3 × 2 · 中</option><option value="4,3">4 × 3 · 大</option></select></div>
    <div id="weatherFields" hidden><div class="field"><label for="widgetLocationMode">天气位置</label><select id="widgetLocationMode"><option value="ip">自动定位（IP）</option><option value="manual">手动选择城市</option></select></div><p id="widgetIpHint" class="helper">添加后按当前网络 IP 自动定位城市；代理或 VPN 可能影响结果，可切换为手动选城。定位由 ipwho.is 提供。</p><div id="widgetManualLocation" hidden><label for="widgetCity">城市</label><div class="city-search"><input id="widgetCity" placeholder="输入城市名称，如杭州、Hangzhou" maxlength="100"><button class="secondary-button" type="button" id="findWidgetCity">搜索</button></div><div id="widgetCityResults" class="city-results"></div><p id="widgetCityStatus" class="helper" role="status"></p><p class="helper">同名地点请核对省份和所属地区。</p></div><p class="helper">天气由 Open-Meteo 提供，每 15 分钟更新；使用定位或所选城市的坐标查询。</p></div>
    <div id="webFields" hidden><div class="field"><label for="widgetUrl">HTTPS 网页地址</label><input id="widgetUrl" type="url" placeholder="https://example.com"></div><p class="helper">填写网站提供的嵌入地址。部分网站禁止 iframe 嵌入，或需要另开页面登录，可使用组件内的“独立打开”。</p></div>
    <div id="clockFields" hidden><div class="field"><label for="widgetTimezone">时区</label><select id="widgetTimezone">${[...new Set(['Asia/Shanghai', 'UTC', ...Intl.supportedValuesOf('timeZone')])].map(zone => `<option value="${zone}">${zone.replaceAll('_', ' ')}</option>`).join('')}</select></div><div class="field"><label for="widgetHour24">时间格式</label><select id="widgetHour24"><option value="true">24 小时制</option><option value="false">12 小时制</option></select></div></div>
    <div id="countdownFields" hidden><div class="field"><label for="widgetTargetDate">目标日期</label><input id="widgetTargetDate" type="date" min="0001-01-01" max="9999-12-31"></div><p class="helper">当天显示“就是今天”，过去的日期显示已经过了多少天。</p></div>
    <div id="pomodoroFields" hidden><div class="field-row"><div class="field"><label for="widgetFocusMinutes">专注分钟</label><input id="widgetFocusMinutes" type="number" min="1" max="120" value="25"></div><div class="field"><label for="widgetBreakMinutes">休息分钟</label><input id="widgetBreakMinutes" type="number" min="1" max="60" value="5"></div></div><p class="helper">支持开始、暂停和重置，刷新后继续计时。结束时在组件内提示；切换模式或修改时长会重置本轮，不发送系统通知。</p></div>
    <p id="widgetError" class="helper danger-text" role="alert"></p>
    </div></div></div></div><div class="modal-actions"><button class="secondary-button" type="button" data-close>取消</button><button class="primary-button" id="saveWidget" type="submit" hidden>保存组件</button></div></form>`;
  document.body.append(dialog);
  function clearPreviews() { cityRequest++; $('#widgetSelectedPreview').replaceChildren(); }
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
  $('#widgetLocationMode').onchange = () => { cityRequest++; $('#widgetError').textContent = ''; syncLocationMode(); };
  function sampleWidget(type) {
    const target = new Date(); target.setDate(target.getDate() + 10);
    const widget = { id: `preview-${type}`, type, name: WIDGET_TYPES[type][0], timezone: getState().timezone, hour24: true, targetDate: localDate(target), items: [{ id: 'one', text: '整理今天的计划', done: true }, { id: 'two', text: '留一点时间给自己', done: false }] };
    return { ...widget, ...normalizeTool(widget) };
  }
  function previewCard(type) {
    const widget = sampleWidget(type), host = document.createElement('div');
    host.innerHTML = card(widget, false);
    const article = host.firstElementChild;
    // Fill the same markup used on the desktop without registering live widgets.
    if (type === 'note') { article.querySelector('textarea').value = '今天的灵感\n\n把想做的事，慢慢变成日常。'; article.querySelector('[data-note-count]').textContent = `${[...article.querySelector('textarea').value].length} 字`; }
    else if (type === 'weather') { setWeatherScene(article.querySelector('.weather-content'), { weather_code: 2, is_day: 1 }); article.querySelector('.weather-content').innerHTML = '<span class="weather-city">杭州</span><strong class="weather-temperature">24°</strong><span>多云 · 湿度 65%</span><small>更新于 09:41</small>'; }
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
    const widget = { id: crypto.randomUUID(), type, name: WIDGET_TYPES[type][0], width: 2, height: 2, text: '', locationMode: 'ip', timezone: state.timezone, hour24: state.hour24, targetDate: localDate() };
    Object.assign(widget, normalizeTool(widget));
    state.widgets.push(widget); state.desktopOrder.unshift({ id: `widget:${widget.id}` });
    if (placement) moveDesktopItem(state, `widget:${widget.id}`, placement.target, placement.after);
    render(); reveal(`widget:${widget.id}`);
    if (!await save()) throw new Error('未能保存组件，请重试');
    return { widget };
  }
  $('#widgetName').addEventListener('input', () => { const title = $('#widgetSelectedPreview .widget-header strong'); if (title) title.textContent = $('#widgetName').value.trim() || WIDGET_TYPES[selectedType][0]; });
  $('#widgetCity').oninput = () => { selectedCity = null; cityRequest++; $('#widgetCityResults').replaceChildren(); $('#widgetCityStatus').textContent = '点击搜索后选择城市'; };
  $('#findWidgetCity').onclick = async () => {
    const name = $('#widgetCity').value.trim(); if (name.length < 2) { $('#widgetCityStatus').textContent = '请输入至少两个字符'; return; }
    const request = ++cityRequest; $('#widgetCityStatus').textContent = '正在查找城市…'; $('#widgetCityResults').replaceChildren();
    try {
      const data = await json(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=20&language=zh&format=json`);
      if (request !== cityRequest || !dialog.open) return;
      const cities = rankCities(data.results, name);
      $('#widgetCityStatus').textContent = cities.length ? '请选择城市，并核对省份和所属地区' : '没有找到城市，请尝试英文名称';
      for (const city of cities) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = cityLabel(city);
        button.onclick = () => { selectedCity = city; $('#widgetCityStatus').textContent = `已选择：${button.textContent}`; $('#widgetCityResults').replaceChildren(); }; $('#widgetCityResults').append(button);
      }
    } catch (error) { if (request === cityRequest) $('#widgetCityStatus').textContent = error.message; }
  };
  $('#widgetForm').onsubmit = async event => {
    event.preventDefault(); const type = selectedType; const state = getState(); const existing = state.widgets.find(widget => widget.id === editingId);
    if (editingId && !existing) { $('#widgetError').textContent = '此组件已在其他标签页删除，请重新添加。'; return; }
    const widget = { ...existing, id: editingId || crypto.randomUUID(), type, name: $('#widgetName').value.trim(), text: existing?.text || '' };
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
    if (existing) Object.assign(existing, widget); else { state.widgets.push(widget); state.desktopOrder.unshift({ id: `widget:${widget.id}` }); }
    if (!existing && pendingPlacement) moveDesktopItem(state, `widget:${widget.id}`, pendingPlacement.target, pendingPlacement.after);
    close(); render(); reveal(`widget:${widget.id}`); await save();
  };
  function open(id, type = 'note', placement = null) {
    pendingPlacement = placement;
    const widget = getState().widgets.find(item => item.id === id); editingId = widget?.id || null;
    $('#widgetForm').reset(); selectedType = widget?.type || type;
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
  function card(widget, editing) {
    const content = tools.content(widget, editing) ?? (widget.type === 'note' ? `<textarea class="widget-note-input" data-note="${escape(widget.id)}" aria-label="${escape(widget.name)}内容" placeholder="记下此刻的想法…" maxlength="20000" ${editing ? 'readonly' : ''}></textarea><small class="note-status"><span data-note-state role="status">自动保存在本机</span><span data-note-count>0 字</span></small>`
      : widget.type === 'weather' ? `${weatherScene}<div class="weather-content" data-weather="${escape(widget.id)}" role="status">正在获取天气…</div><div class="weather-footer"><a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a><button data-weather-refresh="${escape(widget.id)}" aria-label="刷新天气">刷新</button></div>`
      : `<iframe title="${escape(widget.name)}" data-web-url="${escape(widget.url)}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer" loading="lazy"></iframe><div class="web-footer"><span class="web-origin" title="${escape(widget.url)}">${escape(widget.url ? new URL(widget.url).hostname : '网页工具')}</span><a href="${escape(widget.url)}" target="_blank" rel="noopener noreferrer">独立打开 ↗</a><small>无法显示？网站可能禁止嵌入</small></div>`);
    const compact = widget.type === 'weather' || (['clock', 'calendar', 'pomodoro', 'calculator'].includes(widget.type) && widget.name === WIDGET_TYPES[widget.type][0]);
    const header = compact ? '' : `<header class="widget-header" ${editing ? 'title="拖动标题栏调整位置"' : ''}><strong>${escape(widget.name)}</strong></header>`;
    return `<article class="widget-card widget-${widget.type}${compact ? ' compact-widget' : ''}" aria-label="${escape(widget.name)}小组件">${header}${content}</article>`;
  }
  function hydrate() {
    tools.hydrate();
    for (const input of document.querySelectorAll('[data-note]')) {
      const widget = getState().widgets.find(item => item.id === input.dataset.note);
      if (document.activeElement !== input) input.value = widget?.text || '';
      const status = input.nextElementSibling.querySelector('[data-note-state]');
      const count = input.nextElementSibling.querySelector('[data-note-count]');
      count.textContent = `${[...input.value].length} 字`;
      input.oninput = () => {
        const current = getState().widgets.find(item => item.id === input.dataset.note); if (!current) return;
        current.text = input.value; status.textContent = '正在保存…'; count.textContent = `${[...input.value].length} 字`;
        // Persist on each input so closing a tab cannot lose a pending debounce.
        clearTimeout(noteTimers.get(current.id));
        const promise = save();
        noteTimers.set(current.id, setTimeout(async () => { const ok = await promise; if (input.isConnected) status.textContent = ok ? '已保存到本机' : '保存失败，请重试'; }, 250));
      };
    }
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
  document.querySelector('#sitesPages').addEventListener('click', async event => {
    const edit = event.target.closest('[data-widget-edit]'), remove = event.target.closest('[data-widget-remove]'), refresh = event.target.closest('[data-weather-refresh]');
    if (edit) open(edit.dataset.widgetEdit);
    const locationSettings = event.target.closest('[data-weather-settings]');
    if (locationSettings) { open(locationSettings.dataset.weatherSettings); $('#widgetLocationMode').value = 'manual'; syncLocationMode(); $('#widgetCity').focus(); }
    if (remove) {
      const state = getState(), index = state.widgets.findIndex(widget => widget.id === remove.dataset.widgetRemove); if (index < 0) return;
      const [widget] = state.widgets.splice(index, 1); const order = state.desktopOrder.findIndex(item => item.id === `widget:${widget.id}`);
      state.desktopOrder = state.desktopOrder.filter(item => item.id !== `widget:${widget.id}`); render();
      if (await save()) {
        report(`已移除「${widget.name}」`); const undo = document.createElement('button'); undo.textContent = '撤销';
        undo.onclick = async () => { const latest = getState(); if (!latest.widgets.some(item => item.id === widget.id)) { latest.widgets.push(widget); latest.desktopOrder.splice(Math.max(0, order), 0, { id: `widget:${widget.id}` }); render(); await save(); } $('#status').hidden = true; }; $('#status').append(undo);
      }
    }
    if (refresh) { const node = refresh.closest('.widget-card').querySelector('[data-weather]'); void loadWeather(node, true); }
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
  return { open, add, previewCard, card, hydrate, activateFrames };
}
