import { normalizeState } from './state.js';

export const STATE_UPDATED = 'tabcatUpdatedAt';
export const stateTime = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

// Local edits advance the configuration's time. Downloads and icon hydration
// retain the source time instead of making an old configuration look new.
// Callers serialize these writes in the background worker's state queue.
export function createStateStorage({ storage, now = Date.now }) {
  const loadState = async () => normalizeState((await storage.get('tabcat')).tabcat);
  const saveState = (state, updated) => storage.set({ tabcat: state, ...(updated === undefined ? {} : { [STATE_UPDATED]: stateTime(updated) }) });
  async function saveLocalState(before, after) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const previous = stateTime((await storage.get(STATE_UPDATED))[STATE_UPDATED]);
    await saveState(after, Math.max(stateTime(now()), previous + 1));
  }
  return { loadState, saveState, saveLocalState };
}
