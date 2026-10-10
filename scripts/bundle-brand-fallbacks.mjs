// Offline fallback for sites whose homepage logo cannot be fetched. These are
// attributed brand vectors, not downloaded browser icons. Runtime discovery
// still prefers the real homepage logo when it is available.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const sources = JSON.parse(readFileSync('public/catalog/sources.json'));
const aliases = { weibo: 'sinaweibo', douyin: 'tiktok', chatgpt: 'openai', music163: 'neteasecloudmusic', mdn: 'mdnwebdocs', gemini: 'googlegemini', lechat: 'mistralai', bing: 'microsoftbing', outlook: 'microsoftoutlook' };
for (const [id, entry] of Object.entries(sources)) {
  if (['page-logo', 'brand-artwork', 'hd-favicon'].includes(entry.kind)) continue;
  const name = aliases[id] || id;
  let icon;
  try { const loaded = require(`@iconify-icons/simple-icons/${name}`); icon = loaded.default || loaded; } catch { continue; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 ${(icon.width || 24) + 6} ${(icon.height || 24) + 6}" color="#202124">${icon.body}</svg>\n`;
  const file = `${id}.svg`;
  writeFileSync(`public/catalog/${file}`, svg);
  sources[id] = { file, kind: 'brand-fallback', source: 'https://github.com/simple-icons/simple-icons', website: entry.website, package: '@iconify-icons/simple-icons@2.0.6', icon: name, sha256: createHash('sha256').update(svg).digest('hex') };
}
writeFileSync('public/catalog/sources.json', `${JSON.stringify(sources, null, 2)}\n`);
console.log('Still need homepage logos:', Object.entries(sources).filter(([,v])=>!['page-logo','brand-artwork','brand-fallback','hd-favicon'].includes(v.kind)).map(([id])=>id).join(', '));
