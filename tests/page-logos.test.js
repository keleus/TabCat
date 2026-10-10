import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { collectPageLogos, sanitizeLogo, isHomepageLogoUrl } from '../lib/page-logos.js';

const collect = html => collectPageLogos(new DOMParser().parseFromString(html, 'text/html'), 'https://example.com/article', false);

test('homepage branding wins over favicons, footer brands and partner images', () => {
  const logos = collect('<link rel="icon" href="/favicon.ico"><header><a href="/"><img class="logo" src="/small.png" srcset="/small.png 1x, /large.png 2x"></a><img class="partner-logo" src="/partner.png"></header><footer><img class="logo" src="/footer.png"></footer>');
  assert.equal(logos[0].url, 'https://example.com/large.png');
  assert.ok(logos.every(logo => !/favicon|partner|footer/.test(logo.url)));
});

test('header CSS image-set selects the higher density homepage logo', () => {
  const logos = collect('<header><a class="logo" href="/" style="background-image:image-set(url(/logo.png) 1x,url(/logo@2x.png) 2x)"></a></header>');
  assert.equal(logos[0].url, 'https://example.com/logo@2x.png');
});

test('SVG preserves wide branding while removing scripts and external references', () => {
  const svg = sanitizeLogo('<svg viewBox="0 0 400 100"><script>bad()</script><foreignObject>bad</foreignObject><path d="M0 0H400V100H0Z" fill="#f00" onclick="bad()"/><use href="https://evil.example/a.svg#logo"/></svg>', DOMParser);
  assert.match(svg, /width="512"/);
  assert.match(svg, /height="128"/);
  assert.doesNotMatch(svg, /script|foreignObject|onclick|evil\.example/);
});

test('automatic logo candidates reject favicon and ICO sources', () => {
  for (const url of ['https://x.test/favicon.ico', 'https://x.test/favicon-192.png', 'https://x.test/apple-touch-icon.png', 'https://x.test/site.ICO?v=2']) assert.equal(isHomepageLogoUrl(url), false);
  assert.equal(isHomepageLogoUrl('https://x.test/header-logo.svg'), true);
});
