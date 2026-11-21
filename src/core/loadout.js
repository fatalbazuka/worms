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

/** Соль генератора: арсенал не должен зависеть от того, сколько случайностей взяла карта. */
const SALT = 7331;

/**
 * Телепорт и батут — не оружие, а ход: в «гостях» они вытесняли бы то,
 * ради чего арсенал и придуман, — новый способ попасть.
 */
const NOT_IN_LOADOUT = new Set(['teleport', 'spring']);

/**
 * Режимы, где арсенал боя есть. Сетевые бои и дуэли — нет: у старого
 * клиента из кэша патронов было бы меньше, а снимок хода переносит патроны
 * от одного к другому (подробнее — в отчёте к правке). Кампания, испытания
 * и «Подъём» строят бой на своих правилах (only, ammo, кривая сложности).
 */
export function loadoutApplies(match, { online = false } = {}) {
  if (!match || online || match.tutorial) return false;
  if (match.mode !== 'quick' && match.mode !== 'daily') return false;
  const r = match.rules ?? {};
  // Бой со своим набором оружия — не трогаем
  if (Array.isArray(r.only) || r.ammo || r.enemyAmmo) return false;
  return true;
}

/**
 * Три оружия по зерну.
 * @param {number} seed
 * @param {{id:string, startAmmo:number|null}[]} weapons — реестр (WEAPONS)
 * @returns {string[]} id в порядке реестра
 */
export function battleLoadout(seed, weapons) {
  const pool = weapons.filter((w) => w.startAmmo === 0 && !NOT_IN_LOADOUT.has(w.id)).map((w) => w.id);
  const rng = subRng(Number(seed) >>> 0, SALT);
  const picked = [];
  while (picked.length < LOADOUT_SIZE && pool.length) {
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
