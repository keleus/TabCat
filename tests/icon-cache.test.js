import test from 'node:test';
import assert from 'node:assert/strict';
import { createIconCache, sniffImageType, ICON_CACHE_KEY } from '../lib/icon-cache.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    local: {
      async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
      async set(values) { Object.assign(data, structuredClone(values)); },
    },
  };
}
const image = label => `data:image/webp;base64,${label}`;

test('image types are detected from the bytes, not from the server label', () => {
  const bytes = (...values) => Uint8Array.from(values);
  assert.equal(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d)), 'image/png');
  assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImageType(new TextEncoder().encode('GIF89a')), 'image/gif');
  assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageType(bytes(0, 0, 1, 0, 1, 0)), 'image/x-icon');
  assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), '');
  assert.equal(sniffImageType(new TextEncoder().encode('<!doctype html>')), '');
  assert.equal(sniffImageType(new Uint8Array()), '');
});

test('an address is downloaded once, shrunk, stored and then served without the network', async () => {
  const storage = fakeStorage(), downloads = [];
  const cache = createIconCache({ storage, fetchImage: async url => { downloads.push(url); return image('raw'); }, shrink: async data => `${data}-small` });
  assert.equal(await cache.get('https://a.example/icon.png'), image('raw') + '-small');
  assert.equal(await cache.get('https://a.example/icon.png'), image('raw') + '-small');
  assert.deepEqual(downloads, ['https://a.example/icon.png']);
  assert.equal(storage.data[ICON_CACHE_KEY]['https://a.example/icon.png'].data, image('raw') + '-small');
  // A new page starts from what is stored.
  const next = createIconCache({ storage, fetchImage: async () => assert.fail('must not download'), shrink: async data => data });
  assert.equal(await next.get('https://a.example/icon.png'), image('raw') + '-small');
});

test('simultaneous requests for one address share a single download', async () => {
  let downloads = 0;
  const cache = createIconCache({ storage: fakeStorage(), fetchImage: async () => { downloads += 1; return image('raw'); }, shrink: async data => data });
  const results = await Promise.all([1, 2, 3].map(() => cache.get('https://a.example/icon.png')));
  assert.equal(downloads, 1);
  assert.deepEqual(new Set(results), new Set([image('raw')]));
});

test('failures yield an empty result, are not stored and are retried only after a pause', async () => {
  const storage = fakeStorage();
  let clock = 1000, downloads = 0, broken = true;
  const cache = createIconCache({
    storage, now: () => clock, shrink: async data => data,
    fetchImage: async () => { downloads += 1; if (broken) throw new Error('offline'); return image('ok'); },
  });
  assert.equal(await cache.get('https://a.example/icon.png'), '');
  assert.equal(await cache.get('https://a.example/icon.png'), '');
  assert.equal(downloads, 1);
  assert.equal(ICON_CACHE_KEY in storage.data, false);
  broken = false; clock += 11 * 60 * 1000;
  assert.equal(await cache.get('https://a.example/icon.png'), image('ok'));
  assert.equal(downloads, 2);
});

test('refresh downloads again, replaces the copy and keeps the old one when it fails', async () => {
  const storage = fakeStorage();
  let version = 1, broken = false;
  const cache = createIconCache({ storage, shrink: async data => data, fetchImage: async () => { if (broken) throw new Error('offline'); return image(`v${version}`); } });
  assert.equal(await cache.get('https://a.example/icon.png'), image('v1'));
  version = 2;
  assert.equal(await cache.get('https://a.example/icon.png'), image('v1'));
  assert.equal(await cache.get('https://a.example/icon.png', { refresh: true }), image('v2'));
  assert.equal(storage.data[ICON_CACHE_KEY]['https://a.example/icon.png'].data, image('v2'));
  broken = true;
  assert.equal(await cache.get('https://a.example/icon.png', { refresh: true }), image('v2'));
});

test('the cache is bounded and drops the oldest copies first', async () => {
  const storage = fakeStorage();
  let clock = 0;
  const cache = createIconCache({ storage, now: () => ++clock, shrink: async data => data, fetchImage: async url => image(url.split('/').pop()) });
  for (let index = 0; index < 160; index += 1) await cache.get(`https://a.example/${index}`);
  const stored = Object.keys(storage.data[ICON_CACHE_KEY]);
  assert.equal(stored.length, 150);
  assert.equal(stored.includes('https://a.example/0'), false);
  assert.equal(stored.includes('https://a.example/159'), true);

  // Three 1.2 MB copies exceed the 3 MB budget, so the first one is dropped.
  const heavy = fakeStorage();
  const big = createIconCache({ storage: heavy, now: () => ++clock, shrink: async data => data, fetchImage: async () => 'data:image/webp;base64,' + 'A'.repeat(1.2 * 1024 * 1024) });
  for (const name of ['a', 'b', 'c']) await big.get(`https://big.example/${name}`);
  assert.deepEqual(Object.keys(heavy.data[ICON_CACHE_KEY]), ['https://big.example/b', 'https://big.example/c']);
});

test('a storage failure still returns the image just downloaded', async () => {
  const storage = fakeStorage();
  storage.local.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  const cache = createIconCache({ storage, shrink: async data => data, fetchImage: async () => image('ok') });
  assert.equal(await cache.get('https://a.example/icon.png'), image('ok'));
  assert.equal(await cache.get('https://a.example/icon.png'), image('ok'));
});

test('stored entries that are not images are ignored', async () => {
  const storage = fakeStorage({ [ICON_CACHE_KEY]: { 'https://a.example/x': { data: 'javascript:alert(1)', at: 1 }, 'https://a.example/y': { data: image('ok'), at: 2 } } });
  const cache = createIconCache({ storage, shrink: async data => data, fetchImage: async () => image('fresh') });
  assert.equal(await cache.get('https://a.example/y'), image('ok'));
  assert.equal(await cache.get('https://a.example/x'), image('fresh'));
});
