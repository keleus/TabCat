import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../lib/state.js';
import { syncPayload, mergeRemote, mergeFirst, encodePayload, decodePayload, packPayload, knownIcons, createSync, SYNC_META } from '../lib/sync.js';
import { iconRef, isIconRef } from '../lib/icon-refs.js';

const wallpaper = `data:image/png;base64,${'A'.repeat(4000)}`;
const inlineIcon = `data:image/png;base64,${'B'.repeat(400)}`;

test('payload leaves out the local wallpaper and inline favicons', () => {
  const state = normalizeState({ background: 'local', backgroundLocal: wallpaper, backgroundLocalName: 'me.png', sites: [{ id: 'a', name: 'A', url: 'https://a.example', favicon: inlineIcon, iconCandidates: [inlineIcon, 'https://a.example/icon.png'] }] });
  const payload = syncPayload(state);
  assert.equal('backgroundLocal' in payload, false);
  assert.equal('backgroundLocalName' in payload, false);
  assert.equal('background' in payload, false);
  assert.equal(payload.sites[0].favicon, undefined);
  assert.deepEqual(payload.sites[0].iconCandidates, ['https://a.example/icon.png']);
  assert.equal(JSON.stringify(payload).includes('data:'), false);
});

test('remote edits merge without touching this device\'s wallpaper or inline icons', () => {
  const site = { id: 'a', name: 'A', url: 'https://a.example' };
  const base = syncPayload(normalizeState({ sites: [site], background: 'bing' }));
  const current = normalizeState({ sites: [{ ...site, favicon: inlineIcon }], background: 'local', backgroundLocal: wallpaper, iconSize: 90 });
  const remote = syncPayload(normalizeState({ sites: [{ ...site, name: 'Renamed' }, { id: 'b', name: 'B', url: 'https://b.example' }], background: 'picsum', accentColor: '#123456' }));
  const merged = mergeRemote(current, base, remote);
  assert.deepEqual(merged.sites.map(item => item.name), ['Renamed', 'B']);
  assert.equal(merged.sites[0].favicon, inlineIcon);
  assert.equal(merged.background, 'local');
  assert.equal(merged.backgroundLocal, wallpaper);
  assert.equal(merged.accentColor, '#123456');
  // A local edit the remote did not touch survives.
  assert.equal(merged.iconSize, 90);
});

test('a remote device on its own local wallpaper does not reset this device\'s wallpaper', () => {
  const base = syncPayload(normalizeState({ background: 'bing' }));
  const remote = syncPayload(normalizeState({ background: 'local', backgroundLocal: wallpaper }));
  const merged = mergeRemote(normalizeState({ background: 'bing' }), base, remote);
  assert.equal(merged.background, 'bing');
});

test('first sync keeps both devices\' sites and drops duplicate addresses', () => {
  const current = normalizeState({ sites: [{ id: 'github', name: 'GitHub', url: 'https://github.com' }, { id: 'local-1', name: 'Mine', url: 'https://mine.example' }, { id: 'local-2', name: 'Dup', url: 'https://shared.example' }] });
  const remote = syncPayload(normalizeState({ sites: [{ id: 'remote-1', name: 'Shared', url: 'https://shared.example/' }, { id: 'remote-2', name: 'Theirs', url: 'https://theirs.example' }] }));
  const merged = mergeFirst(current, remote);
  // GitHub is a stock site the other devices removed, so it goes here too.
  assert.deepEqual(merged.sites.map(site => site.id).sort(), ['local-1', 'remote-1', 'remote-2']);
});

test('payload encoding round-trips and uploaded icons travel as references', async () => {
  const state = normalizeState({ sites: [{ id: 'a', name: 'A', url: 'https://a.example' }] });
  assert.deepEqual(await decodePayload(await encodePayload(syncPayload(state))), JSON.parse(JSON.stringify(syncPayload(state))));
  // Random bytes do not compress; inline, these images could never fit.
  const noisy = () => `data:image/webp;base64,${Buffer.from(crypto.getRandomValues(new Uint8Array(30000))).toString('base64')}`;
  const big = normalizeState({ sites: Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, url: `https://s${i}.example`, icon: noisy() })) });
  const packed = await packPayload(big);
  assert.ok(packed.payload.sites.every(site => isIconRef(site.icon) && site.icon.endsWith('.webp')));
  assert.equal(JSON.stringify(packed.payload).includes('data:'), false);
  assert.throws(() => syncPayload(big), /missing icon reference/);
  const huge = normalizeState({ widgets: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, type: 'note', text: Buffer.from(crypto.getRandomValues(new Uint8Array(15000))).toString('base64') })) });
  await assert.rejects(packPayload(huge), /超出浏览器同步空间/);
});

test('a remote icon reference resolves to this device\'s copy or waits for WebDAV', async () => {
  const site = { id: 'a', name: 'A', url: 'https://a.example', icon: inlineIcon };
  const current = normalizeState({ sites: [site] });
  const known = await knownIcons(current);
  const base = (await packPayload(current)).payload;
  // Another device renamed the site; the picture is the same one.
  const renamed = structuredClone(base); renamed.sites[0].name = 'Renamed';
  const merged = mergeRemote(current, base, renamed, known);
  assert.equal(merged.sites[0].name, 'Renamed');
  assert.equal(merged.sites[0].icon, inlineIcon);
  // A picture this device has never seen stays a reference until it is fetched.
  const other = await iconRef(`data:image/png;base64,${'C'.repeat(400)}`);
  const replaced = structuredClone(base); replaced.sites[0].icon = other;
  assert.equal(mergeRemote(current, base, replaced, known).sites[0].icon, other);
  assert.equal(normalizeState({ sites: [{ ...site, icon: other }] }).sites[0].icon, other);
});

function fakeArea(onSet) {
  const data = {};
  return {
    data,
    async get(keys) { const list = keys == null ? Object.keys(data) : [].concat(keys); return Object.fromEntries(list.filter(key => key in data).map(key => [key, structuredClone(data[key])])); },
    async set(items) { Object.assign(data, structuredClone(items)); onSet?.(items); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}
function device(syncArea, initial) {
  const local = fakeArea();
  if (initial) local.data.tabcat = initial;
  let queue = Promise.resolve();
  const sync = createSync({
    storage: { local, sync: syncArea }, alarms: { clear: async () => {}, create: async () => {} },
    enqueue: task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; },
    loadState: async () => normalizeState(local.data.tabcat), saveState: async state => { local.data.tabcat = state; },
  });
  return { local, sync, state: () => normalizeState(local.data.tabcat) };
}

test('two devices converge and the uploaded wallpaper stays on its device', async () => {
  const shared = fakeArea();
  const laptop = device(shared, normalizeState({ background: 'local', backgroundLocal: wallpaper, sites: [{ id: 'a', name: 'A', url: 'https://a.example' }] }));
  const desktop = device(shared, normalizeState({ sites: [{ id: 'b', name: 'B', url: 'https://b.example' }] }));
  await laptop.sync.setEnabled(true);
  assert.ok(shared.data[SYNC_META]);
  assert.equal(JSON.stringify(shared.data).includes(wallpaper.slice(30, 80)), false);
  await desktop.sync.setEnabled(true);
  assert.deepEqual(desktop.state().sites.map(site => site.id).sort(), ['a', 'b']);
  assert.equal(desktop.state().backgroundLocal, '');
  assert.notEqual(desktop.state().background, 'local');
  // The laptop receives the desktop's site on the next change event.
  await laptop.sync.reconcile();
  assert.deepEqual(laptop.state().sites.map(site => site.id).sort(), ['a', 'b']);
  assert.equal(laptop.state().backgroundLocal, wallpaper);
  // A later edit travels the other way; a rev already seen does not rewrite.
  laptop.local.data.tabcat = { ...laptop.state(), accentColor: '#abcdef' };
  await laptop.sync.reconcile();
  const rev = shared.data[SYNC_META].rev;
  await laptop.sync.reconcile();
  assert.equal(shared.data[SYNC_META].rev, rev);
  await desktop.sync.reconcile();
  assert.equal(desktop.state().accentColor, '#abcdef');
  // Disabled devices neither read nor write.
  await desktop.sync.setEnabled(false);
  laptop.local.data.tabcat = { ...laptop.state(), accentColor: '#000000' };
  await laptop.sync.reconcile(); await desktop.sync.reconcile();
  assert.equal(desktop.state().accentColor, '#abcdef');
});

test('a half-arrived revision is ignored instead of being overwritten', async () => {
  const shared = fakeArea();
  const first = device(shared, normalizeState({ sites: [{ id: 'a', name: 'A', url: 'https://a.example' }] }));
  await first.sync.setEnabled(true);
  const second = device(shared, normalizeState({ sites: [{ id: 'b', name: 'B', url: 'https://b.example' }] }));
  const meta = shared.data[SYNC_META];
  shared.data[SYNC_META] = { ...meta, hash: 'not-yet' };
  await second.sync.setEnabled(true);
  assert.equal(shared.data[SYNC_META].hash, 'not-yet');
  assert.deepEqual(second.state().sites.map(site => site.id), ['b']);
  shared.data[SYNC_META] = meta;
  await second.sync.reconcile();
  assert.deepEqual(second.state().sites.map(site => site.id).sort(), ['a', 'b']);
});

test('an uploaded icon reaches the other device as a reference and stays inline at home', async () => {
  const shared = fakeArea();
  const laptop = device(shared, normalizeState({ sites: [{ id: 'a', name: 'A', url: 'https://a.example', icon: inlineIcon }] }));
  const desktop = device(shared, normalizeState({ sites: [] }));
  await laptop.sync.setEnabled(true);
  await desktop.sync.setEnabled(true);
  const ref = await iconRef(inlineIcon);
  assert.equal(desktop.state().sites[0].icon, ref);
  assert.equal(JSON.stringify(shared.data).includes(inlineIcon.slice(30, 80)), false);
  // The desktop's pending reference does not overwrite the laptop's picture.
  await laptop.sync.reconcile();
  assert.equal(laptop.state().sites[0].icon, inlineIcon);
  // Once WebDAV delivers the picture, the payload is unchanged and not rewritten.
  const rev = shared.data[SYNC_META].rev;
  desktop.local.data.tabcat = { ...desktop.state(), sites: [{ ...desktop.state().sites[0], icon: inlineIcon }] };
  await desktop.sync.reconcile();
  assert.equal(shared.data[SYNC_META].rev, rev);
});
