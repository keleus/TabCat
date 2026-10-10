import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../lib/defaults.js';
import { normalizeUrl, normalizeState, mergeState, pinSite } from '../lib/state.js';

test('normalizing defaults again preserves shortcut data and avoids a first-save redraw', () => {
  const initial = normalizeState();
  assert.deepEqual(normalizeState(initial), initial);
  assert.deepEqual(normalizeState({ ...initial, theme: 'dark' }).sites, initial.sites);
});

test('shortcuts default to new tabs independently of search and retain saved choices', () => {
  assert.equal(normalizeState().shortcutOpenInNewTab, true);
  assert.equal(normalizeState({ openInNewTab: false }).shortcutOpenInNewTab, true);
  assert.equal(normalizeState({ shortcutOpenInNewTab: 'false' }).shortcutOpenInNewTab, true);
  const saved = normalizeState({ shortcutOpenInNewTab: false, openInNewTab: true });
  assert.equal(saved.shortcutOpenInNewTab, false);
  assert.equal(saved.openInNewTab, true);
});

test('wallpaper effects default off while saved effects and bookmark transparency remain valid', () => {
  const defaults = normalizeState();
  assert.deepEqual([defaults.backgroundBlur, defaults.backgroundDim, defaults.backgroundFrost], [0, 0, 0]);
  assert.equal(defaults.bookmarkBarTransparency, 20);
  const saved = normalizeState({ designVersion: 2, backgroundDim: 16, backgroundBlur: 12, backgroundFrost: 24, bookmarkBarTransparency: 75 });
  assert.deepEqual([saved.backgroundDim, saved.backgroundBlur, saved.backgroundFrost, saved.bookmarkBarTransparency], [16, 12, 24, 75]);
  assert.equal(normalizeState({ bookmarkBarTransparency: -50 }).bookmarkBarTransparency, 0);
  assert.equal(normalizeState({ bookmarkBarTransparency: 150 }).bookmarkBarTransparency, 100);
});

test('page logos persist safely and per-site image sizing is bounded', () => {
  const pinned = pinSite(normalizeState(), { name: 'Logo', url: 'https://logo.example/', logoCandidates: ['https://logo.example/brand.svg', 'data:image/png;base64,AAAA', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)'] }).site;
  assert.deepEqual(pinned.logoCandidates, ['https://logo.example/brand.svg', 'data:image/png;base64,AAAA']);
  const [site] = normalizeState({ sites: [{ ...pinned, imageScale: 500, imageFit: 'contain' }] }).sites;
  assert.equal(site.imageScale, 160);
  assert.equal(site.imageFit, 'contain');
  assert.deepEqual(site.logoCandidates, pinned.logoCandidates);
  const [invalid] = normalizeState({ sites: [{ ...pinned, imageScale: '', imageFit: 'url(bad)' }] }).sites;
  assert.equal(invalid.imageScale, undefined);
  assert.equal(invalid.imageFit, undefined);
});

test('URLs allow web pages and reject executable or browser-internal schemes', () => {
  assert.equal(normalizeUrl('example.com/a?q=1#part'), 'https://example.com/a?q=1#part');
  assert.equal(normalizeUrl('localhost:3000/path'), 'https://localhost:3000/path');
  for (const input of ['javascript:alert(1)', 'data:text/html,test', 'chrome://settings', 'file:///tmp/a', 'ftp://example.com', 'https://user:pass@example.com', 'not a url', 'https://']) assert.equal(normalizeUrl(input), '', input);
});

test('legacy data retains custom shortcuts, order and settings with new defaults', () => {
  const state = normalizeState({ ...DEFAULTS, iconSize: 72, sites: [...DEFAULTS.sites].reverse() });
  assert.equal(state.sites[0].id, DEFAULTS.sites.at(-1).id);
  assert.equal(state.iconSize, 72);
  assert.equal(state.theme, 'system');
  assert.equal(state.openInNewTab, false);
  assert.equal(normalizeState({ layoutColumns: 0, layoutRows: 'bad', timezone: 'bad' }).layoutRows, 2);
});

test('pinning keeps the full page URL and prevents canonical duplicates', () => {
  const { state, duplicate } = pinSite(normalizeState(), { name: 'Example', url: 'https://example.com' });
  assert.equal(duplicate, false);
  assert.equal(pinSite(state, { name: 'Again', url: 'https://example.com/' }).duplicate, true);
  assert.equal(pinSite(state, { name: 'Page', url: 'https://example.com/path?q=1#anchor' }).state.sites.at(-1).url, 'https://example.com/path?q=1#anchor');
  assert.throws(() => pinSite(state, { name: 'bad', url: 'javascript:alert(1)' }));
});

test('stale settings saves and site edits preserve popup additions', () => {
  const before = normalizeState();
  const current = pinSite(before, { name: 'Pinned elsewhere', url: 'https://example.com/' }).state;
  const after = structuredClone(before);
  after.theme = 'dark';
  after.sites.find(site => site.id === 'github').name = 'My GitHub';
  const result = mergeState(current, before, after);
  assert.equal(result.theme, 'dark');
  assert.equal(result.sites.find(site => site.id === 'github').name, 'My GitHub');
  assert.equal(result.sites.at(-1).name, 'Pinned elsewhere');
});

test('stale reorder preserves additions and does not resurrect deleted sites', () => {
  const before = normalizeState();
  const current = pinSite(before, { name: 'Example', url: 'https://example.com/' }).state;
  current.sites = current.sites.filter(site => site.id !== 'github');
  const after = structuredClone(before);
  after.sites.reverse();
  const result = mergeState(current, before, after);
  assert.equal(result.sites[0].id, DEFAULTS.sites.at(-1).id);
  assert.ok(!result.sites.some(site => site.id === 'github'));
  assert.equal(result.sites.at(-1).name, 'Example');
});

test('a stale site edit does not revert a newer ordering', () => {
  const before = normalizeState();
  const current = structuredClone(before); current.sites.reverse();
  const after = structuredClone(before); after.sites.find(site => site.id === 'github').name = 'Edited';
  const result = mergeState(current, before, after);
  assert.equal(result.sites[0].id, DEFAULTS.sites.at(-1).id);
  assert.equal(result.sites.find(site => site.id === 'github').name, 'Edited');
});

test('stock appearance upgrades without deleting sites or replacing custom values', () => {
  const old = { background: 'mist', backgroundDim: 20, iconSize: 62, iconRadius: 19, clockSize: 112, showClock: true, sites: DEFAULTS.sites };
  const migrated = normalizeState(old);
  assert.equal(migrated.background, 'fjord');
  assert.equal(migrated.showClock, false);
  assert.equal(migrated.sites.length, DEFAULTS.sites.length);
  const custom = normalizeState({ ...old, background: 'custom', backgroundUrl: 'https://example.com/pic.png', iconSize: 80, clockSize: 88 });
  assert.equal(custom.background, 'custom');
  assert.equal(custom.iconSize, 80);
  assert.equal(custom.showClock, true);
});


test('captured favicons survive storage separately from custom icons and reject unsafe sources', () => {
  const favicon = 'https://cdn.example.com/assets/brand.png';
  const pinned = pinSite(normalizeState(), { name: 'Example', url: 'https://example.com/a', favicon }).state;
  assert.equal(normalizeState(pinned).sites.at(-1).favicon, favicon);
  assert.equal(normalizeState(pinned).sites.at(-1).icon, '');
  const unsafe = pinSite(normalizeState(), { name: 'Example', url: 'https://example.com/a', favicon: 'javascript:alert(1)' });
  assert.equal(unsafe.site.favicon, undefined);
  const legacy = normalizeState({ sites: [{ id: 'legacy', name: 'Old', url: 'https://example.com', icon: favicon }] });
  assert.equal(legacy.sites.find(site => site.id === 'legacy').icon, favicon);
});

test('removed builtins and empty desktops stay removed across normalization and stale saves', () => {
  const before = normalizeState();
  const after = structuredClone(before); after.sites = after.sites.filter(site => !site.builtin);
  assert.equal(normalizeState(after).sites.some(site => site.builtin), false);
  const stale = structuredClone(before); stale.theme = 'dark';
  assert.equal(mergeState(after, before, stale).sites.some(site => site.builtin), false);
  assert.deepEqual(normalizeState({ sites: [] }).sites, []);
  assert.equal(normalizeState().sites.length, DEFAULTS.sites.length);
});

test('pixel radii migrate once using actual icon sizes and percent radii scale thereafter', () => {
  const legacy = { designVersion: 2, iconSize: 80, iconRadius: 20, sites: [
    { id: 'a', name: 'A', url: 'https://a.example', iconSize: 100, iconRadius: 30 },
    { id: 'b', name: 'B', url: 'https://b.example', iconSize: 100 },
  ] };
  const next = normalizeState(legacy);
  assert.equal(next.iconRadiusUnit, 'percent'); assert.equal(next.iconRadius, 25);
  assert.equal(next.sites[0].iconRadius, 30); assert.equal(next.sites[1].iconRadius, 20);
  assert.deepEqual(normalizeState(next), next);
  assert.equal(normalizeState({ ...next, iconSize: 120 }).iconRadius, 25);
  assert.equal(normalizeState().iconRadius, 50);
  assert.equal(normalizeState({ iconRadius: 19, iconSize: 62 }).iconRadius, 50);
});

test('text icon overrides are constrained and empty values inherit global settings', () => {
  const next = normalizeState({ iconTextSize: 999, iconTextFont: 'bad', iconTextColor: 'red', sites: [
    { id: 'a', name: 'A', url: 'https://a.example', iconTextSize: '', iconTextFont: 'bad', iconTextColor: '#00ff00', iconTextWeight: 900 },
  ] });
  assert.equal(next.iconTextSize, 72); assert.equal(next.iconTextFont, 'system');
  assert.equal(next.iconTextColor, '#ffffff'); assert.equal(next.sites[0].iconTextSize, undefined);
  assert.equal(next.sites[0].iconTextFont, undefined); assert.equal(next.sites[0].iconTextColor, '#00ff00');
  assert.equal(next.sites[0].iconTextWeight, 800);
});
