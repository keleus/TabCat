import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../lib/state.js';
import { iconRef, iconRefFile } from '../lib/icon-refs.js';
import { createIconSync, normalizeWebdavUrl, WEBDAV_STATUS, WEBDAV_SETTINGS } from '../lib/webdav.js';

const picture = fill => `data:image/webp;base64,${Buffer.from(new Uint8Array(300).fill(fill)).toString('base64')}`;

// A minimal WebDAV server: Basic auth, MKCOL, PUT, GET and PROPFIND.
function fakeServer({ user = 'me', password = 'secret' } = {}) {
  const files = new Map();
  const folders = new Set(['/dav/']);
  const requests = [];
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    requests.push(`${init.method} ${pathname}`);
    if (init.headers.Authorization !== `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`) return new Response('', { status: 401 });
    const parent = pathname.replace(/[^/]+\/?$/, '');
    if (init.method === 'PROPFIND') return new Response('<multistatus/>', { status: folders.has(pathname) ? 207 : 404 });
    if (init.method === 'MKCOL') {
      if (folders.has(pathname)) return new Response('', { status: 405 });
      if (!folders.has(parent)) return new Response('', { status: 409 });
      folders.add(pathname); return new Response('', { status: 201 });
    }
    if (init.method === 'PUT') {
      if (!folders.has(parent)) return new Response('', { status: 409 });
      files.set(pathname, new Uint8Array(init.body)); return new Response('', { status: 201 });
    }
    if (init.method === 'GET') return files.has(pathname) ? new Response(files.get(pathname)) : new Response('', { status: 404 });
    return new Response('', { status: 405 });
  };
  return { files, requests, fetch };
}

function area() {
  const data = {};
  return {
    data,
    async get(keys) { return Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, structuredClone(data[key])])); },
    async set(items) { Object.assign(data, structuredClone(items)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
}

function device(server, sites) {
  const local = area();
  local.data.tabcat = normalizeState({ sites });
  const alarms = { created: [], async clear() {}, async create(name, info) { this.created.push([name, info]); } };
  let queue = Promise.resolve();
  const icons = createIconSync({
    storage: { local }, alarms, fetch: server.fetch,
    enqueue: task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; },
    loadState: async () => normalizeState(local.data.tabcat), saveState: async state => { local.data.tabcat = state; },
  });
  return { local, alarms, icons, state: () => normalizeState(local.data.tabcat) };
}

test('WebDAV addresses need a scheme and always point at a folder', () => {
  assert.equal(normalizeWebdavUrl('https://dav.example.com/dav'), 'https://dav.example.com/dav/');
  assert.equal(normalizeWebdavUrl(' http://nas.local:5005/ '), 'http://nas.local:5005/');
  assert.equal(normalizeWebdavUrl('dav.example.com'), '');
  assert.equal(normalizeWebdavUrl('https://me:pw@dav.example.com/'), '');
  assert.equal(normalizeWebdavUrl('ftp://dav.example.com/'), '');
});

test('an uploaded icon goes to WebDAV once and arrives on the other device', async () => {
  const server = fakeServer();
  const icon = picture(7);
  const ref = await iconRef(icon);
  const laptop = device(server, [{ id: 'a', name: 'A', url: 'https://a.example', icon }]);
  await laptop.icons.save({ url: 'https://dav.example.com/dav', username: 'me', password: 'secret' });
  assert.ok(server.files.has(`/dav/TabCat/icons/${iconRefFile(ref)}`));
  assert.equal(laptop.local.data[WEBDAV_STATUS].error, '');
  // Nothing new to upload: no further PUT.
  const puts = server.requests.filter(line => line.startsWith('PUT')).length;
  await laptop.icons.reconcile();
  assert.equal(server.requests.filter(line => line.startsWith('PUT')).length, puts);

  // Browser sync delivered the reference to the desktop.
  const desktop = device(server, [{ id: 'a', name: 'A', url: 'https://a.example', icon: ref }]);
  await desktop.icons.save({ url: 'https://dav.example.com/dav/', username: 'me', password: 'secret' });
  assert.equal(desktop.state().sites[0].icon, icon);
  assert.equal(desktop.local.data[WEBDAV_STATUS].missing, 0);
});

test('a picture not on the server yet is retried later, a damaged one is refused', async () => {
  const server = fakeServer();
  const ref = await iconRef(picture(9));
  const desktop = device(server, [{ id: 'a', name: 'A', url: 'https://a.example', icon: ref }]);
  await desktop.icons.save({ url: 'https://dav.example.com/dav/', username: 'me', password: 'secret' });
  assert.equal(desktop.state().sites[0].icon, ref);
  assert.equal(desktop.local.data[WEBDAV_STATUS].missing, 1);
  assert.deepEqual(desktop.alarms.created.at(-1), ['tabcat:webdav-retry', { delayInMinutes: 30 }]);
  // Bytes that do not match the name are never shown.
  server.files.set(`/dav/TabCat/icons/${iconRefFile(ref)}`, new Uint8Array(300).fill(1));
  await desktop.icons.reconcile();
  assert.equal(desktop.state().sites[0].icon, ref);
  server.files.set(`/dav/TabCat/icons/${iconRefFile(ref)}`, new Uint8Array(300).fill(9));
  await desktop.icons.reconcile();
  assert.equal(desktop.state().sites[0].icon, picture(9));
});

test('wrong credentials are reported and nothing is saved', async () => {
  const server = fakeServer();
  const laptop = device(server, []);
  await assert.rejects(laptop.icons.save({ url: 'https://dav.example.com/dav/', username: 'me', password: 'nope' }), /用户名或密码不正确/);
  assert.equal(WEBDAV_SETTINGS in laptop.local.data, false);
  await assert.rejects(laptop.icons.save({ url: 'https://dav.example.com/missing/', username: 'me', password: 'secret' }), /地址不存在/);
});

test('an empty password keeps the saved one; a new server forgets it', async () => {
  const server = fakeServer();
  const laptop = device(server, []);
  await laptop.icons.save({ url: 'https://dav.example.com/dav/', username: 'me', password: 'secret' });
  await laptop.icons.save({ url: 'https://dav.example.com/dav/', username: 'me', password: '' });
  assert.equal(laptop.local.data[WEBDAV_SETTINGS].password, 'secret');
  await assert.rejects(laptop.icons.save({ url: 'https://other.example.com/dav/', username: 'me', password: '' }), /用户名或密码不正确/);
  await laptop.icons.clear();
  assert.equal(WEBDAV_SETTINGS in laptop.local.data, false);
});

test('a failed pass records the error and schedules a retry', async () => {
  const server = fakeServer();
  let online = false;
  const laptop = device({ fetch: (...args) => online ? server.fetch(...args) : Promise.reject(new TypeError('offline')) }, [{ id: 'a', name: 'A', url: 'https://a.example', icon: picture(3) }]);
  laptop.local.data[WEBDAV_SETTINGS] = { url: 'https://dav.example.com/dav/', username: 'me', password: 'secret' };
  await laptop.icons.reconcile();
  assert.match(laptop.local.data[WEBDAV_STATUS].error, /无法连接/);
  assert.deepEqual(laptop.alarms.created.at(-1), ['tabcat:webdav-retry', { delayInMinutes: 5 }]);
  online = true;
  await laptop.icons.reconcile();
  assert.equal(laptop.local.data[WEBDAV_STATUS].error, '');
  assert.equal(server.files.size, 1);
});
