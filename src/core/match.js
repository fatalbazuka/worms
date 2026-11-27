import { MISSION_BY_ID } from '../campaign/missions.js';
import { CHALLENGE_BY_ID } from '../campaign/challenges.js';
import { ASCENT_BY_ID, chapterOf } from '../campaign/ascent.js';
import { isTowerRoom } from '../net/rooms.js';

/**
 * Описание партии: что именно строить сцене.
 *
 * Меню кладёт такой объект в registry, сцена его читает. Прямой заход по
 * адресу (или тест) описания не даёт — тогда берётся обычный хотсит, ровно
 * как было до всяких меню.
 */

export const HOTSEAT = {
  mode: 'quick',
  teams: [
    { worms: 2, control: 'human' },
    { worms: 2, control: 'human' },
  ],
  rules: {},
};

/**
 * Быстрая игра: случайная карта, соперник — человек рядом или бот.
 *
 * opts — настройки из меню: worms (бойцов в команде), turnTime (секунд на
 * ход), shape (форма карты или 'random'). Без них — как раньше: 2 на 2,
 * 30 секунд, форма от зерна.
 */
export function quickMatch(botLevel = null, opts = {}) {
  const worms = Math.max(1, Math.min(4, Number(opts.worms) || 2));
  const rules = {};
  if (Number(opts.turnTime) > 0) rules.turnTime = Number(opts.turnTime);
  return {
    mode: 'quick',
    teams: [
      { worms, control: 'human' },
      botLevel
        ? { worms, control: 'bot', level: botLevel }
        : { worms, control: 'human' },
    ],
    rules,
    ...(opts.shape && opts.shape !== 'random' ? { shape: opts.shape } : {}),
  };
}

/**
 * Башня: высокая арена, крюк-трос, короткий ход. Соперник — бот или
 * человек рядом. Играется в любой ориентации телефона.
 */
export function towerMatch(botLevel = null) {
  return {
    mode: 'quick',
    shape: 'tower',
    teams: [
      { worms: 2, control: 'human' },
      botLevel
        ? { worms: 2, control: 'bot', level: botLevel }
        : { worms: 2, control: 'human' },
    ],
    // bounce и roll — граната на тесных этажах прыгает и катится вдвое слабее
    // flood — с 9-го хода вода каждый ход поднимается на 85 px: бой сам
    // сжимается к верхним этажам и кончается за несколько минут
    // tactics — тактические правила (GameScene): трос один и запас шагов
    // на ход, ракета вплотную не взводится, прямое попадание сильнее,
    // отброс слабее, отход после выстрела, «Окопаться», честный первый ход
    rules: {
      turnTime: 25, hook: 1, walk: 260, tactics: true, crateChance: 0.3, bounce: 0.5, roll: 0.7,
      flood: { after: 8, step: 85 },
    },
  };
}

/**
 * Секретный режим «Вечеринка»: 3–4 команды на одной башне, каждая —
 * человек (по очереди на одном телефоне) или бот. Спрятан от обычного
 * меню (вход — пять тапов по заголовку «Режимы»), рейтинг не трогает.
 * seats — по месту на команду: 'human' или уровень бота ('rookie'…).
 * Вода поднимается позже: на круг уходит больше ходов, чем вдвоём.
 */
export function partyMatch(seats = ['human', 'human', 'human']) {
  const n = Math.max(3, Math.min(4, seats.length));
  const m = towerMatch(null);
  return {
    ...m,
    party: true,
    teams: seats.slice(0, n).map((s) => (s === 'human'
      ? { worms: 2, control: 'human' }
      : { worms: 2, control: 'bot', level: s })),
    rules: { ...m.rules, flood: { after: 4 * n, step: 85 } },
  };
}

/**
 * Первые бои новичка: спокойная классическая башня, вода поднимается
 * позже обычного. Случайный вариант
 * (лава с извержением, лёд, ветер) в первом же бою путал: победа приходила
 * от стихии, а не от выстрела.
 */
export function rookieMatch() {
  const m = towerMatch('rookie');
  // Вода — позже (с 15-го хода): первые бои должны решаться выстрелами.
  // Слепые игроки побеждали, потому что соперник тонул сам, и не понимали за что
  return { ...m, variant: 'classic', rules: { ...m.rules, flood: { after: 14, step: 85 } } };
}

/** Обучение: «Первый выстрел» без потопа — мишень не должна утонуть сама. */
export function tutorialMatch() {
  const m = challengeMatch('first');
  // Правила — как в бою на башне (тактика): тренировка учит тому, во что потом играть
  return { ...m, tutorial: true, rules: { ...m.rules, flood: null, tactics: true, hook: 1, walk: 260 } };
}

/** Варианты настроек быстрой игры — для меню и проверки сохранённых. */
export const QUICK_OPTIONS = {
  worms: [2, 3, 4, 1],
  turnTime: [30, 45, 60, 20],
};

/** Миссия кампании: карта, стороны и особые условия из описания миссии. */
export function campaignMatch(missionId) {
  const m = MISSION_BY_ID[missionId];
  if (!m) return quickMatch(null);
  return {
    mode: 'campaign',
    missionId: m.id,
    seed: m.seed,
    biome: m.biome,
    shape: m.shape ?? 'island',
    teams: m.teams.map((t) => ({ ...t })),
    rules: { ...m.rules },
  };
}

/** Испытание на башне: его зерно, вид башни, стороны и правила. */
/** Зерно «Башни дня» из строки YYYY-MM-DD. То же — dailySeed в server/dailytower.mjs. */
export function dailySeed(day) {
  let h = 2166136261;
  for (const ch of `daily:${day}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 900000 + 100000;
}

/**
 * «Башня дня»: одна башня на всех на сутки — двое против двух «Бойцов», два
 * слизня и кактус. Вид башни — от зерна. Итог (ходы, здоровье) уходит в
 * таблицу дня на сервер.
 */
export function dailyMatch(day) {
  return {
    mode: 'daily',
    day,
    seed: dailySeed(day),
    shape: 'tower',
    teams: [{ worms: 2, control: 'human' }, { worms: 2, control: 'bot', level: 'fighter' }],
    rules: { turnTime: 35, hook: 3, crateChance: 0.25, bounce: 0.5, roll: 0.7, flood: { after: 8, step: 85 } },
    monsters: { slime: 2, cactus: 1 },
    boss: false,
  };
}

/** Бой кампании «Подъём»: башня главы, монстры, Великан в конце главы. */
export function ascentMatch(id) {
  const m = ASCENT_BY_ID[id];
  if (!m) return towerMatch('rookie');
  return {
    mode: 'ascent',
    ascentId: m.id,
    seed: m.seed,
    shape: 'tower',
    variant: chapterOf(m).variant,
    teams: m.teams.map((t) => ({ ...t })),
    rules: { flood: { after: 9, step: 85 }, ...m.rules },
    monsters: { ...(m.monsters ?? {}) },
    boss: m.boss === true ? true : (m.boss || false),
    bossHp: m.bossHp ?? null,
    // null — по виду башни (entities/Affixes.js, DEFAULT_AFFIXES)
    affixes: m.affixes ?? null,
  };
}

export function challengeMatch(id) {
  const c = CHALLENGE_BY_ID[id];
  if (!c) return towerMatch('rookie');
  return {
    mode: 'challenge',
    challengeId: c.id,
    seed: c.seed,
    shape: 'tower',
    variant: c.variant,
    teams: c.teams.map((t) => ({ ...t })),
    rules: { flood: { after: 8, step: 85 }, ...c.rules },
  };
}

/** Сетевая партия: обе стороны — люди, состав как в обычной быстрой игре. */
export function onlineMatch(room = null) {
  // Все сетевые бои — на башне: и рейтинг, и без рейтинга, и турниры, и
  // с другом по ссылке. Режим по-прежнему зашит в код комнаты, карта — нет.
  // ?map=classic в адресе — прежняя широкая карта: для отладки и для
  // проверки сетевого движка в tests/net.mjs
  const classic = new URLSearchParams(globalThis.location?.search ?? '').get('map') === 'classic';
  if (classic && !isTowerRoom(room)) return { ...HOTSEAT, mode: 'online' };
  return { ...towerMatch(null), mode: 'online' };
}

/**
 * Быстрый бой, где соперник не нашёлся: башня против бота. В рейтинг не
 * идёт — бой с ботом рейтинг не двигает нигде. Игроку это говорится прямо.
 */
export function fallbackMatch() {
  return { ...towerMatch('fighter'), fallback: true };
}

/** Есть ли в партии хоть один бот. */
export function hasBots(match) {
  return match.teams.some((t) => t.control === 'bot');
}
