import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, mergeState, pinSite } from '../lib/state.js';
import { desktopItems, packDesktop, mergeDesktopSites, moveDesktopItem } from '../lib/desktop.js';
import { createBackup, parseBackup } from '../lib/backup.js';

test('old desktops migrate in order and a popup pin remains visible', () => {
  const before = normalizeState();
  assert.deepEqual(desktopItems(before).map(item => item.id), before.sites.map(item => item.id));
  const added = pinSite(before, { name: 'Example', url: 'https://example.com' }).state;
  const after = structuredClone(before); moveDesktopItem(after, 'site:github', 'site:zhihu', true);
  const merged = mergeState(normalizeState(added), before, after);
  assert.deepEqual(desktopItems(merged).slice(0,4).map(item => item.id), ['youtube', 'bilibili', 'zhihu', 'github']);
  assert.equal(desktopItems(merged).at(-1).name, 'Example');
});
test('folder creation preserves target position, membership and backup roundtrip', () => {
  const before = normalizeState(), after = structuredClone(before);
  assert.ok(mergeDesktopSites(after, 'site:github', 'site:youtube', 'work'));
  const merged = mergeState(before, before, after);
  assert.equal(merged.desktopOrder[0].id, 'folder:work');
  assert.deepEqual(merged.folders[0].siteIds, ['youtube', 'github']);
  assert.ok(mergeDesktopSites(merged, 'site:zhihu', 'folder:work', 'unused'));
  merged.widgets.push({ id: 'note', type: 'note', name: '备忘', text: '<script>literal</script>', width: 2, height: 2 });
  assert.deepEqual(parseBackup(createBackup(normalizeState(merged))), normalizeState(merged));
});
test('invalid widget sources and duplicate memberships are removed without losing sites', () => {
  const state = normalizeState({ folders: [{ id: 'one', siteIds: ['github','missing','github'] }, { id: 'two', siteIds: ['github', 'youtube'] }], widgets: [{ id: 'bad', type: 'web', url: 'javascript:alert(1)' }, { id: 'http', type: 'web', url: 'http://example.com' }, { id: 'bad-weather', type: 'weather', latitude: 100, longitude: 1 }, { id: 'note', type: 'note', text: 'x'.repeat(21000) }], desktopOrder: [{ id: 'site:missing' }, { id: 'folder:one' }, { id: 'folder:one' }] });
  assert.deepEqual(state.folders.map(folder => folder.siteIds), [['github'], ['youtube']]);
  assert.equal(state.widgets.length, 1); assert.equal(state.widgets[0].text.length, 20000);
  assert.equal(new Set(state.desktopOrder.map(item => item.id)).size, state.desktopOrder.length);
  assert.equal(desktopItems(state).filter(item => item.kind === 'site').length, state.sites.length - 2);
});
test('mixed-size grid never overlaps or exceeds the viewport at any supported width', () => {
  for (let columns = 2; columns <= 12; columns++) for (let preferredRows = 1; preferredRows <= 6; preferredRows++) {
    const items = Array.from({ length: 40 }, (_, i) => ({ key: String(i), width: i % 3 ? 1 : 4, height: i % 3 ? 1 : 3 }));
    const { pages, rows } = packDesktop(items, columns, preferredRows);
    assert.deepEqual(pages.flat().map(item => item.key), items.map(item => item.key));
    for (const page of pages) {
      const occupied = new Set();
      for (const item of page) {
        assert.ok(item.x + item.width <= columns && item.y + item.height <= rows);
        for (let x = item.x; x < item.x + item.width; x++) for (let y = item.y; y < item.y + item.height; y++) {
          assert.ok(!occupied.has(`${x},${y}`)); occupied.add(`${x},${y}`);
        }
      }
    }
  }
});
test('stale widget settings preserve newer notes and deletions', () => {
  const before = normalizeState({ widgets: [{ id: 'note', type: 'note', text: 'old' }] });
  const current = structuredClone(before); current.widgets[0].text = 'new';
  const after = structuredClone(before); after.widgets[0].name = 'Updated title';
  const merged = mergeState(current, before, after);
  assert.equal(merged.widgets[0].text, 'new'); assert.equal(merged.widgets[0].name, 'Updated title');
  current.widgets = []; assert.equal(mergeState(current, before, after).widgets.length, 0);
});
