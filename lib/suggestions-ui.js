import { browser } from 'wxt/browser';
import { searchProvider } from './search.js';

export function bindSuggestions({ input, list, getState, submit }) {
  let revision = 0, timer, composing = false, selected = -1, values = [], original = '';
  const close = () => {
    revision++; clearTimeout(timer); values = []; selected = -1;
    list.replaceChildren(); list.hidden = true;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  };
  const highlight = index => {
    selected = index;
    [...list.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    if (index < 0) { input.removeAttribute('aria-activedescendant'); input.value = original; }
    else { input.setAttribute('aria-activedescendant', `suggestion-${index}`); input.value = values[index]; }
  };
  const update = () => {
    close();
    const state = getState(); const query = input.value.trim(); original = input.value;
    const engine = state.engines.find(engine => engine.id === state.currentEngine);
    const provider = searchProvider(engine || {});
    if (composing || !state.searchSuggestions || !provider || !query || query.length > 200 || /^https?:\/\//i.test(query)) return;
    const version = revision;
    timer = setTimeout(async () => {
      try {
        const response = await browser.runtime.sendMessage({ type: 'tabcat:suggest', provider, query });
        if (version !== revision || document.activeElement !== input || composing) return;
        values = response?.ok ? response.suggestions || [] : [];
        if (!values.length) return;
        list.replaceChildren(...values.map((value, index) => {
          const option = document.createElement('li'); option.id = `suggestion-${index}`;
          option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.dataset.index = index;
          const text = document.createElement('span'); text.textContent = value; option.append(text);
          return option;
        }));
        list.hidden = false; input.setAttribute('aria-expanded', 'true');
      } catch { if (version === revision) close(); }
    }, 240);
  };
  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; update(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); input.value = original; close(); return; }
    if (list.hidden) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const next = (selected + (event.key === 'ArrowDown' ? 1 : -1) + values.length + 1) % (values.length + 1);
      highlight(next === values.length ? -1 : next);
    } else if (event.key === 'Enter') { close(); }
  });
  list.addEventListener('pointerdown', event => {
    const item = event.target.closest('[data-index]'); if (!item) return;
    event.preventDefault(); input.value = values[Number(item.dataset.index)]; close(); submit();
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#searchForm')) close(); });
  input.addEventListener('blur', close);
  return { close, update };
}
