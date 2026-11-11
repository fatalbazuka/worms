/**
 * Интеграция с Telegram Mini App. В обычном браузере всё здесь — no-op.
 *
 * Что живёт в этом файле:
 *   • запуск: ready/expand, полный экран, блокировка свайпов;
 *   • безопасная область: под кнопками Telegram и под «чёлкой» игру
 *     не рисуем, игровое поле сжимается на эти отступы;
 *   • ссылка-приглашение вида t.me/бот?startapp=КОД и «позвать друга»
 *     родным выбором чата;
 *   • «На экран Домой»: Telegram сам ставит иконку, которая открывает
 *     игру внутри клиента сразу в полный экран;
 *   • CloudStorage — хранилище, привязанное к аккаунту, а не к устройству.
 */

/**
 * Имя бота из BotFather (без @). Из него собирается ссылка-приглашение.
 * Пусто — ссылка ведёт на сайт, как вне Telegram. Можно навязать из
 * index.html через window.WORMS_TG = { bot: 'имя', app: 'короткое_имя' }:
 * app нужен, только если Mini App заведён через /newapp, а не как главный.
 */
export const TELEGRAM = {
  bot: 'Cybercouch77bot',
  app: '',
};

export function telegramConfig() {
  return { ...TELEGRAM, ...(globalThis.WORMS_TG ?? {}) };
}

/**
 * Объект WebApp — только если игра действительно открыта в Telegram.
 *
 * SDK, загруженный в обычном браузере, тоже создаёт WebApp: версия 6.0,
 * платформа unknown, и каждый вызов новых методов сыплет в консоль ошибки
 * (а requestFullscreen и вовсе бросает исключение). Такой объект для игры
 * всё равно что его нет.
 */
export function tgApi() {
  const tg = globalThis.Telegram?.WebApp;
  if (!tg) return null;
  if (!tg.initData && (!tg.platform || tg.platform === 'unknown')) return null;
  return tg;
}

export function inTelegram() {
  return Boolean(tgApi()?.initData || tgApi()?.initDataUnsafe?.user);
}

/** Версия клиента не младше нужной. Старые клиенты просто без этих функций. */
export function tgSupports(version) {
  const tg = tgApi();
  if (!tg) return false;
  if (typeof tg.isVersionAtLeast === 'function') {
    try { return tg.isVersionAtLeast(version); } catch { /* ниже */ }
  }
  const [a, b] = String(tg.version ?? '0').split('.').map(Number);
  const [x, y] = version.split('.').map(Number);
  return a > x || (a === x && (b ?? 0) >= (y ?? 0));
}

/**
 * Метод есть у клиента и клиент достаточно новый, чтобы его вызвать.
 * Одного наличия мало: SDK объявляет все методы сразу, а на старом
 * клиенте вызов пишет ошибку в консоль или бросает исключение.
 */
function can(tg, method, version) {
  return typeof tg?.[method] === 'function' && tgSupports(version);
}

/**
 * Клиент Telegram на компьютере: Desktop, macOS, веб-версия. Там игра
 * получает интерфейс для мыши и клавиатуры, как в обычном браузере.
 */
export function isDesktopClient(tg = tgApi()) {
  return ['tdesktop', 'macos', 'web', 'weba', 'webk', 'unigram'].includes(tg?.platform);
}

// ----------------------------------------------------------------- запуск

let started = false;

/** Вызывается один раз до старта игры. */
export function initTelegram() {
  const tg = tgApi();
  if (!tg || started) return tg;
  started = true;

  try {
    tg.ready();
    tg.expand();
    if (can(tg, 'disableVerticalSwipes', '7.7')) tg.disableVerticalSwipes();
    if (can(tg, 'setHeaderColor', '6.1')) tg.setHeaderColor('#0b1021');
    if (can(tg, 'setBackgroundColor', '6.1')) tg.setBackgroundColor('#0b1021');
    if (can(tg, 'setBottomBarColor', '7.10')) tg.setBottomBarColor('#0b1021');
    // Полный экран появился в Bot API 8.0; в компактном режиме ландшафтной
    // игре тесно, поэтому просим его всегда, а не только с иконки. На ПК
    // (Telegram Desktop, macOS, web) полный экран не нужен: там окно и так
    // большое, а «развернуть на весь монитор» игрок сделает сам.
    if (can(tg, 'requestFullscreen', '8.0') && !isDesktopClient(tg)) tg.requestFullscreen();
  } catch (e) {
    console.warn('[telegram] init failed', e);
  }

  // Ориентацию фиксируем только когда телефон уже повёрнут: lockOrientation
  // держит ТЕКУЩУЮ ориентацию, а запускают игру обычно в портрете — и
  // тогда поворот не сработал бы вовсе, подсказка «поверни» висела бы вечно.
  syncOrientationLock();
  globalThis.addEventListener?.('resize', syncOrientationLock);
  globalThis.addEventListener?.('orientationchange', syncOrientationLock);

  // Отступы приходят не сразу и меняются при входе в полный экран
  for (const ev of ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged']) {
    try { tg.onEvent?.(ev, applySafeArea); } catch { /* старый клиент */ }
  }
  try { tg.onEvent?.('homeScreenAdded', () => setHomeState('added')); } catch { /* — */ }
  applySafeArea();
  refreshHomeState();
  return tg;
}

let locked = null;
let inBattle = false;

/** Игровая сцена сообщает, идёт ли бой: меню крутится свободно, бой держится. */
export function setBattle(on) {
  inBattle = Boolean(on);
  syncOrientationLock();
}

/**
 * Держать ориентацию только в бою и только когда телефон уже повёрнут;
 * всё остальное время — отпустить. Меню и лобби работают в любой
 * ориентации, а lockOrientation держит ТЕКУЩУЮ: позови его в портрете —
 * и повернуть будет нельзя. Работает только в полноэкранном режиме
 * (Bot API 8.0), в компактном методов нет.
 */
export function syncOrientationLock() {
  const tg = tgApi();
  if (!can(tg, 'lockOrientation', '8.0') || !can(tg, 'unlockOrientation', '8.0')) return;
  const landscape = globalThis.innerWidth > globalThis.innerHeight;
  const want = inBattle && landscape;
  if (want === locked) return;
  locked = want;
  try {
    if (want) tg.lockOrientation();
    else tg.unlockOrientation();
  } catch (e) {
    console.warn('[telegram] orientation', e);
  }
}

// ------------------------------------------------------ безопасная область

/**
 * Отступы, под которыми игру рисовать нельзя, в CSS-пикселях.
 *
 * Их два вида, и нужны оба: safeAreaInset — «чёлка» и скруглённые углы
 * устройства, contentSafeAreaInset — кнопки самого Telegram («закрыть»,
 * «ещё»), которые в полноэкранном режиме висят поверх игры.
 */
export function safeArea() {
  const tg = tgApi();
  const a = tg?.safeAreaInset ?? {};
  const b = tg?.contentSafeAreaInset ?? {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  return {
    top: n(a.top) + n(b.top),
    bottom: n(a.bottom) + n(b.bottom),
    left: n(a.left) + n(b.left),
    right: n(a.right) + n(b.right),
    // Кнопки Telegram («Close», «…») сидят только в верхних углах, середина
    // верхней полосы свободна. Ширину углов клиент не сообщает; на iPhone
    // в ландшафте кнопка кончается примерно в 110 CSS-пикселях от края
    // безопасной области — берём с запасом. Панель боя благодаря этому
    // стоит у самого верха, а от кнопок отступают только её края.
    corner: n(b.top) > 0 ? 130 : 0,
  };
}

/**
 * Отступы безопасной области, где бы игра ни была открыта: в Telegram —
 * от клиента, снаружи — из CSS env(safe-area-inset-*) через щуп в
 * index.html (у JS к env() прямого доступа нет).
 */
export function screenInsets() {
  if (tgApi()) return safeArea();
  const probe = globalThis.document?.getElementById('safe-probe');
  if (!probe) return { top: 0, bottom: 0, left: 0, right: 0 };
  const cs = getComputedStyle(probe);
  const n = (v) => Math.max(0, Math.round(parseFloat(v) || 0));
  return {
    top: n(cs.paddingTop), bottom: n(cs.paddingBottom),
    left: n(cs.paddingLeft), right: n(cs.paddingRight),
    corner: 0,
  };
}

let lastInset = '';

/**
 * Telegram прислал отступы. Сами они применяются в main.js через рамку
 * CFG.FRAME: канвас остаётся на весь экран, внутрь сдвигается только
 * интерфейс. Здесь — лишь сигнал, что рамку пора пересчитать.
 */
export function applySafeArea() {
  if (!tgApi()) return;
  const s = safeArea();
  const inset = `${s.top} ${s.right} ${s.bottom} ${s.left}`;
  if (inset === lastInset) return;
  lastInset = inset;
  globalThis.dispatchEvent(new Event('worms-safearea'));
}

// ------------------------------------------------------------- приглашение

/**
 * Комната из ссылки-приглашения.
 *
 * В Telegram ссылка выглядит как t.me/бот?startapp=КОД, и код приезжает в
 * start_param — адресной строки, куда можно дописать ?room=, внутри
 * клиента просто нет. Снаружи работает обычный ?room=.
 */
export function startRoom() {
  const p = tgApi()?.initDataUnsafe?.start_param;
  if (p && /^[A-Z0-9]{4,10}$/i.test(p)) return p.toUpperCase();
  return new URLSearchParams(location.search).get('room');
}

/**
 * Ссылка-приглашение в комнату.
 *
 * В Telegram, если бот назван, — глубокая ссылка t.me: друг откроет игру
 * внутри клиента под своим аккаунтом. Ссылка на сайт открыла бы Safari,
 * где он был бы анонимом с другим рейтингом. Вне Telegram — адрес сайта
 * с ?room=, как и раньше.
 */
export function inviteLink(room) {
  const { bot, app } = telegramConfig();
  if (bot && inTelegram()) {
    const base = app ? `https://t.me/${bot}/${app}` : `https://t.me/${bot}`;
    return `${base}?startapp=${encodeURIComponent(room)}`;
  }
  const url = new URL(location.href);
  url.searchParams.set('room', room);
  return url.toString();
}

/**
 * Позвать друга в бой.
 *
 * В Telegram — родным выбором чата: жмёшь, выбираешь, туда улетает ссылка.
 * Это две-три секунды против «скопируй и куда-то вставь». Инлайн-режим
 * (switchInlineQuery) сюда не годится: на инлайн-запрос должен ответить
 * сервер бота, а его нет. Снаружи Telegram возвращаем false, и вызывающий
 * копирует ссылку сам.
 */
export function shareRoom(room, link = inviteLink(room)) {
  const tg = tgApi();
  if (!tg?.openTelegramLink) return false;
  const text = `Го в Worms! Комната ${room}`;
  try {
    const url = `https://t.me/share/url?url=${encodeURIComponent(link)}`
      + `&text=${encodeURIComponent(text)}`;
    tg.openTelegramLink(url);
    return true;
  } catch (e) {
    console.warn('[telegram] поделиться не вышло', e);
    return false;
  }
}

// --------------------------------------------------------- на экран Домой

/**
 * Состояние иконки на домашнем экране:
 *   unsupported — клиент без Bot API 8.0 или платформа не умеет;
 *   unknown     — платформа не может сказать (тогда предлагать можно);
 *   added       — уже стоит;
 *   missed      — не стоит, можно предложить.
 */
let homeState = 'unsupported';
const homeListeners = new Set();

export function homeScreenState() { return homeState; }

export function onHomeScreenChange(fn) {
  homeListeners.add(fn);
  return () => homeListeners.delete(fn);
}

function setHomeState(state) {
  if (state === homeState) return;
  homeState = state;
  for (const fn of homeListeners) {
    try { fn(state); } catch (e) { console.warn('[telegram] home listener', e); }
  }
}

function refreshHomeState() {
  const tg = tgApi();
  if (!can(tg, 'checkHomeScreenStatus', '8.0') || !can(tg, 'addToHomeScreen', '8.0')) {
    return setHomeState('unsupported');
  }
  try {
    tg.checkHomeScreenStatus((status) => setHomeState(status || 'unknown'));
  } catch {
    setHomeState('unsupported');
  }
}

/** Можно ли сейчас предложить иконку. */
export function canOfferHomeScreen() {
  return inTelegram() && (homeState === 'missed' || homeState === 'unknown');
}

/** Показать родное предложение Telegram поставить иконку. */
export function addToHomeScreen() {
  const tg = tgApi();
  if (!canOfferHomeScreen()) return false;
  try {
    tg.addToHomeScreen();
    return true;
  } catch (e) {
    console.warn('[telegram] addToHomeScreen', e);
    return false;
  }
}

const OFFERED_KEY = 'worms.home.offered';

/**
 * Предложить иконку один раз — после первой доигранной партии. Отметка
 * «уже предлагали» лежит в CloudStorage: иначе после переустановки
 * клиента предложение всплывало бы снова.
 */
export async function offerHomeScreenOnce() {
  if (!canOfferHomeScreen()) return false;
  if (await cloudGet(OFFERED_KEY)) return false;
  await cloudSet(OFFERED_KEY, '1');
  return addToHomeScreen();
}

// ---------------------------------------------------------- CloudStorage

/**
 * Хранилище Telegram, привязанное к аккаунту: рейтинг едет за человеком
 * на другой телефон и в веб-клиент. Вне Telegram — localStorage под тем
 * же ключом, чтобы вызывающему было всё равно, где он.
 */
function cloud() {
  const tg = tgApi();
  return tg && tgSupports('6.9') ? tg.CloudStorage : null;
}

export function cloudGet(key) {
  const cs = cloud();
  if (!cs?.getItem) {
    try { return Promise.resolve(localStorage.getItem(key)); } catch { return Promise.resolve(null); }
  }
  return new Promise((resolve) => {
    // Хранилище может не ответить (нет сети, старый клиент): игра не
    // должна ждать его вечно
    const timer = setTimeout(() => resolve(null), 1500);
    try {
      cs.getItem(key, (err, value) => {
        clearTimeout(timer);
        resolve(err ? null : (value || null));
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export function cloudSet(key, value) {
  const cs = cloud();
  if (!cs?.setItem) {
    try { localStorage.setItem(key, value); } catch { /* инкогнито */ }
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    try {
      cs.setItem(key, String(value), (err, ok) => {
        clearTimeout(timer);
        resolve(!err && ok !== false);
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/**
 * Вибрация — родная, через Telegram. Виды:
 *   tap    — лёгкий щелчок нажатия кнопки
 *   select — смена выбора (оружие, вкладка)
 *   shot   — выстрел
 *   hit    — попадание рядом / по сопернику
 *   hurt   — ранили своего: сильный толчок
 *   turn   — начался твой ход
 *   win, lose, warn — итоги и предупреждения
 * Вне Telegram и на старых клиентах — тишина, ошибок нет.
 */
export function haptic(kind = 'tap') {
  const tg = tgApi();
  const h = tg && tgSupports('6.1') ? tg.HapticFeedback : null;
  if (!h) return;
  try {
    switch (kind) {
      case 'select': h.selectionChanged(); break;
      case 'shot': h.impactOccurred('medium'); break;
      case 'hit': h.impactOccurred('rigid'); break;
      case 'hurt': h.impactOccurred('heavy'); break;
      case 'turn': h.notificationOccurred('warning'); break;
      case 'win': h.notificationOccurred('success'); break;
      case 'lose': h.notificationOccurred('error'); break;
      case 'warn': h.notificationOccurred('warning'); break;
      default: h.impactOccurred('light');
    }
  } catch { /* старый клиент — просто без отдачи */ }
}

/**
 * Окно оплаты Telegram для счёта звёздами. Возвращает итог:
 * paid | cancelled | failed | pending | unsupported.
 */
export function openInvoice(link) {
  const tg = tgApi();
  if (!tg?.openInvoice || !tgSupports('6.1')) return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    try { tg.openInvoice(link, (status) => resolve(status || 'failed')); } catch { resolve('failed'); }
  });
}

/**
 * Разрешить боту писать в личку — нужно для сообщений о турнире, если
 * игрок открыл игру по ссылке, ни разу не написав боту. Telegram сам
 * спросит; повторно не спрашивает, если уже разрешено.
 */
export function requestWriteAccess() {
  const tg = tgApi();
  if (!tg?.requestWriteAccess || !tgSupports('6.9')) return Promise.resolve(false);
  return new Promise((resolve) => {
    try { tg.requestWriteAccess((ok) => resolve(Boolean(ok))); } catch { resolve(false); }
  });
}

/** Ссылка на Telegram-профиль бота: t.me/<бот>. */
export function botLink(startParam = '') {
  const { bot } = telegramConfig();
  if (!bot) return null;
  return `https://t.me/${bot}${startParam ? `?startapp=${encodeURIComponent(startParam)}` : ''}`;
}
