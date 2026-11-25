import { tgApi, inTelegram } from '../platform/telegram.js';
import { adoptAccount, dropAccount, player } from '../platform/player.js';

/**
 * Свой сервер: аккаунт, рейтинг, турниры, звёзды (server/index.mjs).
 *
 * Аккаунт — это Telegram: вход сам, сервер проверяет подпись initData и
 * заводит игрока tg<id>. Ника и пароля нет. Токен входа лежит в
 * localStorage; на сервере только его хэш.
 *
 * Рейтинг на сервере главный. Бой засчитывается, когда оба игрока
 * сообщили согласный итог; локальный пересчёт на экране итога — только
 * предварительный показ, пока сервер не ответил.
 *
 * Адрес API — WORMS_API из env.js, по умолчанию api/ рядом со страницей:
 * в корне домена это /api, а если игра живёт по адресу /worms/, то
 * /worms/api — так одна и та же сборка работает в любой папке сайта.
 * Нет сервера (статика без бэкенда, локальная разработка) — игра живёт
 * как раньше, на локальном профиле.
 */

const KEY = 'worms.account.v1';
const listeners = new Set();

export function apiBase() {
  return String(globalThis.WORMS_API ?? 'api').replace(/\/+$/, '');
}

/** Полный адрес запроса: относительный путь считается от страницы игры. */
function apiUrl(path) {
  return new URL(`${apiBase()}${path}`, globalThis.document?.baseURI ?? globalThis.location?.href).href;
}

function loadToken() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null')?.token ?? null; } catch { return null; }
}

let token = loadToken();

function saveToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify({ token: t }));
    else localStorage.removeItem(KEY);
  } catch { /* инкогнито: вход живёт до закрытия вкладки */ }
}

/** Вошёл ли игрок в аккаунт. */
export function loggedIn() { return Boolean(token); }

/** Сервер примет отчёт о бое — только от вошедшего. */
export function serverAvailable() { return loggedIn(); }

/** Подписка на вход и выход: меню перерисовывается. */
export function onAccountChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  for (const fn of listeners) {
    try { fn(player()); } catch (e) { console.warn('[account] listener', e); }
  }
}

/** Ошибка сервера с понятным текстом и полем, к которому она относится. */
export class ApiError extends Error {
  constructor(message, status, field = null) { super(message); this.status = status; this.field = field; }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('сервер недоступен', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data) {
    // Токен отозван или база пересоздана — выходим, чтобы не стучаться зря
    if (res.status === 401 && token && path !== '/login' && path !== '/register') signOutLocal();
    throw new ApiError(data?.error ?? `сервер ответил ${res.status}`, res.status, data?.field ?? null);
  }
  if (data.player) adoptAccount(data.player);
  return data;
}

function signedIn(data) {
  saveToken(data.token);
  adoptAccount(data.player);
  changed();
  return data.player;
}

function signOutLocal() {
  saveToken(null);
  dropAccount();
  changed();
}

/** Выйти на этом устройстве (на случай смены аккаунта Telegram). */
export function forgetLogin() {
  signOutLocal();
}

/**
 * Вход из Telegram: подпись initData вместо пароля. Тихо ничего не делает,
 * если игра не в Telegram, вход уже есть или на сервере нет токена бота.
 */
export async function telegramLogin() {
  const initData = tgApi()?.initData;
  if (!inTelegram() || !initData) return null;
  if (token && player().id.startsWith('tg')) return player();
  try {
    return signedIn(await call('POST', '/telegram', { initData }));
  } catch (e) {
    if (e.status !== 503) console.warn('[account] вход через Telegram не удался:', e.message);
    return null;
  }
}

/** Вход с сайта по логину и паролю, которые выдал админ (/web в боте). */
export async function passwordLogin(login, password) {
  return signedIn(await call('POST', '/login', { login, password }));
}

/** Прогресс игры на сервере: { ключ: строка JSON }. null — не вышло. */
export async function fetchSave() {
  if (!token) return null;
  try { return (await call('GET', '/save')).items ?? {}; } catch { return null; }
}

// Запись прогресса — не чаще раза в полторы секунды на ключ: кошелёк и
// задания сохраняются после каждого боя, серверу хватит последнего
const pendingSave = new Map();
export function putSave(key, value) {
  if (!token) return;
  const was = pendingSave.get(key);
  if (was) { was.value = value; return; }
  const entry = { value };
  pendingSave.set(key, entry);
  setTimeout(() => {
    pendingSave.delete(key);
    call('PUT', '/save', { key, value: entry.value }).catch(() => {});
  }, 1500);
}

/**
 * Событие для статистики (open | battle). Только для вошедших в аккаунт и
 * без ожидания: игра от него не зависит, ошибки глотаются.
 */
export function track(name, props = {}) {
  if (!token) return;
  call('POST', '/event', { name, props }).catch(() => {});
}

/**
 * Шаг воронки (server/analytics.mjs, STEPS). once — только первый раз на
 * этом устройстве: «первый выстрел» второй раз не первый.
 */
export function trackStep(step, { once = false } = {}) {
  if (once) {
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem('worms.steps.v1') ?? '{}') || {}; } catch { seen = {}; }
    if (seen[step]) return;
    seen[step] = 1;
    try { localStorage.setItem('worms.steps.v1', JSON.stringify(seen)); } catch { /* инкогнито */ }
  }
  track('step', { step });
}

/** Магазин: товары, цены и что положено игроку (куплено и подарено). */
export async function fetchShop() {
  if (!token) return null;
  try { return await call('GET', '/shop'); } catch { return null; }
}

/** Счёт на покупку: box1 | box5 | skin-<id>. @returns {Promise<string>} ссылка на счёт */
/** «Башня дня»: таблица и моё место. null — сервера нет. */
export async function fetchDailyTower() {
  if (!token) return null;
  try { return await call('GET', '/daily-tower'); } catch { return null; }
}

/** Итог попытки «Башни дня». */
export async function submitDailyTower(run) {
  if (!token) return null;
  try { return await call('POST', '/daily-tower', run); } catch { return null; }
}

/**
 * Выложить картинку или клип на сервер — Telegram берёт сторис и «скачать»
 * только по ссылке. @returns {Promise<{url: string, ext: string}|null>}
 */
export async function uploadMedia(blob) {
  if (!token || !blob) return null;
  try {
    const res = await fetch(apiUrl('/media'), {
      method: 'POST',
      headers: { 'content-type': blob.type.split(';')[0], authorization: `Bearer ${token}` },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok || !data?.path) return null;
    return { url: new URL(data.path, apiUrl('/')).href, ext: data.ext };
  } catch {
    return null;
  }
}

/**
 * Активировать промокод. @returns {Promise<{boxes, coins, skin, owned}>}
 * Ошибку сервера («нет такого», «уже активирован») — исключением с текстом.
 */
export async function redeemPromo(code) {
  if (!token) throw new ApiError('промокоды работают после входа — открой игру через Telegram', 401);
  return call('POST', '/promo', { code });
}

/** Карточка «вызов на бой» для комнаты башни. @returns {Promise<string|null>} id сообщения */
export async function prepareChallenge(room, link) {
  if (!token) return null;
  try { return (await call('POST', '/challenge', { room, link })).id ?? null; } catch { return null; }
}

/** То же для дуэли-вызова по переписке: карточка с кнопкой на startapp=duel_КОД. */
export async function prepareDuelChallenge(code, link) {
  if (!token) return null;
  try { return (await call('POST', '/challenge', { duel: code, link })).id ?? null; } catch { return null; }
}

export async function buyShopItem(item) {
  const r = await call('POST', '/shop/buy', { item });
  return r.invoice;
}

let lastSync = 0;

/**
 * Подтянуть свой профиль: рейтинг, победы, место. Не чаще раза в десять
 * секунд; ошибки глотаются — без сервера игра живёт на локальном.
 */
export async function syncMe(force = false) {
  if (!token || (!force && Date.now() - lastSync < 10_000)) return null;
  lastSync = Date.now();
  try {
    const data = await call('GET', '/me');
    return data.player ?? null;
  } catch (e) {
    if (e.status !== 401) console.warn('[server] профиль не синхронизирован', e.message);
    lastSync = 0;
    return null;
  }
}

/**
 * Сообщить итог сетевого боя.
 * @returns {Promise<{status:string, delta?:number}|null>}
 *   status: pending — ждём отчёт соперника; confirmed — засчитано;
 *   disputed — стороны разошлись; unrated — у соперника нет аккаунта.
 */
export async function reportResult({ room, seed, opponent, won }) {
  if (!token || !opponent) return null;
  try {
    return await call('POST', '/result', { room, seed, opponent, won });
  } catch (e) {
    console.warn('[server] итог не принят', e.message);
    return { status: 'error', error: e.message };
  }
}

/** Таблица лидеров: по рейтингу или по победам в турнирах. */
export async function fetchTop(limit = 20, kind = 'rating') {
  const data = await call('GET', `/top?limit=${limit}&kind=${kind}`);
  return Array.isArray(data.players) ? data.players : [];
}

/**
 * Топ друзей: кого позвал, кто позвал тебя, с кем доиграл бой на рейтинг —
 * и ты сам с местом среди них. Без входа друзей нет.
 * @returns {Promise<{friends: object[], place: number|null, total: number}>}
 */
export async function fetchFriends() {
  if (!token) return { friends: [], place: null, total: 0 };
  const data = await call('GET', '/friends');
  return {
    friends: Array.isArray(data.friends) ? data.friends : [], place: data.place ?? null, total: data.total ?? 0,
    known: Array.isArray(data.known) ? data.known : [],
  };
}

/**
 * Вызвать друга через бота: ему придёт сообщение с кнопкой в комнату.
 * false — не вышло (лимит, друг отписался, нет сети): зовём карточкой.
 */
/**
 * Сидим в комнате вызова одни: попросить бота написать позвавшему.
 * {sent, owner, reason} или null без входа / без сервера.
 */
export async function knockRoom(room) {
  if (!token) return null;
  try { return await call('POST', '/room/knock', { room }); } catch { return null; }
}

export async function inviteFriend(id, room) {
  if (!token) return false;
  try { return (await call('POST', '/friends/challenge', { id, room })).sent === true; } catch { return false; }
}

// ------------------------------------------------- дуэли по переписке

/** Мои дуэли: {items, myTurn, max}. null — без входа или сервер молчит. */
export async function fetchDuels() {
  if (!token) return null;
  try { return await call('GET', '/duels'); } catch { return null; }
}

/** Дуэль целиком, с историей ходов. */
export async function fetchDuel(id) {
  return (await call('GET', `/duels/${Number(id)}`)).duel;
}

/** Новая дуэль: {opponent: id} — с другом, {link: true} — ссылкой с кодом. */
export async function createDuel(body) {
  const r = await call('POST', '/duels', body);
  return r.existing ? { ...r.duel, existing: true } : r.duel;
}

/** Принять дуэль по коду из ссылки. */
export async function joinDuel(code) {
  return (await call('POST', '/duels/join', { code })).duel;
}

/** Свой ход: приказы и снимок итога. Повтор того же хода сервер примет как есть. */
export async function sendDuelTurn(id, payload) {
  return call('POST', `/duels/${Number(id)}/turn`, payload);
}

export async function resignDuel(id) {
  return (await call('POST', `/duels/${Number(id)}/resign`, {})).duel;
}

/** История боёв для кабинета: дуэли на рейтинг и матчи турниров. */
export async function fetchHistory() {
  const data = await call('GET', '/me/history');
  return Array.isArray(data.items) ? data.items : [];
}

// ---------------------------------------------------------------- турниры

export async function fetchTournaments() {
  return call('GET', '/tournaments');
}

export async function fetchTournament(id) {
  return (await call('GET', `/tournaments/${Number(id)}`)).tournament;
}

/** Записаться. Платный турнир вернёт {invoice} — его открывает Telegram. */
export async function joinTournament(id) {
  return call('POST', `/tournaments/${Number(id)}/join`, {});
}

export async function leaveTournament(id) {
  return call('POST', `/tournaments/${Number(id)}/leave`, {});
}

export async function startTournament(id) {
  return call('POST', `/tournaments/${Number(id)}/start`, {});
}

/** Счёт на поддержку игры звёздами: 10, 50 или 100. */
export async function donateInvoice(amount) {
  return (await call('POST', '/stars/donate', { amount })).invoice;
}

/** Моё место в таблице: null, если меня там нет. */
export function myRank(rows) {
  const i = rows.findIndex((r) => r.id === player().id);
  return i >= 0 ? i + 1 : null;
}
