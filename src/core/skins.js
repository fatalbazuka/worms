/**
 * Скины бойца и коробки с ними — правила без хранилища и без сцены.
 *
 * Скин — это другой лист тех же шестнадцати кадров (tools/build_smiley.py):
 * меняется только внешность, на бой он не влияет.
 *
 * Всё — за монеты, звёзд в магазине нет:
 *   • скин можно купить напрямую — цена по редкости (PRICE);
 *   • коробка — гача: сначала по шансам (BOX_ODDS, видны игроку) выпадает
 *     редкость, потом любой скин этой редкости. Повтор не пропадает: за
 *     него возвращаются монеты (DUP_COINS), тем больше, чем реже скин.
 * Коробки ещё дают за кампанию: за первую миссию сразу, чтобы игрок
 * увидел, как это работает, дальше через одну и за последнюю.
 *
 * Состояние: { owned: [id], equipped: id, boxes: N, claimed: [id миссий] }.
 * Все функции чистые — берут состояние, возвращают новое; где оно лежит,
 * решает platform/skins.js. Так правила проверяются тестом без браузера.
 */

export const DEFAULT_SKIN = 'classic';

/**
 * Редкость: odds — шанс в коробке, %; price — цена напрямую, монет;
 * dup — сколько монет вернётся, если из коробки выпал уже собранный.
 */
export const RARITY = {
  common: { name: 'обычный', odds: 60, price: 800, dup: 160, color: '#c8d2e0' },
  rare: { name: 'редкий', odds: 27, price: 1800, dup: 400, color: '#6fb7ff' },
  epic: { name: 'эпический', odds: 10, price: 3600, dup: 900, color: '#c58bff' },
  legendary: { name: 'легендарный', odds: 3, price: 7000, dup: 1800, color: '#ffb347' },
};
export const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];

/** Цена скина за монеты (классический бесплатный — 0). */
export function skinPrice(id) {
  const s = SKIN_BY_ID[id];
  if (!s || s.id === DEFAULT_SKIN) return 0;
  return RARITY[s.rarity]?.price ?? 0;
}

export const SKINS = [
  { id: 'classic', name: 'Смайлик', sheet: 'smiley', rarity: 'common' },
  { id: 'ice', name: 'Ледышка', sheet: 'skin_ice', rarity: 'rare' },
  { id: 'alien', name: 'Пришелец', sheet: 'skin_alien', rarity: 'common' },
  { id: 'toxic', name: 'Токсик', sheet: 'skin_toxic', rarity: 'rare' },
  { id: 'pumpkin', name: 'Тыква', sheet: 'skin_pumpkin', rarity: 'common' },
  { id: 'rage', name: 'Злюка', sheet: 'skin_rage', rarity: 'common' },
  { id: 'devil', name: 'Чертёнок', sheet: 'skin_devil', rarity: 'epic' },
  { id: 'clown', name: 'Клоун', sheet: 'skin_clown', rarity: 'epic' },
  { id: 'cool', name: 'Крутой', sheet: 'skin_cool', rarity: 'common' },
  { id: 'nerd', name: 'Ботаник', sheet: 'skin_nerd', rarity: 'common' },
  { id: 'sleepy', name: 'Соня', sheet: 'skin_sleepy', rarity: 'common' },
  { id: 'ninja', name: 'Ниндзя', sheet: 'skin_ninja', rarity: 'common' },
  { id: 'pirate', name: 'Пират', sheet: 'skin_pirate', rarity: 'common' },
  { id: 'robot', name: 'Робот', sheet: 'skin_robot', rarity: 'common' },
  { id: 'astro', name: 'Космонавт', sheet: 'skin_astro', rarity: 'epic' },
  { id: 'king', name: 'Король', sheet: 'skin_king', rarity: 'legendary' },
  { id: 'rainbow', name: 'Радуга', sheet: 'skin_rainbow', rarity: 'legendary' },
  { id: 'detective', name: 'Детектив', sheet: 'skin_detective', rarity: 'common' },
  { id: 'chef', name: 'Шеф', sheet: 'skin_chef', rarity: 'rare' },
  { id: 'bubblegum', name: 'Жвачка', sheet: 'skin_bubblegum', rarity: 'rare' },
  { id: 'zipper', name: 'Молния', sheet: 'skin_zipper', rarity: 'rare' },
  { id: 'knight', name: 'Рыцарь', sheet: 'skin_knight', rarity: 'epic' },
  { id: 'bomb', name: 'Бомба', sheet: 'skin_bomb', rarity: 'epic' },
  { id: 'beardo', name: 'Бородач', sheet: 'skin_beardo', rarity: 'legendary' },
  { id: 'poophead', name: 'Какашка', sheet: 'skin_poophead', rarity: 'legendary' },
];

/** Что может выпасть из коробки: все, кроме стартового. */
export const BOX_SKINS = SKINS.filter((s) => s.id !== DEFAULT_SKIN);

export const SKIN_BY_ID = Object.fromEntries(SKINS.map((s) => [s.id, s]));

export function emptyState() {
  // paidSeen — сколько коробок с сервера (куплено + подарено) уже положено
  // coinsSeen — сколько монет-подарков от админа уже положено в кошелёк
  return { owned: [DEFAULT_SKIN], equipped: DEFAULT_SKIN, boxes: 0, claimed: [], paidSeen: 0, coinsSeen: 0 };
}

/** Привести что угодно из хранилища к правильному состоянию. */
export function normalize(raw) {
  const st = emptyState();
  if (!raw || typeof raw !== 'object') return st;
  const owned = Array.isArray(raw.owned) ? raw.owned.filter((id) => SKIN_BY_ID[id]) : [];
  st.owned = [...new Set([DEFAULT_SKIN, ...owned])];
  st.equipped = st.owned.includes(raw.equipped) ? raw.equipped : DEFAULT_SKIN;
  st.boxes = Math.max(0, Math.min(99, Math.floor(Number(raw.boxes) || 0)));
  st.claimed = Array.isArray(raw.claimed) ? [...new Set(raw.claimed.map(String))] : [];
  st.paidSeen = Math.max(0, Math.floor(Number(raw.paidSeen) || 0));
  st.coinsSeen = Math.max(0, Math.floor(Number(raw.coinsSeen) || 0));
  return st;
}

/**
 * Свести две копии (устройство и облако Telegram): собранное — объединяем,
 * счётчики — берём больший. Так ни одна копия не теряет того, что есть в
 * другой; надетый — с этого устройства, если он есть в собранных.
 */
export function mergeSkins(a, b) {
  const x = normalize(a), y = normalize(b);
  const owned = [...new Set([...x.owned, ...y.owned])];
  return normalize({
    owned,
    equipped: owned.includes(x.equipped) ? x.equipped : y.equipped,
    boxes: Math.max(x.boxes, y.boxes),
    claimed: [...new Set([...x.claimed, ...y.claimed])],
    paidSeen: Math.max(x.paidSeen, y.paidSeen),
    coinsSeen: Math.max(x.coinsSeen, y.coinsSeen),
  });
}

/**
 * Применить то, что положено с сервера: коробки — разницей с уже
 * положенными (paidSeen), купленные скины — в собранные. Повторный вызов
 * ничего не добавляет.
 * @returns {{state, boxes:number, skins:string[]}} что прибавилось
 */
export function applyOwned(state, owned) {
  const total = Math.max(0, Math.floor(Number(owned?.boxes) || 0));
  const add = Math.max(0, total - state.paidSeen);
  const coinsTotal = Math.max(0, Math.floor(Number(owned?.coins) || 0));
  const coins = Math.max(0, coinsTotal - (state.coinsSeen ?? 0));
  const newSkins = (owned?.skins ?? []).filter((id) => SKIN_BY_ID[id] && !state.owned.includes(id));
  if (!add && !coins && !newSkins.length && total <= state.paidSeen) return { state, boxes: 0, coins: 0, skins: [] };
  return {
    state: {
      ...state,
      boxes: Math.min(99, state.boxes + add),
      paidSeen: Math.max(state.paidSeen, total),
      coinsSeen: Math.max(state.coinsSeen ?? 0, coinsTotal),
      owned: [...state.owned, ...newSkins],
    },
    boxes: add,
    coins,
    skins: newSkins,
  };
}

/** За какие миссии дают коробку: первая, дальше через одну и последняя. */
export function rewardMissions(missionIds) {
  const last = missionIds.length - 1;
  return missionIds.filter((_, i) => i % 2 === 0 || i === last);
}

/**
 * Выдать коробки за пройденные миссии, за которые их ещё не выдавали.
 * Вызывается и сразу после победы, и при входе в меню — так коробки
 * получают и те, кто прошёл миссии до появления скинов.
 */
export function claimBoxes(state, doneIds, missionIds) {
  const done = new Set(doneIds);
  const fresh = rewardMissions(missionIds)
    .filter((id) => done.has(id) && !state.claimed.includes(id));
  if (!fresh.length) return { state, gained: 0 };
  return {
    state: { ...state, boxes: state.boxes + fresh.length, claimed: [...state.claimed, ...fresh] },
    gained: fresh.length,
  };
}

/**
 * Открыть коробку: случайный скин из тех, которых ещё нет. Если собраны
 * все, коробка не тратится (full: true) — она дождётся новых скинов.
 */
export function openBox(state, rnd = Math.random) {
  if (state.boxes <= 0) return { state, skin: null, dup: false, refund: 0 };
  // Редкость — по шансам; если такой редкости скинов нет, берём обычную
  let r = rnd() * RARITY_ORDER.reduce((a, k) => a + RARITY[k].odds, 0);
  let rarity = 'common';
  for (const k of RARITY_ORDER) {
    r -= RARITY[k].odds;
    if (r < 0) { rarity = k; break; }
  }
  const same = BOX_SKINS.filter((s) => s.rarity === rarity);
  const pool = same.length ? same : BOX_SKINS;
  const skin = pool[Math.min(Math.floor(rnd() * pool.length), pool.length - 1)];
  const dup = state.owned.includes(skin.id);
  return {
    state: { ...state, boxes: state.boxes - 1, owned: dup ? state.owned : [...state.owned, skin.id] },
    skin: skin.id,
    dup,
    refund: dup ? RARITY[skin.rarity].dup : 0,
  };
}

/** Купить скин напрямую (монеты списывает вызывающий). */
export function addSkin(state, id) {
  if (!SKIN_BY_ID[id] || state.owned.includes(id)) return state;
  return { ...state, owned: [...state.owned, id] };
}

/** Надеть скин — только свой. */
export function equip(state, id) {
  return state.owned.includes(id) ? { ...state, equipped: id } : state;
}

/**
 * Скин соперника, когда свой он не прислал (бот, сосед по телефону):
 * любой, кроме скина игрока, — один и тот же для данного зерна партии.
 */
export function rivalSkin(seed, team, mine = DEFAULT_SKIN) {
  const pool = SKINS.filter((s) => s.id !== mine);
  return pool[((seed >>> 0) + team * 7) % pool.length].id;
}
