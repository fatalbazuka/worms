/**
 * Облачная копия прогресса: облако Telegram и сервер игры.
 *
 * В Telegram прогресс лежит в его облаке (CloudStorage) и копией на нашем
 * сервере; с сайта по логину — только на сервере. Читаем оба, что есть, и
 * сводим (каждый модуль своим merge*): так сыгранное в браузере доезжает в
 * Telegram и наоборот. Пишем во все доступные.
 */
import { inTelegram, cloudGet, cloudSet } from './telegram.js';
import { loggedIn, fetchSave, putSave } from '../net/server.js';

let server = null;      // прочитанное с сервера при запуске: { ключ: строка }

/** Есть ли куда сохранять, кроме этого устройства. */
export function cloudReady() { return inTelegram() || loggedIn(); }

/** Прочитать серверную копию один раз при запуске (до sync*Cloud). */
export async function prefetchServerSave() {
  if (!loggedIn()) { server = null; return; }
  // Сервер молчит — запуск не ждёт дольше двух секунд
  server = await Promise.race([fetchSave(), new Promise((r) => setTimeout(() => r(null), 2000))]);
}

/** Все облачные копии ключа (строки JSON), какие есть. */
export async function cloudLoad(key) {
  const out = [];
  if (inTelegram()) {
    const v = await cloudGet(key);
    if (v) out.push(v);
  }
  if (server?.[key]) out.push(server[key]);
  return out;
}

/** Записать во все доступные облака. */
export function cloudSave(key, raw) {
  if (inTelegram()) cloudSet(key, raw);
  if (loggedIn()) putSave(key, raw);
}
