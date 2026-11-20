import { prevDay } from './daily.js';

/**
 * «Башня дня» как ежедневный ритуал: своя серия — дни подряд, в которые
 * башня взята хоть раз, — и бонус монетами на 3-й и каждый 7-й день.
 *
 * Чистые функции; хранилище — platform/dailytower.js. День — YYYY-MM-DD.
 * Состояние: { rewarded: день первой победы с монетами, lastWin: последний
 * день победы, streak: серия на lastWin }.
 */

/** Монеты за первую победу дня. */
export const DAILY_TOWER_COINS = 60;
/** Бонус серии: на 3-й день и на каждый 7-й. */
export function streakBonus(streak) {
  if (streak === 3) return 100;
  if (streak > 0 && streak % 7 === 0) return 250;
  return 0;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v) => (typeof v === 'string' && DAY.test(v) ? v : null);

export function normalizeDT(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    rewarded: day(r.rewarded),
    lastWin: day(r.lastWin),
    streak: Math.max(0, Math.min(9999, Math.floor(Number(r.streak) || 0))),
  };
}

/** Серия на сегодня: живая, если последняя победа сегодня или вчера. */
export function streakNow(state, today) {
  const st = normalizeDT(state);
  if (!st.lastWin) return 0;
  return st.lastWin === today || st.lastWin === prevDay(today) ? st.streak : 0;
}

/**
 * Попытка «Башни дня» доиграна.
 * @returns {{state, coins:number, bonus:number, streak:number}} coins — за
 *   первую победу дня, bonus — за серию (оба — один раз в день)
 */
export function recordDailyRun(state, today, won) {
  const st = normalizeDT(state);
  if (!won) return { state: st, coins: 0, bonus: 0, streak: streakNow(st, today) };
  const coins = st.rewarded === today ? 0 : DAILY_TOWER_COINS;
  if (st.lastWin === today) return { state: { ...st, rewarded: today }, coins, bonus: 0, streak: st.streak };
  const streak = st.lastWin === prevDay(today) ? st.streak + 1 : 1;
  return { state: { rewarded: today, lastWin: today, streak }, coins, bonus: streakBonus(streak), streak };
}

/** Две копии (устройство и облако): серия — по более поздней победе. */
export function mergeDT(a, b) {
  const x = normalizeDT(a), y = normalizeDT(b);
  const later = (p, q) => ((p ?? '') >= (q ?? '') ? p : q);
  let streak;
  if (x.lastWin === y.lastWin) streak = Math.max(x.streak, y.streak);
  else streak = later(x.lastWin, y.lastWin) === x.lastWin ? x.streak : y.streak;
  return { rewarded: later(x.rewarded, y.rewarded), lastWin: later(x.lastWin, y.lastWin), streak };
}
