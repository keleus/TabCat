import test from 'node:test';
import assert from 'node:assert/strict';
import { handleNetworkMessage } from '../lib/network.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function stubFetch(handler) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return handler(url); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const respond = (body, type = 'application/octet-stream') => new Response(body, { status: 200, headers: { 'content-type': type } });

test('icon images are downloaded as data URLs using the detected type', async () => {
  const stub = stubFetch(() => respond(PNG, 'application/octet-stream'));
  try {
    const result = await handleNetworkMessage({ type: 'tabcat:icon-image', url: 'https://cdn.example/icon' });
    assert.equal(result.image, `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    // No cookies or referrer go to the icon host.
    assert.equal(stub.calls[0].options.credentials, 'omit');
    assert.equal(stub.calls[0].options.referrerPolicy, 'no-referrer');
  } finally { stub.restore(); }
});

test('icon downloads reject pages, SVG, oversized files and addresses that are not web URLs', async () => {
  const html = stubFetch(() => respond('<!doctype html><title>x</title>', 'image/png'));
  try { await assert.rejects(handleNetworkMessage({ type: 'tabcat:icon-image', url: 'https://cdn.example/page' }), /没有返回可用的图片/); } finally { html.restore(); }
  const svg = stubFetch(() => respond('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'));
  try { await assert.rejects(handleNetworkMessage({ type: 'tabcat:icon-image', url: 'https://cdn.example/icon.svg' }), /没有返回可用的图片/); } finally { svg.restore(); }
  const huge = stubFetch(() => respond(new Uint8Array(2 * 1024 * 1024 + 1).fill(0x89), 'image/png'));
  try { await assert.rejects(handleNetworkMessage({ type: 'tabcat:icon-image', url: 'https://cdn.example/huge.png' }), /响应过大/); } finally { huge.restore(); }
  const none = stubFetch(() => assert.fail('must not request'));
  try {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'https://user:pass@cdn.example/icon.png', '']) {
      await assert.rejects(handleNetworkMessage({ type: 'tabcat:icon-image', url }), /图标地址无效/);
    }
    assert.equal(none.calls.length, 0);
  } finally { none.restore(); }
});

test('simultaneous icon requests for one address make a single request', async () => {
  const stub = stubFetch(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return respond(PNG, 'image/png'); });
  try {
    const results = await Promise.all([1, 2, 3].map(() => handleNetworkMessage({ type: 'tabcat:icon-image', url: 'https://cdn.example/same.png' })));
    assert.equal(stub.calls.length, 1);
    assert.equal(new Set(results.map(result => result.image)).size, 1);
    // Once settled, a later request downloads again rather than serving a stale promise.
    await handleNetworkMessage({ type: 'tabcat:icon-image', url: 'https://cdn.example/same.png' });
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
});
