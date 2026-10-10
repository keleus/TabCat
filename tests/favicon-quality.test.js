import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { requiredFaviconPixels, isSharpFavicon, collectFaviconLinks, rankFavicons } from '../lib/favicon-quality.js';

test('decoded dimensions reject small favicons and retain crisp 64/96px assets', () => {
  const required = requiredFaviconPixels(72, 100, 2);
  assert.equal(required, 64);
  for (const size of [16, 32, 48]) assert.equal(isSharpFavicon('https://site.test/favicon.ico', size, size, required), false);
  for (const size of [64, 96, 128]) assert.equal(isSharpFavicon('https://site.test/favicon.ico', size, size, required), true);
  assert.equal(isSharpFavicon('https://site.test/icon.svg', 16, 16, required), true);
  assert.equal(isSharpFavicon('https://site.test/favicon.ico', 128, 32, required), false);
  assert.equal(isSharpFavicon('https://site.test/icon.svg', 0, 0, required), false);
  assert.equal(isSharpFavicon('https://site.test/favicon.ico', 64, 64, requiredFaviconPixels(128, 160, 3)), false);
});

test('collect and rank declared icons without treating declared sizes as proof', () => {
  const doc = new DOMParser().parseFromString('<link rel="shortcut icon" href="small.ico"><link rel="apple-touch-icon" sizes="180x180" href="touch.png"><link rel="icon" sizes="any" type="image/svg+xml" href="vector.svg"><link rel="manifest" href="app.webmanifest"><link rel="icon" href="javascript:alert(1)">', 'text/html');
  const links = collectFaviconLinks(doc, 'https://site.test/assets/');
  assert.equal(links.manifest, 'https://site.test/assets/app.webmanifest');
  assert.deepEqual(rankFavicons(links.icons), ['https://site.test/assets/vector.svg','https://site.test/assets/touch.png','https://site.test/assets/small.ico']);
});
