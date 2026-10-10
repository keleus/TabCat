import test from 'node:test';
import assert from 'node:assert/strict';
import { wallpaperTextShadow } from '../lib/wallpaper-contrast.js';

test('white text only loses its shadow on a known dark wallpaper', () => {
  assert.equal(wallpaperTextShadow('light', .15), 'none');
  assert.notEqual(wallpaperTextShadow('light', .8), 'none');
  assert.notEqual(wallpaperTextShadow('light', null), 'none');
  assert.notEqual(wallpaperTextShadow('dark', .15), 'none');
});

test('brightness follows the displayed dim and white frost overlays', () => {
  assert.equal(wallpaperTextShadow('light', .8, .6), 'none');
  assert.notEqual(wallpaperTextShadow('light', .15, 0, .6), 'none');
  assert.equal(wallpaperTextShadow('light', .15, .6, .6), 'none');
});
