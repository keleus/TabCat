// Self-contained so the same collector runs in an inert document or active tab.
export function collectPageLogos(doc = document, base = doc.baseURI, live = true) {
  const resolve = value => { try { return new URL(value, base).href; } catch { return ''; } };
  const logos = [];
  const elements = [...doc.querySelectorAll('img, svg, [class*="logo" i], [id*="logo" i], [class*="brand" i], [class*="logo" i] a')].slice(0, 1200);
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    const hint = [el.getAttribute('class'), el.id, el.getAttribute('alt'), el.getAttribute('aria-label'), el.getAttribute('src'), el.parentElement?.getAttribute('class')].join(' ');
    const branded = /logo|brand|标志|标识/i.test(hint);
    const header = Boolean(el.closest('header, [role="banner"], [class*="header" i], [id*="header" i], nav'));
    if (el.closest('footer, [role="contentinfo"], [class*="footer" i]')) continue;
    const anchor = el.closest('a[href]');
    let home = false;
    try { if (!anchor) throw new Error('No home link'); const url = new URL(anchor.getAttribute('href'), base); home = url.origin === new URL(base).origin && /^\/(?:index\.[a-z]+)?$/.test(url.pathname); } catch {}
    if (!branded && !(header && home)) continue;
    if (/avatar|payment|partner|sponsor|loading|spinner|favicon|apple-touch-icon/i.test(hint)) continue;
    if (live) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || getComputedStyle(el).visibility === 'hidden') continue;
    }
    const score = (branded ? 40 : 0) + (header ? 30 : 0) + (home ? 30 : 0);
    if (tag === 'img') {
      const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
      const variants = srcset.split(',').map(value => { const [url, size] = value.trim().split(/\s+/); return { url, size: parseFloat(size) || 0 }; }).sort((a, b) => b.size - a.size);
      for (const value of [variants[0]?.url, el.getAttribute('data-src'), live ? el.currentSrc : '', el.getAttribute('src')]) {
        if (value) logos.push({ url: resolve(value), score });
      }
    } else if (tag === 'svg' && el.outerHTML.length < 80000) {
      const clone = el.cloneNode(true);
      // Copy only computed presentation; sanitization happens in the extension.
      if (live) {
        const originals = [el, ...el.querySelectorAll('*')];
        const copies = [clone, ...clone.querySelectorAll('*')];
        originals.forEach((node, index) => {
          if (index > 500) return;
          const style = getComputedStyle(node);
          for (const attr of ['fill', 'stroke', 'stroke-width', 'opacity', 'color']) copies[index].setAttribute(attr, style.getPropertyValue(attr));
        });
      }
      logos.push({ svg: clone.outerHTML, score: score + 5 });
    } else {
      const background = live ? getComputedStyle(el).backgroundImage : el.getAttribute('style') || '';
      const matches = [...background.matchAll(/url\(["']?([^"')]+)["']?\)\s*(\d+(?:\.\d+)?)?(?:x|dppx)?/gi)];
      matches.sort((a, b) => (Number(b[2]) || 1) - (Number(a[2]) || 1));
      if (matches[0]) logos.push({ url: resolve(matches[0][1]), score });
    }
  }
  return logos.sort((a, b) => b.score - a.score).slice(0, 16);
}

export function isHomepageLogoUrl(value) {
  return typeof value === 'string' && !/favicon|apple-touch-icon|\.ico(?:[?#]|$)/i.test(value);
}

export function sanitizeLogo(raw, Parser = DOMParser) {
  if (typeof raw !== 'string' || raw.length > 100000) return '';
  // outerHTML from a live HTML page may contain non-XML foreignObject children.
  // Parse inert HTML first, then retain only SVG geometry below.
  const root = new Parser().parseFromString(raw, 'text/html').querySelector('svg');
  if (!root) return '';
  const tags = new Set(['symbol', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'title'].map(tag => tag.toLowerCase()));
  const attrs = new Set(['viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','opacity','fill-opacity','stroke-opacity','transform','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','clip-path','mask','href','color','clipPathUnits','maskUnits','maskContentUnits','preserveAspectRatio']);
  for (const node of [root, ...root.querySelectorAll('*')]) {
    if (!tags.has(node.localName.toLowerCase())) { node.remove(); continue; }
    for (const attr of [...node.attributes]) {
      const localReference = /^#[\w-]+$/.test(attr.value);
      const localPaint = /^url\(#[\w-]+\)$/.test(attr.value);
      if (!attrs.has(attr.name) || (attr.name === 'href' && !localReference) || (/url\s*\(/i.test(attr.value) && !localPaint)) node.removeAttribute(attr.name);
    }
  }
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const width = box?.[2] || parseFloat(root.getAttribute('width')) || 128;
  const height = box?.[3] || parseFloat(root.getAttribute('height')) || 128;
  if (!(width > 0 && height > 0 && Number.isFinite(width / height))) return '';
  if (!box) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const scale = 512 / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  root.setAttribute('width', w); root.setAttribute('height', h);
  return root.outerHTML.replace(/(<\/?)(clippath|lineargradient|radialgradient)(?=[\s>])/gi, (_, prefix, tag) => prefix + ({ clippath: 'clipPath', lineargradient: 'linearGradient', radialgradient: 'radialGradient' }[tag.toLowerCase()]));
}

export async function rasterizeLogo(raw) {
  const svg = sanitizeLogo(raw);
  if (!svg) return '';
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    if (!context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0)) return '';
    return canvas.toDataURL('image/png');
  } catch { return ''; }
}
