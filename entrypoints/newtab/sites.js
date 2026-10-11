import { siteArtwork, ICON_FONTS, contrastTextColor, firstIconCharacter } from '../../lib/appearance.js';
import { siteImageScale } from '../../lib/site-catalog.js';
import { renderSiteIcon } from '../../lib/site-icons.js';
import { normalizeUrl } from '../../lib/state.js';
import { $, $$, app, state, storage, showStatus, navigate, escapeHtml, clampNumber, optionalNumber } from './app.js';
import { renderAll, renderSites } from './desktop-view.js';
import { renderManagers } from './engines.js';

let editingSiteId = null;
let sitePreviewKey;
let siteIconSource = 'website';
let siteArtworkRefreshed = false;
let sitePreviewRequest = 0;

export function bindSites() {
  $('#siteForm').addEventListener('submit', saveSite);
  for (const input of $$('#siteForm input')) input.addEventListener('input', () => input.setCustomValidity(''));
  for (const input of $$('#siteImageScale, #siteImageFit, #siteName, #siteColor, #siteIconText, #siteIcon, #siteIconSize, #siteIconRadius, #siteIconTextSize, #siteIconTextWeight, #siteIconTextFont, #siteIconTextColor')) input.addEventListener('input', updateSitePreview);
  $('.icon-source-options').addEventListener('click', event => {
    const button = event.target.closest('[data-icon-source]');
    if (!button) return;
    siteIconSource = button.dataset.iconSource;
    updateSitePreview();
  });
  $('#siteIconText').addEventListener('change', () => {
    $('#siteIconText').value = firstIconCharacter($('#siteIconText').value);
    updateSitePreview();
  });
  $('#refreshSiteIcon').addEventListener('click', () => updateSitePreview(true));
  let previewTimer;
  $('#siteUrl').addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(updateSitePreview, 250); });
}

export function siteCard(site) {
  const artwork = siteArtwork(site);
  const icon = artwork.markup || escapeHtml(artwork.text || site.name[0]);
  const styles = iconStyles(site);
  return `<button class="site-card" draggable="${app.editMode}" data-site="${escapeHtml(site.id)}" title="${escapeHtml(site.name)}" aria-label="${escapeHtml(site.name)}" style="${escapeHtml(styles)}"><span class="site-icon">${icon}</span><span class="site-name">${escapeHtml(site.name)}</span></button>`;
}

function iconStyles(site) {
  const artwork = siteArtwork(site);
  return [
    `--auto-text-color:${contrastTextColor(artwork.color)}`, `--tile-color:${artwork.color}`, `--tile-text:${artwork.textColor || '#ffffff'}`,
    `--image-scale:${clampNumber(siteImageScale(site), 40, 160)}%`, `--image-fit:${site.imageFit === 'contain' ? 'contain' : 'cover'}`,
    `--symbol-scale:${clampNumber(site.imageScale || 100, 40, 160) * .44}%`,
    site.iconSize ? `--icon-size:${clampNumber(site.iconSize, 36, 128)}px` : '',
    site.iconRadius != null && site.iconRadius !== '' ? `--icon-radius:${clampNumber(site.iconRadius, 0, 50)}%` : '',
    site.labelSize ? `--site-label-size:${clampNumber(site.labelSize, 10, 22)}px` : '',
    site.iconTextSize ? `--icon-text-size:${clampNumber(site.iconTextSize, 10, 72)}px` : '',
    site.iconTextWeight ? `--icon-text-weight:${clampNumber(site.iconTextWeight, 300, 800)}` : '',
    ICON_FONTS[site.iconTextFont] ? `--icon-text-font:${ICON_FONTS[site.iconTextFont]}` : '',
    /^#[0-9a-f]{6}$/i.test(site.iconTextColor || '') ? `--icon-text-color:${site.iconTextColor}` : '',
  ].filter(Boolean).join(';');
}

export function openSite(id) {
  const site = state.sites.find(s => s.id === id); if (!site) return;
  navigate(site.url, state.shortcutOpenInNewTab);
}

export function openSiteModal(siteId = null) {
  if (!siteId) { app.siteLibrary.open(); return; }
  openCustomSiteModal(siteId);
}

export function openCustomSiteModal(siteId = null) {
  editingSiteId = siteId; const site = state.sites.find(s => s.id === siteId);
  $('#siteModalTitle').textContent = site ? '编辑快捷方式' : '添加网站'; $('#siteName').value = site?.name || ''; $('#siteUrl').value = site?.url || ''; $('#siteIcon').value = site?.icon || '';
  $('#siteIconSize').value = site?.iconSize || ''; $('#siteIconRadius').value = site?.iconRadius ?? ''; $('#siteLabelSize').value = site?.labelSize || '';
  $('#siteImageScale').value = siteImageScale(site || {}); $('#siteImageFit').value = site?.imageFit || 'cover';
  $('#siteIconText').value = site?.iconText || ''; $('#siteColor').value = siteArtwork(site || { name: 'A', url: '' }).color;
  for (const key of ['Size','Weight','Font','Color']) $(`#siteIconText${key}`).value = site?.[`iconText${key}`] || '';
  siteIconSource = site?.iconText ? 'text' : site?.icon ? 'custom' : 'website';
  sitePreviewKey = null; siteArtworkRefreshed = false;
  $('.advanced-fields').open = false; updateSitePreview();
  $('#siteUrl').readOnly = Boolean(site?.builtin);
  for (const input of $$('#siteForm input')) input.setCustomValidity('');
  $('#siteModal').showModal();
}

async function saveSite(event) {
  event.preventDefault(); if (!event.submitter || event.submitter.value === 'cancel') { $('#siteModal').close(); return; }
  const existing = state.sites.find(site => site.id === editingSiteId);
  if (editingSiteId && !existing) { showStatus('此网站已在其他标签页删除，请重新添加。', true); $('#siteModal').close(); return; }
  const name = $('#siteName').value.trim();
  const url = existing?.builtin ? existing.url : normalizeUrl($('#siteUrl').value);
  if (!name || !url) { const input = !name ? $('#siteName') : $('#siteUrl'); input.setCustomValidity(!name ? '请输入网站名称' : '请输入有效的 HTTP/HTTPS 网址'); input.reportValidity(); return; }
  if (state.sites.some(site => site.id !== editingSiteId && normalizeUrl(site.url) && normalizeUrl(site.url) === url)) { $('#siteUrl').setCustomValidity('此网址已在首页'); $('#siteUrl').reportValidity(); return; }
  const rawIcon = siteIconSource === 'custom' ? $('#siteIcon').value.trim() : '';
  if (siteIconSource === 'custom' && !rawIcon) { $('#siteIcon').setCustomValidity('请输入图标图片网址'); $('#siteIcon').reportValidity(); return; }
  const icon = rawIcon ? normalizeUrl(rawIcon) : '';
  if (rawIcon && !icon) { $('#siteIcon').setCustomValidity('请输入有效的 HTTP/HTTPS 图标地址'); $('#siteIcon').reportValidity(); return; }
  const textColor = $('#siteIconTextColor').value.trim();
  if (textColor && !/^#[0-9a-f]{6}$/i.test(textColor)) { $('#siteIconTextColor').setCustomValidity('请输入 #RRGGBB 格式的颜色，或留空跟随全局'); $('#siteIconTextColor').reportValidity(); return; }
  const appearance = {
    imageScale: optionalNumber($('#siteImageScale').value, 40, 160),
    imageFit: $('#siteImageFit').value,
    color: $('#siteColor').value,
    iconText: siteIconSource === 'text' ? ($('#siteIconText').value.trim() || firstIconCharacter(name)) : '',
    iconSize: optionalNumber($('#siteIconSize').value, 36, 128),
    iconRadius: optionalNumber($('#siteIconRadius').value, 0, 50),
    iconTextSize: optionalNumber($('#siteIconTextSize').value, 10, 72),
    iconTextWeight: optionalNumber($('#siteIconTextWeight').value, 300, 800),
    iconTextFont: $('#siteIconTextFont').value,
    iconTextColor: textColor,
    labelSize: optionalNumber($('#siteLabelSize').value, 10, 22),
  };
  if (editingSiteId) Object.assign(existing, { name, url, icon, favicon: url === existing.url && !siteArtworkRefreshed ? existing.favicon : '', iconCandidates: url === existing.url && !siteArtworkRefreshed ? existing.iconCandidates : [], logoCandidates: url === existing.url && !siteArtworkRefreshed ? existing.logoCandidates : [], ...appearance });
  else state.sites.push({ id: crypto.randomUUID(), name, url, ...(icon ? { icon } : {}), ...appearance });
  $('#siteModal').close(); $('#siteForm').reset(); editingSiteId = null; renderSites(); renderManagers(); await storage.save();
}

function updateSitePreview(force = false) {
  if (force === true) siteArtworkRefreshed = true;
  const existing = state.sites.find(site => site.id === editingSiteId);
  const url = normalizeUrl($('#siteUrl').value);
  const preview = {
    name: $('#siteName').value.trim() || 'A', url,
    builtin: existing?.builtin,
    favicon: existing?.url === url && !siteArtworkRefreshed ? existing.favicon : '',
    iconCandidates: existing?.url === url && !siteArtworkRefreshed ? existing.iconCandidates : [],
    logoCandidates: existing?.url === url && !siteArtworkRefreshed ? existing.logoCandidates : [],
    imageScale: $('#siteImageScale').value, imageFit: $('#siteImageFit').value,
    icon: siteIconSource === 'custom' ? $('#siteIcon').value.trim() : '', iconText: siteIconSource === 'text' ? ($('#siteIconText').value.trim() || firstIconCharacter($('#siteName').value) || '字') : '', color: $('#siteColor').value,
    iconSize: $('#siteIconSize').value, iconRadius: $('#siteIconRadius').value,
    iconTextSize: $('#siteIconTextSize').value, iconTextWeight: $('#siteIconTextWeight').value,
    iconTextFont: $('#siteIconTextFont').value, iconTextColor: $('#siteIconTextColor').value,
  };
  for (const button of $$('[data-icon-source]')) button.setAttribute('aria-pressed', String(button.dataset.iconSource === siteIconSource));
  $('#siteTextFields').hidden = siteIconSource !== 'text';
  $('#siteCustomFields').hidden = siteIconSource !== 'custom';
  $('#siteIcon').disabled = siteIconSource !== 'custom';
  $('#siteIconText').disabled = siteIconSource !== 'text';
  $('.image-controls').hidden = siteIconSource === 'text';
  $('#sitePreview').style.cssText = iconStyles(preview);
  $('#siteImageScaleValue').textContent = `${preview.imageScale}%`;
  $('#siteImageScale').style.setProperty('--range-progress', `${(Number(preview.imageScale) - 40) / 120 * 100}%`);
  const key = JSON.stringify([siteIconSource, preview.name, preview.url, preview.builtin, preview.icon, preview.iconText, preview.favicon, preview.iconCandidates, preview.logoCandidates, preview.iconSize, preview.imageScale]);
  $('#refreshSiteIcon').hidden = siteIconSource !== 'website' || Boolean(preview.builtin);
  $('#refreshSiteIcon').disabled = !url;
  if (sitePreviewKey === key && force !== true) return;
  sitePreviewKey = key;
  const request = ++sitePreviewRequest;
  const status = $('#siteIconStatus');
  status.textContent = siteIconSource === 'text' ? '默认使用名称首字；字色跟随底色亮度，可在下方自定义。' : preview.builtin && !preview.icon ? '使用浏览器内置图标。' : !url && !preview.icon ? '输入网址后自动获取网站图标。' : '正在获取图标…';
  void renderSiteIcon($('#sitePreview'), preview, { refresh: force === true, discover: true }).then(() => {
    if (request !== sitePreviewRequest || siteIconSource === 'text' || (preview.builtin && !preview.icon) || (!url && !preview.icon)) return;
    status.textContent = $('#sitePreview').classList.contains('has-image') ? (siteIconSource === 'custom' ? '图片预览已更新。' : '已获取网站图标，也可以切换为单字图标。') : '暂未获取到图片，使用名称首字；也可以选择单字图标。';
  });
}

export async function removeSite(id) {
  const index = state.sites.findIndex(site => site.id === id);
  const site = state.sites[index]; if (!site) return;
  const folderBefore = structuredClone(state.folders.find(folder => folder.siteIds.includes(id)));
  const orderBefore = state.desktopOrder.findIndex(item => item.id === (folderBefore ? `folder:${folderBefore.id}` : `site:${id}`));
  state.sites.splice(index, 1); renderAll(); if (!await storage.save()) return;
  showStatus(`已移除「${site.name}」`);
  const undo = document.createElement('button'); undo.textContent = '撤销';
  undo.addEventListener('click', async () => {
    if (!state.sites.some(item => item.id === site.id)) state.sites.splice(Math.min(index, state.sites.length), 0, site);
    if (folderBefore) {
      const folder = state.folders.find(item => item.id === folderBefore.id);
      if (folder) { if (!folder.siteIds.includes(id)) folder.siteIds.splice(folderBefore.siteIds.indexOf(id), 0, id); }
      else { state.folders.push({ ...folderBefore, siteIds: [id] }); state.desktopOrder.splice(Math.max(0, orderBefore), 0, { id: `folder:${folderBefore.id}` }); }
    } else state.desktopOrder.splice(Math.max(0, orderBefore), 0, { id: `site:${id}` });
    renderAll(); if (await storage.save()) $('#status').hidden = true;
  });
  $('#status').append(undo);
}
