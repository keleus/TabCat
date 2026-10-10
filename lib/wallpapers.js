export const GALLERY_NAMES = { 'bing-gallery': 'Bing 最近几日', picsum: 'Picsum 摄影图库' };

export function galleryCacheKey(rotation, now = Date.now(), session = '') {
  if (rotation === 'newtab') return `newtab:${session}`;
  if (rotation === 'hourly') return `hour:${Math.floor(now / 3600000)}`;
  if (rotation === 'manual') return 'manual';
  return `day:${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now))}`;
}

export function galleryCandidates(provider, payload) {
  if (provider === 'bing-gallery') {
    return (Array.isArray(payload.images) ? payload.images : []).flatMap(item => {
      try {
        const url = new URL(item.url, 'https://www.bing.com');
        if (url.origin !== 'https://www.bing.com' || url.pathname !== '/th') return [];
        return [{ id: url.href, url: url.href, title: String(item.title || 'Bing 壁纸').slice(0, 200), copyright: String(item.copyright || '').slice(0, 500), source: item.copyrightlink }];
      } catch { return []; }
    });
  }
  if (provider === 'picsum') {
    return (Array.isArray(payload) ? payload : []).filter(item => /^\d+$/.test(String(item.id)) && item.width >= 1600 && item.width / item.height >= 1.4).map(item => ({
      id: String(item.id), url: `https://picsum.photos/id/${item.id}/1920/1080`, title: 'Picsum 摄影', copyright: String(item.author || 'Picsum').slice(0, 200), source: item.url,
    }));
  }
  return [];
}
