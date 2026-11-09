import { tgApi, inTelegram } from '../platform/telegram.js';
import { adoptAccount, dropAccount, player } from '../platform/player.js';

/**
 * Свой сервер: аккаунты и рейтинг (server/index.mjs, база SQLite).
 *
 * Аккаунт — ник и пароль, без почты. В Telegram вход сам: сервер проверяет
 * подпись initData и заводит аккаунт tg<id> без всяких паролей. Токен входа
 * лежит в localStorage; на сервере только его хэш.
 *
 * Рейтинг на сервере главный. Бой засчитывается, когда оба игрока
 * сообщили согласный итог; локальный пересчёт на экране итога — только
 * предварительный показ, пока сервер не ответил.
 *
 * Адрес API — WORMS_API из env.js, по умолчанию /api на том же домене.
 * Нет сервера (статика без бэкенда, локальная разработка) — игра живёт
 * как раньше, на локальном профиле.
 */

const KEY = 'worms.account.v1';
const listeners = new Set();

export function apiBase() {
  return String(globalThis.WORMS_API ?? '/api').replace(/\/+$/, '');
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
    res = await fetch(`${apiBase()}${path}`, {
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

/** Регистрация: ник и пароль. Бросает ApiError с полем name/password. */
export async function register(name, password) {
  return signedIn(await call('POST', '/register', { name, password }));
}

export async function login(name, password) {
  return signedIn(await call('POST', '/login', { name, password }));
}

export async function logout() {
  try { await call('POST', '/logout'); } catch { /* выходим всё равно */ }
  signOutLocal();
}

export async function renameAccount(name) {
  const data = await call('POST', '/rename', { name });
  changed();
  return data.player;
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

let lastSync = 0;

/**
 * Подтянуть свой профиль: рейтинг, победы, место. Не чаще раза в десять
 * секунд; ошибки глотаются — без сервера игра живёт на локальном.
 */
export async function syncMe() {
  if (!token || Date.now() - lastSync < 10_000) return null;
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

/** Таблица лидеров: сыгравшие хотя бы один бой на рейтинг. */
export async function fetchTop(limit = 20) {
  const data = await call('GET', `/top?limit=${limit}`);
  return Array.isArray(data.players) ? data.players : [];
}

/** Моё место в таблице: null, если меня там нет. */
export function myRank(rows) {
  const i = rows.findIndex((r) => r.id === player().id);
  return i >= 0 ? i + 1 : null;
}
