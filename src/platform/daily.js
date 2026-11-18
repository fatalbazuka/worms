/**
 * Кошелёк, задания и серия дней игрока: где лежат и как меняются.
 *
 * Правила — в core/daily.js, здесь только хранилище и связка со скинами
 * (коробку за серию и купленную коробку кладём к остальным коробкам).
 * Пока всё в памяти браузера на устройстве, как и скины; когда монеты
 * станут чем-то покупаться за звёзды, кошелёк переедет на сервер.
 */
import {
  normalize, rollDay, addBattle, claimTask, claimStreak, payForBox, hasReward, dayKey,
} from '../core/daily.js';
import { grantBoxes, allSkinsOwned } from './skins.js';

const STORE_KEY = 'worms.daily.v1';
const listeners = new Set();

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'); } catch { raw = null; }
  return rollDay(normalize(raw), dayKey());
}

function save(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* инкогнито */ }
  for (const fn of listeners) fn(state);
  return state;
}

/** Подписка на изменения кошелька — меню перерисовывает счётчик. */
export function onDailyChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Состояние на сегодня: монеты, задания дня, серия. */
export function dailyState() { return load(); }

export function coins() { return load().coins; }

/** Есть ли что забрать — для точки на вкладке. */
export function rewardWaiting() { return hasReward(load(), dayKey()); }

/** Итог боя. @returns {{coins:number, done:string[]}} */
export function recordBattle(stats, won) {
  const res = addBattle(load(), dayKey(), stats, won);
  save(res.state);
  return { coins: res.coins, done: res.done };
}

export function claimDailyTask(id) {
  const res = claimTask(load(), dayKey(), id);
  if (res.coins) save(res.state);
  return res.coins;
}

/** Бонус серии. Коробку, если положена, кладём к скинам. */
export function claimDailyStreak() {
  const res = claimStreak(load(), dayKey());
  if (!res.coins) return null;
  save(res.state);
  if (res.box) grantBoxes(1);
  return { coins: res.coins, box: res.box, streak: res.streak };
}

/**
 * Купить коробку за монеты.
 * @returns {'ok'|'poor'|'full'} куплено / не хватает / скины собраны все
 */
export function buyBox() {
  if (allSkinsOwned()) return 'full';
  const res = payForBox(load());
  if (!res.ok) return 'poor';
  save(res.state);
  grantBoxes(1);
  return 'ok';
}
