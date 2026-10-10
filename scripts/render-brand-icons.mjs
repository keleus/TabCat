import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Export the editable SVG through Chromium's SVG renderer, preserving alpha.
const source = new URL('../public/icon/tabcat.svg', import.meta.url);
const output = new URL('../public/icon/', import.meta.url);
const svg = await readFile(source, 'utf8');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.TABCAT_CHROMIUM_PATH || undefined });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.screenshot({ path: fileURLToPath(new URL(`${size}.png`, output)), omitBackground: true });
  }
} finally { await browser.close(); }
