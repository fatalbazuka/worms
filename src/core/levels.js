/**
 * Уровень игрока и «Дорога наград» — правила без хранилища (хранит
 * platform/levels.js).
 *
 * Зачем: монеты тратятся, рейтинг растёт только от побед, а проигранный бой
 * раньше не давал ничего. Опыт капает за каждый доигранный бой — и за
 * проигрыш тоже, — а на каждом уровне ждёт подарок. Так у игрока всегда
 * есть ближняя цель: «ещё пара боёв — и коробка».
 *
 * Кривая: первые уровни быстрые (второй — уже после обучения), дальше
 * каждый следующий дороже на LEVEL_STEP, пока не упрётся в LEVEL_CAP: после
 * этого уровни идут ровно, примерно по пятнадцать боёв, — и не кончаются.
 *
 * Награды выдаются сами, в момент нового уровня: отдельная кнопка
 * «забрать» здесь лишний шаг — подарок за уровень и так событие, его
 * показывает экран итога боя.
 *
 * Все функции чистые: берут опыт или состояние, возвращают новое.
 */

/** Опыт за бой: что сложить. Числа — в одном месте, чтобы легко крутить. */
export const XP = {
  battle: 20,       // доиграл бой — любой, и проигранный
  win: 20,          // победил (бот или человек; вдвоём на телефоне — нет)
  online: 10,       // бой с живым соперником по сети
  damagePer: 10,    // +1 опыта за каждые столько урона по соперникам…
  damageMax: 15,    // …но не больше стольких
  firstClear: 30,   // первое прохождение миссии или боя «Подъёма»
  firstBoss: 60,    // первое прохождение босса главы
  star: 10,         // за каждую новую звезду испытания
};

/** Сколько опыта до второго уровня; каждый следующий — на LEVEL_STEP дороже. */
export const LEVEL_FIRST = 50;
export const LEVEL_STEP = 30;
/** Дороже этого уровень не бывает: дальше — ровно, без конца. */
export const LEVEL_CAP = 600;

/**
 * Опыт за бой.
 * @param {object} r
 * @param {boolean} r.won        победил ли этот игрок
 * @param {boolean} r.hotseat    вдвоём на одном телефоне: обе стороны — «свои»
 * @param {boolean} r.online     бой по сети с человеком
 * @param {number}  r.damage     урон по соперникам в свои ходы
 * @param {number}  r.firstClear 0 — нет, 1 — первое прохождение, 2 — босс впервые
 * @param {number}  r.stars      сколько новых звёзд испытания добыто
 * @returns {{total:number, parts:Array<[string, number]>}} parts — из чего сложилось
 */
export function battleXp({ won = false, hotseat = false, online = false, damage = 0, firstClear = 0, stars = 0 } = {}) {
  const parts = [['бой', XP.battle]];
  // Вдвоём на одном телефоне победа и урон всегда «свои» — какая бы сторона
  // ни выиграла. Поэтому там только опыт за сам бой: сыграли — молодцы
  if (!hotseat) {
    if (won) parts.push(['победа', XP.win]);
    if (online) parts.push(['с человеком', XP.online]);
    const dmg = Math.min(XP.damageMax, Math.floor(Math.max(0, damage) / XP.damagePer));
    if (dmg > 0) parts.push(['урон', dmg]);
    if (firstClear) parts.push(['первое прохождение', firstClear > 1 ? XP.firstBoss : XP.firstClear]);
    if (stars > 0) parts.push(['звёзды', stars * XP.star]);
  }
  return { total: parts.reduce((a, [, n]) => a + n, 0), parts };
}

/** Сколько опыта нужно, чтобы с уровня level перейти на следующий. */
export function levelCost(level) {
  return Math.min(LEVEL_CAP, LEVEL_FIRST + LEVEL_STEP * (Math.max(1, level) - 1));
}

/** Сколько опыта всего нужно, чтобы стоять на уровне level. */
export function xpForLevel(level) {
  let sum = 0;
  for (let l = 1; l < level; l++) sum += levelCost(l);
  return sum;
}

/**
 * Где игрок: уровень, сколько набрано внутри него и сколько нужно.
 * @returns {{level:number, into:number, need:number, progress:number}}
 */
export function levelOf(xp) {
  let level = 1;
  let rest = Math.max(0, Math.floor(Number(xp) || 0));
  while (rest >= levelCost(level)) { rest -= levelCost(level); level++; }
  const need = levelCost(level);
  return { level, into: rest, need, progress: rest / need };
}

/**
 * Подарки по уровням. coins — монеты, boxes — коробки со скином, cos —
 * украшение (если уже куплено — его цена монетами). big — крупная куча
 * монет, рисуется горкой. Уровни дальше таблицы — по правилу в rewardFor.
 */
export const REWARDS = {
  2: { coins: 50 },
  3: { coins: 75 },
  4: { boxes: 1 },
  5: { cos: { kind: 'rope', id: 'neon' } },
  6: { coins: 100 },
  7: { coins: 100 },
  8: { boxes: 1 },
  9: { cos: { kind: 'trail', id: 'stars' } },
  10: { coins: 300, big: true },
  11: { coins: 120 },
  12: { boxes: 1 },
  13: { cos: { kind: 'grave', id: 'flower' } },
  14: { coins: 120 },
  15: { coins: 400, big: true },
  16: { boxes: 1 },
  17: { cos: { kind: 'rope', id: 'ice' } },
  18: { coins: 150 },
  19: { coins: 150 },
  20: { boxes: 2 },
  21: { cos: { kind: 'trail', id: 'hearts' } },
  22: { coins: 150 },
  23: { coins: 150 },
  24: { boxes: 1 },
  25: { coins: 600, big: true },
  26: { cos: { kind: 'grave', id: 'skull' } },
  27: { coins: 150 },
  28: { boxes: 1 },
  29: { coins: 150 },
  30: { cos: { kind: 'rope', id: 'rainbow' } },
};
export const TABLE_END = 30;

/** Как назвать украшение в подарке: «трос «Неоновый»». */
export const COS_LABEL = { rope: 'трос', trail: 'след снаряда', grave: 'надгробие' };

/**
 * Подарок за уровень level (за первый — ничего: с него начинают).
 * После таблицы: каждый десятый — две коробки, каждый пятый — коробка,
 * остальные — монеты.
 * @returns {{coins?:number, boxes?:number, cos?:{kind:string,id:string}, big?:boolean}|null}
 */
export function rewardFor(level) {
  if (level < 2) return null;
  if (level <= TABLE_END) return REWARDS[level] ?? { coins: 100 };
  if (level % 10 === 0) return { boxes: 2 };
  if (level % 5 === 0) return { boxes: 1 };
  return { coins: 150 };
}

export function emptyLevel() {
  return { xp: 0, rewarded: 1 };
}

/** Привести что угодно из хранилища к правильному состоянию. */
export function normalizeLevel(raw) {
  const st = emptyLevel();
  if (!raw || typeof raw !== 'object') return st;
  st.xp = Math.max(0, Math.floor(Number(raw.xp) || 0));
  // rewarded — последний уровень, за который подарок уже выдан
  st.rewarded = Math.max(1, Math.floor(Number(raw.rewarded) || 1));
  return st;
}

/**
 * Две копии (устройство и облако): опыт — больший, выданные подарки — по
 * большей копии. Подарки, выданные на другом телефоне, уже лежат в его
 * кошельке и коробках — те копии сводятся своими merge*; второй раз их
 * здесь не выдаём.
 */
export function mergeLevel(a, b) {
  const x = normalizeLevel(a), y = normalizeLevel(b);
  return { xp: Math.max(x.xp, y.xp), rewarded: Math.max(x.rewarded, y.rewarded) };
}

/**
 * Прибавить опыт.
 * @returns {{state, before:number, after:number, levels:number[]}} levels — за
 *   какие уровни теперь положены подарки (по порядку)
 */
export function addXp(state, n) {
  const st = normalizeLevel(state);
  const before = levelOf(st.xp).level;
  const xp = st.xp + Math.max(0, Math.floor(Number(n) || 0));
  const after = levelOf(xp).level;
  const levels = [];
  for (let l = st.rewarded + 1; l <= after; l++) levels.push(l);
  return { state: { xp, rewarded: Math.max(st.rewarded, after) }, before, after, levels };
}
