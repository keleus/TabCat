import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../lib/state.js';
import { syncPayload, mergeRemote, mergeFirst, encodePayload, decodePayload, packPayload, knownIcons, createSync, SYNC_META, SYNC_BASE, SYNC_RETRY_ALARM } from '../lib/sync.js';
import { iconRef, isIconRef } from '../lib/icon-refs.js';
import { createStateStorage, STATE_UPDATED } from '../lib/state-storage.js';

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
function device(syncArea, initial, { local = fakeArea(), now = Date.now } = {}) {
  if (initial) local.data.tabcat = initial;
  let queue = Promise.resolve();
  const store = createStateStorage({ storage: local, now });
  const alarms = { created: [], clear: async () => {}, async create(...args) { this.created.push(args); } };
  const sync = createSync({
    storage: { local, sync: syncArea }, alarms, now,
    enqueue: task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; },
    loadState: store.loadState, saveState: store.saveState,
  });
  return {
    local, sync, store, alarms, state: () => normalizeState(local.data.tabcat),
    async edit(patch) { const before = await store.loadState(); await store.saveLocalState(before, normalizeState({ ...before, ...patch })); },
  };
}

test('local saves timestamp real changes, remain monotonic and keep downloaded source times', async () => {
  let time = 1000;
  const own = device(fakeArea(), normalizeState({}), { now: () => time });
  await own.edit({ iconSize: 80 });
  assert.equal(own.local.data[STATE_UPDATED], 1000);
  await own.edit({ iconSize: 80 });
  assert.equal(own.local.data[STATE_UPDATED], 1000);
  await own.edit({ iconSize: 90 });
  assert.equal(own.local.data[STATE_UPDATED], 1001);
  time = 500;
  await own.edit({ iconSize: 96 });
  assert.equal(own.local.data[STATE_UPDATED], 1002);
  await own.store.saveState(normalizeState({ iconSize: 100 }), 5000);
  assert.equal(own.local.data[STATE_UPDATED], 5000);
  await own.store.saveState(own.state());
  assert.equal(own.local.data[STATE_UPDATED], 5000);
  await own.edit({ iconSize: 110 });
  assert.equal(own.local.data[STATE_UPDATED], 5001);
});

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
  await laptop.edit({ accentColor: '#abcdef' });
  await laptop.sync.reconcile();
  const rev = shared.data[SYNC_META].rev;
  await laptop.sync.reconcile();
  assert.equal(shared.data[SYNC_META].rev, rev);
  await desktop.sync.reconcile();
  assert.equal(desktop.state().accentColor, '#abcdef');
  // Disabled devices neither read nor write.
  await desktop.sync.setEnabled(false);
  await laptop.edit({ accentColor: '#000000' });
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
  // Switching sync on refuses to guess; a device already syncing waits quietly.
  await assert.rejects(second.sync.setEnabled(true), /还没下载完整/);
  assert.equal((await second.sync.settings()).enabled, false);
  assert.equal(shared.data[SYNC_META].hash, 'not-yet');
  assert.deepEqual(second.state().sites.map(site => site.id), ['b']);
  await first.sync.reconcile();
  assert.equal(shared.data[SYNC_META].hash, 'not-yet');
  assert.deepEqual(first.alarms.created.at(-1), [SYNC_RETRY_ALARM, { delayInMinutes: 1 }]);
  shared.data[SYNC_META] = meta;
  await second.sync.setEnabled(true);
  assert.deepEqual(second.state().sites.map(site => site.id).sort(), ['a', 'b']);
});

// Each device has its own copy of sync storage; Chrome keeps the last write.
function deliver(from, to) { Object.assign(to.data, structuredClone(from.data)); for (const key of Object.keys(to.data)) if (!(key in from.data)) delete to.data[key]; }

test('a new computer uploading before the old one\'s copy arrives does not reset it', async () => {
  const fresh = normalizeState({});
  const laptopArea = fakeArea(), desktopArea = fakeArea();
  const laptop = device(laptopArea, normalizeState({ ...fresh, iconSize: 96, accentColor: '#123456', sites: [...fresh.sites, { id: 'x', name: 'X', url: 'https://x.example' }] }));
  await laptop.sync.setEnabled(true);
  const desktop = device(desktopArea, normalizeState({ ...fresh, sites: [...fresh.sites, { id: 'y', name: 'Y', url: 'https://y.example' }] }));
  assert.deepEqual(await desktop.sync.peek(), { remote: 'empty' });
  await desktop.sync.setEnabled(true, 'local');
  // The desktop's later write replaced the laptop's on the server.
  deliver(desktopArea, laptopArea);
  await laptop.sync.reconcile();
  assert.equal(laptop.state().iconSize, 96);
  assert.equal(laptop.state().accentColor, '#123456');
  assert.ok(['x', 'y'].every(id => laptop.state().sites.some(site => site.id === id)));
  deliver(laptopArea, desktopArea);
  await desktop.sync.reconcile();
  assert.equal(desktop.state().iconSize, 96);
  assert.equal(desktop.state().accentColor, '#123456');
  assert.ok(['x', 'y'].every(id => desktop.state().sites.some(site => site.id === id)));
});

test('edits made on two devices at once both survive', async () => {
  const laptopArea = fakeArea(), desktopArea = fakeArea();
  const laptop = device(laptopArea, normalizeState({ sites: [{ id: 'a', name: 'A', url: 'https://a.example' }] }));
  await laptop.sync.setEnabled(true);
  deliver(laptopArea, desktopArea);
  const desktop = device(desktopArea, normalizeState({ sites: [] }));
  await desktop.sync.setEnabled(true);
  deliver(desktopArea, laptopArea);
  await laptop.sync.reconcile();
  // Both edit before either sees the other's change; the desktop writes last.
  await laptop.edit({ iconSize: 90 });
  await laptop.sync.reconcile();
  await desktop.edit({ accentColor: '#abcdef' });
  await desktop.sync.reconcile();
  deliver(desktopArea, laptopArea);
  await laptop.sync.reconcile();
  assert.equal(laptop.state().iconSize, 90);
  assert.equal(laptop.state().accentColor, '#abcdef');
  deliver(laptopArea, desktopArea);
  await desktop.sync.reconcile();
  assert.equal(desktop.state().iconSize, 90);
  assert.equal(desktop.state().accentColor, '#abcdef');
});

test('switching sync on can merge, take the remote copy, or replace it', async () => {
  const shared = fakeArea();
  const laptop = device(shared, normalizeState({ iconSize: 96, sites: [{ id: 'a', name: 'A', url: 'https://a.example' }] }));
  await laptop.sync.setEnabled(true);
  const peek = await device(shared).sync.peek();
  assert.equal(peek.remote, 'ready');
  assert.equal(peek.sites, 1);
  const own = () => normalizeState({ background: 'local', backgroundLocal: wallpaper, accentColor: '#abcdef', sites: [{ id: 'b', name: 'B', url: 'https://b.example' }] });

  const mergeArea = fakeArea(); deliver(shared, mergeArea);
  const merge = device(mergeArea, own());
  await merge.sync.setEnabled(true, 'merge');
  assert.deepEqual(merge.state().sites.map(site => site.id).sort(), ['a', 'b']);
  assert.equal(merge.state().iconSize, 96);
  assert.equal(merge.state().accentColor, '#abcdef');

  const remoteArea = fakeArea(); deliver(shared, remoteArea);
  const take = device(remoteArea, own());
  await take.sync.setEnabled(true, 'remote');
  assert.deepEqual(take.state().sites.map(site => site.id), ['a']);
  assert.equal(take.state().iconSize, 96);
  assert.equal(take.state().accentColor, normalizeState({}).accentColor);
  assert.equal(take.state().backgroundLocal, wallpaper);

  const localArea = fakeArea(); deliver(shared, localArea);
  const push = device(localArea, own());
  await push.sync.setEnabled(true, 'local');
  assert.deepEqual(push.state().sites.map(site => site.id), ['b']);
  deliver(localArea, shared);
  await laptop.sync.reconcile();
  assert.deepEqual(laptop.state().sites.map(site => site.id), ['b']);
  assert.equal(laptop.state().accentColor, '#abcdef');

  await assert.rejects(device(fakeArea(), own()).sync.setEnabled(true, 'remote'), /还没有 TabCat 的配置/);
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

for (const newer of ['local', 'remote', 'equal']) test(`concurrent conflicts prefer the ${newer} modification time and preserve independent edits`, async () => {
  let localTime = 1000, remoteTime = 1000;
  const laptopArea = fakeArea(), desktopArea = fakeArea();
  const laptop = device(laptopArea, normalizeState({}), { now: () => localTime });
  await laptop.sync.setEnabled(true);
  deliver(laptopArea, desktopArea);
  const desktop = device(desktopArea, normalizeState({}), { now: () => remoteTime });
  await desktop.sync.setEnabled(true, 'remote');

  localTime = newer === 'local' ? 3000 : 2000;
  remoteTime = newer === 'remote' ? 3000 : 2000;
  await laptop.edit({ iconSize: 96, accentColor: '#abcdef' });
  await desktop.edit({ iconSize: 80, rowGap: 50 });
  await desktop.sync.reconcile();
  deliver(desktopArea, laptopArea);
  localTime = 10000; // A delayed upload is not a new configuration edit.
  await laptop.sync.reconcile();
  const expectedSize = newer === 'local' ? 96 : 80;
  const expectedTime = newer === 'equal' ? 2000 : 3000;
  assert.equal(laptop.state().iconSize, expectedSize);
  assert.equal(laptop.state().accentColor, '#abcdef');
  assert.equal(laptop.state().rowGap, 50);
  assert.equal(laptopArea.data[SYNC_META].updated, expectedTime);
  assert.equal(laptop.local.data[STATE_UPDATED], expectedTime);
  assert.equal((await laptop.sync.settings()).lastSync, 10000);
  assert.equal((await laptop.sync.settings()).lastModified, expectedTime);

  const rev = laptopArea.data[SYNC_META].rev;
  deliver(laptopArea, desktopArea);
  remoteTime = 20000;
  await desktop.sync.reconcile();
  assert.deepEqual(desktop.state(), laptop.state());
  assert.equal(desktop.local.data[STATE_UPDATED], expectedTime);
  assert.equal(desktopArea.data[SYNC_META].rev, rev);
});

test('a delayed older concurrent edit still contributes changes after the newer edit was uploaded', async () => {
  let localTime = 1000, remoteTime = 1000;
  const laptopArea = fakeArea(), desktopArea = fakeArea();
  const laptop = device(laptopArea, normalizeState({}), { now: () => localTime });
  await laptop.sync.setEnabled(true);
  deliver(laptopArea, desktopArea);
  const desktop = device(desktopArea, normalizeState({}), { now: () => remoteTime });
  await desktop.sync.setEnabled(true, 'remote');
  remoteTime = 2000;
  await desktop.edit({ iconSize: 80, accentColor: '#abcdef' });
  await desktop.sync.reconcile();
  localTime = 3000;
  await laptop.edit({ iconSize: 96 });
  await laptop.sync.reconcile();
  deliver(desktopArea, laptopArea);
  localTime = 10000;
  await laptop.sync.reconcile();
  assert.equal(laptop.state().iconSize, 96);
  assert.equal(laptop.state().accentColor, '#abcdef');
  assert.equal(laptopArea.data[SYNC_META].updated, 3000);
  deliver(laptopArea, desktopArea);
  await desktop.sync.reconcile();
  assert.deepEqual(desktop.state(), laptop.state());
});

test('older cloud backups cannot restore deleted sites or reset settings after a worker restart', async () => {
  let time = 1000;
  const shared = fakeArea();
  const first = device(shared, normalizeState({ sites: [{ id: 'a', name: 'A', url: 'https://a.example' }] }), { now: () => time });
  await first.sync.setEnabled(true);
  const old = fakeArea(); deliver(shared, old);
  time = 2000;
  await first.edit({ sites: [], iconSize: 96 });
  await first.sync.reconcile();
  time = 10000;
  const restarted = device(shared, undefined, { local: first.local, now: () => time });
  for (const known of [true, false]) {
    deliver(old, shared);
    if (!known) shared.data[SYNC_META] = { ...shared.data[SYNC_META], rev: 'unknown-old-revision', parent: 'unknown-parent' };
    await restarted.sync.reconcile();
    assert.deepEqual(restarted.state().sites, []);
    assert.equal(restarted.state().iconSize, 96);
    assert.equal(shared.data[SYNC_META].updated, 2000);
    assert.equal(restarted.local.data[STATE_UPDATED], 2000);
    assert.equal((await restarted.sync.settings()).error, '');
  }
});

test('failed uploads keep the edit time across retries and worker restarts', async () => {
  let time = 1000;
  const shared = fakeArea();
  const first = device(shared, normalizeState({}), { now: () => time });
  await first.sync.setEnabled(true);
  time = 2000;
  await first.edit({ iconSize: 96 });
  const set = shared.set;
  shared.set = async () => { throw new Error('QUOTA_BYTES'); };
  time = 10000;
  await first.sync.reconcile();
  assert.equal(first.local.data[STATE_UPDATED], 2000);
  assert.match((await first.sync.settings()).error, /QUOTA_BYTES/);
  assert.deepEqual(first.alarms.created.at(-1), [SYNC_RETRY_ALARM, { delayInMinutes: 1 }]);
  shared.set = set;
  const restarted = device(shared, undefined, { local: first.local, now: () => time });
  await restarted.sync.reconcile();
  assert.equal(shared.data[SYNC_META].updated, 2000);
  assert.equal((await restarted.sync.settings()).error, '');
  const copy = device(shared, normalizeState({}));
  await copy.sync.setEnabled(true, 'remote');
  assert.equal(copy.state().iconSize, 96);
});

test('legacy local changes without modification metadata migrate before merging an older backup', async () => {
  let time = 1000;
  const laptopArea = fakeArea(), desktopArea = fakeArea();
  const laptop = device(laptopArea, normalizeState({}), { now: () => time });
  await laptop.sync.setEnabled(true);
  deliver(laptopArea, desktopArea);
  const desktop = device(desktopArea, normalizeState({}), { now: () => 1500 });
  await desktop.sync.setEnabled(true, 'remote');
  await desktop.edit({ iconSize: 80, accentColor: '#abcdef' });
  await desktop.sync.reconcile();
  delete laptop.local.data[STATE_UPDATED];
  delete laptop.local.data[SYNC_BASE].updated;
  laptop.local.data.tabcat = { ...laptop.state(), iconSize: 96 };
  time = 2000;
  deliver(desktopArea, laptopArea);
  await laptop.sync.reconcile();
  assert.equal(laptop.state().iconSize, 96);
  assert.equal(laptop.state().accentColor, '#abcdef');
  assert.equal(laptopArea.data[SYNC_META].updated, 2000);
});

test('explicit local and remote replacement choices still override modification times', async () => {
  const shared = fakeArea();
  const remote = device(shared, normalizeState({ iconSize: 96 }), { now: () => 10000 });
  await remote.sync.setEnabled(true);
  const local = device(shared, normalizeState({ iconSize: 80 }), { now: () => 1000 });
  await local.edit({ iconSize: 90 });
  await local.sync.setEnabled(true, 'local');
  assert.equal(shared.data[SYNC_META].updated, 10001);
  await remote.sync.reconcile();
  assert.equal(remote.state().iconSize, 90);
  await remote.edit({ iconSize: 100 });
  await remote.sync.setEnabled(true, 'remote');
  assert.equal(remote.state().iconSize, 90);
  assert.equal(remote.local.data[STATE_UPDATED], 10001);
});

for (const localTime of [1000, 3000]) test(`first merge chooses the newer configuration and deduplicates URLs (local time ${localTime})`, async () => {
  const shared = fakeArea();
  const cloud = device(shared, normalizeState({ iconSize: 80, sites: [
    { id: 'cloud', name: 'Cloud name', url: 'https://shared.example' },
    { id: 'cloud-only', name: 'Cloud only', url: 'https://cloud.example' },
  ] }), { now: () => 2000 });
  await cloud.sync.setEnabled(true);
  const local = device(shared, normalizeState({ sites: [
    { id: 'local', name: 'Local name', url: 'https://shared.example/' },
    { id: 'local-only', name: 'Local only', url: 'https://local.example' },
  ] }), { now: () => localTime });
  await local.edit({ iconSize: 96 });
  await local.sync.setEnabled(true, 'merge');
  assert.equal(local.state().iconSize, localTime > 2000 ? 96 : 80);
  assert.equal(local.state().sites.find(site => site.url === 'https://shared.example/').name, localTime > 2000 ? 'Local name' : 'Cloud name');
  assert.equal(local.state().sites.length, 3);
  assert.equal(shared.data[SYNC_META].updated, Math.max(localTime, 2000));
});

test('resolving a local icon does not override a newer remote icon during a newer local settings edit', async () => {
  let localTime = 1000, remoteTime = 1000;
  const laptopArea = fakeArea(), desktopArea = fakeArea();
  const laptop = device(laptopArea, normalizeState({ sites: [{ id: 'a', name: 'A', url: 'https://a.example', icon: inlineIcon }] }), { now: () => localTime });
  await laptop.sync.setEnabled(true);
  deliver(laptopArea, desktopArea);
  const desktop = device(desktopArea, normalizeState({}), { now: () => remoteTime });
  await desktop.sync.setEnabled(true, 'remote');
  remoteTime = 2000;
  const icon = `data:image/png;base64,${'C'.repeat(400)}`;
  await desktop.edit({ sites: [{ ...desktop.state().sites[0], icon }] });
  await desktop.sync.reconcile();
  localTime = 3000;
  await laptop.edit({ accentColor: '#abcdef' });
  deliver(desktopArea, laptopArea);
  await laptop.sync.reconcile();
  assert.equal(laptop.state().sites[0].icon, await iconRef(icon));
  assert.equal(laptop.state().accentColor, '#abcdef');
  assert.equal(laptopArea.data[SYNC_META].updated, 3000);
});
