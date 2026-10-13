export const WIDGET_TYPES = {
  note: ['备忘', '随手记录'], weather: ['天气', '关注一座城市'], web: ['网页', '嵌入你的工具'],
  clock: ['时钟', '世界时间'], calendar: ['日历', '查看每个月'], todo: ['待办', '完成一件小事'],
  countdown: ['倒数日', '期待重要日子'], pomodoro: ['番茄钟', '专注与休息'], calculator: ['计算器', '快速算一下'],
};
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function localDate(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function daysUntil(target, now = new Date()) {
  if (!validDate(target)) return null;
  // Compare calendar dates, not elapsed 24-hour periods (daylight saving time).
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${localDate(now)}T00:00:00Z`)) / 86400000);
}
export function calendarMonth(year, month) {
  const first = new Date(0); first.setFullYear(year, month, 1); first.setHours(12, 0, 0, 0);
  const last = new Date(first); last.setMonth(month + 1, 0);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => index >= offset && index < offset + last.getDate() ? index - offset + 1 : null);
}
const integer = (value, min, max, fallback) => Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
export function normalizeTool(widget) {
  if (widget.type === 'clock') {
    let timezone = typeof widget.timezone === 'string' ? widget.timezone : 'Asia/Shanghai';
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }); } catch { timezone = 'Asia/Shanghai'; }
    return { timezone, hour24: widget.hour24 !== false };
  }
  if (widget.type === 'note') {
    // Older notes kept a single text field; it becomes the first entry.
    const ids = new Set(), legacy = typeof widget.text === 'string' && widget.text.trim() ? [{ id: 'note', text: widget.text, updatedAt: 0 }] : [];
    return { notes: (Array.isArray(widget.notes) ? widget.notes : legacy).filter(note => note && typeof note.id === 'string' && note.id && typeof note.text === 'string' && !ids.has(note.id) && ids.add(note.id)).slice(0, 200).map(note => ({ id: note.id, text: note.text.slice(0, 20000), updatedAt: Number.isFinite(note.updatedAt) && note.updatedAt > 0 ? note.updatedAt : 0 })) };
  }
  if (widget.type === 'countdown') return { targetDate: validDate(widget.targetDate) ? widget.targetDate : '' };
  if (widget.type === 'todo') {
    const ids = new Set();
    return { items: (Array.isArray(widget.items) ? widget.items : []).filter(item => item && typeof item.id === 'string' && item.id && typeof item.text === 'string' && item.text.trim() && !ids.has(item.id) && ids.add(item.id)).slice(0, 100).map(item => ({ id: item.id, text: item.text.trim().slice(0, 200), done: item.done === true })) };
  }
  if (widget.type === 'pomodoro') {
    const focusMinutes = integer(widget.focusMinutes, 1, 120, 25), breakMinutes = integer(widget.breakMinutes, 1, 60, 5);
    const phase = widget.timer?.phase === 'break' ? 'break' : 'focus', duration = (phase === 'focus' ? focusMinutes : breakMinutes) * 60;
    return { focusMinutes, breakMinutes, timer: { phase, remaining: integer(widget.timer?.remaining, 0, duration, duration), endsAt: Number.isFinite(widget.timer?.endsAt) && widget.timer.endsAt > 0 && widget.timer.endsAt <= 8640000000000000 ? widget.timer.endsAt : null } };
  }
  return {};
}
export function timerSeconds(widget, now = Date.now()) {
  return widget.timer.endsAt === null ? widget.timer.remaining : Math.max(0, Math.min((widget.timer.phase === 'focus' ? widget.focusMinutes : widget.breakMinutes) * 60, Math.ceil((widget.timer.endsAt - now) / 1000)));
}
export function timerAction(widget, action, now = Date.now()) {
  const phase = action === 'focus' || action === 'break' ? action : widget.timer.phase;
  const duration = (phase === 'focus' ? widget.focusMinutes : widget.breakMinutes) * 60;
  if (action === 'reset' || action === 'focus' || action === 'break') return { phase, remaining: duration, endsAt: null };
  const remaining = timerSeconds(widget, now);
  if (widget.timer.endsAt !== null && remaining > 0) return { phase, remaining, endsAt: null };
  return { phase, remaining: remaining || duration, endsAt: now + (remaining || duration) * 1000 };
}
// Merge per item so two devices editing different entries keep both changes.
export function mergeTodoItems(current = [], before = [], after = [], fields = ['text', 'done']) {
  const items = new Map(current.map(item => [item.id, item]));
  for (const item of before) if (!after.some(next => next.id === item.id)) items.delete(item.id);
  for (const item of after) {
    const old = before.find(previous => previous.id === item.id);
    if (!old) items.set(item.id, item);
    else if (items.has(item.id)) {
      const merged = { ...items.get(item.id) };
      for (const key of fields) if (old[key] !== item[key]) merged[key] = item[key];
      items.set(item.id, merged);
    }
  }
  return [...items.values()];
}
export const mergeNotes = (current, before, after) => mergeTodoItems(current, before, after, ['text', 'updatedAt']);
// The note shown on the desktop card: the one edited most recently.
export const latestNote = notes => notes.reduce((latest, note) => !latest || note.updatedAt > latest.updatedAt ? note : latest, null);
// A small arithmetic parser: no eval, Function constructor, or remote code.
export function calculate(expression) {
  const source = String(expression).replace(/×/g, '*').replace(/[÷]/g, '/').replace(/−/g, '-');
  if (!source.trim() || source.length > 200) throw new Error('请输入 200 字以内的算式');
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/%]|\S/g) || [];
  let index = 0;
  const fail = () => { throw new Error('算式有误，请检查数字、运算符和括号'); };
  function primary() {
    let value;
    if (tokens[index] === '+' || tokens[index] === '-') { const sign = tokens[index++]; value = (sign === '-' ? -1 : 1) * primary(); }
    else if (tokens[index] === '(') { index++; value = sum(); if (tokens[index++] !== ')') fail(); }
    else { const token = tokens[index++]; if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token || '')) fail(); value = Number(token); }
    while (tokens[index] === '%') { index++; value /= 100; }
    return value;
  }
  function product() {
    let value = primary();
    while (tokens[index] === '*' || tokens[index] === '/') {
      const operator = tokens[index++], right = primary();
      if (operator === '/' && right === 0) throw new Error('不能除以零');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }
  function sum() {
    let value = product();
    while (tokens[index] === '+' || tokens[index] === '-') { const operator = tokens[index++], right = product(); value = operator === '+' ? value + right : value - right; }
    return value;
  }
  const result = sum(); if (index !== tokens.length) fail();
  if (!Number.isFinite(result)) throw new Error('结果超出可计算范围');
  return String(Number(result.toPrecision(12)));
}
