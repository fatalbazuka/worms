/**
 * Игра внутри Telegram Mini App.
 *
 *   node tests/telegram.mjs http://127.0.0.1:5187
 *
 * Настоящего Telegram в тесте нет: вместо SDK подставляется поддельный
 * window.Telegram.WebApp, который помнит, что у него вызывали, и отвечает
 * так, как отвечает клиент с Bot API 8.0. Проверяется всё, что игра
 * делает по-своему внутри Telegram:
 *   • личность и рейтинг берутся из аккаунта: имя из initData, рейтинг
 *     из CloudStorage, и облако главнее локальной копии;
 *   • игровое поле отступает от кнопок Telegram и от «чёлки»;
 *   • ссылка-приглашение ведёт в t.me, а «позвать друга» открывает
 *     родной выбор чата;
 *   • startapp=КОД из приглашения ведёт прямо в комнату;
 *   • «На экран Домой»: кнопка в меню, предложение после первой партии
 *     ровно один раз, и кнопка пропадает, когда иконка стоит.
 */
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173';

const failures = [];
const errors = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch(launchOptions());

/**
 * Страница «внутри Telegram». Подделка ставится до загрузки страницы,
 * а настоящий SDK с telegram.org не пускаем: он бы её перезаписал.
 */
async function openPage({ startParam = null, cloud = {}, local = null, viewport, old = false } = {}) {
  const page = await browser.newPage({
    viewport: viewport ?? { width: 932, height: 430 },   // iPhone в ландшафте
    hasTouch: true,
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`console: ${t}`);
  });
  await page.route('**/telegram-web-app.js', (r) => r.abort());

  await page.addInitScript(({ startParam, cloud, local, old }) => {
    const calls = [];
    const listeners = new Map();
    const store = new Map(Object.entries(cloud));
    const fire = (ev, data) => (listeners.get(ev) ?? []).forEach((fn) => fn(data));
    const WebApp = {
      version: '8.0',
      platform: 'ios',
      initData: 'query_id=test&user=%7B%22id%22%3A42%7D&hash=deadbeef',
      initDataUnsafe: {
        user: { id: 42, first_name: 'Тест', last_name: 'Телеграмов' },
        ...(startParam ? { start_param: startParam } : {}),
      },
      isFullscreen: false,
      // «Чёлка» слева/справа в ландшафте плюс кнопки Telegram сверху
      safeAreaInset: { top: 0, bottom: 21, left: 47, right: 47 },
      contentSafeAreaInset: { top: 46, bottom: 0, left: 0, right: 0 },
      isVersionAtLeast: (v) => Number(v.split('.')[0]) <= 8,
      ready() { calls.push('ready'); },
      expand() { calls.push('expand'); },
      requestFullscreen() { calls.push('requestFullscreen'); this.isFullscreen = true; fire('fullscreenChanged'); },
      lockOrientation() { calls.push('lockOrientation'); },
      unlockOrientation() { calls.push('unlockOrientation'); },
      disableVerticalSwipes() { calls.push('disableVerticalSwipes'); },
      setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {},
      onEvent(ev, fn) { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); },
      offEvent(ev, fn) { listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn)); },
      openTelegramLink(url) { calls.push(`openTelegramLink:${url}`); },
      checkHomeScreenStatus(cb) { calls.push('checkHomeScreenStatus'); setTimeout(() => cb(WebApp.__home), 30); },
      addToHomeScreen() {
        calls.push('addToHomeScreen');
        WebApp.__home = 'added';
        setTimeout(() => fire('homeScreenAdded'), 30);
      },
      __home: 'missed',
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      CloudStorage: {
        getItem(k, cb) { setTimeout(() => cb(null, store.get(k) ?? ''), 20); },
        setItem(k, v, cb) { store.set(k, String(v)); setTimeout(() => cb?.(null, true), 20); },
        __store: store,
      },
      __calls: calls,
      __fire: fire,
    };
    if (old) {
      // Клиент без Bot API 8.0: ни иконки, ни полного экрана
      WebApp.version = '7.0';
      delete WebApp.checkHomeScreenStatus;
      delete WebApp.addToHomeScreen;
      delete WebApp.requestFullscreen;
    }
    globalThis.Telegram = { WebApp };
    globalThis.WORMS_TG = { bot: 'worms_test_bot' };
    // Сервер рейтинга: настоящий из теста недоступен, отвечает заглушка,
    // которая помнит, что у неё спрашивали
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.__server = { calls: [] };
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      const reply = (body, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
      });
      // Свой сервер аккаунтов. Пока тест не включил его (__server.enabled),
      // он отвечает «вход через Telegram не настроен» — как сервер без
      // токена бота, — и профиль живёт на облаке Telegram.
      if (u.includes('/api/')) {
        const path = new URL(u, location.href).pathname;
        const body = opts.body ? JSON.parse(opts.body) : {};
        const auth = opts.headers?.authorization ?? null;
        const player = { id: 'tg42', name: 'Тест Телеграмов', rating: 1300, wins: 6, losses: 2, telegram: true, rank: 2 };
        globalThis.__server.calls.push({ path, auth, ...body });
        if (!globalThis.__server.enabled) return reply({ error: 'вход через Telegram не настроен' }, 503);
        if (path === '/api/telegram') return reply({ token: 'tok-tg42', player });
        if (path === '/api/me') return reply({ player });
        if (path === '/api/top') {
          return reply({ players: [
            { id: 'tg1', name: 'Оля', rating: 1510, wins: 20, losses: 4 },
            { id: 'tg42', name: 'Тест Телеграмов', rating: 1300, wins: 6, losses: 2 },
            { id: 'u77', name: 'Петя', rating: 990, wins: 3, losses: 9 },
          ] });
        }
        if (path === '/api/result') {
          return reply({ status: 'confirmed', delta: 12, player: { ...player, rating: 1312, wins: 7, rank: 2 } });
        }
        return reply({ error: 'нет такого адреса' }, 404);
      }
      return realFetch(url, opts);
    };
    if (local) localStorage.setItem('worms.player.v1', JSON.stringify(local));
    // Сеть здесь не проверяется: транспорт-пустышка, чтобы лобби и
    // комната не ломились в настоящий сервис
    globalThis.WORMS_TRANSPORT = () => ({
      id: `p${Math.random().toString(36).slice(2, 8)}`,
      async connect() {}, send() {}, close() {},
    });
  }, { startParam, cloud, local, old });

  await page.goto(`${URL}/?biome=forest&seed=777`, { waitUntil: 'domcontentloaded' });
  return page;
}

const menuReady = (p) => p.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Menu')
    && Object.keys(window.__WORMS__.scene.getScene('Menu').buttons).length > 0,
  null, { timeout: 40000 },
);
const gameReady = (p) => p.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game')
    && window.__WORMS__.scene.getScene('Game').turn?.activeWorm && !window.__WORMS__.scene.getScene('Game').landing(),
  null, { timeout: 40000 },
);
const calls = (p) => p.evaluate(() => [...Telegram.WebApp.__calls]);

// ================================================= запуск, профиль, отступы

const localProfile = { id: 'gold', name: 'Локальный', rating: 1000, wins: 0, losses: 0 };
const cloudProfile = { id: 'tg42', name: 'Тест Телеграмов', rating: 1234, wins: 5, losses: 2 };
const page = await openPage({
  local: localProfile,
  cloud: { 'worms.player.v1': JSON.stringify(cloudProfile) },
});
await menuReady(page);

const boot = await calls(page);
check('при запуске: ready, expand, полный экран; в меню ориентация свободна',
  ['ready', 'expand', 'requestFullscreen'].every((c) => boot.includes(c)) && !boot.includes('lockOrientation'),
  boot.join(', '));

const me = await page.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.showOnline();
  return JSON.parse(localStorage.getItem('worms.player.v1'));
});
check('имя и идентификатор — из аккаунта Telegram',
  me.id === 'tg42' && me.name === 'Тест Телеграмов', `${me.id} / ${me.name}`);
check('рейтинг — из облака, а не из локальной копии',
  me.rating === 1234 && me.wins === 5, `рейтинг ${me.rating}, побед ${me.wins}`);

const area = await page.evaluate(() => {
  const g = window.__WORMS__;
  const c = g.canvas.getBoundingClientRect();
  const m = g.scene.getScene('Menu');
  const k = c.width / g.scale.width;   // CSS-пикселей на логический
  const ui = m.uiCam;
  return {
    canvas: `${Math.round(c.width)}x${Math.round(c.height)}`,
    full: Math.abs(c.width - innerWidth) < 2 && Math.abs(c.height - innerHeight) < 2,
    // Вьюпорт интерфейса в CSS-пикселях от краёв экрана
    top: Math.round(ui.y * k), left: Math.round(ui.x * k),
    right: Math.round(innerWidth - (ui.x + ui.width) * k),
    bottom: Math.round(innerHeight - (ui.y + ui.height) * k),
    uiH: ui.height,
  };
});
check('канвас на весь экран, включая «чёлку» и полосу кнопок Telegram',
  area.full, area.canvas);
// Сверху рамки нет: кнопки Telegram сидят в углах, и отступают от них
// только края верхней панели боя. По бокам — «чёлка», снизу — полоска
check('интерфейс отступает от «чёлки» и снизу, но идёт до самого верха',
  area.top === 0 && Math.abs(area.left - 47) <= 1
    && Math.abs(area.right - 47) <= 1 && Math.abs(area.bottom - 21) <= 1 && area.uiH === 720,
  `сверху ${area.top}, слева ${area.left}, справа ${area.right}, снизу ${area.bottom}`);

// ------------------------------------------------------------ приглашение

const invite = await page.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.showRoom('ABC123');
  const link = m.inviteLink('ABC123');
  const b = m.buttons.copy;
  return { link, button: b ? { x: b.x, y: b.y } : null };
});
check('ссылка-приглашение ведёт в t.me с кодом комнаты',
  invite.link === 'https://t.me/worms_test_bot?startapp=ABC123', invite.link);

await page.evaluate(() => window.__WORMS__.scene.getScene('Menu').buttons.copy);
await tapButton(page, invite.button);
const shared = (await calls(page)).find((c) => c.startsWith('openTelegramLink:'));
check('«позвать друга» открывает родной выбор чата со ссылкой',
  Boolean(shared) && shared.includes('t.me/share/url') && shared.includes(encodeURIComponent(invite.link)),
  shared ?? 'не вызывалось');

// -------------------------------------------------------- на экран Домой

await page.evaluate(() => window.__WORMS__.scene.getScene('Menu').showRoot());
const homeBtn = await page.evaluate(() => window.__WORMS__.scene.getScene('Menu').buttons.home ?? null);
check('в меню есть кнопка «На экран Домой», пока иконки нет', Boolean(homeBtn));

// Первая партия: играем хотсит и завершаем — предложение должно всплыть
await page.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.showQuick();
});
await page.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  const b = m.buttons.hotseat;
  m.start({ mode: 'quick', teams: [{ worms: 2, control: 'human' }, { worms: 2, control: 'human' }], rules: {} });
  return b;
});
await gameReady(page);
await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.worms.filter((w) => w.team === 1).forEach((w) => w.damage(999));
});
const offered = await page.waitForFunction(
  () => Telegram.WebApp.__calls.includes('addToHomeScreen'), null, { timeout: 15000 },
).then(() => true).catch(() => false);
check('после первой доигранной партии Telegram предлагает иконку', offered);
const offeredFlag = await page.evaluate(() => Telegram.WebApp.CloudStorage.__store.get('worms.home.offered'));
check('отметка «уже предлагали» лежит в облаке', offeredFlag === '1', String(offeredFlag));

// Иконка поставлена → кнопка в меню пропадает
await page.evaluate(() => window.__WORMS__.scene.getScene('Game').toMenu());
await menuReady(page);
const homeAfter = await page.evaluate(() => window.__WORMS__.scene.getScene('Menu').buttons.home ?? null);
check('когда иконка стоит, кнопки в меню нет', homeAfter === null);

// Вторая партия — предложения быть не должно
const offersBefore = (await calls(page)).filter((c) => c === 'addToHomeScreen').length;
await page.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.start({ mode: 'quick', teams: [{ worms: 2, control: 'human' }, { worms: 2, control: 'human' }], rules: {} });
});
await gameReady(page);
await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.worms.filter((w) => w.team === 1).forEach((w) => w.damage(999));
});
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game').gameOverUi, null, { timeout: 15000 });
await page.waitForTimeout(2200);
const offersAfter = (await calls(page)).filter((c) => c === 'addToHomeScreen').length;
check('второй раз иконку не предлагают', offersAfter === offersBefore, `${offersBefore} → ${offersAfter}`);

// Результат боя ушёл в облако
const cloudAfter = await page.evaluate(() => JSON.parse(Telegram.WebApp.CloudStorage.__store.get('worms.player.v1')));
check('профиль пишется в облако', cloudAfter?.id === 'tg42', JSON.stringify(cloudAfter));

// -------------------------------------------------- сервер рейтинга

// Сервер с токеном бота: вход в аккаунт по подписи Telegram, без пароля.
// Дальше профиль и таблица — с сервера, итог боя уходит с токеном входа.
const srv = await page.evaluate(async () => {
  globalThis.__server.enabled = true;
  const m = await import('/src/net/server.js');
  await m.telegramLogin();
  window.__WORMS__.scene.getScene('Menu').showOnline();
  return {
    calls: globalThis.__server.calls,
    me: JSON.parse(localStorage.getItem('worms.player.v1')),
    token: JSON.parse(localStorage.getItem('worms.account.v1') ?? 'null')?.token,
  };
});
const tgCall = srv.calls.find((c) => c.path === '/api/telegram');
check('вход в аккаунт — по подписи Telegram, без пароля',
  Boolean(tgCall) && typeof tgCall.initData === 'string' && tgCall.initData.includes('hash=') && srv.token === 'tok-tg42',
  tgCall ? 'initData с подписью' : 'запроса не было');
check('числа сервера стали главными', srv.me.rating === 1300 && srv.me.wins === 6 && srv.me.account === true,
  `рейтинг ${srv.me.rating}, побед ${srv.me.wins}`);

await page.evaluate(() => window.__WORMS__.scene.getScene('Menu').showTop());
const top = await page.waitForFunction(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  return m.topRows?.length === 3 && m.items.some((o) => o.text === 'Оля') && m.items.some((o) => o.text === 'ты на 2 месте');
}, null, { timeout: 8000 }).then(() => true).catch(() => false);
check('таблица лидеров показывает игроков и моё место', top);

const rep = await page.evaluate(async () => {
  const srvMod = await import('/src/net/server.js');
  const res = await srvMod.reportResult({ room: 'ABC123', seed: 777, opponent: 'tg1', won: true });
  const call = globalThis.__server.calls.find((c) => c.path === '/api/result');
  return { res, call, me: JSON.parse(localStorage.getItem('worms.player.v1')) };
});
check('итог боя уходит серверу: комната, зерно, соперник, исход',
  rep.call?.room === 'ABC123' && rep.call.seed === 777 && rep.call.opponent === 'tg1' && rep.call.won === true
    && rep.call.auth === 'Bearer tok-tg42', JSON.stringify(rep.call ?? null).slice(0, 120));
check('подтверждённый бой переписывает рейтинг числами сервера',
  rep.res?.status === 'confirmed' && rep.me.rating === 1312 && rep.me.wins === 7,
  `рейтинг ${rep.me.rating}, побед ${rep.me.wins}`);

await page.close();

// ------------------------------------------------- запуск в портрете

// Меню и лобби живут в любой ориентации, держится только бой в ландшафте.
// lockOrientation фиксирует ТЕКУЩУЮ ориентацию, поэтому в портрете и в
// меню его звать нельзя — иначе повернуть будет невозможно.
const portrait = await openPage({ viewport: { width: 430, height: 932 } });
await menuReady(portrait);
let pc = await calls(portrait);
check('в портрете ориентация не фиксируется — можно повернуть',
  !pc.includes('lockOrientation') && pc.includes('unlockOrientation'), pc.join(', '));
const pm = await portrait.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  return { w: m.W, h: m.H, uiW: m.uiCam.width, uiH: m.uiCam.height };
});
check('меню в портрете: ширина 720, интерфейс на всю высоту',
  pm.w === 720 && pm.h > 1000 && pm.uiW === 720 && pm.uiH === pm.h, `${pm.w}x${pm.h}`);
await portrait.setViewportSize({ width: 932, height: 430 });
await portrait.waitForTimeout(700);
pc = await calls(portrait);
check('повернули в меню — ориентация всё ещё свободна', !pc.includes('lockOrientation'), pc.join(', '));
await portrait.evaluate(() => window.__WORMS__.scene.getScene('Menu').start({
  mode: 'quick', teams: [{ worms: 2, control: 'human' }, { worms: 2, control: 'human' }], rules: {},
}));
await gameReady(portrait);
pc = await calls(portrait);
check('начался бой в ландшафте — ориентация держится', pc.includes('lockOrientation'), pc.join(', '));

// После поворота (а это обычный путь: открыли в портрете, повернули) канвас
// обязан остаться экраном плюс рамка, а камера интерфейса — целиком внутри
// канваса. Раньше пересчёт ставил размер без рамки, и HUD резался справа
// и снизу.
const fit = await portrait.evaluate(() => {
  const g = window.__WORMS__;
  const s = g.scene.getScene('Game');
  const ui = s.rig.uiCam;
  const r = g.canvas.getBoundingClientRect();
  const fire = s.hud.buttons.fire;
  return {
    game: `${g.scale.width}x${g.scale.height}`, ui: `${ui.x},${ui.y} ${ui.width}x${ui.height}`,
    inside: ui.x + ui.width <= g.scale.width && ui.y + ui.height <= g.scale.height,
    full: Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2,
    fireOnScreen: fire ? (ui.x + fire.x) * (r.width / g.scale.width) < innerWidth
      && (ui.y + fire.y) * (r.height / g.scale.height) < innerHeight : false,
  };
});
check('после поворота канвас — экран плюс рамка, интерфейс внутри канваса',
  fit.inside && fit.full, `канвас ${fit.game}, интерфейс ${fit.ui}`);
const bar = await portrait.evaluate(() => {
  const g = window.__WORMS__;
  const s = g.scene.getScene('Game');
  const k = g.canvas.getBoundingClientRect().width / g.scale.width;
  return {
    uiTop: s.rig.uiCam.y,
    nameLeftCss: Math.round((s.rig.uiCam.x + s.hud.turnText.x) * k),
    windRightCss: Math.round(innerWidth - (s.rig.uiCam.x + s.hud.windText.x) * k),
  };
});
check('панель боя у самого верха, а её края отступают от кнопок Telegram',
  bar.uiTop === 0 && bar.nameLeftCss >= 47 + 130 && bar.windRightCss >= 47 + 130,
  `панель с ${bar.uiTop}, имя бойца в ${bar.nameLeftCss} CSS px от края, ветер в ${bar.windRightCss}`);
check('кнопка «Огонь» после поворота на экране', fit.fireOnScreen);
await portrait.evaluate(() => window.__WORMS__.scene.getScene('Game').toMenu());
await menuReady(portrait);
pc = await calls(portrait);
check('вышли в меню — отпущена', pc.lastIndexOf('unlockOrientation') > pc.lastIndexOf('lockOrientation'),
  pc.slice(-3).join(', '));
await portrait.close();

// ------------------------------------------- вход по ссылке-приглашению

const guest = await openPage({ startParam: 'ROOM42' });
const straight = await guest.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game') && window.__WORMS__.scene.getScene('Game').room === 'ROOM42',
  null, { timeout: 40000 },
).then(() => true).catch(() => false);
check('startapp=КОД ведёт прямо в комнату, минуя меню', straight);
const guestLink = await guest.evaluate(() => window.__WORMS__.scene.getScene('Game').inviteLink());
check('ссылка из партии — тоже t.me', guestLink === 'https://t.me/worms_test_bot?startapp=ROOM42', guestLink);
await guest.close();

// ------------------------------------------------------- старый клиент

const old = await openPage({ old: true });
await menuReady(old);
const oldHome = await old.evaluate(() => window.__WORMS__.scene.getScene('Menu').buttons.home ?? null);
check('старый клиент без иконки — кнопки нет и ничего не падает', oldHome === null);
await old.close();

await browser.close();

/** Тап по кнопке меню: координаты логические, переводим в экранные. */
async function tapButton(p, b) {
  if (!b) throw new Error('кнопки нет');
  const pt = await p.evaluate(([x, y]) => {
    const c = document.querySelector('#game canvas').getBoundingClientRect();
    const g = window.__WORMS__;
    const ui = g.scene.getScene('Menu').uiCam;   // интерфейс сдвинут на рамку
    return [c.left + ((ui.x + x) / g.scale.width) * c.width,
      c.top + ((ui.y + y) / g.scale.height) * c.height];
  }, [b.x, b.y]);
  await p.mouse.click(pt[0], pt[1]);
}

if (errors.length) {
  console.log('\nошибки страницы:');
  for (const e of errors) console.log('  ', e);
}
console.log(failures.length || errors.length
  ? `\nПРОВАЛ: ${[...failures, ...errors].length}` : '\nпроверки Telegram пройдены');
process.exit(failures.length || errors.length ? 1 : 0);
