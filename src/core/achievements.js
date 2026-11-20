/**
 * Достижения — правила без хранилища (хранит platform/achievements.js).
 *
 * Зачем: монеты, уровень и рейтинг отвечают на «сколько», а достижения — на
 * «как». Добил врага, вися на тросе, сбросил битой в воду, выиграл на
 * последних пяти очках — это и есть те моменты, ради которых играют, и
 * пусть они не пропадают молча. Плюс длинные цели (сто побед, все скины),
 * к которым видно, сколько осталось.
 *
 * Каждое достижение — счётчик (stat) и порог (target). Счётчики двух видов:
 *   • накопительные — победы, добитые, трюки: бой прибавляет к ним;
 *   • «лучшее» — уровень, серия дней, собранные скины: их снимают с
 *     прогресса игры как есть и держат максимум.
 * Порог взят — достижение открыто навсегда, награда выдаётся один раз, в
 * этот момент (как подарок за уровень: без кнопки «забрать»).
 *
 * Трюки ловит бой (GameScene): что было при выстреле и что из него вышло
 * сводится в итог выстрела (shotStats), конец боя — в battleEndStats. Здесь
 * только правила: что из этого засчитывается.
 *
 * Все функции чистые.
 */
import { SKINS } from './skins.js';
import { COSMETICS, KINDS } from './cosmetics.js';
import { CHALLENGES } from '../campaign/challenges.js';
import { ASCENT, CHAPTERS } from '../campaign/ascent.js';

/** Группы витрины — в этом порядке. */
export const GROUPS = [
  { id: 'tricks', title: 'Трюки', hint: 'красивые ходы в бою' },
  { id: 'milestones', title: 'Вехи', hint: 'победы, серии дней, главы и уровни' },
  { id: 'collection', title: 'Коллекция', hint: 'скины, украшения и друзья' },
];

/** «Через полкарты»: попадание дальше этой доли большей стороны мира. */
export const LONG_SHOT = 0.5;
/** «На волоске»: победил последним бойцом, у которого здоровья не больше. */
export const LAST_STAND_HP = 10;
/** «Блиц»: победа не больше чем за столько своих ходов. */
export const BLITZ_TURNS = 3;

const COS_TOTAL = KINDS.reduce((a, k) => a + COSMETICS[k].length, 0);

/**
 * Таблица. icon — эмодзи из assets/emoji (emoji_<имя>); coins и boxes —
 * награда. Чем реже случается, тем щедрее; коробка — за самые редкие.
 */
export const ACHIEVEMENTS = [
  // --- трюки: ловит бой ---
  { id: 'rope_kill', group: 'tricks', icon: 'dash', title: 'Человек-паук',
    desc: 'Добей врага выстрелом, вися на тросе', stat: 'rope_kill', target: 1, coins: 200 },
  { id: 'double_kill', group: 'tricks', icon: 'fire', title: 'Дуплет',
    desc: 'Добей двоих врагов одним выстрелом', stat: 'double_kill', target: 1, coins: 200 },
  { id: 'triple', group: 'tricks', icon: 'boom', title: 'Тройной',
    desc: 'Задень троих врагов одним выстрелом', stat: 'triple', target: 1, coins: 250, boxes: 1 },
  { id: 'drown', group: 'tricks', icon: 'cyclone', title: 'Купальщик',
    desc: 'Сбрось 10 врагов в воду или за край', stat: 'drown', target: 10, coins: 250 },
  { id: 'homerun', group: 'tricks', icon: 'comet', title: 'Хоумран',
    desc: 'Отправь врага в воду битой', stat: 'homerun', target: 1, coins: 200 },
  { id: 'boomerang_back', group: 'tricks', icon: 'moon', title: 'Возвращается!',
    desc: 'Задень врага бумерангом на обратном пути', stat: 'boomerang_back', target: 1, coins: 150 },
  { id: 'homing_kill', group: 'tricks', icon: 'rocket', title: 'Не уйдёшь',
    desc: 'Добей врага самонаводкой', stat: 'homing_kill', target: 1, coins: 150 },
  { id: 'long_shot', group: 'tricks', icon: 'satellite', title: 'Снайпер',
    desc: 'Попади во врага через полкарты', stat: 'long_shot', target: 1, coins: 200 },
  { id: 'spring_shot', group: 'tricks', icon: 'ufo', title: 'С батута',
    desc: 'Попади во врага в полёте после батута', stat: 'spring_shot', target: 1, coins: 250, boxes: 1 },
  { id: 'flawless', group: 'tricks', icon: 'gem', title: 'Ни царапины',
    desc: 'Победи, не потеряв ни капли здоровья', stat: 'flawless', target: 1, coins: 300 },
  { id: 'last_stand', group: 'tricks', icon: 'skull', title: 'На волоске',
    desc: `Победи последним бойцом, у которого 1–${LAST_STAND_HP} здоровья`, stat: 'last_stand', target: 1,
    coins: 300, boxes: 1 },
  { id: 'blitz', group: 'tricks', icon: 'zap', title: 'Блиц',
    desc: `Победи за ${BLITZ_TURNS} своих хода или быстрее`, stat: 'blitz', target: 1, coins: 200 },

  // --- вехи ---
  { id: 'wins_1', group: 'milestones', icon: 'star', title: 'Первая победа',
    desc: 'Победи в бою', stat: 'wins', target: 1, coins: 50 },
  { id: 'wins_10', group: 'milestones', icon: 'sparkles', title: 'Боец',
    desc: 'Победи 10 раз', stat: 'wins', target: 10, coins: 150 },
  { id: 'wins_50', group: 'milestones', icon: 'planet', title: 'Ветеран',
    desc: 'Победи 50 раз', stat: 'wins', target: 50, coins: 400 },
  { id: 'wins_100', group: 'milestones', icon: 'crown', title: 'Легенда башни',
    desc: 'Победи 100 раз', stat: 'wins', target: 100, coins: 800, boxes: 1 },
  { id: 'kills_50', group: 'milestones', icon: 'headstone', title: 'Гроза смайликов',
    desc: 'Добей 50 врагов', stat: 'kills', target: 50, coins: 300 },
  { id: 'streak_7', group: 'milestones', icon: 'sun', title: 'Неделя в строю',
    desc: 'Заходи 7 дней подряд', stat: 'streak', target: 7, coins: 200 },
  { id: 'streak_30', group: 'milestones', icon: 'sunflower', title: 'Месяц в строю',
    desc: 'Заходи 30 дней подряд', stat: 'streak', target: 30, coins: 600, boxes: 1 },
  { id: 'ascent_1', group: 'milestones', icon: 'mountain', title: 'Подножие взято',
    desc: 'Пройди главу «Подъёма»', stat: 'ascent', target: 1, coins: 200 },
  { id: 'ascent_all', group: 'milestones', icon: 'volcano', title: 'На вершине',
    desc: 'Пройди все главы «Подъёма»', stat: 'ascent', target: CHAPTERS.length, coins: 800, boxes: 1 },
  { id: 'stars_all', group: 'milestones', icon: 'snowflake', title: 'Звездочёт',
    desc: 'Пройди все испытания на три звезды', stat: 'stars3', target: CHALLENGES.length, coins: 600, boxes: 1 },
  { id: 'level_10', group: 'milestones', icon: 'pine', title: 'Десятый уровень',
    desc: 'Дойди до 10-го уровня', stat: 'level', target: 10, coins: 200 },
  { id: 'level_20', group: 'milestones', icon: 'tree', title: 'Двадцатый уровень',
    desc: 'Дойди до 20-го уровня', stat: 'level', target: 20, coins: 500 },

  // --- коллекция ---
  { id: 'skins_5', group: 'collection', icon: 'box', title: 'Гардероб',
    desc: 'Собери 5 скинов', stat: 'skins', target: 5, coins: 100 },
  { id: 'skins_10', group: 'collection', icon: 'cactus', title: 'Костюмер',
    desc: 'Собери 10 скинов', stat: 'skins', target: 10, coins: 250 },
  { id: 'skins_all', group: 'collection', icon: 'ogre', title: 'Все лица',
    desc: 'Собери все скины', stat: 'skins', target: SKINS.length, coins: 1000 },
  { id: 'cos_all', group: 'collection', icon: 'blossom', title: 'Модник',
    desc: 'Собери все украшения: тросы, следы и надгробия', stat: 'cos', target: COS_TOTAL, coins: 500 },
  { id: 'promo', group: 'collection', icon: 'mushroom', title: 'Секретный код',
    desc: 'Активируй промокод', stat: 'promo', target: 1, coins: 50 },
  { id: 'friend', group: 'collection', icon: 'herb', title: 'Своя компания',
    desc: 'Позови друга — и он зайдёт по твоей ссылке', stat: 'invited', target: 1, coins: 200 },
];

export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
/** Все счётчики, какие бывают: остальное из хранилища выбрасывается. */
export const STATS = [...new Set(ACHIEVEMENTS.map((a) => a.stat))];

export function emptyAch() {
  return { got: {}, n: {} };
}

const int = (v) => Math.max(0, Math.floor(Number(v) || 0));

/** Привести что угодно из хранилища к правильному состоянию. */
export function normalizeAch(raw) {
  const st = emptyAch();
  if (!raw || typeof raw !== 'object') return st;
  for (const [id, at] of Object.entries(raw.got ?? {})) {
    // Время открытия — для подписи на витрине; без него (старая копия) — 1
    if (ACH_BY_ID[id]) st.got[id] = Math.max(1, int(at));
  }
  for (const k of STATS) {
    const v = int(raw.n?.[k]);
    if (v) st.n[k] = v;
  }
  return st;
}

/**
 * Две копии (устройство и облако): открытые — объединение, с более ранней
 * датой; счётчики — по большей копии. Награды за открытое на другом
 * телефоне уже лежат в его кошельке — второй раз их не выдаём.
 */
export function mergeAch(a, b) {
  const x = normalizeAch(a), y = normalizeAch(b);
  const got = { ...x.got };
  for (const [id, at] of Object.entries(y.got)) got[id] = got[id] ? Math.min(got[id], at) : at;
  const n = { ...x.n };
  for (const [k, v] of Object.entries(y.n)) n[k] = Math.max(n[k] ?? 0, v);
  return { got, n };
}

/**
 * Сдвинуть счётчики и открыть то, что набрало порог.
 * @param add  { счётчик: сколько прибавить } — победы, трюки боя
 * @param best { счётчик: значение } — снятое с прогресса (уровень, скины):
 *             держим максимум, убавиться оно не может
 * @returns {{state, unlocked: string[]}} unlocked — открытые этим вызовом, по порядку таблицы
 */
export function addStats(state, add = {}, best = {}, now = Date.now()) {
  const st = normalizeAch(state);
  const n = { ...st.n };
  for (const [k, v] of Object.entries(add)) if (STATS.includes(k) && int(v)) n[k] = (n[k] ?? 0) + int(v);
  for (const [k, v] of Object.entries(best)) if (STATS.includes(k) && int(v) > (n[k] ?? 0)) n[k] = int(v);
  const got = { ...st.got };
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (got[a.id] || (n[a.stat] ?? 0) < a.target) continue;
    got[a.id] = Math.max(1, int(now));
    unlocked.push(a.id);
  }
  return { state: { got, n }, unlocked };
}

/** Где игрок по достижению: { n, target, done, at } — n не больше порога. */
export function progressOf(state, a) {
  const at = state.got?.[a.id] ?? 0;
  return { n: Math.min(a.target, state.n?.[a.stat] ?? 0), target: a.target, done: Boolean(at), at };
}

/** Попадание «через полкарты»: дальше доли LONG_SHOT от большей стороны мира. */
export function isLongShot(dist, worldW, worldH) {
  return dist >= LONG_SHOT * Math.max(worldW, worldH);
}

/**
 * Итог одного своего выстрела — в трюки.
 * @param {object} s
 * @param {string}  s.weapon id оружия
 * @param {boolean} s.hang   стрелял, вися на тросе
 * @param {boolean} s.sprung стрелял в полёте после батута
 * @param {number}  s.hits   скольких разных врагов задел
 * @param {number}  s.kills  скольких добил этим выстрелом (пока ход не отыгран)
 * @param {number}  s.drowns скольких из них — в воду или за край
 * @param {boolean} s.far    задел врага через полкарты (isLongShot)
 * @param {boolean} s.back   бумеранг задел врага на обратном пути
 * @returns {object} { счётчик: сколько прибавить }
 */
export function shotStats(s = {}) {
  const hits = int(s.hits), kills = int(s.kills), drowns = int(s.drowns);
  const out = {};
  if (kills && s.hang) out.rope_kill = 1;
  if (kills >= 2) out.double_kill = 1;
  if (hits >= 3) out.triple = 1;
  if (drowns) out.drown = drowns;
  if (drowns && s.weapon === 'bat') out.homerun = 1;
  if (s.back) out.boomerang_back = 1;
  if (kills && s.weapon === 'homing') out.homing_kill = 1;
  if (s.far) out.long_shot = 1;
  if (hits && s.sprung) out.spring_shot = 1;
  return out;
}

/**
 * Итог боя — в вехи и трюки конца боя.
 * Испытания — головоломки с готовым решением в один-два хода: победа в них
 * не идёт ни в счёт побед, ни в «Блиц» и «Ни царапины».
 * @param {object} r
 * @param {boolean} r.won     победил этот игрок
 * @param {string}  r.mode    режим партии
 * @param {number}  r.myTurns своих ходов за бой
 * @param {boolean} r.hurt    своим бойцам за бой досталось хоть раз
 * @param {Array<{alive:boolean, health:number}>} r.mine свои бойцы в конце
 * @param {number}  r.kills   добито врагов за бой
 * @returns {object} { счётчик: сколько прибавить }
 */
export function battleEndStats({ won = false, mode = '', myTurns = 0, hurt = true, mine = [], kills = 0 } = {}) {
  const out = {};
  if (int(kills)) out.kills = int(kills);
  if (!won || mode === 'challenge') return out;
  out.wins = 1;
  const alive = mine.filter((w) => w.alive);
  if (!hurt && alive.length === mine.length) out.flawless = 1;
  if (alive.length === 1 && alive[0].health >= 1 && alive[0].health <= LAST_STAND_HP) out.last_stand = 1;
  if (myTurns > 0 && myTurns <= BLITZ_TURNS) out.blitz = 1;
  return out;
}

/**
 * Снять «лучшие» счётчики с прогресса игры.
 * @param {object} p
 * @param {number} p.level     уровень игрока
 * @param {number} p.streak    серия дней сейчас
 * @param {string[]} p.skins   собранные скины
 * @param {object} p.cos       собранные украшения: { rope: [...], trail: [...], grave: [...] }
 * @param {Iterable<string>} p.ascent пройденные бои «Подъёма»
 * @param {object} p.stars     звёзды испытаний: { id: 0..3 }
 * @returns {object} { счётчик: значение }
 */
export function progressStats({ level = 1, streak = 0, skins = [], cos = {}, ascent = [], stars = {} } = {}) {
  const done = new Set(ascent);
  const chapters = CHAPTERS.filter((ch) => ASCENT.filter((m) => m.chapter === ch.id).every((m) => done.has(m.id)));
  const known = new Set(SKINS.map((s) => s.id));
  return {
    level: int(level),
    streak: int(streak),
    skins: new Set(skins.filter((id) => known.has(id))).size,
    cos: KINDS.reduce((a, k) => a + new Set((cos[k] ?? []).filter((id) => COSMETICS[k].some((x) => x.id === id))).size, 0),
    ascent: chapters.length,
    stars3: CHALLENGES.filter((c) => (stars[c.id] ?? 0) >= 3).length,
  };
}
