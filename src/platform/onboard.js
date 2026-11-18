/**
 * Первые шаги новичка: куда ведёт большая «Играть», пока игрок осваивается.
 *
 *   tutorial — ещё ни разу не стрелял: «Играть» запускает испытание
 *              «Первый выстрел» (мишень стоит, ветра нет);
 *   rookie   — стрелять умеет, но ещё не побеждал: бой с ботом «Новичок»;
 *   free     — победил хоть раз или сам выбрал бота: обычный выбор
 *              (по умолчанию «Боец»).
 *
 * Сильный бот в первом же бою — верный проигрыш и закрытая вкладка. Стадия
 * считается из того, что уже лежит на устройстве: звёзд испытаний, счётчика
 * выстрелов из рогатки и отметки о победе. Кто играл до этого правила,
 * обучение заново не проходит: выстрелы из рогатки у него уже есть.
 */
import { challengeStars } from './challenges.js';

const KEY = 'worms.onboard.v1';
const PLAY_KEY = 'worms.play.v1';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') || {}; } catch { return {}; }
}

function num(key) {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}

function hasPlayChoice() {
  try { return localStorage.getItem(PLAY_KEY) !== null; } catch { return false; }
}

/** @returns {'tutorial'|'rookie'|'free'} */
export function onboardStage() {
  if (hasPlayChoice() || read().won) return 'free';
  const shot = (challengeStars().first ?? 0) > 0 || num('worms.slingUses') >= 2;
  return shot ? 'rookie' : 'tutorial';
}

/** Первая победа над ботом или человеком — дальше обычный выбор. */
export function markWon() {
  const st = read();
  if (st.won) return;
  try { localStorage.setItem(KEY, JSON.stringify({ ...st, won: 1 })); } catch { /* инкогнито */ }
}
