import { DEFAULTS } from './defaults.js';
import { normalizeState, mergeState, normalizeUrl } from './state.js';
import { isIconRef, iconRefMap } from './icon-refs.js';

// Browser sync storage is small (100 KB, 8 KB per item), so the config is
// gzipped and split. The meta record is written in the same set() call as the
// chunks, so a reader never sees a revision without its data.
export const SYNC_META = 'tabcatSync:meta';
export const SYNC_CHUNK = 'tabcatSync:';
export const SYNC_SETTINGS = 'tabcatSyncSettings';
export const SYNC_BASE = 'tabcatSyncBase';
export const SYNC_RETRY_ALARM = 'tabcat:sync-retry';
const CHUNK_SIZE = 7800;
const MAX_CHUNKS = 12;
// Payloads of recent revisions, to find the version a remote write started from.
const HISTORY = 4;
// The uploaded wallpaper never leaves this device.
const LOCAL_ONLY = ['backgroundLocal', 'backgroundLocalName'];
const isData = value => typeof value === 'string' && value.startsWith('data:');

// Captured favicons are re-discoverable, so inline copies are left out. An
// uploaded icon travels as its content reference (see icon-refs.js); WebDAV,
// when set up, carries the picture itself. `refs` maps data URL -> reference.
export function syncPayload(state, refs = new Map()) {
  const payload = Object.fromEntries(Object.keys(DEFAULTS).filter(key => !LOCAL_ONLY.includes(key)).map(key => [key, structuredClone(state[key])]));
  if (payload.background === 'local') delete payload.background;
  payload.sites = payload.sites.map(site => {
    const next = { ...site };
    if (isData(next.favicon)) delete next.favicon;
    for (const key of ['iconCandidates', 'logoCandidates']) if (Array.isArray(next[key])) next[key] = next[key].filter(value => !isData(value));
    if (isData(next.icon)) {
      if (!refs.has(next.icon)) throw new Error('missing icon reference');
      next.icon = refs.get(next.icon);
    }
    return next;
  });
  return payload;
}

// Values the payload left out mean "unchanged", never "cleared". `known` maps
// icon reference -> data URL for the pictures this device already has; other
// references stay in the state until WebDAV delivers them.
export function mergeRemote(current, base, remote, known = new Map()) {
  const full = payload => ({ ...current, ...(base || {}), ...payload });
  const merged = mergeState(current, full(base || syncPayload(normalizeState({}))), full(remote));
  return restoreLocal(merged, current, known);
}

// First sync on a device: apply what the other devices changed from a fresh
// install, keep this device's own additions, and drop same-URL duplicates.
export function mergeFirst(current, remote, known = new Map()) {
  const fresh = syncPayload(normalizeState({}));
  const remoteUrls = new Set(remote.sites.filter(site => !site.builtin).map(site => normalizeUrl(site.url)));
  const remoteBuiltins = new Set(remote.sites.map(site => site.builtin).filter(Boolean));
  const remoteIds = new Set(remote.sites.map(site => site.id));
  const local = structuredClone(current);
  local.sites = local.sites.filter(site => remoteIds.has(site.id) || !(site.builtin ? remoteBuiltins.has(site.builtin) : remoteUrls.has(normalizeUrl(site.url))));
  return mergeRemote(normalizeState(local), fresh, remote, known);
}

function restoreLocal(merged, current, known) {
  const result = structuredClone(merged);
  for (const key of LOCAL_ONLY) result[key] = current[key];
  // A device showing its own uploaded wallpaper keeps it.
  if (current.background === 'local' && current.backgroundLocal) result.background = 'local';
  result.sites = result.sites.map(site => {
    const own = current.sites.find(item => item.id === site.id);
    const next = { ...site };
    if (isIconRef(next.icon) && known.has(next.icon)) next.icon = known.get(next.icon);
    if (own && own.url === next.url) {
      if (!next.favicon && isData(own.favicon)) next.favicon = own.favicon;
      for (const key of ['iconCandidates', 'logoCandidates']) {
        const inline = (own[key] || []).filter(isData);
        if (inline.length) next[key] = [...new Set([...(next[key] || []), ...inline])];
      }
    }
    return next;
  });
  return normalizeState(result);
}

async function transform(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function encodePayload(payload) {
  const bytes = await transform(new TextEncoder().encode(JSON.stringify(payload)), new CompressionStream('gzip'));
  let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export async function decodePayload(text) {
  const bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(await transform(bytes, new DecompressionStream('gzip'))));
}

export function splitChunks(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));
  return chunks.length <= MAX_CHUNKS ? chunks : null;
}

export async function packPayload(state) {
  const payload = syncPayload(state, await iconRefMap(state));
  const chunks = splitChunks(await encodePayload(payload));
  if (!chunks) throw new Error('配置太大，超出浏览器同步空间（约 100 KB）。可以精简备忘内容后再试');
  return { payload, chunks };
}

// Reference -> data URL for the uploaded icons in `state`.
export async function knownIcons(state) {
  return new Map([...await iconRefMap(state)].map(([data, ref]) => [ref, data]));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function digest(text) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...hash.subarray(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Chrome keeps whichever write reached the server last, so a revision may have
// replaced one this device never merged. Each revision names the revision it
// was built on (`parent`), and merging against that version keeps both sides'
// edits. A first upload (parent null) started from a fresh install, so its
// untouched defaults must not reset what other devices changed; an unknown
// parent is treated the same way. Revisions from before `parent` existed fall
// back to the last synced payload.
export function mergeIncoming(current, base, remote, known = new Map()) {
  const parent = remote.meta.parent;
  if (!base || parent === null) return mergeFirst(current, remote.payload, known);
  if (parent === undefined) return mergeRemote(current, base.payload, remote.payload, known);
  const ancestor = [base, ...(base.history || [])].find(entry => entry.rev === parent);
  return ancestor ? mergeRemote(current, ancestor.payload, remote.payload, known) : mergeFirst(current, remote.payload, known);
}

// Take every synced value from the remote; the wallpaper and inline icons
// that never leave this device stay.
export function replaceWithRemote(current, remote, known = new Map()) {
  return restoreLocal(normalizeState({ ...current, ...remote }), current, known);
}

// How the first sync on a device treats an existing remote copy.
export const ENABLE_MODES = ['merge', 'remote', 'local'];

// IO wrapper. `enqueue` serializes with every other write to the local state.
export function createSync({ storage, alarms, enqueue, loadState, saveState }) {
  let timer = null;
  const settings = async () => ({ enabled: false, ...(await storage.local.get(SYNC_SETTINGS))[SYNC_SETTINGS] });
  async function setStatus(patch) {
    const current = await settings();
    await storage.local.set({ [SYNC_SETTINGS]: { ...current, ...patch } });
  }
  async function readRemote() {
    const meta = (await storage.sync.get(SYNC_META))[SYNC_META];
    if (!meta?.chunks) return null;
    const keys = Array.from({ length: meta.chunks }, (_, i) => `${SYNC_CHUNK}${i}`);
    const values = await storage.sync.get(keys);
    const text = keys.map(key => values[key] ?? '').join('');
    // Sync may deliver keys separately. Wait for the next change event rather
    // than mistaking a half-arrived revision for an empty or corrupt one.
    if (keys.some(key => typeof values[key] !== 'string') || await digest(text) !== meta.hash) return { meta, incomplete: true };
    return { meta, payload: await decodePayload(text) };
  }
  async function writeRemote(chunks, previous, parent) {
    const items = Object.fromEntries(chunks.map((chunk, i) => [`${SYNC_CHUNK}${i}`, chunk]));
    const meta = { rev: crypto.randomUUID(), parent, chunks: chunks.length, hash: await digest(chunks.join('')), updated: Date.now() };
    await storage.sync.set({ ...items, [SYNC_META]: meta });
    const stale = Array.from({ length: Math.max(0, (previous || 0) - chunks.length) }, (_, i) => `${SYNC_CHUNK}${chunks.length + i}`);
    if (stale.length) await storage.sync.remove(stale);
    return meta;
  }
  // Pull newer remote changes into the local state, then push local changes.
  // `mode` is set only when sync is switched on (see ENABLE_MODES).
  function reconcile({ mode } = {}) {
    return enqueue(async () => {
      const config = await settings(); if (!config.enabled) return;
      await alarms.clear(SYNC_RETRY_ALARM);
      try {
        const base = mode ? null : (await storage.local.get(SYNC_BASE))[SYNC_BASE];
        const remote = await readRemote();
        if (remote?.incomplete) {
          if (mode) throw new Error('其他设备的配置还没下载完整，请稍后再试');
          return;
        }
        if (mode === 'remote' && !remote) throw new Error('浏览器同步里还没有 TabCat 的配置');
        let state = await loadState();
        if (remote && mode !== 'local' && (!base || remote.meta.rev !== base.rev)) {
          const known = await knownIcons(state);
          const merged = mode === 'remote' ? replaceWithRemote(state, remote.payload, known) : mergeIncoming(state, base, remote, known);
          if (!same(merged, state)) { state = merged; await saveState(state); }
        }
        const packed = await packPayload(state);
        let rev = remote?.meta.rev;
        if (!remote || !same(packed.payload, remote.payload)) rev = (await writeRemote(packed.chunks, remote?.meta.chunks, remote ? remote.meta.rev : null)).rev;
        const history = [remote && { rev: remote.meta.rev, payload: remote.payload }, base, ...(base?.history || [])]
          .filter(entry => entry && entry.rev !== rev).map(({ rev, payload }) => ({ rev, payload }))
          .filter((entry, i, list) => list.findIndex(other => other.rev === entry.rev) === i).slice(0, HISTORY);
        await storage.local.set({ [SYNC_BASE]: { rev, payload: packed.payload, history } });
        await setStatus({ lastSync: Date.now(), error: '' });
      } catch (error) {
        await setStatus({ error: error.message || '同步失败' });
        if (mode) throw error;
        // Quota bursts and transient failures heal on their own; an alarm
        // survives the service worker being suspended.
        await alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: 1 });
      }
    });
  }
  return {
    reconcile,
    // Typing in a note saves often; batch bursts under the hourly write quota.
    schedule() { clearTimeout(timer); timer = setTimeout(() => void reconcile(), 3000); },
    // What the browser has synced so far, for choosing how to switch sync on.
    async peek() {
      const remote = await readRemote();
      if (!remote) return { remote: 'empty' };
      if (remote.incomplete) return { remote: 'incomplete' };
      return { remote: 'ready', updated: remote.meta.updated, sites: remote.payload.sites.length, widgets: remote.payload.widgets.length };
    },
    async setEnabled(enabled, mode = 'merge') {
      if (!enabled) { await setStatus({ enabled, error: '' }); await storage.local.remove(SYNC_BASE); return; }
      if (!ENABLE_MODES.includes(mode)) throw new Error('未知的同步方式');
      await setStatus({ enabled, error: '' });
      try { await reconcile({ mode }); } catch (error) { await setStatus({ enabled: false }); throw error; }
    },
    settings,
  };
}
