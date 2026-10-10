import { browser } from 'wxt/browser';
import { normalizeUrl } from './state.js';
import { suggestionUrl, parseSuggestions } from './search.js';
import { GALLERY_NAMES, galleryCacheKey, galleryCandidates } from './wallpapers.js';

// Keep network work outside the serialized settings-write queue.
export async function readResponse(url, maxBytes = 1024 * 1024, binary = false) {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('响应过大');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > maxBytes) throw new Error('响应过大'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return { data: binary ? data : new TextDecoder().decode(data), url: response.url, type: response.headers.get('content-type') || '' };
}

let bingPending;
async function bingWallpaper(force) {
  const { tabcatBing } = await browser.storage.local.get('tabcatBing');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  if (!force && tabcatBing?.date === date && tabcatBing.image) return tabcatBing;
  try {
    const metadata = JSON.parse((await readResponse('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN', 128 * 1024)).data).images?.[0];
    const url = new URL(metadata.url, 'https://www.bing.com');
    if (url.origin !== 'https://www.bing.com' || url.pathname !== '/th') throw new Error('壁纸地址无效');
    const { data, type } = await readResponse(url.href, 2500 * 1024, true);
    if (!/^image\/(jpeg|png|webp)(;|$)/.test(type)) throw new Error('壁纸格式无效');
    let bytes = ''; for (let i = 0; i < data.length; i += 8192) bytes += String.fromCharCode(...data.subarray(i, i + 8192));
    const result = { date, image: `data:${type.split(';')[0]};base64,${btoa(bytes)}`, title: String(metadata.title || 'Bing 每日壁纸').slice(0, 200), copyright: String(metadata.copyright || '').slice(0, 500), source: normalizeUrl(metadata.copyrightlink), url: url.href };
    await browser.storage.local.set({ tabcatBing: result }); return result;
  } catch (error) { if (tabcatBing?.image) return { ...tabcatBing, stale: true }; throw error; }
}

let galleryQueue = Promise.resolve();
async function galleryWallpaper(message) {
  if (!Object.hasOwn(GALLERY_NAMES, message.provider)) throw new Error('未知壁纸来源');
  const { tabcatGallery } = await browser.storage.local.get('tabcatGallery');
  const cached = tabcatGallery?.provider === message.provider ? tabcatGallery : null;
  const key = galleryCacheKey(message.rotation, Date.now(), String(message.session || '').slice(0, 80));
  if (!message.force && cached?.key === key && cached.image) return cached;
  try {
    const endpoint = message.provider === 'bing-gallery'
      ? 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN'
      : `https://picsum.photos/v2/list?page=${1 + Math.floor(Math.random() * 30)}&limit=30`;
    const candidates = galleryCandidates(message.provider, JSON.parse((await readResponse(endpoint, 256 * 1024)).data)).filter(item => item.id !== cached?.id);
    if (!candidates.length) throw new Error('图库暂时没有新的照片');
    const photo = candidates[Math.floor(Math.random() * candidates.length)];
    const { data, type } = await readResponse(photo.url, 1800 * 1024, true);
    if (!/^image\/(jpeg|png|webp)(;|$)/.test(type)) throw new Error('壁纸格式无效');
    let bytes = ''; for (let i = 0; i < data.length; i += 8192) bytes += String.fromCharCode(...data.subarray(i, i + 8192));
    const result = { ...photo, provider: message.provider, key, source: normalizeUrl(photo.source), image: `data:${type.split(';')[0]};base64,${btoa(bytes)}` };
    await browser.storage.local.set({ tabcatGallery: result });
    return result;
  } catch (error) {
    if (cached?.image) return { ...cached, stale: true };
    throw error;
  }
}

export async function handleNetworkMessage(message) {
  if (message.type === 'tabcat:gallery') {
    // Serialize cache updates across tabs without blocking settings writes.
    const request = galleryQueue.then(() => galleryWallpaper(message));
    galleryQueue = request.catch(() => {});
    return { wallpaper: await request };
  }
  if (message.type === 'tabcat:suggest') {
    if (typeof message.query !== 'string' || !message.query.trim() || message.query.length > 200) return { suggestions: [] };
    const url = suggestionUrl(message.provider, message.query); if (!url) return { suggestions: [] };
    return { suggestions: parseSuggestions(message.provider, (await readResponse(url, 128 * 1024)).data) };
  }
  if (message.type === 'tabcat:bing') {
    if (!bingPending) bingPending = bingWallpaper(Boolean(message.force)).finally(() => { bingPending = null; });
    return { wallpaper: await bingPending };
  }
  const url = normalizeUrl(message.url);
  if (!url) throw new Error('网页地址无效');
  const result = await readResponse(url);
  if (!/html|json|manifest/i.test(result.type)) throw new Error('网页未提供图标信息');
  return { document: result.data, url: result.url };
}
