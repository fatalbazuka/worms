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
import { tgApi } from './telegram.js';

const STORE_KEY = 'worms.ui';
const MODES = ['desktop', 'touch'];

let cached = null;

function stored() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

export function detectUiMode() {
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('ui');
  if (MODES.includes(fromUrl)) return fromUrl;
  // Игра живёт в Telegram и управляется пальцами — и в Telegram Desktop тоже:
  // одна раскладка на всех, кнопки там нажимаются мышью
  if (tgApi()) return 'touch';
  const saved = stored();
  if (MODES.includes(saved)) return saved;
  if (MODES.includes(globalThis.WORMS_UI)) return globalThis.WORMS_UI;


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

/**
 * Как целиться пальцем на башне — три схемы на выбор:
 *   sling    — рычаг-рогатка у большого пальца (по умолчанию);
 *   buttons  — классика жанра: ▲▼ крутят угол, «Огонь» держишь — копится
 *              сила, отпустил — выстрел; плюс свайп по бойцу к цели;
 *   anywhere — рогатка с любого места: потянул пальцем где угодно на поле
 *              от цели и отпустил; рычаг тоже остаётся.
 * ?aim=sling|buttons|anywhere в адресе — для отладки и тестов. Трос во
 * всех схемах — тап по стене.
 */
const AIM_KEY = 'worms.aim';
export const AIM_SCHEMES = ['sling', 'buttons', 'anywhere'];

export function aimScheme() {
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? '').get('aim');
  if (AIM_SCHEMES.includes(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem(AIM_KEY);
    if (AIM_SCHEMES.includes(saved)) return saved;
  } catch { /* инкогнито */ }
  return 'sling';
}

export function setAimScheme(scheme) {
  if (!AIM_SCHEMES.includes(scheme)) return;
  try { localStorage.setItem(AIM_KEY, scheme); } catch { /* инкогнито */ }
}
