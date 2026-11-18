/**
 * Мини-приложение целиком, как его увидят игроки в Telegram.
 *
 *   node tests/tgapp.mjs
 *
 * Свой сервер с базой в памяти и токеном бота, свой поддельный Telegram
 * для бота, два браузера с поддельным Telegram.WebApp, у которого initData
 * подписан тем же токеном, — то есть вход идёт настоящей проверкой подписи.
 *
 * Путь: вход сам → кабинет → турнир (админ создаёт командой бота) → оба
 * записываются → старт → «Играть матч» уводит обоих в одну комнату →
 * бой → итог засчитан в сетке → чемпион в кабинете. Плюс экран-заглушка
 * для обычного браузера и поддержка звёздами.
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { openDb } from '../server/db.mjs';
import { createApp } from '../server/index.mjs';
import { signInitData } from '../server/lib/telegram.js';
import { hashPassword } from '../server/lib/accounts.js';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// --- поддельный Telegram для бота ---
const tgCalls = [];
const fakeTg = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    tgCalls.push({ method, params: body ? JSON.parse(body) : {} });
    const result = {
      getMe: { username: 'worms_test_bot' }, createInvoiceLink: 'https://t.me/$inv',
      savePreparedInlineMessage: { id: 'prep-1', expiration_date: 0 },
    }[method] ?? true;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => fakeTg.listen(0, '127.0.0.1', r));

const BOT = '424242:app-test-token';
const ADMIN = 100;
const db = openDb(':memory:');
const app = createApp({
  db, botToken: BOT, adminIds: [ADMIN], staticDir: process.cwd(), publicUrl: 'https://example.test/worms',
  telegramApiBase: `http://127.0.0.1:${fakeTg.address().port}`, log: { warn() {}, log() {}, error: console.error },
});
const server = createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}`;

const browsers = [await chromium.launch(launchOptions()), await chromium.launch(launchOptions())];
const errors = [];
const pages = [];

/** Страница «внутри Telegram»: подписанный initData, мост сети между двумя страницами. */
async function tgPage(i, user, { gateOnly = false } = {}) {
  const page = await browsers[i].newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.on('pageerror', (e) => errors.push(`[${i}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`[${i}] ${t}`);
  });
  await page.route('**/telegram-web-app.js', (r) => r.abort());
  if (gateOnly) {
    await page.addInitScript(() => { globalThis.WORMS_TELEGRAM_ONLY = true; });
  } else {
    const initData = await signInitData({ query_id: 'q', user, auth_date: String(Math.floor(Date.now() / 1000)) }, BOT);
    await page.exposeFunction('__netOut', (room, msg) => {
      setTimeout(() => pages[1 - i]?.evaluate(([r, m]) => globalThis.__netIn?.(r, m), [room, msg]).catch(() => {}), 30);
    });
    await page.addInitScript(({ initData, user }) => {
      const haptics = [];
      globalThis.Telegram = { WebApp: {
        version: '8.0', platform: 'ios', initData,
        initDataUnsafe: { user },
        safeAreaInset: {}, contentSafeAreaInset: {},
        isVersionAtLeast: () => true,
        ready() {}, expand() {}, requestFullscreen() {}, lockOrientation() {}, unlockOrientation() {},
        disableVerticalSwipes() {}, setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {},
        onEvent() {}, offEvent() {},
        checkHomeScreenStatus(cb) { cb('missed'); }, addToHomeScreen() {},
        requestWriteAccess(cb) { cb(true); },
        openInvoice(link, cb) { globalThis.__invoices = [...(globalThis.__invoices ?? []), link]; cb('paid'); },
        shareMessage(id) { globalThis.__shared = [...(globalThis.__shared ?? []), id]; },
        HapticFeedback: {
          impactOccurred: (k) => haptics.push(`impact:${k}`),
          notificationOccurred: (k) => haptics.push(`note:${k}`),
          selectionChanged: () => haptics.push('select'),
        },
        CloudStorage: { getItem(k, cb) { cb(null, ''); }, setItem(k, v, cb) { cb?.(null, true); } },
        __haptics: haptics,
      } };
      globalThis.__inboxes = new Map();
      globalThis.__netIn = (room, msg) => globalThis.__inboxes.get(room)?.(msg);
      globalThis.WORMS_TRANSPORT = () => ({
        id: `p${Math.random().toString(36).slice(2, 8)}`,
        async connect(room, onMessage) { this.room = room; globalThis.__inboxes.set(room, onMessage); },
        send(msg) { globalThis.__netOut(this.room, { ...msg, from: this.id }); },
        close() { globalThis.__inboxes.delete(this.room); },
      });
    }, { initData, user });
  }
  await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
  return page;
}

const menuReady = (p) => p.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu')
  && window.__WORMS__.scene.getScene('Menu').buttons.tournaments, null, { timeout: 30000 });

// --- обычный браузер при TELEGRAM_ONLY: заглушка со ссылкой на бота ---
{
  const gate = await tgPage(0, null, { gateOnly: true });
  await gate.waitForSelector('#gate a', { timeout: 15000 }).catch(() => {});
  const g = await gate.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('gate')).display !== 'none',
    href: document.querySelector('#gate a')?.href ?? null,
    game: Boolean(window.__WORMS__),
  }));
  check('вне Telegram — заглушка со ссылкой на бота, игра не грузится',
    g.shown && /^https:\/\/t\.me\/\w+$/.test(g.href ?? '') && !g.game, JSON.stringify(g));
  await gate.close();
}

// --- вход и кабинет ---
const A = await tgPage(0, { id: ADMIN, first_name: 'Админ', photo_url: 'https://example.test/a.jpg' });
const B = await tgPage(1, { id: 200, first_name: 'Боря' });
pages.push(A, B);
await Promise.all([menuReady(A), menuReady(B)]);
await A.waitForFunction(() => JSON.parse(localStorage.getItem('worms.player.v1'))?.account === true, null, { timeout: 10000 });
await B.waitForFunction(() => JSON.parse(localStorage.getItem('worms.player.v1'))?.account === true, null, { timeout: 10000 });
const me = await A.evaluate(() => JSON.parse(localStorage.getItem('worms.player.v1')));
check('вход сам по подписи Telegram: имя, аватар, админ', me.id === `tg${ADMIN}` && me.name === 'Админ'
  && me.photo === 'https://example.test/a.jpg' && me.admin === true, `${me.id} ${me.name}`);
const rootKeys = await A.evaluate(() => Object.keys(window.__WORMS__.scene.getScene('Menu').buttons));
check('в меню турниры и кабинет, переключателя управления нет',
  rootKeys.includes('tournaments') && rootKeys.includes('account') && !rootKeys.includes('ui-mode'), rootKeys.join(','));

await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').openAccount());
await A.waitForSelector('.acc-box .acc-name');
const cab = await A.evaluate(() => ({
  name: document.querySelector('.acc-name')?.textContent,
  stats: [...document.querySelectorAll('.acc-stat span')].map((x) => x.textContent),
  history: document.querySelector('.ov-empty')?.textContent ?? '',
  buttons: [...document.querySelectorAll('.acc-btn')].map((b) => b.textContent),
}));
check('кабинет: имя, статистика, история, турниры, звёзды', cab.name === 'Админ' && cab.stats.includes('рейтинг')
  && cab.stats.includes('турниров выиграно') && cab.buttons.some((b) => /Поддержать/.test(b))
  && cab.buttons.some((b) => /Турниры/.test(b)), JSON.stringify(cab.buttons));
await A.click('text=⭐ Поддержать игру');
await A.click('text=50 ⭐');
await A.waitForFunction(() => /Спасибо/.test(document.querySelector('.acc-err')?.textContent ?? ''), null, { timeout: 5000 })
  .catch(() => {});
const inv = tgCalls.filter((c) => c.method === 'createInvoiceLink').at(-1)?.params;
check('поддержка звёздами: счёт XTR открыт окном Telegram', inv?.currency === 'XTR' && inv.prices[0].amount === 50
  && (await A.evaluate(() => globalThis.__invoices?.length)) === 1);
await A.keyboard.press('Escape');

// --- турнир ---
const t = app.tournaments.create({ name: 'Кубок вечера', size: 4 });
for (const p of [A, B]) {
  await p.evaluate(() => window.__WORMS__.scene.getScene('Menu').openTournaments());
  await p.waitForSelector('text=Кубок вечера', { timeout: 10000 });
  await p.click('text=Кубок вечера');
  await p.click('text=Записаться');
  await p.waitForSelector('text=Выйти из турнира', { timeout: 10000 });
}
check('оба записались через мини-приложение', app.tournaments.get(t.id, null).count === 2);
// Админ начинает кнопкой в игре: набралось двое из четырёх
await A.click('text=Начать сейчас');
for (const p of [A, B]) await p.waitForSelector('text=⚔️ Играть матч', { timeout: 15000 });
check('после старта у обоих карточка своего матча', true);
await Promise.all([A, B].map((p) => p.click('text=⚔️ Играть матч')));
const inGame = await Promise.all([A, B].map((p) => p.waitForFunction(() => {
  const s = window.__WORMS__?.scene.getScene('Game');
  return window.__WORMS__.scene.isActive('Game') && s?.net?.connected && s.turn?.activeWorm && !s.landing() ? s.room : null;
}, null, { timeout: 40000 }).then((h) => h.jsonValue()).catch(() => null)));
check('«Играть матч» сводит обоих в одну турнирную комнату', inGame[0] && inGame[0] === inGame[1] && /^T/.test(inGame[0]),
  inGame.join(' / '));

// Бой: A выбивает команду соперника — как в tests/net.mjs
await A.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  const foe = s.net.myTeam === 0 ? 1 : 0;
  const target = s.worms.find((w) => w.team === foe);
  // Взрыв рядом с соперником — короткая отдача в руку, как от попадания
  s.explode(target.x, target.centerY, { radius: 10, damageRadius: 40, damage: 10, knockback: 0, shake: 0 });
  s.worms.filter((w) => w.team === foe).forEach((w) => w.damage(999));
});
await Promise.all([A, B].map((p) => p.waitForFunction(
  () => window.__WORMS__.scene.getScene('Game').turn.state === 'over', null, { timeout: 40000 }).catch(() => {})));
await A.waitForTimeout(2500);
const tt = app.tournaments.get(t.id, null);
check('итог матча засчитан, турнир окончен, чемпион — победитель', tt.status === 'finished'
  && tt.winner?.id === `tg${ADMIN}`, `${tt.status}, чемпион ${tt.winner?.name}`);
const over = await A.evaluate(() => window.__WORMS__.scene.getScene('Game').children.list
  .filter((o) => o.type === 'Text').map((o) => o.text).join(' | '));
check('экран итога говорит о турнире, а не о рейтинге', /турнирный матч/.test(over) && !/рейтинг \d/.test(over));
const haptics = await A.evaluate(() => Telegram.WebApp.__haptics);
check('вибрация: нажатия, ход, попадание, победа', haptics.includes('impact:light') && haptics.includes('note:success')
  && haptics.some((h) => h === 'impact:rigid' || h === 'impact:heavy'), [...new Set(haptics)].join(','));

// Обратно в меню — сразу к сетке турнира
await A.evaluate(() => window.__WORMS__.scene.getScene('Game').toMenu());
await A.waitForSelector('text=все турниры', { timeout: 10000 }).catch(() => {});
const back = await A.evaluate(() => document.querySelector('.acc-box h2')?.textContent);
check('после матча меню открывает сетку того же турнира', back === 'Кубок вечера', back);
await A.keyboard.press('Escape');
await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').openAccount());
await A.waitForFunction(() => document.querySelectorAll('.ov-row').length > 0, null, { timeout: 8000 }).catch(() => {});
const champ = await A.evaluate(() => document.querySelector('.acc-box')?.innerText ?? '');
check('в кабинете чемпиона титул и матч турнира', /Чемпион «Кубок вечера»/.test(champ) && /Кубок вечера, раунд 1/.test(champ));

const startMsgs = tgCalls.filter((c) => c.method === 'sendMessage' && /соперник/.test(c.params.text));
check('бот написал обоим о матче', startMsgs.length === 2);
// --- покупка коробки за звёзды: счёт, оплата, коробка в профиле ---
await A.keyboard.press('Escape');
await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').showSkins());
const shopBtn = await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').buttons['shop-box1']?.enabled);
check('в скинах есть магазин за звёзды', shopBtn === true);
const boxesBefore = await A.evaluate(() => JSON.parse(localStorage.getItem('worms.skins.v1') ?? '{}').boxes ?? 0);
const invBefore = tgCalls.filter((c) => c.method === 'createInvoiceLink').length;
A.evaluate(() => window.__WORMS__.scene.getScene('Menu')._buy('box1'));
await A.waitForFunction(() => (globalThis.__invoices ?? []).length > 0, null, { timeout: 10000 }).catch(() => {});
const shopInv = tgCalls.filter((c) => c.method === 'createInvoiceLink')[invBefore]?.params;
// Telegram сообщает боту об оплате — как настоящий, через вебхук
await app.bot.handleUpdate({ message: { from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' },
  successful_payment: { invoice_payload: shopInv?.payload, total_amount: shopInv?.prices?.[0]?.amount, telegram_payment_charge_id: 'tg-shop-1' } } });
const boxesAfter = await A.waitForFunction((b) => {
  const n = JSON.parse(localStorage.getItem('worms.skins.v1') ?? '{}').boxes ?? 0;
  return n > b ? n : false;
}, boxesBefore, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => boxesBefore);
check('коробка за звёзды: счёт на 25 ⭐, после оплаты коробка в профиле',
  shopInv?.prices?.[0]?.amount === 25 && boxesAfter === boxesBefore + 1, `${boxesBefore} → ${boxesAfter}`);

// --- вызов друга с главного экрана: карточка с кнопкой в комнату башни ---
await A.evaluate(() => {
  globalThis.WORMS_TG = { bot: 'worms_test_bot', app: 'game' };
  window.__WORMS__.scene.getScene('Menu').showRoot();
});
await A.waitForTimeout(300);
await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').challengeFriend());
const shared = await A.waitForFunction(() => globalThis.__shared?.length && globalThis.__shared, null, { timeout: 8000 })
  .then((h) => h.jsonValue()).catch(() => null);
const prep = tgCalls.filter((c) => c.method === 'savePreparedInlineMessage').at(-1)?.params;
check('«вызвать друга»: комната башни, карточка с кнопкой ушла в окно «поделиться»',
  Boolean(shared?.length) && /startapp=ZW/.test(prep?.result?.reply_markup?.inline_keyboard?.[0]?.[0]?.url ?? ''),
  JSON.stringify({ shared, url: prep?.result?.reply_markup?.inline_keyboard?.[0]?.[0]?.url }));

// --- башня дня: итог попытки уходит в таблицу, экран показывает место ---
const dailyBoard = await A.evaluate(async () => {
  const srv = await import('/src/net/server.js');
  const b0 = await srv.fetchDailyTower();
  await srv.submitDailyTower({ day: b0.day, won: true, turns: 5, hp: 140 });
  const m = window.__WORMS__.scene.getScene('Menu');
  await m.showDailyTower();
  return { day: b0.day, go: Boolean(m.buttons['daily-go']), mine: (await srv.fetchDailyTower()).me };
});
check('башня дня в Telegram: попытка в таблице, место на экране',
  dailyBoard.go && dailyBoard.mine?.place === 1 && dailyBoard.mine.turns === 5, JSON.stringify(dailyBoard));

// --- вход с сайта: тот же аккаунт и прогресс, что в Telegram ---
{
  // Прогресс из Telegram уходит на сервер с задержкой — даём ему доехать
  await A.waitForTimeout(2000);
  const tgBoxes = await A.evaluate(() => JSON.parse(localStorage.getItem('worms.skins.v1') ?? '{}').boxes ?? 0);
  db.prepare('update player set name_key = ?, pass_hash = ? where id = ?').run('admin.site', hashPassword('pw-12345'), `tg${ADMIN}`);
  const W = await browsers[1].newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  W.on('pageerror', (e) => errors.push(`[сайт] pageerror: ${e.message}`));
  await W.addInitScript(() => { globalThis.WORMS_TELEGRAM_ONLY = true; });
  await W.goto(URL, { waitUntil: 'domcontentloaded' });
  const gate = await W.waitForSelector('#gate-login', { state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  await W.fill('#gate-login input[name=login]', 'admin.site');
  await W.fill('#gate-login input[name=password]', 'wrong');
  await W.click('#gate-login button');
  const wrongMsg = await W.waitForFunction(() => document.querySelector('#gate .gate-error')?.textContent, null, { timeout: 8000 })
    .then((h) => h.jsonValue()).catch(() => '');
  await W.fill('#gate-login input[name=password]', 'pw-12345');
  await W.click('#gate-login button');
  await W.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
  const web = await W.evaluate(async () => {
    const { player } = await import('/src/platform/player.js');
    return { id: player().id, boxes: JSON.parse(localStorage.getItem('worms.skins.v1') ?? '{}').boxes ?? 0,
      gate: getComputedStyle(document.getElementById('gate')).display };
  });
  check('сайт: форма входа, неверный пароль — ошибка, верный — тот же аккаунт и прогресс из Telegram',
    gate && /неверный/.test(wrongMsg) && web.id === `tg${ADMIN}` && web.gate === 'none' && web.boxes === tgBoxes && tgBoxes > 0,
    JSON.stringify({ wrongMsg, ...web, tgBoxes }));
  await W.close();
}

check('нет ошибок в консоли', errors.length === 0, errors.slice(0, 4).join(' | '));

await Promise.all(browsers.map((b) => b.close()));
server.close();
fakeTg.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nпроверки мини-приложения пройдены');
