import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherCache, WEATHER_STORAGE_KEY, weatherCacheFresh, weatherDaylight, weatherMoon } from '../lib/weather-cache.js';

function fixture() {
  let values = {}, time = Date.parse('2026-10-10T12:07:00Z'), calls = [], fail = false, chain = Promise.resolve();
  const storage = { get: async key => ({ [key]: structuredClone(values[key]) }), set: async patch => { values = { ...values, ...structuredClone(patch) }; } };
  const request = async url => {
    calls.push(url); if (fail) throw new Error('offline');
    if (url.includes('ipwho.is')) return { success: true, city: '杭州', latitude: 30.29, longitude: 120.16, ip: '203.0.113.1' };
    return { current: { temperature_2m: 24, weather_code: 0, is_day: 1, time: time / 1000 }, utc_offset_seconds: 28800 };
  };
  const lock = run => { const next = chain.catch(() => {}).then(run); chain = next; return next; };
  return { make: () => createWeatherCache({ storage, request, now: () => time, lock }), storage, calls, advance: value => { time += value; }, fail: () => { fail = true; } };
}
const automatic = { locationMode: 'ip' };

test('weather and IP location persist across instances without repeated network requests', async () => {
  const f = fixture(), cache = f.make();
  assert.equal(await cache.snapshot(automatic), null);
  const entry = await cache.refresh(automatic);
  assert.equal(f.calls.length, 2);
  const reopened = f.make();
  assert.deepEqual(await reopened.snapshot(automatic), entry);
  assert.deepEqual(await reopened.refresh(automatic), entry);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(await f.storage.get(WEATHER_STORAGE_KEY)).includes('203.0.113.1'), false);
  assert.equal(await reopened.snapshot({ latitude: 0, longitude: 0 }), null);
});

test('quarter-hour expiry and manual refresh revalidate; failures retain last successful weather', async () => {
  const f = fixture(), cache = f.make();
  const first = await cache.refresh(automatic);
  f.advance(7 * 60000); await cache.refresh(automatic); assert.equal(f.calls.length, 2);
  f.advance(60000); const next = await cache.refresh(automatic); assert.equal(f.calls.length, 4); assert.notEqual(next.at, first.at);
  await cache.refresh(automatic, true); assert.equal(f.calls.length, 6);
  f.fail(); await assert.rejects(cache.refresh(automatic, true));
  assert.deepEqual(await f.make().snapshot(automatic), next);
  assert.equal(weatherCacheFresh(next.at, next.at - 1), false);
});

test('multiple tabs and cards share an in-flight refresh, and cities retain their own readings', async () => {
  const f = fixture(), a = f.make(), b = f.make();
  await Promise.all([a.refresh(automatic), a.refresh(automatic), b.refresh(automatic)]);
  assert.equal(f.calls.length, 2);
  const manual = { city: '北京', latitude: 39.9, longitude: 116.4 };
  await b.refresh(manual); assert.equal(f.calls.length, 3);
  assert.equal((await a.snapshot(automatic)).location.city, '杭州');
  assert.equal((await a.snapshot(manual)).location.city, '北京');
});

test('cached sunrise and sunset switch exactly at the city boundaries, independent of fetch time', () => {
  const entry = { current: { is_day: 1 }, daylight: [{ start: 1000, end: 87400, sunrise: 22600, sunset: 65800 }] };
  assert.equal(weatherDaylight(entry, 22599 * 1000), 0);
  assert.equal(weatherDaylight(entry, 22600 * 1000), 1);
  assert.equal(weatherDaylight(entry, 65799 * 1000), 1);
  assert.equal(weatherDaylight(entry, 65800 * 1000), 0);
  assert.equal(weatherDaylight({ current: { is_day: 0 } }), 0);
  assert.equal(weatherMoon({ utcOffset: 28800 }, Date.parse('2024-02-10T12:00:00Z')), 'moon-new');
  assert.equal(weatherMoon({ utcOffset: 28800 }, Date.parse('2024-02-24T12:00:00Z')), 'moon-full');
});
