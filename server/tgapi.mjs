/**
 * Клиент Telegram Bot API: один метод call(name, params).
 *
 * Без токена — заглушка, которая только пишет в лог: сервер должен
 * работать и без бота (локальная разработка, тесты без Telegram).
 * Базовый адрес подменяется (TELEGRAM_API_BASE) — так тесты поднимают
 * свой поддельный Telegram и смотрят, что бот туда отправил.
 */
export function createTelegramApi({ token = '', base = 'https://api.telegram.org', log = console } = {}) {
  if (!token) {
    return {
      enabled: false,
      async call(method) { log.warn?.(`[bot] нет токена, ${method} пропущен`); return null; },
    };
  }
  const root = `${base.replace(/\/+$/, '')}/bot${token}`;
  return {
    enabled: true,
    async call(method, params = {}) {
      let res;
      try {
        res = await fetch(`${root}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        log.warn?.(`[bot] ${method}: сеть — ${e.message}`);
        return null;
      }
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!data?.ok) {
        log.warn?.(`[bot] ${method}: ${data?.description ?? res.status}`);
        return null;
      }
      return data.result;
    },
  };
}
