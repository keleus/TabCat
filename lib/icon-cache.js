// An icon entered as an address is downloaded once by the extension and kept on
// this device, so it keeps working offline or after the host removes it. Only
// the address belongs to the synced configuration, never the image itself.
export const ICON_CACHE_KEY = 'tabcatIconImages';
const MAX_ENTRIES = 150;
const MAX_CHARS = 3 * 1024 * 1024;
const RETRY_AFTER = 10 * 60 * 1000;

// Servers often label images as application/octet-stream, so trust the bytes.
export function sniffImageType(bytes) {
  const at = (offset, ...signature) => signature.every((byte, index) => bytes[offset + index] === byte);
  const ascii = (offset, text) => at(offset, ...[...text].map(char => char.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  return '';
}

// `fetchImage(url)` resolves to a data URL of the original bytes and `shrink`
// turns it into the small copy that is stored.
export function createIconCache({ storage, fetchImage, shrink, now = Date.now }) {
  let entries = null;
  const pending = new Map();
  const failed = new Map();

  async function read() {
    const saved = (await storage.local.get(ICON_CACHE_KEY))[ICON_CACHE_KEY];
    const map = new Map();
    if (saved && typeof saved === 'object') {
      for (const [url, entry] of Object.entries(saved)) {
        if (typeof entry?.data === 'string' && entry.data.startsWith('data:image/')) map.set(url, { data: entry.data, at: Number(entry.at) || 0 });
      }
    }
    return map;
  }
  async function load() { entries ||= await read(); return entries; }

  // Oldest copies go first, which also forgets icons of deleted shortcuts.
  function trim() {
    const ordered = [...entries].sort((a, b) => a[1].at - b[1].at);
    let chars = ordered.reduce((sum, [url, entry]) => sum + url.length + entry.data.length, 0);
    while (ordered.length && (ordered.length > MAX_ENTRIES || chars > MAX_CHARS)) {
      const [url, entry] = ordered.shift();
      chars -= url.length + entry.data.length;
      entries.delete(url);
    }
  }
  async function write() {
    // Another new-tab page may have stored icons since this one loaded.
    for (const [url, entry] of await read()) if (!entries.has(url)) entries.set(url, entry);
    trim();
    await storage.local.set({ [ICON_CACHE_KEY]: Object.fromEntries(entries) });
  }

  return {
    // Resolves to the stored copy, downloading it first when needed. An empty
    // string means no usable image; a failed refresh keeps the previous copy.
    async get(url, { refresh = false } = {}) {
      const map = await load();
      const known = map.get(url);
      if (known && !refresh) return known.data;
      if (!refresh && failed.get(url) > now() - RETRY_AFTER) return '';
      if (pending.has(url)) return pending.get(url);
      const task = (async () => {
        try {
          const data = await shrink(await fetchImage(url));
          if (!data) throw new Error('empty image');
          failed.delete(url);
          map.set(url, { data, at: now() });
          // A full or unavailable storage must not lose the copy just fetched.
          await write().catch(() => {});
          return data;
        } catch {
          failed.set(url, now());
          return known?.data || '';
        }
      })().finally(() => pending.delete(url));
      pending.set(url, task);
      return task;
    },
  };
}
