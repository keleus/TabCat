// Individual Iconify imports keep the UI icons bundled and available offline.
import plus from '@iconify-icons/lucide/plus';
import settings from '@iconify-icons/lucide/settings-2';
import wallpaper from '@iconify-icons/lucide/image';
import shuffle from '@iconify-icons/lucide/shuffle';
import arrow from '@iconify-icons/lucide/chevron-right';
import chevronDown from '@iconify-icons/lucide/chevron-down';
import edit from '@iconify-icons/lucide/pencil';
import trash from '@iconify-icons/lucide/trash-2';
import search from '@iconify-icons/lucide/search';
import close from '@iconify-icons/lucide/x';
import appearance from '@iconify-icons/lucide/shapes';
import layout from '@iconify-icons/lucide/layout-grid';
import clock from '@iconify-icons/lucide/clock-3';
import backup from '@iconify-icons/lucide/arrow-down-up';
import external from '@iconify-icons/lucide/external-link';
import grip from '@iconify-icons/lucide/grip-vertical';
import up from '@iconify-icons/lucide/arrow-up';
import down from '@iconify-icons/lucide/arrow-down';
import check from '@iconify-icons/lucide/check';
import bookmark from '@iconify-icons/lucide/bookmark';
import history from '@iconify-icons/lucide/history';
import puzzle from '@iconify-icons/lucide/puzzle';
import folder from '@iconify-icons/lucide/folder';
import expand from '@iconify-icons/lucide/maximize-2';

const icons = { plus, settings, wallpaper, shuffle, arrow, chevronDown, edit, trash, search, close, appearance, layout, clock, backup, external, grip, up, down, check, bookmark, history, puzzle, folder, expand };
export const UI_ICONS = Object.fromEntries(Object.entries(icons).map(([name, icon]) => [
  name, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.width || 24} ${icon.height || 24}" aria-hidden="true" focusable="false">${icon.body}</svg>`,
]));
