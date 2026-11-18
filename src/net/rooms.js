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
// Башня: бой без рейтинга на высокой арене с тросом. Вторая буква «W»
// после «Z» — и хозяин, и гость по ссылке получают одну и ту же карту и
// правила, ни о чём не договариваясь. Для сервера это обычная комната
// без рейтинга.
export const TOWER_PREFIX = 'ZW';
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Первая буква обычной комнаты — не Z (бои без рейтинга) и не T (турниры)
const ABC_NO_Z = ABC.replace('Z', '').replace('T', '');

/** Комната турнирного матча: их коды выдаёт сервер, все начинаются на «T». */
export function isTournamentRoom(room) {
  return String(room ?? '').toUpperCase().startsWith('T');
}

/** Комната боя без рейтинга? */
export function isCasualRoom(room) {
  return String(room ?? '').toUpperCase().startsWith(CASUAL_PREFIX);
}

/** Комната боя на башне? */
export function isTowerRoom(room) {
  return String(room ?? '').toUpperCase().startsWith(TOWER_PREFIX);
}

/** Очередь по коду комнаты: rated | casual. */
export function queueOf(room) {
  return isCasualRoom(room) ? 'casual' : 'rated';
}

/**
 * Случайный код из шести знаков. Рейтинговый никогда не начинается с «Z»
 * или «T», иначе случайно оказался бы боем без рейтинга или турнирным.
 */
export function randomRoom(casual = false, tower = false) {
  const pick = (abc) => abc[Math.floor(Math.random() * abc.length)];
  let out = tower ? TOWER_PREFIX : casual ? CASUAL_PREFIX : pick(ABC_NO_Z);
  // Обычная комната без рейтинга не должна случайно оказаться башней
  if (casual && !tower) out += pick(ABC.replace('W', ''));
  while (out.length < 6) out += pick(ABC);
  return out;
}
