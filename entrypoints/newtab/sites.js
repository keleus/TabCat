import { siteArtwork, ICON_FONTS, contrastTextColor, firstIconCharacter } from '../../lib/appearance.js';
import { siteImageScale } from '../../lib/site-catalog.js';
import { renderSiteIcon } from '../../lib/site-icons.js';
import { resizeToDataUrl } from '../../lib/image-resize.js';
import { normalizeUrl } from '../../lib/state.js';
import { isIconRef } from '../../lib/icon-refs.js';
import { $, $$, app, state, storage, showStatus, navigate, escapeHtml, clampNumber, optionalNumber } from './app.js';
import { renderAll, renderSites } from './desktop-view.js';
import { renderManagers } from './engines.js';

let editingSiteId = null;
let sitePreviewKey;
let siteIconSource = 'website';
// A picture chosen from this computer, as a small data URL, or the reference of
// one uploaded on another device that WebDAV has not delivered yet. It and the
// typed address are mutually exclusive: the address is downloaded and cached
// by the extension, while an uploaded picture travels through WebDAV.
let siteUploadedIcon = '';
let siteArtworkRefreshed = false;
let sitePreviewRequest = 0;

export function bindSites() {
  $('#siteForm').addEventListener('submit', saveSite);
  // The preview downloads the typed address, so wait for typing to pause rather
  // than requesting every half-typed URL. Typing also replaces an upload.
  let iconTimer;
  $('#siteIcon').addEventListener('input', () => {
    if ($('#siteIcon').value.trim() && siteUploadedIcon) { siteUploadedIcon = ''; updateSitePreview(); }
    clearTimeout(iconTimer); iconTimer = setTimeout(updateSitePreview, 500);
  });
  $('#uploadSiteIcon').addEventListener('click', () => $('#siteIconFile').click());
  $('#siteIconFile').addEventListener('change', uploadSiteIcon);
  $('#removeSiteIconUpload').addEventListener('click', () => { siteUploadedIcon = ''; updateSitePreview(); });
  for (const input of $$('#siteForm input')) input.addEventListener('input', () => input.setCustomValidity(''));
  for (const input of $$('#siteImageScale, #siteImageFit, #siteName, #siteColor, #siteIconText, #siteIconSize, #siteIconRadius, #siteIconTextSize, #siteIconTextWeight, #siteIconTextFont, #siteIconTextColor')) input.addEventListener('input', updateSitePreview);
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
  $('#refreshSiteIcon').addEventListener('click', () => updateSitePreview(siteIconSource === 'custom' ? 'icon' : true));
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
  $('#siteModalTitle').textContent = site ? '编辑快捷方式' : '添加网站'; $('#siteName').value = site?.name || ''; $('#siteUrl').value = site?.url || ''; siteUploadedIcon = site?.icon?.startsWith('data:') || isIconRef(site?.icon) ? site.icon : ''; $('#siteIcon').value = siteUploadedIcon ? '' : site?.icon || ''; $('#siteIconFile').value = '';
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
  const uploadedIcon = siteIconSource === 'custom' ? siteUploadedIcon : '';
  if (siteIconSource === 'custom' && !rawIcon && !uploadedIcon) { $('#siteIcon').setCustomValidity('请输入图标图片网址，或上传本地图片'); $('#siteIcon').reportValidity(); return; }
  const icon = uploadedIcon || (rawIcon ? normalizeUrl(rawIcon) : '');
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

async function uploadSiteIcon() {
  const file = $('#siteIconFile').files[0]; if (!file) return;
  const button = $('#uploadSiteIcon'); button.disabled = true;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('请选择 5 MB 以内的 PNG、JPG、WebP 或 GIF 图片');
    siteUploadedIcon = await resizeToDataUrl(file);
    $('#siteIcon').value = ''; $('#siteIcon').setCustomValidity('');
    updateSitePreview();
  } catch (error) { $('#siteIcon').setCustomValidity(error.message || '无法读取这张图片'); $('#siteIcon').reportValidity(); }
  finally { button.disabled = false; $('#siteIconFile').value = ''; }
}

// `force` is true to rediscover the website's icon, 'icon' to download the
// typed icon address again.
function updateSitePreview(force = false) {
  const refresh = force === true || force === 'icon';
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
    icon: siteIconSource === 'custom' ? siteUploadedIcon || $('#siteIcon').value.trim() : '', iconText: siteIconSource === 'text' ? ($('#siteIconText').value.trim() || firstIconCharacter($('#siteName').value) || '字') : '', color: $('#siteColor').value,
    iconSize: $('#siteIconSize').value, iconRadius: $('#siteIconRadius').value,
    iconTextSize: $('#siteIconTextSize').value, iconTextWeight: $('#siteIconTextWeight').value,
    iconTextFont: $('#siteIconTextFont').value, iconTextColor: $('#siteIconTextColor').value,
  };
  for (const button of $$('[data-icon-source]')) button.setAttribute('aria-pressed', String(button.dataset.iconSource === siteIconSource));
  $('#siteTextFields').hidden = siteIconSource !== 'text';
  $('#siteCustomFields').hidden = siteIconSource !== 'custom';
  $('#siteIcon').disabled = siteIconSource !== 'custom';
  $('#siteIcon').placeholder = siteUploadedIcon ? '正在使用上传的图片，填写网址可替换' : 'https://example.com/icon.png';
  $('#siteIconHint').textContent = siteUploadedIcon ? '上传的图片保存在本机；连接 WebDAV 后会同步到其他设备。' : '填写网址后，图片由扩展下载并缓存在本机，同步时只带上网址。';
  $('#uploadSiteIcon').textContent = siteUploadedIcon ? '更换本地图片' : '上传本地图片';
  $('#removeSiteIconUpload').hidden = !siteUploadedIcon;
  $('#siteIconText').disabled = siteIconSource !== 'text';
  $('.image-controls').hidden = siteIconSource === 'text';
  $('#sitePreview').style.cssText = iconStyles(preview);
  $('#siteImageScaleValue').textContent = `${preview.imageScale}%`;
  $('#siteImageScale').style.setProperty('--range-progress', `${(Number(preview.imageScale) - 40) / 120 * 100}%`);
  const key = JSON.stringify([siteIconSource, preview.name, preview.url, preview.builtin, preview.icon, preview.iconText, preview.favicon, preview.iconCandidates, preview.logoCandidates, preview.iconSize, preview.imageScale]);
  // Rediscovering applies to the website's icon; a typed address can be downloaded again.
  const typedAddress = siteIconSource === 'custom' && !siteUploadedIcon && Boolean($('#siteIcon').value.trim());
  $('#refreshSiteIcon').hidden = siteIconSource === 'custom' ? !typedAddress : siteIconSource !== 'website' || Boolean(preview.builtin);
  $('#refreshSiteIcon').disabled = siteIconSource === 'website' && !url;
  if (sitePreviewKey === key && !refresh) return;
  sitePreviewKey = key;
  const request = ++sitePreviewRequest;
  const status = $('#siteIconStatus');
  status.textContent = siteIconSource === 'text' ? '默认使用名称首字；字色跟随底色亮度，可在下方自定义。' : preview.builtin && !preview.icon ? '使用浏览器内置图标。' : !url && !preview.icon ? '输入网址后自动获取网站图标。' : '正在获取图标…';
  void renderSiteIcon($('#sitePreview'), preview, { refresh, discover: true }).then(() => {
    if (request !== sitePreviewRequest || siteIconSource === 'text' || (preview.builtin && !preview.icon) || (!url && !preview.icon)) return;
    const origin = $('#sitePreview').dataset.iconOrigin;
    status.textContent = !$('#sitePreview').classList.contains('has-image') ? '暂未获取到图片，使用名称首字；也可以选择单字图标。'
      : siteIconSource !== 'custom' ? '已获取网站图标，也可以切换为单字图标。'
      : origin === 'cache' ? '图片已下载并缓存到本机。'
      : origin === 'inline' ? '已使用上传的图片。'
      : isIconRef(preview.icon) ? '这张图片在其他设备上传，还没从 WebDAV 下载到本机，暂时显示网站图标。'
      : origin === 'direct' ? '图片预览已更新。'
      : '这个地址没有返回可用的图片，暂时显示网站图标。';
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
