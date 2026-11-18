/**
 * Монеты, ежедневные задания и серия дней — правила без хранилища.
 *
 * Как устроен день:
 *   • три задания на сутки, одни и те же у всех (выбираются по дате);
 *   • прогресс копится из боёв: попадания, урон, выбитые бойцы, тросы…;
 *   • выполненное задание забирают кнопкой — монеты падают в кошелёк;
 *   • за каждый бой — монеты, за победу больше; но только за первые
 *     BATTLE_COIN_LIMIT боёв в сутки, иначе монеты фармились бы о ботов;
 *   • первый вход за день — бонус серии; каждый седьмой день подряд —
 *     коробка со скином, монеты после седьмого дня держатся на максимуме;
 *   • коробку можно купить за BOX_PRICE монет;
 *   • заморозка серии: пропустил один день — серия не сгорает, если есть
 *     заморозка. Одна приходит бесплатно каждую неделю, ещё — за
 *     FREEZE_PRICE монет; больше FREEZE_MAX держать нельзя.
 *
 * Все функции чистые: берут состояние и «сегодня», возвращают новое. Где
 * оно лежит, решает platform/daily.js. День — строка YYYY-MM-DD по
 * местному времени игрока.
 */

export const BOX_PRICE = 300;
export const BATTLE_COINS = { win: 25, loss: 10 };
export const BATTLE_COIN_LIMIT = 10;
export const TASKS_PER_DAY = 3;

/** Награда за серию: день 1…7, дальше — седьмая. Каждый 7-й день — коробка. */
export const STREAK_COINS = [20, 30, 40, 50, 60, 80, 120];
export const STREAK_BOX_DAY = 7;
export const FREEZE_PRICE = 200;
export const FREEZE_MAX = 3;

/**
 * Задания. stat — счётчик из боя (см. GameScene.battleStats), goal — сколько
 * набрать, coins — награда. Счётчики с одним stat в один день не попадают:
 * «сыграй 3 боя» и «сыграй 5 боёв» вместе — это одно задание дважды.
 */
export const TASKS = [
  { id: 'play3', stat: 'battles', goal: 3, coins: 60, text: 'Сыграй 3 боя' },
  { id: 'win1', stat: 'wins', goal: 1, coins: 70, text: 'Победи в бою' },
  { id: 'win3', stat: 'wins', goal: 3, coins: 150, text: 'Победи 3 раза' },
  { id: 'hits6', stat: 'hits', goal: 6, coins: 60, text: 'Попади по соперникам 6 раз' },
  { id: 'dmg300', stat: 'damage', goal: 300, coins: 80, text: 'Нанеси 300 урона' },
  { id: 'kills3', stat: 'kills', goal: 3, coins: 90, text: 'Выбей 3 бойцов' },
  { id: 'hooks6', stat: 'hooks', goal: 6, coins: 50, text: 'Пусти трос 6 раз' },
  { id: 'crates2', stat: 'crates', goal: 2, coins: 60, text: 'Подбери 2 ящика' },
  { id: 'grenade', stat: 'grenadeHits', goal: 2, coins: 70, text: 'Попади гранатой 2 раза' },
  // «Сыграй бой с человеком» (stat 'online') вернётся, когда людей в
  // онлайне станет достаточно: пока такое задание часто невыполнимо
];

export const TASK_BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t]));

/** Какие счётчики умеет присылать бой. */
export const STATS = [...new Set(TASKS.map((t) => t.stat))];

/** Строка дня по местному времени: «2026-11-18». */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Вчера относительно дня day. */
export function prevDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d - 1));
}

/** Неделя дня day: понедельник этой недели. */
export function weekKey(day) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return dayKey(new Date(y, m - 1, d - ((t.getDay() + 6) % 7)));
}

/** Простой генератор от строки — чтобы выбор заданий зависел только от даты. */
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/** Задания дня: TASKS_PER_DAY штук, с разными счётчиками, одни у всех. */
export function tasksFor(day) {
  const rnd = seeded(`tasks:${day}`);
  const pool = TASKS.slice();
  const out = [];
  while (out.length < TASKS_PER_DAY && pool.length) {
    const t = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    if (out.some((o) => o.stat === t.stat)) continue;
    out.push(t);
  }
  return out.map((t) => t.id);
}

export function emptyState() {
  return {
    coins: 0,
    day: null,          // день, к которому относятся задания и счётчики
    tasks: [],          // [{ id, progress, claimed }]
    battlesToday: 0,    // сколько боёв сегодня уже принесли монеты
    streak: 0,          // дней подряд
    streakDay: null,    // день, за который бонус серии уже забран
    freezes: 0,         // заморозки серии в запасе
    freezeWeek: null,   // неделя, за которую бесплатная заморозка уже выдана
  };
}

/** Привести что угодно из хранилища к правильному состоянию. */
export function normalize(raw) {
  const st = emptyState();
  if (!raw || typeof raw !== 'object') return st;
  const int = (v, max = 1e9) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  st.coins = int(raw.coins);
  st.day = typeof raw.day === 'string' ? raw.day : null;
  st.tasks = Array.isArray(raw.tasks)
    ? raw.tasks.filter((t) => t && TASK_BY_ID[t.id])
      .map((t) => ({ id: t.id, progress: int(t.progress), claimed: Boolean(t.claimed) }))
    : [];
  st.battlesToday = int(raw.battlesToday, 1000);
  st.streak = int(raw.streak, 10000);
  st.streakDay = typeof raw.streakDay === 'string' ? raw.streakDay : null;
  st.freezes = int(raw.freezes, FREEZE_MAX);
  st.freezeWeek = typeof raw.freezeWeek === 'string' ? raw.freezeWeek : null;
  return st;
}

/** Наступил новый день — новые задания, счётчик боёв с нуля. */
export function rollDay(state, day) {
  if (state.day === day) return state;
  return {
    ...state,
    day,
    tasks: tasksFor(day).map((id) => ({ id, progress: 0, claimed: false })),
    battlesToday: 0,
  };
}

/**
 * Итог боя: счётчики двигают задания, сам бой приносит монеты.
 * stats — { battles, wins, hits, damage, kills, hooks, crates, grenadeHits, online }.
 * @returns {{state, coins: number, done: string[]}} монеты за бой и задания,
 *   которые этим боем стали выполненными
 */
export function addBattle(state, day, stats, won) {
  let st = rollDay(state, day);
  const done = [];
  st = {
    ...st,
    tasks: st.tasks.map((t) => {
      const def = TASK_BY_ID[t.id];
      const add = Math.max(0, Math.floor(Number(stats[def.stat]) || 0));
      const was = t.progress >= def.goal;
      const progress = Math.min(def.goal, t.progress + add);
      if (!was && progress >= def.goal) done.push(t.id);
      return { ...t, progress };
    }),
  };
  let coins = 0;
  if (st.battlesToday < BATTLE_COIN_LIMIT) {
    coins = won ? BATTLE_COINS.win : BATTLE_COINS.loss;
    st = { ...st, coins: st.coins + coins, battlesToday: st.battlesToday + 1 };
  }
  return { state: st, coins, done };
}

/** Забрать награду за выполненное задание. */
export function claimTask(state, day, id) {
  const st = rollDay(state, day);
  const t = st.tasks.find((x) => x.id === id);
  const def = TASK_BY_ID[id];
  if (!t || !def || t.claimed || t.progress < def.goal) return { state: st, coins: 0 };
  return {
    state: {
      ...st,
      coins: st.coins + def.coins,
      tasks: st.tasks.map((x) => (x.id === id ? { ...x, claimed: true } : x)),
    },
    coins: def.coins,
  };
}

/** Можно ли сегодня забрать бонус серии. */
export function streakReady(state, day) {
  return state.streakDay !== day;
}

/**
 * Бонус за вход: вчера забирал — серия растёт; пропустил ровно один день и
 * есть заморозка — тоже растёт, заморозка тратится; иначе — с начала.
 * Новая неделя — бесплатная заморозка (если запас не полон).
 * @returns {{state, coins, box: boolean, streak: number, frozen: boolean}}
 */
export function claimStreak(state, day) {
  if (!streakReady(state, day)) return { state, coins: 0, box: false, streak: state.streak, frozen: false };
  let freezes = state.freezes ?? 0;
  let freezeWeek = state.freezeWeek ?? null;
  const week = weekKey(day);
  if (freezeWeek !== week) { freezes = Math.min(FREEZE_MAX, freezes + 1); freezeWeek = week; }
  let streak = 1;
  let frozen = false;
  if (state.streakDay === prevDay(day)) streak = state.streak + 1;
  else if (state.streakDay === prevDay(prevDay(day)) && state.streak > 0 && freezes > 0) {
    streak = state.streak + 1;
    freezes -= 1;
    frozen = true;
  }
  const coins = STREAK_COINS[Math.min(streak, STREAK_COINS.length) - 1];
  const box = streak % STREAK_BOX_DAY === 0;
  return {
    state: { ...state, streak, streakDay: day, coins: state.coins + coins, freezes, freezeWeek },
    coins,
    box,
    streak,
    frozen,
  };
}

/** Купить заморозку серии за монеты. */
export function buyFreeze(state) {
  if (state.coins < FREEZE_PRICE || (state.freezes ?? 0) >= FREEZE_MAX) return { state, ok: false };
  return { state: { ...state, coins: state.coins - FREEZE_PRICE, freezes: (state.freezes ?? 0) + 1 }, ok: true };
}

/** Потратить монеты (украшения). */
export function spendCoins(state, n) {
  if (n <= 0 || state.coins < n) return { state, ok: false };
  return { state: { ...state, coins: state.coins - n }, ok: true };
}

/** Списать цену коробки. ok: false — монет не хватает. */
export function payForBox(state) {
  if (state.coins < BOX_PRICE) return { state, ok: false };
  return { state: { ...state, coins: state.coins - BOX_PRICE }, ok: true };
}

/**
 * Свести две копии (устройство и облако Telegram). Кошелёк — больший; день
 * заданий — более поздний, в один день — прогресс по максимуму; серия — с
 * более поздней отметкой.
 */
export function mergeDaily(a, b) {
  const x = normalize(a), y = normalize(b);
  const later = (x.day ?? '') >= (y.day ?? '') ? x : y;
  const other = later === x ? y : x;
  let tasks = later.tasks;
  if (other.day === later.day) {
    tasks = later.tasks.map((t) => {
      const o = other.tasks.find((z) => z.id === t.id);
      return o ? { id: t.id, progress: Math.max(t.progress, o.progress), claimed: t.claimed || o.claimed } : t;
    });
  }
  const streakSrc = (x.streakDay ?? '') >= (y.streakDay ?? '') ? x : y;
  return {
    coins: Math.max(x.coins, y.coins),
    day: later.day,
    tasks,
    battlesToday: other.day === later.day ? Math.max(x.battlesToday, y.battlesToday) : later.battlesToday,
    streak: streakSrc.streak,
    streakDay: streakSrc.streakDay,
    freezes: streakSrc.freezes,
    freezeWeek: (x.freezeWeek ?? '') >= (y.freezeWeek ?? '') ? x.freezeWeek : y.freezeWeek,
  };
}

/** Есть ли что забрать: выполненное задание или бонус серии. */
export function hasReward(state, day) {
  const st = rollDay(state, day);
  return streakReady(st, day)
    || st.tasks.some((t) => !t.claimed && t.progress >= TASK_BY_ID[t.id].goal);
}
