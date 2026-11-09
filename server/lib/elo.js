/**
 * Эло на сервере. Та же формула, что и в клиенте (src/platform/player.js):
 * тест tests/server.mjs сверяет их на сетке значений, чтобы предварительный
 * расчёт на экране итога совпадал с тем, что потом подтвердит сервер.
 */

export const START_RATING = 1000;
export const MIN_RATING = 100;
export const K = 24;

/** Сдвиг рейтинга игрока с рейтингом mine против theirs; won — выиграл ли он. */
export function eloDelta(mine, theirs, won) {
  const expected = 1 / (1 + 10 ** ((theirs - mine) / 400));
  return Math.round(K * ((won ? 1 : 0) - expected));
}

/**
 * Итог подтверждённого боя для обоих: победитель получает delta, проигравший
 * теряет столько же (не ниже минимума). Одно число на двоих — иначе суммы
 * рейтинга в таблице расползались бы от округлений.
 */
export function settle(winnerRating, loserRating) {
  const delta = Math.max(1, eloDelta(winnerRating, loserRating, true));
  return {
    delta,
    winner: winnerRating + delta,
    loser: Math.max(MIN_RATING, loserRating - delta),
  };
}
