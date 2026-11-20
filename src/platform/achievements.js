/**
 * Достижения игрока: на устройстве и копией в облаке (Telegram и сервер игры).
 * Таблица и правила — core/achievements.js; монеты — platform/daily.js,
 * коробки — platform/skins.js. Награда выдаётся сразу, как достижение
 * открыто, и один раз: открытое помнится навсегда.
 *
 * Кто хочет показать открытое (плашка в бою, в меню) — подписывается
 * onAchievement; бой ещё и сам забирает список открытого для экрана итога.
 */
import {
  ACHIEVEMENTS, ACH_BY_ID, normalizeAch, mergeAch, addStats, progressOf, progressStats,
} from '../core/achievements.js';
import { cloudReady, cloudLoad, cloudSave } from './cloud.js';
import { grantCoins, dailyState } from './daily.js';
import { grantBoxes, skinState } from './skins.js';
import { cosState } from './cosmetics.js';
import { levelState } from './levels.js';
import { ascentDone } from './ascent.js';
import { challengeStars } from './challenges.js';
import { trackStep } from '../net/server.js';

const STORE_KEY = 'worms.ach.v1';
const listeners = new Set();

function load() {
  try { return normalizeAch(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')); } catch { return normalizeAch(null); }
}

function save(st) {
  const raw = JSON.stringify(st);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  cloudSave(STORE_KEY, raw);
  return st;
}

/** Подтянуть облачную копию и свести с местной: открытое — объединение. */
export async function syncAchCloud() {
  if (!cloudReady()) return;
  let st = load();
  for (const raw of await cloudLoad(STORE_KEY)) {
    try { st = mergeAch(st, JSON.parse(raw)); } catch { /* битая копия — мимо */ }
  }
  save(st);
}

/** Подписка на открытые достижения: fn(список описаний). @returns отписка */
export function onAchievement(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Витрина: все достижения с прогрессом, по порядку таблицы.
 * @returns {{list: Array<object>, got: number, total: number}}
 */
export function achState() {
  const st = load();
  const list = ACHIEVEMENTS.map((a) => ({ ...a, ...progressOf(st, a) }));
  return { list, got: list.filter((a) => a.done).length, total: list.length };
}

/**
 * Сдвинуть счётчики (add — прибавить, best — снятое с прогресса) и выдать
 * награды за открытое.
 * @returns {object[]} открытые сейчас — описания из таблицы
 */
export function bumpAch(add = {}, best = {}) {
  const st = load();
  const res = addStats(st, add, best);
  if (JSON.stringify(res.state) !== JSON.stringify(st)) save(res.state);
  if (!res.unlocked.length) return [];
  const got = res.unlocked.map((id) => ACH_BY_ID[id]);
  const coins = got.reduce((a, x) => a + (x.coins ?? 0), 0);
  const boxes = got.reduce((a, x) => a + (x.boxes ?? 0), 0);
  if (coins) grantCoins(coins);
  if (boxes) grantBoxes(boxes);
  // Воронка: открыл ли новичок первое достижение и дошёл ли до десятка
  trackStep('ach_first', { once: true });
  if (Object.keys(res.state.got).length >= 10) trackStep('ach_10', { once: true });
  for (const fn of listeners) fn(got);
  return got;
}

/** Снять «лучшие» счётчики с прогресса игры: уровень, серия, скины, главы, звёзды. */
function progressNow() {
  return progressStats({
    level: levelState().level,
    streak: dailyState().streak,
    skins: skinState().owned,
    cos: cosState().owned,
    ascent: ascentDone(),
    stars: challengeStars(),
  });
}

/**
 * Проверить вехи и коллекцию по прогрессу игры (меню, конец боя), заодно
 * с тем, что принёс бой (add). @returns {object[]} открытые сейчас
 */
export function checkAchievements(add = {}) {
  return bumpAch(add, progressNow());
}

/** Активирован промокод. */
export function notePromo() { return bumpAch({ promo: 1 }); }

/** Сервер сказал, скольких друзей игрок привёл по своей ссылке. */
export function noteInvited(n) { return bumpAch({}, { invited: n }); }
