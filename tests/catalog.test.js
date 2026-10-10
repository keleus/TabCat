import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SITE_CATALOG, CATALOG_CATEGORIES, searchCatalog, pinCatalogSite, catalogIcon } from '../lib/site-catalog.js';
import { normalizeState } from '../lib/state.js';
import { createBackup, parseBackup } from '../lib/backup.js';

test('catalog is searchable by Chinese name, alias, domain and category', () => {
  assert.equal(searchCatalog('sspai.com')[0].name, '少数派');
  assert.equal(searchCatalog('b站')[0].id, 'bilibili');
  assert.equal(searchCatalog('GITHUB')[0].id, 'github');
  assert.equal(searchCatalog('插件', 'browser')[0].builtin, 'extensions');
  assert.equal(searchCatalog('sspai', 'browser').length, 0);
  assert.equal(new Set(SITE_CATALOG.map(site => site.id)).size, SITE_CATALOG.length);
  for (const entry of SITE_CATALOG) assert.ok(CATALOG_CATEGORIES.some(([id]) => id === entry.category));
});

test('catalog pinning deduplicates aliases and allows restoring removed builtins', () => {
  const state = normalizeState({ sites: [{ id: 'custom', name: '我的少数派', url: 'https://www.sspai.com/' }] });
  assert.equal(pinCatalogSite(state, 'sspai').duplicate, true);
  const next = pinCatalogSite(state, 'builtin-history');
  assert.equal(next.site.url, 'chrome://history/');
  assert.equal(pinCatalogSite(next.state, 'builtin-history').duplicate, true);
  assert.throws(() => pinCatalogSite(state, 'chrome://flags'), /网站库/);
});

test('new builtins survive normalization and backup, without expanding the default desktop', () => {
  assert.equal(normalizeState().sites.length, 8);
  let state = normalizeState({ sites: [] });
  for (const id of ['sspai', 'builtin-downloads', 'builtin-settings']) state = pinCatalogSite(state, id).state;
  const restored = parseBackup(createBackup(state));
  assert.deepEqual(restored.sites.map(site => site.url), ['https://sspai.com/', 'chrome://downloads/', 'chrome://settings/']);
});

test('all catalog websites ship valid attributed icons, including social and AI sites', () => {
  const sources = JSON.parse(readFileSync(new URL('../public/catalog/sources.json', import.meta.url)));
  const websites = SITE_CATALOG.filter(site => !site.builtin);
  assert.equal(websites.length, 74);
  for (const site of websites) {
    if (!site.iconPath) { assert.ok(!['page-logo', 'brand-artwork', 'brand-fallback', 'hd-favicon'].includes(sources[site.id].kind)); continue; }
    assert.ok(['page-logo', 'brand-artwork', 'brand-fallback', 'hd-favicon'].includes(sources[site.id].kind));
    if (sources[site.id].kind !== 'hd-favicon') assert.doesNotMatch(sources[site.id].source, /favicon|apple-touch-icon|\.ico(?:[?#]|$)/i);
    const data = readFileSync(new URL(`../public${site.iconPath}`, import.meta.url));
    if (site.iconPath.endsWith('.svg')) {
      assert.match(data.toString(), /<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
      assert.ok(!/<script|<foreignObject|\bonload=|\bhref=/i.test(data.toString()), site.id);
    } else {
      assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', site.id);
      assert.ok(data.readUInt32BE(16) >= 16 && data.readUInt32BE(16) <= 512, site.id);
      assert.ok(data.readUInt32BE(20) >= 16 && data.readUInt32BE(20) <= 512, site.id);
    }
    assert.equal(sources[site.id].sha256, createHash('sha256').update(data).digest('hex'), site.id);
    assert.ok(sources[site.id].source.startsWith('https://'), site.id);
    assert.equal(catalogIcon(site.url), site.iconPath);
  }
  for (const [query, category, id] of [['Twitter', 'social-global', 'x'], ['小红书', 'social-cn', 'xiaohongshu'], ['深度求索', 'ai-cn', 'deepseek'], ['OpenAI', 'ai-global', 'chatgpt']]) {
    assert.equal(searchCatalog(query, category)[0].id, id);
  }
});

test('bundled icon resolution supports known aliases without matching unrelated hosts or schemes', () => {
  assert.equal(catalogIcon('https://www.twitter.com/someone'), '/catalog/x-favicon.png');
  assert.equal(catalogIcon('https://threads.net/'), '/catalog/threads-favicon.png');
  assert.equal(catalogIcon('https://mail.google.com/mail/'), '/catalog/gmail-favicon.png');
  for (const value of ['https://x.com.example.org/', 'https://unknown.example/', 'chrome://history/', '/catalog/x-favicon.png', 'not a URL']) assert.equal(catalogIcon(value), '');
});

test('crisp Sspai and JD favicons are bundled while Weibo keeps its vector header logo', () => {
  assert.equal(catalogIcon('https://sspai.com/'), '/catalog/sspai-favicon.png');
  assert.equal(catalogIcon('https://www.jd.com/'), '/catalog/jd-favicon.png');
  assert.equal(catalogIcon('https://weibo.com/'), '/catalog/weibo.svg');
});
