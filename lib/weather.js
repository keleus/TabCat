// Location metadata is kept separate from weather readings and never relabelled
// independently of its coordinates.
export const WEATHER_CACHE_MS = 15 * 60 * 1000;
export function validCoordinates(location) {
  return Number.isFinite(location?.latitude) && Math.abs(location.latitude) <= 90
    && Number.isFinite(location?.longitude) && Math.abs(location.longitude) <= 180;
}
export function cityLabel(city) {
  return [...new Set([city.name, city.admin1, city.admin2, city.country].filter(value => typeof value === 'string' && value.trim()))].join(' · ');
}
export function rankCities(results, query) {
  const name = value => String(value || '').trim().toLocaleLowerCase().replace(/市$/, '');
  const exact = city => name(city.name) === name(query);
  const capital = city => /^PPLA\d?$|^PPLC$/.test(city.feature_code || '');
  const seen = new Set();
  return (Array.isArray(results) ? results : []).filter(city => {
    if (!city || !validCoordinates(city) || typeof city.name !== 'string' || !city.name.trim()) return false;
    const key = `${city.name}:${city.latitude}:${city.longitude}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => Number(exact(b)) - Number(exact(a)) || Number(capital(b)) - Number(capital(a))
    || (Number(b.population) || 0) - (Number(a.population) || 0));
}
export function ipLocation(data) {
  if (data?.success !== true || !validCoordinates(data) || typeof data.city !== 'string' || !data.city.trim()) throw new Error('无法定位城市');
  return { city: data.city.trim().slice(0, 100), cityLabel: [data.city, data.region, data.country].filter(value => typeof value === 'string' && value.trim()).join(' · ').slice(0, 250), latitude: data.latitude, longitude: data.longitude };
}
export function createIpLocator(request) {
  let cached = null, pending = null;
  return async function locate(force = false) {
    if (!force && cached && Date.now() - cached.at < WEATHER_CACHE_MS) return cached.location;
    if (!pending) {
      // Request only the fields needed for weather; no IP address is stored.
      pending = request('https://ipwho.is/?lang=zh-CN&fields=success,city,region,country,latitude,longitude')
        .then(data => { const location = ipLocation(data); cached = { at: Date.now(), location }; return location; })
        .catch(error => { cached = null; throw error; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

// Open-Meteo WMO codes: unknown values use a neutral card, never a storm.
export function weatherAppearance(code, isDay = 1) {
  const conditions = {
    0: ['clear', '晴'], 1: ['clear', '晴间多云'], 2: ['cloudy', '多云'], 3: ['overcast', '阴'],
    45: ['fog', '雾'], 48: ['fog', '雾凇'],
    51: ['rain', '小毛毛雨'], 53: ['rain', '毛毛雨'], 55: ['rain', '强毛毛雨'],
    56: ['rain', '冻毛毛雨'], 57: ['rain', '强冻毛毛雨'],
    61: ['rain', '小雨'], 63: ['rain', '中雨'], 65: ['rain', '大雨'], 66: ['rain', '冻雨'], 67: ['rain', '强冻雨'],
    71: ['snow', '小雪'], 73: ['snow', '中雪'], 75: ['snow', '大雪'], 77: ['snow', '米雪'],
    80: ['rain', '小阵雨'], 81: ['rain', '阵雨'], 82: ['rain', '强阵雨'], 85: ['snow', '阵雪'], 86: ['snow', '强阵雪'],
    95: ['storm', '雷雨'], 96: ['storm', '雷雨伴冰雹'], 97: ['storm', '强雷雨'], 99: ['storm', '雷雨伴强冰雹'],
  };
  const [scene, label] = conditions[code] || ['unknown', '天气未知'];
  return { scene, label, night: isDay === 0 };
}
