/**
 * Украшения за монеты — правила без хранилища (хранит platform/cosmetics.js).
 *
 * На бой не влияют, только на вид: цвет троса, след за снарядом, что
 * остаётся на месте выбитого бойца. Сопернику по сети уходит то, что надето
 * (session hello), и он видит тебя таким же.
 *
 * Первая вещь в каждом ряду бесплатная и есть у всех — это то, как было.
 */

export const COSMETICS = {
  rope: [
    { id: 'classic', name: 'Пеньковый', color: 0xe8d9a8, price: 0 },
    { id: 'gold', name: 'Золотой', color: 0xffd23f, price: 200 },
    { id: 'neon', name: 'Неоновый', color: 0x5dff7a, price: 200 },
    { id: 'pink', name: 'Розовый', color: 0xff7ad9, price: 200 },
    { id: 'ice', name: 'Ледяной', color: 0x8fe3ff, price: 200 },
    { id: 'rainbow', name: 'Радужный', rainbow: true, price: 400 },
  ],
  trail: [
    { id: 'none', name: 'Обычный', price: 0 },
    { id: 'fire', name: 'Огонь', color: 0xff8a3d, price: 250 },
    { id: 'stars', name: 'Звёзды', color: 0xffe27a, dots: true, price: 250 },
    { id: 'hearts', name: 'Сердечки', color: 0xff6b9a, dots: true, price: 250 },
    { id: 'rainbow', name: 'Радуга', rainbow: true, price: 400 },
  ],
  grave: [
    { id: 'ghost', name: 'Призрак', price: 0 },
    { id: 'flower', name: 'Цветочек', emoji: 'blossom', price: 300 },
    { id: 'tomb', name: 'Надгробие', emoji: 'headstone', price: 300 },
    { id: 'skull', name: 'Череп', emoji: 'skull', price: 300 },
    { id: 'crown', name: 'Корона', emoji: 'crown', price: 450 },
  ],
};

export const KINDS = Object.keys(COSMETICS);
export const KIND_NAMES = { rope: 'Трос', trail: 'След снаряда', grave: 'Что остаётся от выбитого' };

export function item(kind, id) {
  return COSMETICS[kind]?.find((x) => x.id === id) ?? null;
}

export const DEFAULTS = Object.fromEntries(KINDS.map((k) => [k, COSMETICS[k][0].id]));

export function emptyCos() {
  return {
    owned: Object.fromEntries(KINDS.map((k) => [k, [DEFAULTS[k]]])),
    equipped: { ...DEFAULTS },
  };
}

/** Привести что угодно из хранилища к правильному состоянию. */
export function normalizeCos(raw) {
  const st = emptyCos();
  if (!raw || typeof raw !== 'object') return st;
  for (const k of KINDS) {
    const own = Array.isArray(raw.owned?.[k]) ? raw.owned[k].filter((id) => item(k, id)) : [];
    st.owned[k] = [...new Set([DEFAULTS[k], ...own])];
    const eq = raw.equipped?.[k];
    st.equipped[k] = st.owned[k].includes(eq) ? eq : DEFAULTS[k];
  }
  return st;
}

/** Надетое — только известные id; чужое из сети тоже через это. */
export function cleanEquipped(raw) {
  const out = { ...DEFAULTS };
  for (const k of KINDS) if (item(k, raw?.[k])) out[k] = raw[k];
  return out;
}

/** Две копии (устройство и облако): купленное — объединение, надетое — с устройства. */
export function mergeCos(local, cloud) {
  const a = normalizeCos(local), b = normalizeCos(cloud);
  return normalizeCos({
    owned: Object.fromEntries(KINDS.map((k) => [k, [...a.owned[k], ...b.owned[k]]])),
    equipped: a.equipped,
  });
}

/**
 * Купить вещь. coins — сколько монет у игрока.
 * @returns {{state, ok:boolean, price:number}} ok — куплено и надето
 */
export function buyCos(state, kind, id, coins) {
  const it = item(kind, id);
  if (!it || state.owned[kind].includes(id) || coins < it.price) return { state, ok: false, price: 0 };
  return {
    state: {
      owned: { ...state.owned, [kind]: [...state.owned[kind], id] },
      equipped: { ...state.equipped, [kind]: id },
    },
    ok: true,
    price: it.price,
  };
}

export function equipCos(state, kind, id) {
  if (!state.owned[kind]?.includes(id)) return state;
  return { ...state, equipped: { ...state.equipped, [kind]: id } };
}
