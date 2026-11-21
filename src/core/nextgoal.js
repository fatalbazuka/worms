import { TASK_BY_ID, BOX_PRICE } from './daily.js';
import { rewardFor, COS_LABEL } from './levels.js';

/**
 * «Что дальше»: одна ближайшая цель после боя и на главном.
 *
 * Монеты, задания, уровни, коробки и достижения есть, но экран итога не
 * говорил, что ближе всего, — и тяги в следующий бой не было. Здесь
 * выбирается одна цель по порядку:
 *   1. награда ждёт: задание выполнено, коробка не открыта, на коробку хватает;
 *   2. задание дня ближе всего к концу: «Попади ещё 2 раза — +60 монет»;
 *   3. уровень в паре боёв: «ещё 1 бой до ур. 6: коробка»;
 *   4. монеты до коробки, если накоплена хотя бы половина;
 *   5. достижение, где больше всего сделано;
 *   6. иначе — уровень, сколько бы ни оставалось.
 *
 * Чистая функция: состояние снаружи (platform/*), проверяется в tests/match.mjs.
 *
 * action — куда ведёт тап: tasks (задания), skins (коробки), road (дорога
 * наград), achievements, battle (просто сыграть ещё).
 */

/** Сколько опыта приносит обычный бой — для «ещё N боёв до уровня». */
export const XP_PER_BATTLE = 40;
/** Уровень показываем раньше коробки и достижений, если до него столько боёв. */
const LEVEL_SOON = 2;

/** 1 раз, 2 раза, 5 раз — русские числа. */
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const TIMES = ['раз', 'раза', 'раз'];

/** Сколько ещё по заданию — по-человечески, от счётчика. */
export function taskLeftText(stat, n) {
  switch (stat) {
    case 'battles': return `Сыграй ещё ${n} ${plural(n, ['бой', 'боя', 'боёв'])}`;
    case 'wins': return `Победи ещё ${n} ${plural(n, TIMES)}`;
    case 'hits': return `Попади ещё ${n} ${plural(n, TIMES)}`;
    case 'damage': return `Нанеси ещё ${n} урона`;
    case 'kills': return `Выбей ещё ${n} ${plural(n, ['бойца', 'бойцов', 'бойцов'])}`;
    case 'hooks': return `Пусти трос ещё ${n} ${plural(n, TIMES)}`;
    case 'crates': return `Подбери ещё ${n} ${plural(n, ['ящик', 'ящика', 'ящиков'])}`;
    case 'grenadeHits': return `Попади гранатой ещё ${n} ${plural(n, TIMES)}`;
    default: return `Ещё ${n}`;
  }
}

/** Подарок за уровень одной строкой: «коробка», «+100 монет», «трос». */
export function rewardWord(r) {
  if (!r) return '';
  if (r.boxes) return r.boxes > 1 ? `коробки ×${r.boxes}` : 'коробка';
  if (r.cos) return COS_LABEL[r.cos.kind] ?? 'украшение';
  if (r.coins) return `+${r.coins} монет`;
  return '';
}

/**
 * @param {object} s
 * @param {{tasks:{id:string,progress:number,claimed:boolean}[], coins:number}} s.daily
 * @param {number} s.boxes        неоткрытых коробок со скином
 * @param {boolean} s.allSkins    скины собраны все — коробки больше не нужны
 * @param {{level:number, into:number, need:number}} s.level
 * @param {{title:string, n:number, target:number, done:boolean, coins?:number, boxes?:number}[]} s.ach
 * @returns {{kind:string, text:string, progress:number, action:string}|null}
 */
export function nextGoal({ daily, boxes = 0, allSkins = false, level = null, ach = [] }) {
  const tasks = (daily?.tasks ?? []).filter((t) => TASK_BY_ID[t.id]);
  const coins = daily?.coins ?? 0;

  // 1. Награда ждёт
  const ready = tasks.filter((t) => !t.claimed && t.progress >= TASK_BY_ID[t.id].goal);
  if (ready.length) {
    const sum = ready.reduce((a, t) => a + TASK_BY_ID[t.id].coins, 0);
    return { kind: 'claim', text: `Задание выполнено — забери +${sum} монет`, progress: 1, action: 'tasks' };
  }
  if (boxes > 0) return { kind: 'box', text: 'Коробка со скином ждёт — открой', progress: 1, action: 'skins' };
  if (!allSkins && coins >= BOX_PRICE) {
    return { kind: 'buy', text: `Хватает на коробку: ${coins} монет`, progress: 1, action: 'skins' };
  }

  // 2. Задание дня, ближе всего к концу
  const open = tasks.filter((t) => !t.claimed && t.progress < TASK_BY_ID[t.id].goal)
    .map((t) => ({ t, def: TASK_BY_ID[t.id], k: t.progress / TASK_BY_ID[t.id].goal }))
    .sort((a, b) => b.k - a.k || a.def.goal - a.t.progress - (b.def.goal - b.t.progress));
  if (open.length) {
    const { t, def, k } = open[0];
    return {
      kind: 'task', text: `${taskLeftText(def.stat, def.goal - t.progress)} — +${def.coins} монет`,
      progress: k, action: 'battle',
    };
  }

  // 3. Уровень в паре боёв
  const lv = level && level.need > 0 ? (() => {
    const left = Math.max(1, level.need - level.into);
    const battles = Math.max(1, Math.ceil(left / XP_PER_BATTLE));
    const gift = rewardWord(rewardFor(level.level + 1));
    return {
      kind: 'level', battles,
      text: `ещё ${battles} ${plural(battles, ['бой', 'боя', 'боёв'])} до ур. ${level.level + 1}${gift ? `: ${gift}` : ''}`,
      progress: level.into / level.need, action: 'road',
    };
  })() : null;
  if (lv && lv.battles <= LEVEL_SOON) return { kind: lv.kind, text: lv.text, progress: lv.progress, action: lv.action };

  // 4. Монеты до коробки — когда больше половины уже есть
  if (!allSkins && coins >= BOX_PRICE / 2) {
    return { kind: 'coins', text: `до коробки ${BOX_PRICE - coins} монет`, progress: coins / BOX_PRICE, action: 'battle' };
  }

  // 5. Достижение, где сделано больше всего
  const near = ach.filter((a) => !a.done && a.n > 0 && a.target > 1)
    .sort((a, b) => b.n / b.target - a.n / a.target)[0];
  if (near) {
    return {
      kind: 'ach', text: `«${near.title}»: ${near.n} из ${near.target}`,
      progress: near.n / near.target, action: 'achievements',
    };
  }

  return lv ? { kind: lv.kind, text: lv.text, progress: lv.progress, action: lv.action } : null;
}
