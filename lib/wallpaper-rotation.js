import { GALLERY_NAMES } from './wallpapers.js';

export const WALLPAPER_ALARM = 'tabcat:wallpaper-rotation';
export function automaticWallpaperRequest(state) {
  if (state?.background === 'bing') return { type: 'tabcat:bing', force: false };
  if (GALLERY_NAMES[state?.background] && ['hourly', 'daily'].includes(state.wallpaperRotation || 'daily')) {
    return { type: 'tabcat:gallery', provider: state.background, rotation: state.wallpaperRotation || 'daily', force: false };
  }
  return null;
}

// Service-worker alarms continue independently of hidden/new-tab page timers.
// Each tick checks the existing dated cache; only a due or failed image downloads.
export function installWallpaperRotation({ alarms, storage, refresh }) {
  let pending = Promise.resolve();
  const sync = () => {
    const run = async () => {
      const { tabcat } = await storage.local.get('tabcat');
      const request = automaticWallpaperRequest(tabcat);
      if (!request) { await alarms.clear(WALLPAPER_ALARM); return; }
      if (!await alarms.get(WALLPAPER_ALARM)) await alarms.create(WALLPAPER_ALARM, { periodInMinutes: 1 });
      try { await refresh(request); } catch { /* Preserve the image; retry on the next alarm. */ }
    };
    pending = pending.then(run, run);
    return pending;
  };
  alarms.onAlarm.addListener(alarm => { if (alarm.name === WALLPAPER_ALARM) return sync(); });
  storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.tabcat) return;
    const { oldValue, newValue } = changes.tabcat;
    if (oldValue?.background !== newValue?.background || oldValue?.wallpaperRotation !== newValue?.wallpaperRotation) return sync();
  });
  // Recreate missing alarms after a browser restart or extension update.
  void sync();
  return sync;
}
