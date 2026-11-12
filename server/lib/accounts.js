/**
 * Токены входа. Вход в игру — только через Telegram (подпись initData),
 * после проверки сервер выдаёт токен: случайные 32 байта. В базе лежит лишь
 * его SHA-256, так что утёкшая база не даёт войти ни под кем.
 */
import { randomBytes, createHash } from 'node:crypto';

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}
