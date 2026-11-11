/**
 * Аккаунты: проверка ника и пароля, хэш пароля, токены входа.
 *
 * Регистрация намеренно простая — ник и пароль, без почты и подтверждений.
 * Пароль хранится только как scrypt с солью; токен входа — случайные
 * 32 байта, в базе лежит лишь его SHA-256, так что утёкшая база не даёт
 * войти ни под кем.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const KEYLEN = 32;
// N=2^14 — стандарт для интерактивного входа: ~50 мс на проверку
const PARAMS = { N: 16384, r: 8, p: 1 };

export const NAME_MIN = 3;
export const NAME_MAX = 20;
export const PASS_MIN = 4;
export const PASS_MAX = 100;

/** Ник: буквы любого алфавита, цифры, пробел, _ . - ; пробелы схлопнуты. */
export function cleanName(raw) {
  const name = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name.length < NAME_MIN) return { error: `ник короче ${NAME_MIN} символов` };
  if (name.length > NAME_MAX) return { error: `ник длиннее ${NAME_MAX} символов` };
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) return { error: 'в нике только буквы, цифры, пробел, _ . -' };
  return { name, key: name.toLowerCase() };
}

export function checkPassword(raw) {
  const pass = String(raw ?? '');
  if (pass.length < PASS_MIN) return { error: `пароль короче ${PASS_MIN} символов` };
  if (pass.length > PASS_MAX) return { error: 'слишком длинный пароль' };
  return { pass };
}

/** scrypt$N$r$p$соль$хэш — параметры внутри, чтобы их можно было поднять. */
export async function hashPassword(pass) {
  const salt = randomBytes(16);
  const hash = await scrypt(pass, salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(pass, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, want] = parts;
  const expected = Buffer.from(want, 'base64');
  const got = await scrypt(pass, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Хэш-заглушка: вход под несуществующим ником стоит столько же времени. */
export const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function newPlayerId() {
  return `u${randomBytes(5).toString('hex')}`;
}
