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
  $('#cancelImport').addEventListener('click', () => $('#importPreviewModal').close());
  $('#importPreviewModal').addEventListener('close', () => { pendingImportText = ''; $('#importData').focus(); });
}

function exportBackup() {
  const url = URL.createObjectURL(new Blob([createBackup(state)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tabcat-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup() {
  const file = $('#backupFile').files[0]; if (!file) return;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 20 MB');
    const text = await file.text();
    const result = inspectBackup(text, state);
    pendingImportText = text;
    const { summary } = result;
    const name = { tabcat: 'TabCat', infinity: 'Infinity', itab: 'iTab' }[result.format];
    $('#importSource').textContent = `${name} · ${file.name}`;
    $('#importSummary').textContent = `网站 ${summary.sites.imported} 个 · 搜索引擎 ${summary.engines.imported} 个 · 设置 ${summary.settings.imported} 项`;
    $('#importMode').textContent = summary.mode === 'replace' ? '将用这份 TabCat 备份替换当前配置。' : '保留已有网站并追加导入，重复网址自动跳过；仅覆盖可兼容的设置。';
    $('#importWarnings').replaceChildren(...result.warnings.map(warning => { const item = document.createElement('li'); item.textContent = warning; return item; }));
    $('#importWarnings').hidden = !result.warnings.length;
    $('#importPreviewModal').showModal();
  } catch (error) { showStatus(error.message || '导入失败', true); }
  finally { $('#backupFile').value = ''; }
}

async function confirmImport() {
  if (!pendingImportText) return;
  try {
    const result = inspectBackup(pendingImportText, state);
    setState(result.state); app.currentPage = 0;
    $('#importPreviewModal').close();
    populateTimezones(); syncControls(); applyAppearance(); renderAll(); updateClock();
    if (await storage.save()) showStatus(result.format === 'tabcat' ? '备份已恢复' : '兼容数据已导入');
  } catch (error) { showStatus(error.message || '导入失败', true); }
}
