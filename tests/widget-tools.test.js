import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, validDate, daysUntil, calendarMonth, timerSeconds, timerAction } from '../lib/widget-tools.js';
import { normalizeState, mergeState } from '../lib/state.js';
import { createBackup, parseBackup } from '../lib/backup.js';

test('calculator respects precedence, signs, parentheses and explicit percent semantics', () => {
  for (const [expression, expected] of [['(12 + 8) × 3', '60'], ['2+3*4', '14'], ['-3 * -2 + .5', '6.5'], ['200 * 15%', '30'], ['200 + 10%', '200.1'], ['0.1+0.2', '0.3'], ['1 / (2 + 2)', '0.25'], ['-(1+2)', '-3']]) assert.equal(calculate(expression), expected);
  for (const expression of ['1/0', 'alert(1)', '1;2', '2**3', '2(3)', '1 2', '(', '1+', '', '9'.repeat(201)]) assert.throws(() => calculate(expression));
});
test('calendar is Monday-first and handles leap years and year boundaries', () => {
  assert.equal(calendarMonth(2024, 1).filter(Boolean).length, 29);
  assert.equal(calendarMonth(2025, 1).filter(Boolean).length, 28);
  assert.equal(calendarMonth(2026, 5)[0], 1);
  assert.equal(calendarMonth(2026, 1)[6], 1);
  assert.equal(calendarMonth(2000, 1).filter(Boolean).at(-1), 29);
  assert.equal(calendarMonth(1900, 1).filter(Boolean).at(-1), 28);
});
test('countdowns use local calendar dates and reject impossible dates', () => {
  assert.ok(validDate('2024-02-29')); assert.ok(!validDate('2025-02-29')); assert.ok(!validDate('2026-13-01')); assert.ok(!validDate('0000-01-01'));
  const now = new Date(2026, 9, 10, 23, 59);
  assert.equal(daysUntil('2026-10-11', now), 1); assert.equal(daysUntil('2026-10-10', now), 0); assert.equal(daysUntil('2026-10-01', now), -9);
  assert.equal(daysUntil('2027-01-01', new Date(2026, 11, 31)), 1);
  assert.equal(daysUntil('2026-03-09', new Date(2026, 2, 8)), 1);
  assert.equal(daysUntil('invalid', now), null);
});
test('pomodoro uses timestamps across pauses, reloads and elapsed sessions', () => {
  const widget = normalizeState({ widgets: [{ id: 'timer', type: 'pomodoro', focusMinutes: 1, breakMinutes: 2 }] }).widgets[0];
  widget.timer = timerAction(widget, 'toggle', 100000);
  assert.equal(widget.timer.endsAt, 160000); assert.equal(timerSeconds(widget, 110000), 50);
  widget.timer = timerAction(widget, 'toggle', 112500); assert.equal(widget.timer.endsAt, null); assert.equal(widget.timer.remaining, 48);
  widget.timer = timerAction(widget, 'toggle', 120000); assert.equal(widget.timer.endsAt, 168000);
  const restored = parseBackup(createBackup(normalizeState({ widgets: [widget] }))).widgets[0];
  assert.equal(timerSeconds(restored, 169000), 0);
  restored.timer = timerAction(restored, 'break', 169000); assert.equal(timerSeconds(restored), 120); assert.equal(restored.timer.endsAt, null);
});
test('all six tool types normalize and roundtrip without injecting or losing records', () => {
  const state = normalizeState({ widgets: [
    { id: 'clock', type: 'clock', timezone: 'Invalid/Zone', hour24: false }, { id: 'calendar', type: 'calendar' },
    { id: 'todo', type: 'todo', items: [{ id: 'x', text: '保存 <文本>', done: true }, { id: 'x', text: '重复' }, null] },
    { id: 'date', type: 'countdown', targetDate: '2026-02-30' }, { id: 'timer', type: 'pomodoro', focusMinutes: -5, breakMinutes: 900, timer: { remaining: -1, endsAt: Infinity } }, { id: 'calculator', type: 'calculator' },
  ] });
  assert.equal(state.widgets.length, 6); assert.equal(state.widgets[0].timezone, 'Asia/Shanghai'); assert.equal(state.widgets[0].hour24, false);
  assert.equal(state.widgets[2].items.length, 1); assert.equal(state.widgets[3].targetDate, '');
  assert.equal(state.widgets[4].focusMinutes, 1); assert.equal(state.widgets[4].breakMinutes, 60); assert.equal(state.widgets[4].timer.endsAt, null);
  assert.deepEqual(parseBackup(createBackup(state)), state);
});
test('concurrent todo additions, edits and deletes merge per item', () => {
  const before = normalizeState({ widgets: [{ id: 'todo', type: 'todo', items: [{ id: 'a', text: 'A', done: false }, { id: 'b', text: 'B', done: false }] }] });
  const current = structuredClone(before); current.widgets[0].items[0].text = 'Renamed'; current.widgets[0].items.push({ id: 'c', text: 'C', done: false });
  const after = structuredClone(before); after.widgets[0].items[0].done = true; after.widgets[0].items.pop(); after.widgets[0].items.push({ id: 'd', text: 'D', done: false });
  const items = mergeState(current, before, after).widgets[0].items;
  assert.deepEqual(items.map(item => item.id), ['a','c','d']); assert.equal(items[0].text, 'Renamed'); assert.equal(items[0].done, true);
  current.widgets[0].items = []; assert.ok(!mergeState(current, before, after).widgets[0].items.some(item => item.id === 'a'));
});
