import { catalogIcon } from './site-catalog.js';

export function searchProvider(engine) {
  let host;
  try { host = new URL(engine.url).hostname; } catch { return ''; }
  if (['google.com', 'www.google.com'].includes(host)) return 'google';
  if (['bing.com', 'www.bing.com', 'cn.bing.com'].includes(host)) return 'bing';
  if (['baidu.com', 'www.baidu.com'].includes(host)) return 'baidu';
  return '';
}

export function engineIcon(engine) {
  const provider = searchProvider(engine);
  if (provider === 'google') return '/search/google.png';
  return provider ? catalogIcon(`https://www.${provider}.com/`) : '';
}

export function suggestionUrl(provider, query) {
  const q = encodeURIComponent(query.slice(0, 200));
  return {
    google: `https://suggestqueries.google.com/complete/search?client=firefox&hl=zh-CN&q=${q}`,
    bing: `https://api.bing.com/osjson.aspx?query=${q}&market=zh-CN`,
    baidu: `https://suggestion.baidu.com/su?wd=${q}&ie=utf-8&cb=tabcat`,
  }[provider] || '';
}

export function parseSuggestions(provider, text) {
  let values;
  if (provider === 'baidu') {
    // Parse only the string array in Baidu's JSONP. Never execute returned code.
    const match = text.match(/\bs\s*:\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\])/);
    values = match ? JSON.parse(match[1]) : [];
  } else values = JSON.parse(text)?.[1];
  return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && value.trim() && value.length <= 200))].slice(0, 8) : [];
}
