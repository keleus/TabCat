import { createServer } from 'node:http';
import { test as base, expect, chromium } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { SITE_CATALOG } from '../../lib/site-catalog.js';

const test = base.extend({
  extension: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'tabcat-e2e-'));
    const extensionPath = resolve('.output/chrome-mv3');
    const launchOptions = {
      channel: 'chromium', headless: true,
      executablePath: process.env.TABCAT_CHROMIUM_PATH || undefined,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      viewport: { width: 1360, height: 900 },
    };
    const context = await chromium.launchPersistentContext(profile, launchOptions);
    const errors = [];
    context.on('page', page => page.on('pageerror', error => { if (page.url().startsWith('chrome-extension://') || page.url().startsWith('chrome://newtab')) errors.push(error.message); }));
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const id = new URL(worker.url()).host;
      const home = await context.newPage();
      await home.goto('chrome://newtab/');
      await expect(home.locator('#sitesPages .site-card[data-site]')).toHaveCount(8);
      await use({ context, worker, home, id, errors, profile, launchOptions });
      expect(errors).toEqual([]);
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  },
});

async function openAction(context, id, page) {
  await page.bringToFront();
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
  const tab = targetInfos.find(target => target.type === 'tab' && target.url === page.url());
  await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
  let popup;
  await expect.poll(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
    popup = targetInfos.find(target => target.type === 'page' && target.url === `chrome-extension://${id}/popup.html`);
    return Boolean(popup);
  }).toBe(true);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: false });
  let sequence = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error(`Popup CDP timeout: ${method}`)); }, 5000);
    const listener = event => {
      const message = JSON.parse(event.message);
      if (event.sessionId !== sessionId || message.id !== requestId) return;
      clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', listener);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: requestId, method, params }) }).catch(reject);
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await expect.poll(() => evaluate('Boolean(document.querySelector("#pinButton"))')).toBe(true);
  return { evaluate, send, close: () => cdp.send('Target.closeTarget', { targetId: popup.targetId }) };
}

async function settings(home, tab) {
  await home.locator('#settingsButton').click();
  await home.locator(`.settings-tabs [data-tab="${tab}"]`).click();
}

async function desktopMenu(home, name) {
  // A pending viewport resize dismisses menus; let responsive layout settle first.
  await home.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await home.mouse.click(16, 130, { button: 'right' });
  await home.getByRole('menuitem', { name, exact: true }).click();
}
async function addWebsite(home) { await desktopMenu(home, '添加网站'); await home.locator('#libraryCustom').click(); }

test('closed settings panel never paints into the right edge on startup, resize or after closing', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await home.addInitScript(() => {
    window.panelStartupFrames = [];
    const sample = () => {
      const panel = document.querySelector('#settingsPanel');
      if (panel) window.panelStartupFrames.push(getComputedStyle(panel).visibility);
      if (window.panelStartupFrames.length < 12) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  for (const [width, theme] of [[1360, 'light'], [680, 'dark'], [390, 'light']]) {
    await worker.evaluate(async theme => {
      const { tabcat = {} } = await chrome.storage.local.get('tabcat');
      await chrome.storage.local.set({ tabcat: { ...tabcat, theme } });
    }, theme);
    await home.setViewportSize({ width, height: 900 });
    await home.reload();
    await expect.poll(() => home.evaluate(() => window.panelStartupFrames.length)).toBe(12);
    expect(await home.evaluate(() => window.panelStartupFrames)).toEqual(Array(12).fill('hidden'));
    const panel = home.locator('#settingsPanel');
    await expect(panel).toHaveCSS('visibility', 'hidden');
    await expect(panel).toHaveCSS('pointer-events', 'none');
    await home.locator('#settingsButton').click();
    await expect(panel).toHaveCSS('visibility', 'visible');
    await expect(home.locator('#closeSettings')).toBeFocused();
    await home.locator('#closeSettings').click();
    await expect(panel).toHaveCSS('visibility', 'hidden');
    await expect(home.locator('#settingsButton')).toBeFocused();
    await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).not.toBe('');
    // Removing an already-closed panel must not change even its shadow pixels.
    const clip = { x: width - 90, y: 180, width: 90, height: 400 };
    const normal = await home.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`right-edge-${width}.png`) });
    await panel.evaluate(panel => { panel.style.display = 'none'; });
    const removed = await home.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`right-edge-removed-${width}.png`) });
    const changedPixels = await home.evaluate(async sources => {
      const pixels = await Promise.all(sources.map(async source => {
        const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      }));
      // Removing a compositor layer may round a color channel by one level.
      let changed = 0;
      for (let i = 0; i < pixels[0].length; i += 4) if ([0, 1, 2].some(channel => Math.abs(pixels[0][i + channel] - pixels[1][i + channel]) > 1)) changed++;
      return changed;
    }, [normal.toString('base64'), removed.toString('base64')]);
    expect(changedPixels, `closed panel must not affect right-edge pixels at ${width}px`).toBe(0);
    await panel.evaluate(panel => { panel.style.removeProperty('display'); });
  }
  await home.emulateMedia({ reducedMotion: 'reduce' });
  await home.locator('#settingsButton').click();
  await expect(home.locator('#closeSettings')).toBeFocused();
  await home.keyboard.press('Escape');
  await expect(home.locator('#settingsPanel')).toHaveCSS('visibility', 'hidden');
});

test('dialogs dismiss on backdrop clicks without saving or closing the underlying settings', async ({ extension }) => {
  const { home } = extension;
  const dismiss = async selector => {
    const dialog = home.locator(selector);
    await expect(dialog).toBeVisible();
    // Padding belongs to the dialog, even when the event targets the dialog itself.
    await dialog.click({ position: { x: 10, y: 10 } });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    await home.mouse.move(box.x + 10, box.y + 10); await home.mouse.down();
    await home.mouse.move(4, 4); await home.mouse.up();
    await expect(dialog).toBeVisible();
    await home.mouse.click(4, 4);
    await expect(dialog).toBeHidden();
  };
  await desktopMenu(home, '添加网站');
  await expect(home.locator('#siteLibraryModal')).toBeVisible();
  await home.mouse.click(4, 4); await expect(home.locator('#siteLibraryModal')).toBeVisible();
  await home.keyboard.press('Escape'); await expect(home.locator('#siteLibraryModal')).toBeHidden();
  await addWebsite(home);
  await home.locator('#siteName').fill('未保存的网站');
  await dismiss('#siteModal');
  await expect(home.locator('.site-card[data-site]')).toHaveCount(8);
  await home.locator('[data-site="github"]').click({ button: 'right' });
  await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
  await home.locator('#siteName').fill('未保存的修改');
  await dismiss('#siteModal');
  await expect(home.locator('[data-site="github"]')).toHaveAttribute('title', 'GitHub');
  await settings(home, 'search');
  const engines = await home.locator('#engineList .sort-item').count();
  await home.locator('#addEngineButton').click();
  await home.locator('#engineName').fill('未保存的引擎');
  await dismiss('#engineModal');
  await expect(home.locator('#engineList .sort-item')).toHaveCount(engines);
  await expect(home.locator('#addEngineButton')).toBeFocused();
  await expect(home.locator('#settingsPanel')).toHaveAttribute('aria-hidden', 'false');
  await home.locator('[data-tab="data"]').click();
  await home.locator('#backupFile').setInputFiles(resolve('tests/fixtures/imports/infinity-v2.json'));
  await dismiss('#importPreviewModal');
  await expect(home.locator('#importData')).toBeFocused();
  await expect(home.locator('.site-card[data-site]')).toHaveCount(8);
  await expect(home.locator('#settingsPanel')).toHaveAttribute('aria-hidden', 'false');
  await home.mouse.click(4, 4);
  await expect(home.locator('#settingsPanel')).toHaveAttribute('aria-hidden', 'true');
  await home.setViewportSize({ width: 390, height: 844 });
  await desktopMenu(home, '添加网站');
  await expect(home.locator('#siteLibraryModal')).toBeVisible();
  await home.mouse.click(4, 4); await expect(home.locator('#siteLibraryModal')).toBeVisible();
  await home.keyboard.press('Escape'); await expect(home.locator('#siteLibraryModal')).toBeHidden();
});

test('reset confirmation cancels from the backdrop and Escape, and resets only after confirmation', async ({ extension }) => {
  const { home, worker } = extension;
  await settings(home, 'search');
  await home.locator('#addEngineButton').click();
  await home.locator('#engineName').fill('自定义引擎');
  await home.locator('#engineUrl').fill('https://example.com/search?q=%s');
  await home.locator('#engineForm .primary-button').click();
  const hasCustomEngine = () => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.engines.some(engine => engine.name === '自定义引擎'));
  await expect.poll(hasCustomEngine).toBe(true);
  await home.locator('[data-tab="data"]').click();
  await home.locator('#resetButton').click();
  await expect(home.locator('#resetForm [value="cancel"]')).toBeFocused();
  await home.mouse.click(4, 4);
  await expect(home.locator('#resetModal')).toBeHidden();
  await expect(home.locator('#resetButton')).toBeFocused();
  expect(await hasCustomEngine()).toBe(true);
  await home.locator('#resetButton').click(); await home.keyboard.press('Escape');
  await expect(home.locator('#resetModal')).toBeHidden();
  expect(await hasCustomEngine()).toBe(true);
  await home.locator('#resetButton').click(); await home.locator('#resetForm [value="cancel"]').click();
  expect(await hasCustomEngine()).toBe(true);
  await home.locator('#resetButton').click(); await home.locator('#resetForm [value="confirm"]').click();
  await expect(home.locator('#resetModal')).toBeHidden();
  await expect.poll(hasCustomEngine).toBe(false);
});

test('shortcut opening mode defaults to new tabs and persists current-tab selection across pages', async ({ extension }, testInfo) => {
  const { home, context, worker, id } = extension;
  await context.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Shortcut destination</title>' }));
  const homeUrl = home.url();
  const opened = context.waitForEvent('page');
  await home.locator('[data-site="github"]').click();
  const destination = await opened;
  await expect(destination).toHaveURL('https://github.com/');
  await expect(home).toHaveURL(homeUrl);
  await destination.close();

  const other = await context.newPage();
  await other.goto(`chrome-extension://${id}/newtab.html`);
  await settings(other, 'sites');
  await settings(home, 'sites');
  const mode = home.getByLabel('快捷方式打开方式', { exact: true });
  await expect(mode).toHaveValue('true');
  await mode.selectOption('false');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.shortcutOpenInNewTab)).toBe(false);
  await expect(other.getByLabel('快捷方式打开方式', { exact: true })).toHaveValue('false');
  await other.close();
  await home.reload();
  await settings(home, 'sites');
  await expect(mode).toHaveValue('false');
  await home.screenshot({ path: testInfo.outputPath('shortcut-opening-settings.png'), animations: 'disabled' });
  await home.locator('#closeSettings').click();

  const pageCount = context.pages().length;
  await home.locator('[data-site="github"]').click();
  await expect(home).toHaveURL('https://github.com/');
  expect(context.pages()).toHaveLength(pageCount);

  await home.goto(homeUrl);
  await settings(home, 'sites');
  await mode.selectOption('true');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.shortcutOpenInNewTab)).toBe(true);
  await home.locator('#closeSettings').click();
  await home.locator('[data-site="builtin-history"]').click();
  const cdp = await context.browser().newBrowserCDPSession();
  await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.some(target => target.url === 'chrome://history/')).toBe(true);
  await cdp.detach();
  await expect(home).toHaveURL(homeUrl);
});

test('optional bookmark bar mirrors Chrome folders, changes, opening behavior and saved visibility', async ({ extension }, testInfo) => {
  const { home, worker, context } = extension;
  await expect(home.locator('#bookmarkBar')).toBeHidden();
  const bookmarks = await worker.evaluate(async () => {
    const [root] = await chrome.bookmarks.getTree();
    const bar = root.children.find(node => node.folderType === 'bookmarks-bar' || node.id === '1');
    const first = await chrome.bookmarks.create({ parentId: bar.id, title: '测试书签', url: 'https://bookmark.example/one' });
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: '开发资料' });
    const nested = await chrome.bookmarks.create({ parentId: folder.id, title: '子文件夹' });
    const leaf = await chrome.bookmarks.create({ parentId: nested.id, title: '嵌套书签', url: 'https://bookmark.example/nested' });
    const unsafe = await chrome.bookmarks.create({ parentId: bar.id, title: '脚本书签', url: 'javascript:alert(1)' });
    return { first, folder, nested, leaf, unsafe, bar };
  });
  await settings(home, 'sites'); await home.getByRole('checkbox', { name: '显示书签栏', exact: true }).check();
  await expect(home.locator('#bookmarkBar')).toBeVisible();
  await home.locator('#closeSettings').click();
  await expect(home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.first.id}"]`)).toHaveText('测试书签');
  await expect(home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.unsafe.id}"]`)).toBeDisabled();
  await home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.folder.id}"]`).click();
  await home.locator(`#bookmarkFolderMenu [data-bookmark-id="${bookmarks.nested.id}"]`).click();
  await expect(home.locator(`#bookmarkFolderMenu [data-bookmark-id="${bookmarks.leaf.id}"]`)).toBeVisible();
  await home.screenshot({ path: testInfo.outputPath('bookmark-bar.png'), animations: 'disabled' });
  await home.locator('#bookmarkFolderMenu .bookmark-back:not(:disabled)').last().click();
  await expect(home.locator(`#bookmarkFolderMenu [data-bookmark-id="${bookmarks.nested.id}"]`)).toBeFocused();
  await home.keyboard.press('Escape'); await expect(home.locator('#bookmarkFolderMenu')).toBeHidden();
  await expect(home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.folder.id}"]`)).toBeFocused();
  await worker.evaluate(async id => { await chrome.bookmarks.update(id, { title: '已重命名' }); }, bookmarks.first.id);
  await expect(home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.first.id}"]`)).toHaveText('已重命名');
  await worker.evaluate(async ({ first, folder }) => { await chrome.bookmarks.move(first.id, { parentId: folder.id }); }, bookmarks);
  await expect(home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.first.id}"]`)).toHaveCount(0);
  await worker.evaluate(async ({ first, bar }) => { await chrome.bookmarks.move(first.id, { parentId: bar.id, index: 0 }); }, bookmarks);
  await expect(home.locator('#bookmarkBarItems .bookmark-entry').first()).toHaveAttribute('data-bookmark-id', bookmarks.first.id);
  await settings(home, 'search'); await home.locator('#openInNewTab').check(); await home.locator('#closeSettings').click();
  await context.route('https://bookmark.example/**', route => route.fulfill({ body: '<title>书签目标</title>' }));
  const opened = context.waitForEvent('page'); await home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.first.id}"]`).click();
  const destination = await opened; await expect.poll(() => destination.url()).toBe(bookmarks.first.url);
  await expect(destination.locator('#bookmarkBar')).toHaveCount(0); await destination.close();
  await home.reload(); await expect(home.locator('#bookmarkBar')).toBeVisible();
  const other = await context.newPage(); await other.goto('chrome://newtab/'); await expect(other.locator('#bookmarkBar')).toBeVisible();
  await settings(home, 'sites'); await home.locator('#showBookmarksBar').uncheck(); await expect(other.locator('#bookmarkBar')).toBeHidden();
  await home.locator('#closeSettings').click(); await home.reload(); await expect(home.locator('#bookmarkBar')).toBeHidden();
  await settings(home, 'sites'); await home.locator('#showBookmarksBar').check(); await home.locator('#closeSettings').click();
  await worker.evaluate(async id => { await chrome.bookmarks.remove(id); }, bookmarks.first.id);
  await expect(home.locator(`#bookmarkBar [data-bookmark-id="${bookmarks.first.id}"]`)).toHaveCount(0);
  await home.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('frost controls default off, bookmark transparency persists and select pickers share the app style', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  expect(await home.evaluate(() => ['--background-dim', '--background-frost', '--background-blur'].map(key => document.documentElement.style.getPropertyValue(key)))).toEqual(['0', '0', '0px']);
  await settings(home, 'sites'); await home.locator('#showBookmarksBar').check();
  await expect(home.locator('#bookmarkBarTransparency')).toHaveValue('20');
  expect(await home.locator('#bookmarkBar').evaluate(bar => getComputedStyle(bar).backdropFilter)).toContain('blur(18px)');
  await home.locator('#bookmarkBarTransparency').evaluate(input => { input.value = '75'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(home.locator('#bookmarkBarTransparencyValue')).toHaveText('75%');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.bookmarkBarTransparency)).toBe(75);
  expect(await home.evaluate(() => document.documentElement.style.getPropertyValue('--bookmark-bar-opacity'))).toBe('25%');
  await home.locator('[data-tab="wallpaper"]').click();
  for (const [key, value] of [['backgroundFrost','24'], ['backgroundDim','30'], ['backgroundBlur','12']]) {
    await home.locator(`#${key}`).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  }
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.backgroundBlur)).toBe(12);
  await home.reload(); await settings(home, 'wallpaper');
  expect(await home.evaluate(() => ['--background-dim', '--background-frost', '--background-blur', '--bookmark-bar-opacity'].map(key => document.documentElement.style.getPropertyValue(key)))).toEqual(['0.3', '0.24', '12px', '25%']);
  await home.locator('#background').click();
  await expect(home.locator('#background')).toHaveCSS('appearance', 'base-select');
  await expect(home.locator('#background')).toHaveJSProperty('value', 'fjord');
  await expect(home.locator('#background option[value="custom"]')).toBeVisible();
  expect(await home.locator('#background').evaluate(el => getComputedStyle(el, '::picker(select)').borderRadius)).toBe('13px');
  await home.screenshot({ path: testInfo.outputPath('styled-select-light.png'), animations: 'disabled' });
  await home.keyboard.press('Escape');
  await expect(home.locator('#settingsPanel')).toHaveAttribute('aria-hidden', 'false');
  await home.locator('#background').click(); await home.locator('#background option[value="custom"]').click();
  await expect(home.locator('#backgroundUrlField')).toBeVisible();
  await home.locator('[data-tab="appearance"]').click(); await home.locator('#theme').selectOption('dark');
  await home.locator('#theme').click(); await home.screenshot({ path: testInfo.outputPath('styled-select-dark.png'), animations: 'disabled' });
  await home.keyboard.press('Escape'); await home.locator('#closeSettings').click();
  await home.locator('[data-site="github"]').click({ button: 'right' }); await home.getByRole('menuitem', { name: '编辑快捷方式', exact: true }).click();
  await home.locator('#siteImageFit').click(); await expect(home.locator('#siteImageFit option[value="contain"]')).toBeVisible();
  await home.locator('#siteImageFit option[value="contain"]').click();
  await expect(home.locator('#siteImageFit')).toHaveValue('contain');
  await home.locator('#saveSiteButton').click();
});

test('toolbar action reads current page, pins once, updates open home and survives reload', async ({ extension }, testInfo) => {
  const { context, home, id } = extension;
  const page = await context.newPage();
  await page.route('https://tabcat.example/**', route => route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><title>我的测试网页</title><h1>TabCat test</h1>' }));
  await page.goto('https://tabcat.example/article?q=1#details');
  const popup = await openAction(context, id, page);
  await expect.poll(() => popup.evaluate('document.querySelector("#siteName").value')).toBe('我的测试网页');
  expect(await popup.evaluate('document.querySelector("#siteUrl").value')).toBe(page.url());
  await popup.evaluate('document.querySelector("#pinButton").click()');
  await expect.poll(() => popup.evaluate('document.querySelector("#status").textContent')).toContain('已添加');
  await expect(home.locator('.site-card[title="我的测试网页"]')).toHaveCount(1);
  expect(await popup.evaluate('document.querySelector("#pinButton").disabled')).toBe(true);
  await expect.poll(() => popup.evaluate('document.documentElement.scrollHeight <= innerHeight')).toBe(true);
  const { data } = await popup.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(testInfo.outputPath('popup.png'), Buffer.from(data, 'base64'));
  await popup.close();
  const again = await openAction(context, id, page);
  await expect.poll(() => again.evaluate('document.querySelector("#pinButton").textContent')).toContain('已固定');
  await again.close();
  await home.reload();
  await expect(home.locator('.site-card[title="我的测试网页"]')).toHaveCount(1);
  await home.screenshot({ path: testInfo.outputPath('home.png'), fullPage: true, animations: 'disabled' });
});

test('unsupported browser pages cannot be pinned', async ({ extension }) => {
  const { context, home, id } = extension;
  await home.goto('chrome://settings/');
  const popup = await openAction(context, id, home);
  await expect.poll(() => popup.evaluate('document.querySelector("#status").textContent')).toContain('此页面不支持添加');
  expect(await popup.evaluate('document.querySelector("#pinButton").disabled')).toBe(true);
  await popup.close();
});

test('appearance and layout persist across tabs; links honor new-tab setting', async ({ extension }, testInfo) => {
  const { home, context, id, worker } = extension;
  const second = await context.newPage();
  await second.goto(`chrome-extension://${id}/newtab.html`);
  await settings(home, 'appearance');
  await home.locator('#theme').selectOption('dark');
  await home.locator('[data-tab="wallpaper"]').click();
  await home.locator('#background').selectOption('custom');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(second.locator('html')).toHaveAttribute('data-background', 'custom');
  await home.locator('[data-tab="sites"]').click();
  await home.locator('#layoutColumns').selectOption('4');
  await home.locator('#layoutRows').selectOption('1');
  await expect(home.locator('.page-dot')).toHaveCount(2);
  await home.locator('[data-tab="search"]').click();
  await home.locator('#openInNewTab').check({ force: true });
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.openInNewTab)).toBe(true);
  await home.locator('#closeSettings').click();
  await home.screenshot({ path: testInfo.outputPath('dark.png'), fullPage: true, animations: 'disabled' });
  await home.locator('#searchInput').fill('TabCat 空格 & test');
  await context.route('https://www.google.com/search?*', route => route.fulfill({ body: '<title>Search results test</title>' }));
  const opened = context.waitForEvent('page');
  await home.locator('#searchForm').press('Enter');
  const results = await opened;
  await expect.poll(() => results.url()).toContain('google.com/search?q=TabCat%20');
  await home.reload();
  await expect(home.locator('html')).toHaveAttribute('data-theme', 'dark');
  await home.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await home.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true, animations: 'disabled' });
});

test('manual add/edit/delete, cancel and invalid search URL recovery', async ({ extension }) => {
  const { home } = extension;
  await addWebsite(home);
  await home.locator('#siteForm button[value="cancel"]').last().click();
  await expect(home.locator('#siteModal')).not.toBeVisible();
  await addWebsite(home);
  await home.locator('#siteName').fill('手动添加');
  await home.locator('#siteUrl').fill('javascript:alert(1)');
  await home.locator('#saveSiteButton').click();
  await expect(home.locator('#siteModal')).toBeVisible();
  await home.locator('#siteUrl').fill('https://manual.example/path');
  await home.locator('#saveSiteButton').click();
  await expect(home.locator('.site-card[title="手动添加"]')).toHaveCount(1);
  await home.locator('.site-card[title="手动添加"]').click({ button: 'right' });
  await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
  await home.locator('#siteName').fill('修改名称');
  await home.locator('#saveSiteButton').click();
  await expect(home.locator('.site-card[title="修改名称"]')).toHaveCount(1);
  await home.locator('#editDesktopButton').click();
  await home.getByRole('button', { name: '移除 修改名称', exact: true }).click();
  await expect(home.locator('.site-card[title="修改名称"]')).toHaveCount(0);
  await home.locator('#finishEditing').click();
  await settings(home, 'search');
  await home.locator('#addEngineButton').click();
  await home.locator('#engineName').fill('Test search');
  await home.locator('#engineUrl').fill('https://search.example/no-placeholder');
  await home.locator('#engineForm button[value="default"]').click();
  await expect(home.locator('#engineModal')).toBeVisible();
  await home.locator('#engineUrl').fill('https://search.example/?q=%s');
  await home.locator('#engineForm button[value="default"]').click();
  await expect(home.locator('#engineModal')).not.toBeVisible();
  await expect(home.locator('#engineList')).toContainText('Test search');
});

test('concurrent writes from separate pages preserve both additions and settings', async ({ extension }) => {
  const { home, context, id } = extension;
  const second = await context.newPage();
  await second.goto(`chrome-extension://${id}/newtab.html`);
  // The first write initializes storage through the actual settings UI.
  await settings(home, 'appearance');
  await home.locator('#theme').selectOption('dark');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  const snapshot = await home.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat);
  const after = structuredClone(snapshot); after.iconSize = 80;
  const responses = await Promise.all([
    home.evaluate(() => chrome.runtime.sendMessage({ type: 'tabcat:pin', site: { name: '并发添加', url: 'https://concurrent.example/' } })),
    second.evaluate(({ before, after }) => chrome.runtime.sendMessage({ type: 'tabcat:commit', before, after }), { before: snapshot, after }),
  ]);
  expect(responses.every(result => result.ok)).toBe(true);
  await expect(home.locator('.site-card[title="并发添加"]')).toHaveCount(1);
  const final = await home.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat);
  expect(final.iconSize).toBe(80);
  expect(final.sites.some(site => site.name === '并发添加')).toBe(true);
});


test('saved shortcuts and settings survive a browser restart', async ({ extension }) => {
  const { context, home, profile, launchOptions, id } = extension;
  await home.evaluate(() => chrome.runtime.sendMessage({ type: 'tabcat:pin', site: { name: '保留网站', url: 'https://persist.example/' } }));
  await settings(home, 'appearance');
  await home.locator('#theme').selectOption('dark');
  await expect.poll(() => home.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.theme)).toBe('dark');
  await context.close();
  const restarted = await chromium.launchPersistentContext(profile, launchOptions);
  try {
    const page = await restarted.newPage();
    await page.goto(`chrome-extension://${id}/newtab.html`);
    await expect(page.locator('.site-card[title="保留网站"]')).toHaveCount(1);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  } finally { await restarted.close(); }
});

test('desktop is quiet, drag reorders, and context removal can be undone', async ({ extension }, testInfo) => {
  const { home } = extension;
  await expect(home.locator('.hero')).toBeHidden();
  await expect(home.locator('.section-heading')).toHaveCount(0);
  await home.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true, animations: 'disabled' });
  await desktopMenu(home, '进入编辑模式');
  await home.locator('[data-site="github"]').dragTo(home.locator('[data-site="zhihu"]'), { targetPosition: { x: 98, y: 35 } });
  await expect.poll(() => home.locator('.site-card[data-site]').evaluateAll(cards => cards.slice(0, 4).map(card => card.dataset.site))).toEqual(['youtube','bilibili','zhihu','github']);
  await home.reload();
  await expect(home.locator('.site-card[data-site]').first()).toHaveAttribute('data-site', 'youtube');
  await home.locator('[data-site="youtube"]').click({ button: 'right' });
  await home.getByRole('menuitem', { name: '移除快捷方式' }).click();
  await expect(home.locator('[data-site="youtube"]')).toHaveCount(0);
  await home.locator('#status').getByRole('button', { name: '撤销' }).click();
  await expect(home.locator('[data-site="youtube"]')).toHaveCount(1);
  await home.keyboard.press('/');
  await expect(home.locator('#searchInput')).toBeFocused();
});

test('icons make room before release, stay stable, and restore on cancelled drags', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await settings(home, 'sites');
  await home.locator('#layoutColumns').selectOption('4');
  await home.locator('#layoutRows').selectOption('2');
  await home.locator('#closeSettings').click();
  await home.locator('#settingsPanel').evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  await desktopMenu(home, '进入编辑模式');
  const tile = id => home.locator(`#sitesPages [data-desktop-key="site:${id}"]`);
  await expect.poll(() => home.locator('#sitesPages').evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  const source = await tile('github').boundingBox(), target = await tile('notion').boundingBox();
  const original = await tile('youtube').boundingBox();
  const savedOrder = () => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.desktopOrder);
  const before = await savedOrder();
  const start = async () => {
    await home.mouse.move(source.x + 35, source.y + 35); await home.mouse.down();
    await home.mouse.move(source.x + 48, source.y + 35, { steps: 5 });
    await home.mouse.move(target.x + target.width - 4, target.y + 35, { steps: 12 });
    await home.mouse.move(target.x + target.width - 3, target.y + 35);
  };
  await start();
  await expect(home.locator('.desktop-drop-slot')).toBeVisible();
  await expect.poll(async () => Math.round((await tile('youtube').boundingBox()).x)).toBe(Math.round(source.x));
  await expect.poll(async () => Math.round((await tile('notion').boundingBox()).y)).toBe(Math.round(source.y));
  expect(await savedOrder()).toEqual(before);
  // Repeated native dragover events at one point must not undo the preview.
  for (let i = 0; i < 4; i++) await home.mouse.move(target.x + target.width - 3, target.y + 35);
  expect(Math.round((await tile('youtube').boundingBox()).x)).toBe(Math.round(source.x));
  await home.screenshot({ path: testInfo.outputPath('icons-live-reorder.png') });
  await home.keyboard.press('Escape'); await home.mouse.up();
  await expect(home.locator('.desktop-drop-slot')).toHaveCount(0);
  await expect.poll(async () => Math.round((await tile('youtube').boundingBox()).x)).toBe(Math.round(original.x));
  expect(await savedOrder()).toEqual(before);
  await start(); await home.mouse.up();
  await expect.poll(async () => (await savedOrder()).slice(0, 5).map(item => item.id)).toEqual(['site:youtube', 'site:bilibili', 'site:zhihu', 'site:notion', 'site:github']);
  await home.reload();
  await expect(tile('youtube')).toBeVisible();
  expect((await savedOrder()).slice(0, 5).map(item => item.id)).toEqual(['site:youtube', 'site:bilibili', 'site:zhihu', 'site:notion', 'site:github']);
});

test('local wallpaper and backup restore work through the settings UI', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await home.locator('#wallpaperButton').click();
  await expect(home.locator('[data-page="wallpaper"]')).toBeVisible();
  await home.screenshot({ path: testInfo.outputPath('wallpaper-settings.png'), fullPage: true, animations: 'disabled' });
  await home.locator('#wallpaperFile').setInputFiles(resolve('public/wallpapers/fjord.png'));
  await expect(home.locator('html')).toHaveAttribute('data-background', 'local');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.backgroundLocal.startsWith('data:image/webp;'))).toBe(true);
  await home.locator('[data-tab="data"]').click();
  const downloadPromise = home.waitForEvent('download');
  await home.locator('#exportData').click();
  const download = await downloadPromise;
  await download.saveAs(testInfo.outputPath('backup.json'));
  const { readFile } = await import('node:fs/promises');
  const backup = JSON.parse(await readFile(testInfo.outputPath('backup.json'), 'utf8'));
  expect(backup.format).toBe('tabcat');
  expect(backup.state.backgroundLocal).toContain('data:image/webp;');
  backup.state.sites.push({ id: 'restored', name: '恢复的网站', url: 'https://restore.example/' });
  await home.locator('#backupFile').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(home.locator('#importPreviewModal')).toBeVisible();
  await home.locator('#confirmImport').click();
  await expect(home.locator('[data-site="restored"]')).toHaveCount(1);
  await home.locator('#backupFile').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await expect(home.locator('#status')).toContainText('无法读取 JSON');
  await expect(home.locator('[data-site="restored"]')).toHaveCount(1);
  await home.locator('#closeSettings').click();
  await home.reload();
  await expect(home.locator('html')).toHaveAttribute('data-background', 'local');
  await expect(home.locator('[data-site="restored"]')).toHaveCount(1);
});

test('wallpaper shadows follow decoded brightness, dimming and frost', async ({ extension }) => {
  const { home, worker } = extension;
  const images = await home.evaluate(() => Object.fromEntries(['#151515', '#eeeeee'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 64, 64);
    return [color, canvas.toDataURL()];
  })));
  async function change(values) {
    await worker.evaluate(async values => {
      const { tabcat } = await chrome.storage.local.get('tabcat');
      await chrome.storage.local.set({ tabcat: { ...tabcat, ...values } });
    }, values);
  }
  const shadow = () => home.locator('#clock').evaluate(element => getComputedStyle(element).textShadow);
  await change({ background: 'local', backgroundLocal: images['#151515'], labelColor: 'light', showClock: true, backgroundDim: 0, backgroundFrost: 0 });
  await expect.poll(shadow).toBe('none');
  await change({ backgroundLocal: images['#eeeeee'] });
  await expect.poll(shadow).not.toBe('none');
  await change({ backgroundDim: 70 });
  await expect.poll(shadow).toBe('none');
  await change({ backgroundLocal: images['#151515'], backgroundDim: 0, backgroundFrost: 60 });
  await expect.poll(shadow).not.toBe('none');
  await change({ backgroundFrost: 0 });
  await expect.poll(shadow).toBe('none');
  await home.reload();
  await expect.poll(shadow).toBe('none');
  for (const selector of ['#dateText', '#wallpaperName', '#sitesPages .site-name']) {
    await expect(home.locator(selector).first()).toHaveCSS('text-shadow', 'none');
  }
  await change({ labelColor: 'dark' });
  await expect.poll(shadow).not.toBe('none');
});

test('fine layout controls, clock toggle and narrow settings stay usable', async ({ extension }, testInfo) => {
  const { home } = extension;
  await settings(home, 'search');
  await home.locator('#searchWidth').focus();
  await home.locator('#searchWidth').press('End');
  await expect(home.locator('#searchWidthValue')).toHaveText('760px');
  await home.locator('#showSearch').uncheck();
  await expect(home.locator('#searchForm')).toBeHidden();
  await home.locator('#showSearch').check();
  await home.locator('[data-tab="time"]').click();
  await home.locator('#showClock').check();
  await expect(home.locator('.hero')).toBeVisible();
  await home.locator('[data-tab="appearance"]').click();
  await home.locator('#theme').selectOption('dark');
  await home.screenshot({ path: testInfo.outputPath('dark-settings.png'), fullPage: true, animations: 'disabled' });
  await home.setViewportSize({ width: 390, height: 844 });
  await home.screenshot({ path: testInfo.outputPath('narrow-settings.png'), fullPage: true, animations: 'disabled' });
  await expect.poll(() => home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await home.locator('#closeSettings').click();
  await expect(home.locator('#settingsButton')).toBeFocused();
  await home.screenshot({ path: testInfo.outputPath('narrow-desktop.png'), fullPage: true, animations: 'disabled' });
});

test('mouse drags dock blank space to turn pages, snaps back and works while editing', async ({ extension }) => {
  const { home, worker } = extension;
  await expect(home.locator('.sites-section')).toBeVisible();
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); await chrome.storage.local.set({ tabcat: { ...tabcat, layoutColumns: 4, layoutRows: 1 } }); });
  await expect(home.locator('.page-dot')).toHaveCount(2);
  const viewport = home.locator('#sitesViewport'), active = home.locator('.page-dot.active');
  const box = await viewport.boundingBox();
  const x = box.x + box.width / 2, y = box.y + 3;
  const swipe = async (dx, button = 'left') => { await home.mouse.move(x, y); await home.mouse.down({ button }); await home.mouse.move(x + dx, y, { steps: 8 }); await home.mouse.up({ button }); };
  await home.mouse.move(x, y); await home.mouse.down(); await home.mouse.move(x - 100, y, { steps: 8 });
  await expect(home.locator('.sites-section')).toHaveClass(/page-panning/);
  await expect(active).toHaveAttribute('data-page', '0');
  expect(await home.locator('#sitesPages').evaluate(node => getComputedStyle(node).transform)).not.toBe('matrix(1, 0, 0, 1, 0, 0)');
  await home.mouse.up(); await expect(active).toHaveAttribute('data-page', '1');
  await swipe(-100); await expect(active).toHaveAttribute('data-page', '1');
  await swipe(20); await expect(active).toHaveAttribute('data-page', '1');
  await swipe(100); await expect(active).toHaveAttribute('data-page', '0');
  await swipe(100); await expect(active).toHaveAttribute('data-page', '0');
  await swipe(-100, 'right'); await expect(active).toHaveAttribute('data-page', '0');
  await home.keyboard.press('Escape');
  await home.mouse.move(x, y); await home.mouse.down(); await home.mouse.move(x - 100, y, { steps: 8 }); await home.keyboard.press('Escape'); await home.mouse.up();
  await expect(active).toHaveAttribute('data-page', '0'); await expect(home.locator('.sites-section')).not.toHaveClass(/page-panning/);
  // Captured pointer release outside the grid still completes exactly one page turn.
  await swipe(-box.width); await expect(active).toHaveAttribute('data-page', '1');
  await home.locator('#editDesktopButton').click();
  const editBox = await viewport.boundingBox();
  await home.mouse.move(editBox.x + 120, editBox.y + 3); await home.mouse.down(); await home.mouse.move(editBox.x + 220, editBox.y + 3, { steps: 8 }); await home.mouse.up();
  await expect(active).toHaveAttribute('data-page', '0');
  expect(await home.locator('#sitesPages [data-site]').evaluateAll(cards => cards.map(card => card.dataset.site))).toEqual(['github', 'youtube', 'bilibili', 'zhihu', 'notion', 'builtin-bookmarks', 'builtin-history', 'builtin-extensions']);
});

test('dock edge buttons appear near the pointer, support focus and respect page boundaries', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await expect(home.locator('.sites-section')).toBeVisible();
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); await chrome.storage.local.set({ tabcat: { ...tabcat, layoutColumns: 4, layoutRows: 1 } }); });
  const previous = home.locator('#previousPage'), next = home.locator('#nextPage');
  await home.mouse.move(10, 10);
  await expect(previous).toBeHidden(); await expect(next).toHaveCSS('opacity', '0');
  const box = await home.locator('#sitesViewport').boundingBox();
  await home.mouse.move(box.x + box.width - 6, box.y + box.height / 2);
  await expect(next).toHaveCSS('opacity', '1');
  await home.screenshot({ path: testInfo.outputPath('dock-edge-next.png'), animations: 'disabled' });
  await next.click(); await expect(home.locator('.page-dot.active')).toHaveAttribute('data-page', '1'); await expect(next).toBeHidden();
  await home.mouse.move(box.x + 6, box.y + box.height / 2); await expect(previous).toHaveCSS('opacity', '1');
  await home.mouse.move(10, 10); await expect(previous).toHaveCSS('opacity', '0');
  await home.locator('.sites-page:not([inert]) [data-site]').first().focus(); await home.keyboard.press('Shift+Tab'); await expect(previous).toBeFocused(); await expect(previous).toHaveCSS('opacity', '1'); await home.keyboard.press('Enter');
  await expect(home.locator('.page-dot.active')).toHaveAttribute('data-page', '0');
  await expect(home.locator('.sites-section')).toBeVisible();
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); await chrome.storage.local.set({ tabcat: { ...tabcat, layoutColumns: 6, layoutRows: 2 } }); });
  await expect(previous).toBeHidden(); await expect(next).toBeHidden();
});

test('dock touch swipes still turn pages and vertical gestures cancel', async ({ extension }) => {
  const { home, worker, context } = extension;
  await expect(home.locator('.sites-section')).toBeVisible();
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); await chrome.storage.local.set({ tabcat: { ...tabcat, layoutColumns: 4, layoutRows: 1 } }); });
  await expect(home.locator('.page-dot')).toHaveCount(2);
  const box = await home.locator('#sitesViewport').boundingBox();
  const cdp = await context.newCDPSession(home);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const x = box.x + box.width / 2, y = box.y + 3;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 80 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(home.locator('.page-dot.active')).toHaveAttribute('data-page', '0');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 90, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(home.locator('.page-dot.active')).toHaveAttribute('data-page', '1');
  await cdp.detach();
});

test('dragging a shortcut over a page arrow moves it across pages', async ({ extension }) => {
  const { home } = extension;
  await settings(home, 'sites');
  await home.locator('#layoutColumns').selectOption('4');
  await home.locator('#layoutRows').selectOption('1');
  await home.locator('#closeSettings').click();
  await home.locator('#settingsPanel').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await desktopMenu(home, '进入编辑模式');
  const source = await home.locator('[data-site="github"] .site-icon').boundingBox();
  const arrow = await home.locator('#nextPage').boundingBox();
  await home.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await home.mouse.down();
  await home.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2, { steps: 5 });
  await home.mouse.move(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2, { steps: 15 });
  await expect(home.locator('.page-dot.active')).toHaveAttribute('data-page', '1');
  await home.locator('#sitesPages').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const target = await home.locator('[data-desktop-key="site:notion"]').boundingBox();
  await home.mouse.move(target.x + target.width - 3, target.y + 35, { steps: 15 });
  await home.mouse.move(target.x + target.width - 2, target.y + 35);
  await home.mouse.up();
  await expect.poll(() => home.locator('.site-card[data-site]').evaluateAll(cards => cards.slice(0, 5).map(card => card.dataset.site))).toEqual(['youtube','bilibili','zhihu','notion','github']);
});


test('real page homepage logo is captured; editing URL refreshes it; text override wins', async ({ extension }, testInfo) => {
  const { home, context, worker, id } = extension;
  const icon = await readFile(resolve('public/icon/32.png'));
  const server = createServer((request, response) => {
    if (request.url === '/assets/site-icon.png' || request.url === '/favicon.ico') {
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(icon);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<title>真实网站图标</title><link rel="icon" type="image/png" href="/assets/site-icon.png"><header><a href="/"><img class="logo" src="/assets/site-icon.png"></a></header>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/article`);
    const popup = await openAction(context, id, page);
    await expect.poll(() => popup.evaluate('(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0].favIconUrl)()')).toBe(`${origin}/assets/site-icon.png`);
    const ready = popup;
    await expect.poll(() => ready.evaluate('document.querySelector("#pinButton").disabled')).toBe(false);
    await ready.evaluate('document.querySelector("#pinButton").click()');
    const card = home.locator('.site-card[title="真实网站图标"]');
    await expect(card.locator('img')).toHaveAttribute('src', `${origin}/assets/site-icon.png`);
    await ready.close();
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.sites.at(-1));
    expect(saved.favicon).toBeFalsy();
    expect(saved.logoCandidates).toContain(`${origin}/assets/site-icon.png`);
    expect(saved.icon).toBeFalsy();
    await home.reload();
    await expect(card.locator('img')).toHaveAttribute('src', `${origin}/assets/site-icon.png`);
    await card.click({ button: 'right' });
    await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
    await expect(home.locator('#sitePreview img')).toHaveAttribute('src', `${origin}/assets/site-icon.png`);
    await home.locator('#siteUrl').fill(`${origin}/different`);
    await home.locator('#saveSiteButton').click();
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.sites.at(-1).favicon)).toBe('');
    await expect(card.locator('img')).toHaveCount(1);

    await home.screenshot({ path: testInfo.outputPath('real-favicon.png'), fullPage: true });
    await card.click({ button: 'right' });
    await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
    await home.locator('.advanced-fields summary').click();
    await home.locator('[data-icon-source="text"]').click();
    await home.locator('#siteIconText').fill('自');
    await expect(home.locator('#sitePreview')).toHaveText('自');
    await home.locator('#saveSiteButton').click();
    await expect(card.locator('.site-icon')).toHaveText('自');
    await expect(card.locator('img')).toHaveCount(0);
    // The visited page's non-root icon must also work for manual additions offline.
    await context.setOffline(true);
    await addWebsite(home);
    await home.locator('#siteName').fill('缓存图标');
    await home.locator('#siteUrl').fill(`${origin}/article`);
    await expect.poll(() => home.locator('#sitePreview img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await home.locator('#saveSiteButton').click();
    await expect.poll(() => home.locator('.site-card[title="缓存图标"] img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('manual deep links use the homepage logo and broken logos use text; UI icons work offline', async ({ extension }) => {
  const { home, context } = extension;
  const icon = await readFile(resolve('public/icon/32.png'));
  let missingRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/header-logo.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(icon); }
    else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(request.url === '/' ? '<header><a href="/"><img class="logo" src="/header-logo.png"></a></header>' : '<link rel="icon" href="/favicon.ico">'); }
  });
  const missing = createServer((request, response) => {
    missingRequests++; response.writeHead(404); response.end('missing');
  });
  await Promise.all([server, missing].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const missingOrigin = `http://127.0.0.1:${missing.address().port}`;
  try {
    await addWebsite(home);
    await home.locator('#siteName').fill('站点图标');
    await home.locator('#siteUrl').fill(`${origin}/deep/page`);
    await expect(home.locator('#sitePreview img')).toHaveAttribute('src', `${origin}/header-logo.png`);
    await home.locator('#saveSiteButton').click();
    const good = home.locator('.site-card[title="站点图标"] img');
    await expect(good).toHaveAttribute('src', `${origin}/header-logo.png`);
    await addWebsite(home);
    await home.locator('#siteName').fill('失效图标');
    await home.locator('#siteUrl').fill(`${missingOrigin}/page`);
    await home.locator('#saveSiteButton').click();
    await expect.poll(() => missingRequests).toBeGreaterThan(0);
    const broken = home.locator('.site-card[title="失效图标"] .site-icon');
    await expect(broken).toHaveText('失');
    await expect(broken.locator('img')).toHaveCount(0);
    await context.setOffline(true);
    await home.reload();
    await expect(home.locator('#settingsButton svg path')).not.toHaveCount(0);
    await expect(home.locator('[data-site="builtin-bookmarks"] svg')).toHaveCount(1);
    await expect(broken).toHaveText('失');
  } finally {
    for (const service of [server, missing]) service.closeAllConnections();
    await Promise.all([server, missing].map(service => new Promise(resolve => service.close(resolve))));
  }
});

test('desktop adds only in edit mode and horizontal gestures switch pages', async ({ extension }, testInfo) => {
  const { home } = extension;
  await expect(home.locator('#addSiteButton')).toBeHidden();
  await expect(home.locator('.site-add')).toHaveCount(0);
  await expect(home.locator('[data-site="github"]')).toHaveAttribute('draggable', 'false');
  await settings(home, 'sites');
  await home.locator('#layoutColumns').selectOption('2');
  await home.locator('#layoutRows').selectOption('1');
  await home.locator('#closeSettings').click();
  await home.locator('#sitesViewport').dispatchEvent('wheel', { deltaX: 80, deltaY: 0 });
  await expect(home.locator('.page-dot.active')).toHaveAttribute('data-page', '1');
  await desktopMenu(home, '进入编辑模式');
  await expect(home.locator('#addSiteButton')).toBeVisible();
  await expect(home.locator('.site-add')).toHaveCount(1);
  await expect(home.locator('[data-site="github"]')).toHaveAttribute('draggable', 'true');
  await home.screenshot({ path: testInfo.outputPath('edit-mode.png'), fullPage: true, animations: 'disabled' });
  await home.locator('#finishEditing').click();
  await expect(home.locator('.site-add')).toHaveCount(0);
  await expect(home.locator('#addSiteButton')).toBeHidden();
  await addWebsite(home);
  await expect(home.locator('#siteModal')).toBeVisible();
});

test('switching search engines preserves shortcut nodes and keeps add controls in edit mode only', async ({ extension }) => {
  const { home, context } = extension;
  const other = await context.newPage();
  await other.goto('chrome://newtab/');
  await expect(other.locator('#sitesPages [data-site]')).toHaveCount(8);
  for (const page of [home, other]) {
    await page.evaluate(() => {
      window.shortcutNodes = [...document.querySelectorAll('#sitesPages .sites-page, #sitesPages [data-site], #sitesPages .site-icon')];
      window.bookmarkArtwork = document.querySelector('[data-site="builtin-bookmarks"] svg');
    });
  }
  for (const engine of ['bing', 'baidu', 'google']) {
    await home.locator('#engineButton').click();
    await home.locator(`#engineMenu [data-engine="${engine}"]`).click();
    // The other tab's engine reflects the completed storage write and change event.
    await expect(other.locator('#engineMenu .active')).toHaveAttribute('data-engine', engine);
    for (const page of [home, other]) {
      expect(await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('#sitesPages .sites-page, #sitesPages [data-site], #sitesPages .site-icon')];
        return nodes.length === window.shortcutNodes.length && nodes.every((node, index) => node === window.shortcutNodes[index])
          && document.querySelector('[data-site="builtin-bookmarks"] svg') === window.bookmarkArtwork;
      })).toBe(true);
      await expect(page.locator('#addSiteButton')).toBeHidden();
      await expect(page.locator('.site-add')).toHaveCount(0);
    }
  }
  await desktopMenu(home, '进入编辑模式');
  await expect(home.locator('#addSiteButton')).toBeVisible();
  await expect(home.locator('.site-add')).toBeVisible();
  await home.reload();
  await expect(home.locator('#sitesPages [data-site]')).toHaveCount(8);
  await expect(home.locator('#addSiteButton')).toBeHidden();
  await expect(home.locator('.site-add')).toHaveCount(0);
  await expect(home.locator('#finishEditing')).toBeHidden();
});

test('desktop and search icons never paint temporary letters or colors while decoding, and survive settings updates', async ({ extension }) => {
  const { home, worker } = extension;
  await home.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    const waiting = new Promise(resolve => { window.releaseIconDecoding = resolve; });
    HTMLImageElement.prototype.decode = async function () {
      if (/\/(catalog|search)\//.test(this.src)) await waiting;
      return decode.call(this);
    };
    window.iconFrames = [];
    const sample = () => {
      for (const selector of ['[data-site="github"] .site-icon', '#engineIcon']) {
        const icon = document.querySelector(selector);
        if (icon && getComputedStyle(icon).visibility === 'visible') {
          const image = icon.querySelector('img');
          window.iconFrames.push({ selector, text: icon.textContent, image: Boolean(image?.complete && image.naturalWidth) });
        }
      }
      if (!window.stopIconFrames) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await home.reload();
  await expect(home.locator('#settingsButton')).toBeVisible();
  for (const selector of ['[data-site="github"] .site-icon', '#engineIcon']) {
    await expect(home.locator(selector)).toHaveClass(/icon-loading/);
    await expect(home.locator(selector)).toHaveCSS('visibility', 'hidden');
    await expect(home.locator(selector)).toHaveText('');
  }
  await home.evaluate(() => window.releaseIconDecoding());
  await expect(home.locator('#engineIcon img')).toHaveAttribute('src', '/search/google.png');
  for (const selector of ['[data-site="github"] .site-icon', '#engineIcon']) {
    await expect(home.locator(`${selector} img`)).toBeVisible();
  }
  await home.evaluate(() => {
    window.stableEngineIcon = document.querySelector('#engineIcon img');
    window.stableDesktopIcon = document.querySelector('[data-site="github"] .site-icon img');
  });
  await worker.evaluate(async () => {
    const { tabcat = {} } = await chrome.storage.local.get('tabcat');
    await chrome.storage.local.set({ tabcat: { ...tabcat, theme: 'dark' } });
  });
  await expect(home.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await home.evaluate(() => window.stableEngineIcon === document.querySelector('#engineIcon img') && window.stableDesktopIcon === document.querySelector('[data-site="github"] .site-icon img'))).toBe(true);
  await expect.poll(() => home.evaluate(() => window.iconFrames.length)).toBeGreaterThan(0);
  const frames = await home.evaluate(() => { window.stopIconFrames = true; return window.iconFrames; });
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) expect(frame).toMatchObject({ text: '', image: true });
});

test('successful custom icon is requested directly on reopen without repeating discovery', async ({ extension }) => {
  const { home, worker } = extension;
  const png = await readFile(resolve('public/icon/128.png'));
  const server = createServer((request, response) => {
    if (request.url === '/icon.png') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); }
    else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<header><a href="/"><img class="logo" src="/icon.png"></a></header>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await worker.evaluate(async origin => {
      await chrome.storage.local.set({ tabcat: { sites: [{ id: 'cached-custom', name: '缓存图标', url: origin }] } });
    }, origin);
    await expect(home.locator('[data-site="cached-custom"] img')).toHaveAttribute('src', `${origin}/icon.png`);
    await expect.poll(() => home.evaluate(() => JSON.parse(localStorage.getItem('tabcat:resolved-icons:quality-v3') || '[]').some(([, entry]) => entry.source.endsWith('/icon.png')))).toBe(true);
    await home.addInitScript(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = (...args) => args[0] === 'tabcatIconCache' ? new Promise(() => {}) : get(...args);
    });
    await home.reload();
    await expect(home.locator('[data-site="cached-custom"] img')).toHaveAttribute('src', `${origin}/icon.png`, { timeout: 2000 });
    await expect(home.locator('[data-site="cached-custom"] .site-icon')).toHaveText('');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Bing daily wallpaper caches offline and frost controls persist', async ({ extension }) => {
  const { home, worker, context } = extension;
  const png = (await readFile(resolve('public/icon/128.png'))).toString('base64');
  await worker.evaluate(png => {
    const original = globalThis.fetch;
    globalThis.failBing = false;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://www.bing.com/HPImageArchive')) {
        if (globalThis.failBing) throw new Error('offline');
        return new Response(JSON.stringify({ images: [{ url: '/th?id=fixture', title: '每日壁纸测试', copyright: '测试图片', copyrightlink: 'https://www.bing.com/' }] }), { headers: { 'content-type': 'application/json' } });
      }
      if (String(url) === 'https://www.bing.com/th?id=fixture') return new Response(Uint8Array.from(atob(png), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
      return original(url, options);
    };
  }, png);
  await settings(home, 'wallpaper');
  await home.locator('#background').selectOption('bing');
  await expect(home.locator('#bingStatus')).toContainText('每日壁纸测试');
  await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).toContain('data:image/png;base64,');
  for (const [id, value] of [['backgroundBlur', '24'], ['backgroundFrost', '32']]) {
    await home.locator(`#${id}`).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  }
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.backgroundFrost)).toBe(32);
  await worker.evaluate(() => { globalThis.failBing = true; });
  await home.locator('#refreshBing').click();
  await expect(home.locator('#bingStatus')).toContainText('离线缓存');
  await context.setOffline(true);
  await home.reload();
  await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).toContain('data:image/png;base64,');
  expect(await home.evaluate(() => document.documentElement.style.getPropertyValue('--background-blur'))).toBe('24px');
  expect(await home.evaluate(() => document.documentElement.style.getPropertyValue('--background-frost'))).toBe('0.32');
});

test('photo gallery rotates, caches offline, and keeps manual and new-tab policies distinct', async ({ extension }) => {
  const { home, worker, context } = extension;
  const png = (await readFile(resolve('public/icon/128.png'))).toString('base64');
  await worker.evaluate(png => {
    const original = globalThis.fetch;
    globalThis.galleryCalls = 0; globalThis.galleryOffline = false;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://picsum.photos/')) {
        if (globalThis.galleryOffline) throw new Error('offline');
        if (String(url).includes('/v2/list')) {
          globalThis.galleryCalls++;
          return new Response(JSON.stringify(['10', '20', '30'].map(id => ({ id, width: 3000, height: 2000, author: '摄影师测试', url: `https://example.com/photo/${id}` }))));
        }
        return new Response(Uint8Array.from(atob(png), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
      }
      return original(url, options);
    };
  }, png);
  await settings(home, 'wallpaper');
  await expect(home.locator('#background option[value="mist"], #background option[value="sky"], #background option[value="forest"], #background option[value="peach"]')).toHaveCount(0);
  await home.locator('#background').selectOption('picsum');
  await expect(home.locator('#galleryStatus')).toContainText('摄影师测试');
  const first = await worker.evaluate(async () => (await chrome.storage.local.get('tabcatGallery')).tabcatGallery.id);
  await expect(home.locator('#wallpaperCredit')).toHaveAttribute('href', `https://example.com/photo/${first}`);
  await home.locator('#refreshGallery').click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcatGallery')).tabcatGallery.id)).not.toBe(first);
  await expect(home.locator('#refreshGallery')).toBeEnabled();
  await home.reload();
  await settings(home, 'wallpaper');
  await expect(home.locator('#galleryStatus')).toContainText('摄影师测试');
  expect(await worker.evaluate(() => globalThis.galleryCalls)).toBe(2);
  await home.locator('#wallpaperRotation').selectOption('manual');
  await expect(home.locator('#refreshGallery')).toBeEnabled();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.wallpaperRotation)).toBe('manual');
  const calls = await worker.evaluate(() => globalThis.galleryCalls);
  const other = await context.newPage(); await other.goto('chrome://newtab/');
  await settings(other, 'wallpaper');
  await expect(other.locator('#galleryStatus')).toContainText('摄影师测试');
  expect(await worker.evaluate(() => globalThis.galleryCalls)).toBe(calls);
  await other.close();
  await home.locator('#wallpaperRotation').selectOption('newtab');
  await expect(home.locator('#refreshGallery')).toBeEnabled();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.wallpaperRotation)).toBe('newtab');
  const beforeReload = await worker.evaluate(() => globalThis.galleryCalls);
  await home.reload(); await settings(home, 'wallpaper');
  await expect(home.locator('#galleryStatus')).toContainText('摄影师测试');
  expect(await worker.evaluate(() => globalThis.galleryCalls)).toBe(beforeReload + 1);
  await worker.evaluate(() => { globalThis.galleryOffline = true; });
  await home.locator('#refreshGallery').click();
  await expect(home.locator('#galleryStatus')).toContainText('使用上次缓存');
  await home.reload();
  await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).toContain('data:image/png;base64,');
});

test('Bing gallery changes photos and a failed new source preserves the current photo', async ({ extension }) => {
  const { home, worker } = extension;
  const png = (await readFile(resolve('public/icon/128.png'))).toString('base64');
  await worker.evaluate(png => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://www.bing.com/HPImageArchive')) return new Response(JSON.stringify({ images: [1,2,3].map(id => ({ url: `/th?id=gallery${id}`, title: `风景 ${id}`, copyright: '图库摄影', copyrightlink: 'https://www.bing.com/' })) }));
      if (String(url).startsWith('https://www.bing.com/th?id=gallery')) return new Response(Uint8Array.from(atob(png), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
      if (String(url).startsWith('https://picsum.photos/')) throw new Error('offline');
      return original(url, options);
    };
  }, png);
  await settings(home, 'wallpaper');
  await home.locator('#background').selectOption('bing-gallery');
  await expect(home.locator('#galleryStatus')).toContainText('图库摄影');
  const first = await worker.evaluate(async () => (await chrome.storage.local.get('tabcatGallery')).tabcatGallery.id);
  await home.locator('#closeSettings').click();
  await home.locator('#nextWallpaper').click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcatGallery')).tabcatGallery.id)).not.toBe(first);
  await expect(home.locator('html')).toHaveAttribute('data-background', 'bing-gallery');
  await settings(home, 'wallpaper');
  const previousBackground = await home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'));
  await home.locator('#background').selectOption('picsum');
  await expect(home.locator('#galleryStatus')).toContainText('暂时无法连接图库');
  const background = await home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'));
  expect(background).toBe(previousBackground); expect(background).toContain('data:image/png;base64,');
});

test('wallpaper paints during startup and saved bookmark layout stays stable despite delayed storage', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  const image = `data:image/png;base64,${(await readFile(resolve('public/icon/128.png'))).toString('base64')}`;
  await worker.evaluate(async image => {
    const [root] = await chrome.bookmarks.getTree();
    const bar = root.children.find(node => node.folderType === 'bookmarks-bar' || node.id === '1');
    await chrome.bookmarks.create({ parentId: bar.id, title: '首屏书签', url: 'https://example.com/' });
    await chrome.storage.local.set({
      tabcat: { background: 'bing', showBookmarksBar: true, showClock: true, showSearch: false },
      tabcatBing: { image, date: '2000-01-01', title: '首屏缓存', copyright: '测试' },
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://www.bing.com/')) throw new Error('offline');
      return original(url, options);
    };
  }, image);
  // Populate the real first-paint cache through the normal wallpaper display path.
  await home.reload();
  await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).toBe(`url(${JSON.stringify(image)})`);
  const preview = await home.evaluate(() => JSON.parse(localStorage.getItem('tabcat:first-paint:v1')).preview);
  expect(preview).toMatch(/^data:image\/webp;base64,/);
  await home.addInitScript(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async (...args) => { await new Promise(resolve => setTimeout(resolve, 800)); return get(...args); };
    const tree = chrome.bookmarks.getTree.bind(chrome.bookmarks);
    chrome.bookmarks.getTree = async () => { await new Promise(resolve => setTimeout(resolve, 250)); return tree(); };
    window.startupFrames = [];
    window.bootFrames = [];
    const sample = () => {
      const root = document.documentElement, bar = document.querySelector('#bookmarkBar'), search = document.querySelector('#searchForm');
      const layer = document.querySelector('.wallpaper-layer');
      if (layer && root.classList.contains('booting')) {
        window.bootFrames.push({
          visibility: getComputedStyle(layer).visibility,
          preview: root.style.getPropertyValue('--wallpaper-preview'),
          bar: getComputedStyle(bar).display !== 'none' && getComputedStyle(bar).visibility === 'visible',
          reserved: root.classList.contains('has-bookmarks-bar'),
        });
      }
      if (bar && search && getComputedStyle(search).visibility === 'visible') {
        window.startupFrames.push({
          wallpaper: root.style.getPropertyValue('--wallpaper'), bar: !bar.hidden,
          reserved: root.classList.contains('has-bookmarks-bar'), items: document.querySelector('#bookmarkBarItems').textContent,
          clock: !document.querySelector('.hero').hidden, search: !search.hidden,
          top: document.querySelector('.app-shell').getBoundingClientRect().top + parseFloat(getComputedStyle(document.querySelector('.app-shell')).paddingTop),
        });
      }
      if (window.startupFrames.length < 12) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await home.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => home.evaluate(() => window.bootFrames.length)).toBeGreaterThan(0);
  await home.screenshot({ path: testInfo.outputPath('cached-wallpaper-during-startup.png') });
  await expect.poll(() => home.evaluate(() => window.startupFrames.length)).toBe(12);
  const bootFrames = await home.evaluate(() => window.bootFrames);
  for (const frame of bootFrames) {
    expect(frame).toMatchObject({ visibility: 'visible', bar: true, reserved: true });
    expect(frame.preview).toBe(`url(${JSON.stringify(preview)})`);
  }
  const frames = await home.evaluate(() => window.startupFrames);
  for (const frame of frames) {
    expect(frame).toMatchObject({ bar: true, reserved: true, clock: true, search: false });
    expect(frame.items).toContain('首屏书签');
    expect(frame.top).toBe(frames[0].top);
  }
  await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).toBe(`url(${JSON.stringify(image)})`);
  await home.screenshot({ path: testInfo.outputPath('wallpaper-after-startup.png') });
  await worker.evaluate(async () => {
    const { tabcat } = await chrome.storage.local.get('tabcat');
    await chrome.storage.local.set({ tabcat: { ...tabcat, showBookmarksBar: false, showSearch: true, showClock: false } });
  });
  await expect.poll(() => home.evaluate(() => JSON.parse(localStorage.getItem('tabcat:first-paint:v1')).bookmarks)).toBe(false);
  await home.reload();
  await expect.poll(() => home.evaluate(() => window.startupFrames.length)).toBe(12);
  for (const frame of await home.evaluate(() => window.startupFrames)) {
    expect(frame).toMatchObject({ bar: false, reserved: false, clock: false, search: true });
  }
  for (const frame of await home.evaluate(() => window.bootFrames)) {
    expect(frame).toMatchObject({ visibility: 'visible', bar: false, reserved: false });
  }
});

test('broken first-paint cache recovers and slow wallpaper cannot hold controls behind a blank page', async ({ extension }) => {
  const { home, worker } = extension;
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ tabcat: { background: 'custom', backgroundUrl: 'https://wallpaper.example/slow.png' } });
  });
  await home.evaluate(() => localStorage.setItem('tabcat:first-paint:v1', '{broken'));
  let release;
  const response = new Promise(resolve => { release = resolve; });
  await home.route('https://wallpaper.example/slow.png', async route => { await response; await route.abort(); });
  try {
    await home.reload();
    await expect(home.locator('#settingsButton')).toBeVisible({ timeout: 1000 });
    await expect(home.locator('.wallpaper-layer')).toHaveCSS('visibility', 'visible');
    expect(await home.locator('.wallpaper-layer').evaluate(layer => getComputedStyle(layer).backgroundImage)).toContain('fjord-preview.jpg');
    await home.locator('#settingsButton').click();
    await expect(home.locator('#settingsPanel')).toHaveAttribute('aria-hidden', 'false');
  } finally { release(); await home.unrouteAll({ behavior: 'wait' }); }
});

test('search suggestions follow the engine, discard stale results and support keyboard selection', async ({ extension }, testInfo) => {
  const { home, worker, context } = extension;
  await worker.evaluate(() => {
    const original = globalThis.fetch; globalThis.suggestRequests = []; globalThis.oldFinished = false;
    globalThis.fetch = async (url, options) => {
      const u = new URL(url);
      if (['suggestqueries.google.com', 'api.bing.com', 'suggestion.baidu.com'].includes(u.hostname)) {
        const query = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('wd');
        globalThis.suggestRequests.push({ host: u.hostname, query });
        if (query === '旧查询') { await new Promise(resolve => setTimeout(resolve, 900)); globalThis.oldFinished = true; }
        if (query === '失败') throw new Error('network unavailable');
        return new Response(u.hostname === 'suggestion.baidu.com' ? 'tabcat({q:"百度",s:["百度推荐一","百度推荐二"]});' : JSON.stringify([query, [`${query} 推荐一`, `${query} 推荐二`]]), { headers: { 'content-type': 'application/json' } });
      }
      return original(url, options);
    };
  });
  await home.locator('#searchInput').fill('旧查询');
  await expect.poll(() => worker.evaluate(() => globalThis.suggestRequests.some(item => item.query === '旧查询'))).toBe(true);
  await home.locator('#searchInput').fill('新查询');
  await expect(home.locator('#suggestionList')).toContainText('新查询 推荐一');
  await expect.poll(() => worker.evaluate(() => globalThis.oldFinished)).toBe(true);
  await expect(home.locator('#suggestionList')).not.toContainText('旧查询');
  await home.locator('#engineButton').click();
  await home.locator('[data-engine="baidu"]').click();
  await home.locator('#searchInput').fill('百度');
  await expect(home.locator('#suggestionList')).toContainText('百度推荐一');
  await expect(home.locator('#engineIcon img')).toHaveAttribute('src', '/catalog/baidu-favicon.png');
  await home.locator('#searchInput').press('ArrowDown');
  await expect(home.locator('#searchInput')).toHaveValue('百度推荐一');
  await home.locator('#searchInput').press('ArrowDown');
  await expect(home.locator('#searchInput')).toHaveValue('百度推荐二');
  await home.locator('#searchInput').press('Escape');
  await expect(home.locator('#searchInput')).toHaveValue('百度');
  await expect(home.locator('#suggestionList')).toBeHidden();
  await home.locator('#engineButton').click();
  await home.locator('[data-engine="bing"]').click();
  await home.locator('#searchInput').fill('失败');
  await expect.poll(() => worker.evaluate(() => globalThis.suggestRequests.some(item => item.query === '失败'))).toBe(true);
  await expect(home.locator('#suggestionList')).toBeHidden();
  await settings(home, 'search');
  await home.locator('#openInNewTab').check({ force: true });
  await home.locator('#closeSettings').click();
  await home.locator('#searchInput').fill('必应');
  await expect(home.locator('#suggestionList')).toContainText('必应 推荐一');
  await home.screenshot({ path: testInfo.outputPath('suggestions.png'), fullPage: true });
  await home.locator('#searchInput').press('ArrowDown');
  const opened = context.waitForEvent('page');
  await home.locator('#searchInput').press('Enter');
  const page = await opened;
  await expect.poll(() => page.url()).toContain('bing.com/search?q=%E5%BF%85%E5%BA%94%20');
  await page.close();
  await settings(home, 'search');
  await home.locator('#searchSuggestions').uncheck({ force: true });
  await home.locator('#closeSettings').click();
  await home.locator('#searchInput').fill('禁用后');
  await expect(home.locator('#suggestionList')).toBeHidden();
});

test('low-resolution favicons use text while high-resolution manifest icons are retained', async ({ extension }) => {
  const { home, worker } = extension;
  const small = await readFile(resolve('public/icon/32.png'));
  const large = await readFile(resolve('public/icon/128.png'));
  const server = createServer((request, response) => {
    if (request.url.endsWith('.png') || request.url.endsWith('.ico')) {
      response.writeHead(200, { 'content-type': 'image/png' }); response.end(request.url === '/large.png' ? large : small); return;
    }
    if (request.url === '/app.webmanifest') {
      response.writeHead(200, { 'content-type': 'application/manifest+json' }); response.end(JSON.stringify({ icons: [{ src: 'large.png', sizes: '128x128' }] })); return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<link rel="icon" sizes="512x512" href="/favicon.ico">' + (request.url === '/high' ? '<link rel="manifest" href="/app.webmanifest">' : ''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await worker.evaluate(async origin => {
      const { tabcat = { sites: [] } } = await chrome.storage.local.get('tabcat');
      tabcat.sites.push({ id: 'legacy-icon', name: 'No Logo', url: origin, favicon: `${origin}/favicon.ico` });
      tabcat.sites.push({ id: 'manifest-icon', name: 'Manifest', url: `${origin}/high` });
      await chrome.storage.local.set({ tabcat });
    }, origin);
    const icon = home.locator('[data-site="legacy-icon"] .site-icon');
    await expect(icon).toHaveText('N');
    await expect(icon.locator('img')).toHaveCount(0);
    await expect(home.locator('[data-site="manifest-icon"] img')).toHaveAttribute('src', `${origin}/large.png`);
    await home.reload();
    await expect(home.locator('[data-site="manifest-icon"] img')).toHaveAttribute('src', `${origin}/large.png`);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('crisp favicon beats a homepage logo and larger tiles re-evaluate the cached choice', async ({ extension }) => {
  const { home, worker } = extension;
  const favicon = await readFile(resolve('public/catalog/sspai-favicon.png'));
  const logo = await readFile(resolve('public/icon/128.png'));
  const server = createServer((request, response) => {
    if (request.url.endsWith('.png')) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(request.url === '/favicon.png' ? favicon : logo); return; }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<link rel="icon" href="/favicon.png"><header><img class="logo" src="/header.png"></header>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await worker.evaluate(async origin => {
      const { tabcat = { sites: [] } } = await chrome.storage.local.get('tabcat');
      tabcat.sites.push({ id: 'sharp-icon', name: 'Sharp', url: origin });
      await chrome.storage.local.set({ tabcat });
    }, origin);
    const image = home.locator('[data-site="sharp-icon"] img');
    await expect(image).toHaveAttribute('src', `${origin}/favicon.png`);
    await home.reload(); await expect(image).toHaveAttribute('src', `${origin}/favicon.png`);
    await home.locator('[data-site="sharp-icon"]').click({ button: 'right' });
    await home.getByRole('menuitem', { name: '编辑快捷方式', exact: true }).click();
    await expect(home.locator('#sitePreview img')).toHaveAttribute('src', `${origin}/favicon.png`);
    await home.locator('#saveSiteButton').click();
    await worker.evaluate(async () => {
      const { tabcat = { sites: [] } } = await chrome.storage.local.get('tabcat');
      tabcat.sites.find(site => site.id === 'sharp-icon').iconSize = 128;
      await chrome.storage.local.set({ tabcat });
    });
    await expect(image).toHaveAttribute('src', `${origin}/header.png`);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('page header logos beat low-resolution favicons, fill the tile, and support per-site image sizing', async ({ extension }, testInfo) => {
  const { home, context, worker, id } = extension;
  const png = await readFile(resolve('public/icon/128.png'));
  const small = await readFile(resolve('public/icon/32.png'));
  const server = createServer((request, response) => {
    if (request.url.endsWith('.png')) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(request.url === '/favicon.png' ? small : png); }
    else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Page Brand</title><link rel="icon" href="/favicon.png"><header><a href="/"><img class="brand-logo" alt="Brand" src="/small-logo.png" srcset="/small-logo.png 1x, /large-logo.png 2x" width="100" height="100"></a></header>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await context.newPage(); await page.goto(`${origin}/article`);
    const popup = await openAction(context, id, page);
    await expect.poll(() => popup.evaluate('document.querySelector("#pinButton").disabled')).toBe(false);
    await popup.evaluate('document.querySelector("#pinButton").click()');
    const card = home.locator('.site-card[title="Page Brand"]');
    await expect(card.locator('img')).toHaveAttribute('src', `${origin}/large-logo.png`);
    expect(await card.evaluate(card => card.querySelector('img').getBoundingClientRect().width / card.querySelector('.site-icon').getBoundingClientRect().width)).toBeCloseTo(1);
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.sites.at(-1));
    expect(saved.logoCandidates[0]).toBe(`${origin}/large-logo.png`);
    await popup.close();
    await card.click({ button: 'right' }); await home.getByRole('menuitem', { name: '编辑快捷方式', exact: true }).click();
    await home.locator('#siteImageScale').evaluate(input => { input.value = '60'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await home.locator('#siteImageFit').selectOption('contain');
    await expect(home.locator('#siteImageScaleValue')).toHaveText('60%');
    await expect(home.locator('#sitePreview img')).toHaveCSS('object-fit', 'contain');
    await home.screenshot({ path: testInfo.outputPath('logo-editor.png'), animations: 'disabled' });
    await home.locator('#saveSiteButton').click(); await home.reload();
    await expect(card.locator('img')).toHaveAttribute('src', `${origin}/large-logo.png`);
    expect(await card.evaluate(card => card.querySelector('img').getBoundingClientRect().width / card.querySelector('.site-icon').getBoundingClientRect().width)).toBeCloseTo(.6);
    await expect(card.locator('img')).toHaveCSS('object-fit', 'contain');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('manual page logos include sanitized inline SVG and CSS background branding', async ({ extension }) => {
  const { home } = extension;
  const png = await readFile(resolve('public/icon/128.png'));
  const small = await readFile(resolve('public/icon/32.png'));
  let trackerRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/tracker') trackerRequests++;
    if (request.url.endsWith('.png')) { response.writeHead(200, { 'content-type': 'image/png' }); response.end(request.url === '/favicon.png' ? small : png); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url === '/css' ? '<header><a class="brand-logo" href="/" style="width:100px;height:100px;background-image:url(/page-logo.png)"></a></header>' : '<header><a href="/" class="brand-logo"><svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><script>window.injectedLogo=true</script><foreignObject><img src="/tracker"></foreignObject><rect width="100" height="100" fill="#2277dd"/><path d="M20 60L50 20L80 60Z" fill="white"/></svg></a></header><link rel="icon" href="/favicon.png">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const type of ['svg', 'css']) {
      await addWebsite(home); await home.locator('#siteName').fill(`Logo ${type}`); await home.locator('#siteUrl').fill(`${origin}/${type}`);
      await home.locator('#saveSiteButton').click();
      const image = home.locator(`.site-card[title="Logo ${type}"] img`);
      if (type === 'svg') { await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/); expect(await image.evaluate(img => img.naturalWidth)).toBe(512); }
      else await expect(image).toHaveAttribute('src', `${origin}/page-logo.png`);
    }
    expect(await home.evaluate(() => window.injectedLogo)).toBeUndefined();
    expect(trackerRequests).toBe(0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('external backups preview, cancel safely, merge supported data and export as TabCat JSON', async ({ extension }, testInfo) => {
  const { home } = extension;
  await settings(home, 'data');
  const originalCount = await home.locator('.site-card[data-site]').count();
  await home.locator('#backupFile').setInputFiles(resolve('tests/fixtures/imports/infinity-v2.json'));
  await expect(home.locator('#importSource')).toContainText('Infinity');
  await expect(home.locator('#importWarnings')).toContainText('文件夹');
  await home.locator('#cancelImport').click();
  await expect(home.locator('.site-card[data-site]')).toHaveCount(originalCount);
  await home.locator('#backupFile').setInputFiles(resolve('tests/fixtures/imports/infinity-v2.json'));
  await home.locator('#confirmImport').click();
  await expect(home.locator('.site-card[title="MDN"]')).toHaveCount(1);
  await expect(home.locator('[data-site="github"]')).toHaveCount(1);
  await home.locator('#backupFile').setInputFiles(resolve('tests/fixtures/imports/itab-config.json'));
  await expect(home.locator('#importSource')).toContainText('iTab');
  await home.screenshot({ path: testInfo.outputPath('import-preview.png'), fullPage: true });
  await home.locator('#confirmImport').click();
  await expect(home.locator('.site-card[title="MDN"]')).toHaveCount(1);
  const beforeInvalid = await home.locator('.site-card[data-site]').count();
  await home.locator('#backupFile').setInputFiles({ name: 'unknown.json', mimeType: 'application/json', buffer: Buffer.from('{"unexpected":true}') });
  await expect(home.locator('#status')).toHaveClass(/error/);
  await expect(home.locator('.site-card[data-site]')).toHaveCount(beforeInvalid);
  const downloadPromise = home.waitForEvent('download');
  await home.locator('#exportData').click();
  const download = await downloadPromise; await download.saveAs(testInfo.outputPath('merged-tabcat.json'));
  const backup = JSON.parse(await readFile(testInfo.outputPath('merged-tabcat.json'), 'utf8'));
  expect(backup.format).toBe('tabcat');
  expect(backup.state.sites.some(site => site.name === 'MDN')).toBe(true);
});

test('builtins can be removed, undone, and remain removed after reload and backup restore', async ({ extension }, testInfo) => {
  const { home } = extension;
  await home.locator('[data-site="builtin-bookmarks"]').click({ button: 'right' });
  await home.getByRole('menuitem', { name: '移除快捷方式' }).click();
  await expect(home.locator('[data-site="builtin-bookmarks"]')).toHaveCount(0);
  await home.locator('#status').getByRole('button', { name: '撤销' }).click();
  await expect(home.locator('[data-site="builtin-bookmarks"]')).toHaveCount(1);
  await home.locator('#editDesktopButton').click();
  for (const id of ['builtin-bookmarks', 'builtin-history', 'builtin-extensions']) {
    await home.locator(`[data-desktop-remove="${id}"]`).click();
    await expect(home.locator(`[data-site="${id}"]`)).toHaveCount(0);
  }
  await home.reload();
  await expect(home.locator('.site-card[data-site]')).toHaveCount(5);
  await settings(home, 'data');
  const downloading = home.waitForEvent('download'); await home.locator('#exportData').click();
  const download = await downloading; await download.saveAs(testInfo.outputPath('without-builtins.json'));
  await home.locator('#backupFile').setInputFiles(testInfo.outputPath('without-builtins.json'));
  await home.locator('#confirmImport').click();
  await home.reload();
  await expect(home.locator('.site-card[data-site]')).toHaveCount(5);
});

test('text icon styles support global settings and per-site overrides; percent radii scale', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await home.locator('[data-site="github"]').click({ button: 'right' });
  await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
  await home.locator('.advanced-fields summary').click();
  await home.locator('[data-icon-source="text"]').click();
  await home.locator('#siteIconText').fill('字');
  await home.locator('#saveSiteButton').click();
  await settings(home, 'appearance');
  for (const [id, value] of [['iconSize', '80'], ['iconRadius', '25'], ['iconTextSize', '36'], ['iconTextColor', '#ff6600']]) {
    await home.locator(`#${id}`).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  }
  await home.locator('#iconTextWeight').selectOption('700');
  await home.locator('#iconTextFont').selectOption('mono');
  const icon = home.locator('[data-site="github"] .site-icon');
  await expect(icon).toHaveCSS('font-size', '36px'); await expect(icon).toHaveCSS('font-weight', '700');
  await expect(icon).toHaveCSS('color', 'rgb(255, 102, 0)'); await expect(icon).toHaveCSS('border-radius', '25%');
  await expect(icon).toHaveCSS('width', '80px');
  await home.locator('#iconSize').evaluate(input => { input.value = '120'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(icon).toHaveCSS('width', '120px'); await expect(icon).toHaveCSS('border-radius', '25%');
  await home.locator('#closeSettings').click();
  await home.locator('[data-site="github"]').click({ button: 'right' });
  await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
  await home.locator('.advanced-fields summary').click();
  await home.locator('#siteIconSize').fill('100'); await home.locator('#siteIconRadius').fill('10');
  await home.locator('#siteIconTextSize').fill('44'); await home.locator('#siteIconTextWeight').selectOption('500');
  await home.locator('#siteIconTextFont').selectOption('serif'); await home.locator('#siteIconTextColor').fill('#00aaff');
  await expect(home.locator('#sitePreview')).toHaveCSS('border-radius', '10%');
  await expect(home.locator('#sitePreview')).toHaveCSS('font-size', '44px');
  await home.screenshot({ path: testInfo.outputPath('text-icon-settings.png'), fullPage: true });
  await home.locator('#saveSiteButton').click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.sites.find(site => site.id === 'github').iconTextSize)).toBe(44);
  await home.reload();
  await expect(icon).toHaveCSS('width', '100px'); await expect(icon).toHaveCSS('border-radius', '10%');
  await expect(icon).toHaveCSS('font-size', '44px'); await expect(icon).toHaveCSS('font-weight', '500');
  await expect(icon).toHaveCSS('color', 'rgb(0, 170, 255)');
  await home.locator('[data-site="github"]').click({ button: 'right' });
  await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
  await home.locator('.advanced-fields summary').click();
  for (const id of ['siteIconSize', 'siteIconRadius', 'siteIconTextSize', 'siteIconTextColor']) await home.locator(`#${id}`).fill('');
  for (const id of ['siteIconTextWeight', 'siteIconTextFont']) await home.locator(`#${id}`).selectOption('');
  await home.locator('#saveSiteButton').click();
  await expect(icon).toHaveCSS('width', '120px'); await expect(icon).toHaveCSS('border-radius', '25%');
  await expect(icon).toHaveCSS('font-size', '36px'); await expect(icon).toHaveCSS('font-weight', '700');
});

test('icon source switches persist and luminance updates preview and saved text', async ({ extension }, testInfo) => {
  const { home } = extension;
  const image = await readFile(resolve('public/icon/128.png'));
  let finishPage;
  const pendingPage = new Promise(resolve => { finishPage = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === '/slow') {
      await pendingPage;
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<link rel="icon" href="/icon.png">');
    } else { response.writeHead(200, { 'content-type': 'image/png' }); response.end(image); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/slow`;
  const preview = home.locator('#sitePreview');
  const setColor = value => home.locator('#siteColor').evaluate((input, color) => { input.value = color; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  try {
    await addWebsite(home);
    await home.locator('#siteName').fill('测试网站'); await home.locator('#siteUrl').fill(url);
    await expect(home.locator('#siteIconStatus')).toHaveText('正在获取图标…');
    await home.locator('[data-icon-source="text"]').click();
    await expect(preview).toHaveText('测');
    await setColor('#222222'); await expect(preview).toHaveCSS('color', 'rgb(255, 255, 255)');
    await setColor('#eeeeee'); await expect(preview).toHaveCSS('color', 'rgb(0, 0, 0)');
    finishPage();
    await expect(preview.locator('img')).toHaveCount(0);
    await home.screenshot({ path: testInfo.outputPath('single-character-icon.png') });
    await home.locator('#saveSiteButton').click(); await home.reload();
    const card = home.locator('.site-card[title="测试网站"]');
    await expect(card.locator('.site-icon')).toHaveText('测'); await expect(card.locator('.site-icon')).toHaveCSS('color', 'rgb(0, 0, 0)');
    await card.click({ button: 'right' }); await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
    await expect(home.locator('[data-icon-source="text"]')).toHaveAttribute('aria-pressed', 'true');
    await home.locator('[data-icon-source="website"]').click();
    await expect(preview.locator('img')).toHaveAttribute('src', url.replace('/slow', '/icon.png'));
    await expect(home.locator('#siteIconStatus')).toContainText('已获取');
    await home.locator('#saveSiteButton').click(); await home.reload();
    await expect(card.locator('img')).toHaveAttribute('src', url.replace('/slow', '/icon.png'));
    await card.click({ button: 'right' }); await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
    await home.locator('[data-icon-source="custom"]').click(); await home.locator('#siteIcon').fill(url.replace('/slow', '/custom.png'));
    await expect(preview.locator('img')).toHaveAttribute('src', url.replace('/slow', '/custom.png'));
    await home.locator('#saveSiteButton').click(); await home.reload();
    await expect(card.locator('img')).toHaveAttribute('src', url.replace('/slow', '/custom.png'));
  } finally { finishPage(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('nested bookmark menus stay compact, fit edges and restore the parent selection', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  const ids = await worker.evaluate(async () => {
    const [root] = await chrome.bookmarks.getTree();
    const bar = root.children.find(node => node.folderType === 'bookmarks-bar' || node.id === '1');
    for (let i = 0; i < 6; i++) await chrome.bookmarks.create({ parentId: bar.id, title: `常用收藏 ${i}`, url: `https://example.com/${i}` });
    const top = await chrome.bookmarks.create({ parentId: bar.id, title: '多层收藏' });
    for (let i = 0; i < 18; i++) await chrome.bookmarks.create({ parentId: top.id, title: `资料 ${i}`, url: `https://example.com/docs/${i}` });
    const child = await chrome.bookmarks.create({ parentId: top.id, title: '很长的子文件夹名称用于检查多层下拉宽度保持一致' });
    const deep = await chrome.bookmarks.create({ parentId: child.id, title: '第三层文件夹' });
    const empty = await chrome.bookmarks.create({ parentId: deep.id, title: '空文件夹' });
    await chrome.bookmarks.create({ parentId: deep.id, title: '深层收藏', url: 'https://example.com/deep' });
    return { top: top.id, child: child.id, deep: deep.id, empty: empty.id };
  });
  await settings(home, 'sites'); await home.locator('#showBookmarksBar').check(); await home.locator('#closeSettings').click();
  const menu = home.locator('#bookmarkFolderMenu');
  const entry = id => menu.locator(`[data-bookmark-id="${id}"]`);
  const panels = menu.locator('.bookmark-menu-panel');
  await home.setViewportSize({ width: 900, height: 900 });
  await home.locator(`#bookmarkBar [data-bookmark-id="${ids.top}"]`).click();
  await entry(ids.child).click();
  await expect(panels).toHaveCount(2);
  await expect(entry(ids.child)).toHaveAttribute('aria-expanded', 'true');
  await entry(ids.deep).press('ArrowRight'); await expect(panels).toHaveCount(3);
  await expect(entry(ids.empty)).toBeFocused();
  const rectangles = await panels.evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; }));
  for (const bounds of rectangles) { expect(bounds.left).toBeGreaterThanOrEqual(8); expect(bounds.right).toBeLessThanOrEqual(892); expect(bounds.bottom).toBeLessThanOrEqual(892); expect(bounds.width).toBe(264); }
  expect(rectangles[1].left).toBeLessThan(rectangles[0].left);
  expect(rectangles[2].right).toBeLessThan(rectangles[1].left);
  await home.screenshot({ path: testInfo.outputPath('nested-bookmark-menus.png'), animations: 'disabled' });
  await home.keyboard.press('ArrowLeft'); await expect(panels).toHaveCount(2); await expect(entry(ids.deep)).toBeFocused();
  await menu.locator('.bookmark-back:not(:disabled)').click(); await expect(entry(ids.child)).toBeFocused();
  expect(await menu.locator('.bookmark-folder-list').evaluate(list => list.scrollTop)).toBeGreaterThan(0);
  await home.keyboard.press('Escape');
  await home.setViewportSize({ width: 390, height: 620 });
  await home.locator(`#bookmarkBar [data-bookmark-id="${ids.top}"]`).click();
  await entry(ids.child).click(); await expect(panels).toHaveCount(1);
  await entry(ids.deep).click(); await entry(ids.empty).click();
  await expect(menu).toContainText('此文件夹为空');
  await expect(menu.locator('.bookmark-back')).toBeFocused();
  const bounds = await panels.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.x + bounds.width).toBeLessThanOrEqual(382); expect(bounds.y + bounds.height).toBeLessThanOrEqual(612);
  await home.screenshot({ path: testInfo.outputPath('nested-bookmark-mobile.png'), animations: 'disabled' });
  await home.keyboard.press('ArrowLeft'); await expect(entry(ids.empty)).toBeFocused();
  await home.keyboard.press('ArrowLeft'); await expect(entry(ids.deep)).toBeFocused();
  await home.keyboard.press('ArrowLeft'); await expect(entry(ids.child)).toBeFocused();
  expect(await menu.locator('.bookmark-folder-list').evaluate(list => list.scrollTop)).toBeGreaterThan(0);
  await home.keyboard.press('Escape'); await expect(menu).toBeHidden();
});

test('shortcut library searches, adds websites and builtins, deduplicates across tabs and fits mobile', async ({ extension }, testInfo) => {
  const { home, worker, context } = extension;
  const dialog = home.locator('#siteLibraryModal');
  const card = id => dialog.locator(`[data-catalog-id="${id}"]`);
  await desktopMenu(home, '添加网站');
  await expect(dialog).toBeVisible(); await expect(home.locator('#librarySearch')).toBeFocused();
  await expect(card('github')).toHaveAttribute('aria-disabled', 'true');
  await home.locator('#librarySearch').fill('插件');
  await expect(dialog.locator('.library-card')).toHaveCount(1);
  await expect(card('builtin-extensions')).toContainText('已添加');
  await home.locator('#librarySearch').fill('sspai.com'); await card('sspai').click();
  await expect(card('sspai')).toContainText('已添加');
  await expect(home.locator('#libraryStatus')).toContainText('已添加 少数派');
  await expect(dialog).toBeVisible();
  await card('sspai').click({ force: true });
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.sites.filter(site => site.url === 'https://sspai.com/').length)).toBe(1);
  await home.locator('#librarySearch').fill(''); await dialog.locator('[data-category="browser"]').click();
  await expect(dialog.locator('.library-card')).toHaveCount(5);
  const other = await context.newPage(); await other.goto(home.url());
  const responses = await Promise.all([home, other].map(page => page.evaluate(() => chrome.runtime.sendMessage({ type: 'tabcat:catalog-pin', id: 'builtin-downloads' }))));
  await other.close();
  expect(responses.map(result => result.duplicate).sort()).toEqual([false, true]);
  await expect(card('builtin-downloads')).toContainText('已添加');
  await card('builtin-settings').click(); await expect(card('builtin-settings')).toContainText('已添加');
  await home.screenshot({ path: testInfo.outputPath('shortcut-library.png'), animations: 'disabled' });
  await home.locator('#libraryDone').click();
  await home.locator('[data-site="builtin-history"]').click({ button: 'right' }); await home.getByRole('menuitem', { name: '移除快捷方式' }).click();
  await desktopMenu(home, '添加网站'); await card('builtin-history').click(); await expect(card('builtin-history')).toContainText('已添加');
  await home.locator('#libraryDone').click(); await home.reload();
  await expect(home.locator('[data-site="builtin-downloads"] svg')).toHaveCount(1);
  await settings(home, 'search'); await home.locator('#openInNewTab').check(); await home.locator('#closeSettings').click();
  await test.step('open the downloads builtin in a new tab', async () => {
    await home.locator('[data-site="builtin-downloads"]').click();
    const cdp = await context.browser().newBrowserCDPSession();
    let downloadTarget;
    await expect.poll(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      downloadTarget = targetInfos.find(target => target.url === 'chrome://downloads/');
      return Boolean(downloadTarget);
    }).toBe(true);
    await cdp.send('Target.closeTarget', { targetId: downloadTarget.targetId }); await cdp.detach();
  });
  await context.setOffline(true);
  await home.setViewportSize({ width: 390, height: 700 }); await desktopMenu(home, '添加网站');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await home.screenshot({ path: testInfo.outputPath('shortcut-library-mobile.png'), animations: 'disabled' });
  await home.locator('#librarySearch').fill('不存在的网站xyz'); await expect(home.locator('#libraryEmpty')).toBeVisible();
  await home.locator('#libraryCustom').click(); await expect(home.locator('#siteModal')).toBeVisible();
});

test('bare website address retains a wide homepage wordmark and can refresh cached artwork', async ({ extension }) => {
  const { home, worker, context } = extension;
  const png = await readFile(resolve('public/icon/128.png'));
  const small = await readFile(resolve('public/icon/32.png'));
  await context.route('https://icon-fixture.example/**', route => route.fulfill({ contentType: 'image/png', body: route.request().url().endsWith('/favicon.png') ? small : png }));
  await worker.evaluate(() => {
    const original = globalThis.fetch; globalThis.iconDocumentRequests = 0;
    globalThis.fetch = async (url, options) => {
      if (url === 'https://icon-fixture.example/') {
        globalThis.iconDocumentRequests++;
        const response = new Response('<header><a href="/"><svg class="logo" viewBox="0 0 400 100"><rect width="400" height="100" fill="red"/></svg><svg class="logo" viewBox="0 0 100 100"><rect width="100" height="100" fill="black"/></svg></a></header><link rel="icon" href="/favicon.png">', { headers: { 'content-type': 'text/html' } });
        Object.defineProperty(response, 'url', { value: url }); return response;
      }
      return original(url, options);
    };
  });
  await addWebsite(home); await home.locator('#siteName').fill('图标测试'); await home.locator('#siteUrl').fill('icon-fixture.example');
  await expect(home.locator('#sitePreview img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(home.locator('#sitePreview img')).toHaveCSS('object-fit', 'contain');
  await expect.poll(() => worker.evaluate(() => globalThis.iconDocumentRequests)).toBe(1);
  await home.locator('#refreshSiteIcon').click();
  await expect.poll(() => worker.evaluate(() => globalThis.iconDocumentRequests)).toBe(2);
  await expect(home.locator('#sitePreview img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await home.locator('#saveSiteButton').click(); await home.reload();
  await expect(home.locator('.site-card[title="图标测试"] img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await worker.evaluate(async () => {
    const { tabcat } = await chrome.storage.local.get('tabcat');
    const site = tabcat.sites.find(site => site.name === '图标测试');
    site.logoCandidates = ['https://icon-fixture.example/stale.png'];
    await chrome.storage.local.set({ tabcat });
  });
  await expect(home.locator('.site-card[title="图标测试"] img')).toHaveAttribute('src', 'https://icon-fixture.example/stale.png');
  await home.locator('.site-card[title="图标测试"]').click({ button: 'right' }); await home.getByRole('menuitem', { name: '编辑快捷方式' }).click();
  await home.locator('#refreshSiteIcon').click();
  await expect(home.locator('#sitePreview img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await home.locator('#saveSiteButton').click(); await home.reload();
  await expect(home.locator('.site-card[title="图标测试"] img')).toHaveAttribute('src', /^data:image\/png;base64,/);
});

test('social and AI library icons remain images offline and persist after adding', async ({ extension }, testInfo) => {
  const { home, context, worker } = extension;
  await context.setOffline(true);
  await desktopMenu(home, '添加网站');
  const dialog = home.locator('#siteLibraryModal');
  const images = dialog.locator('.library-icon img');
  await expect(images).toHaveCount(SITE_CATALOG.filter(site => site.iconPath).length);
  await expect.poll(() => images.evaluateAll(nodes => nodes.every(img => img.complete && img.naturalWidth >= 16 && new URL(img.src).pathname.startsWith('/catalog/')))).toBe(true);
  await expect(dialog.locator('.library-icon')).toHaveCount(79);
  for (const [category, count] of [['social-cn', 7], ['social-global', 11], ['ai-cn', 8], ['ai-global', 13]]) {
    await dialog.locator(`[data-category="${category}"]`).click();
    await expect(dialog.locator('.library-card')).toHaveCount(count);
  }
  await home.screenshot({ path: testInfo.outputPath('ai-library-offline.png'), animations: 'disabled' });
  await dialog.locator('[data-category="all"]').click();
  for (const id of ['x', 'xiaohongshu', 'chatgpt', 'deepseek', 'sspai', 'jd', 'weibo']) {
    await dialog.locator(`[data-catalog-id="${id}"]`).click();
    await expect(dialog.locator(`[data-catalog-id="${id}"]`)).toContainText('已添加');
  }
  await home.locator('#libraryDone').click();
  await home.reload();
  for (const id of ['x', 'xiaohongshu', 'chatgpt', 'deepseek', 'sspai', 'jd', 'weibo', 'github']) {
    const icon = home.locator(`#sitesPages .site-icon img[src="${SITE_CATALOG.find(site => site.id === id).iconPath}"]`);
    await expect(icon).toHaveCount(1);
    await expect.poll(() => icon.evaluate(img => img.complete && img.naturalWidth >= 16)).toBe(true);
  }
  // Bundled artwork must never override an explicit user choice.
  await worker.evaluate(async () => {
    const { tabcat } = await chrome.storage.local.get('tabcat');
    tabcat.sites.find(site => site.url === 'https://x.com/').iconText = '字';
    const image = tabcat.sites.find(site => site.url === 'https://chatgpt.com/');
    image.icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
    await chrome.storage.local.set({ tabcat });
  });
  await expect(home.locator('.site-card[title="X"] .site-icon')).toHaveText('字');
  await expect(home.locator('.site-card[title="ChatGPT"] img')).toHaveAttribute('src', /^data:image\/png/);
  await home.setViewportSize({ width: 390, height: 700 });
  await desktopMenu(home, '添加网站');
  await dialog.locator('[data-category="social-cn"]').click();
  await expect(dialog.locator('.library-card')).toHaveCount(7);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await home.screenshot({ path: testInfo.outputPath('social-library-mobile-offline.png'), animations: 'disabled' });
});

test('desktop folders merge, rename, move out and dissolve without losing shortcuts', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await settings(home, 'sites'); await expect(home.locator('#siteList')).toHaveCount(0);
  await home.locator('#editDesktopSettings').click();
  await home.locator('[data-site="github"]').dragTo(home.locator('[data-site="youtube"]'));
  await expect(home.locator('[data-folder]')).toHaveCount(1);
  await expect(home.locator('#sitesPages [data-site]')).toHaveCount(6);
  await home.locator('[data-folder]').click();
  await expect(home.locator('#desktopFolder [data-site]')).toHaveCount(2);
  await home.locator('#folderName').fill('开发工具'); await home.locator('#folderTitle').click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.folders[0]?.name)).toBe('开发工具');
  await home.locator('[data-member-out="github"]').click();
  await expect(home.locator('#desktopFolder [data-site]')).toHaveCount(1);
  await home.locator('[data-folder-close]').click();
  await home.locator('[data-site="github"]').dragTo(home.locator('[data-folder]'));
  await home.locator('[data-folder]').click();
  await expect(home.locator('#desktopFolder [data-site]')).toHaveCount(2);
  await home.screenshot({ path: testInfo.outputPath('folder.png') });
  await home.locator('[data-folder-dissolve]').click();
  await expect(home.locator('[data-folder]')).toHaveCount(0);
  await expect(home.locator('#sitesPages [data-site]')).toHaveCount(8);
  await home.reload();
  await expect(home.locator('#sitesPages [data-site]')).toHaveCount(8);
});

test('note widgets persist, reorder with keyboard, resize, and undo removal', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await addTool(home, 'note', async () => { await home.locator('#widgetName').fill('今日备忘'); });
  const note = home.locator('[data-note]'); await expect(note).toBeVisible();
  await note.fill('整理设计稿\n周五发布 <script>这只是文本</script>');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets[0]?.text)).toContain('周五发布');
  await home.reload(); await expect(note).toHaveValue('整理设计稿\n周五发布 <script>这只是文本</script>');
  await expect(home.locator('[data-note-count]')).toHaveText(`${[...'整理设计稿\n周五发布 <script>这只是文本</script>'].length} 字`);
  await home.locator('#editDesktopButton').click();
  await home.locator('[data-widget-edit]').click();
  await home.locator('#widgetSize').selectOption('4,3');
  await home.getByRole('button', { name: '保存组件', exact: true }).click();
  const widgetTile = home.locator('.desktop-widget'); await widgetTile.focus(); await home.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.desktopOrder.findIndex(item => item.id.startsWith('widget:')))).toBe(1);
  await home.locator('[data-widget-remove]').click(); await expect(note).toHaveCount(0);
  await home.locator('#status').getByRole('button', { name: '撤销' }).click(); await expect(note).toHaveValue('整理设计稿\n周五发布 <script>这只是文本</script>');
  await home.locator('#finishEditing').click();
  await home.setViewportSize({ width: 390, height: 844 });
  await home.locator('.page-dot').nth(1).click();
  await home.locator('#sitesPages').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await expect(note).toBeVisible();
  expect(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const tileBox = await widgetTile.boundingBox(); expect(tileBox.x).toBeGreaterThanOrEqual(0); expect(tileBox.x + tileBox.width).toBeLessThanOrEqual(390);
  await home.screenshot({ path: testInfo.outputPath('widget-mobile.png'), fullPage: true });
});

test('weather city selection, offline retry and sandboxed web widgets work', async ({ extension }, testInfo) => {
  const { home, context, worker } = extension;
  let offline = false;
  await context.route('https://geocoding-api.open-meteo.com/**', route => route.fulfill({ json: { results: [{ name: '杭州', admin1: '四川', admin2: '甘孜藏族自治州', country: '中国', latitude: 30.06517, longitude: 102.19527, feature_code: 'PPL' }, { name: '杭州', admin1: '浙江', admin2: '杭州市', country: '中国', latitude: 30.27, longitude: 120.15, feature_code: 'PPLA', population: 9236032 }] } }));
  await context.route('https://api.open-meteo.com/**', route => offline ? route.abort() : route.fulfill({ json: { current: { temperature_2m: 23.6, weather_code: 2, relative_humidity_2m: 65, time: '2026-10-10T14:30' } } }));
  await context.route('https://widgets.example.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>嵌入工具已加载</h1>' }));
  await addTool(home, 'weather');
  await home.locator('#editDesktopButton').click(); await home.locator('[data-widget-edit]').click();
  await expect(home.locator('#widgetLocationMode')).toHaveValue('ip');
  await home.locator('#widgetLocationMode').selectOption('manual');
  await home.locator('#widgetCity').fill('杭州'); await home.locator('#findWidgetCity').click();
  await expect(home.locator('#widgetCityResults button').first()).toHaveText('杭州 · 浙江 · 杭州市 · 中国');
  await home.locator('#widgetCityResults button').first().click(); await home.getByRole('button', { name: '保存组件', exact: true }).click();
  await home.locator('#finishEditing').click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets[0]?.longitude)).toBe(120.15);
  await expect(home.locator('[data-weather]')).toContainText('24°'); await expect(home.locator('[data-weather]')).toContainText('杭州');
  offline = true; await home.locator('[data-weather-refresh]').click(); await expect(home.locator('[data-weather]')).toContainText('暂时无法');
  offline = false; await home.locator('[data-weather-refresh]').click(); await expect(home.locator('[data-weather]')).toContainText('24°');
  await home.locator('#addWidgetButton').click(); await home.locator('[data-widget-type="web"]').click(); await home.locator('#widgetUrl').fill('http://widgets.example.test');
  await home.getByRole('button', { name: '保存组件', exact: true }).click(); await expect(home.locator('#widgetError')).toContainText('HTTPS');
  await home.locator('#widgetUrl').fill('https://widgets.example.test/embed'); await home.getByRole('button', { name: '保存组件', exact: true }).click();
  await home.locator('#libraryDone').click();
  await expect(home.frameLocator('.widget-web iframe').getByRole('heading')).toHaveText('嵌入工具已加载');
  await expect(home.locator('.widget-web iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups');
  await expect(home.locator('.web-footer a')).toHaveAttribute('href', 'https://widgets.example.test/embed');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets.length)).toBe(2);
  await home.screenshot({ path: testInfo.outputPath('widgets-desktop.png'), fullPage: true });
});

async function addTool(home, type, configure) {
  await home.locator('#addWidgetButton').click(); await home.locator(`[data-widget-type="${type}"]`).click();
  await expect(home.locator('#libraryStatus')).toContainText('已添加');
  await home.locator('#libraryDone').click();
  await expect(home.locator(`#sitesPages .widget-${type}`)).toBeVisible();
  if (configure) {
    await home.locator('#editDesktopButton').click(); await home.locator(`#sitesPages .widget-${type} [data-widget-edit]`).click();
    await configure(); await home.getByRole('button', { name: '保存组件', exact: true }).click();
    await home.locator('#finishEditing').click();
  }
}

test('clock, calendar and countdown tools configure and fit a narrow grid', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await addTool(home, 'clock', async () => { await home.locator('#widgetTimezone').selectOption('UTC'); });
  await expect(home.locator('[data-live-time]')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(home.locator('.widget-clock small')).toHaveText('UTC');
  await addTool(home, 'calendar');
  const month = await home.locator('[data-month-title]').textContent();
  await home.getByRole('button', { name: '下个月', exact: true }).click(); await expect(home.locator('[data-month-title]')).not.toHaveText(month);
  await home.locator('[data-calendar="today"]').click(); await expect(home.locator('[data-month-title]')).toHaveText(month);
  await expect(home.locator('.calendar-days [aria-current="date"]')).toHaveCount(1);
  const date = await home.evaluate(() => { const day = new Date(); day.setDate(day.getDate() + 10); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; });
  await addTool(home, 'countdown', async () => { await home.locator('#widgetName').fill('旅行出发'); await home.locator('#widgetTargetDate').fill(date); });
  await expect(home.locator('[data-countdown-number]')).toHaveText('10');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets.length)).toBe(3);
  await home.reload(); await expect(home.locator('[data-countdown-number]')).toHaveText('10');
  await home.screenshot({ path: testInfo.outputPath('date-tools.png'), fullPage: true });
  await home.setViewportSize({ width: 390, height: 844 });
  await home.screenshot({ path: testInfo.outputPath('countdown-mobile.png'), fullPage: true });
  expect(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('todos save, sync across tabs, toggle and undo; calculator parses without executing code', async ({ extension }, testInfo) => {
  const { home, worker, context, id } = extension;
  await addTool(home, 'todo');
  await home.locator('[data-todo-input]').fill('整理项目资料'); await home.locator('.todo-add').getByRole('button').click();
  await home.locator('[data-todo-input]').fill('<script>普通文本</script>'); await home.locator('[data-todo-input]').press('Enter');
  await expect(home.locator('.todo-row')).toHaveCount(2);
  const other = await context.newPage(); await other.goto(`chrome-extension://${id}/newtab.html`);
  await expect(other.locator('.todo-row')).toHaveCount(2);
  await other.locator('[data-todo-check]').first().check(); await expect(home.locator('[data-todo-check]').first()).toBeChecked();
  await expect(home.locator('.todo-progress')).toHaveAttribute('aria-valuenow', '50');
  await home.locator('[data-todo-clear]').click(); await expect(home.locator('.todo-row')).toHaveCount(1);
  await home.locator('#status').getByRole('button', { name: '撤销' }).click(); await expect(home.locator('.todo-row')).toHaveCount(2);
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets[0].items.length)).toBe(2);
  await home.reload(); await expect(home.locator('.todo-row')).toHaveCount(2);
  await addTool(home, 'calculator');
  const input = home.locator('[data-calculator-input]'), result = home.locator('[data-calculator-result]');
  await input.fill('(12 + 8) * 3'); await input.press('Enter'); await expect(result).toHaveText('60');
  await input.fill('200 * 15%'); await input.press('Enter'); await expect(result).toHaveText('30');
  await input.fill('1 / 0'); await input.press('Enter'); await expect(result).toHaveText('不能除以零'); await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.fill('alert(1)'); await input.press('Enter'); await expect(result).toContainText('算式有误');
  await home.locator('[data-calculator-clear]').click(); await expect(input).toHaveValue(''); await expect(input).toHaveAttribute('aria-invalid', 'false');
  await home.screenshot({ path: testInfo.outputPath('productivity-tools.png'), fullPage: true });
  await other.close();
});

test('pomodoro starts, survives reload, pauses, finishes and switches modes', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await addTool(home, 'pomodoro', async () => { await home.locator('#widgetFocusMinutes').fill('1'); await home.locator('#widgetBreakMinutes').fill('2'); });
  await expect(home.locator('[data-timer-value]')).toHaveText('01:00');
  await home.locator('[data-timer="toggle"]').click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets[0].timer.endsAt)).toBeGreaterThan(0);
  await home.reload(); await expect(home.locator('[data-timer="toggle"]')).toHaveText('暂停');
  await home.locator('[data-timer="toggle"]').click(); await expect(home.locator('[data-timer="toggle"]')).toHaveText('开始');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets[0].timer.endsAt)).toBeNull();
  await home.locator('[data-timer="toggle"]').click();
  await expect(home.locator('[data-timer="toggle"]')).toHaveText('暂停');
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); tabcat.widgets[0].timer.endsAt = Date.now() - 1000; await chrome.storage.local.set({ tabcat }); });
  await expect(home.locator('[data-timer-status]')).toContainText('本轮专注完成'); await expect(home.locator('[data-timer-value]')).toHaveText('00:00');
  await home.locator('[data-timer="break"]').click(); await expect(home.locator('[data-timer-value]')).toHaveText('02:00');
  await home.locator('#editDesktopButton').click(); await expect(home.locator('[data-timer="toggle"]')).toBeDisabled();
  await home.locator('[data-widget-edit]').click(); await home.locator('#widgetFocusMinutes').fill('30'); await home.getByRole('button', { name: '保存组件', exact: true }).click();
  await home.locator('#finishEditing').click(); await expect(home.locator('[data-timer-value]')).toHaveText('30:00');
  await home.screenshot({ path: testInfo.outputPath('pomodoro.png'), fullPage: true });
});

test('desktop stays vertically centered in one viewport with an overlaid bookmark bar', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  for (const scenario of [
    { width: 1360, height: 900, bookmarks: false, clock: false, search: true, rows: 2 },
    { width: 1360, height: 900, bookmarks: true, clock: true, search: true, rows: 2 },
    { width: 680, height: 500, bookmarks: true, clock: true, search: true, rows: 6 },
    { width: 390, height: 640, bookmarks: true, clock: false, search: false, rows: 3 },
  ]) {
    await home.setViewportSize({ width: scenario.width, height: scenario.height });
    await worker.evaluate(async ({ bookmarks, clock, search, rows }) => {
      const { tabcat } = await chrome.storage.local.get('tabcat');
      await chrome.storage.local.set({ tabcat: { ...tabcat, showBookmarksBar: bookmarks, showClock: clock, showSearch: search, layoutRows: rows } });
    }, scenario);
    await expect(home.locator('#showBookmarksBar')).toBeChecked({ checked: scenario.bookmarks });
    await expect(home.locator('#layoutRows')).toHaveValue(String(scenario.rows));
    const icon = home.locator('#sitesPages [data-site="github"] .site-icon');
    let normalIconWidth;
    for (const editing of [false, true]) {
      if (editing) await home.locator('#editDesktopButton').click();
      await expect.poll(() => home.evaluate(() => {
        const box = document.querySelector('.desktop-content').getBoundingClientRect();
        const bar = document.querySelector('#bookmarkBar');
        const top = bar.hidden ? 0 : bar.getBoundingClientRect().bottom;
        return Math.abs((box.top - top) - (innerHeight - box.bottom));
      })).toBeLessThan(2);
      const bounds = await home.locator('.desktop-content').boundingBox();
      if (!editing) normalIconWidth = (await icon.boundingBox()).width;
      else {
        await expect.poll(async () => Math.abs((await icon.boundingBox()).width - normalIconWidth)).toBeLessThan(1);
        const gap = await home.locator('[data-desktop-key="site:github"]').evaluate(tile => {
          const frame = tile.querySelector('.tile-edit-frame').getBoundingClientRect();
          const icon = tile.querySelector('.site-icon').getBoundingClientRect();
          return Math.min(icon.top - frame.top, icon.left - frame.left, frame.right - icon.right) / (icon.width / tile.querySelector('.site-icon').offsetWidth);
        });
        expect(gap).toBeGreaterThanOrEqual(7);
        const hint = home.locator('#editingHint');
        if (await hint.isVisible()) {
          const hintBox = await hint.boundingBox();
          expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(bounds.y - 11);
        }
        await expect.poll(() => home.locator('#sitesPages').evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.effect?.target.matches('.desktop-tile')).length)).toBe(0);
        await home.screenshot({ path: testInfo.outputPath(`editing-spacing-${scenario.width}-${scenario.height}.png`) });
      }
      expect(bounds.y).toBeGreaterThanOrEqual(scenario.bookmarks ? 42 : 0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(scenario.height);
      await home.mouse.move(scenario.width / 2, scenario.height / 2);
      await home.mouse.wheel(0, 1000);
      await home.keyboard.press('PageDown');
      await home.evaluate(() => { window.scrollTo(0, 1000); document.body.scrollTop = 1000; });
      expect(await home.evaluate(() => [scrollY, document.documentElement.scrollTop, document.body.scrollTop])).toEqual([0, 0, 0]);
      if (editing) await home.locator('#finishEditing').click();
    }
    const wallpaper = await home.locator('.wallpaper-frame').boundingBox();
    expect(wallpaper).toEqual({ x: 0, y: 0, width: scenario.width, height: scenario.height });
    await home.screenshot({ path: testInfo.outputPath(`centered-${scenario.width}-${scenario.height}.png`) });
  }
  await settings(home, 'appearance');
  const panel = home.locator('.panel-content');
  await panel.hover(); await home.mouse.wheel(0, 800);
  await expect.poll(() => panel.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  expect(await home.evaluate(() => scrollY)).toBe(0);
});

test('candidate sidebar previews are inert, adds on click, shares search and fits narrow screens', async ({ extension }, testInfo) => {
  const { home, worker, context } = extension;
  const requests = [];
  context.on('request', request => { if (/open-meteo|ipwho\.is|widgets\.example/.test(request.url())) requests.push(request.url()); });
  await home.locator('#addWidgetButton').click();
  const drawer = home.locator('#siteLibraryModal');
  await expect(drawer.locator('[data-widget-type]')).toHaveCount(9);
  await expect(drawer.locator('.widget-option-preview .widget-card')).toHaveCount(9);
  await expect(drawer.locator('iframe')).toHaveCount(0);
  await expect(drawer.locator('.widget-weather')).toContainText('24°');
  await expect(drawer.locator('.calendar-days span')).toHaveCount(42);
  await expect(drawer.locator('.todo-row')).toHaveCount(2);
  expect(await drawer.evaluate(node => node.matches(':modal'))).toBe(false);
  const shell = await home.locator('.app-shell').boundingBox(), sidebar = await drawer.boundingBox();
  expect(shell.x + shell.width).toBeLessThan(sidebar.x);
  await home.screenshot({ path: testInfo.outputPath('candidate-sidebar.png'), animations: 'disabled' });
  await drawer.locator('[data-widget-type="note"]').focus(); await home.keyboard.press('Enter');
  await expect(home.locator('#sitesPages [data-note]')).toHaveCount(1);
  await expect(home.locator('#widgetModal')).toBeHidden();
  await expect(home.locator('#libraryStatus')).toContainText('已添加 备忘');
  await drawer.locator('[data-library-kind="all"]').click();
  await expect(drawer.locator('[data-catalog-id="github"]')).toHaveAttribute('aria-disabled', 'true');
  await drawer.locator('#librarySearch').fill('计算器');
  await expect(drawer.locator('[data-widget-type]')).toHaveCount(1);
  await expect(drawer.locator('.library-card')).toHaveCount(0);
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); await chrome.storage.local.set({ tabcat: { ...tabcat, theme: 'dark' } }); });
  await expect(home.locator('html')).toHaveAttribute('data-theme', 'dark');
  await home.setViewportSize({ width: 390, height: 640 });
  await expect.poll(() => drawer.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const mobileShell = await home.locator('.app-shell').boundingBox(), mobileDrawer = await drawer.boundingBox();
  expect(mobileShell.y + mobileShell.height).toBeLessThanOrEqual(mobileDrawer.y + 1);
  await home.screenshot({ path: testInfo.outputPath('candidate-sidebar-mobile.png'), animations: 'disabled' });
  await drawer.locator('[data-widget-type="calculator"]').focus(); await home.keyboard.press('Enter');
  await expect(home.locator('#libraryStatus')).toContainText('已添加 计算器');
  await home.keyboard.press('Escape'); await expect(drawer).toBeHidden();
  await expect(home.locator('#addWidgetButton')).toBeFocused();
  expect(requests).toEqual([]);
  await home.reload();
  await expect(home.locator('#sitesPages .widget-calculator')).toHaveCount(1);
  await expect(home.locator('#sitesPages .widget-note')).toHaveCount(1);
});

test('candidate icons and widgets drag onto the desktop, cancel safely and persist placement', async ({ extension }, testInfo) => {
  const { home, worker } = extension;
  await home.locator('#addWidgetButton').click();
  const drawer = home.locator('#siteLibraryModal');
  const target = home.locator('[data-desktop-key="site:github"]');
  await drawer.locator('[data-widget-type="note"]').dragTo(target, { targetPosition: { x: 5, y: 20 } });
  await expect(home.locator('#libraryStatus')).toContainText('已添加 备忘');
  await expect.poll(() => worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); const index = tabcat.desktopOrder.findIndex(item => item.id === 'site:github'); return tabcat.desktopOrder[index - 1]?.id.startsWith('widget:'); })).toBe(true);
  await drawer.locator('[data-library-kind="sites"]').click(); await drawer.locator('#librarySearch').fill('sspai');
  await drawer.locator('[data-catalog-id="sspai"]').dragTo(home.locator('.sites-page:not([inert]) [data-desktop-key]').first(), { targetPosition: { x: 5, y: 20 } });
  await expect(home.locator('#libraryStatus')).toContainText('已添加 少数派');
  await expect(drawer.locator('[data-catalog-id="sspai"]')).toHaveAttribute('draggable', 'false');
  const order = await worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.desktopOrder);
  await drawer.locator('[data-library-kind="widgets"]').click(); await drawer.locator('#librarySearch').fill('日历');
  await drawer.locator('[data-widget-type="calendar"]').dragTo(home.locator('#libraryTitle'));
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets.length)).toBe(1);
  await home.screenshot({ path: testInfo.outputPath('candidate-drag-result.png') });
  await home.locator('#libraryDone').click(); await home.reload();
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.desktopOrder)).toEqual(order);
});

test('empty desktop accepts candidates and web drops retain their position after configuration', async ({ extension }) => {
  const { home, context, worker } = extension;
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); await chrome.storage.local.set({ tabcat: { ...tabcat, sites: [], desktopOrder: [] } }); });
  await expect(home.locator('#sitesPages [data-site]')).toHaveCount(0);
  await home.locator('#addWidgetButton').click();
  const drawer = home.locator('#siteLibraryModal');
  await drawer.locator('[data-widget-type="note"]').dragTo(home.locator('.sites-page:not([inert])'));
  await expect(home.locator('#libraryStatus')).toContainText('已添加 备忘');
  await drawer.locator('#librarySearch').fill('网页');
  const note = home.locator('.desktop-widget');
  await drawer.locator('[data-widget-type="web"]').dragTo(note, { targetPosition: { x: 5, y: 20 } });
  await expect(home.locator('#widgetModal')).toBeVisible();
  await home.locator('#widgetModal').getByRole('button', { name: '取消', exact: true }).click();
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets.length)).toBe(1);
  await context.route('https://widgets.example.test/**', route => route.fulfill({ body: 'Tool' }));
  await drawer.locator('[data-widget-type="web"]').dragTo(note, { targetPosition: { x: 5, y: 20 } });
  await home.locator('#widgetUrl').fill('https://widgets.example.test/embed'); await home.locator('#saveWidget').click();
  await expect.poll(() => worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); return tabcat.widgets.find(widget => `widget:${widget.id}` === tabcat.desktopOrder[0].id)?.type; })).toBe('web');
  await home.locator('#libraryDone').click(); await home.locator('#editDesktopButton').click(); await home.locator('#addWidgetButton').click();
  await home.keyboard.press('Escape');
  await expect(drawer).toBeHidden(); await expect(home.locator('#finishEditing')).toBeVisible();
});

test('weather defaults to IP location, refreshes its city and preserves manual choices', async ({ extension }, testInfo) => {
  const { home, context, worker } = extension;
  let ipCalls = 0, forecastCalls = 0, city = '杭州', longitude = 120.16;
  await context.route('https://ipwho.is/**', route => { ipCalls++; return route.fulfill({ json: { success: true, city, region: city === '杭州' ? '浙江' : '上海', country: '中国', latitude: 30.29, longitude } }); });
  await context.route('https://api.open-meteo.com/**', route => { forecastCalls++; return route.fulfill({ json: { current: { temperature_2m: 24, weather_code: 2, relative_humidity_2m: 65, time: '2026-10-10T14:30' } } }); });
  await addTool(home, 'weather');
  const weather = home.locator('#sitesPages [data-weather]');
  await expect(weather).toContainText('杭州'); await expect(weather).toContainText('IP 定位');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets[0]?.locationMode)).toBe('ip');
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.widgets[0].latitude)).toBeUndefined();
  expect(ipCalls).toBe(1); expect(forecastCalls).toBe(1);
  city = '上海'; longitude = 121.47;
  await home.locator('[data-weather-refresh]').click(); await expect(weather).toContainText('上海');
  expect(ipCalls).toBe(2);
  await home.reload(); await expect(weather).toContainText('上海');
  await home.screenshot({ path: testInfo.outputPath('ip-weather.png') });
  await context.route('https://geocoding-api.open-meteo.com/**', route => route.fulfill({ json: { results: [{ name: '北京', admin1: '北京', country: '中国', latitude: 39.9, longitude: 116.4 }] } }));
  await home.locator('#editDesktopButton').click(); await home.locator('[data-widget-edit]').click();
  await home.locator('#widgetLocationMode').selectOption('manual');
  await home.locator('#widgetCity').fill('北京'); await home.locator('#findWidgetCity').click(); await home.locator('#widgetCityResults button').click();
  await home.locator('#saveWidget').click(); await home.locator('#finishEditing').click();
  await expect(weather).toContainText('北京'); await expect(weather).not.toContainText('IP 定位');
  const before = ipCalls;
  await home.reload(); await expect(weather).toContainText('北京'); expect(ipCalls).toBe(before);
  await home.locator('#editDesktopButton').click(); await home.locator('[data-widget-edit]').click();
  await expect(home.locator('#widgetLocationMode')).toHaveValue('manual');
  await home.locator('#widgetLocationMode').selectOption('ip'); await home.locator('#saveWidget').click();
  await expect(weather).toContainText('上海');
});

test('failed IP lookup never fetches weather for fake coordinates and can retry or switch to manual', async ({ extension }) => {
  const { home, context } = extension;
  let failed = true, forecastCalls = 0;
  await context.route('https://ipwho.is/**', route => route.fulfill({ json: failed ? { success: false, message: 'Rate limit exceeded' } : { success: true, city: '杭州', latitude: 30.29, longitude: 120.16 } }));
  await context.route('https://api.open-meteo.com/**', route => { forecastCalls++; return route.fulfill({ json: { current: { temperature_2m: 24, weather_code: 0, relative_humidity_2m: 60, time: '2026-10-10T14:30' } } }); });
  await addTool(home, 'weather');
  const weather = home.locator('#sitesPages [data-weather]');
  await expect(weather).toContainText('暂时无法按 IP 定位'); expect(forecastCalls).toBe(0);
  failed = false; await home.locator('[data-weather-refresh]').click(); await expect(weather).toContainText('杭州');
  failed = true; await home.locator('[data-weather-refresh]').click(); await expect(weather).toContainText('暂时无法按 IP 定位');
  await home.locator('[data-weather-settings]').click();
  await expect(home.locator('#widgetLocationMode')).toHaveValue('manual'); await expect(home.locator('#widgetCity')).toBeFocused();
  await home.locator('#saveWidget').click(); await expect(home.locator('#widgetError')).toContainText('请搜索并选择');
});

test('wallpaper alarms update hidden tabs before focus and keep rotating without a new-tab page', async ({ extension }) => {
  const { home, context, worker } = extension;
  const images = await Promise.all(['public/icon/128.png', 'public/wallpapers/fjord-preview.jpg'].map(async path => (await readFile(resolve(path))).toString('base64')));
  await worker.evaluate(async images => {
    const original = globalThis.fetch;
    globalThis.rotationCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://picsum.photos/v2/list')) {
        globalThis.rotationCalls++;
        return new Response(JSON.stringify([{ id: String(globalThis.rotationCalls), width: 3000, height: 2000, author: '后台轮换', url: 'https://example.com/photo' }]));
      }
      if (String(url).startsWith('https://picsum.photos/id/')) {
        const index = (globalThis.rotationCalls - 1) % 2;
        return new Response(Uint8Array.from(atob(images[index]), char => char.charCodeAt(0)), { headers: { 'content-type': index ? 'image/jpeg' : 'image/png' } });
      }
      return original(url, options);
    };
    const { tabcat } = await chrome.storage.local.get('tabcat');
    await chrome.storage.local.set({ tabcat: { ...tabcat, background: 'picsum', wallpaperRotation: 'hourly' } });
  }, images);
  await expect.poll(() => worker.evaluate(() => globalThis.rotationCalls)).toBe(1);
  await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).toContain(`data:image/png;base64,${images[0]}`);
  expect(await worker.evaluate(() => chrome.alarms.get('tabcat:wallpaper-rotation'))).toMatchObject({ periodInMinutes: 1 });
  const other = await context.newPage(); await other.goto('about:blank'); await other.bringToFront();
  // Headless Chromium may keep all pages "visible"; emulate the platform signal
  // in that case, while using the real worker alarm and real storage events.
  await home.evaluate(() => {
    if (!document.hidden) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  const expireAndTick = () => worker.evaluate(async () => {
    const { tabcatGallery } = await chrome.storage.local.get('tabcatGallery');
    await chrome.storage.local.set({ tabcatGallery: { ...tabcatGallery, key: 'hour:expired' } });
    await chrome.alarms.create('tabcat:wallpaper-rotation', { when: Date.now() + 100, periodInMinutes: 1 });
  });
  await expireAndTick();
  await expect.poll(() => worker.evaluate(() => globalThis.rotationCalls)).toBe(2);
  await expect.poll(() => home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'))).toContain(`data:image/jpeg;base64,${images[1]}`);
  await expect(home.locator('.wallpaper-outgoing')).toHaveCount(0);
  const background = await home.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper'));
  await home.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await home.bringToFront();
  const frames = await home.evaluate(() => new Promise(resolve => {
    const frames = [];
    function sample() { frames.push(document.documentElement.style.getPropertyValue('--wallpaper')); if (frames.length < 12) requestAnimationFrame(sample); else resolve(frames); }
    requestAnimationFrame(sample);
  }));
  expect(frames.every(frame => frame === background)).toBe(true);
  expect(await worker.evaluate(() => globalThis.rotationCalls)).toBe(2);
  await home.close(); await other.close();
  await expireAndTick();
  await expect.poll(() => worker.evaluate(() => globalThis.rotationCalls)).toBe(3);
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcatGallery')).tabcatGallery.id)).toBe('3');
});

test('weather scenes follow conditions and daylight without a redundant title', async ({ extension }, testInfo) => {
  const { home, context } = extension;
  let code = 0, day = 1;
  await context.route('https://ipwho.is/**', route => route.fulfill({ json: { success: true, city: '杭州', latitude: 30.29, longitude: 120.16 } }));
  await context.route('https://api.open-meteo.com/**', route => {
    expect(new URL(route.request().url()).searchParams.get('current')).toContain('is_day');
    return route.fulfill({ json: { current: { temperature_2m: 24, weather_code: code, is_day: day, relative_humidity_2m: 65, time: '2026-10-10T14:30' } } });
  });
  await addTool(home, 'weather');
  const card = home.locator('#sitesPages .widget-weather');
  for (const [nextCode, nextDay, scene, label] of [[0, 1, 'clear', '晴'], [0, 0, 'clear', '晴'], [2, 1, 'cloudy', '多云'], [3, 1, 'overcast', '阴'], [45, 1, 'fog', '雾'], [65, 1, 'rain', '大雨'], [75, 1, 'snow', '大雪'], [95, 1, 'storm', '雷雨'], [123, 1, 'unknown', '天气未知']]) {
    code = nextCode; day = nextDay;
    await card.locator('[data-weather-refresh]').click();
    await expect(card).toHaveClass(new RegExp(`weather-${scene}(?: |$)`));
    await expect(card.locator('[data-weather]')).toContainText(label);
    await expect.poll(() => card.evaluate(node => node.classList.contains('weather-night'))).toBe(day === 0);
    await expect(card.locator('.widget-header')).toHaveCount(0);
    await card.screenshot({ path: testInfo.outputPath(`weather-${scene}-${day}.png`) });
  }
  await home.emulateMedia({ reducedMotion: 'reduce' });
  code = 65; await card.locator('[data-weather-refresh]').click();
  await expect(card).toHaveClass(/weather-rain/);
  expect(await card.locator('.weather-particles i').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await home.locator('#editDesktopButton').click();
  await expect(card.locator('.widget-header strong')).toHaveCount(0);
  await home.locator('#sitesPages [data-widget-edit]').click();
  await expect(home.locator('#widgetModal')).toBeVisible();
  await home.locator('#saveWidget').click();
  await expect(home.locator('#widgetModal')).toBeHidden();
  await home.locator('#finishEditing').click();
  await home.setViewportSize({ width: 390, height: 844 });
  await expect(card.locator('[data-weather-refresh]')).toBeVisible();
  await expect.poll(() => card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await card.screenshot({ path: testInfo.outputPath('weather-mobile.png') });
});

test('weather and shortcut dragging show a floating preview and clean it up', async ({ extension }, testInfo) => {
  const { home, context, worker } = extension;
  await context.route('https://ipwho.is/**', route => route.fulfill({ json: { success: true, city: '杭州', latitude: 30.29, longitude: 120.16 } }));
  await context.route('https://api.open-meteo.com/**', route => route.fulfill({ json: { current: { temperature_2m: 24, weather_code: 0, is_day: 1, relative_humidity_2m: 65, time: '2026-10-10T14:30' } } }));
  await addTool(home, 'weather');
  await expect(home.locator('#sitesPages .weather-clear')).toHaveCount(1);
  await home.locator('#editDesktopButton').click();
  for (const source of [home.locator('#sitesPages .desktop-widget'), home.locator('#sitesPages [data-desktop-key="site:github"]')]) {
    // Wait for the preceding layout transition before capturing drag coordinates.
    await expect.poll(() => home.locator('#sitesPages').evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.effect?.target.matches('.desktop-tile')).length)).toBe(0);
    const from = await source.boundingBox(), target = home.locator('#sitesPages [data-desktop-key="site:youtube"]');
    const to = await target.boundingBox();
    await home.mouse.move(from.x + 35, from.y + 65); await home.mouse.down();
    await home.mouse.move(from.x + 48, from.y + 68, { steps: 5 });
    await home.mouse.move(to.x + 18, to.y + 35, { steps: 8 });
    // Native DnD needs a move after dragenter to emit dragover on the target.
    await home.mouse.move(to.x + 19, to.y + 35);
    await expect(home.locator('.desktop-drag-preview')).toHaveCount(1);
    await expect(source).toHaveClass(/dragging/);
    await expect(target).toHaveClass(/drop-before/);
    await expect(home.locator('.desktop-drop-slot')).toBeVisible();
    await expect(source).toHaveCSS('opacity', '0');
    await expect.poll(() => home.locator('.desktop-drag-preview').evaluate(node => Math.round(parseFloat(node.style.left))))
      .toBe(Math.round(to.x + 19 - 35));
    await expect.poll(() => home.locator('#sitesPages').evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.effect?.target.matches('.desktop-tile')).length)).toBe(0);
    await home.screenshot({ path: testInfo.outputPath(`drag-${await source.getAttribute('data-desktop-key')}.png`) });
    await home.mouse.up();
    await expect(home.locator('.desktop-drag-preview')).toHaveCount(0);
    await expect(home.locator('#sitesPages .dragging')).toHaveCount(0);
  }
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('tabcat')).tabcat.desktopOrder.map(item => item.id).indexOf('site:github') < (await chrome.storage.local.get('tabcat')).tabcat.desktopOrder.map(item => item.id).indexOf('site:youtube'))).toBe(true);
  await home.reload(); await expect(home.locator('#sitesPages .widget-weather')).toHaveCount(1);
});

test('tool cards fit compact light and dark layouts and expose their changing states', async ({ extension }, testInfo) => {
  const { home, worker, context } = extension;
  await home.emulateMedia({ reducedMotion: 'reduce' });
  await home.clock.setFixedTime(new Date('2026-10-10T12:00:00Z'));
  await context.route('https://widgets.example.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body style="font:14px system-ui;background:#f4f7fa;color:#34465b;padding:16px"><h3>随手阅读</h3><p>让常用工具留在桌面。</p></body>' }));
  const samples = [
    { type: 'note', name: '今日备忘', text: '整理今天的灵感\n把想做的事，慢慢变成日常。' },
    { type: 'todo', name: '待办', items: [{ id: 'a', text: '整理项目资料', done: true }, { id: 'b', text: '留一点时间给自己', done: false }] },
    { type: 'clock', name: '时钟', timezone: 'UTC', hour24: true },
    { type: 'calendar', name: '日历' },
    { type: 'countdown', name: '旅行出发', targetDate: '2026-10-20' },
    { type: 'pomodoro', name: '番茄钟', focusMinutes: 25, breakMinutes: 5, timer: { phase: 'focus', remaining: 900, endsAt: null } },
    { type: 'calculator', name: '计算器' },
    { type: 'web', name: '阅读角', url: 'https://widgets.example.test/embed' },
  ];
  for (const theme of ['light', 'dark']) {
    await home.setViewportSize({ width: theme === 'light' ? 1360 : 390, height: 900 });
    for (const sample of samples) {
      await worker.evaluate(async ({ sample, theme }) => {
        const { tabcat } = await chrome.storage.local.get('tabcat');
        await chrome.storage.local.set({ tabcat: { ...tabcat, theme, sites: [], folders: [], widgets: [{ ...sample, id: 'visual-tool', width: 2, height: 2 }], desktopOrder: [{ id: 'widget:visual-tool' }] } });
      }, { sample, theme });
      const card = home.locator(`#sitesPages .widget-${sample.type}`);
      await expect(card).toBeVisible();
      await expect(home.locator('html')).toHaveAttribute('data-theme', theme);
      await expect.poll(() => card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      if (sample.type === 'pomodoro') {
        const ring = await card.locator('.timer-ring').boundingBox(); expect(ring.width).toBeGreaterThan(80); expect(ring.height).toBeGreaterThan(80);
        await expect(card).toHaveAttribute('data-timer-state', 'paused');
        await expect(card.locator('[data-timer-status]')).toContainText('已暂停');
        expect(await card.locator('.tool-pomodoro').evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
      }
      if (sample.type === 'clock') { await expect(card.locator('[data-live-time]')).toHaveText('12:00:00'); await expect(card).not.toHaveClass(/clock-night/); }
      if (sample.type === 'countdown') { await expect(card).toHaveAttribute('data-countdown-state', 'future'); await expect(card.locator('.widget-header strong')).toHaveText('旅行出发'); }
      if (sample.type === 'web') { await expect(card.locator('.web-origin')).toHaveText('widgets.example.test'); await expect(card.locator('iframe')).toHaveAttribute('src', sample.url); }
      await card.screenshot({ path: testInfo.outputPath(`${sample.type}-${theme}.png`), animations: 'disabled' });
    }
  }
  // The clock scene follows the configured timezone; it is independent of weather permissions.
  await worker.evaluate(async () => { const { tabcat } = await chrome.storage.local.get('tabcat'); tabcat.widgets = [{ id: 'visual-tool', type: 'clock', name: '伦敦时间', width: 2, height: 2, timezone: 'UTC', hour24: false }]; await chrome.storage.local.set({ tabcat }); });
  await home.clock.setFixedTime(new Date('2026-10-10T22:00:00Z'));
  await expect(home.locator('#sitesPages .widget-clock')).toHaveClass(/clock-night/);
  await expect(home.locator('#sitesPages .widget-clock .widget-header strong')).toHaveText('伦敦时间');
  await home.locator('#sitesPages .widget-clock').screenshot({ path: testInfo.outputPath('clock-night-custom.png') });
});

test('widget spans align with icon artwork edges rather than label cells', async ({ extension }) => {
  const { home, worker } = extension;
  await addTool(home, 'note');
  await home.emulateMedia({ reducedMotion: 'reduce' });
  await home.mouse.move(0, 0);
  for (const scenario of [
    { width: 2, height: 2, iconSize: 72, columnGap: 46, rowGap: 34, columns: 4 },
    { width: 2, height: 2, iconSize: 48, columnGap: 20, rowGap: 16, columns: 4 },
    { width: 3, height: 2, iconSize: 88, columnGap: 28, rowGap: 24, columns: 5 },
    { width: 4, height: 3, iconSize: 64, columnGap: 24, rowGap: 28, columns: 6 },
  ]) {
    await worker.evaluate(async scenario => {
      const { tabcat } = await chrome.storage.local.get('tabcat');
      const widget = { id: 'aligned', type: 'note', name: '对齐卡片', text: '', width: scenario.width, height: scenario.height };
      await chrome.storage.local.set({ tabcat: { ...tabcat, iconSize: scenario.iconSize, columnGap: scenario.columnGap, rowGap: scenario.rowGap, layoutColumns: scenario.columns, layoutRows: scenario.height, widgets: [widget], desktopOrder: [{ id: 'widget:aligned' }, ...tabcat.sites.map(site => ({ id: `site:${site.id}` }))] } });
    }, scenario);
    await expect(home.locator('#sitesPages [data-note]')).toHaveCount(1);
    await expect.poll(() => home.evaluate(({ width, height, iconSize }) => {
      const card = document.querySelector('#sitesPages .widget-card').getBoundingClientRect();
      const page = document.querySelector('.sites-page:not([inert])');
      const tiles = [...page.querySelectorAll('[data-desktop-key^="site:"]')];
      const first = tiles[0], next = tiles[1], below = tiles.find(tile => tile.style.gridRowStart !== first.style.gridRowStart);
      if (!below || !next) return 999;
      const icon = first.querySelector('.site-icon').getBoundingClientRect();
      const across = next.querySelector('.site-icon').getBoundingClientRect(), down = below.querySelector('.site-icon').getBoundingClientRect();
      const expectedWidth = icon.width + (width - 1) * (across.x - icon.x);
      const expectedHeight = icon.height + (height - 1) * (down.y - icon.y);
      const expectedLeft = page.getBoundingClientRect().left + icon.left - first.getBoundingClientRect().left;
      return Math.max(Math.abs(card.width - expectedWidth), Math.abs(card.height - expectedHeight), Math.abs(card.top - icon.top), Math.abs(card.left - expectedLeft));
    }, scenario)).toBeLessThan(1);
  }
});

test('weather cache survives new tabs, keeps offline readings and changes at sunset without fetching', async ({ extension }, testInfo) => {
  const { home, context, worker, id } = extension;
  const base = Date.parse('2026-10-10T12:05:00Z') / 1000;
  await context.addInitScript(time => { window.weatherTestNow = time; Date.now = () => window.weatherTestNow; }, base * 1000);
  await home.reload();
  let ipCalls = 0, weatherCalls = 0, offline = false;
  await context.route('https://ipwho.is/**', route => {
    ipCalls++;
    return offline ? route.abort() : route.fulfill({ json: { success: true, city: '杭州', latitude: 30.29, longitude: 120.16 } });
  });
  await context.route('https://api.open-meteo.com/**', route => {
    weatherCalls++;
    return offline ? route.abort() : route.fulfill({ json: { utc_offset_seconds: 0, current: { temperature_2m: 24, weather_code: 0, is_day: 1, relative_humidity_2m: 65, time: base }, daily: { time: [base - 43500, base + 42900], sunrise: [base - 3600, base + 82800], sunset: [base + 10, base + 86410] } } });
  });
  await addTool(home, 'weather');
  const card = home.locator('#sitesPages .widget-weather');
  await expect(card).toContainText('24°'); await expect(card).not.toHaveClass(/weather-night/);
  await expect(card.locator('.weather-sun')).toBeVisible();
  expect(ipCalls).toBe(1); expect(weatherCalls).toBe(1);
  await home.evaluate(time => { window.weatherTestNow = time; document.dispatchEvent(new Event('visibilitychange')); }, (base + 30) * 1000);
  await expect(card).toHaveClass(/weather-night/); await expect(card.locator('.weather-moon')).toBeVisible(); await expect(card.locator('.weather-sun')).toBeHidden();
  expect(weatherCalls).toBe(1);
  await home.reload(); await expect(card).toContainText('24°');
  expect(ipCalls).toBe(1); expect(weatherCalls).toBe(1);
  const other = await context.newPage(); await other.goto(`chrome-extension://${id}/newtab.html`);
  await expect(other.locator('#sitesPages .widget-weather')).toContainText('24°'); expect(ipCalls).toBe(1); expect(weatherCalls).toBe(1);
  await other.close();
  await worker.evaluate(async () => {
    const { tabcatWeatherCacheV1: cache } = await chrome.storage.local.get('tabcatWeatherCacheV1');
    cache.ip.at -= 900000; cache.automatic.at -= 900000;
    Object.values(cache.readings).forEach(entry => { entry.at -= 900000; });
    await chrome.storage.local.set({ tabcatWeatherCacheV1: cache });
  });
  offline = true;
  await home.reload(); await expect(card).toContainText('24°'); await expect(card).toContainText('保留上次天气');
  await expect(card).toContainText('更新于 10-10 12:05');
  await expect(card.locator('[data-weather]')).not.toContainText(/正在|加载/);
  await card.screenshot({ path: testInfo.outputPath('cached-weather-offline.png') });
  offline = false; await card.locator('[data-weather-refresh]').click();
  await expect.poll(() => weatherCalls).toBe(2);
  await expect(card.locator('[data-weather]')).not.toHaveAttribute('aria-busy', 'true');
  await expect(card.locator('.weather-cache-state')).toHaveCount(0);
});
