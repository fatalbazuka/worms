/**
 * Режим боя по коду комнаты — то же правило, что в src/net/rooms.js:
 * комната на «Z» — бой без рейтинга, сервер его не засчитывает.
 */
export const CASUAL_PREFIX = 'Z';

export function isCasualRoom(room) {
  return String(room ?? '').toUpperCase().startsWith(CASUAL_PREFIX);
}
