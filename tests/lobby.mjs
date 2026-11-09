/**
 * Лобби и подбор соперника.
 *
 *   node tests/lobby.mjs http://127.0.0.1:5187
 *
 * Два браузера заходят в лобби, оба жмут «Быстрый бой» и обязаны сойтись
 * в одной комнате — без сервера, без арбитра и не договариваясь. Здесь же
 * проверяется рейтинг: он двигается только за сетевой бой и на одинаковое
 * число очков у обеих сторон.
 *
 * Сообщения ходят через сам тест (window.WORMS_TRANSPORT), как в net.mjs:
 * проверяется логика лобби, а не транспорт.
 */
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173';
const LAG = 40;

const failures = [];
const errors = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const launch = () => chromium.launch(
  launchOptions(),
);

const browsers = [await launch(), await launch()];
const pages = [];

for (let i = 0; i < 2; i++) {
  const page = await browsers[i].newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`[${i}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) {
      errors.push(`[${i}] console: ${t}`);
    }
  });

  // Транспорт общий на все каналы: лобби и партия разведены по комнате,
  // как и в настоящем сервисе.
  await page.exposeFunction('__netOut', (room, msg) => {
    setTimeout(() => {
      pages[1 - i]?.evaluate(([r, m]) => globalThis.__netIn?.(r, m), [room, msg])
        .catch(() => {});
    }, LAG);
  });
  await page.addInitScript(() => {
    globalThis.__inboxes = new Map();
    globalThis.__netIn = (room, msg) => globalThis.__inboxes.get(room)?.(msg);
    globalThis.WORMS_TRANSPORT = () => ({
      id: `p${Math.random().toString(36).slice(2, 8)}`,
      async connect(room, onMessage) {
        this.room = room;
        globalThis.__inboxes.set(room, onMessage);
      },
      send(msg) { globalThis.__netOut(this.room, { ...msg, from: this.id }); },
      close() { globalThis.__inboxes.delete(this.room); },
    });
    // Имена и рейтинги разводим, чтобы видеть, что именно передалось.
    // Разброс держим внутри стартового коридора подбора: расширение
    // коридора со временем проверяет tests/match.mjs, и заставлять этот
    // набор ждать лишние секунды незачем.
    localStorage.setItem('worms.player.v1', JSON.stringify({
      id: `test${Math.random().toString(36).slice(2, 7)}`,
      name: `Тестовый ${Math.floor(Math.random() * 90 + 10)}`,
      rating: 1000 + Math.floor(Math.random() * 80),
      wins: 0, losses: 0,
    }));
  });

  await page.goto(`${URL}/?biome=forest`, { waitUntil: 'domcontentloaded' });
  pages.push(page);
}
const [A, B] = pages;

const menuReady = (p) => p.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Menu')
    && Object.keys(window.__WORMS__.scene.getScene('Menu').buttons).length > 0,
  null, { timeout: 40000 },
);
await Promise.all(pages.map(menuReady));

const menu = (p) => p.evaluate(() => window.__WORMS__.scene.getScene('Menu'));
const call = (p, fn) => p.evaluate(fn);

// --- лобби видит соседа ---
await Promise.all(pages.map((p) => call(p, () => {
  window.__WORMS__.scene.getScene('Menu').showOnline();
})));
const seen = await Promise.all(pages.map((p) => p.waitForFunction(
  () => (window.__WORMS__.scene.getScene('Menu').lobby?.list().length ?? 0) > 0,
  null, { timeout: 20000 },
).then(() => true).catch(() => false)));
check('игроки видят друг друга в лобби', seen.every(Boolean), seen.join(', '));

const rosters = await Promise.all(pages.map((p) => call(p, () => {
  const l = window.__WORMS__.scene.getScene('Menu').lobby;
  return { me: l.me.name, peers: l.list().map((x) => `${x.name}:${x.rating}`) };
})));
check('в списке видно имя и рейтинг соседа',
  rosters[0].peers.length === 1 && /:\d{3,4}$/.test(rosters[0].peers[0]),
  rosters.map((r) => `${r.me} видит ${r.peers.join(',') || '—'}`).join(' | '));

// --- открытые игры: A создаёт стол, B видит его и входит ---
const hostId = await A.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.createGame();
  return m.lobby.me.id;
});
const tableSeen = await B.waitForFunction(
  (id) => {
    const m = window.__WORMS__.scene.getScene('Menu');
    return m.lobby?.tables().some((t) => t.id === id) && Boolean(m.buttons[`join-${id}`]);
  }, hostId, { timeout: 20000 },
).then(() => true).catch(() => false);
check('созданная игра видна соседу как стол с кнопкой «Войти»', tableSeen);
const hostState = await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').lobby.state);
check('хозяин ждёт за столом', hostState === 'hosting', hostState);

await B.evaluate((id) => window.__WORMS__.scene.getScene('Menu').joinTable(id), hostId);
const bothIn = await Promise.all(pages.map((p) => p.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game')
    && window.__WORMS__.scene.getScene('Game').net?.connected === true,
  null, { timeout: 40000 },
).then(() => true).catch(() => false)));
check('«Войти» отправляет в комнату обоих и они соединяются', bothIn.every(Boolean), bothIn.join(', '));
const tableRooms = await Promise.all(pages.map((p) => call(p,
  () => window.__WORMS__.scene.getScene('Game').room)));
check('комната одна и та же', tableRooms[0] && tableRooms[0] === tableRooms[1], tableRooms.join(' / '));
const busy = await Promise.all(pages.map((p) => call(p,
  () => window.__WORMS__.registry.get('lobby')?.state)));
check('в бою оба помечены «играет», стол пропал из лобби', busy.every((x) => x === 'playing'), busy.join(', '));

// Обратно в меню — лобби снова свободно, дальше проверяем быстрый бой
await Promise.all(pages.map((p) => call(p, () => window.__WORMS__.scene.getScene('Game').toMenu())));
await Promise.all(pages.map(menuReady));
await Promise.all(pages.map((p) => call(p, () => window.__WORMS__.scene.getScene('Menu').showOnline())));
const freed = await Promise.all(pages.map((p) => call(p, () => window.__WORMS__.registry.get('lobby')?.state)));
check('вернулись в меню — лобби свободно', freed.every((x) => x === 'idle'), freed.join(', '));

// --- быстрый бой сводит обоих в одну комнату ---
await Promise.all(pages.map((p) => call(p, () => {
  window.__WORMS__.scene.getScene('Menu').startSearch();
})));

const started = await Promise.all(pages.map((p) => p.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game')
    && window.__WORMS__.scene.getScene('Game').turn?.activeWorm && !window.__WORMS__.scene.getScene('Game').landing(),
  null, { timeout: 40000 },
).then(() => true).catch(() => false)));
check('подбор развёл обоих в бой', started.every(Boolean), started.join(', '));

const rooms = await Promise.all(pages.map((p) => call(p,
  () => window.__WORMS__.scene.getScene('Game').room)));
check('комната у обоих одна', rooms[0] && rooms[0] === rooms[1], rooms.join(' / '));

// --- партия действительно связалась ---
const paired = await Promise.all(pages.map((p) => p.waitForFunction(
  () => window.__WORMS__.scene.getScene('Game').net?.connected === true,
  null, { timeout: 30000 },
).then(() => true).catch(() => false)));
check('соперники соединились', paired.every(Boolean), paired.join(', '));

const info = () => Promise.all(pages.map((p) => call(p, () => {
  const s = window.__WORMS__.scene.getScene('Game');
  return {
    team: s.net.myTeam,
    seed: s.seed,
    opponent: s.net.opponent?.name ?? null,
    oppRating: s.net.opponent?.rating ?? null,
    rating: JSON.parse(localStorage.getItem('worms.player.v1')).rating,
  };
})));
let st = await info();
check('стороны разные и зерно общее',
  st[0].team !== st[1].team && st[0].seed === st[1].seed,
  `команды ${st[0].team}/${st[1].team}, зерно ${st[0].seed}`);
check('каждый знает имя и рейтинг соперника',
  Boolean(st[0].opponent && st[1].opponent && st[0].oppRating && st[1].oppRating),
  `${st[0].opponent} (${st[0].oppRating}) ↔ ${st[1].opponent} (${st[1].oppRating})`);

// --- рейтинг за победу ---
const before = st.map((x) => x.rating);
await A.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  // Выбиваем команду соперника того, кто смотрит: победа достаётся
  // владельцу этой вкладки
  const foe = s.net.myTeam === 0 ? 1 : 0;
  s.worms.filter((w) => w.team === foe).forEach((w) => w.damage(999));
});
await A.waitForFunction(
  () => window.__WORMS__.scene.getScene('Game').turn.state === 'over',
  null, { timeout: 40000 },
);
await A.waitForTimeout(600);
const afterA = await A.evaluate(
  () => JSON.parse(localStorage.getItem('worms.player.v1')));
check('победа поднимает рейтинг и счёт побед',
  afterA.rating > before[0] && afterA.wins === 1,
  `${before[0]} → ${afterA.rating}, побед ${afterA.wins}`);

// --- без рейтинга: свои столы, своя очередь, рейтинг не трогаем ---
await Promise.all(pages.map((p) => call(p, () => window.__WORMS__.scene.getScene('Game').toMenu())));
await Promise.all(pages.map(menuReady));
await Promise.all(pages.map((p) => call(p, () => window.__WORMS__.scene.getScene('Menu').showOnline())));

// A открывает стол без рейтинга: в рейтинговой вкладке B его нет, в другой — есть
await A.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.onlineQueue = 'casual';
  m.createGame();
});
const casualTable = await B.waitForFunction((id) => {
  const l = window.__WORMS__.scene.getScene('Menu').lobby;
  return l?.tables('casual').some((t) => t.id === id) ? true : null;
}, hostId, { timeout: 20000 }).then(() => true).catch(() => false);
const ratedTables = await B.evaluate((id) => window.__WORMS__.scene.getScene('Menu').lobby.tables('rated')
  .some((t) => t.id === id), hostId);
const casualRoom = await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').lobby.room);
check('стол без рейтинга — только во вкладке «Без рейтинга»', casualTable && !ratedTables && /^Z/.test(casualRoom),
  `комната ${casualRoom}`);
await A.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.hosting = null;
  m.lobby.unhost();
  m.showOnline();
});

// Рейтинги далеко друг от друга: на рейтинг их сразу не свело бы
await Promise.all(pages.map((p, i) => p.evaluate(async (r) => {
  const { player } = await import('/src/platform/player.js');
  player().rating = r;
}, i === 0 ? 1900 : 1000)));

// A ищет без рейтинга — B видит «сейчас ищут 1» под «Быстрым боем»
await B.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.onlineQueue = 'casual';
  m.showOnline();
});
await A.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.onlineQueue = 'casual';
  m.startSearch();
});
const counter = await B.waitForFunction(() => {
  const t = window.__WORMS__.scene.getScene('Menu').buttonTexts?.quickmatch?.sub?.text ?? '';
  return t.includes('сейчас ищут 1') ? t : null;
}, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
check('под «Быстрым боем» видно, сколько ищут', Boolean(counter), counter ?? 'счётчика нет');
const ratedCounter = await B.evaluate(() => window.__WORMS__.scene.getScene('Menu').lobby.searchingCount('rated'));
const searchLine = await A.waitForFunction(() => {
  const t = window.__WORMS__.scene.getScene('Menu').searchCount?.text ?? '';
  return t ? t : null;
}, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(async () => A.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  return `нет строки: section=${m.section === m.startSearch}, ticker=${Boolean(m.searchTicker)}, lobby=${m.lobby?.state}`;
}));
check('ищущий без рейтинга не считается в рейтинговой очереди', ratedCounter === 0, `рейтинг: ${ratedCounter}`);
check('на экране поиска — «Сейчас ищут: N»', /Сейчас ищут: 1/.test(searchLine ?? ''), searchLine);

const t0 = Date.now();
await B.evaluate(() => window.__WORMS__.scene.getScene('Menu').startSearch());
const casualIn = await Promise.all(pages.map((p) => p.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game') && window.__WORMS__.scene.getScene('Game').net?.connected === true,
  null, { timeout: 40000 },
).then(() => true).catch(() => false)));
const casualRooms = await Promise.all(pages.map((p) => call(p, () => window.__WORMS__.scene.getScene('Game').room)));
check('без рейтинга сводит сразу, несмотря на разницу 900',
  casualIn.every(Boolean) && casualRooms[0] === casualRooms[1] && /^Z/.test(casualRooms[0]) && Date.now() - t0 < 20000,
  `${casualRooms.join(' / ')} за ${Math.round((Date.now() - t0) / 1000)} с`);

await Promise.all(pages.map((p) => p.waitForFunction(
  () => { const s = window.__WORMS__.scene.getScene('Game'); return s.turn?.activeWorm && !s.landing(); },
  null, { timeout: 40000 },
)));
const beforeCasual = await A.evaluate(() => JSON.parse(localStorage.getItem('worms.player.v1')));
await A.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  const foe = s.net.myTeam === 0 ? 1 : 0;
  s.worms.filter((w) => w.team === foe).forEach((w) => w.damage(999));
});
await A.waitForFunction(() => window.__WORMS__.scene.getScene('Game').turn.state === 'over', null, { timeout: 40000 });
await A.waitForTimeout(600);
const afterCasual = await A.evaluate(() => JSON.parse(localStorage.getItem('worms.player.v1')));
const overText = await A.evaluate(() => window.__WORMS__.scene.getScene('Game').children.list
  .filter((o) => o.type === 'Text').map((o) => o.text).join(' | '));
check('победа без рейтинга не меняет ни рейтинг, ни счёт',
  afterCasual.rating === beforeCasual.rating && afterCasual.wins === beforeCasual.wins
    && overText.includes('бой без рейтинга'),
  `${beforeCasual.rating} → ${afterCasual.rating}, побед ${afterCasual.wins}`);

check('нет ошибок в консоли', errors.length === 0, errors.slice(0, 4).join(' | '));

await Promise.all(browsers.map((b) => b.close()));
console.log(failures.length
  ? `\nПРОВАЛЕНО: ${failures.length} — ${failures.join(', ')}`
  : '\nпроверки лобби пройдены');
process.exit(failures.length ? 1 : 0);
