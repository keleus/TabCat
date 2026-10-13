import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, mergeState, pinSite } from '../lib/state.js';
import { desktopItems, packDesktop, moveDesktopItem, placeOnPage } from '../lib/desktop.js';
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
test('old folders open back up in place and a backup roundtrips', () => {
  const state = normalizeState({ folders: [{ id: 'work', siteIds: ['zhihu', 'github', 'missing'] }], desktopOrder: [{ id: 'site:youtube' }, { id: 'folder:work' }, { id: 'site:bilibili' }] });
  assert.equal(state.folders, undefined);
  assert.deepEqual(state.desktopOrder.slice(0, 4).map(item => item.id), ['site:youtube', 'site:zhihu', 'site:github', 'site:bilibili']);
  assert.equal(desktopItems(state).filter(item => item.kind === 'site').length, state.sites.length);
  state.widgets.push({ id: 'note', type: 'note', name: '备忘', notes: [{ id: 'a', text: '<script>literal</script>', updatedAt: 1 }], width: 2, height: 2 });
  assert.deepEqual(parseBackup(createBackup(normalizeState(state))), normalizeState(state));
});
test('invalid widget sources and duplicate references are removed without losing sites', () => {
  const state = normalizeState({ widgets: [{ id: 'bad', type: 'web', url: 'javascript:alert(1)' }, { id: 'http', type: 'web', url: 'http://example.com' }, { id: 'bad-weather', type: 'weather', latitude: 100, longitude: 1 }, { id: 'note', type: 'note', text: 'x'.repeat(21000) }], desktopOrder: [{ id: 'site:missing' }, { id: 'site:github' }, { id: 'site:github' }] });
  assert.equal(state.widgets.length, 1); assert.equal(state.widgets[0].notes[0].text.length, 20000);
  assert.equal(new Set(state.desktopOrder.map(item => item.id)).size, state.desktopOrder.length);
  assert.equal(desktopItems(state).filter(item => item.kind === 'site').length, state.sites.length);
});
test('mixed-size grid never overlaps or exceeds the viewport at any supported width', () => {
  for (let columns = 2; columns <= 12; columns++) for (let preferredRows = 1; preferredRows <= 6; preferredRows++) {
    const items = Array.from({ length: 40 }, (_, i) => ({ key: String(i), width: i % 3 ? 1 : 4, height: i % 3 ? 1 : 3 }));
    const { pages, rows } = packDesktop(items, columns, preferredRows);
    assert.deepEqual(pages.flat().map(item => item.key).sort(), items.map(item => item.key).sort());
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
test('a widget that wraps leaves no hole for later shortcuts', () => {
  const items = [...'abcde'.split('').map(key => ({ key, width: 1, height: 1 })), { key: 'w', width: 2, height: 2 }, { key: 'f', width: 1, height: 1 }, { key: 'g', width: 1, height: 1 }];
  const { pages } = packDesktop(items, 6, 3);
  const at = key => { const item = pages[0].find(item => item.key === key); return [item.x, item.y]; };
  assert.equal(pages.length, 1);
  assert.deepEqual(at('w'), [0, 1]); assert.deepEqual(at('f'), [5, 0]); assert.deepEqual(at('g'), [2, 1]);
  // A page that cannot fit a big widget is still filled by the shortcuts after it.
  const crowded = packDesktop([...'abcd'.split('').map(key => ({ key, width: 1, height: 1 })), { key: 'w', width: 2, height: 2 }, { key: 'e', width: 1, height: 1 }], 5, 1);
  assert.deepEqual(crowded.pages.map(page => page.map(item => item.key)), [['a', 'b', 'c', 'd', 'e'], ['w']]);
});
test('cross-page drops land on the hovered slot after earlier pages reflow', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const items = [...keys.map(key => ({ key, width: 1, height: 1 })), { key: 'add', width: 1, height: 1 }];
  const drop = (source, pageIndex, x, y = 0) => {
    const placement = placeOnPage(items, source, 3, 1, pageIndex, slot => Math.hypot(slot.x - x, slot.y - y));
    const state = { desktopOrder: keys.map(id => ({ id })) };
    moveDesktopItem(state, source, placement.target, placement.after);
    return packDesktop(state.desktopOrder.map(({ id }) => ({ key: id, width: 1, height: 1 })), 3, 1).pages;
  };
  const position = (pages, key) => { const page = pages.findIndex(page => page.some(item => item.key === key)); return [page, pages[page].find(item => item.key === key).x]; };
  // Forward: b leaves page 0, so d reflows back; b must still land on page 1.
  for (let x = 0; x < 3; x++) assert.deepEqual(position(drop('b', 1, x), 'b'), [1, x]);
  // Backward: e moves to page 0 and pushes c forward.
  for (let x = 0; x < 3; x++) assert.deepEqual(position(drop('e', 0, x), 'e'), [0, x]);
  // The last page keeps its own slots, including past the final item.
  assert.deepEqual(position(drop('a', 2, 2), 'a'), [2, 0]);
  assert.equal(placeOnPage(items, 'missing', 3, 1, 0, () => 0), null);
});

test('stale widget settings preserve newer notes and deletions', () => {
  const before = normalizeState({ widgets: [{ id: 'note', type: 'note', notes: [{ id: 'a', text: 'old', updatedAt: 1 }] }] });
  const current = structuredClone(before); current.widgets[0].notes[0] = { id: 'a', text: 'new', updatedAt: 2 };
  const after = structuredClone(before); after.widgets[0].name = 'Updated title';
  const merged = mergeState(current, before, after);
  assert.equal(merged.widgets[0].notes[0].text, 'new'); assert.equal(merged.widgets[0].name, 'Updated title');
  current.widgets = []; assert.equal(mergeState(current, before, after).widgets.length, 0);
});
test('a single old note becomes the first entry, and devices editing different notes keep both', () => {
  assert.deepEqual(normalizeState({ widgets: [{ id: 'n', type: 'note', text: '买牛奶' }] }).widgets[0].notes, [{ id: 'note', text: '买牛奶', updatedAt: 0 }]);
  assert.deepEqual(normalizeState({ widgets: [{ id: 'n', type: 'note', text: '  ' }] }).widgets[0].notes, []);
  const before = normalizeState({ widgets: [{ id: 'n', type: 'note', notes: [{ id: 'a', text: 'A', updatedAt: 1 }, { id: 'b', text: 'B', updatedAt: 1 }] }] });
  const current = structuredClone(before); current.widgets[0].notes[0] = { id: 'a', text: 'A2', updatedAt: 2 };
  const after = structuredClone(before); after.widgets[0].notes[1] = { id: 'b', text: 'B2', updatedAt: 3 }; after.widgets[0].notes.push({ id: 'c', text: 'C', updatedAt: 4 });
  assert.deepEqual(mergeState(current, before, after).widgets[0].notes.map(note => note.text), ['A2', 'B2', 'C']);
});
