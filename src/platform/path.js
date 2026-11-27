/**
 * «Путь новичка» на главном: четыре шага к тому, ради чего играют, — дуэли,
 * рейтинг и скины. За каждый шаг — монеты или коробка, забирать тапом.
 *
 *   1. tutorial — пройти обучение (коробку за него и так дают);
 *   2. skin     — надеть скин из коробки: +50 монет;
 *   3. duel     — позвать друга на дуэль: +100 монет;
 *   4. rated    — первая победа в рейтинге (дуэль или онлайн): коробка.
 *
 * Всё отмечается по тому, что уже есть на устройстве и в профиле, поэтому
 * шаг засчитывается, как бы игрок до него ни дошёл. Опытному игроку
 * (три победы в рейтинге и больше до появления пути) путь не показываем.
 */
import { challengeStars } from './challenges.js';
import { equippedSkin, grantBoxes } from './skins.js';
import { grantCoins } from './daily.js';
import { player } from './player.js';
import { DEFAULT_SKIN } from '../core/skins.js';

const KEY = 'worms.path.v1';

export const PATH_STEPS = [
  { id: 'tutorial', icon: '🎯', text: 'Пройди обучение', reward: null },
  { id: 'skin', icon: '👕', text: 'Открой коробку и надень скин', reward: { coins: 50 }, action: 'skins' },
  { id: 'duel', icon: '⚔️', text: 'Позови друга на дуэль', reward: { coins: 100 }, action: 'invite' },
  { id: 'rated', icon: '🏆', text: 'Победи в дуэли — получи рейтинг', reward: { boxes: 1 }, action: 'rated' },
];

function read() {
  try { return { claimed: [], ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') || {}) }; } catch { return { claimed: [] }; }
}

function write(st) {
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* инкогнито */ }
}

/** Позвал друга (ссылкой или вызовом) — шаг «дуэль» сделан. */
export function markInvited() {
  const st = read();
  if (st.invited) return;
  write({ ...st, invited: 1 });
}

function isDone(id, ctx, st) {
  switch (id) {
    case 'tutorial': return (challengeStars().first ?? 0) > 0 || Boolean(ctx.pastTutorial);
    case 'skin': return equippedSkin().id !== DEFAULT_SKIN;
    case 'duel': return Boolean(st.invited) || (ctx.duelsLive ?? 0) > 0;
    case 'rated': return (player().wins ?? 0) > 0;
    default: return false;
  }
}

/**
 * Состояние пути. null — путь пройден или не нужен.
 * @param {{duelsLive?:number, pastTutorial?:boolean}} ctx
 * @returns {{steps:{id,icon,text,reward,action,done,claimed}[], current:object, n:number, total:number}|null}
 */
export function pathState(ctx = {}) {
  let st = read();
  if (st.skip) return null;
  // Опытный игрок застал путь уже бывалым — не мешаем
  if (!st.seen) {
    st = { ...st, seen: 1, ...((player().wins ?? 0) >= 3 ? { skip: 1 } : {}) };
    write(st);
    if (st.skip) return null;
  }
  const steps = PATH_STEPS.map((s) => {
    const done = isDone(s.id, ctx, st);
    // Шаг без награды забирать нечего — он закрыт, как только сделан
    return { ...s, done, claimed: st.claimed.includes(s.id) || (done && !s.reward) };
  });
  if (steps.every((s) => s.claimed)) return null;
  // Сначала — то, что сделано и ждёт награды, потом первый несделанный
  const current = steps.find((s) => s.done && !s.claimed) ?? steps.find((s) => !s.done);
  return { steps, current, n: steps.filter((s) => s.claimed).length, total: steps.length };
}

/**
 * Забрать награду за шаг.
 * @returns {{coins?:number, boxes?:number}|null} что выдали
 */
export function claimPath(id, ctx = {}) {
  const st = read();
  const step = PATH_STEPS.find((s) => s.id === id);
  if (!step || st.claimed.includes(id) || !isDone(id, ctx, st)) return null;
  write({ ...st, claimed: [...st.claimed, id] });
  const r = step.reward ?? {};
  if (r.coins) grantCoins(r.coins);
  if (r.boxes) grantBoxes(r.boxes);
  return r;
}
