import { isIconRef, iconRefFile, iconRefMap, iconImageBytes, iconFromBytes } from './icon-refs.js';

// WebDAV carries only the pictures that browser sync cannot hold: uploaded
// icons, stored as TabCat/icons/<sha256>.<ext>. Files are named by content, so
// they never change once written and devices never overwrite each other. The
// configuration itself still travels through browser sync as references.
export const WEBDAV_SETTINGS = 'tabcatWebdav';
export const WEBDAV_STATUS = 'tabcatWebdavStatus';
export const WEBDAV_UPLOADED = 'tabcatWebdavUploaded';
export const WEBDAV_RETRY_ALARM = 'tabcat:webdav-retry';
const FOLDERS = ['TabCat/', 'TabCat/icons/'];
const ICON_FOLDER = 'TabCat/icons/';
const MAX_ICON_BYTES = 1024 * 1024;

export function normalizeWebdavUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch { return ''; }
}

function statusError(response, action) {
  if (response.status === 401) return new Error('WebDAV 用户名或密码不正确（部分网盘需要使用应用密码）');
  if (response.status === 403) return new Error(`WebDAV 服务器拒绝${action}，请检查账号权限`);
  if (response.status === 404) return new Error('WebDAV 地址不存在，请检查文件夹路径');
  if (response.status === 507) return new Error('WebDAV 空间已满');
  return new Error(`WebDAV ${action}失败（HTTP ${response.status}）`);
}

export function createWebdavClient({ fetch, url, username = '', password = '' }) {
  const base = normalizeWebdavUrl(url);
  if (!base) throw new Error('请输入有效的 WebDAV 地址（http:// 或 https:// 开头）');
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const authorization = `Basic ${btoa(String.fromCharCode(...bytes))}`;
  async function request(method, path, { headers = {}, body } = {}) {
    try {
      // Never send the browser's own cookies; the account is the one entered here.
      return await fetch(new URL(path, base).href, { method, headers: { Authorization: authorization, ...headers }, body, credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    } catch { throw new Error('无法连接 WebDAV 服务器，请检查地址和网络'); }
  }
  return {
    async check() {
      const response = await request('PROPFIND', '', { headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>' });
      if (response.status !== 207 && !response.ok) throw statusError(response, '连接');
    },
    async ensureFolders() {
      for (const folder of FOLDERS) {
        const response = await request('MKCOL', folder);
        // 405 means the folder already exists.
        if (!response.ok && response.status !== 405) throw statusError(response, '创建文件夹');
      }
    },
    async put(name, data, type) {
      const response = await request('PUT', `${ICON_FOLDER}${name}`, { headers: { 'Content-Type': type }, body: data });
      if (!response.ok) throw statusError(response, '上传');
    },
    // Resolves to the file's bytes, or null when it is not there (yet).
    async get(name) {
      const response = await request('GET', `${ICON_FOLDER}${name}`);
      if (response.status === 404) return null;
      if (!response.ok) throw statusError(response, '下载');
      const data = new Uint8Array(await response.arrayBuffer());
      return data.length <= MAX_ICON_BYTES ? data : null;
    },
  };
}

// IO wrapper, run by the background worker. `enqueue` serializes with every
// other write to the local state; network work stays outside the queue.
export function createIconSync({ storage, alarms, fetch, enqueue, loadState, saveState, now = Date.now }) {
  let timer = null;
  let running = null;
  let again = false;
  const read = async key => (await storage.local.get(key))[key];
  const settings = async () => ({ url: '', username: '', password: '', ...(await read(WEBDAV_SETTINGS)) });
  const endpoint = config => `${config.url}\n${config.username}`;
  async function setStatus(patch) {
    await storage.local.set({ [WEBDAV_STATUS]: { ...(await read(WEBDAV_STATUS)), ...patch } });
  }

  async function run() {
    const config = await settings();
    if (!config.url) return;
    await alarms.clear(WEBDAV_RETRY_ALARM);
    const record = await read(WEBDAV_UPLOADED);
    // A different server or account starts over; the files are not there yet.
    const uploaded = new Set(record?.endpoint === endpoint(config) ? record.refs : []);
    const saveUploaded = () => storage.local.set({ [WEBDAV_UPLOADED]: { endpoint: endpoint(config), refs: [...uploaded] } });
    try {
      const client = createWebdavClient({ fetch, ...config });
      const state = await loadState();
      const local = [...await iconRefMap(state)].filter(([, ref]) => !uploaded.has(ref));
      if (local.length) {
        await client.ensureFolders();
        try {
          for (const [data, ref] of local) {
            const image = iconImageBytes(data);
            await client.put(iconRefFile(ref), image.bytes, image.type);
            uploaded.add(ref);
          }
        } finally { await saveUploaded(); }
      }
      // Pictures uploaded on other devices arrive as references.
      const wanted = [...new Set(state.sites.map(site => site.icon).filter(isIconRef))];
      const fetched = new Map();
      let missing = 0;
      for (const ref of wanted) {
        const data = await client.get(iconRefFile(ref));
        const image = data && await iconFromBytes(ref, data);
        if (image) { fetched.set(ref, image); uploaded.add(ref); } else missing += 1;
      }
      if (fetched.size) {
        await saveUploaded();
        await enqueue(async () => {
          const latest = await loadState();
          let changed = false;
          latest.sites = latest.sites.map(site => {
            if (!fetched.has(site.icon)) return site;
            changed = true;
            return { ...site, icon: fetched.get(site.icon) };
          });
          if (changed) await saveState(latest);
        });
      }
      await setStatus({ lastSync: now(), error: '', missing });
      // A device without WebDAV may upload its picture later; look again.
      if (missing) await alarms.create(WEBDAV_RETRY_ALARM, { delayInMinutes: 30 });
    } catch (error) {
      await setStatus({ error: error.message || 'WebDAV 同步失败' });
      await alarms.create(WEBDAV_RETRY_ALARM, { delayInMinutes: 5 });
    }
  }

  // One pass at a time; a request during a pass runs once more afterwards.
  function reconcile() {
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; await run(); } while (again);
    })().finally(() => { running = null; });
    return running;
  }

  return {
    reconcile,
    settings,
    schedule() { clearTimeout(timer); timer = setTimeout(() => void reconcile(), 5000); },
    // An empty password keeps the saved one, so the form never shows it again.
    async save({ url, username = '', password = '' }) {
      const current = await settings();
      const next = { url: normalizeWebdavUrl(url), username: String(username).trim(), password: password || (normalizeWebdavUrl(url) === current.url ? current.password : '') };
      const client = createWebdavClient({ fetch, ...next });
      await client.check();
      await client.ensureFolders();
      await storage.local.set({ [WEBDAV_SETTINGS]: next });
      await storage.local.remove(WEBDAV_STATUS);
      await reconcile();
    },
    async clear() {
      await alarms.clear(WEBDAV_RETRY_ALARM);
      await storage.local.remove([WEBDAV_SETTINGS, WEBDAV_STATUS, WEBDAV_UPLOADED]);
    },
  };
}
