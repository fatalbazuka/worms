/**
 * Чистые части сервера рейтинга: подпись Telegram и Эло.
 *
 *   node tests/server.mjs
 *
 * Проверка подписи Telegram (server/lib/telegram.js) и Эло
 * (server/lib/elo.js). Сервер целиком, с базой и HTTP, проверяет
 * tests/api.mjs.
 */
import { verifyInitData, signInitData, displayName } from '../server/lib/telegram.js';
import { eloDelta, settle, MIN_RATING } from '../server/lib/elo.js';
import { eloDelta as clientElo } from '../src/platform/player.js';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const TOKEN = '8870109026:AAtest-token-not-real';
const now = Date.now();
const user = { id: 42, first_name: 'Тест', last_name: 'Телеграмов', username: 'tester' };

// --- подпись ---
const good = await signInitData({
  query_id: 'AAH', user, auth_date: String(Math.floor(now / 1000)), start_param: 'ROOM42',
}, TOKEN);
let v = await verifyInitData(good, TOKEN, { now });
check('правильная подпись принимается', v.ok, v.ok ? '' : v.reason);
check('пользователь и start_param прочитаны', v.ok && v.user.id === 42 && v.startParam === 'ROOM42');

v = await verifyInitData(good, 'другой-токен', { now });
check('чужой токен — подпись не сходится', !v.ok && v.reason === 'подпись не сошлась', v.reason);

const tampered = good.replace('%22id%22%3A42', '%22id%22%3A43');
v = await verifyInitData(tampered, TOKEN, { now });
check('подмена пользователя ловится', !v.ok, v.reason);

const old = await signInitData({ user, auth_date: String(Math.floor(now / 1000) - 2 * 86400) }, TOKEN);
v = await verifyInitData(old, TOKEN, { now });
check('устаревшая подпись отвергается', !v.ok && v.reason === 'подпись устарела', v.reason);

v = await verifyInitData('', TOKEN, { now });
check('пустой initData отвергается', !v.ok);
v = await verifyInitData(good, '', { now });
check('без токена сервер честно говорит, что не настроен', !v.ok && /не настроен/.test(v.reason), v.reason);

check('имя для таблицы — как в Telegram', displayName(user) === 'Тест Телеграмов', displayName(user));
check('без имени — username, без всего — «Игрок N»',
  displayName({ id: 7, username: 'x' }) === 'x' && displayName({ id: 7 }) === 'Игрок 7');

// --- Эло: сервер и клиент считают одинаково ---
let same = true;
for (const a of [100, 800, 1000, 1200, 1500, 2000]) {
  for (const b of [100, 800, 1000, 1200, 1500, 2000]) {
    for (const won of [true, false]) {
      if (eloDelta(a, b, won) !== clientElo(a, b, won)) same = false;
    }
  }
}
check('Эло сервера совпадает с клиентским на сетке значений', same);

const s = settle(1000, 1000);
check('равные: победитель +12, проигравший −12', s.delta === 12 && s.winner === 1012 && s.loser === 988,
  JSON.stringify(s));
const up = settle(1000, 1400);
check('победа над сильным даёт больше', up.delta > 12, `+${up.delta}`);
const floor = settle(1000, MIN_RATING);
check('рейтинг не уходит ниже минимума', floor.loser === MIN_RATING && floor.delta >= 1, JSON.stringify(floor));

console.log(failures.length ? `\nПРОВАЛЕНО: ${failures.length} — ${failures.join(', ')}` : '\nпроверки сервера пройдены');
process.exit(failures.length ? 1 : 0);
