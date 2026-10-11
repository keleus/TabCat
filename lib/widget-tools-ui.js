import { UI_ICONS } from './icons.js';
import { calculate, calendarMonth, daysUntil, localDate, timerAction, timerSeconds } from './widget-tools.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
export function createWidgetTools({ getState, save, report }) {
  const months = new Map(), calculators = new Map();
  const root = document.querySelector('#sitesPages');
  function content(widget, editing) {
    let body;
    if (widget.type === 'clock') body = `<div class="clock-sky" aria-hidden="true"></div><div class="widget-time"><time data-live-time></time><span data-live-date></span><small>${escape(widget.timezone.replaceAll('_', ' '))}</small></div>`;
    else if (widget.type === 'calendar') body = `<div class="calendar-nav"><button type="button" data-calendar="-1" aria-label="上个月">‹</button><strong data-month-title></strong><button type="button" data-calendar="1" aria-label="下个月">›</button><button type="button" data-calendar="today">今天</button></div><div class="calendar-weekdays" aria-hidden="true">${['一','二','三','四','五','六','日'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-days" aria-label="本地日历"></div>`;
    else if (widget.type === 'todo') body = `<div class="todo-progress" role="progressbar" aria-label="待办完成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div><form class="todo-add"><input data-todo-input aria-label="新增待办" placeholder="添加一件事，按 Enter" maxlength="200" required><button type="submit" aria-label="添加待办">＋</button></form><div class="todo-list"></div><footer class="todo-footer"><small data-todo-count></small><button type="button" data-todo-clear>清理已完成</button></footer>`;
    else if (widget.type === 'countdown') body = `<div class="countdown-content"><span data-countdown-label></span><div><strong data-countdown-number></strong><span data-countdown-unit>天</span></div><time>${escape(widget.targetDate || '请在组件设置中选择日期')}</time><small>按本地日期计算</small></div>`;
    else if (widget.type === 'pomodoro') body = `<div class="timer-modes"><button type="button" data-timer="focus">专注</button><button type="button" data-timer="break">休息</button></div><div class="timer-face"><svg class="timer-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="45"/><circle class="timer-ring-value" cx="50" cy="50" r="45" pathLength="100"/></svg><strong data-timer-value></strong></div><span class="timer-status" data-timer-status role="status"></span><div class="timer-actions"><button type="button" class="primary-button" data-timer="toggle">开始</button><button type="button" class="secondary-button" data-timer="reset">重置</button></div>`;
    else if (widget.type === 'calculator') {
      const calculator = calculators.get(widget.id) || { expression: '', result: '0' };
      body = `<form class="calculator-form${calculator.error ? ' has-error' : ''}"><input data-calculator-input aria-invalid="${calculator.error === true}" aria-label="计算算式" placeholder="例如 (12 + 8) × 3" value="${escape(calculator.expression)}" maxlength="200" autocomplete="off" spellcheck="false"><output aria-live="polite" aria-label="计算结果" data-calculator-result>${escape(calculator.result)}</output><div class="calculator-actions"><button type="button" class="secondary-button" data-calculator-clear>清空</button><button type="submit" class="primary-button">计算 =</button></div><small>支持 + − × ÷、括号、百分比（50% = 0.5）</small></form>`;
    } else return null;
    return `<fieldset class="widget-tool-body tool-${widget.type}" data-tool-widget="${escape(widget.id)}" ${editing ? 'disabled' : ''}>${body}</fieldset>`;
  }
  function updateCalendar(node, widget) {
    const now = new Date(), today = localDate(now), selected = months.get(widget.id) || { year: now.getFullYear(), month: now.getMonth() };
    const key = `${selected.year}-${selected.month}-${today}`;
    if (node.dataset.calendarKey === key) return;
    node.dataset.calendarKey = key;
    setText(node.querySelector('[data-month-title]'), `${selected.year}年${selected.month + 1}月`);
    node.querySelector('.calendar-days').innerHTML = calendarMonth(selected.year, selected.month).map(day => {
      const date = `${String(selected.year).padStart(4, '0')}-${String(selected.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return day ? `<span ${date === today ? 'class="is-today" aria-current="date"' : ''} aria-label="${date}">${day}</span>` : '<span aria-hidden="true"></span>';
    }).join('');
  }
  function updateTodo(node, widget) {
    const list = node.querySelector('.todo-list'), key = JSON.stringify(widget.items);
    if (list.dataset.items !== key) {
      const focused = list.contains(document.activeElement) ? { id: document.activeElement.dataset.todoCheck || document.activeElement.dataset.todoDelete, kind: document.activeElement.hasAttribute('data-todo-check') ? 'todoCheck' : 'todoDelete' } : null;
      list.dataset.items = key;
      list.innerHTML = widget.items.length ? widget.items.map(item => `<div class="todo-row"><label><input type="checkbox" data-todo-check="${escape(item.id)}" ${item.done ? 'checked' : ''}><span class="${item.done ? 'is-done' : ''}">${escape(item.text)}</span></label><button type="button" data-todo-delete="${escape(item.id)}" aria-label="删除待办 ${escape(item.text)}">${UI_ICONS.close}</button></div>`).join('') : '<p class="widget-empty">今天想完成什么？<br>从一件小事开始。</p>';
      if (focused) [...list.querySelectorAll('input,button')].find(input => input.dataset[focused.kind] === focused.id)?.focus();
    }
    const done = widget.items.filter(item => item.done).length;
    setText(node.querySelector('[data-todo-count]'), `${done} / ${widget.items.length} 已完成`);
    node.querySelector('[data-todo-clear]').disabled = !done;
    const progress = widget.items.length ? Math.round(done / widget.items.length * 100) : 0;
    node.querySelector('.todo-progress').setAttribute('aria-valuenow', String(progress));
    node.style.setProperty('--todo-progress', `${progress}%`);
    node.closest('.widget-card').classList.toggle('todo-complete', widget.items.length > 0 && done === widget.items.length);
  }
  function updateLive(node, widget) {
    if (widget.type === 'clock') {
      const now = new Date();
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: widget.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
      node.closest('.widget-card').classList.toggle('clock-night', hour < 6 || hour >= 18);
      setText(node.querySelector('[data-live-time]'), new Intl.DateTimeFormat('zh-CN', { timeZone: widget.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: widget.hour24 ? 'h23' : 'h12' }).format(now));
      setText(node.querySelector('[data-live-date]'), new Intl.DateTimeFormat('zh-CN', { timeZone: widget.timezone, month: 'long', day: 'numeric', weekday: 'long' }).format(now));
    } else if (widget.type === 'calendar') updateCalendar(node, widget);
    else if (widget.type === 'countdown') {
      const days = daysUntil(widget.targetDate);
      node.closest('.widget-card').dataset.countdownState = days === null ? 'empty' : days === 0 ? 'today' : days > 0 ? 'future' : 'past';
      setText(node.querySelector('[data-countdown-label]'), days === null ? '还没有目标日期' : days === 0 ? '就是今天' : days > 0 ? '距离这一天还有' : '这一天已经过去');
      setText(node.querySelector('[data-countdown-number]'), days === null ? '—' : String(Math.abs(days)));
    } else if (widget.type === 'pomodoro') {
      const remaining = timerSeconds(widget), running = widget.timer.endsAt !== null && remaining > 0;
      const duration = (widget.timer.phase === 'focus' ? widget.focusMinutes : widget.breakMinutes) * 60;
      node.style.setProperty('--timer-progress', String(100 * (1 - remaining / duration)));
      node.closest('.widget-card').dataset.timerPhase = widget.timer.phase;
      node.closest('.widget-card').dataset.timerState = remaining === 0 ? 'complete' : running ? 'running' : remaining < duration ? 'paused' : 'ready';
      setText(node.querySelector('[data-timer-value]'), `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`);
      setText(node.querySelector('[data-timer-status]'), remaining === 0 ? (widget.timer.phase === 'focus' ? '本轮专注完成，休息一下吧' : '休息结束，准备好再开始') : running ? (widget.timer.phase === 'focus' ? '专注眼前这一件事' : '放松一下') : remaining < duration ? '已暂停，按开始继续' : '准备好就开始');
      setText(node.querySelector('[data-timer="toggle"]'), running ? '暂停' : remaining === 0 ? '再来一轮' : '开始');
      node.querySelectorAll('.timer-modes button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.timer === widget.timer.phase)));
    }
  }
  function hydrate() {
    root.querySelectorAll('[data-tool-widget]').forEach(node => {
      const widget = getState().widgets.find(item => item.id === node.dataset.toolWidget); if (!widget) return;
      if (widget.type === 'todo') updateTodo(node, widget);
      updateLive(node, widget);
    });
  }
  const getWidget = target => {
    const node = target.closest('[data-tool-widget]');
    return { node, widget: node && getState().widgets.find(item => item.id === node.dataset.toolWidget) };
  };
  const persist = async () => { hydrate(); await save(); };
  root.addEventListener('submit', async event => {
    const { node, widget } = getWidget(event.target); if (!widget) return;
    event.preventDefault(); if (node.disabled) return;
    if (widget.type === 'todo') {
      const input = node.querySelector('[data-todo-input]'), text = input.value.trim(); if (!text) return;
      if (widget.items.length >= 100) { report('每个待办组件最多保存 100 项，请先清理已完成事项。', true); return; }
      widget.items.push({ id: crypto.randomUUID(), text, done: false }); input.value = ''; await persist(); input.focus();
    } else if (widget.type === 'calculator') {
      const input = node.querySelector('[data-calculator-input]'); let result, error = false;
      try { result = calculate(input.value); } catch (failure) { result = failure.message; error = true; }
      calculators.set(widget.id, { expression: input.value, result, error });
      node.querySelector('.calculator-form').classList.toggle('has-error', error);
      input.setAttribute('aria-invalid', String(error));
      setText(node.querySelector('[data-calculator-result]'), result);
    }
  });
  root.addEventListener('input', event => {
    if (!event.target.matches('[data-calculator-input]')) return;
    const { widget } = getWidget(event.target); if (widget) {
      calculators.set(widget.id, { expression: event.target.value, result: calculators.get(widget.id)?.result || '0' });
      event.target.setAttribute('aria-invalid', 'false'); event.target.closest('form').classList.remove('has-error');
    }
  });
  root.addEventListener('change', async event => {
    if (!event.target.matches('[data-todo-check]')) return;
    const { node, widget } = getWidget(event.target); if (!widget || node.disabled) return;
    const item = widget.items.find(item => item.id === event.target.dataset.todoCheck); if (item) { item.done = event.target.checked; await persist(); }
  });
  root.addEventListener('click', async event => {
    const { node, widget } = getWidget(event.target); if (!widget || node.disabled) return;
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-calendar')) {
      const now = new Date(), current = months.get(widget.id) || { year: now.getFullYear(), month: now.getMonth() };
      if (button.dataset.calendar === 'today') months.delete(widget.id);
      else { const next = new Date(0); next.setFullYear(current.year, current.month + Number(button.dataset.calendar), 1); if (next.getFullYear() >= 1 && next.getFullYear() <= 9999) months.set(widget.id, { year: next.getFullYear(), month: next.getMonth() }); }
      updateCalendar(node, widget);
    } else if (button.hasAttribute('data-timer')) { widget.timer = timerAction(widget, button.dataset.timer); await persist(); }
    else if (button.hasAttribute('data-calculator-clear')) {
      node.querySelector('.calculator-form').classList.remove('has-error'); node.querySelector('[data-calculator-input]').setAttribute('aria-invalid', 'false');
      calculators.set(widget.id, { expression: '', result: '0' }); node.querySelector('[data-calculator-input]').value = ''; setText(node.querySelector('[data-calculator-result]'), '0'); node.querySelector('[data-calculator-input]').focus();
    } else if (button.hasAttribute('data-todo-delete') || button.hasAttribute('data-todo-clear')) {
      const removed = widget.items.filter(item => button.hasAttribute('data-todo-delete') ? item.id === button.dataset.todoDelete : item.done);
      widget.items = widget.items.filter(item => !removed.includes(item)); hydrate();
      if (await save()) {
        report(`已移除 ${removed.length} 项待办`); const undo = document.createElement('button'); undo.textContent = '撤销';
        undo.onclick = async () => { const current = getState().widgets.find(item => item.id === widget.id); if (current) { current.items.push(...removed.filter(item => !current.items.some(next => next.id === item.id))); await persist(); } document.querySelector('#status').hidden = true; };
        document.querySelector('#status').append(undo);
      }
    }
  });
  setInterval(() => { root.querySelectorAll('.sites-page:not([inert]) [data-tool-widget]').forEach(node => { const widget = getState().widgets.find(item => item.id === node.dataset.toolWidget); if (widget) updateLive(node, widget); }); }, 1000);
  function preview(node, widget) {
    if (widget.type === 'todo') updateTodo(node, widget);
    updateLive(node, widget);
  }
  return { content, hydrate, preview };
}
