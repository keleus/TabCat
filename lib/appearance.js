import { UI_ICONS } from './icons.js';
export { UI_ICONS } from './icons.js';

export const WALLPAPERS = [
  { id: 'fjord', name: '远山', subtitle: '山海之间，留一点空白', image: '/wallpapers/fjord.png', color: '#536d83', text: 'light' },
];

const builtins = {
  bookmarks: { color: '#22ad9c', markup: UI_ICONS.bookmark },
  history: { color: '#eda44d', markup: UI_ICONS.history },
  extensions: { color: '#8b7fcb', markup: UI_ICONS.puzzle },
  downloads: { color: '#4c94b6', markup: UI_ICONS.down },
  settings: { color: '#748194', markup: UI_ICONS.settings },
};

export const ICON_FONTS = {
  system: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif',
  serif: 'Georgia,"Songti SC",serif',
  rounded: 'ui-rounded,"Arial Rounded MT Bold","PingFang SC",sans-serif',
  mono: 'ui-monospace,SFMono-Regular,Menlo,monospace',
};

// Use linear-light luminance to choose the more legible black/white foreground.
export function contrastTextColor(color) {
  const channels = (color.match(/[0-9a-f]{2}/gi) || ['4c', '94', 'b6']).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}

export function firstIconCharacter(value) {
  return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value.trim())][0]?.segment || '';
}

export function siteArtwork(site) {
  if (site.iconText) return { color: /^#[0-9a-f]{6}$/i.test(site.color || '') ? site.color : builtins[site.builtin]?.color || '#4c94b6', text: site.iconText };
  if (site.builtin && builtins[site.builtin]) return builtins[site.builtin];
  let host = '';
  try { host = new URL(site.url).hostname.replace(/^www\./, ''); } catch {}
  const colors = ['#4c94b6', '#7e88be', '#49a69c', '#c17d82', '#bd9658'];
  const hash = [...host].reduce((a, char) => a + char.charCodeAt(0), 0);
  return { color: /^#[0-9a-f]{6}$/i.test(site.color || '') ? site.color : colors[hash % colors.length], text: firstIconCharacter(site.name || host) };
}
