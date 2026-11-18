/**
 * Токены входа. Вход в игру — через Telegram (подпись initData) или, с
 * сайта, по логину и паролю, которые выдаёт админ (/web в боте),
 * после проверки сервер выдаёт токен: случайные 32 байта. В базе лежит лишь
 * его SHA-256, так что утёкшая база не даёт войти ни под кем.
 */
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Пароль — scrypt с солью: «scrypt$соль$хеш». */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(String(password), salt, 32).toString('base64url');
  return ['scrypt', salt, hash].join('$');
}

export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = scryptSync(String(password), salt, 32);
  const want = Buffer.from(hash, 'base64url');
  return want.length === got.length && timingSafeEqual(got, want);
}

/** Пароль, который удобно продиктовать: 8 знаков без похожих (0/O, 1/l). */
export function newPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}
