/**
 * Сервер аккаунтов и рейтинга целиком: HTTP, база в памяти, без браузера.
 *
 *   node tests/api.mjs
 *
 * Регистрация, вход, смена ника, бой с подтверждением с двух сторон, спор,
 * бой с анонимом, таблица лидеров, вход из Telegram по подписи, выход,
 * ограничитель перебора и защита раздачи файлов от выхода за папку.
 */
import { createServer } from 'node:http';
import { openDb } from '../server/db.mjs';
import { createApp } from '../server/index.mjs';
import { signInitData } from '../server/lib/telegram.js';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const BOT = '123456:test-token';
const db = openDb(':memory:');
const server = createServer(createApp({ db, botToken: BOT, staticDir: process.cwd() }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  return { status: res.status, data };
}

// --- регистрация и вход
let r = await call('POST', '/api/register', { name: '  Вася   Пупкин ', password: '1234' });
check('регистрация: ник и пароль — и всё', r.status === 200 && r.data.token && r.data.player.name === 'Вася Пупкин',
  JSON.stringify(r.data?.player));
const vasya = r.data.token;
const vasyaId = r.data.player.id;
check('новичок начинает с 1000 и без места в таблице', r.data.player.rating === 1000 && r.data.player.rank === null);

r = await call('POST', '/api/register', { name: 'вася пупкин', password: 'other' });
check('ник занят без учёта регистра', r.status === 409 && r.data.field === 'name', r.data?.error);
r = await call('POST', '/api/register', { name: 'ab', password: '1234' });
check('слишком короткий ник отклонён', r.status === 400 && r.data.field === 'name', r.data?.error);
r = await call('POST', '/api/register', { name: 'Петя<script>', password: '1234' });
check('ник со спецсимволами отклонён', r.status === 400, r.data?.error);
r = await call('POST', '/api/register', { name: 'Петя', password: '12' });
check('слишком короткий пароль отклонён', r.status === 400 && r.data.field === 'password', r.data?.error);

r = await call('POST', '/api/register', { name: 'Петя', password: 'qwerty' });
const petya = r.data.token;
const petyaId = r.data.player.id;
check('второй игрок зарегистрирован', r.status === 200 && petyaId !== vasyaId);

r = await call('POST', '/api/login', { name: 'ВАСЯ ПУПКИН', password: '1234' });
check('вход по нику в любом регистре', r.status === 200 && r.data.player.id === vasyaId && r.data.token !== vasya);
const vasya2 = r.data.token;
r = await call('POST', '/api/login', { name: 'Вася Пупкин', password: 'wrong' });
check('неверный пароль — 401', r.status === 401, r.data?.error);
r = await call('POST', '/api/login', { name: 'Никто', password: 'wrong' });
check('неизвестный ник — тот же ответ', r.status === 401 && r.data.error === 'неверный ник или пароль');

const row = db.prepare('select pass_hash from player where id = ?').get(vasyaId);
check('пароль в базе только хэшем', row.pass_hash.startsWith('scrypt$') && !row.pass_hash.includes('1234'));
const sess = db.prepare('select token_hash from session').all().map((s) => s.token_hash);
check('токены в базе только хэшами', !sess.includes(vasya) && sess.length === 3, `${sess.length} входа`);

// --- профиль
r = await call('GET', '/api/me', null, vasya2);
check('/me по токену', r.status === 200 && r.data.player.id === vasyaId);
r = await call('GET', '/api/me', null, 'not-a-real-token');
check('/me с чужим токеном — 401', r.status === 401);
r = await call('GET', '/api/me');
check('/me без токена — 401', r.status === 401);
r = await call('POST', '/api/rename', { name: 'петя' }, vasya);
check('чужой ник взять нельзя', r.status === 409);
r = await call('POST', '/api/rename', { name: 'Василий' }, vasya);
check('смена ника', r.status === 200 && r.data.player.name === 'Василий');
r = await call('POST', '/api/login', { name: 'Василий', password: '1234' });
check('вход под новым ником', r.status === 200 && r.data.player.id === vasyaId);

// --- бой: подтверждение с двух сторон
r = await call('POST', '/api/result', { room: 'ROOM01', seed: 77, opponent: petyaId, won: true }, vasya);
check('первый отчёт — ждём второй', r.data.status === 'pending' && r.data.player.rating === 1000, r.data.status);
r = await call('POST', '/api/result', { room: 'ROOM01', seed: 77, opponent: petyaId, won: true }, vasya);
check('повтор того же отчёта ничего не меняет', r.data.status === 'pending');
r = await call('POST', '/api/result', { room: 'ROOM01', seed: 77, opponent: vasyaId, won: false }, petya);
check('второй согласен — бой засчитан', r.data.status === 'confirmed' && r.data.delta === -12
  && r.data.player.rating === 988 && r.data.player.losses === 1, JSON.stringify(r.data));
r = await call('GET', '/api/me', null, vasya);
check('победителю +12, первое место', r.data.player.rating === 1012 && r.data.player.wins === 1 && r.data.player.rank === 1,
  JSON.stringify(r.data.player));
r = await call('POST', '/api/result', { room: 'ROOM01', seed: 77, opponent: petyaId, won: true }, vasya);
check('после подтверждения отчёт возвращает итог', r.data.status === 'confirmed' && r.data.delta === 12);

// --- спор и посторонние
r = await call('POST', '/api/result', { room: 'ROOM02', seed: 5, opponent: petyaId, won: true }, vasya);
r = await call('POST', '/api/result', { room: 'ROOM02', seed: 5, opponent: vasyaId, won: true }, petya);
check('оба говорят «я победил» — спор, рейтинг не трогаем', r.data.status === 'disputed' && r.data.player.rating === 988);

const third = (await call('POST', '/api/register', { name: 'Третий', password: '1111' })).data;
r = await call('POST', '/api/result', { room: 'ROOM03', seed: 9, opponent: petyaId, won: true }, vasya);
r = await call('POST', '/api/result', { room: 'ROOM03', seed: 9, opponent: vasyaId, won: true }, third.token);
check('чужой бой закрыть нельзя', r.status === 403, r.data?.error);
r = await call('POST', '/api/result', { room: 'ROOM04', seed: 1, opponent: 'g12345', won: true }, vasya);
check('бой с анонимом — без рейтинга', r.data.status === 'unrated');
r = await call('POST', '/api/result', { room: 'ZCASU1', seed: 2, opponent: petyaId, won: true }, vasya);
await call('POST', '/api/result', { room: 'ZCASU1', seed: 2, opponent: vasyaId, won: false }, petya);
const afterCasual = (await call('GET', '/api/me', null, vasya)).data.player;
check('бой без рейтинга (комната на Z) сервер не засчитывает',
  r.data.status === 'unrated' && r.data.reason === 'casual' && afterCasual.rating === 1012 && afterCasual.wins === 1,
  `${r.data.status}, рейтинг ${afterCasual.rating}`);
r = await call('POST', '/api/result', { room: '../x', seed: 1, opponent: petyaId, won: true }, vasya);
check('кривая комната отклонена', r.status === 400);
r = await call('POST', '/api/result', { room: 'ROOM05', seed: 1, opponent: petyaId, won: true });
check('отчёт без входа — 401', r.status === 401);

// --- таблица лидеров
r = await call('GET', '/api/top?limit=10');
check('в таблице только сыгравшие, по рейтингу',
  r.data.players.length === 2 && r.data.players[0].id === vasyaId && r.data.players[1].id === petyaId
  && !('pass_hash' in r.data.players[0]), JSON.stringify(r.data.players));

// --- Telegram
const initData = await signInitData({
  query_id: 'q', user: { id: 4242, first_name: 'Оля' }, auth_date: String(Math.floor(Date.now() / 1000)),
}, BOT);
r = await call('POST', '/api/telegram', { initData });
check('вход из Telegram по подписи, без пароля', r.status === 200 && r.data.player.id === 'tg4242'
  && r.data.player.telegram && r.data.player.name === 'Оля', JSON.stringify(r.data));
const olya = r.data.token;
r = await call('POST', '/api/telegram', { initData });
check('повторный вход — тот же аккаунт', r.data.player.id === 'tg4242'
  && db.prepare("select count(*) as n from player where id = 'tg4242'").get().n === 1);
r = await call('POST', '/api/telegram', { initData: initData.replace('4242', '4243') });
check('подделка initData не проходит', r.status === 401, r.data?.error);
r = await call('POST', '/api/rename', { name: 'Не Оля' }, olya);
check('имя из Telegram не меняется', r.status === 400);
r = await call('POST', '/api/result', { room: 'ROOM06', seed: 3, opponent: 'tg4242', won: true }, vasya);
r = await call('POST', '/api/result', { room: 'ROOM06', seed: 3, opponent: vasyaId, won: false }, olya);
check('игрок по нику и игрок из Telegram играют на рейтинг', r.data.status === 'confirmed');

// --- выход
r = await call('POST', '/api/logout', null, vasya2);
check('выход', r.status === 200);
r = await call('GET', '/api/me', null, vasya2);
check('после выхода токен не работает', r.status === 401);
r = await call('GET', '/api/me', null, vasya);
check('другие входы того же игрока живы', r.status === 200);

// --- раздача файлов и мусор
r = await fetch(`${base}/index.html`);
check('игра раздаётся этим же процессом', r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('text/html'));
r = await fetch(`${base}/..%2fpackage.json`);
check('выйти из папки игры нельзя', r.status === 403 || r.status === 404, String(r.status));
r = await fetch(`${base}/.git/config`);
check('скрытые файлы не отдаются', r.status === 404, String(r.status));
r = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
check('битый JSON — 400', r.status === 400);
r = await fetch(`${base}/api/register`, { method: 'POST', body: 'x'.repeat(40000) });
check('огромный запрос — 413', r.status === 413, String(r.status));
r = await call('GET', '/api/nope');
check('неизвестный адрес — 404', r.status === 404);

// --- ограничитель: удачных регистраций не больше 10 в час с адреса
let codes = [];
for (let i = 0; i < 10; i++) codes.push((await call('POST', '/api/register', { name: `Бот ${i}`, password: '1234' })).status);
check('массовая регистрация упирается в ограничитель', codes.includes(429), codes.join(','));
codes = [];
for (let i = 0; i < 25; i++) codes.push((await call('POST', '/api/login', { name: 'Петя', password: `x${i}` })).status);
check('перебор пароля упирается в ограничитель', codes.at(-1) === 429, codes.slice(-3).join(','));

server.close();
db.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nпроверки сервера аккаунтов пройдены');
