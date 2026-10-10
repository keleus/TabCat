import { browser } from 'wxt/browser';
import { collectTabIcons, discoverArtwork } from '../../lib/icon-discovery.js';
import { UI_ICONS } from '../../lib/icons.js';

document.querySelector('#openHome span').innerHTML = UI_ICONS.external;
import { addPinnedSite, loadState, watchState } from '../../lib/storage.js';
import { normalizeUrl } from '../../lib/state.js';

const form = document.querySelector('#pinForm');
const nameInput = document.querySelector('#siteName');
const urlInput = document.querySelector('#siteUrl');
const pinButton = document.querySelector('#pinButton');
const status = document.querySelector('#status');
let sites = [];
let busy = false;
let available = false;
let currentPageUrl = '';
let currentPageId;

function updateButton() {
  const duplicate = sites.some(site => normalizeUrl(site.url) === normalizeUrl(urlInput.value));
  pinButton.disabled = !available || busy || duplicate;
  pinButton.textContent = busy ? '正在添加…' : duplicate ? '已固定到首页 ✓' : '添加到首页';
  if (duplicate) status.textContent = '此网页已在首页，无需重复添加。';
  else if (available && !busy) status.textContent = '可以修改名称和地址后再添加。';
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  sites = (await loadState()).sites;
  if (!tab?.url || !/^https?:\/\//i.test(tab.url) || !normalizeUrl(tab.url)) {
    status.textContent = '此页面不支持添加。请在普通 HTTP/HTTPS 网页上点击扩展图标。';
    return;
  }
  available = true;
  currentPageId = tab.id;
  currentPageUrl = normalizeUrl(tab.url);
  nameInput.disabled = urlInput.disabled = false;
  nameInput.value = (tab.title || new URL(tab.url).hostname).slice(0, 80);
  urlInput.value = tab.url;
  updateButton();
  watchState(state => { sites = state.sites; updateButton(); });
}

urlInput.addEventListener('input', () => { urlInput.setCustomValidity(''); updateButton(); });
nameInput.addEventListener('input', () => nameInput.setCustomValidity(''));
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !available) return;
  if (!nameInput.value.trim()) { nameInput.setCustomValidity('请输入网站名称'); nameInput.reportValidity(); return; }
  if (!normalizeUrl(urlInput.value)) { urlInput.setCustomValidity('请输入有效的 HTTP/HTTPS 网址'); urlInput.reportValidity(); return; }
  busy = true; updateButton();
  try {
    const url = normalizeUrl(urlInput.value);
    const livePage = url === currentPageUrl ? await collectTabIcons(currentPageId) : undefined;
    const { logos: logoCandidates, icons: iconCandidates } = await discoverArtwork(url, livePage);
    const result = await addPinnedSite({ name: nameInput.value, url: urlInput.value, logoCandidates, iconCandidates });
    sites = (await loadState()).sites;
    busy = false; updateButton();
    status.textContent = result.duplicate ? '此网页已在首页，无需重复添加。' : '已添加！打开的 TabCat 首页也已同步更新。';
  } catch (error) {
    busy = false; updateButton(); status.textContent = `添加失败：${error.message}`;
  }
});

document.querySelector('#openHome').addEventListener('click', async () => {
  try { await browser.tabs.create({ url: browser.runtime.getURL('/newtab.html') }); window.close(); }
  catch (error) { status.textContent = `无法打开首页：${error.message}`; }
});

init().catch(error => { status.textContent = `读取失败：${error.message}`; });
