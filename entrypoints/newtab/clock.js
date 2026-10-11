import { $, state, pad } from './app.js';

export function updateClock() {
  const now = new Date();
  const timeParts = new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone, hour: '2-digit', minute: '2-digit', hour12: !state.hour24 }).formatToParts(now);
  const hour = timeParts.find(p => p.type === 'hour')?.value || '';
  const minute = timeParts.find(p => p.type === 'minute')?.value || '';
  const period = timeParts.find(p => p.type === 'dayPeriod')?.value || '';
  $('#clock').textContent = state.hour24 ? `${hour}:${minute}` : `${hour}:${minute} ${period}`;
  const parts = getDateParts(now, state.timezone);
  if (state.dateStyle === 'full') $('#dateText').textContent = `${parts.year}年${parts.month}月${parts.day}日 ${parts.weekday}`;
  else if (state.dateStyle === 'iso') $('#dateText').textContent = `${parts.year}-${pad(parts.month)}-${pad(parts.day)} · ${parts.weekday}`;
  else $('#dateText').textContent = `${parts.month}月${parts.day}日 · ${parts.weekday}`;
  const lunar = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: state.timezone, month: 'long', day: 'numeric' }).format(now);
  $('#lunarText').textContent = `农历${lunar.replace(/\s/g, '')}`;
  $('#lunarText').style.display = state.showLunar ? '' : 'none';
  $('.date-line .separator').style.display = state.showLunar ? '' : 'none';
}

function getDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long' }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
