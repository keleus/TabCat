import { browser } from 'wxt/browser';
import { WALLPAPERS } from '../../lib/appearance.js';
import { GALLERY_NAMES, galleryCacheKey } from '../../lib/wallpapers.js';
import { createWallpaperDisplay } from '../../lib/wallpaper-display.js';
import { wallpaperBrightness, wallpaperTextShadow } from '../../lib/wallpaper-contrast.js';
import { $, $$, app, state, storage, showStatus } from './app.js';
import { applyAppearance, syncControls } from './settings.js';

let bingWallpaper;
let bingLoading;
let bingCheckedAt = 0;
let galleryWallpaper;
let galleryRequest = 0;
let galleryCheckedAt = 0;
let galleryCheckedKey = '';
let galleryFailed = false;
let displayedWallpaperImage;
let displayedWallpaperBrightness = null;
const wallpaperSession = crypto.randomUUID();
const wallpaperDisplay = createWallpaperDisplay({
  fallback: WALLPAPERS[0].image,
  apply: (source, image) => {
    const layer = $('.wallpaper-layer');
    // Keep the old painted frame above the fully decoded replacement while it
    // fades out. Hidden pages commit immediately, with no animation to resume.
    let previous;
    if (!document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      previous = layer.cloneNode(false);
      previous.classList.add('wallpaper-outgoing');
      previous.style.backgroundImage = getComputedStyle(layer).backgroundImage;
    }
    document.querySelectorAll('.wallpaper-outgoing').forEach(node => node.remove());
    if (previous) layer.after(previous);
    document.documentElement.style.setProperty('--wallpaper', `url(${JSON.stringify(source)})`);
    displayedWallpaperImage = image;
    updateWallpaperBrightness();
    if (previous) previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: 'ease-out', fill: 'forwards' }).finished.then(() => previous.remove(), () => previous.remove());
    window.tabcatStartup?.saveWallpaper(source, image);
  },
});
window.addEventListener('resize', updateWallpaperBrightness);

export function setStoredWallpapers(stored) {
  bingWallpaper = stored.tabcatBing;
  galleryWallpaper = stored.tabcatGallery;
}

export function showFallbackWallpaper() { void wallpaperDisplay.show(WALLPAPERS[0].image); }

export function refreshWallpaper() {
  if (state.background === 'bing') void loadBingWallpaper();
  if (GALLERY_NAMES[state.background]) void loadGalleryWallpaper();
}

export function watchWallpapers() {
  setInterval(refreshWallpaper, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    // Do not start a new download when a tab becomes visible, or resume a fade
    // which began before it was hidden.
    if (document.hidden) document.querySelectorAll('.wallpaper-outgoing').forEach(node => node.remove());
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const bing = changes.tabcatBing?.newValue, gallery = changes.tabcatGallery?.newValue;
    if (state.background === 'bing' && bing?.image) {
      bingWallpaper = bing; bingCheckedAt = Date.now();
      $('#bingStatus').textContent = `${bing.title} · ${bing.copyright}`;
      applyAppearance();
    } else if (state.wallpaperRotation !== 'newtab' && gallery?.image && gallery.provider === state.background && gallery.key === galleryCacheKey(state.wallpaperRotation)) {
      galleryWallpaper = gallery;
      galleryCheckedKey = `${gallery.provider}:${gallery.key}`; galleryCheckedAt = Date.now(); galleryFailed = false;
      $('#galleryStatus').textContent = `${gallery.title} · ${gallery.copyright}`;
      applyAppearance();
    }
  });
}

export function bindWallpaper() {
  $('#refreshBing').addEventListener('click', () => loadBingWallpaper(true));
  $('#refreshGallery').addEventListener('click', () => loadGalleryWallpaper(true));
  $('#nextWallpaper').addEventListener('click', async () => {
    if (!GALLERY_NAMES[state.background]) state.background = state.background === 'bing' ? 'bing-gallery' : 'picsum';
    syncControls();
    await loadGalleryWallpaper(true);
    applyAppearance(); await storage.save();
  });
  $('#wallpaperChoices').addEventListener('click', async event => {
    const button = event.target.closest('[data-wallpaper]'); if (!button) return;
    state.background = button.dataset.wallpaper; syncControls(); applyAppearance(); await storage.save();
  });
  $('#uploadWallpaper').addEventListener('click', () => $('#wallpaperFile').click());
  $('#wallpaperFile').addEventListener('change', uploadWallpaper);
}

export function renderWallpaperChoices() {
  $('#wallpaperChoices').innerHTML = WALLPAPERS.map(wallpaper => `<button type="button" class="wallpaper-choice" data-wallpaper="${wallpaper.id}" aria-label="${wallpaper.name}" aria-pressed="false"><span class="wallpaper-swatch" style="background-image:url('${wallpaper.image}')"></span><span>${wallpaper.name}</span></button>`).join('');
}

// The wallpaper half of applyAppearance(): background source, effects and labels.
export function applyWallpaper() {
  const root = document.documentElement;
  root.dataset.background = state.background;
  $('#backgroundUrlField').hidden = state.background !== 'custom';
  const wallpaper = WALLPAPERS.find(item => item.id === state.background) || WALLPAPERS[0];
  if (!app.starting && state.background === 'bing') void loadBingWallpaper();
  const gallery = Boolean(GALLERY_NAMES[state.background]);
  if (!app.starting && gallery) void loadGalleryWallpaper();
  $('#bingControls').hidden = state.background !== 'bing';
  $('#galleryControls').hidden = !gallery;
  const online = state.background === 'bing' ? bingWallpaper : gallery && galleryWallpaper?.provider === state.background ? galleryWallpaper : null;
  const source = gallery || state.background === 'bing' ? online?.image : state.background === 'custom' ? state.backgroundUrl || wallpaper.image : state.background === 'local' ? state.backgroundLocal : wallpaper.image;
  void wallpaperDisplay.show(source);
  root.style.setProperty('--background-frost', state.backgroundFrost / 100);
  root.style.setProperty('--background-dim', state.backgroundDim / 100);
  root.style.setProperty('--background-blur', `${state.backgroundBlur}px`);
  const text = state.labelColor === 'auto' ? wallpaper.text : state.labelColor;
  root.style.setProperty('--home-text', text === 'dark' ? '#38444e' : '#ffffff');
  updateWallpaperTextShadow();
  $('#wallpaperName').textContent = GALLERY_NAMES[state.background] || (state.background === 'bing' ? 'Bing 每日壁纸' : state.background === 'local' ? '我的壁纸' : state.background === 'custom' ? '自定义壁纸' : wallpaper.name);
  $('#wallpaperCredit').hidden = !online?.source;
  $('#wallpaperCredit').href = online?.source || '#';
  $('#wallpaperCredit').textContent = '查看图片来源 ↗';
  $('#localWallpaperName').textContent = state.backgroundLocalName || '支持 JPG、PNG、WebP，图片仅保存在本机。';
  $$('[data-wallpaper]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.wallpaper === state.background)));
}

function updateWallpaperTextShadow() {
  const wallpaper = WALLPAPERS.find(item => item.id === state.background) || WALLPAPERS[0];
  const text = state.labelColor === 'auto' ? wallpaper.text : state.labelColor;
  document.documentElement.style.setProperty('--label-shadow', wallpaperTextShadow(text, displayedWallpaperBrightness, state.backgroundDim / 100, state.backgroundFrost / 100));
}

function updateWallpaperBrightness() {
  displayedWallpaperBrightness = displayedWallpaperImage ? wallpaperBrightness(displayedWallpaperImage, innerWidth, innerHeight) : null;
  updateWallpaperTextShadow();
}

async function uploadWallpaper() {
  const file = $('#wallpaperFile').files[0]; if (!file) return;
  const button = $('#uploadWallpaper'); button.disabled = true; button.textContent = '正在处理图片…';
  try {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('请选择 10 MB 以内的 JPG、PNG 或 WebP 图片');
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 60000000) { bitmap.close(); throw new Error('图片分辨率过大，请选择 6000 万像素以内的图片'); }
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const data = canvas.toDataURL('image/webp', .85);
    if (data.length > 3 * 1024 * 1024) throw new Error('图片压缩后仍然过大，请选择较小的图片');
    state.backgroundLocal = data; state.backgroundLocalName = file.name; state.background = 'local';
    syncControls(); applyAppearance(); if (await storage.save()) showStatus('本地壁纸已应用');
  } catch (error) { showStatus(error.message || '无法读取这张图片', true); }
  finally { button.disabled = false; button.textContent = '从电脑选择图片'; $('#wallpaperFile').value = ''; }
}

async function loadBingWallpaper(force = false) {
  if (bingLoading || (!force && Date.now() - bingCheckedAt < 60 * 60 * 1000)) return;
  bingCheckedAt = Date.now(); $('#bingStatus').textContent = '正在获取今日壁纸…';
  $('#refreshBing').disabled = true;
  bingLoading = true;
  try {
    const result = await browser.runtime.sendMessage({ type: 'tabcat:bing', force });
    if (!result?.ok) throw new Error(result?.error || '暂时无法获取 Bing 壁纸');
    bingWallpaper = result.wallpaper;
    $('#bingStatus').textContent = `${bingWallpaper.title} · ${bingWallpaper.copyright}${bingWallpaper.stale ? '（离线缓存）' : ''}`;
    if (state.background === 'bing') applyAppearance();
  } catch {
    $('#bingStatus').textContent = '暂时无法连接 Bing，显示已有壁纸，可稍后重试。';
  } finally { bingLoading = false; $('#refreshBing').disabled = false; }
}

async function loadGalleryWallpaper(force = false) {
  const provider = state.background;
  if (!GALLERY_NAMES[provider]) return;
  const rotation = state.wallpaperRotation;
  const key = `${provider}:${galleryCacheKey(rotation, Date.now(), wallpaperSession)}`;
  if (!force && galleryCheckedKey === key && (!galleryFailed || Date.now() - galleryCheckedAt < 60 * 1000)) return;
  galleryCheckedKey = key; galleryCheckedAt = Date.now();
  galleryFailed = false;
  const request = ++galleryRequest;
  const active = () => request === galleryRequest && state.background === provider;
  $('#galleryStatus').textContent = '正在加载照片…';
  $('#refreshGallery').disabled = true; $('#nextWallpaper').disabled = true;
  try {
    // The current image stays painted until the replacement is decoded.
    const result = await browser.runtime.sendMessage({ type: 'tabcat:gallery', provider, rotation, session: wallpaperSession, force });
    if (!result?.ok) throw new Error(result?.error || '暂时无法获取照片');
    if (!active()) return;
    const image = new Image(); image.src = result.wallpaper.image; await image.decode();
    if (!active()) return;
    galleryWallpaper = result.wallpaper;
    galleryFailed = Boolean(galleryWallpaper.stale);
    $('#galleryStatus').textContent = `${galleryWallpaper.title} · ${galleryWallpaper.copyright}${galleryWallpaper.stale ? '（连接失败，使用上次缓存）' : ''}`;
    applyAppearance();
  } catch {
    if (active()) { galleryFailed = true; $('#galleryStatus').textContent = '暂时无法连接图库，保留已缓存的照片或远山壁纸，可点击重试。'; }
  } finally {
    if (request === galleryRequest) { $('#refreshGallery').disabled = false; $('#nextWallpaper').disabled = false; }
  }
}
