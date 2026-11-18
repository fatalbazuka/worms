/**
 * Испытания на башне: короткие задачи на три звезды.
 *
 *   ★   — победить;
 *   ★★  — победить не дольше чем за stars.turns своих ходов;
 *   ★★★ — то же, и не потерять ни одного очка здоровья.
 *
 * Каждое учит одному приёму — выстрел, трос, граната, ветер, лёд, лава — и
 * открывается после хотя бы одной звезды в предыдущем. За каждую новую
 * звезду — монеты (STAR_COINS); переиграть ради звёзд можно сколько угодно,
 * монеты даются только за звёзды, которых ещё не было.
 *
 * Испытание — данные: зерно (одна и та же башня у всех), вид башни,
 * стороны, правила партии (match.js) и порог ходов для звёзд.
 * rules.only — какое оружие оставить игроку, остальное убрать.
 */

export const STAR_COINS = 40;

const base = { turnTime: 30, hook: 3, crateChance: 0, bounce: 0.5, roll: 0.7 };

export const CHALLENGES = [
  {
    id: 'first', title: 'Первый выстрел', seed: 1001, variant: 'classic',
    brief: 'Мишень стоит и ждёт. Ветра нет — натяни рогатку и отпусти.',
    teams: [{ worms: 1, control: 'human' }, { worms: 1, control: 'bot', level: 'dummy' }],
    rules: { ...base, wind: 0 }, stars: { turns: 2 },
  },
  {
    id: 'rope', title: 'Достань его', seed: 2027, variant: 'classic',
    brief: 'Мишени далеко. Подтянись тросом поближе — и бей.',
    teams: [{ worms: 1, control: 'human' }, { worms: 2, control: 'bot', level: 'dummy' }],
    rules: { ...base, wind: 0 }, stars: { turns: 3 },
  },
  {
    id: 'grenade', title: 'Только граната', seed: 3141, variant: 'classic',
    brief: 'В руках одни гранаты. Брось так, чтобы она легла рядом с целью.',
    teams: [{ worms: 1, control: 'human' }, { worms: 2, control: 'bot', level: 'dummy' }],
    rules: { ...base, windRange: [-60, 60], only: ['grenade'], ammo: { grenade: 12 } }, stars: { turns: 4 },
  },
  {
    id: 'windy', title: 'Сквозняк', seed: 4242, variant: 'wind',
    brief: 'Ветер сносит снаряды. Смотри на стрелку и бери поправку.',
    teams: [{ worms: 1, control: 'human' }, { worms: 1, control: 'bot', level: 'rookie' }],
    rules: { ...base }, stars: { turns: 3 },
  },
  {
    id: 'ice', title: 'Каток', seed: 5150, variant: 'ice',
    brief: 'На льду от взрыва катятся далеко — столкни их с этажа.',
    teams: [{ worms: 1, control: 'human' }, { worms: 2, control: 'bot', level: 'rookie' }],
    rules: { ...base }, stars: { turns: 4 },
  },
  {
    id: 'lava', title: 'Пол — это лава', seed: 6262, variant: 'lava',
    brief: 'Лава поднимается рано. Бей быстро и держись повыше.',
    teams: [{ worms: 1, control: 'human' }, { worms: 1, control: 'bot', level: 'fighter' }],
    rules: { ...base, flood: { after: 3, step: 110 } }, stars: { turns: 4 },
  },
  {
    id: 'duo', title: 'Один против двоих', seed: 7373, variant: 'classic',
    brief: 'Их двое, ты один. Не подставляйся и выбирай, кого добить первым.',
    teams: [{ worms: 1, control: 'human' }, { worms: 2, control: 'bot', level: 'fighter' }],
    rules: { ...base, crateChance: 0.3 }, stars: { turns: 5 },
  },
  {
    id: 'sniper', title: 'Дуэль со снайпером', seed: 8484, variant: 'classic',
    brief: 'Снайпер почти не промахивается. Успей первым — или спрячься.',
    teams: [{ worms: 1, control: 'human' }, { worms: 1, control: 'bot', level: 'sniper' }],
    rules: { ...base }, stars: { turns: 4 },
  },
  {
    id: 'final', title: 'Последний этаж', seed: 9595, variant: 'lava',
    brief: 'Финал: двое против троих, и лава уже близко.',
    teams: [{ worms: 2, control: 'human' }, { worms: 3, control: 'bot', level: 'fighter' }],
    rules: { ...base, crateChance: 0.3, flood: { after: 6, step: 90 } }, stars: { turns: 7 },
  },
];

export const CHALLENGE_BY_ID = Object.fromEntries(CHALLENGES.map((c) => [c.id, c]));

/** Звёзды за итог боя. myTurns — сколько своих ходов сделано, hpLost — потеряно здоровья. */
export function starsFor(challenge, { won, myTurns, hpLost }) {
  if (!won) return 0;
  if (myTurns > challenge.stars.turns) return 1;
  return hpLost > 0 ? 2 : 3;
}

/** Открыто ли испытание: первое всегда, дальше — после звезды в предыдущем. */
export function challengeOpen(index, best) {
  return index === 0 || (best[CHALLENGES[index - 1].id] ?? 0) > 0;
}

/**
 * Записать результат: лучший итог и монеты только за новые звёзды.
 * @returns {{best, gained:number, coins:number}}
 */
export function recordStars(best, id, stars) {
  const was = best[id] ?? 0;
  if (stars <= was) return { best, gained: 0, coins: 0 };
  return { best: { ...best, [id]: stars }, gained: stars - was, coins: (stars - was) * STAR_COINS };
}

export function totalStars(best) {
  return CHALLENGES.reduce((a, c) => a + (best[c.id] ?? 0), 0);
}
