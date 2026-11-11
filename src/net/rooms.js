/**
 * Коды комнат и режим боя.
 *
 * Режим зашит в сам код: бой без рейтинга — комната на «Z». Так его знают
 * все, у кого есть код, — и хозяин, и гость по ссылке, и тот, кто вбил код
 * руками, — и сервер рейтинга, который такой бой не засчитает, что бы ни
 * прислал клиент. Договариваться о режиме отдельным сообщением не нужно.
 *
 * То же правило — в server/lib/rooms.js (сервер не видит src/); тест
 * tests/match.mjs сверяет, что они согласны.
 */

export const CASUAL_PREFIX = 'Z';
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ABC_NO_Z = ABC.replace('Z', '');

/** Комната боя без рейтинга? */
export function isCasualRoom(room) {
  return String(room ?? '').toUpperCase().startsWith(CASUAL_PREFIX);
}

/** Очередь по коду комнаты: rated | casual. */
export function queueOf(room) {
  return isCasualRoom(room) ? 'casual' : 'rated';
}

/**
 * Случайный код из шести знаков. Рейтинговый никогда не начинается с «Z»,
 * иначе случайно оказался бы боем без рейтинга.
 */
export function randomRoom(casual = false) {
  const pick = (abc) => abc[Math.floor(Math.random() * abc.length)];
  let out = casual ? CASUAL_PREFIX : pick(ABC_NO_Z);
  for (let i = 1; i < 6; i++) out += pick(ABC);
  return out;
}
