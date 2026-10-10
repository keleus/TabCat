// Intentionally a small, parser-blocking script: restore the last painted
// background before the module bundle or asynchronous extension APIs run.
(() => {
  const key = 'tabcat:first-paint:v1';
  const root = document.documentElement;
  const properties = ['--background-dim', '--background-frost', '--background-blur', '--bookmark-bar-opacity'];
  const validPreview = value => typeof value === 'string' && value.length <= 256 * 1024 && (
    /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value)
    || value === '/wallpapers/fjord-preview.jpg'
    || /^https?:\/\//.test(value)
  );
  let snapshot = { version: 1, preview: '/wallpapers/fjord-preview.jpg', properties: {} };
  let serialized = '';
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved?.version === 1 && validPreview(saved.preview)) {
      snapshot = saved;
      root.classList.add('has-startup-preview');
      root.classList.toggle('has-bookmarks-bar', saved.bookmarks === true);
      if (['light', 'dark'].includes(saved.theme)) root.dataset.theme = saved.theme;
      for (const name of properties) {
        const value = saved.properties?.[name];
        if (typeof value === 'string' && /^[\d.]+(?:px|vh|%)?$/.test(value)) root.style.setProperty(name, value);
      }
    }
  } catch { /* Missing, blocked or damaged cache must not prevent startup. */ }
  root.style.setProperty('--wallpaper-preview', `url(${JSON.stringify(snapshot.preview)})`);
  const preload = document.createElement('link');
  preload.rel = 'preload'; preload.as = 'image'; preload.href = snapshot.preview;
  document.head.append(preload);
  const preloadedIcons = new Set();
  const validIcon = source => typeof source === 'string' && /^\/(catalog|search)\/[a-z0-9-]+\.(png|svg)$/.test(source);
  function preloadIcons(sources) {
    const icons = [...new Set(sources.filter(validIcon))].slice(0, 100);
    for (const source of icons) {
      if (preloadedIcons.has(source)) continue;
      preloadedIcons.add(source);
      const link = document.createElement('link');
      link.rel = 'preload'; link.as = 'image'; link.href = source; document.head.append(link);
    }
    snapshot.icons = icons;
  }
  preloadIcons(snapshot.logoVersion === 4 && Array.isArray(snapshot.icons) ? snapshot.icons : ['/catalog/github-favicon.png', '/catalog/youtube-favicon.png', '/catalog/bilibili.svg', '/catalog/zhihu-favicon.png', '/catalog/notion-favicon.png', '/search/google.png']);
  snapshot.logoVersion = 4;

  function save() {
    const next = JSON.stringify(snapshot);
    if (next === serialized) return;
    try { localStorage.setItem(key, next); serialized = next; }
    catch {
      // Do not keep showing an outdated wallpaper if storage is full/disabled.
      try { localStorage.removeItem(key); } catch {}
    }
  }

  window.tabcatStartup = {
    preloadIcons(sources) { preloadIcons(sources); save(); },
    saveAppearance() {
      snapshot.properties = Object.fromEntries(properties.map(name => [name, root.style.getPropertyValue(name)]));
      snapshot.bookmarks = root.classList.contains('has-bookmarks-bar');
      snapshot.theme = root.dataset.theme;
      save();
    },
    saveWallpaper(source, image) {
      let preview;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 960 / image.naturalWidth, 540 / image.naturalHeight);
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        preview = canvas.toDataURL('image/webp', .8);
      } catch {
        // A custom URL without CORS can still use the browser's HTTP cache.
        preview = source;
      }
      if (!validPreview(preview)) preview = '/wallpapers/fjord-preview.jpg';
      snapshot.preview = preview;
      root.style.setProperty('--wallpaper-preview', `url(${JSON.stringify(preview)})`);
      save();
    },
  };
})();
