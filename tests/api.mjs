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

async function call(method, path, body, token, headers = {}, at = base) {
  const res = await fetch(at + path, {
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
const callAt = call;
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
check('/start: под «Играть» — «Позвать друга на партию», он открывает выбор чата с @ботом',
  hello?.reply_markup?.inline_keyboard?.[1]?.[0]?.switch_inline_query === ''
    && /Позвать друга на партию/.test(hello.reply_markup.inline_keyboard[1][0].text), JSON.stringify(hello?.reply_markup));
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
      && note?.chat_id === 51 && /по твоему приглашению/.test(note.text), `${friendShop.data.owned.boxes}/${hostShop.data.owned.boxes}`);
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

// @бот в любом чате: карточка — дуэль по переписке (первым ходит принявший), вторая — «позвать» по рефералке
{
  await hook({ update_id: 9001, inline_query: { id: 'iq1', from: { id: 555, first_name: 'Вася', language_code: 'ru' }, query: '' } });
  const a = calls('answerInlineQuery').at(-1)?.params;
  const duel = a?.results?.[0]?.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? '';
  const ref = a?.results?.[1]?.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? '';
  const code = /startapp=duel_([A-Z2-9]{6})$/.exec(duel)?.[1];
  check('инлайн: карточка ведёт в дуэль-вызов по переписке, вторая — по рефералке',
    Boolean(code) && ref.endsWith('startapp=ref_555') && a.results[0].input_message_content.message_text.includes('Вася'),
    JSON.stringify(a)?.slice(0, 300));
  // Инлайн-запрос летит на каждую букву — вызов тот же, новых дуэлей нет
  await hook({ update_id: 9002, inline_query: { id: 'iq2', from: { id: 555, first_name: 'Вася', language_code: 'ru' }, query: 'а' } });
  const again = calls('answerInlineQuery').at(-1)?.params?.results?.[0]?.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? '';
  check('инлайн: повторный запрос — тот же вызов', again === duel, again);
  check('при запуске: вебхук принимает инлайн-запросы',
    calls('setWebhook').at(-1)?.params.allowed_updates?.includes('inline_query'));
}

// Турнир недели: заводится сам, один раз за неделю, старт в субботу в 19:00 МСК; чемпиону — коробки
{
  const realNow = clock;
  // Среда 12:00 МСК
  clock = Date.UTC(2026, 10, 18, 9, 0);
  const t1 = app.weekly.tick();
  const t2 = app.weekly.tick();
  const st = t1 ? new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t1.starts_at)) : '';
  // Воскресенье: старт этой недели прошёл — ничего не заводим
  clock = Date.UTC(2026, 10, 22, 9, 0);
  const t3 = app.weekly.tick();
  const boxCount = () => db.prepare("select coalesce(sum(boxes), 0) as n from bonus where player_id = 'tg1'").get().n;
  const before = boxCount();
  app.weekly.onFinish({ name: t1?.name }, 'tg1');
  const boxes = boxCount() - before;
  clock = realNow;
  check('турнир недели: заводится раз в неделю на субботу 19:00, чемпиону 3 коробки',
    t1?.name.startsWith('Турнир недели') && t1.size === 16 && t1.fee === 0 && st === 'Sat, 19' && !t2 && !t3 && boxes === 3,
    `${t1?.name} ${st} ${Boolean(t2)} ${Boolean(t3)} коробок ${boxes}`);
}

// Промокоды: SKIPPER77 есть сразу, один раз на игрока; админ заводит свой с лимитом
{
  const tokenOf = async (id, name) => (await call('POST', '/api/telegram', { initData: await signed({ id, first_name: name }) })).data?.token;
  const A = await tokenOf(5101, 'Промо А'), B = await tokenOf(5102, 'Промо Б');
  const r1 = await call('POST', '/api/promo', { code: 'Skipper77' }, A);
  const r2 = await call('POST', '/api/promo', { code: 'SKIPPER77' }, A);
  const r3 = await call('POST', '/api/promo', { code: 'nope-code' }, A);
  await hook({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '/newpromo friends1 коробок=2 раз=1' } });
  const made = calls('sendMessage').at(-1)?.params.text ?? '';
  const r4 = await call('POST', '/api/promo', { code: 'friends1' }, A);
  const r5 = await call('POST', '/api/promo', { code: 'friends1' }, B);
  await hook({ message: { from: { id: 5102 }, chat: { id: 5102, type: 'private' }, text: '/promo skipper77' } });
  const viaBot = calls('sendMessage').at(-1)?.params.text ?? '';
  check('промокод: SKIPPER77 даёт 3 коробки, повтор и чужой код — отказ',
    r1.status === 200 && r1.data.boxes === 3 && r1.data.owned.boxes >= 3 && r2.status === 409 && r3.status === 404,
    `${r1.status} ${JSON.stringify(r1.data)?.slice(0, 80)} ${r2.status} ${r3.status}`);
  check('промокод: админ заводит в боте, лимит активаций работает, игрок вводит и через /promo',
    /FRIENDS1/.test(made) && r4.status === 200 && r4.data.boxes === 2 && r5.status === 410 && viaBot.includes('активирован'),
    `${made.slice(0, 60)} | ${r4.status} ${r5.status} | ${viaBot.slice(0, 60)}`);
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

// --- друзья: кого позвал, кто позвал, с кем доиграл бой на рейтинг; «обогнал» раз в день ---
{
  // Свой сервер: здесь много боёв подряд, а лимит записи — на адрес в минуту
  const fdb = openDb(':memory:');
  const fapp = createApp({
    db: fdb, botToken: BOT, mediaDir, publicUrl: 'https://example.test/worms',
    telegramApiBase: `http://127.0.0.1:${fakeTg.address().port}`, now: () => clock,
    log: { warn() {}, log() {}, error: console.error },
  });
  const fsrv = createServer(fapp);
  await new Promise((res) => fsrv.listen(0, '127.0.0.1', res));
  const at = `http://127.0.0.1:${fsrv.address().port}`;
  const call = (method, path, body, token) => callAt(method, path, body, token, {}, at);
  const hook = (update) => callAt('POST', '/api/bot/webhook', update, null, { 'x-telegram-bot-api-secret-token': fapp.webhookSecret }, at);
  const login = async (id, first_name, extra = {}) => {
    const r = await call('POST', '/api/telegram', { initData: await signInitData({
      query_id: 'q', user: { id, first_name }, auth_date: String(Math.floor(clock / 1000)), ...extra,
    }, BOT) });
    return { token: r.data?.token, player: r.data?.player };
  };
  const db = fdb;
  const realNow = clock;
  clock = Date.UTC(2026, 10, 20, 10, 0);            // 20 ноября, 13:00 МСК — днём бот пишет
  const host = await login(6001, 'Хозяин');
  const guest = await login(6002, 'Гость', { start_param: 'ref_6001' });
  const foe = await login(6003, 'Соперник'), spat = await login(6004, 'Спорщик'), far = await login(6005, 'Чужой');
  const duel = async (w, l, room) => {
    await call('POST', '/api/result', { room, seed: 1, opponent: l.player.id, won: true }, w.token);
    return call('POST', '/api/result', { room, seed: 1, opponent: w.player.id, won: false }, l.token);
  };
  await duel(host, foe, 'FRND01');
  // Спорный бой (оба «победили») друзьями не делает; бой соперника с чужим — не мой друг
  await call('POST', '/api/result', { room: 'FRND02', seed: 1, opponent: spat.player.id, won: true }, host.token);
  await call('POST', '/api/result', { room: 'FRND02', seed: 1, opponent: host.player.id, won: true }, spat.token);
  await duel(foe, far, 'FRND03');
  const mine = (await call('GET', '/api/friends', null, host.token)).data;
  const ids = mine.friends.map((f) => f.id);
  const ratings = mine.friends.map((f) => f.rating);
  check('друзья: позванный и соперник по бою на рейтинг, сам игрок с местом; спорный бой и друг друга — нет',
    ids.length === 3 && ids.includes(guest.player.id) && ids.includes(foe.player.id) && ids.includes(host.player.id)
      && !ids.includes(spat.player.id) && !ids.includes(far.player.id)
      && ratings.every((x, i) => !i || ratings[i - 1] >= x) && mine.place === 1 && mine.friends[0].me === true
      && mine.total === 3 && mine.friends.every((f) => f.skin && f.place && f.seenAt), JSON.stringify(mine));
  const theirs = (await call('GET', '/api/friends', null, guest.token)).data.friends.map((f) => f.id);
  check('друзья взаимны: позвавший — друг позванного', theirs.length === 2 && theirs.includes(host.player.id));

  // Гость выше хозяина; хозяин выигрывает — и обгоняет его
  const setRating = (id, rating) => db.prepare('update player set rating = ?, wins = max(wins, 1) where id = ?').run(rating, id);
  const overtakes = () => calls('sendMessage').filter((c) => c.params.chat_id === 6002 && /обогнал/.test(c.params.text));
  const round = async (room) => {
    setRating(host.player.id, 1000); setRating(guest.player.id, 1005); setRating(foe.player.id, 1000);
    await duel(host, foe, room);
    await new Promise((res) => setTimeout(res, 150));
  };
  await round('OVER01');
  const first = overtakes();
  check('обогнал друга — другу сообщение с кнопкой в топ друзей; соперник по бою такого не получает',
    first.length === 1 && first[0].params.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('?top=friends')
      && !calls('sendMessage').some((c) => c.params.chat_id === 6003 && /обогнал/.test(c.params.text)), JSON.stringify(first[0]?.params));
  await round('OVER02');
  check('та же пара в тот же день — второго сообщения нет', overtakes().length === 1);
  clock += 86400_000;
  await round('OVER03');
  check('на следующий день — снова можно', overtakes().length === 2);
  await hook({ message: { from: { id: 6002, first_name: 'Гость' }, chat: { id: 6002, type: 'private' }, text: '/mute' } });
  clock += 86400_000;
  await round('OVER04');
  check('после /mute «обогнал» не приходит', overtakes().length === 2);
  await hook({ message: { from: { id: 6002, first_name: 'Гость' }, chat: { id: 6002, type: 'private' }, text: '/unmute' } });

  // Вызов другу через бота: только другу и не чаще раза в 10 минут
  // Знакомые: друзья друзей — Гостю виден Соперник (он сыграл с Хозяином), через кого — тоже
  {
    const fr = (await call('GET', '/api/friends', null, guest.token)).data;
    const k = fr.known?.find((x) => x.id === foe.player.id);
    check('знакомые: друг твоего друга виден с пометкой, через кого; сам друг и ты — не в знакомых',
      Boolean(k) && k.via === 'Хозяин' && !fr.known.some((x) => x.id === host.player.id || x.id === guest.player.id),
      JSON.stringify(fr.known?.map((x) => [x.name, x.via])));
  }
  let ch = await call('POST', '/api/friends/challenge', { id: guest.player.id, room: 'ZWFR12' }, host.token);
  const inv = calls('sendMessage').at(-1)?.params;
  check('«Вызвать»: бот пишет другу, кнопка — сразу в комнату башни',
    ch.data?.sent === true && inv?.chat_id === 6002 && inv.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('?room=ZWFR12'),
    JSON.stringify(ch.data));
  const again = await call('POST', '/api/friends/challenge', { id: guest.player.id, room: 'ZWFR13' }, host.token);
  const stranger = await call('POST', '/api/friends/challenge', { id: far.player.id, room: 'ZWFR14' }, host.token);
  check('«Вызвать»: повтор сразу — нет (игра позовёт карточкой), не другу — отказ',
    again.data?.sent === false && again.data.reason === 'limit' && stranger.status === 403, `${JSON.stringify(again.data)} ${stranger.status}`);

  // Друг открыл вызов, когда позвавшего уже нет: бот пишет позвавшему «заходи»
  const knock = await call('POST', '/api/room/knock', { room: 'ZWFR12' }, guest.token);
  const kn = calls('sendMessage').at(-1)?.params;
  check('друг ждёт в комнате вызова — позвавшему сообщение с кнопкой в ту же комнату',
    knock.data?.sent === true && knock.data.owner === 'Хозяин' && kn?.chat_id === 6001
      && kn.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('?room=ZWFR12'), JSON.stringify(knock.data));
  const knock2 = await call('POST', '/api/room/knock', { room: 'ZWFR12' }, guest.token);
  const own = await call('POST', '/api/room/knock', { room: 'ZWFR12' }, host.token);
  const unknown = await call('POST', '/api/room/knock', { room: 'ZWNOPE' }, guest.token);
  check('«заходи»: не чаще раза в 10 минут, себе не пишем, чужую комнату не знаем',
    knock2.data?.sent === false && knock2.data.reason === 'limit' && own.data?.reason === 'own'
      && unknown.data?.reason === 'unknown', `${JSON.stringify(knock2.data)} ${JSON.stringify(own.data)} ${JSON.stringify(unknown.data)}`);
  clock = realNow;
  fsrv.close();
  fdb.close();
}

// --- дуэли по переписке: очередь, повтор хода, лимиты, срок хода, пропуски, только друзья ---
{
  const ddb = openDb(':memory:');
  const warns = [];
  const dapp = createApp({
    db: ddb, botToken: BOT, mediaDir, adminIds: [7001], publicUrl: 'https://example.test/worms',
    telegramApiBase: `http://127.0.0.1:${fakeTg.address().port}`, now: () => clock,
    log: { warn: (m) => warns.push(String(m)), log() {}, error: console.error },
  });
  const dsrv = createServer(dapp);
  await new Promise((res) => dsrv.listen(0, '127.0.0.1', res));
  const at = `http://127.0.0.1:${dsrv.address().port}`;
  const call = (method, path, body, token) => callAt(method, path, body, token, {}, at);
  const hook = (update) => callAt('POST', '/api/bot/webhook', update, null, { 'x-telegram-bot-api-secret-token': dapp.webhookSecret }, at);
  const login = async (id, first_name, extra = {}) => (await call('POST', '/api/telegram', { initData: await signInitData({
    query_id: 'q', user: { id, first_name }, auth_date: String(Math.floor(clock / 1000)), ...extra,
  }, BOT) })).data;
  const realNow = clock;
  clock = Date.UTC(2026, 10, 20, 10, 0);            // 13:00 МСК — днём бот пишет со звуком
  const A = await login(7001, 'Хозяин'), B = await login(7002, 'Гость', { start_param: 'ref_7001' });
  const C = await login(7003, 'Чужой');
  const msgsTo = (tg) => calls('sendMessage').filter((m) => m.params.chat_id === tg);
  // Ход как его шлёт игра: приказы для показа и снимок итога — очередь у соперника
  const turn = (n, extra = {}) => ({ turn: n, cmds: [{ k: 'shot', at: 900, cmd: { type: 'shot', turn: n, worm: 0, vx: 300, vy: -200 } }],
    state: { turn: n + 1, team: n % 2, worms: [{ x: 1, y: 2, hp: 100, alive: true }] }, hash: `h${n}`, ...extra });

  // Вызвать можно любого — и не друга (из рейтинга, по коду); одна идущая дуэль на пару
  let r = await call('POST', '/api/duels', { opponent: C.player.id }, A.token);
  const twice = await call('POST', '/api/duels', { opponent: C.player.id }, A.token);
  check('дуэль по переписке: и не с другом можно; вторая с тем же — та же дуэль',
    r.status === 200 && twice.data?.existing === true && twice.data.duel.id === r.data.duel.id, `${r.status} ${JSON.stringify(twice.data)}`);
  await call('POST', `/api/duels/${r.data.duel.id}/resign`, null, A.token);
  // Код игрока: в профиле, пять знаков; вызов по коду — без дружбы и без чата
  const meC = (await call('GET', '/api/me', null, C.token)).data.player;
  const meC2 = (await call('GET', '/api/me', null, C.token)).data.player;
  const byCode = await call('POST', '/api/duels', { code: meC.code.toLowerCase(), theyFirst: true }, B.token);
  const ownCode = await call('POST', '/api/duels', { code: meC.code }, C.token);
  const noCode = await call('POST', '/api/duels', { code: 'ZZZZZ' }, B.token);
  check('код игрока: пять знаков, не меняется; по коду — дуэль, свой код и чужой несуществующий — отказ',
    /^[A-Z2-9]{5}$/.test(meC.code ?? '') && meC2.code === meC.code && byCode.status === 200
      && byCode.data.duel.opponent?.id === C.player.id && byCode.data.duel.myTurn === false
      && ownCode.status === 400 && noCode.status === 404, `${meC.code} ${byCode.status} ${ownCode.status} ${noCode.status}`);
  await call('POST', `/api/duels/${byCode.data.duel.id}/resign`, null, B.token);
  r = await call('POST', '/api/duels', { opponent: B.player.id }, A.token);
  const d1 = r.data?.duel;
  const bView = (await call('GET', '/api/duels', null, B.token)).data;
  check('дуэль с другом: создатель ходит первым, у друга — «ждём»',
    r.status === 200 && d1.myTurn === true && d1.me === 0 && d1.turn === 1 && d1.opponent.id === B.player.id
      && bView.items[0]?.id === d1.id && bView.items[0].myTurn === false && bView.myTurn === 0, JSON.stringify(d1));

  const notMine = await call('POST', `/api/duels/${d1.id}/turn`, turn(1), B.token);
  const badQueue = await call('POST', `/api/duels/${d1.id}/turn`, { ...turn(1), state: { turn: 3, team: 0, worms: [] } }, A.token);
  const sentBefore = msgsTo(7002).length;
  const ok1 = await call('POST', `/api/duels/${d1.id}/turn`, turn(1), A.token);
  const again = await call('POST', `/api/duels/${d1.id}/turn`, turn(1), A.token);
  const toB = msgsTo(7002).slice(sentBefore);
  check('ход: чужой — отказ, не сходится с очередью — отказ, свой — принят; повтор того же хода — тот же ответ',
    notMine.status === 409 && badQueue.status === 400 && ok1.status === 200 && ok1.data.duel.turn === 2
      && again.status === 200 && again.data.repeated === true
      && ddb.prepare('select count(*) as n from duel_turn where duel_id = ?').get(d1.id).n === 1,
    `${notMine.status} ${badQueue.status} ${ok1.status} ${again.status}`);
  check('бот: «⚔️ Твой ход против Хозяин» с кнопкой прямо в дуэль, один раз',
    toB.length === 1 && /твой ход против Хозяин/i.test(toB[0].params.text)
      && toB[0].params.reply_markup.inline_keyboard[0][0].web_app.url.endsWith(`?duel=${d1.id}`)
      && !toB[0].params.disable_notification, JSON.stringify(toB.map((m) => m.params.text)));

  // Второй игрок получает партию целиком и шлёт свой ход с тем, что у него вышло
  const full = (await call('GET', `/api/duels/${d1.id}`, null, B.token)).data.duel;
  check('дуэль целиком: зерно и история ходов с приказами и снимком',
    Number.isSafeInteger(full.seed) && full.turns.length === 1 && full.turns[0].team === 0
      && full.turns[0].cmds[0].k === 'shot' && full.turns[0].state.turn === 2 && full.turns[0].hash === 'h1', JSON.stringify(full.turns));
  // Хозяин сейчас смотрит дуэль (опрашивает её) — бот ему не пишет
  await call('GET', `/api/duels/${d1.id}`, null, A.token);
  const toA0 = msgsTo(7001).length;
  await call('POST', `/api/duels/${d1.id}/turn`, turn(2, { prevHash: 'other' }), B.token);
  check('свёртка не сошлась — в журнале сервера и в истории; партия идёт дальше',
    warns.some((w) => /разошлось h1 != other/.test(w))
      && ddb.prepare('select seen_hash from duel_turn where duel_id = ? and n = 1').get(d1.id).seen_hash === 'other'
      && (await call('GET', `/api/duels/${d1.id}`, null, A.token)).data.duel.myTurn === true, warns.join(' | '));
  check('кто сейчас смотрит дуэль, тому «твой ход» не пишем', msgsTo(7001).length === toA0);

  // Срок хода: за два часа — напоминание (одно), после срока — пропуск и ход сопернику
  clock += 22 * 3600_000 + 60_000;
  const t1 = await dapp.duels.tick();
  const t1again = await dapp.duels.tick();
  const remind = msgsTo(7001).at(-1)?.params.text ?? '';
  clock += 2 * 3600_000;
  const t2 = await dapp.duels.tick();
  const skipMsg = msgsTo(7002).at(-1)?.params.text ?? '';
  let d = (await call('GET', `/api/duels/${d1.id}`, null, B.token)).data.duel;
  check('за 2 часа до срока — одно напоминание; срок вышел — ход пропущен, очередь у соперника',
    t1.reminded === 1 && t1again.reminded === 0 && /Осталось 2 часа/.test(remind) && t2.skipped === 1
      && d.turn === 4 && d.myTurn === true && d.turns.at(-1).kind === 'skip' && d.skips[0] === 1
      && /Хозяин не успел походить/.test(skipMsg), `${JSON.stringify(t1)} ${JSON.stringify(t2)} ${skipMsg.split('\n')[0]}`);
  // Пропуски подряд: Гость ходит, Хозяин молчит ещё дважды — поражение по времени
  await call('POST', `/api/duels/${d1.id}/turn`, turn(4), B.token);
  clock += 24 * 3600_000 + 1000; await dapp.duels.tick();           // пропуск Хозяина №2
  await call('POST', `/api/duels/${d1.id}/turn`, turn(6), B.token);
  clock += 24 * 3600_000 + 1000;
  const t3 = await dapp.duels.tick();                                // №3 — конец
  d = (await call('GET', `/api/duels/${d1.id}`, null, A.token)).data.duel;
  const finA = msgsTo(7001).at(-1)?.params.text ?? '', finB = msgsTo(7002).at(-1)?.params.text ?? '';
  check('три пропуска подряд — поражение; итог бот пишет обоим',
    t3.lost === 1 && d.status === 'finished' && d.winner === 1 && d.reason === 'timeout'
      && /проиграна/.test(finA) && /Победа в партии против Хозяин/.test(finB), `${d.status} ${d.reason} | ${finA} | ${finB}`);

  // Ссылкой: чужой принимает по коду после первого хода; потом с ним можно реванш
  const link = (await call('POST', '/api/duels', { link: true }, A.token)).data.duel;
  await call('POST', `/api/duels/${link.id}/turn`, turn(1), A.token);
  const joined = await call('POST', '/api/duels/join', { code: link.code }, C.token);
  const joinedAgain = await call('POST', '/api/duels/join', { code: link.code }, B.token);
  check('по ссылке: код у создателя, принявший сразу ходит, второй раз ссылка не принимается',
    /^[A-Z2-9]{6}$/.test(link.code ?? '') && joined.status === 200 && joined.data.duel.myTurn === true
      && joined.data.duel.me === 1 && joined.data.duel.deadline > clock && joinedAgain.status === 404,
    `${link.code} ${joined.status} ${joinedAgain.status}`);
  // Итог боем: ходивший сообщает победителя — дуэль окончена, обоим итог
  const before = msgsTo(7001).length;
  const rA0 = ddb.prepare('select rating, wins, losses from player where id = ?').get(A.player.id);
  const rC0 = ddb.prepare('select rating, wins, losses from player where id = ?').get(C.player.id);
  r = await call('POST', `/api/duels/${link.id}/turn`, { ...turn(2), state: { turn: 2, team: 1, over: true, worms: [] }, over: true, winner: 1 }, C.token);
  check('последний ход с победой — дуэль окончена, проигравшему итог',
    r.data?.duel?.status === 'finished' && r.data.duel.winner === 1 && r.data.duel.reason === 'kill'
      && msgsTo(7001).slice(before).some((m) => /проиграна/.test(m.params.text)), JSON.stringify(r.data?.duel));
  {
    const rA1 = ddb.prepare('select rating, wins, losses from player where id = ?').get(A.player.id);
    const rC1 = ddb.prepare('select rating, wins, losses from player where id = ?').get(C.player.id);
    const d = r.data.duel;
    const lostMsg = msgsTo(7001).slice(before).map((m) => m.params.text).join(' | ');
    check('дуэль по переписке на рейтинг: победителю +, проигравшему −, счёт побед; в итоге и в сообщении',
      d.delta > 0 && rC1.rating === rC0.rating + d.delta && rA1.rating === rA0.rating - d.delta
        && rC1.wins === rC0.wins + 1 && rA1.losses === rA0.losses + 1 && /Рейтинг −\d+/.test(lostMsg),
      `${JSON.stringify(rA0)}→${JSON.stringify(rA1)} ${JSON.stringify(rC0)}→${JSON.stringify(rC1)} δ${d.delta} | ${lostMsg}`);
  }
  r = await call('POST', '/api/duels', { opponent: C.player.id }, A.token);
  check('с соперником по прошлой дуэли можно реванш, хоть он и не друг', r.status === 200, r.data?.error);

  // Вызов «позвал и ушёл»: создатель не ходит, первым ходит принявший, создателю — «твой ход»
  const inv = (await call('POST', '/api/duels', { link: true, theyFirst: true }, B.token)).data.duel;
  const early = await call('POST', `/api/duels/${inv.id}/turn`, turn(1), B.token);
  const accepted = await call('POST', '/api/duels/join', { code: inv.code }, C.token);
  const beforeB = msgsTo(7002).length;
  const first = await call('POST', `/api/duels/${inv.id}/turn`, turn(1), C.token);
  const nudge = msgsTo(7002).slice(beforeB).map((m) => m.params.text).join(' | ');
  check('вызов: пока не приняли — не «твой ход» и ходить нельзя; принявший ходит первым, позвавшему — «твой ход»',
    inv.invite === true && inv.myTurn === false && early.status === 409
      && accepted.data?.duel?.me === 0 && accepted.data.duel.myTurn === true
      && first.status === 200 && /Твой ход против Чужой/.test(nudge),
    `${JSON.stringify(inv)} ${early.status} ${JSON.stringify(accepted.data?.duel)} ${first.status} ${nudge}`);

  // Сходил и тут же закрыл игру, а соперник ответил через секунды: «он же
  // смотрит» — сразу не пишем, но хода он не увидел — сообщение досылается
  await call('GET', `/api/duels/${inv.id}`, null, C.token);
  const toC0 = msgsTo(7003).length;
  await call('POST', `/api/duels/${inv.id}/turn`, turn(2), B.token);
  const quiet = msgsTo(7003).length === toC0;
  clock += 50_000;
  const lateTick = await dapp.duels.tick();
  const lateMsg = msgsTo(7003).slice(toC0).map((m) => m.params.text).join(' | ');
  const lateAgain = await dapp.duels.tick();
  check('«твой ход» досылается, если игрок ушёл, не увидев ход соперника; один раз',
    quiet && lateTick.late === 1 && /Твой ход против Гость/.test(lateMsg) && lateAgain.late === 0
      && msgsTo(7003).length === toC0 + 1, `${quiet} ${JSON.stringify(lateTick)} ${lateMsg}`);

  // Пришёл в игру по ссылке на шахматную партию — тоже приглашение: обоим по коробке
  {
    const inv2 = (await call('POST', '/api/duels', { link: true, theyFirst: true }, B.token)).data.duel;
    const fresh = (await call('POST', '/api/telegram', { initData: await signInitData({
      query_id: 'q', user: { id: 7099, first_name: 'Новичок' }, auth_date: String(Math.floor(clock / 1000)), start_param: `duel_${inv2.code}`,
    }, BOT) })).data;
    await new Promise((res) => setTimeout(res, 150));   // сообщение позвавшему уходит без ожидания
    const row = ddb.prepare('select referred_by from player where id = ?').get(fresh.player.id);
    const gifts = ddb.prepare("select player_id, reason from bonus where ref = ? or player_id = ?").all(fresh.player.id, fresh.player.id);
    const hostMsg = msgsTo(7002).map((m) => m.params.text).filter((t) => /по твоему приглашению/.test(t)).join(' | ');
    check('новичок по ссылке на партию — приглашённый: обоим по коробке, позвавшему сообщение',
      row?.referred_by === B.player.id && gifts.some((g) => g.reason === 'ref-host') && gifts.some((g) => g.reason === 'ref-guest')
        && /по твоему приглашению/.test(hostMsg), `${JSON.stringify(row)} ${JSON.stringify(gifts)} ${hostMsg}`);
    await call('POST', '/api/duels/join', { code: inv2.code }, fresh.token);
    await call('POST', `/api/duels/${inv2.id}/resign`, null, B.token);
  }

  // /duellog: разбор дуэли по ходам — чем стрелял, куда пришёл взрыв, здоровье
  {
    const lg = (await call('POST', '/api/duels', { link: true, theyFirst: true }, A.token)).data.duel;
    await call('POST', '/api/duels/join', { code: lg.code }, C.token);
    const st = (n, hp) => ({ turn: n + 1, team: n % 2, worms: [{ x: 1, y: 2, hp: hp[0], alive: true }, { x: 5, y: 2, hp: hp[1], alive: true }] });
    await call('POST', `/api/duels/${lg.id}/turn`, { turn: 1, hash: 'a', state: st(1, [100, 64]), cmds: [
      { k: 'shot', at: 100, cmd: { type: 'shot', turn: 1, worm: 0, vx: 1, vy: 1, weapon: 0 } },
      { k: 'boom', at: 900, x: 5, y: 2, r: 72, hits: [[1, 36]], near: 12 }] }, C.token);
    await call('POST', `/api/duels/${lg.id}/turn`, { turn: 2, hash: 'b', state: st(2, [100, 64]), cmds: [
      { k: 'shot', at: 100, cmd: { type: 'shot', turn: 2, worm: 1, vx: 1, vy: 1, weapon: 17 } },
      { k: 'boom', at: 900, x: 300, y: 2, r: 72, hits: [], near: 140 }] }, A.token);
    await hook({ message: { from: { id: 7001, first_name: 'Хозяин' }, chat: { id: 7001, type: 'private' }, text: `/duellog ${lg.id}` } });
    const text = msgsTo(7001).at(-1)?.params.text ?? '';
    check('/duellog: по ходам — оружие, взрыв (задел или мимо) и здоровье с разницей',
      /1\. Чужой: базука → задел #1 −36/.test(text) && /HP 100\/64/.test(text)
        && /2\. Хозяин: самонаводка → мимо \(до бойца 140px, радиус 72\)/.test(text), text);
    const stranger = msgsTo(7003).length;
    await hook({ message: { from: { id: 7003, first_name: 'Чужой' }, chat: { id: 7003, type: 'private' }, text: `/duellog ${lg.id}` } });
    check('/duellog — только админу', !/Дуэль \d+:/.test(msgsTo(7003).slice(stranger).map((m) => m.params.text).join()));
    await call('POST', `/api/duels/${lg.id}/resign`, null, A.token);
  }

  // Сдаться: дуэль соперника, пишем только ему. Ночью — без звука
  clock = Date.UTC(2026, 10, 27, 21, 30);           // 00:30 МСК
  const rev = r.data.duel;
  await call('POST', `/api/duels/${rev.id}/turn`, turn(1), A.token);
  const night = msgsTo(7003).at(-1)?.params;
  const toCbefore = msgsTo(7003).length, toAbefore = msgsTo(7001).length;
  r = await call('POST', `/api/duels/${rev.id}/resign`, {}, A.token);
  check('ночью «твой ход» приходит без звука', night?.disable_notification === true && /твой ход/i.test(night.text));
  check('сдался — победа сопернику, итог пишем только ему',
    r.data?.duel?.status === 'finished' && r.data.duel.winner === 1 && r.data.duel.reason === 'resign'
      && msgsTo(7003).length === toCbefore + 1 && msgsTo(7001).length === toAbefore, JSON.stringify(r.data?.duel));

  // /mute: о дуэлях бот молчит
  await hook({ message: { from: { id: 7002, first_name: 'Гость' }, chat: { id: 7002, type: 'private' }, text: '/mute' } });
  clock = Date.UTC(2026, 10, 28, 10, 0);
  const d2 = (await call('POST', '/api/duels', { opponent: B.player.id }, A.token)).data.duel;
  const toBmuted = msgsTo(7002).length;
  await call('POST', `/api/duels/${d2.id}/turn`, turn(1), A.token);
  check('после /mute «твой ход» не приходит', msgsTo(7002).length === toBmuted);

  // Не больше пяти идущих дуэлей у игрока
  const made = [];
  for (let i = 0; i < 6; i++) made.push((await call('POST', '/api/duels', { link: true }, A.token)).status);
  const list = (await call('GET', '/api/duels', null, A.token)).data;
  check('идущих дуэлей не больше 5: шестая — отказ', made.filter((s) => s === 200).length === 4 && made.at(-1) === 409
    && list.items.filter((x) => ['open', 'active'].includes(x.status)).length === 5, made.join(','));
  clock = realNow;
  dsrv.close();
  ddb.close();
}

// Клип из Android приходит WebM — сервер с ffmpeg отдаёт MP4 (Telegram берёт в сторис только его)
{
  const { spawnSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const src = `${mediaDir}/in.webm`;
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '0.6', '-c:v', 'libvpx', src]);
  if (made.status === 0) {
    const T = (await call('POST', '/api/telegram', { initData: await signed({ id: 4243, first_name: 'Клип' }) })).data?.token;
    const up = await fetch(`${base}/api/media`, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'video/webm' }, body: readFileSync(src) });
    const r = await up.json();
    const got = await fetch(`${base}${r.path}?dl=1`);
    check('клип: WebM перекодирован в MP4 и отдаётся на скачивание',
      r.ext === 'mp4' && got.status === 200 && got.headers.get('content-type') === 'video/mp4'
        && /attachment/.test(got.headers.get('content-disposition')), JSON.stringify(r));
  }
}

server.close();
fakeTg.close();
db.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nпроверки сервера пройдены');
