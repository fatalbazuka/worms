/**
 * Скины и коробки игрока: где лежат и как меняются.
 *
 * Правила — в core/skins.js, здесь только хранилище. Пока это память
 * браузера на устройстве: сервер про скины ничего не знает. Когда скины
 * начнут продаваться, владение переедет на сервер, а эти функции
 * останутся теми же снаружи.
 */
import {
  SKINS, SKIN_BY_ID, DEFAULT_SKIN, normalize, claimBoxes, openBox, equip,
} from '../core/skins.js';
import { MISSIONS, loadProgress } from '../campaign/missions.js';

const STORE_KEY = 'worms.skins.v1';

function load() {
  try { return normalize(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')); } catch { return normalize(null); }
}

function save(state) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* инкогнито */ }
  return state;
}

export function skinState() { return load(); }

/** Надетый скин: { id, name, sheet }. */
export function equippedSkin() {
  return SKIN_BY_ID[load().equipped] ?? SKIN_BY_ID[DEFAULT_SKIN];
}

export function equipSkin(id) { return save(equip(load(), id)); }

/** Открыть коробку. @returns {{skin: string|null, full: boolean}} */
export function openSkinBox() {
  const res = openBox(load());
  save(res.state);
  return { skin: res.skin, full: res.full };
}

/** Добавить коробок (серия дней, покупка за монеты). */
export function grantBoxes(n = 1) {
  const st = load();
  return save({ ...st, boxes: Math.min(99, st.boxes + n) });
}

/** Собраны ли все скины — тогда коробку покупать незачем. */
export function allSkinsOwned() {
  return load().owned.length >= SKINS.length;
}

/**
 * Выдать коробки за пройденные миссии кампании.
 * @returns {number} сколько коробок выдано сейчас
 */
export function syncCampaignBoxes() {
  const res = claimBoxes(load(), [...loadProgress()], MISSIONS.map((m) => m.id));
  if (res.gained) save(res.state);
  return res.gained;
}
