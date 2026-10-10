import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticWallpaperRequest, installWallpaperRotation, WALLPAPER_ALARM } from '../lib/wallpaper-rotation.js';

test('only timed wallpaper policies schedule background work', () => {
  for (const background of ['fjord', 'local', 'custom']) assert.equal(automaticWallpaperRequest({ background }), null);
  for (const wallpaperRotation of ['manual', 'newtab']) assert.equal(automaticWallpaperRequest({ background: 'picsum', wallpaperRotation }), null);
  assert.deepEqual(automaticWallpaperRequest({ background: 'bing' }), { type: 'tabcat:bing', force: false });
  assert.deepEqual(automaticWallpaperRequest({ background: 'picsum', wallpaperRotation: 'hourly' }), { type: 'tabcat:gallery', provider: 'picsum', rotation: 'hourly', force: false });
});

test('alarms refresh without a page, restore missing schedules, retry failures and stop for manual rotation', async () => {
  let state = { background: 'picsum', wallpaperRotation: 'hourly' }, alarm, onAlarm, onChanged, fail = false;
  const refreshed = [];
  const alarms = {
    onAlarm: { addListener(callback) { onAlarm = callback; } },
    async get() { return alarm; },
    async create(name, options) { alarm = { name, ...options }; },
    async clear() { alarm = undefined; },
  };
  const storage = { local: { async get() { return { tabcat: state }; } }, onChanged: { addListener(callback) { onChanged = callback; } } };
  const sync = installWallpaperRotation({ alarms, storage, async refresh(request) { refreshed.push(request); if (fail) throw new Error('offline'); } });
  await sync();
  assert.equal(alarm.name, WALLPAPER_ALARM); assert.equal(alarm.periodInMinutes, 1);
  const before = refreshed.length;
  await onAlarm({ name: 'unrelated' }); assert.equal(refreshed.length, before);
  fail = true; await onAlarm({ name: WALLPAPER_ALARM }); assert.equal(refreshed.length, before + 1);
  fail = false; alarm = undefined; await onAlarm({ name: WALLPAPER_ALARM }); assert.equal(refreshed.length, before + 2); assert.ok(alarm);
  await onChanged({ tabcat: { oldValue: state, newValue: { ...state, iconSize: 80 } } }, 'local'); assert.equal(refreshed.length, before + 2);
  const old = state; state = { ...state, wallpaperRotation: 'manual' };
  await onChanged({ tabcat: { oldValue: old, newValue: state } }, 'local'); assert.equal(alarm, undefined); assert.equal(refreshed.length, before + 2);
});
