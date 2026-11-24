import { subRng } from './rng.js';

/**
 * «Арсенал боя»: каждой стороне — одни и те же три оружия сверх обычного.
 *
 * Оружия в игре восемнадцать, а с патронами на старте — базука, граната и
 * пара мелочей; остальное приходит только из ящиков. Симуляция 280 боёв:
 * ~80% выстрелов — базука. Разнообразие, которым игра хвалится, почти не
 * видно. Теперь в каждом бою по три «гостя» из того, чего на старте нет, —
 * по зерну партии, у обеих сторон одинаково (бой честный, и «Башня дня»
 * у всех одна).
 *
 * Без Phaser: проверяется в tests/match.mjs.
 */

/** Сколько оружий в арсенале боя. */
export const LOADOUT_SIZE = 3;
/**
 * В бою с человеком (онлайн, дуэль по переписке) — пять: там нет бота,
 * которого надо щадить, а разнообразие и есть смысл боя с другом.
 */
export const PVP_LOADOUT_SIZE = 5;

/** Соль генератора: арсенал не должен зависеть от того, сколько случайностей взяла карта. */
const SALT = 7331;

/**
 * Телепорт и батут — не оружие, а ход: в «гостях» они вытесняли бы то,
 * ради чего арсенал и придуман, — новый способ попасть.
 */
const NOT_IN_LOADOUT = new Set(['teleport', 'spring']);

/**
 * Режимы, где арсенал боя есть: быстрый бой, «Башня дня», бой онлайн и
 * дуэль по переписке. Кампания, испытания и «Подъём» строят бой на своих
 * правилах (only, ammo, кривая сложности).
 *
 * По сети арсенал у обоих один — по зерну партии. Патроны едут в снимке
 * хода, и снимок — истина: если у соперника клиент старый (из кэша) и
 * арсенала не знает, после его хода патроны станут как у него, а не
 * разойдутся. Дуэль, начатая до арсенала (rules.loadout === false), идёт
 * по старым правилам до конца: её патроны уже записаны в истории ходов.
 */
export function loadoutApplies(match) {
  if (!match || match.tutorial) return false;
  if (!['quick', 'daily', 'online', 'duel'].includes(match.mode)) return false;
  const r = match.rules ?? {};
  if (r.loadout === false) return false;
  // Бой со своим набором оружия — не трогаем
  if (Array.isArray(r.only) || r.ammo || r.enemyAmmo) return false;
  return true;
}

/**
 * Оружия арсенала по зерну: первые три — те же, что в бою с ботом на этом
 * зерне, дальше добавляются ещё.
 * @param {number} seed
 * @param {{id:string, startAmmo:number|null}[]} weapons — реестр (WEAPONS)
 * @returns {string[]} id в порядке реестра
 */
export function battleLoadout(seed, weapons, size = LOADOUT_SIZE) {
  const pool = weapons.filter((w) => w.startAmmo === 0 && !NOT_IN_LOADOUT.has(w.id)).map((w) => w.id);
  const rng = subRng(Number(seed) >>> 0, SALT);
  const picked = [];
  while (picked.length < size && pool.length) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  const order = weapons.map((w) => w.id);
  return picked.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Патронов на сторону: по одному, слабым редким (крот, миномёт, липучка —
 * урон меньше полусотни) — по два, иначе их и пробовать незачем.
 */
export function loadoutAmmo(w) {
  return w.rarity === 'rare' && (w.explosion?.damage ?? 0) < 50 ? 2 : 1;
}
