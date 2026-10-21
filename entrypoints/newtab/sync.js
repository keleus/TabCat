import { browser } from 'wxt/browser';
import { SYNC_SETTINGS } from '../../lib/sync.js';
import { WEBDAV_SETTINGS, WEBDAV_STATUS } from '../../lib/webdav.js';
import { setSyncEnabled, peekSync, syncNow, saveWebdav, syncWebdav, clearWebdav } from '../../lib/storage.js';
import { $, showStatus } from './app.js';

let busy = false;

export function bindSync() {
  const toggle = $('#syncEnabled'), button = $('#syncNow');
  toggle.addEventListener('change', () => {
    if (!toggle.checked) return run(() => setSyncEnabled(false), '已关闭同步，配置仍保留在本机');
    toggle.checked = false;
    void chooseMode();
  });
  button.addEventListener('click', () => run(syncNow));
  $('#syncModeForm').addEventListener('submit', event => {
    event.preventDefault();
    $('#syncModeModal').close();
    if (event.submitter?.value !== 'confirm') return;
    const mode = $('#syncModes').hidden ? 'local' : new FormData($('#syncModeForm')).get('syncMode');
    run(() => setSyncEnabled(true, mode), '已开启同步');
  });
  browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[SYNC_SETTINGS]) render(changes[SYNC_SETTINGS].newValue); });
  browser.storage.local.get(SYNC_SETTINGS).then(stored => render(stored[SYNC_SETTINGS]));
  bindWebdav();
}

// A second computer may not have received the other devices' copy yet, so
// switching sync on first shows what the browser has synced and lets the user
// decide how the two copies combine.
async function chooseMode() {
  let peek;
  try { peek = await peekSync(); } catch (error) { showStatus(`同步失败：${error.message}`, true); return; }
  const summary = $('#syncModeSummary'), confirm = $('#syncModeConfirm');
  $('#syncModes').hidden = peek.remote !== 'ready';
  confirm.hidden = peek.remote === 'incomplete';
  if (peek.remote === 'ready') {
    summary.textContent = `浏览器同步里已有 TabCat 的配置：${peek.sites} 个网站、${peek.widgets} 个小组件，配置修改于 ${formatTime(peek.updated)}。选择如何与本机合并：`;
    confirm.textContent = '开启同步';
    $('#syncModeForm').elements.syncMode.value = 'merge';
  } else if (peek.remote === 'incomplete') {
    summary.textContent = '正在从浏览器账号下载其他设备的配置，还没下载完整。请过一两分钟再开启。';
  } else {
    summary.textContent = '浏览器同步里还没有 TabCat 的配置，开启后会上传本机配置。如果其他电脑已经开启过同步，它的配置可能还没下载到这台电脑，建议等一两分钟后再开启，以免覆盖。';
    confirm.textContent = '上传本机配置';
  }
  $('#syncModeModal').showModal();
}

async function run(action, message) {
  busy = true; $('#syncEnabled').disabled = $('#syncNow').disabled = true;
  $('#syncStatus').classList.remove('error'); $('#syncStatus').textContent = '正在同步…';
  try {
    const { settings } = await action();
    if (message && !settings?.error) showStatus(message);
    busy = false; render(settings);
  } catch (error) {
    busy = false; showStatus(`同步失败：${error.message}`, true);
    render((await browser.storage.local.get(SYNC_SETTINGS))[SYNC_SETTINGS]);
  }
}

function render(settings = {}) {
  if (busy) return;
  const status = $('#syncStatus'), enabled = Boolean(settings?.enabled);
  $('#syncEnabled').checked = enabled; $('#syncEnabled').disabled = false;
  $('#syncNow').hidden = !enabled; $('#syncNow').disabled = false;
  status.classList.toggle('error', enabled && Boolean(settings.error));
  if (!enabled) status.textContent = '未开启。开启后自动同步配置，冲突时保留最近修改的内容；重复网址只保留一个。';
  else if (settings.error) status.textContent = `同步失败：${settings.error}。稍后会自动重试。`;
  else if (!settings.lastSync) status.textContent = '正在同步…';
  else status.textContent = `${settings.lastModified ? `配置修改：${formatTime(settings.lastModified)} · ` : ''}上次同步：${formatTime(settings.lastSync)}`;
}

const formatTime = time => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// WebDAV keeps uploaded icons; the account never leaves this device and the
// saved password is never put back into the form.
let webdavBusy = false;
let webdav = { config: {}, status: {} };

function bindWebdav() {
  $('#webdavForm').addEventListener('submit', event => {
    event.preventDefault();
    const url = $('#webdavUrl').value.trim();
    if (!url) { $('#webdavUrl').setCustomValidity('请输入 WebDAV 地址'); $('#webdavUrl').reportValidity(); return; }
    runWebdav(() => saveWebdav({ url, username: $('#webdavUser').value, password: $('#webdavPassword').value }), '已连接 WebDAV');
  });
  $('#webdavUrl').addEventListener('input', () => $('#webdavUrl').setCustomValidity(''));
  $('#webdavSync').addEventListener('click', () => runWebdav(syncWebdav));
  $('#webdavClear').addEventListener('click', () => runWebdav(clearWebdav, '已断开 WebDAV，图片仍保留在本机'));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes[WEBDAV_SETTINGS] || changes[WEBDAV_STATUS])) return;
    if (changes[WEBDAV_SETTINGS]) webdav.config = changes[WEBDAV_SETTINGS].newValue || {};
    if (changes[WEBDAV_STATUS]) webdav.status = changes[WEBDAV_STATUS].newValue || {};
    renderWebdav(Boolean(changes[WEBDAV_SETTINGS]));
  });
  browser.storage.local.get([WEBDAV_SETTINGS, WEBDAV_STATUS]).then(stored => {
    webdav = { config: stored[WEBDAV_SETTINGS] || {}, status: stored[WEBDAV_STATUS] || {} };
    renderWebdav(true);
  });
}

async function runWebdav(action, message) {
  webdavBusy = true; let failed = false;
  for (const id of ['#webdavSave', '#webdavSync', '#webdavClear']) $(id).disabled = true;
  $('#webdavStatus').classList.remove('error'); $('#webdavStatus').textContent = '正在连接…';
  try {
    await action();
    if (message) showStatus(message);
    $('#webdavPassword').value = '';
  } catch (error) {
    failed = true; $('#webdavStatus').classList.add('error'); $('#webdavStatus').textContent = error.message || 'WebDAV 连接失败';
  } finally {
    webdavBusy = false;
    const stored = await browser.storage.local.get([WEBDAV_SETTINGS, WEBDAV_STATUS]);
    webdav = { config: stored[WEBDAV_SETTINGS] || {}, status: stored[WEBDAV_STATUS] || {} };
    // A failed attempt keeps what was typed and shows why it failed.
    renderWebdav(!failed, failed);
  }
}

function renderWebdav(fillForm = false, keepStatus = false) {
  if (webdavBusy) return;
  const { config, status } = webdav, connected = Boolean(config.url);
  if (fillForm) { $('#webdavUrl').value = config.url || ''; $('#webdavUser').value = config.username || ''; }
  $('#webdavPassword').placeholder = connected && config.password ? '已保存，留空则不修改' : '建议使用网盘的应用密码';
  $('#webdavSave').textContent = connected ? '保存修改' : '连接并保存';
  $('#webdavSave').disabled = false;
  $('#webdavSync').hidden = $('#webdavClear').hidden = !connected;
  $('#webdavSync').disabled = $('#webdavClear').disabled = false;
  if (keepStatus) return;
  const element = $('#webdavStatus');
  element.classList.toggle('error', connected && Boolean(status.error));
  if (!connected) element.textContent = '未连接。上传的图标只保存在本机，其他设备会显示网站自己的图标。';
  else if (status.error) element.textContent = `同步失败：${status.error}。稍后会自动重试。`;
  else if (!status.lastSync) element.textContent = '已连接，正在同步图片…';
  else element.textContent = `上次同步：${formatTime(status.lastSync)}${status.missing ? `。还有 ${status.missing} 张图片尚未出现在 WebDAV 上，请在上传它们的设备上也连接 WebDAV` : ''}`;
}
