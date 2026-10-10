import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galleryCacheKey, galleryCandidates } from '../lib/wallpapers.js';
import { normalizeState } from '../lib/state.js';
import { createBackup, inspectBackup } from '../lib/backup.js';

test('wallpaper rotation changes at the chosen boundary and stays stable within it', () => {
  const now = Date.parse('2026-10-09T10:00:00Z');
  assert.equal(galleryCacheKey('daily', now), galleryCacheKey('daily', now + 3600000));
  assert.notEqual(galleryCacheKey('daily', now), galleryCacheKey('daily', now + 86400000));
  assert.notEqual(galleryCacheKey('hourly', now), galleryCacheKey('hourly', now + 3600000));
  assert.equal(galleryCacheKey('manual', now), galleryCacheKey('manual', now + 86400000));
  assert.equal(galleryCacheKey('newtab', now, 'tab1'), galleryCacheKey('newtab', now + 3600000, 'tab1'));
  assert.notEqual(galleryCacheKey('newtab', now, 'tab1'), galleryCacheKey('newtab', now, 'tab2'));
});

test('gallery accepts landscape photography and trusted image endpoints only', () => {
  const pics = galleryCandidates('picsum', [
    { id: '10', width: 3000, height: 2000, author: 'Photographer' },
    { id: '11', width: 800, height: 600 }, { id: '12', width: 2000, height: 3000 },
    { id: '../bad', width: 3000, height: 2000 },
  ]);
  assert.equal(pics.length, 1);
  assert.equal(pics[0].url, 'https://picsum.photos/id/10/1920/1080');
  const bing = galleryCandidates('bing-gallery', { images: [{ url: '/th?id=photo', title: '山' }, { url: 'https://evil.example/th' }, { url: '/other' }] });
  assert.equal(bing.length, 1);
  assert.equal(bing[0].title, '山');
  assert.deepEqual(galleryCandidates('unknown', []), []);
});

test('removed gradient presets migrate and gallery settings survive backup', () => {
  for (const background of ['mist', 'sky', 'forest', 'peach']) assert.equal(normalizeState({ designVersion: 2, background }).background, 'fjord');
  const state = normalizeState({ background: 'picsum', wallpaperRotation: 'newtab' });
  const restored = inspectBackup(createBackup(state), state).state;
  assert.equal(restored.background, 'picsum');
  assert.equal(restored.wallpaperRotation, 'newtab');
  assert.equal(normalizeState({ wallpaperRotation: 'bad' }).wallpaperRotation, 'daily');
});
