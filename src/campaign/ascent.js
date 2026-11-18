/**
 * Кампания «Подъём»: пятнадцать боёв на башне, три главы по пять.
 *
 *   Подножие — обычная башня: слизни, кактусы, гиря; в конце — Великан;
 *   Ледник   — ледяная: скользко, липкая бомба, батут; снова Великан;
 *   Жерло    — лавовая: лава поднимается, нашествие слизней; финальный
 *              Великан покрепче.
 *
 * Бой — данные, как испытание: зерно (одна башня у всех), вид башни,
 * стороны, правила, монстры. Победа — выбить всех бойцов соперника, а где
 * есть Великан — повалить Великана (его бойцы ему не нужны). Бой
 * открывается после победы в предыдущем. Коробки со скинами — за первый,
 * дальше через один и за последний (core/skins.js, rewardMissions).
 *
 * monsters: { slime, cactus } — сколько каких рассадить по этажам (места
 * выбираются от зерна, у всех одинаково); boss: true — Великан на вершине.
 * rules.ammo — патроны нового оружия, чтобы бой учил ему.
 */

const base = { turnTime: 35, hook: 3, crateChance: 0.25, bounce: 0.5, roll: 0.7 };

const human = (n) => ({ worms: n, control: 'human' });
const bot = (n, level) => ({ worms: n, control: 'bot', level });

export const CHAPTERS = [
  { id: 'foot', title: 'Подножие', variant: 'classic' },
  { id: 'glacier', title: 'Ледник', variant: 'ice' },
  { id: 'crater', title: 'Жерло', variant: 'lava' },
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
    id: 'up-10', chapter: 'glacier', title: 'Ледяной Великан', seed: 12005, boss: true,
    brief: 'Великан вернулся, и с ним ветер. Бери поправку.',
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
    id: 'up-15', chapter: 'crater', title: 'Вершина', seed: 13005, boss: true, bossHp: 520,
    brief: 'Финал: Великан на вершине жерла, лава уже идёт. Повали его, пока не поздно.',
    teams: [human(3)], monsters: { slime: 2, cactus: 2 },
    rules: { ...base, flood: { after: 6, step: 80 }, ammo: { weight: 3, sticky: 3, spring: 2 } },
  },
];

export const ASCENT_BY_ID = Object.fromEntries(ASCENT.map((m) => [m.id, m]));

export const chapterOf = (m) => CHAPTERS.find((c) => c.id === m.chapter);

/** Открыт ли бой: первый всегда, дальше — после победы в предыдущем. */
export function ascentOpen(index, done) {
  return index === 0 || done.has(ASCENT[index - 1].id);
}
