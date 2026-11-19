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
      savePreparedInlineMessage: { id: `prep-${tgCalls.length}`, expiration_date: 0 },
    }[method] ?? true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => fakeTg.listen(0, '127.0.0.1', r));

const BOT = '123456:test-token';
const ADMIN = 777;
let clock = Date.now();
const db = openDb(':memory:');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const mediaDir = mkdtempSync(`${tmpdir()}/smiles-media-`);
const app = createApp({
  db, botToken: BOT, mediaDir, adminIds: [ADMIN], publicUrl: 'https://example.test/worms',
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
const hello = calls('sendAnimation').at(-1)?.params;
check('/start: ролик с боем, приветствие и кнопка «Играть» в мини-приложение',
  hello?.animation === 'https://example.test/worms/assets/promo/welcome.mp4' && hello.caption.includes('Вика')
  && hello.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url === 'https://example.test/worms/');
await hook({ message: { from: { id: 4, first_name: 'Ann', language_code: 'en' }, chat: { id: 4, type: 'private' }, text: '/start' } });
check('/start по-английски: подпись, кнопка Play и своё меню',
  calls('sendAnimation').at(-1)?.params.caption.startsWith('Hi, Ann!')
  && calls('sendAnimation').at(-1)?.params.reply_markup.inline_keyboard[0][0].text === '🎮 Play'
  && calls('setChatMenuButton').some((c) => c.params.chat_id === 4 && c.params.menu_button.text === 'Play'));
await hook({ message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/stats' } });
check('/stats: статистика в чате', calls('sendMessage').at(-1)?.params.text
  .includes(`Рейтинг: ${app.players.byId('tg1').rating}`), calls('sendMessage').at(-1)?.params.text.split('\n')[1]);
await app.setupBot();
check('при запуске: вебхук с секретом и кнопка меню', calls('setWebhook').at(-1)?.params.url === 'https://example.test/worms/api/bot/webhook'
  && calls('setWebhook').at(-1)?.params.secret_token === app.webhookSecret
  && calls('setChatMenuButton').at(-1)?.params.menu_button.web_app.url === 'https://example.test/worms/');
check('«твой ход» бот не пишет', !calls('sendMessage').some((x) => /твой ход/i.test(x.params.text)));

// ------------------------------------------------- статистика и напоминания
{
  // Полдень по Москве в известный день — чтобы «вчера», «сегодня» и вечер не
  // зависели от того, когда идёт тест
  clock = Date.UTC(2026, 10, 17, 9, 0);            // 17 ноября, 12:00 МСК
  const ann = await login(41, 'Аня');
  const ivan = await login(42, 'Иван');
  const r1 = await call('POST', '/api/event', { name: 'open', props: { streak: 3 } }, ann.token);
  await call('POST', '/api/event', { name: 'open', props: { streak: 1 } }, ivan.token);
  await call('POST', '/api/event', { name: 'battle', props: { mode: 'fallback', won: true, turns: 9 } }, ann.token);
  const bad = await call('POST', '/api/event', { name: 'hack', props: {} }, ann.token);
  const anon = await call('POST', '/api/event', { name: 'open', props: {} });
  check('события принимаются от вошедших; чужие имена и анонимы — нет',
    r1.data?.ok === true && bad.data?.ok === false && anon.status === 401);
  check('серия из события запоминается', app.players.byId('tg41').last_streak === 3);

  // На следующий день Аня зашла, Иван — нет. В обед ещё рано
  clock = Date.UTC(2026, 10, 18, 9, 0);            // 18 ноября, 12:00 МСК
  await call('POST', '/api/event', { name: 'open', props: { streak: 4 } }, ann.token);
  const before = calls('sendMessage').length;
  check('днём не напоминаем', await app.bot.remind() === 0 && calls('sendMessage').length === before);

  clock = Date.UTC(2026, 10, 18, 16, 30);          // 19:30 МСК
  const sent = await app.bot.remind();
  const msg = calls('sendMessage').at(-1)?.params;
  check('вечером напоминаем тому, кто был вчера и не был сегодня',
    sent === 1 && msg?.chat_id === 42 && /Серия 1 день/.test(msg.text)
      && msg.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app, msg?.text?.split('\n')[0]);
  check('дважды за вечер не напоминаем', await app.bot.remind() === 0);

  // Отписка: на следующий вечер Аня (была вчера, сегодня нет) — отписана
  await hook({ message: { from: { id: 41, first_name: 'Аня' }, chat: { id: 41, type: 'private' }, text: '/mute' } });
  clock = Date.UTC(2026, 10, 19, 16, 30);          // 19 ноября, 19:30 МСК
  const muted = await app.bot.remind();
  check('после /mute не напоминаем', muted === 0 && !calls('sendMessage').slice(-2).some((c) => c.params.chat_id === 41 && /Серия/.test(c.params.text)));

  clock = Date.UTC(2026, 10, 18, 16, 40);
  await call('POST', '/api/event', { name: 'step', props: { step: 'first_shot' } }, ann.token);
  const junk = await call('POST', '/api/event', { name: 'step', props: { step: 'hack' } }, ann.token);
  await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/metrics' } });
  const rep = calls('sendMessage').at(-1)?.params.text ?? '';
  check('/metrics у админа: игроки, новички, бои, возврат',
    /Сегодня \(2026-11-18\): игроков 1/.test(rep) && /Вчера: игроков 2/.test(rep)
      && /Вчерашние новички вернулись сегодня: 1 из 2/.test(rep), rep.split('\n').slice(0, 4).join(' | '));
  check('/metrics: воронка новичков и возврат через 3 и 7 дней',
    /выстрелил 1/.test(rep) && /Через 3 дня: \d+ из \d+/.test(rep) && junk.data?.ok === false,
    rep.split('\n').slice(4, 7).join(' | '));
  await hook({ message: { from: { id: 3 }, chat: { id: 3, type: 'private' }, text: '/metrics' } });
  check('/metrics не админу не показывается', !/игроков/.test(calls('sendMessage').at(-1)?.params.text ?? ''));
}

// ------------------------------------------------------ магазин и подарки
{
  clock = Date.now();
  const buyer = await login(51, 'Покупатель');
  let shop = await call('GET', '/api/shop', null, buyer.token);
  check('магазин: товары и пустой профиль покупок',
    shop.data?.items?.some((i) => i.id === 'box5' && i.stars === 99) && shop.data.owned.boxes === 0);
  const buy = await call('POST', '/api/shop/buy', { item: 'box5' }, buyer.token);
  const inv = calls('createInvoiceLink').at(-1)?.params;
  check('счёт на 5 коробок — 99 звёзд', buy.data?.invoice && inv?.currency === 'XTR' && inv.prices[0].amount === 99,
    JSON.stringify(inv?.prices));
  const bad = await call('POST', '/api/shop/buy', { item: 'box1000' }, buyer.token);
  check('несуществующий товар не продаётся', bad.status === 400);

  await hook({ pre_checkout_query: { id: 'pq-shop', from: { id: 51 }, total_amount: 50, invoice_payload: inv.payload } });
  check('чужая цена в оплате отклоняется', calls('answerPreCheckoutQuery').at(-1)?.params.ok === false);
  await hook({ pre_checkout_query: { id: 'pq-shop2', from: { id: 51 }, total_amount: 99, invoice_payload: inv.payload } });
  check('верная цена — оплата разрешена', calls('answerPreCheckoutQuery').at(-1)?.params.ok === true);
  await hook({ message: { from: { id: 51 }, chat: { id: 51, type: 'private' },
    successful_payment: { invoice_payload: inv.payload, total_amount: 99, telegram_payment_charge_id: 'shop-1' } } });
  shop = await call('GET', '/api/shop', null, buyer.token);
  check('после оплаты 5 коробок положены игроку', shop.data.owned.boxes === 5);
  await call('POST', '/api/shop/buy', { item: 'skin-devil' }, buyer.token);
  const skinInv = calls('createInvoiceLink').at(-1)?.params;
  await hook({ message: { from: { id: 51 }, chat: { id: 51, type: 'private' },
    successful_payment: { invoice_payload: skinInv.payload, total_amount: skinInv.prices[0].amount, telegram_payment_charge_id: 'shop-2' } } });
  shop = await call('GET', '/api/shop', null, buyer.token);
  check('купленный скин положен игроку', shop.data.owned.skins.includes('devil') && /Чертёнок/.test(skinInv.title));
  await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/refund shop-1' } });
  shop = await call('GET', '/api/shop', null, buyer.token);
  check('после возврата звёзд коробки из покупок уходят', shop.data.owned.boxes === 0);

  // Друг по ссылке: новичку и пригласившему — по коробке
  const hostBefore = (await call('GET', '/api/shop', null, buyer.token)).data.owned.boxes;
  const guest = await login(52, 'Новичок', {});
  const viaRef = await call('POST', '/api/telegram', { initData: await signInitData({
    query_id: 'q', user: { id: 53, first_name: 'Друг' }, start_param: 'ref_51', auth_date: String(Math.floor(clock / 1000)),
  }, BOT) });
  const friendShop = await call('GET', '/api/shop', null, viaRef.data.token);
  const hostShop = await call('GET', '/api/shop', null, buyer.token);
  const note = calls('sendMessage').at(-1)?.params;
  check('новичок по ссылке друга: обоим по коробке, другу — сообщение',
    friendShop.data.owned.boxes === 1 && hostShop.data.owned.boxes === hostBefore + 1
      && note?.chat_id === 51 && /по твоей ссылке/.test(note.text), `${friendShop.data.owned.boxes}/${hostShop.data.owned.boxes}`);
  const again = await call('POST', '/api/telegram', { initData: await signInitData({
    query_id: 'q', user: { id: 53, first_name: 'Друг' }, start_param: 'ref_51', auth_date: String(Math.floor(clock / 1000)),
  }, BOT) });
  check('повторный вход по той же ссылке подарков не даёт',
    (await call('GET', '/api/shop', null, again.data.token)).data.owned.boxes === 1);
  const self = await call('POST', '/api/telegram', { initData: await signInitData({
    query_id: 'q', user: { id: 54, first_name: 'Хитрый' }, start_param: 'ref_54', auth_date: String(Math.floor(clock / 1000)),
  }, BOT) });
  check('по своей же ссылке подарка нет', (await call('GET', '/api/shop', null, self.data.token)).data.owned.boxes === 0);
  // Друг сначала нажал /start в чате с ботом, а игру открыл по ссылке позже
  await hook({ message: { from: { id: 56, first_name: 'Осторожный' }, chat: { id: 56, type: 'private' }, text: '/start' } });
  const hostMid = (await call('GET', '/api/shop', null, buyer.token)).data.owned.boxes;
  const late = await call('POST', '/api/telegram', { initData: await signInitData({
    query_id: 'q', user: { id: 56, first_name: 'Осторожный' }, start_param: 'ref_51', auth_date: String(Math.floor(clock / 1000)),
  }, BOT) });
  check('подарок за друга есть, даже если он сперва нажал /start в боте',
    (await call('GET', '/api/shop', null, late.data.token)).data.owned.boxes === 1
      && (await call('GET', '/api/shop', null, buyer.token)).data.owned.boxes === hostMid + 1);
  // Вызов на бой: карточка с кнопкой в комнату башни
  const ch = await call('POST', '/api/challenge', { room: 'ZWAB12', link: 'https://t.me/worms_test_bot/game?startapp=ZWAB12' }, buyer.token);
  const prep = calls('savePreparedInlineMessage').at(-1)?.params;
  check('вызов на бой: карточка с кнопкой «Принять вызов» в ту же комнату',
    ch.status === 200 && prep?.user_id === 51
      && prep.result.reply_markup.inline_keyboard[0][0].url.endsWith('startapp=ZWAB12') && prep.allow_group_chats,
    JSON.stringify(prep?.result?.reply_markup));
  const badLink = await call('POST', '/api/challenge', { room: 'ZWAB12', link: 'https://evil.test/?startapp=ZWAB12' }, buyer.token);
  const badRoom = await call('POST', '/api/challenge', { room: 'A1B2C3', link: 'https://t.me/worms_test_bot/game?startapp=A1B2C3' }, buyer.token);
  check('вызов на бой: чужая ссылка и не башня — отказ', badLink.status === 400 && badRoom.status === 400);
  check('обычный вход без ссылки подарка не даёт', (await call('GET', '/api/shop', null, guest.token)).data.owned.boxes === 0);
}

// --- «Башня дня»: лучшая попытка, места, вчерашняя не засчитывается ---
{
  const { dailySeed } = await import('../server/dailytower.mjs');
  const { dailySeed: clientSeed } = await import('../src/core/match.js');
  const a = await login(61, 'Аля');
  const b = await login(62, 'Боря');
  const c = await login(63, 'Вова');
  let board = (await call('GET', '/api/daily-tower', null, a.token)).data;
  const day = board.day;
  check('башня дня: день и зерно, у игры зерно то же', /^\d{4}-\d{2}-\d{2}$/.test(day)
    && board.seed === dailySeed(day) && clientSeed(day) === board.seed && board.me === null, `${day} ${board.seed}`);
  await call('POST', '/api/daily-tower', { day, won: true, turns: 6, hp: 120 }, a.token);
  await call('POST', '/api/daily-tower', { day, won: true, turns: 4, hp: 30 }, b.token);
  await call('POST', '/api/daily-tower', { day, won: false, turns: 9, hp: 0 }, c.token);
  const worse = (await call('POST', '/api/daily-tower', { day, won: true, turns: 8, hp: 200 }, a.token)).data;
  const better = (await call('POST', '/api/daily-tower', { day, won: true, turns: 4, hp: 90 }, a.token)).data;
  check('башня дня: хуже прежней попытка не засчитана, лучше — засчитана',
    worse.accepted === false && better.accepted === true && better.me.turns === 4 && better.me.tries === 3,
    JSON.stringify(better.me));
  board = (await call('GET', '/api/daily-tower', null, c.token)).data;
  check('башня дня: места — победы, меньше ходов, больше здоровья',
    board.top.map((r) => r.name).join(',') === 'Аля,Боря,Вова' && board.me.place === 3 && board.players === 3,
    board.top.map((r) => `${r.name}:${r.turns}/${r.hp}`).join(' '));
  const stale = (await call('POST', '/api/daily-tower', { day: '2001-01-01', won: true, turns: 1, hp: 300 }, c.token)).data;
  check('башня дня: попытка не того дня не засчитывается', stale.accepted === false && stale.me.place === 3);
}

// --- вход с сайта: админ выдаёт логин и пароль, это тот же аккаунт ---
{
  const tgUser = await login(71, 'Сайтовый');
  // Игрок узнаёт свой id
  await hook({ message: { from: { id: 71 }, chat: { id: 71, type: 'private' }, text: '/id' } });
  const idMsg = calls('sendMessage').at(-1)?.params.text ?? '';
  // Не админ выдать вход не может
  await hook({ message: { from: { id: 71 }, chat: { id: 71, type: 'private' }, text: '/web 71 hacker' } });
  const denied = calls('sendMessage').at(-1)?.params.text ?? '';
  await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/web 71 Site.User' } });
  const issued = calls('sendMessage').at(-1)?.params.text ?? '';
  const pass = /пароль: (\S+)/.exec(issued)?.[1];
  check('/id и /web: админ выдаёт логин и пароль к аккаунту Telegram',
    /71/.test(idMsg) && !/пароль/.test(denied) && /логин: site\.user/.test(issued) && pass?.length === 8, issued.split('\n')[0]);
  const bad = await call('POST', '/api/login', { login: 'site.user', password: 'wrong-pass' });
  const ok = await call('POST', '/api/login', { login: 'Site.User', password: pass });
  check('вход с сайта: неверный пароль — отказ, верный — тот же аккаунт',
    bad.status === 401 && ok.status === 200 && ok.data.player.id === 'tg71' && ok.data.player.id === tgUser.player.id,
    `${bad.status} ${ok.status} ${ok.data?.player?.id}`);
  // Прогресс: из Telegram записали — с сайта прочли
  const saved = await call('PUT', '/api/save', { key: 'worms.skins.v1', value: JSON.stringify({ owned: ['classic', 'devil'] }) }, tgUser.token);
  const read = await call('GET', '/api/save', null, ok.data.token);
  const junk = await call('PUT', '/api/save', { key: 'worms.player.v1', value: '{}' }, ok.data.token);
  check('прогресс на сервере: записано в Telegram — видно с сайта; чужие ключи — отказ',
    saved.status === 200 && JSON.parse(read.data.items['worms.skins.v1']).owned.includes('devil') && junk.status === 400,
    JSON.stringify(read.data?.items));
  // Повторная выдача меняет пароль: старый больше не подходит
  await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/web 71 site.user' } });
  const old = await call('POST', '/api/login', { login: 'site.user', password: pass });
  check('повторная выдача — новый пароль, старый не подходит', old.status === 401);
}

// --- топ-10 лестницей: у каждого — надетый скин из его прогресса ---
{
  const a = await login(81, 'Нинзя'), b = await login(82, 'Битый');
  db.prepare('update player set wins = 5, rating = 3001 where id = ?').run(a.player.id);
  db.prepare('update player set wins = 4, rating = 3000 where id = ?').run(b.player.id);
  await call('PUT', '/api/save', { key: 'worms.skins.v1', value: JSON.stringify({ owned: ['classic', 'ninja'], equipped: 'ninja' }) }, a.token);
  await call('PUT', '/api/save', { key: 'worms.skins.v1', value: '{битый' }, b.token);
  const top = await call('GET', '/api/top?limit=10');
  const ra = top.data.players.find((r) => r.id === a.player.id), rb = top.data.players.find((r) => r.id === b.player.id);
  check('топ отдаёт надетый скин; битая копия — обычный смайлик, топ не падает',
    top.status === 200 && ra?.skin === 'ninja' && rb?.skin === 'classic', JSON.stringify({ ra: ra?.skin, rb: rb?.skin }));
}

// --- админка: вход по ссылке из бота, сводка, игрок, подарок, бан, рассылка, копия базы ---
{
  const victim = await login(91, 'Игрок91');
  db.prepare('update player set wins = 3, rating = 3500 where id = ?').run(victim.player.id);
  // Не админу /admin ссылки не даёт, админу — даёт одноразовую
  await hook({ message: { from: { id: 91 }, chat: { id: 91, type: 'private' }, text: '/admin' } });
  const noLink = calls('sendMessage').at(-1)?.params.text ?? '';
  await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/admin' } });
  const linkMsg = calls('sendMessage').at(-1)?.params.text ?? '';
  const key = /admin\/\?key=([\w-]+)/.exec(linkMsg)?.[1];
  const enter = await call('POST', '/api/admin/enter', { key });
  const reuse = await call('POST', '/api/admin/enter', { key });
  const T = enter.data.token;
  const notAdmin = await call('GET', '/api/admin/overview', null, victim.token);
  check('админка: ссылка из /admin только админу, одноразовая; не админа не пускает',
    !/key=/.test(noLink) && Boolean(key) && enter.status === 200 && reuse.status === 401 && notAdmin.status === 403,
    `${enter.status} ${reuse.status} ${notAdmin.status}`);
  const ov = await call('GET', '/api/admin/overview', null, T);
  check('админка: сводка — 14 дней, возврат, воронка, всего игроков',
    ov.status === 200 && ov.data.series.length === 14 && ov.data.retention.d1 && ov.data.funnel.steps.length > 0 && ov.data.totals.players > 0,
    JSON.stringify(ov.data?.totals));
  const found = await call('GET', '/api/admin/players?q=91', null, T);
  const card = await call('GET', `/api/admin/player?id=${victim.player.id}`, null, T);
  check('админка: поиск по Telegram ID и карточка игрока без хэша пароля',
    found.data.players.some((p) => p.id === victim.player.id) && card.data.player.id === victim.player.id
      && !('pass_hash' in card.data.player) && Array.isArray(card.data.duels),
    JSON.stringify(found.data.players.map((p) => p.id)));
  // Подарок: монеты, коробка, скин — придут в owned, игроку — сообщение в бот
  const before = (await call('GET', '/api/shop', null, victim.token)).data.owned;
  const gift = await call('POST', '/api/admin/gift', { id: victim.player.id, coins: 500, boxes: 2, skin: 'king', notify: true }, T);
  const after = (await call('GET', '/api/shop', null, victim.token)).data.owned;
  const giftMsg = calls('sendMessage').at(-1)?.params;
  const bad = await call('POST', '/api/admin/gift', { id: victim.player.id, skin: 'нет-такого' }, T);
  check('админка: подарок монет, коробок и скина ложится в owned, игроку пишет бот; пустой — отказ',
    gift.status === 200 && after.coins === before.coins + 500 && after.boxes === before.boxes + 2 && after.skins.includes('king')
      && giftMsg?.chat_id === 91 && /подарок/.test(giftMsg?.text ?? '') && bad.status === 400,
    JSON.stringify({ before, after }));
  // Бан: игра не пускает, из топа пропадает; админа забанить нельзя; разбан возвращает
  const topBefore = (await call('GET', '/api/top?limit=50')).data.players.some((p) => p.id === victim.player.id);
  await call('POST', '/api/admin/ban', { id: victim.player.id, ban: true }, T);
  const blocked = await call('GET', '/api/me', null, victim.token);
  const topBanned = (await call('GET', '/api/top?limit=50')).data.players.some((p) => p.id === victim.player.id);
  const relogin = await call('POST', '/api/telegram', { initData: await signed({ id: 91, first_name: 'Игрок91' }) });
  const selfBan = await call('POST', '/api/admin/ban', { id: `tg${ADMIN}`, ban: true }, T);
  await call('POST', '/api/admin/ban', { id: victim.player.id, ban: false }, T);
  const back = await call('GET', '/api/me', null, victim.token);
  check('админка: бан — вход закрыт и в топе нет; админа не банят; разбан возвращает',
    topBefore && blocked.status === 403 && !topBanned && relogin.status === 403 && selfBan.status === 409 && back.status === 200,
    `${blocked.status} ${relogin.status} ${selfBan.status} ${back.status}`);
  // Турнир из админки
  const tour = await call('POST', '/api/admin/tours', { name: 'Админский', size: 8 }, T);
  const tours = await call('GET', '/api/admin/tours', null, T);
  const cancel = await call('POST', '/api/admin/tours/cancel', { id: tour.data.tournament?.id }, T);
  check('админка: турнир создаётся и отменяется',
    tour.status === 200 && tours.data.items.some((t) => t.name === 'Админский') && cancel.status === 200, `${tour.status} ${cancel.status}`);
  // Рассылка: сначала превью, потом отправка всем с Telegram, кроме отписавшихся
  const sentBefore = calls('sendMessage').length;
  const prev = await call('POST', '/api/admin/broadcast', { text: 'Турнир в 20:00!' }, T);
  const noSend = calls('sendMessage').length === sentBefore;
  const go = await call('POST', '/api/admin/broadcast', { text: 'Турнир в 20:00!', confirm: true }, T);
  let status = null;
  for (let i = 0; i < 100 && !status?.items?.[0]?.done_at; i++) {
    await new Promise((r) => setTimeout(r, 50));
    status = (await call('GET', '/api/admin/broadcast', null, T)).data;
  }
  const delivered = calls('sendMessage').slice(sentBefore).filter((c) => c.params.text === 'Турнир в 20:00!').length;
  check('админка: рассылка — превью ничего не шлёт, отправка доходит до всех',
    prev.data.preview && prev.data.audience > 0 && noSend && go.status === 200 && delivered === go.data.total
      && status.items[0].sent === go.data.total, `превью ${prev.data.audience}, ушло ${delivered} из ${go.data.total}`);
  // Аккаунт только для сайта: из админки со своим паролем и из бота с придуманным
  const acc = await call('POST', '/api/admin/accounts', { login: 'EXS', name: 'Экс', password: 'exs123' }, T);
  const dup = await call('POST', '/api/admin/accounts', { login: 'exs', password: 'other1' }, T);
  const short = await call('POST', '/api/admin/accounts', { login: 'exs2', password: '123' }, T);
  const web = await call('POST', '/api/login', { login: 'exs', password: 'exs123' });
  const webMe = await call('GET', '/api/me', null, web.data.token);
  check('аккаунт для сайта: создаётся со своим паролем, вход работает, без Telegram; занятый логин и короткий пароль — отказ',
    acc.status === 200 && acc.data.password === null && web.status === 200 && /^u[0-9a-f]+$/.test(webMe.data.player.id)
      && webMe.data.player.name === 'Экс' && dup.status === 409 && short.status === 409,
    JSON.stringify({ acc: acc.data, me: webMe.data?.player?.id, dup: dup.status, short: short.status }));
  await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/newweb vasya Вася' } });
  const nw = calls('sendMessage').at(-1)?.params.text ?? '';
  const nwPass = /пароль: (\S+)/.exec(nw)?.[1];
  const nwLogin = await call('POST', '/api/login', { login: 'vasya', password: nwPass });
  const reset = await call('POST', '/api/admin/password', { id: webMe.data.player.id }, T);
  const oldPass = await call('POST', '/api/login', { login: 'exs', password: 'exs123' });
  const newPass = await call('POST', '/api/login', { login: 'exs', password: reset.data.password });
  check('/newweb в боте придумывает пароль; «новый пароль» в админке — старый больше не подходит',
    /логин: vasya/.test(nw) && nwLogin.status === 200 && reset.status === 200 && oldPass.status === 401 && newPass.status === 200,
    `${nwLogin.status} ${oldPass.status} ${newPass.status}`);
  // Копия базы — файл SQLite
  const res = await fetch(`${base}/api/admin/backup`, { headers: { authorization: `Bearer ${T}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  const noAuth = await fetch(`${base}/api/admin/backup`);
  check('админка: копия базы скачивается файлом SQLite, без входа — нет',
    res.status === 200 && buf.subarray(0, 15).toString() === 'SQLite format 3' && noAuth.status === 401, `${res.status} ${buf.length} байт`);
}

// @бот в любом чате: карточка дуэли с общей комнатой башни и «позвать» по рефералке
{
  await hook({ update_id: 9001, inline_query: { id: 'iq1', from: { id: 555, first_name: 'Вася', language_code: 'ru' }, query: '' } });
  const a = calls('answerInlineQuery').at(-1)?.params;
  const duel = a?.results?.[0]?.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? '';
  const ref = a?.results?.[1]?.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? '';
  check('инлайн: карточка дуэли ведёт в комнату башни, вторая — по рефералке',
    /startapp=ZW[A-Z2-9]{4}$/.test(duel) && ref.endsWith('startapp=ref_555') && a.results[0].input_message_content.message_text.includes('Вася'),
    JSON.stringify(a)?.slice(0, 300));
  check('при запуске: вебхук принимает инлайн-запросы',
    calls('setWebhook').at(-1)?.params.allowed_updates?.includes('inline_query'));
}

// Сторис и клипы: картинка ложится на сервер и отдаётся по ссылке; чужое — нет
{
  const T = (await call('POST', '/api/telegram', { initData: await signed({ id: 4242, first_name: 'Сторис' }) })).data?.token;
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);
  const up = await fetch(`${base}/api/media`, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'image/jpeg' }, body: jpg });
  const r = await up.json();
  const got = r.path ? await fetch(base + r.path) : null;
  const body = got ? Buffer.from(await got.arrayBuffer()) : Buffer.alloc(0);
  const html = await fetch(`${base}/api/media`, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'text/html' }, body: '<b>x</b>'.repeat(20) });
  const anon = await fetch(`${base}/api/media`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpg });
  check('медиа: картинка для сторис загружается и отдаётся, HTML и без входа — нет',
    up.status === 200 && got?.status === 200 && got.headers.get('content-type') === 'image/jpeg' && body.equals(jpg)
      && html.status === 415 && anon.status === 401, `${up.status} ${JSON.stringify(r)} ${got?.status} ${html.status} ${anon.status}`);
}

server.close();
fakeTg.close();
db.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nпроверки сервера пройдены');
