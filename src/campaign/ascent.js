/**
 * Кампания «Подъём»: двадцать боёв на башне, четыре главы по пять.
 *
 *   Подножие — обычная башня: слизни, кактусы, гиря; в конце — Великан;
 *   Ледник   — ледяная: скользко, липкая бомба, батут; снова Великан;
 *   Жерло    — лавовая: лава поднимается, нашествие слизней; лавовый голем;
 *   Космос   — тяжесть вдвое слабее, трос тянет дальше, внизу пустота;
 *              Король слизней.
 *
 * Бой — данные, как испытание: зерно (одна башня у всех), вид башни,
 * стороны, правила, монстры. Победа — выбить всех бойцов соперника, а где
 * есть Великан — повалить Великана (его бойцы ему не нужны). Бой
 * открывается после победы в предыдущем. Коробки со скинами — за первый,
 * дальше через один и за последний (core/skins.js, rewardMissions).
 *
 * monsters: { slime, cactus } — сколько каких рассадить по этажам (места
 * выбираются от зерна, у всех одинаково); boss — босс главы на вершине:
 * true (тролль-Великан), 'yeti', 'golem', 'slimeking' (entities/Monster.js).
 * rules.ammo — патроны нового оружия, чтобы бой учил ему.
 */

const base = { turnTime: 35, hook: 3, crateChance: 0.25, bounce: 0.5, roll: 0.7 };

const human = (n) => ({ worms: n, control: 'human' });
const bot = (n, level) => ({ worms: n, control: 'bot', level });

export const CHAPTERS = [
  { id: 'foot', title: 'Подножие', variant: 'classic' },
  { id: 'glacier', title: 'Ледник', variant: 'ice' },
  { id: 'crater', title: 'Жерло', variant: 'lava' },
  { id: 'space', title: 'Космос', variant: 'space' },
];

export const ASCENT = [
  // --- Подножие ---
  {
    id: 'up-1', chapter: 'foot', title: 'Первые ступени', seed: 11001,
    brief: 'По этажам ползут слизни: доползут — лопнут рядом. Бей их, пока далеко.',
    teams: [human(2), bot(2, 'rookie')], monsters: { slime: 2 }, rules: { ...base },
  },
  {
    id: 'up-2', chapter: 'foot', title: 'Колючки', seed: 11002,
    brief: 'Кактусы колются, а подорванные — взрываются. Подорви кактус рядом с врагом.',
    teams: [human(2), bot(2, 'rookie')], monsters: { cactus: 3 }, rules: { ...base },
  },
  {
    id: 'up-3', chapter: 'foot', title: 'Гиря сверху', seed: 11003,
    brief: 'Гиря пробивает этаж и падает на того, кто спрятался под ним.',
    teams: [human(2), bot(2, 'fighter')], monsters: { slime: 1 },
    rules: { ...base, ammo: { weight: 4 } },
  },
  {
    id: 'up-4', chapter: 'foot', title: 'Слизни наступают', seed: 11004,
    brief: 'Их много и они не ждут. Держись выше и не подпускай.',
    teams: [human(2), bot(1, 'fighter')], monsters: { slime: 5 }, rules: { ...base },
  },
  {
    id: 'up-5', chapter: 'foot', title: 'Великан на крыше', seed: 11005, boss: true,
    brief: 'Наверху Великан: кидает камни и зовёт слизней. Повали его.',
    teams: [human(3)], monsters: { cactus: 2 }, rules: { ...base, ammo: { weight: 3 } },
  },
  // --- Ледник ---
  {
    id: 'up-6', chapter: 'glacier', title: 'Скользко', seed: 12001,
    brief: 'Лёд: от взрыва катятся далеко. Столкни их с этажа.',
    teams: [human(2), bot(2, 'fighter')], monsters: { slime: 2 }, rules: { ...base },
  },
  {
    id: 'up-7', chapter: 'glacier', title: 'Липкие дела', seed: 12002,
    brief: 'Липкая бомба прилипает к стене или потолку и рвётся через три секунды.',
    teams: [human(2), bot(2, 'fighter')], monsters: { cactus: 2 },
    rules: { ...base, ammo: { sticky: 4 } },
  },
  {
    id: 'up-8', chapter: 'glacier', title: 'Пружина', seed: 12003,
    brief: 'Батут подбросит на этаж выше — или выкинет врага под удар.',
    teams: [human(2), bot(3, 'rookie')], monsters: { slime: 2 },
    rules: { ...base, ammo: { spring: 3 } },
  },
  {
    id: 'up-9', chapter: 'glacier', title: 'Колючий каток', seed: 12004,
    brief: 'Кактусы на льду. Кто поскользнётся — наколется.',
    teams: [human(2), bot(2, 'sniper')], monsters: { cactus: 4 }, rules: { ...base },
  },
  {
    id: 'up-10', chapter: 'glacier', title: 'Йети', seed: 12005, boss: 'yeti',
    brief: 'На вершине ледника — йети. Его снежок замораживает: кого задело, тот пропустит ход.',
    teams: [human(3)], monsters: { slime: 2, cactus: 1 },
    rules: { ...base, windRange: [-90, 90], ammo: { sticky: 2, spring: 2 } },
  },
  // --- Жерло ---
  {
    id: 'up-11', chapter: 'crater', title: 'Горячо', seed: 13001,
    brief: 'Лава поднимается с пятого хода. Бей быстро.',
    teams: [human(2), bot(2, 'fighter')], monsters: { slime: 2 },
    rules: { ...base, flood: { after: 5, step: 95 } },
  },
  {
    id: 'up-12', chapter: 'crater', title: 'Нашествие', seed: 13002,
    brief: 'Слизней шестеро. Батут и гиря помогут.',
    teams: [human(2), bot(2, 'fighter')], monsters: { slime: 6 },
    rules: { ...base, ammo: { weight: 2, spring: 2 } },
  },
  {
    id: 'up-13', chapter: 'crater', title: 'Снайперы на уступах', seed: 13003,
    brief: 'Снайперы почти не мажут. Прячься под этажами и бей гирей.',
    teams: [human(2), bot(2, 'sniper')], monsters: { cactus: 2 },
    rules: { ...base, ammo: { weight: 3 } },
  },
  {
    id: 'up-14', chapter: 'crater', title: 'Всё сразу', seed: 13004,
    brief: 'Трое на трое, слизни, кактусы и лава. Последняя проверка перед вершиной.',
    teams: [human(3), bot(3, 'fighter')], monsters: { slime: 2, cactus: 2 },
    rules: { ...base, flood: { after: 7, step: 85 }, ammo: { sticky: 2, weight: 2 } },
  },
  {
    id: 'up-15', chapter: 'crater', title: 'Лавовый голем', seed: 13005, boss: 'golem',
    brief: 'На вершине жерла — лавовый голем. Его огненные шары бьют широко, а лава уже идёт.',
    teams: [human(3)], monsters: { slime: 2, cactus: 2 },
    rules: { ...base, flood: { after: 6, step: 80 }, ammo: { weight: 3, sticky: 3, spring: 2 } },
  },
  // --- Космос ---
  {
    id: 'up-16', chapter: 'space', title: 'Невесомость', seed: 14001,
    brief: 'Тяжести почти нет: снаряды летят дальше, прыжки выше. Целься ниже, чем привык.',
    teams: [human(2), bot(2, 'rookie')], monsters: { slime: 2 }, rules: { ...base },
  },
  {
    id: 'up-17', chapter: 'space', title: 'Кристаллы', seed: 14002,
    brief: 'Прячься за кристаллами — они держат удар, пока их не разобьют.',
    teams: [human(2), bot(2, 'fighter')], monsters: { cactus: 2 }, rules: { ...base, ammo: { sticky: 3 } },
  },
  {
    id: 'up-18', chapter: 'space', title: 'Батут до звёзд', seed: 14003,
    brief: 'В невесомости батут подбрасывает на несколько этажей. Не улети в пустоту!',
    teams: [human(2), bot(3, 'rookie')], monsters: { slime: 3 }, rules: { ...base, ammo: { spring: 3 } },
  },
  {
    id: 'up-19', chapter: 'space', title: 'Орбитальная дуэль', seed: 14004,
    brief: 'Снайперы на орбите. Гиря падает медленно, но этаж всё равно пробьёт.',
    teams: [human(2), bot(2, 'sniper')], monsters: { slime: 2, cactus: 1 },
    rules: { ...base, ammo: { weight: 3 } },
  },
  {
    id: 'up-20', chapter: 'space', title: 'Король слизней', seed: 14005, boss: 'slimeking',
    brief: 'Финал: Король слизней плюётся слизью и через ход зовёт подданных. Повали его.',
    teams: [human(3)], monsters: { slime: 2 },
    rules: { ...base, ammo: { weight: 3, sticky: 3, spring: 2 } },
  },
];

/**
 * Аффиксы уровней (entities/Affixes.js): чем дальше в главу, тем их больше.
 * Не указано — по виду башни (метель на льду, извержение в лаве, метеориты
 * в космосе); на Подножии — гроза, кроме первого боя и «Гири».
 */
const LEVEL_AFFIXES = {
  'up-2': ['storm'], 'up-4': ['storm'], 'up-5': ['storm'],
  'up-17': ['gravity'], 'up-18': ['gravity'], 'up-19': ['meteors', 'gravity'], 'up-20': ['gravity', 'meteors'],
  'up-6': ['gust'], 'up-7': ['icicles'], 'up-8': ['gust'], 'up-9': ['gust', 'icicles'], 'up-10': ['icicles'],
  'up-11': ['eruption'], 'up-12': ['vent'], 'up-13': ['vent'], 'up-14': ['eruption', 'vent'], 'up-15': ['vent'],
};
for (const m of ASCENT) m.affixes ??= LEVEL_AFFIXES[m.id] ?? (m.chapter === 'foot' ? [] : null);

const BOSS_NAMES = { yeti: 'Йети', golem: 'Лавовый голем', slimeking: 'Король слизней' };
/** Имя босса боя для меню; null — боя без босса. */
export const bossName = (m) => (m.boss ? BOSS_NAMES[m.boss] ?? 'Великан' : null);

export const ASCENT_BY_ID = Object.fromEntries(ASCENT.map((m) => [m.id, m]));

export const chapterOf = (m) => CHAPTERS.find((c) => c.id === m.chapter);

/** Открыт ли бой: первый всегда, дальше — после победы в предыдущем. */
export function ascentOpen(index, done) {
  return index === 0 || done.has(ASCENT[index - 1].id);
}

// ------------------------------------------------------------- звёзды

/**
 * Звёзды боя, как у испытаний: ★ — победа, ★★ — победа не дольше
 * stars.turns своих ходов, ★★★ — ещё и без потерь бойцов. Порог ходов —
 * у каждого боя свой (stars.turns) — подобран по симуляции
 * (docs/ascent-curve.md); без него — по умолчанию: 8, у босса 10.
 * Переигрывать ради звёзд можно сколько угодно: «Подъём» больше не
 * плоский список, а лестница, к которой возвращаются.
 */
export function ascentStarTurns(m) {
  return m.stars?.turns ?? (m.boss ? 10 : 8);
}

/** @returns {number} 0…3 */
export function ascentStarsFor(m, { won, myTurns, lost }) {
  if (!won) return 0;
  if (myTurns > ascentStarTurns(m)) return 1;
  return lost ? 2 : 3;
}

/** Пройдена ли глава целиком. done — Set пройденных id. */
export function chapterCleared(chapterId, done) {
  return ASCENT.filter((m) => m.chapter === chapterId).every((m) => done.has(m.id));
}
