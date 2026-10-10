import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCities, cityLabel, validCoordinates, ipLocation, createIpLocator } from '../lib/weather.js';
import { normalizeState } from '../lib/state.js';
import { createBackup, parseBackup } from '../lib/backup.js';

test('same-name major cities rank above small localities and retain their coordinates', () => {
  const village = { name: '杭州', admin1: '四川', admin2: '甘孜藏族自治州', country: '中国', latitude: 30.06517, longitude: 102.19527, feature_code: 'PPL' };
  const city = { name: '杭州', admin1: '浙江', admin2: '杭州市', country: '中国', latitude: 30.29365, longitude: 120.16142, feature_code: 'PPLA', population: 9236032 };
  const ranked = rankCities([village, city, { ...city }, { name: '坏坐标', latitude: 180, longitude: 0 }], '杭州市');
  assert.deepEqual(ranked, [city, village]);
  assert.equal(cityLabel(ranked[0]), '杭州 · 浙江 · 杭州市 · 中国');
  assert.equal(ranked[1].longitude, 102.19527);
});

test('IP results require success, usable city and valid coordinates; no IP is retained', () => {
  const data = { success: true, city: '杭州', region: '浙江', country: '中国', latitude: 30.29, longitude: 120.16, ip: '203.0.113.1' };
  assert.equal(ipLocation(data).city, '杭州'); assert.equal(ipLocation(data).ip, undefined);
  for (const patch of [{ success: false }, { city: '' }, { latitude: null }, { longitude: 181 }]) assert.throws(() => ipLocation({ ...data, ...patch }));
  assert.equal(validCoordinates({ latitude: 0, longitude: 0 }), true);
});

test('IP location shares pending requests, caches successes and retries after failure', async () => {
  let calls = 0, fail = false;
  const locate = createIpLocator(async () => {
    calls++;
    if (fail) throw new Error('offline');
    return { success: true, city: `城市${calls}`, latitude: 30, longitude: 120 };
  });
  const [a, b] = await Promise.all([locate(), locate()]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  await locate(); assert.equal(calls, 1);
  assert.equal((await locate(true)).city, '城市2');
  fail = true; await assert.rejects(locate(true));
  fail = false; assert.equal((await locate()).city, '城市4');
});

test('automatic weather survives normalization and backup without coordinates; legacy cities remain manual', () => {
  const state = normalizeState({ widgets: [
    { id: 'auto', type: 'weather', locationMode: 'ip', city: 'outdated', latitude: 31, longitude: 121 },
    { id: 'legacy', type: 'weather', city: '杭州', latitude: 30.29, longitude: 120.16 },
  ] });
  assert.equal(state.widgets[0].locationMode, 'ip'); assert.equal(state.widgets[0].latitude, undefined); assert.equal(state.widgets[0].city, undefined);
  assert.equal(state.widgets[1].locationMode, 'manual'); assert.equal(state.widgets[1].longitude, 120.16);
  assert.deepEqual(parseBackup(createBackup(state)), state);
});
