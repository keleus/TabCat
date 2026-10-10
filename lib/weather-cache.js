import { WEATHER_CACHE_MS, validCoordinates, ipLocation } from './weather.js';

export const WEATHER_STORAGE_KEY = 'tabcatWeatherCacheV1';
export const weatherCacheFresh = (at, now = Date.now()) => Number.isFinite(at) && at <= now && Math.floor(at / WEATHER_CACHE_MS) === Math.floor(now / WEATHER_CACHE_MS);
const locationKey = location => `${location.latitude},${location.longitude}`;
const usable = entry => validCoordinates(entry?.location) && Number.isFinite(entry?.at)
  && Number.isFinite(entry?.current?.temperature_2m) && Number.isFinite(entry?.current?.weather_code);

// Only weather/location metadata is cached. Settings and backups remain separate.
export function createWeatherCache({ storage, request, now = Date.now, lock = run => run(), initial }) {
  const pending = new Map();
  let memory = initial;
  const read = async () => {
    try { const data = (await storage.get(WEATHER_STORAGE_KEY))[WEATHER_STORAGE_KEY]; memory = data?.version === 1 ? data : { version: 1, readings: {} }; return memory; }
    catch { return { version: 1, readings: {} }; }
  };
  const write = async data => { memory = data; await storage.set({ [WEATHER_STORAGE_KEY]: data }).catch(() => {}); };
  function snapshot(data, widget) {
    const entry = widget.locationMode === 'ip' ? data?.automatic : data?.readings?.[locationKey(widget)];
    return usable(entry) ? entry : null;
  }
  async function refresh(widget, force = false) {
    const key = widget.locationMode === 'ip' ? 'automatic' : locationKey(widget);
    if (pending.has(key)) return pending.get(key);
    const task = lock(async () => {
      const data = await read(); data.readings ||= {};
      let location = { city: widget.city, cityLabel: widget.cityLabel, latitude: widget.latitude, longitude: widget.longitude };
      if (widget.locationMode === 'ip') {
        if (!force && validCoordinates(data.ip?.location) && weatherCacheFresh(data.ip.at, now())) location = data.ip.location;
        else {
          try { location = ipLocation(await request('https://ipwho.is/?lang=zh-CN&fields=success,city,region,country,latitude,longitude')); }
          catch (cause) { throw Object.assign(new Error('暂时无法按 IP 定位'), { phase: 'location', cause }); }
          data.ip = { at: now(), location }; await write(data);
        }
      }
      if (!validCoordinates(location)) throw new Error('请选择有效城市');
      const coordinateKey = locationKey(location);
      let entry = data.readings[coordinateKey];
      if (force || !usable(entry) || !weatherCacheFresh(entry.at, now())) {
        const response = await request(`https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,is_day&daily=sunrise,sunset&forecast_days=2&timeformat=unixtime&timezone=auto`);
        const current = response.current;
        if (!Number.isFinite(current?.temperature_2m) || !Number.isFinite(current?.weather_code)) throw new Error('天气数据暂不可用');
        entry = { location, at: now(), current: {
          temperature_2m: current.temperature_2m, relative_humidity_2m: current.relative_humidity_2m,
          weather_code: current.weather_code, is_day: current.is_day, time: current.time,
        }, utcOffset: Number.isFinite(response.utc_offset_seconds) ? response.utc_offset_seconds : 0,
        daylight: (response.daily?.time || []).slice(0, 2).map((start, i) => ({
          start, end: response.daily.time[i + 1] || start + 86400,
          sunrise: response.daily.sunrise?.[i], sunset: response.daily.sunset?.[i],
        })).filter(day => [day.start, day.end, day.sunrise, day.sunset].every(Number.isFinite) && day.sunrise < day.sunset) };
        data.readings[coordinateKey] = entry;
        data.readings = Object.fromEntries(Object.entries(data.readings).filter(([, value]) => usable(value)).sort((a, b) => b[1].at - a[1].at).slice(0, 20));
        if (widget.locationMode === 'ip') data.automatic = entry;
        await write(data);
      } else if (widget.locationMode === 'ip' && data.automatic?.at !== entry.at) {
        data.automatic = entry; await write(data);
      }
      return entry;
    });
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return { peek: widget => snapshot(memory, widget), snapshot: async widget => snapshot(await read(), widget), refresh };
}

export function weatherDaylight(entry, now = Date.now()) {
  const seconds = now / 1000;
  const day = entry.daylight?.find(day => seconds >= day.start && seconds < day.end);
  return day ? Number(seconds >= day.sunrise && seconds < day.sunset) : entry.current.is_day;
}

// Decorative moon phases approximate the lunar day, not astronomical illumination.
export function weatherMoon(entry, now = Date.now()) {
  try {
    const local = new Date(now + (entry.utcOffset || 0) * 1000);
    const day = Number(new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'UTC', day: 'numeric' }).formatToParts(local).find(part => part.type === 'day')?.value);
    const phase = day <= 1 || day >= 29 ? 'new' : day <= 6 || day >= 25 ? 'crescent' : day <= 9 || day >= 22 ? 'quarter' : day <= 13 || day >= 18 ? 'gibbous' : 'full';
    return `moon-${phase}${day > 15 ? ' moon-waning' : ''}`;
  } catch { return 'moon-crescent'; }
}

export function weatherUpdatedTime(entry) {
  const time = entry.current.time;
  if (Number.isFinite(time)) return new Date((time + (entry.utcOffset || 0)) * 1000).toISOString().slice(5, 16).replace('T', ' ');
  return typeof time === 'string' ? time.slice(5, 16).replace('T', ' ') : '时间未知';
}
