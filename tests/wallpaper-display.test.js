import test from 'node:test';
import assert from 'node:assert/strict';
import { createWallpaperDisplay } from '../lib/wallpaper-display.js';

function fixture() {
  const requests = [], applied = [];
  const display = createWallpaperDisplay({
    fallback: 'default', apply: source => applied.push(source),
    createImage: () => {
      const image = {};
      const promise = new Promise((resolve, reject) => Object.assign(image, { resolve, reject }));
      image.decode = () => promise;
      requests.push(image);
      return image;
    },
  });
  return { display, requests, applied };
}

test('keeps the current wallpaper until replacement decode succeeds and reuses unchanged images', async () => {
  const { display, requests, applied } = fixture();
  const first = display.show('cached'); requests[0].resolve(); await first;
  const second = display.show('next');
  assert.equal(display.current, 'cached');
  assert.equal(display.show('next'), second);
  assert.equal(requests.length, 2);
  requests[1].resolve(); await second;
  assert.deepEqual(applied, ['cached', 'next']);
  await display.show('next');
  assert.equal(requests.length, 2);
});

test('late responses cannot overwrite a newer selection or a return to the current image', async () => {
  const { display, requests, applied } = fixture();
  const first = display.show('first'); requests[0].resolve(); await first;
  const slow = display.show('slow');
  await display.show('first'); requests[1].resolve(); await slow;
  assert.deepEqual(applied, ['first']);
  const older = display.show('older'), latest = display.show('latest');
  requests[3].resolve(); await latest;
  requests[2].resolve(); await older;
  assert.deepEqual(applied, ['first', 'latest']);
});

test('failed images preserve the current wallpaper; failed first image decodes a fallback', async () => {
  const { display, requests, applied } = fixture();
  const first = display.show('broken'); requests[0].reject(new Error('invalid image'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(requests[1].src, 'default'); requests[1].resolve(); await first;
  const failed = display.show('offline'); requests[2].reject(new Error('offline')); await failed;
  assert.deepEqual(applied, ['default']);
  assert.equal(display.current, 'default');
});

test('a stalled image settles without blanking a successfully displayed image', async () => {
  const applied = [];
  const display = createWallpaperDisplay({ fallback: 'default', timeout: 10, apply: source => applied.push(source), createImage: () => ({ decode() { return this.src === 'default' ? Promise.resolve() : new Promise(() => {}); } }) });
  await display.show('default');
  await display.show('stalled');
  assert.deepEqual(applied, ['default']);
});
