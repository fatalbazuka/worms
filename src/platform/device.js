/**
 * Какой интерфейс показывать: для мыши с клавиатурой или для пальцев.
 *
 *   desktop — компактная панель, прицел мышью, сила — удержание ЛКМ или
 *             пробела, камера — правой кнопкой и колесом, горячие клавиши;
 *   touch   — крупные кнопки по краям экрана под большие пальцы.
 *
 * Порядок решения: ?ui=desktop|touch в адресе → выбор игрока в меню
 * (localStorage) → window.WORMS_UI из env.js → клиент Telegram (на ПК —
 * desktop) → само устройство: точный указатель с наведением и без
 * сенсорного экрана — desktop, всё остальное — touch. Ноутбук с сенсорным
 * экраном попадает в touch; переключиться можно в меню.
 */
import { tgApi, isDesktopClient } from './telegram.js';

const STORE_KEY = 'worms.ui';
const MODES = ['desktop', 'touch'];

let cached = null;

function stored() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

export function detectUiMode() {
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('ui');
  if (MODES.includes(fromUrl)) return fromUrl;
  const saved = stored();
  if (MODES.includes(saved)) return saved;
  if (MODES.includes(globalThis.WORMS_UI)) return globalThis.WORMS_UI;

  const tg = tgApi();
  if (tg) return isDesktopClient(tg) ? 'desktop' : 'touch';

  const mm = (q) => Boolean(globalThis.matchMedia?.(q).matches);
  const touchscreen = (globalThis.navigator?.maxTouchPoints ?? 0) > 0;
  return mm('(pointer: fine)') && mm('(hover: hover)') && !touchscreen ? 'desktop' : 'touch';
}

export function uiMode() {
  if (!cached) cached = detectUiMode();
  return cached;
}

export const isDesktop = () => uiMode() === 'desktop';

/** Выбор игрока: запоминается в браузере. */
export function setUiMode(mode) {
  if (!MODES.includes(mode)) return;
  cached = mode;
  try { localStorage.setItem(STORE_KEY, mode); } catch { /* инкогнито */ }
  globalThis.document?.body.classList.toggle('ui-desktop', mode === 'desktop');
}

export function applyUiClass() {
  globalThis.document?.body.classList.toggle('ui-desktop', isDesktop());
}
