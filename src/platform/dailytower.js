/**
 * «Башня дня» игрока: серия побед по дням и монеты за первую победу дня —
 * на устройстве и копией в облаке. Правила — core/dailytower.js.
 */
import { normalizeDT, recordDailyRun, mergeDT, streakNow } from '../core/dailytower.js';
import { dayKey } from '../core/daily.js';
import { cloudReady, cloudLoad, cloudSave } from './cloud.js';
import { grantCoins } from './daily.js';

const STORE_KEY = 'worms.dailytower.v1';
// Прежний ключ: в нём жил только день, за который монеты уже выданы
const OLD_KEY = 'worms.dailyTower.v1';

function load() {
  let st = null;
  try { st = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'); } catch { st = null; }
  if (!st) {
    try { st = { rewarded: JSON.parse(localStorage.getItem(OLD_KEY) ?? '{}')?.rewarded ?? null }; } catch { st = null; }
  }
  return normalizeDT(st);
}

function save(st) {
  const raw = JSON.stringify(st);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  cloudSave(STORE_KEY, raw);
  return st;
}

/** Серия на сегодня (0 — прервана или не начиналась). */
export function dailyTowerStreak(day = dayKey()) { return streakNow(load(), day); }

/** Взята ли башня в этот день. */
export function dailyTowerWon(day = dayKey()) { return load().lastWin === day; }

/**
 * Попытка доиграна: монеты за первую победу дня и бонус серии — сразу в кошелёк.
 * day — день башни (из описания партии).
 * @returns {{coins:number, bonus:number, streak:number}}
 */
export function recordDailyTower(won, day = dayKey()) {
  const res = recordDailyRun(load(), day, won);
  if (won) save(res.state);
  if (res.coins + res.bonus) grantCoins(res.coins + res.bonus);
  return { coins: res.coins, bonus: res.bonus, streak: res.streak };
}

/** Облачная копия: серия — по более поздней победе. */
export async function syncDailyTowerCloud() {
  if (!cloudReady()) return;
  let st = load();
  for (const raw of await cloudLoad(STORE_KEY)) {
    try { st = mergeDT(st, JSON.parse(raw)); } catch { /* битая копия — мимо */ }
  }
  save(st);
}
