/**
 * Скины и коробки игрока: где лежат и как меняются.
 *
 * Правила — в core/skins.js, здесь только хранилище. Пока это память
 * браузера на устройстве: сервер про скины ничего не знает. Когда скины
 * начнут продаваться, владение переедет на сервер, а эти функции
 * останутся теми же снаружи.
 */
import {
  SKINS, SKIN_BY_ID, DEFAULT_SKIN, BOX_SKINS, normalize, claimBoxes, openBox, equip, mergeSkins, applyOwned,
} from '../core/skins.js';
import { inTelegram, cloudGet, cloudSet } from './telegram.js';
import { MISSIONS, loadProgress } from '../campaign/missions.js';
import { ASCENT } from '../campaign/ascent.js';
import { ascentDone } from './ascent.js';

const STORE_KEY = 'worms.skins.v1';

function load() {
  try { return normalize(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')); } catch { return normalize(null); }
}

function save(state) {
  const raw = JSON.stringify(state);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  // Копия в облаке Telegram: сменил телефон — скины с тобой
  if (inTelegram()) cloudSet(STORE_KEY, raw);
  return state;
}

/** Подтянуть облачную копию и свести с местной. Зовётся при запуске. */
export async function syncSkinsCloud() {
  if (!inTelegram()) return;
  let cloud = null;
  try { cloud = JSON.parse((await cloudGet(STORE_KEY)) ?? 'null'); } catch { cloud = null; }
  if (cloud) save(mergeSkins(load(), cloud));
}

/**
 * Применить то, что положено с сервера (покупки за звёзды, подарки).
 * @returns {{boxes:number, skins:string[]}} что прибавилось
 */
export function applyServerOwned(owned) {
  const before = load();
  const res = applyOwned(before, owned);
  if (res.boxes || res.skins.length || res.state.paidSeen !== before.paidSeen) save(res.state);
  return { boxes: res.boxes, skins: res.skins };
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
  return BOX_SKINS.every((s) => load().owned.includes(s.id));
}

/**
 * Выдать коробки за пройденные миссии кампании.
 * @returns {number} сколько коробок выдано сейчас
 */
export function syncCampaignBoxes() {
  // И за «Подъём»: первый бой, дальше через один и последний
  const old = claimBoxes(load(), [...loadProgress()], MISSIONS.map((m) => m.id));
  const up = claimBoxes(old.state, [...ascentDone()], ASCENT.map((m) => m.id));
  const res = { state: up.state, gained: old.gained + up.gained };
  if (res.gained) save(res.state);
  return res.gained;
}
