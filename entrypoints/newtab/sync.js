import { browser } from 'wxt/browser';
import { SYNC_SETTINGS } from '../../lib/sync.js';
import { WEBDAV_SETTINGS, WEBDAV_STATUS } from '../../lib/webdav.js';
import { setSyncEnabled, syncNow, saveWebdav, syncWebdav, clearWebdav } from '../../lib/storage.js';
import { $, showStatus } from './app.js';

let busy = false;

export function bindSync() {
  const toggle = $('#syncEnabled'), button = $('#syncNow');
  toggle.addEventListener('change', () => run(() => setSyncEnabled(toggle.checked), toggle.checked ? '已开启同步' : '已关闭同步，配置仍保留在本机'));
  button.addEventListener('click', () => run(syncNow));
  browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[SYNC_SETTINGS]) render(changes[SYNC_SETTINGS].newValue); });
  browser.storage.local.get(SYNC_SETTINGS).then(stored => render(stored[SYNC_SETTINGS]));
  bindWebdav();
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
  if (!enabled) status.textContent = '未开启。开启后，本机和其他设备的网站会合并在一起，重复网址只保留一个。';
  else if (settings.error) status.textContent = `同步失败：${settings.error}。稍后会自动重试。`;
  else if (!settings.lastSync) status.textContent = '正在同步…';
  else status.textContent = `上次同步：${formatTime(settings.lastSync)}`;
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
