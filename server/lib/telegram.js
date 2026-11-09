/**
 * Проверка подписи initData от Telegram Mini App.
 *
 * Telegram подписывает данные запуска ключом, выведенным из токена бота:
 *   secret = HMAC_SHA256(key = "WebAppData", msg = токен)
 *   hash   = HMAC_SHA256(key = secret, msg = data_check_string)
 * где data_check_string — все поля, кроме hash, в виде «ключ=значение»,
 * отсортированные и склеенные через перевод строки.
 *
 * Файл чистый: только WebCrypto, никаких импортов, — его гоняет и
 * сервер (server/index.mjs), и тест (tests/server.mjs).
 */

const enc = new TextEncoder();

async function hmac(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** data_check_string по правилам Telegram. */
function checkString(params) {
  const pairs = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  return pairs.join('\n');
}

/**
 * @returns {Promise<{ok:true,user:object,startParam:string|null}|{ok:false,reason:string}>}
 */
export async function verifyInitData(initData, botToken, { maxAgeSec = 86400, now = Date.now() } = {}) {
  if (!botToken) return { ok: false, reason: 'сервер не настроен: нет токена бота' };
  if (!initData || typeof initData !== 'string') return { ok: false, reason: 'нет initData' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'нет подписи' };

  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  const sig = hex(await hmac(secret, enc.encode(checkString(params))));
  if (sig !== hash.toLowerCase()) return { ok: false, reason: 'подпись не сошлась' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) {
    return { ok: false, reason: 'подпись устарела' };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') ?? 'null'); } catch { user = null; }
  if (!user || !Number.isFinite(Number(user.id))) return { ok: false, reason: 'нет пользователя' };

  return { ok: true, user, startParam: params.get('start_param') };
}

/**
 * Собрать подписанный initData — для тестов, чтобы не зависеть от
 * настоящего клиента. Поля как у Telegram: user — JSON, auth_date — секунды.
 */
export async function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const secret = await hmac(enc.encode('WebAppData'), enc.encode(botToken));
  params.set('hash', hex(await hmac(secret, enc.encode(checkString(params)))));
  return params.toString();
}

/** Имя для таблицы лидеров: как в Telegram, без пустот. */
export function displayName(user) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return (full || user.username || `Игрок ${user.id}`).slice(0, 32);
}
