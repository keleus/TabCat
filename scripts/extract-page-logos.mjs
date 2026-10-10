// Share the runtime collector and sanitizer with the catalog refresh command.
import { DOMParser } from 'linkedom';
import { readFileSync } from 'node:fs';
import { collectPageLogos, sanitizeLogo } from '../lib/page-logos.js';
import { collectFaviconLinks, rankFavicons } from '../lib/favicon-quality.js';
const [mode, base] = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
if (mode === 'svg') process.stdout.write(sanitizeLogo(input, DOMParser));
else {
  const doc = new DOMParser().parseFromString(input, 'text/html');
  const candidates = collectPageLogos(doc, base, false).filter(item => item.score >= 40).map(item => item.svg ? { ...item, svg: sanitizeLogo(item.svg, DOMParser) } : item);
  process.stdout.write(JSON.stringify({ title: doc.title, candidates, icons: rankFavicons(collectFaviconLinks(doc, base).icons) }));
}
