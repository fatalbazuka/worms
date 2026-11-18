/**
 * Скины бойца и коробки с ними — правила без хранилища и без сцены.
 *
 * Скин — это другой лист тех же шестнадцати кадров (tools/build_smiley.py):
 * меняется только внешность, на бой он не влияет. Коробка даёт случайный
 * скин из тех, которых у игрока ещё нет, — повторов не бывает, поэтому
 * каждая коробка радует. Коробки дают за первое прохождение миссий
 * кампании: за первую сразу, чтобы игрок увидел, как это работает, дальше
 * через одну и за последнюю.
 *
 * Состояние: { owned: [id], equipped: id, boxes: N, claimed: [id миссий] }.
 * Все функции чистые — берут состояние, возвращают новое; где оно лежит,
 * решает platform/skins.js. Так правила проверяются тестом без браузера.
 */

export const DEFAULT_SKIN = 'classic';

export const SKINS = [
  { id: 'classic', name: 'Смайлик', sheet: 'smiley' },
  { id: 'ice', name: 'Ледышка', sheet: 'skin_ice' },
  { id: 'alien', name: 'Пришелец', sheet: 'skin_alien' },
  { id: 'toxic', name: 'Токсик', sheet: 'skin_toxic' },
  { id: 'pumpkin', name: 'Тыква', sheet: 'skin_pumpkin' },
  { id: 'rage', name: 'Злюка', sheet: 'skin_rage' },
  { id: 'devil', name: 'Чертёнок', sheet: 'skin_devil' },
  { id: 'clown', name: 'Клоун', sheet: 'skin_clown' },
];

export const SKIN_BY_ID = Object.fromEntries(SKINS.map((s) => [s.id, s]));

export function emptyState() {
  return { owned: [DEFAULT_SKIN], equipped: DEFAULT_SKIN, boxes: 0, claimed: [] };
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
  return st;
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
  if (state.boxes <= 0) return { state, skin: null, full: false };
  const pool = SKINS.filter((s) => !state.owned.includes(s.id));
  if (!pool.length) return { state, skin: null, full: true };
  const skin = pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
  return {
    state: { ...state, boxes: state.boxes - 1, owned: [...state.owned, skin.id] },
    skin: skin.id,
    full: false,
  };
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
