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
    rules: {
      turnTime: 25, hook: 3, crateChance: 0.3, bounce: 0.5, roll: 0.7,
      flood: { after: 8, step: 85 },
    },
  };
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
    boss: Boolean(m.boss),
    bossHp: m.bossHp ?? null,
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
