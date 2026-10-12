import { createBackup, inspectBackup, MAX_BACKUP_BYTES } from '../../lib/backup.js';
import { $, app, state, setState, storage, showStatus } from './app.js';
import { updateClock } from './clock.js';
import { renderAll } from './desktop-view.js';
import { applyAppearance, populateTimezones, syncControls } from './settings.js';

let pendingImportText = '';

export function bindBackup() {
  $('#exportData').addEventListener('click', exportBackup);
  $('#importData').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', importBackup);
  $('#confirmImport').addEventListener('click', confirmImport);
  $('#importKeepIcons').addEventListener('change', () => { if (pendingImportText) showWarnings(inspectPending()); });
  $('#cancelImport').addEventListener('click', () => $('#importPreviewModal').close());
  $('#importPreviewModal').addEventListener('close', () => { pendingImportText = ''; $('#importData').focus(); });
}

function exportBackup() {
  const url = URL.createObjectURL(new Blob([createBackup(state)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tabcat-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Icons of an Infinity backup are fetched from the website unless the user asks
// to keep Infinity's own images, which are then downloaded and cached locally.
function inspectPending() {
  return inspectBackup(pendingImportText, state, { keepInfinityIcons: $('#importKeepIcons').checked });
}

function showWarnings(result) {
  $('#importWarnings').replaceChildren(...result.warnings.map(warning => { const item = document.createElement('li'); item.textContent = warning; return item; }));
  $('#importWarnings').hidden = !result.warnings.length;
}

async function importBackup() {
  const file = $('#backupFile').files[0]; if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 20 MB');
    const text = await file.text();
    $('#importKeepIcons').checked = false;
    pendingImportText = text;
    const result = inspectPending();
    const { summary } = result;
    const name = { tabcat: 'TabCat', infinity: 'Infinity', itab: 'iTab' }[result.format];
    $('#importSource').textContent = `${name} · ${file.name}`;
    $('#importSummary').textContent = `网站 ${summary.sites.imported} 个 · 搜索引擎 ${summary.engines.imported} 个 · 设置 ${summary.settings.imported} 项`;
    $('#importMode').textContent = summary.mode === 'replace' ? '将用这份 TabCat 备份替换当前配置。' : '保留已有网站并追加导入，重复网址自动跳过；仅覆盖可兼容的设置。';
    $('#importKeepIconsRow').hidden = !summary.infinityIcons?.sites;
    showWarnings(result);
    $('#importPreviewModal').showModal();
  } catch (error) { pendingImportText = ''; showStatus(error.message || '导入失败', true); }
  finally { $('#backupFile').value = ''; }
}

async function confirmImport() {
  if (!pendingImportText) return;
  try {
    const result = inspectPending();
    setState(result.state); app.currentPage = 0;
    $('#importPreviewModal').close();
    populateTimezones(); syncControls(); applyAppearance(); renderAll(); updateClock();
    if (await storage.save()) showStatus(result.format === 'tabcat' ? '备份已恢复' : '兼容数据已导入');
  } catch (error) { showStatus(error.message || '导入失败', true); }
}
