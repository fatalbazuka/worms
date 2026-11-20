/**
 * Уровень игрока: на устройстве и копией в облаке (Telegram и сервер игры).
 * Правила, кривая и таблица подарков — core/levels.js; монеты — в
 * platform/daily.js, коробки — в platform/skins.js, украшения — в
 * platform/cosmetics.js. Подарок за уровень выдаётся сразу, как уровень взят.
 */
import { normalizeLevel, mergeLevel, addXp, levelOf, rewardFor } from '../core/levels.js';
import { item } from '../core/cosmetics.js';
import { cloudReady, cloudLoad, cloudSave } from './cloud.js';
import { grantCoins } from './daily.js';
import { grantBoxes } from './skins.js';
import { grantCosmetic } from './cosmetics.js';
import { trackStep } from '../net/server.js';

const STORE_KEY = 'worms.level.v1';
/** Уровни, о которых стоит знать воронке: дошёл ли новичок до второго, пятого… */
const TRACKED = new Set([2, 5, 10, 20]);

function load() {
  try { return normalizeLevel(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')); } catch { return normalizeLevel(null); }
}

function save(st) {
  const raw = JSON.stringify(st);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  cloudSave(STORE_KEY, raw);
  return st;
}

/** Подтянуть облачную копию и свести с местной: опыт — больший. */
export async function syncLevelCloud() {
  if (!cloudReady()) return;
  let st = load();
  for (const raw of await cloudLoad(STORE_KEY)) {
    try { st = mergeLevel(st, JSON.parse(raw)); } catch { /* битая копия — мимо */ }
  }
  save(st);
}

/** Где игрок: { xp, level, into, need, progress }. */
export function levelState() {
  const st = load();
  return { xp: st.xp, ...levelOf(st.xp) };
}

/**
 * Выдать подарок за уровень. Украшение, которое уже куплено, — его ценой
 * в монетах: подарок не должен пропасть.
 * @returns {{coins:number, boxes:number, cos:{kind,id}|null}} что выдано
 */
function grantReward(level) {
  const r = rewardFor(level);
  const got = { coins: r?.coins ?? 0, boxes: r?.boxes ?? 0, cos: null };
  if (r?.cos) {
    if (grantCosmetic(r.cos.kind, r.cos.id)) got.cos = r.cos;
    else got.coins += item(r.cos.kind, r.cos.id)?.price ?? 0;
  }
  if (got.coins) grantCoins(got.coins);
  if (got.boxes) grantBoxes(got.boxes);
  return got;
}

/**
 * Опыт за бой — и подарки за взятые уровни, сразу.
 * @returns {{xp:number, before:object, after:object, rewards:Array<{level:number, coins:number, boxes:number, cos:object|null}>}}
 *   before и after — levelOf до и после
 */
export function gainXp(n) {
  const st = load();
  const before = levelOf(st.xp);
  const res = addXp(st, n);
  save(res.state);
  const rewards = res.levels.map((level) => ({ level, ...grantReward(level) }));
  for (const { level } of rewards) if (TRACKED.has(level)) trackStep(`level_${level}`, { once: true });
  return { xp: res.state.xp - st.xp, before, after: levelOf(res.state.xp), rewards };
}
