/**
 * Украшения игрока: на устройстве и копией в облаке Telegram.
 * Правила и каталог — core/cosmetics.js, монеты — platform/daily.js.
 */
import { normalizeCos, mergeCos, buyCos, equipCos, item } from '../core/cosmetics.js';
import { cloudReady, cloudLoad, cloudSave } from './cloud.js';
import { coins, payCoins } from './daily.js';

const STORE_KEY = 'worms.cosmetics.v1';

function load() {
  try { return normalizeCos(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')); } catch { return normalizeCos(null); }
}

function save(st) {
  const raw = JSON.stringify(st);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  cloudSave(STORE_KEY, raw);
  return st;
}

export function cosState() { return load(); }

/** Что надето: { rope, trail, grave }. */
export function myCosmetics() { return load().equipped; }

/** Купить и сразу надеть. @returns {'ok'|'poor'|'owned'} */
export function buyCosmetic(kind, id) {
  const st = load();
  if (st.owned[kind]?.includes(id)) return 'owned';
  const res = buyCos(st, kind, id, coins());
  if (!res.ok) return 'poor';
  if (!payCoins(res.price)) return 'poor';
  save(res.state);
  return 'ok';
}

/**
 * Подарить вещь (награда за уровень): в собранные, но не надевать — что
 * носить, игрок решает сам. @returns {boolean} false — уже была или нет такой
 */
export function grantCosmetic(kind, id) {
  const st = load();
  if (!item(kind, id) || st.owned[kind]?.includes(id)) return false;
  save({ ...st, owned: { ...st.owned, [kind]: [...st.owned[kind], id] } });
  return true;
}

export function equipCosmetic(kind, id) {
  save(equipCos(load(), kind, id));
}

export async function syncCosmeticsCloud() {
  if (!cloudReady()) return;
  let st = load();
  for (const raw of await cloudLoad(STORE_KEY)) {
    try { st = mergeCos(st, JSON.parse(raw)); } catch { /* битая копия — мимо */ }
  }
  save(st);
}
