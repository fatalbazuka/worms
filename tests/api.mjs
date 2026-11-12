/**
 * Сервер целиком: HTTP, база в памяти, бот — против поддельного Telegram.
 *
 *   node tests/api.mjs
 *
 * Проверяется то, что ломать нельзя: вход только по подписи Telegram,
 * рейтинг по подтверждённым дуэлям, турнир от создания до чемпиона (с
 * проходом без игры и неявкой), звёзды — оплата и возврат, защита вебхука.
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

// --- поддельный Telegram: запоминает вызовы, отвечает как настоящий ---
const tgCalls = [];
const fakeTg = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const params = body ? JSON.parse(body) : {};
    tgCalls.push({ method, params });
    const result = {
      getMe: { id: 1, is_bot: true, username: 'worms_test_bot' },
      createInvoiceLink: `https://t.me/$invoice-${tgCalls.length}`,
      sendMessage: { message_id: tgCalls.length },
    }[method] ?? true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => fakeTg.listen(0, '127.0.0.1', r));

const BOT = '123456:test-token';
const ADMIN = 777;
let clock = Date.now();
const db = openDb(':memory:');
const app = createApp({
  db, botToken: BOT, adminIds: [ADMIN], publicUrl: 'https://example.test/worms',
  telegramApiBase: `http://127.0.0.1:${fakeTg.address().port}`, now: () => clock,
  log: { warn() {}, log() {}, error: console.error },
});
const server = createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, body, token, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* не JSON */ }
  return { status: res.status, data };
}
const hook = (update, secret = app.webhookSecret) =>
  call('POST', '/api/bot/webhook', update, null, { 'x-telegram-bot-api-secret-token': secret });
const calls = (method) => tgCalls.filter((c) => c.method === method);
const signed = (user) => signInitData({ query_id: 'q', user, auth_date: String(Math.floor(clock / 1000)) }, BOT);

async function login(id, first_name, extra = {}) {
  const r = await call('POST', '/api/telegram', { initData: await signed({ id, first_name, ...extra }) });
  return { token: r.data?.token, player: r.data?.player, status: r.status };
}

// ------------------------------------------------------------------- вход
const admin = await login(ADMIN, 'Админ', { photo_url: 'https://t.me/i/userpic/1.jpg' });
check('вход по подписи Telegram, аватар из Telegram', admin.status === 200 && admin.player.id === `tg${ADMIN}`
  && admin.player.photo?.startsWith('https://'), JSON.stringify(admin.player));
check('админ видит себя админом', admin.player.admin === true);
const [a, b, c, d] = [await login(1, 'Аня'), await login(2, 'Боря'), await login(3, 'Вика'), await login(4, 'Гоша')];
check('обычный игрок — не админ', a.player.admin === undefined);
let r = await call('POST', '/api/telegram', { initData: (await signed({ id: 5, first_name: 'X' })).replace('%22id%22%3A5', '%22id%22%3A6') });
check('подделка подписи не проходит', r.status === 401, r.data?.error);
r = await call('POST', '/api/register', { name: 'Вася', password: '1234' });
check('входа по нику и паролю больше нет', r.status === 404);

// ----------------------------------------------------------------- дуэль
await call('POST', '/api/result', { room: 'ROOM01', seed: 7, opponent: b.player.id, won: true }, a.token);
r = await call('POST', '/api/result', { room: 'ROOM01', seed: 7, opponent: a.player.id, won: false }, b.token);
check('дуэль на рейтинг засчитана обеими сторонами', r.data.status === 'confirmed' && r.data.player.rating === 988);
r = await call('GET', '/api/me', null, a.token);
check('у победителя рейтинг, серия и место', r.data.player.rating === 1012 && r.data.player.streak === 1
  && r.data.player.bestStreak === 1 && r.data.player.rank === 1, JSON.stringify(r.data.player));
r = await call('POST', '/api/result', { room: 'ZCASU1', seed: 1, opponent: b.player.id, won: true }, a.token);
check('бой без рейтинга не засчитывается', r.data.status === 'unrated' && r.data.player.rating === 1012);

// ----------------------------------------------------------------- турнир
r = await hook({ message: { from: { id: 1, first_name: 'Аня' }, chat: { id: 1, type: 'private' }, text: '/newtour 4' } });
check('не админ турнир создать не может', !app.tournaments.list(null).length
  && /не знаю/i.test(calls('sendMessage').at(-1)?.params.text ?? ''));
r = await hook({ message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/newtour 4' } }, 'wrong');
check('вебхук без секрета отклоняется', r.status === 401);
await hook({ message: { from: { id: ADMIN, first_name: 'Админ' }, chat: { id: ADMIN, type: 'private' }, text: '/newtour 4 Кубок тестов' } });
let list = (await call('GET', '/api/tournaments', null, a.token)).data.items;
const tid = list[0]?.id;
check('админ создал турнир командой бота', list.length === 1 && list[0].name === 'Кубок тестов' && list[0].size === 4
  && list[0].fee === 0, JSON.stringify(list[0]));

for (const p of [a, b, c]) await call('POST', `/api/tournaments/${tid}/join`, {}, p.token);
r = await call('POST', `/api/tournaments/${tid}/join`, {}, a.token);
check('дважды записаться нельзя', r.status === 409);
await call('POST', `/api/tournaments/${tid}/join`, {}, d.token);
let t = (await call('GET', `/api/tournaments/${tid}`, null, a.token)).data.tournament;
check('набралось четверо — турнир начался сам, два матча в комнатах на T',
  t.status === 'running' && t.rounds[0].length === 2 && t.my?.room?.startsWith('T'), JSON.stringify(t.rounds[0].map((m) => m.status)));
// Сообщения бот шлёт, не задерживая ответ игроку, — дадим им дойти
await new Promise((res) => setTimeout(res, 300));
check('о начале турнира бот написал каждому', calls('sendMessage').filter((x) => /соперник/.test(x.params.text)).length === 4);

// Матч 1: оба отчитались согласно
const tok = { [a.player.id]: a.token, [b.player.id]: b.token, [c.player.id]: c.token, [d.player.id]: d.token };
const m1 = t.rounds[0][0];
const room1 = (await call('GET', `/api/tournaments/${tid}`, null, tok[m1.p1.id])).data.tournament.my.room;
await call('POST', '/api/result', { room: room1, seed: 1, opponent: m1.p2.id, won: true }, tok[m1.p1.id]);
r = await call('POST', '/api/result', { room: room1, seed: 1, opponent: m1.p1.id, won: false }, tok[m1.p2.id]);
const loserView = (await call('GET', `/api/tournaments/${tid}`, null, tok[m1.p2.id])).data.tournament.my;
check('проигравший видит, что выбыл', loserView?.eliminated === true && loserView.round === 1, JSON.stringify(loserView));
check('матч турнира засчитан, рейтинг Эло он не трогает', r.data.status === 'tournament' && r.data.match === 'done'
  && r.data.winner === m1.p1.id);

// Матч 2: отчитался только победитель — после окна матча он проходит
const m2 = t.rounds[0][1];
const room2 = (await call('GET', `/api/tournaments/${tid}`, null, tok[m2.p2.id])).data.tournament.my.room;
await call('POST', '/api/result', { room: room2, seed: 2, opponent: m2.p1.id, won: true }, tok[m2.p2.id]);
clock += 21 * 60_000;
app.tournaments.tick();
t = (await call('GET', `/api/tournaments/${tid}`, null, a.token)).data.tournament;
check('неявка: не отчитавшийся соперник выбывает по времени', t.rounds[0][1].winner === m2.p2.id
  && t.rounds[1]?.length === 1, JSON.stringify(t.rounds[1]));

// Финал
const fin = t.rounds[1][0];
const roomF = (await call('GET', `/api/tournaments/${tid}`, null, tok[fin.p1.id])).data.tournament.my.room;
const ratingBefore = app.players.byId(fin.p1.id).rating;
await call('POST', '/api/result', { room: roomF, seed: 3, opponent: fin.p2.id, won: true }, tok[fin.p1.id]);
await call('POST', '/api/result', { room: roomF, seed: 3, opponent: fin.p1.id, won: false }, tok[fin.p2.id]);
t = (await call('GET', `/api/tournaments/${tid}`, null, a.token)).data.tournament;
const champ = (await call('GET', '/api/me', null, tok[fin.p1.id])).data.player;
check('финал сыгран — у турнира чемпион', t.status === 'finished' && t.winner?.id === fin.p1.id);
check('чемпиону титул, счётчик и +25 к рейтингу', champ.tourneyWins === 1 && /Чемпион «Кубок тестов»/.test(champ.titles[0]?.title)
  && champ.rating === ratingBefore + 25, JSON.stringify(champ.titles));
r = await call('GET', '/api/me/history', null, tok[fin.p1.id]);
check('в истории чемпиона его турнирные матчи', r.data.items.filter((i) => i.kind === 'tournament').length === 2);

// Сетка с проходом: трое в турнире на четверых, старт по команде админа
await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/newtour 4' } });
const tid2 = (await call('GET', '/api/tournaments', null, a.token)).data.items.find((x) => x.status === 'open').id;
for (const p of [a, b, c]) await call('POST', `/api/tournaments/${tid2}/join`, {}, p.token);
r = await call('POST', `/api/tournaments/${tid2}/start`, {}, a.token);
check('начать турнир из игры может только админ', r.status === 403);
await call('POST', `/api/tournaments/${tid2}/start`, {}, admin.token);
t = (await call('GET', `/api/tournaments/${tid2}`, null, a.token)).data.tournament;
check('трое в сетке на четверых: один проходит без игры', t.rounds[0].filter((m) => m.status === 'done' && !m.p2).length === 1
  && t.rounds[0].filter((m) => m.status === 'pending').length === 1);

// ------------------------------------------------------------------ звёзды
r = await call('POST', '/api/stars/donate', { amount: 50 }, a.token);
const inv = calls('createInvoiceLink').at(-1)?.params;
check('поддержка звёздами: счёт в XTR на 50', Boolean(r.data.invoice) && inv.currency === 'XTR'
  && inv.prices[0].amount === 50 && !('provider_token' in inv));
await hook({ pre_checkout_query: { id: 'pc1', from: { id: 1 }, currency: 'XTR', total_amount: 50, invoice_payload: inv.payload } });
check('перед списанием бот подтверждает покупку', calls('answerPreCheckoutQuery').at(-1)?.params.ok === true);
await hook({ message: { from: { id: 1 }, chat: { id: 1, type: 'private' },
  successful_payment: { currency: 'XTR', total_amount: 50, invoice_payload: inv.payload, telegram_payment_charge_id: 'ch-1' } } });
check('оплата записана, игроку — спасибо', db.prepare("select amount from payment where charge_id = 'ch-1'").get()?.amount === 50
  && /Спасибо/.test(calls('sendMessage').at(-1)?.params.text));

// Платный турнир: взнос, затем отмена — звёзды возвращаются
await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/newtour 4 взнос=5 Платный' } });
const tid3 = (await call('GET', '/api/tournaments', null, a.token)).data.items.find((x) => x.name === 'Платный').id;
r = await call('POST', `/api/tournaments/${tid3}/join`, {}, b.token);
const inv3 = calls('createInvoiceLink').at(-1)?.params;
check('платный турнир: запись через счёт на взнос', Boolean(r.data.invoice) && inv3.prices[0].amount === 5);
await hook({ pre_checkout_query: { id: 'pc2', from: { id: 1 }, currency: 'XTR', total_amount: 5, invoice_payload: inv3.payload } });
check('чужой счёт оплатить нельзя', calls('answerPreCheckoutQuery').at(-1)?.params.ok === false);
await hook({ message: { from: { id: 2 }, chat: { id: 2, type: 'private' },
  successful_payment: { currency: 'XTR', total_amount: 5, invoice_payload: inv3.payload, telegram_payment_charge_id: 'ch-2' } } });
t = (await call('GET', `/api/tournaments/${tid3}`, null, b.token)).data.tournament;
check('после оплаты игрок в турнире', t.joined === true && t.count === 1);
await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: `/canceltour ${tid3}` } });
const ref = calls('refundStarPayment').at(-1)?.params;
check('отмена турнира возвращает взнос', ref?.telegram_payment_charge_id === 'ch-2' && ref.user_id === 2
  && db.prepare("select refunded_at from payment where charge_id = 'ch-2'").get()?.refunded_at > 0);

// ------------------------------------------------------------------- бот
await hook({ message: { from: { id: 3, first_name: 'Вика' }, chat: { id: 3, type: 'private' }, text: '/start' } });
const hello = calls('sendMessage').at(-1)?.params;
check('/start: приветствие и кнопка «Играть» в мини-приложение',
  hello.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url === 'https://example.test/worms/');
await hook({ message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/stats' } });
check('/stats: статистика в чате', calls('sendMessage').at(-1)?.params.text
  .includes(`Рейтинг: ${app.players.byId('tg1').rating}`), calls('sendMessage').at(-1)?.params.text.split('\n')[1]);
await app.setupBot();
check('при запуске: вебхук с секретом и кнопка меню', calls('setWebhook').at(-1)?.params.url === 'https://example.test/worms/api/bot/webhook'
  && calls('setWebhook').at(-1)?.params.secret_token === app.webhookSecret
  && calls('setChatMenuButton').at(-1)?.params.menu_button.web_app.url === 'https://example.test/worms/');
check('«твой ход» бот не пишет', !calls('sendMessage').some((x) => /твой ход/i.test(x.params.text)));

server.close();
fakeTg.close();
db.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nпроверки сервера пройдены');
