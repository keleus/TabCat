import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBackup, inspectBackup, parseBackup } from '../lib/backup.js';
import { normalizeState } from '../lib/state.js';

const fixture = name => readFileSync(fileURLToPath(new URL(`./fixtures/imports/${name}`, import.meta.url)), 'utf8');

test('shortcut opening preferences roundtrip; iTab imports set them independently and Infinity imports leave them alone', () => {
  for (const choice of [true, false]) {
    const current = normalizeState({ shortcutOpenInNewTab: choice, openInNewTab: !choice });
    const restored = parseBackup(createBackup(current));
    assert.equal(restored.shortcutOpenInNewTab, choice);
    assert.equal(restored.openInNewTab, !choice);
    const existing = normalizeState({ shortcutOpenInNewTab: !choice, openInNewTab: !choice });
    const itab = JSON.parse(fixture('itab-config.json'));
    itab.baseConfig.open.iconBlank = choice;
    const importedItab = inspectBackup(JSON.stringify(itab), existing).state;
    assert.equal(importedItab.shortcutOpenInNewTab, choice);
    assert.equal(importedItab.openInNewTab, !choice);
    // Infinity's link behaviour is not icon appearance, so it is not imported.
    const infinity = JSON.parse(fixture('infinity-v2.json'));
    infinity.data.setting.setting.link.icon = choice;
    const importedInfinity = inspectBackup(JSON.stringify(infinity), existing).state;
    assert.equal(importedInfinity.shortcutOpenInNewTab, !choice);
    assert.equal(importedInfinity.openInNewTab, !choice);
  }
});

test('backup roundtrip preserves wallpaper, layout and custom site icon', () => {
  const state = normalizeState({ background: 'local', backgroundLocal: 'data:image/webp;base64,AAAA', backgroundLocalName: 'test.webp', searchWidth: 700, rowGap: 50 });
  state.sites.push({ id: 'custom', name: '个人网站', url: 'https://example.com/', icon: '', iconText: '我', color: '#aa6699' });
  const result = parseBackup(createBackup(state));
  assert.equal(result.backgroundLocal, state.backgroundLocal);
  assert.equal(result.searchWidth, 700);
  assert.equal(result.sites.at(-1).iconText, '我');
});

test('invalid backups cannot replace current data or inject active URLs', () => {
  assert.throws(() => parseBackup('{broken'), /JSON/);
  assert.throws(() => parseBackup('{"format":"other","state":{}}'), /TabCat/);
  const state = normalizeState();
  state.sites.push({ id: 'bad', name: 'Bad', url: 'javascript:alert(1)' });
  assert.throws(() => parseBackup(createBackup(state)), /网站/);
  assert.equal(normalizeState({ backgroundLocal: 'data:image/svg+xml;base64,AAAA', background: 'local' }).background, 'fjord');
});

test('TabCat inspection retains replacement semantics and reports stable summary fields', () => {
  const state = normalizeState({ searchWidth: 640 });
  const inspected = inspectBackup(createBackup(state), normalizeState({ searchWidth: 420 }));
  assert.equal(inspected.format, 'tabcat');
  assert.equal(inspected.summary.mode, 'replace');
  assert.equal(inspected.summary.sites.imported, state.sites.length);
  assert.equal(inspected.summary.engines.imported, state.engines.length);
  assert.deepEqual(inspected.state, parseBackup(createBackup(state)));
  assert.deepEqual(inspected.warnings, []);
});

test('Infinity v2 import applies only icon appearance and leaves layout, search, link and wallpaper settings alone', () => {
  const current = normalizeState({
    layoutColumns: 8, layoutRows: 4, columnGap: 40, rowGap: 40,
    searchRadius: 10, searchOpacity: 70, showSearch: false, shortcutOpenInNewTab: false,
    background: 'custom', backgroundUrl: 'https://example.com/bg.jpg', backgroundDim: 30, backgroundBlur: 10,
    iconSize: 100, iconOpacity: 50, showSiteNames: false,
  });
  const inspected = inspectBackup(fixture('infinity-v2.json'), current);
  const { state } = inspected;
  // Fixture: icon scale 0.5 -> 72px, radius 0.5 -> 24px = 33.33% of 72px, opacity 1 -> 100%.
  assert.deepEqual([state.iconSize, state.iconRadius, state.iconOpacity, state.showSiteNames], [72, 33.33, 100, true]);
  assert.equal(inspected.summary.settings.imported, 4);
  const imported = new Set(['sites', 'desktopOrder', 'engines', 'currentEngine', 'iconSize', 'iconRadius', 'iconOpacity', 'showSiteNames']);
  for (const key of Object.keys(current)) {
    if (!imported.has(key)) assert.deepEqual(state[key], current[key], `${key} must not be changed by an Infinity import`);
  }
  assert.equal(inspected.warnings.some(warning => warning.includes('仅导入 Infinity 的图标外观')), true);
});

test('Infinity v2 import drops icons hosted on the Infinity CDN but keeps inline and site-hosted ones', () => {
  const backup = JSON.parse(fixture('infinity-v2.json'));
  const inline = 'data:image/png;base64,AAAA';
  backup.data.site.sites[0].push(
    { uuid: 'site-inline', id: 'siteId-inline', name: '内嵌图标', target: 'https://inline.example/', type: 'web', bgType: 'image', bgImage: inline },
    { uuid: 'site-custom', id: 'siteId-custom', name: '自定义图标', target: 'https://custom.example/', type: 'web', bgType: 'image', bgImage: 'https://infinitypro-img.infinitynewtab.com/custom-icon/custom.png' },
  );
  const inspected = inspectBackup(JSON.stringify(backup), normalizeState({ sites: [] }));
  const site = name => inspected.state.sites.find(item => item.name === name);
  assert.equal(JSON.stringify(inspected.state).includes('infinitynewtab.com'), false);
  // GitHub (library icon) and the custom icon fall back to discovery from the website.
  assert.deepEqual(site('GitHub').iconCandidates, []);
  assert.deepEqual(site('自定义图标').iconCandidates, []);
  // MDN's icon is hosted by MDN itself, and an inline image needs no network request.
  assert.deepEqual(site('MDN').iconCandidates, ['https://developer.mozilla.org/favicon-48x48.cbbd161b.png']);
  assert.deepEqual(site('内嵌图标').iconCandidates, [inline]);
  assert.equal(inspected.warnings.some(warning => warning.includes('从各网站自动获取图标')), true);
});

test('Infinity v2 import can keep icon addresses as the shortcut icon for the new tab to download and cache', () => {
  const backup = JSON.parse(fixture('infinity-v2.json'));
  const inline = 'data:image/png;base64,AAAA';
  backup.data.site.sites[0].push(
    { uuid: 'site-inline', id: 'siteId-inline', name: '内嵌图标', target: 'https://inline.example/', type: 'web', bgType: 'image', bgImage: inline },
    { uuid: 'site-custom', id: 'siteId-custom', name: '自定义图标', target: 'https://custom.example/', type: 'web', bgType: 'image', bgImage: 'https://infinitypro-img.infinitynewtab.com/custom-icon/custom.png' },
  );
  const text = JSON.stringify(backup), empty = normalizeState({ sites: [] });

  const dropped = inspectBackup(text, empty);
  assert.deepEqual(dropped.summary.infinityIcons, { sites: 2, kept: false });
  assert.equal(dropped.state.sites.some(site => site.icon), false);

  const kept = inspectBackup(text, empty, { keepInfinityIcons: true });
  assert.deepEqual(kept.summary.infinityIcons, { sites: 2, kept: true });
  const site = name => kept.state.sites.find(item => item.name === name);
  assert.equal(site('GitHub').icon, 'https://infinityicon.infinitynewtab.com/user-share-icon/github.png');
  assert.equal(site('自定义图标').icon, 'https://infinitypro-img.infinitynewtab.com/custom-icon/custom.png');
  // Icons that never lived on the Infinity CDN stay candidates, not user overrides.
  assert.equal(site('MDN').icon, '');
  assert.deepEqual(site('MDN').iconCandidates, ['https://developer.mozilla.org/favicon-48x48.cbbd161b.png']);
  assert.equal(site('内嵌图标').icon, '');
  assert.deepEqual(site('内嵌图标').iconCandidates, [inline]);
  assert.equal(kept.warnings.some(warning => warning.includes('按图标地址保留')), true);
  assert.equal(kept.warnings.some(warning => warning.includes('从各网站自动获取图标')), false);
  assert.equal(dropped.warnings.some(warning => warning.includes('从各网站自动获取图标')), true);

  // Shortcuts that already exist are skipped, so they are not counted or changed.
  const existing = normalizeState({ sites: [{ id: 'mine', name: '我的 GitHub', url: 'https://github.com/' }] });
  const merged = inspectBackup(text, existing, { keepInfinityIcons: true });
  assert.deepEqual(merged.summary.infinityIcons, { sites: 1, kept: true });
  assert.equal(merged.state.sites.find(item => item.id === 'mine').icon, '');
});

test('Infinity v2 fixture imports HTTP sites and icon appearance, expands folders, and skips components', () => {
  const current = normalizeState({
    sites: [{ id: 'existing', name: '已有网站', url: 'https://existing.example/' }],
  });
  const before = structuredClone(current);
  const inspected = inspectBackup(fixture('infinity-v2.json'), current);
  assert.equal(inspected.format, 'infinity');
  assert.equal(inspected.summary.mode, 'merge');
  assert.equal(inspected.summary.foldersExpanded, 1);
  assert.equal(inspected.summary.sites.imported, 2);
  assert.equal(inspected.summary.engines.imported, 1);
  assert.equal(inspected.state.sites.some(site => site.name === '已有网站'), true);
  assert.equal(inspected.state.sites.some(site => site.name === 'MDN'), true);
  assert.equal(inspected.state.engines.find(engine => engine.name === 'MDN 搜索')?.id, inspected.state.currentEngine);
  assert.equal(inspected.state.sites.some(site => /^javascript:/i.test(site.url)), false);
  assert.equal(inspected.warnings.some(warning => warning.includes('文件夹')), true);
  assert.equal(inspected.warnings.some(warning => warning.includes('Infinity:wallpaper')), true);
  assert.deepEqual(current, before);
});

test('iTab fixture imports baseConfig and navConfig while preserving unsupported data warnings', () => {
  const inspected = inspectBackup(fixture('itab-config.json'));
  assert.equal(inspected.format, 'itab');
  assert.equal(inspected.summary.mode, 'merge');
  assert.equal(inspected.summary.foldersExpanded, 1);
  assert.equal(inspected.summary.sites.imported, 2);
  assert.equal(inspected.summary.engines.imported, 2);
  assert.equal(inspected.state.sites.some(site => site.name === 'GitHub'), true);
  assert.equal(inspected.state.sites.some(site => site.name === 'MDN'), true);
  assert.equal(inspected.state.sites.some(site => /^javascript:/i.test(site.url)), false);
  assert.equal(inspected.warnings.some(warning => warning.includes('iTab:notes')), true);
  assert.equal(inspected.warnings.some(warning => warning.includes('文件夹')), true);
  assert.equal(inspected.state.engines.find(engine => engine.name === 'DuckDuckGo')?.id, inspected.state.currentEngine);
  assert.equal(inspected.state.engines.at(-1).url.includes('%s'), true);
});

test('unknown, encrypted and oversized files are rejected before state changes', () => {
  assert.throws(() => inspectBackup('{"version":"v3","data":{}}'), /TabCat/);
  assert.throws(() => inspectBackup('{"encrypted":true,"ciphertext":"..."}'), /加密/);
  assert.throws(() => inspectBackup('x'.repeat(20 * 1024 * 1024 + 1)), /20 MB/);

  const current = normalizeState({ searchWidth: 511 });
  const before = structuredClone(current);
  const inspected = inspectBackup('{"baseConfig":{"wallpaper":{"src":"javascript:alert(1)"}},"navConfig":[{"children":[{"url":"javascript:alert(1)","name":"bad"}]}]}', current);
  assert.equal(inspected.state.sites.some(site => /^javascript:/i.test(site.url)), false);
  assert.equal(inspected.summary.sites.skipped, 1);
  assert.equal(inspected.warnings.some(warning => warning.includes('HTTP/HTTPS')), true);
  assert.deepEqual(current, before);
});

test('backup restores deletions, typography and percent radii without migrating twice', () => {
  const state = normalizeState({ iconRadiusUnit: 'percent', iconRadius: 25, iconTextSize: 38, iconTextWeight: 700, iconTextFont: 'serif', sites: [] });
  const restored = parseBackup(createBackup(state));
  assert.deepEqual(restored.sites, []); assert.equal(restored.iconRadius, 25);
  assert.equal(restored.iconTextSize, 38); assert.equal(restored.iconTextWeight, 700); assert.equal(restored.iconTextFont, 'serif');
});
