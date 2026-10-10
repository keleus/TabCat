import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBackup, inspectBackup, parseBackup } from '../lib/backup.js';
import { normalizeState } from '../lib/state.js';

const fixture = name => readFileSync(fileURLToPath(new URL(`./fixtures/imports/${name}`, import.meta.url)), 'utf8');

test('shortcut opening preferences roundtrip and external imports affect shortcuts independently', () => {
  for (const choice of [true, false]) {
    const current = normalizeState({ shortcutOpenInNewTab: choice, openInNewTab: !choice });
    const restored = parseBackup(createBackup(current));
    assert.equal(restored.shortcutOpenInNewTab, choice);
    assert.equal(restored.openInNewTab, !choice);
    const itab = JSON.parse(fixture('itab-config.json'));
    itab.baseConfig.open.iconBlank = choice;
    const infinity = JSON.parse(fixture('infinity-v2.json'));
    infinity.data.setting.setting.link.icon = choice;
    for (const backup of [itab, infinity]) {
      const imported = inspectBackup(JSON.stringify(backup), normalizeState({ shortcutOpenInNewTab: !choice, openInNewTab: !choice })).state;
      assert.equal(imported.shortcutOpenInNewTab, choice);
      assert.equal(imported.openInNewTab, !choice);
    }
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

test('Infinity v2 fixture imports HTTP sites and settings, expands folders, and skips components', () => {
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
