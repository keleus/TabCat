import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Render Chrome Web Store graphics from the brand SVG and a desktop screenshot.
// Screenshots and promo tiles are JPEG because the store rejects PNGs with alpha.
const root = new URL('../', import.meta.url);
const output = new URL('docs/store/', root);
const read = path => readFile(new URL(path, root));
const dataUrl = async (path, type) => `data:${type};base64,${(await read(path)).toString('base64')}`;

const svg = (await read('public/icon/tabcat.svg')).toString('utf8');
const catUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const screenshotUrl = await dataUrl('docs/store/source/desktop.webp', 'image/webp');
const wallpaperUrl = await dataUrl('public/wallpapers/fjord.png', 'image/png');

const TITLE = 'TabCat 新标签页';
const TAGLINE = '常用网站、随手记录和每日壁纸，都在新标签页';
const FEATURES = ['网站与小组件同桌', '每日壁纸', '本地保存 · 可同步'];
const FONT = `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif`;

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.TABCAT_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const save = (name, data) => writeFile(fileURLToPath(new URL(name, output)), data);

  // Store icon: 96 px artwork with 16 px transparent padding on each side.
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block;margin:16px;width:96px;height:96px}</style><img src="${catUrl}">`);
  await page.waitForFunction(() => document.images[0].complete);
  await save('icon-128.png', await page.screenshot({ omitBackground: true }));

  // Screenshot: crop the wide capture to 16:10 around the centred desktop, then move the
  // right-hand toolbar and wallpaper caption back to the new right edge.
  await page.setContent('<canvas></canvas>');
  const screenshot = await page.evaluate(async ({ src, width, height }) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const cropWidth = Math.round(image.height * width / height);
    const left = Math.round((image.width - cropWidth) / 2);
    const canvas = Object.assign(document.createElement('canvas'), { width: cropWidth, height: image.height });
    const context = canvas.getContext('2d');
    context.drawImage(image, -left, 0);
    const patchWidth = 300;
    const patch = (y, h, featherTop, featherBottom) => {
      const piece = Object.assign(document.createElement('canvas'), { width: patchWidth, height: h });
      const pc = piece.getContext('2d');
      pc.drawImage(image, image.width - patchWidth, y, patchWidth, h, 0, 0, patchWidth, h);
      pc.globalCompositeOperation = 'destination-in';
      const across = pc.createLinearGradient(0, 0, 120, 0);
      across.addColorStop(0, 'rgba(0,0,0,0)');
      across.addColorStop(1, '#000');
      pc.fillStyle = across;
      pc.fillRect(0, 0, patchWidth, h);
      const down = pc.createLinearGradient(0, 0, 0, h);
      down.addColorStop(0, featherTop ? 'rgba(0,0,0,0)' : '#000');
      down.addColorStop(featherTop ? 0.3 : 0, '#000');
      down.addColorStop(featherBottom ? 0.7 : 1, '#000');
      down.addColorStop(1, featherBottom ? 'rgba(0,0,0,0)' : '#000');
      pc.fillStyle = down;
      pc.fillRect(0, 0, patchWidth, h);
      context.drawImage(piece, cropWidth - patchWidth, y);
    };
    patch(0, 130, false, true);
    patch(image.height - 110, 110, true, false);
    const out = Object.assign(document.createElement('canvas'), { width, height });
    const oc = out.getContext('2d');
    oc.imageSmoothingQuality = 'high';
    oc.drawImage(canvas, 0, 0, width, height);
    return out.toDataURL('image/jpeg', 0.92);
  }, { src: screenshotUrl, width: 1280, height: 800 });
  const screenshotJpeg = Buffer.from(screenshot.split(',')[1], 'base64');
  await save('screenshot-1-desktop.jpg', screenshotJpeg);
  const desktopUrl = `data:image/jpeg;base64,${screenshotJpeg.toString('base64')}`;

  const base = `
    html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:${FONT};color:#fff}
    .bg{position:absolute;inset:0;background:url(${wallpaperUrl}) center 35%/cover}
    .bg::after{content:'';position:absolute;inset:0;background:linear-gradient(115deg,rgba(24,36,58,.82),rgba(40,58,86,.55) 55%,rgba(40,58,86,.25))}
    .badge{background:#fff;border-radius:50%;display:grid;place-items:center;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    .badge img{width:78%;height:78%}
    h1{margin:0;font-weight:700;letter-spacing:.5px}
    p{margin:0;color:rgba(255,255,255,.88)}`;

  // Small promo tile, 440×280.
  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(`<style>${base}
    .wrap{position:relative;height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 36px;gap:14px}
    .row{display:flex;align-items:center;gap:16px}
    .badge{width:76px;height:76px}
    h1{font-size:34px} p{font-size:16px;line-height:1.5}
  </style><div class="bg"></div><div class="wrap"><div class="row"><div class="badge"><img src="${catUrl}"></div><h1>TabCat</h1></div><p>常用网站、随手记录和每日壁纸<br>都在新标签页</p></div>`);
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  await save('promo-small-440x280.jpg', await page.screenshot({ type: 'jpeg', quality: 92 }));

  // Marquee promo tile, 1400×560.
  await page.setViewportSize({ width: 1400, height: 560 });
  await page.setContent(`<style>${base}
    .wrap{position:relative;height:100%;display:flex;align-items:center;padding-left:88px}
    .text{width:470px;display:flex;flex-direction:column;gap:22px}
    .badge{width:96px;height:96px}
    h1{font-size:50px} p{font-size:22px;line-height:1.55}
    ul{display:flex;flex-wrap:wrap;gap:10px;margin:6px 0 0;padding:0;list-style:none}
    li{font-size:16px;padding:7px 14px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28)}
    .shot{position:absolute;left:640px;top:64px;width:832px;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.35)}
  </style><div class="bg"></div><div class="wrap"><div class="text"><div class="badge"><img src="${catUrl}"></div><h1>${TITLE}</h1><p>${TAGLINE}</p><ul>${FEATURES.map(item => `<li>${item}</li>`).join('')}</ul></div></div><img class="shot" src="${desktopUrl}">`);
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  await save('promo-marquee-1400x560.jpg', await page.screenshot({ type: 'jpeg', quality: 92 }));
} finally { await browser.close(); }
