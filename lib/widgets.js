import { WIDGET_TYPES, normalizeTool, validDate, localDate } from './widget-tools.js';
import { createWidgetTools } from './widget-tools-ui.js';
import { moveDesktopItem } from './desktop.js';
import { normalizeUrl } from './state.js';
import { WEATHER_CACHE_MS, cityLabel, rankCities, createIpLocator } from './weather.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const weatherLabel = code => code === 0 ? '晴' : code <= 3 ? '多云' : code <= 48 ? '雾' : code <= 67 ? '雨' : code <= 77 ? '雪' : code <= 82 ? '阵雨' : code <= 86 ? '阵雪' : '雷雨';
async function json(url) {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('服务暂不可用，请稍后重试');
  return response.json();
}

export function createWidgets({ getState, save, render, report, reveal }) {
  const tools = createWidgetTools({ getState, save, report });
  let editingId = null, selectedCity = null, cityRequest = 0, selectedType = 'note', pendingPlacement = null;
  const weatherCache = new Map(), weatherPending = new Map(), weatherRequests = new WeakMap(), noteTimers = new Map();
  const locateIp = createIpLocator(json);
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
    if (type === 'note') article.querySelector('textarea').value = '今天的灵感\n\n把想做的事，慢慢变成日常。';
    else if (type === 'weather') article.querySelector('.weather-content').innerHTML = '<span class="weather-city">杭州</span><strong class="weather-temperature">24°</strong><span>多云 · 湿度 65%</span><small>更新于 09:41</small>';
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
    $('#widgetSelectedPreview .widget-header strong').textContent = $('#widgetName').value;
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
    const actions = editing ? `<button data-widget-edit="${escape(widget.id)}" aria-label="编辑 ${escape(widget.name)}">设置</button><button data-widget-remove="${escape(widget.id)}" aria-label="移除 ${escape(widget.name)}">×</button>` : '';
    const content = tools.content(widget, editing) ?? (widget.type === 'note' ? `<textarea class="widget-note-input" data-note="${escape(widget.id)}" aria-label="${escape(widget.name)}内容" placeholder="记下此刻的想法…" maxlength="20000" ${editing ? 'readonly' : ''}></textarea><small class="note-status" role="status">自动保存在本机</small>`
      : widget.type === 'weather' ? `<div class="weather-content" data-weather="${escape(widget.id)}" role="status">正在获取天气…</div><div class="weather-footer"><a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a><button data-weather-refresh="${escape(widget.id)}" aria-label="刷新天气">刷新</button></div>`
      : `<iframe title="${escape(widget.name)}" data-web-url="${escape(widget.url)}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer" loading="lazy"></iframe><div class="web-footer"><span>无法显示？网站可能禁止嵌入</span><a href="${escape(widget.url)}" target="_blank" rel="noopener noreferrer">独立打开 ↗</a></div>`);
    return `<article class="widget-card widget-${widget.type}" aria-label="${escape(widget.name)}小组件"><header class="widget-header" ${editing ? 'title="拖动标题栏调整位置"' : ''}><strong>${escape(widget.name)}</strong><div>${actions}</div></header>${content}</article>`;
  }
  function hydrate() {
    tools.hydrate();
    for (const input of document.querySelectorAll('[data-note]')) {
      const widget = getState().widgets.find(item => item.id === input.dataset.note);
      if (document.activeElement !== input) input.value = widget?.text || '';
      input.oninput = () => {
        const current = getState().widgets.find(item => item.id === input.dataset.note); if (!current) return;
        current.text = input.value; input.nextElementSibling.textContent = '正在保存…';
        // Persist on each input so closing a tab cannot lose a pending debounce.
        clearTimeout(noteTimers.get(current.id));
        const promise = save();
        noteTimers.set(current.id, setTimeout(async () => { const ok = await promise; if (input.isConnected) input.nextElementSibling.textContent = ok ? '已保存到本机' : '保存失败，请重试'; }, 250));
      };
    }
    document.querySelectorAll('[data-weather]').forEach(node => { void loadWeather(node); });
  }
  function activateFrames() {
    document.querySelectorAll('.sites-page:not([inert]) iframe[data-web-url]').forEach(frame => { if (!frame.src) frame.src = frame.dataset.webUrl; });
  }
  async function loadWeather(node, force = false) {
    const widget = getState().widgets.find(item => item.id === node.dataset.weather); if (!widget) return;
    const request = (weatherRequests.get(node) || 0) + 1; weatherRequests.set(node, request);
    const currentRequest = () => node.isConnected && weatherRequests.get(node) === request;
    const automatic = widget.locationMode === 'ip';
    let location = widget;
    if (automatic) {
      node.textContent = '正在按 IP 定位城市…';
      try { location = await locateIp(force); }
      catch { if (currentRequest()) node.innerHTML = '暂时无法按 IP 定位，请点击刷新重试，或<button class="weather-location-action" data-weather-settings="' + escape(widget.id) + '">手动选择城市</button>。'; return; }
      if (!currentRequest()) return;
    }
    const key = `${location.latitude},${location.longitude}`;
    const paint = current => {
      if (!currentRequest()) return;
      node.innerHTML = `<span class="weather-city" title="${escape(location.cityLabel || location.city)}">${escape(location.city)}</span><strong class="weather-temperature">${Math.round(current.temperature_2m)}°</strong><span>${weatherLabel(current.weather_code)} · 湿度 ${escape(current.relative_humidity_2m)}%</span><small>${automatic ? 'IP 定位 · ' : ''}更新于 ${escape(current.time?.slice(11, 16))}</small>`;
    };
    const cached = weatherCache.get(key);
    if (!force && cached && Date.now() - cached.at < WEATHER_CACHE_MS) { paint(cached.current); return; }
    node.textContent = '正在获取天气…';
    try {
      if (!weatherPending.has(key)) weatherPending.set(key, json(`https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,weather_code&timezone=auto`).finally(() => weatherPending.delete(key)));
      const data = await weatherPending.get(key); const current = data.current;
      if (!Number.isFinite(current?.temperature_2m) || !Number.isFinite(current?.weather_code)) throw new Error('天气数据暂不可用');
      weatherCache.set(key, { current, at: Date.now() }); paint(current);
    } catch { if (currentRequest()) node.textContent = '暂时无法获取天气，请检查网络后点击刷新。'; }
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
  setInterval(() => { document.querySelectorAll('.sites-page:not([inert]) [data-weather]').forEach(node => { void loadWeather(node); }); }, WEATHER_CACHE_MS);
  return { open, add, previewCard, card, hydrate, activateFrames };
}
