import { loggedIn, createDuel, prepareDuelChallenge } from './server.js';
import { copyText } from './transport.js';
import { inTelegram, shareMessage, shareLink, duelLink } from '../platform/telegram.js';

/**
 * Одно приглашение на всё: шахматная партия. Позвал — и ушёл: друг
 * открывает карточку когда угодно и ходит первым, бот пишет «твой ход».
 * Новичку по такой ссылке — коробка, как по реферальной (server/shop.mjs).
 */
export const CHESS_SHARE_TEXT = 'Зову на шахматную партию в Smiles ♟ Ходим по очереди, когда удобно — твой ход первый';

/** Отправить вызов-ссылку: карточкой в Telegram, иначе ссылкой, иначе в буфер. @returns {Promise<boolean>} */
export async function shareChessInvite(code) {
  const link = duelLink(code);
  if (inTelegram()) {
    const id = await prepareDuelChallenge(code, link);
    if (shareMessage(id)) return true;
  }
  if (shareLink(link, CHESS_SHARE_TEXT)) return true;
  copyText(link);
  return false;
}

/**
 * Позвать на шахматную партию: незанятый вызов (у игрока он один) и
 * карточка в выбор чата. Без входа партии нет — вернёт null.
 * @returns {Promise<{duel: object, shared: boolean} | null>}
 */
export async function inviteToChess() {
  if (!loggedIn()) return null;
  const duel = await createDuel({ link: true, theyFirst: true });
  const shared = await shareChessInvite(duel.code);
  return { duel, shared };
}
