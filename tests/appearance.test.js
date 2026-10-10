import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastTextColor, firstIconCharacter } from '../lib/appearance.js';
import { normalizeState } from '../lib/state.js';

test('automatic foreground considers perceived luminance, including saturated colors', () => {
  for (const background of ['#000000', '#222222', '#0000ff', '#666666']) assert.equal(contrastTextColor(background), '#ffffff');
  for (const background of ['#ffffff', '#eeeeee', '#ffff00', '#00ff00', '#888888']) assert.equal(contrastTextColor(background), '#000000');
});

test('single-character icons preserve emoji and combining characters', () => {
  assert.equal(firstIconCharacter('  城院'), '城');
  assert.equal(firstIconCharacter('👩‍💻开发'), '👩‍💻');
  assert.equal(firstIconCharacter('e\u0301cole'), 'e\u0301');
  const saved = normalizeState({ sites: [{ id: 'emoji', name: '开发', url: 'https://example.com', iconText: '👩‍💻' }] });
  assert.equal(saved.sites[0].iconText, '👩‍💻');
});

test('automatic contrast is the default while explicit custom colors survive migration', () => {
  assert.equal(normalizeState().iconTextColorMode, 'auto');
  assert.equal(normalizeState({ iconTextColor: '#ffffff' }).iconTextColorMode, 'auto');
  assert.equal(normalizeState({ iconTextColor: '#aabbcc' }).iconTextColorMode, 'custom');
  assert.equal(normalizeState({ iconTextColorMode: 'custom', iconTextColor: '#ffffff' }).iconTextColorMode, 'custom');
});
