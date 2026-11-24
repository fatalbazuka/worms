/**
 * Дуэль по переписке в двух браузерах: сходятся ли партии.
 *
 *   node tests/duel.mjs
 *
 * Главный риск дуэли — что у двух игроков получатся разные партии: каждый
 * собирает её у себя с зерна по истории ходов с сервера. Здесь двое (два
 * отдельных браузера, вход по подписи Telegram, как у игроков) по очереди
 * открывают дуэль по кнопке бота (?duel=ID), смотрят повтор хода соперника,
 * ходят сами — шагают и стреляют — и ход уходит на сервер. Один ход
 * пропущен по сроку. Проверяется:
 *   • свёртка итога каждого хода у того, кто его восстановил, та же, что у
 *     того, кто ходил (и сервер это подтверждает — seen_hash);
 *   • в конце оба браузера собирают всю дуэль заново — свёртки по ходам
 *     совпадают ход в ход;
 *   • партия не пустая: земля изрыта, здоровье убавилось;
 *   • ждущий видит ход соперника сам, без перезахода (опрос сервера).
 *
 * Сервер и поддельный Telegram — в этом же процессе, на одном порту
 * (DUEL_PORT, по умолчанию любой свободный).
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { openDb } from '../server/db.mjs';
import { createApp } from '../server/index.mjs';
import { signInitData } from '../server/lib/telegram.js';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const BOT = '515151:duel-test-token';
const tgCalls = [];
const db = openDb(':memory:');
let app = null;
// Поддельный Telegram — на том же порту, что и игра: /bot<токен>/<метод>
const server = createServer((req, res) => {
  if (!req.url.startsWith('/bot')) return app(req, res);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    tgCalls.push({ method: req.url.split('/').pop(), params: body ? JSON.parse(body) : {} });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  return undefined;
});
await new Promise((r) => server.listen(Number(process.env.DUEL_PORT) || 0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
app = createApp({
  db, botToken: BOT, staticDir: process.cwd(), publicUrl: 'https://example.test/worms',
  telegramApiBase: base, log: { warn() {}, log() {}, error: console.error },
});

const errors = [];
const diverged = [];
const browsers = [await chromium.launch(launchOptions()), await chromium.launch(launchOptions())];
const USERS = [{ id: 811, first_name: 'Аня' }, { id: 812, first_name: 'Боря' }];

/** Страница «в Telegram» у игрока i: подписанный initData, телефон в портрете. */
async function open(i, query = '') {
  const page = await browsers[i].newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.on('pageerror', (e) => errors.push(`[${i}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`[${i}] ${t}`);
    if (t.startsWith('[duel]')) diverged.push(`[${i}] ${t}`);
  });
  await page.route('**/telegram-web-app.js', (r) => r.abort());
  const user = USERS[i];
  const initData = await signInitData({ query_id: 'q', user, auth_date: String(Math.floor(Date.now() / 1000)) }, BOT);
  await page.addInitScript(({ initData, user }) => {
    globalThis.Telegram = { WebApp: {
      version: '8.0', platform: 'ios', initData, initDataUnsafe: { user },
      safeAreaInset: {}, contentSafeAreaInset: {}, isVersionAtLeast: () => true,
      ready() {}, expand() {}, requestFullscreen() {}, lockOrientation() {}, unlockOrientation() {},
      disableVerticalSwipes() {}, setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {},
      onEvent() {}, offEvent() {}, checkHomeScreenStatus(cb) { cb('missed'); }, addToHomeScreen() {},
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
      CloudStorage: { getItem(k, cb) { cb(null, ''); }, setItem(k, v, cb) { cb?.(null, true); } },
    } };
  }, { initData, user });
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
  return page;
}

const phase = (p) => p.evaluate(() => window.__WORMS__?.scene.getScene('Game')?.net?.phase ?? null);
// Таймауты с запасом: машина с тестами бывает загружена, и кадров тогда мало
const waitPhase = (p, want, timeout = 180000) => p.waitForFunction((w) => {
  const s = window.__WORMS__?.scene.getScene('Game');
  return s?.sys.isActive() && w.includes(s.net?.phase);
}, want, { timeout }).catch(async (e) => {
  // Не дождались — что на экране и в консоли, чтобы было с чего начать
  const at = await p.evaluate(() => {
    const g = window.__WORMS__?.scene;
    const s = g?.getScene('Game');
    return { menu: g?.isActive('Menu'), game: g?.isActive('Game'), phase: s?.net?.phase, turn: s?.turn?.state,
      n: s?.turn?.turnNumber, team: s?.turn?.currentTeam, dead: s?.net?.dead, now: s?.time?.now, rep: s?.replaying,
      proj: s?.projectiles?.length, rt: s?.turn?.resolveTimer, settled: s?.worms?.map((w) => w.settled),
      cmds: s?.net?.duel?.turns?.map((t) => t.cmds?.map((c) => c.k).join('')), fps: s?.game?.loop?.actualFps };
  }).catch(() => null);
  console.log('  не дождались фазы', want, JSON.stringify(at), errors.slice(-5).join(' | '));
  throw e;
});

/**
 * Свой ход: шаг к сопернику и прицельный выстрел — траектория подбирается
 * тем же просчётом полёта, что у бота (ai/ballistics.js): нужен настоящий
 * урон, иначе сверять было бы нечего. Ждём, пока ход уйдёт.
 */
async function playTurn(p, k) {
  await p.waitForFunction(() => window.__WORMS__.scene.getScene('Game').canPlayerAct(), null, { timeout: 120000 });
  await p.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    s.hud.setHelp?.(false);
    const w = s.turn.activeWorm;
    const e = s.worms.find((o) => o.alive && o.team !== w.team);
    s.moveInput[e && e.x < w.x ? 'left' : 'right'] = true;
  });
  await p.waitForTimeout(600);
  await p.evaluate(async (k) => {
    const { simulateShot, muzzle } = await import('/src/ai/ballistics.js');
    const s = window.__WORMS__.scene.getScene('Game');
    s.moveInput.left = false; s.moveInput.right = false;
    const w = s.turn.activeWorm;
    const foes = s.worms.filter((o) => o.alive && o.team !== w.team);
    let best = null;
    for (let a = -175; a <= -5; a += 5) {
      for (let v = 250; v <= 950; v += 50) {
        const dx = Math.cos(a * Math.PI / 180), dy = Math.sin(a * Math.PI / 180);
        const m = muzzle(s, w, dx, dy);
        const r = simulateShot(s, m.x, m.y, dx * v, dy * v, s.turn.weapon, w);
        const d = Math.min(...foes.map((f) => Math.hypot(f.x - r.x, f.centerY - r.y)))
          + (r.kind === 'worm' ? -100 : 0) + (r.kind === 'water' || r.kind === 'out' ? 1000 : 0);
        if (!best || d < best.d) best = { d, vx: dx * v, vy: dy * v };
      }
    }
    // Нечего подобрать (оружие без полёта) — просто в сторону соперника
    if (!best) best = { vx: (k % 2 ? 1 : -1) * 400, vy: -340 };
    s.fireActiveWorm(best.vx, best.vy);
  }, k);
  await p.waitForFunction(() => {
    const n = window.__WORMS__.scene.getScene('Game').net;
    return n.uploaded || n.phase === 'over';
  }, null, { timeout: 240000 });
  await p.waitForTimeout(300);
}

const checksOf = (p) => p.evaluate(() => window.__WORMS__.scene.getScene('Game').net.checks.map((c) => ({ ...c })));

// --- друзья: Боря пришёл по ссылке Ани ---
const pages = [await open(0), null];
await pages[0].waitForFunction(() => JSON.parse(localStorage.getItem('worms.player.v1') ?? 'null')?.account === true, null, { timeout: 30000 });
{
  const initData = await signInitData({ query_id: 'q', user: USERS[1], start_param: 'ref_811', auth_date: String(Math.floor(Date.now() / 1000)) }, BOT);
  await fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) });
}

// --- Аня вызывает Борю из топа друзей: позвала и ушла, первым ходит Боря ---
const A = pages[0];
await A.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 30000 });
await A.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  m.topFrom = 'tab';
  m.showTop('rating', 'friends');
});
await A.waitForFunction(() => Boolean(window.__WORMS__.scene.getScene('Menu').buttonHandlers?.['duel-tg812']), null, { timeout: 15000 });
await A.evaluate(() => window.__WORMS__.scene.getScene('Menu').buttonHandlers['duel-tg812']());
await A.waitForFunction(() => window.__WORMS__.scene.getScene('Menu').section === window.__WORMS__.scene.getScene('Menu').showDuels
  && /ходит первым/.test(window.__WORMS__.scene.getScene('Menu').duelNoteText?.text ?? ''), null, { timeout: 15000 });
const duelId = db.prepare("select id from duel where p1 = 'tg812' and p2 = 'tg811' order by id desc").get()?.id;
check('«Вызвать» у друга: дуэль создана, Боря ходит первым, Аня никого не ждёт (список дуэлей)', Number.isInteger(duelId), String(duelId));
const called = tgCalls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === 812 && /дуэл/.test(c.params.text));
check('Боре бот пишет «Аня вызывает на дуэль — твой ход первый» с кнопкой в дуэль', called.length === 1
  && /Аня вызывает тебя на дуэль/.test(called[0].params.text)
  && called[0].params.reply_markup.inline_keyboard[0][0].web_app.url.endsWith(`?duel=${duelId}`), called[0]?.params.text);
await A.close();
pages[0] = null;

// --- Боря открыл по кнопке бота и сходил; Ане бот пишет «твой ход» ---
pages[1] = await open(1, `?duel=${duelId}`);
await waitPhase(pages[1], ['play']);
// Ход «пропадал»: 25 секунд съедала загрузка истории и повтор соперника
const clock = await pages[1].evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { left: s.turn.timeLeft, full: s.turnTime };
});
check('дуэль: свой ход начинается с полными часами, на ход минута', clock.full === 60 && clock.left > 55, JSON.stringify(clock));
const arsenal = await pages[1].evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { ids: s.loadout, ammo: s.loadoutIdx.map((i) => s.turn.ammo[0][i] === s.turn.ammo[1][i] && s.turn.ammo[0][i] > 0) };
});
check('дуэль: арсенал боя — пять оружий сверх базовых, у обеих сторон поровну',
  arsenal.ids.length === 5 && arsenal.ammo.every(Boolean), JSON.stringify(arsenal));
// Часы стоят, пока игрок не тронул экран, и идут после первого касания
await pages[1].waitForTimeout(1500);
const idle = await pages[1].evaluate(() => window.__WORMS__.scene.getScene('Game').turn.timeLeft);
await pages[1].evaluate(() => window.__WORMS__.scene.getScene('Game').input.emit('pointerdown', {}));
await pages[1].waitForTimeout(1500);
const ticking = await pages[1].evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { left: s.turn.timeLeft, started: s.net.started };
});
check('дуэль: часы хода стоят до первого касания и идут после', idle === 60 && ticking.started && ticking.left < 60,
  `${idle} → ${JSON.stringify(ticking)}`);
await playTurn(pages[1], 1);
const pinged = tgCalls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === 811 && /ход/.test(c.params.text));
check('Ане бот пишет «твой ход против Боря» с кнопкой в дуэль', pinged.length === 1
  && /Твой ход против Боря/.test(pinged[0].params.text)
  && pinged[0].params.reply_markup.inline_keyboard[0][0].web_app.url.endsWith(`?duel=${duelId}`), pinged[0]?.params.text);
await pages[1].waitForTimeout(500);
check('ход ушёл — плашка «Ход отправлен», ходить больше нельзя',
  await pages[1].evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    return s.net.phase === 'sent' && !s.canPlayerAct() && Boolean(s.duelUi?.length);
  }));
await pages[1].close();
pages[1] = null;

// --- по очереди: открыл по кнопке бота → повтор хода соперника → свой ход ---
let turns = 1;
const replayChecks = [];
for (let k = 2; k <= 7; k++) {
  const i = k % 2 === 0 ? 0 : 1;    // чётные — Аня, нечётные — Боря (он ходил первым)
  if (k === 5) {
    // Боря не успел: срок хода вышел — ход пропущен, очередь у Ани
    db.prepare('update duel set deadline = ? where id = ?').run(Date.now() - 1000, duelId);
    const t = await app.duels.tick();
    check('срок хода вышел — ход пропущен', t.skipped === 1, JSON.stringify(t));
    turns++;
    continue;
  }
  await pages[i]?.close();
  if (k === 2) {
    // Аня открыла игру не по кнопке бота: на главном — «Твой ход в дуэли», один тап
    pages[i] = await open(i);
    await pages[i].waitForFunction(() => Boolean(window.__WORMS__?.scene.getScene('Menu')?.buttonHandlers?.['duel-turn']), null, { timeout: 40000 })
      .catch(() => {});
    const strip = await pages[i].evaluate(() => {
      const m = window.__WORMS__.scene.getScene('Menu');
      const has = Boolean(m.buttonHandlers?.['duel-turn']);
      if (has) m.buttonHandlers['duel-turn']();
      return has;
    });
    check('на главном экране — «Твой ход в дуэли», ведёт прямо в неё', strip);
    if (!strip) { await pages[i].close(); pages[i] = await open(i, `?duel=${duelId}`); }
  } else {
    pages[i] = await open(i, `?duel=${duelId}`);
  }
  const p = pages[i];
  await waitPhase(p, ['replay', 'play']);
  // Во время повтора соперника ходить нельзя
  const during = await p.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    return { phase: s.net.phase, act: s.canPlayerAct() };
  });
  if (during.phase === 'replay') check(`ход ${k}: пока идёт повтор хода соперника — ходить нельзя`, !during.act);
  if (k === 3 && during.phase === 'replay') {
    // «Пропустить повтор»: кнопка на экране, после неё ход сразу мой, итог тот же (сверки ниже)
    const seen = await p.waitForFunction(() => window.__WORMS__.scene.getScene('Game').skipBtn?.visible === true, null, { timeout: 20000 })
      .then(() => true).catch(() => false);
    const t0 = Date.now();
    await p.evaluate(() => window.__WORMS__.scene.getScene('Game').net.skipShow());
    await waitPhase(p, ['play', 'over']);
    const hidden = await p.waitForFunction(() => window.__WORMS__.scene.getScene('Game').skipBtn?.visible === false, null, { timeout: 10000 })
      .then(() => true).catch(() => false);
    check('«Пропустить повтор»: кнопка видна во время показа, после неё — сразу свой ход', seen && hidden && Date.now() - t0 < 5000,
      `${seen} ${hidden} ${Date.now() - t0} мс`);
  }
  await waitPhase(p, ['play', 'over']);
  replayChecks.push(...(await checksOf(p)).map((c) => ({ ...c, by: i, at: k })));
  if ((await phase(p)) === 'over') break;
  await playTurn(p, k);
  turns++;
  if ((await phase(p)) === 'over') break;
  // Сходил — закрыл игру, как живой игрок; последний ждёт с открытой дуэлью
  if (k < 7) { await p.close(); pages[i] = null; }
}

const bad = replayChecks.filter((c) => c.mine !== c.theirs);
check('каждый ход, восстановленный другим браузером, сошёлся со свёрткой ходившего',
  replayChecks.length >= 6 && bad.length === 0, `${replayChecks.length} сверок, расхождений ${bad.length}: ${JSON.stringify(bad.slice(0, 3))}`);

// Ждущий видит ход соперника сам: Аня (страница открыта, ждёт) — Боря ходит
{
  const st = await app.duels.byId(duelId);
  if (st.status === 'active') {
    const moverIdx = st.turn % 2 === 1 ? 1 : 0;   // p1 — Боря, страница 1
    const watcher = pages[1 - moverIdx];
    const mover = pages[moverIdx];
    // Ходящий: открыл дуэль по кнопке бота
    await mover?.close();
    pages[moverIdx] = await open(moverIdx, `?duel=${duelId}`);
    await waitPhase(pages[moverIdx], ['play']);
    const before = await watcher.evaluate(() => window.__WORMS__.scene.getScene('Game').turn.turnNumber);
    await playTurn(pages[moverIdx], 9);
    turns++;
    await watcher.waitForFunction((b) => {
      const s = window.__WORMS__.scene.getScene('Game');
      return s?.sys.isActive() && s.net?.phase === 'play' && s.turn.turnNumber > b;
    }, before, { timeout: 180000 }).catch(() => {});
    const w = await watcher.evaluate(() => {
      const s = window.__WORMS__.scene.getScene('Game');
      return { phase: s.net.phase, checks: s.net.checks.map((c) => c.mine === c.theirs) };
    });
    check('ждущий сам видит ход соперника — без перезахода, по опросу сервера',
      w.phase === 'play' && w.checks.length > 0 && w.checks.every(Boolean), JSON.stringify(w));
  }
}

// --- в конце оба собирают всю дуэль заново: свёртки ход в ход одинаковые ---
const finalChecks = [];
for (let i = 0; i < 2; i++) {
  await pages[i]?.close();
  pages[i] = await open(i, `?duel=${duelId}`);
  await waitPhase(pages[i], ['play', 'wait', 'over']);
  finalChecks.push(await checksOf(pages[i]));
}
const [fa, fb] = finalChecks;
const serverTurns = db.prepare('select n, kind, hash, seen_hash from duel_turn where duel_id = ? order by n').all(duelId);
const moves = serverTurns.filter((t) => t.kind === 'move');
check('оба браузера, собрав дуэль с нуля, получили одни и те же свёртки по всем ходам',
  fa.length === moves.length && fb.length === moves.length
    && fa.every((c, j) => c.mine === fb[j].mine && c.mine === c.theirs),
  `${fa.length}/${fb.length}/${moves.length}: ${fa.map((c) => c.mine).join(',')} | ${fb.map((c) => c.mine).join(',')}`);
check('сервер подтверждает: у следующего игрока итог каждого хода сошёлся',
  moves.filter((t) => t.seen_hash).length >= moves.length - 1
    && moves.every((t) => !t.seen_hash || t.seen_hash === t.hash), JSON.stringify(serverTurns));
check('в истории есть пропуск по сроку', serverTurns.some((t) => t.kind === 'skip'));
const real = await pages[0].evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { hp: s.worms.map((w) => w.health), craters: s.explosionHistory.length };
});
check('партия не пустая: воронки есть, здоровье убавилось', real.craters > 0 && real.hp.some((h) => h < 100), JSON.stringify(real));
// --- «Пересмотреть ход»: последний ход заново, партия та же ---
const rw = pages[0];
const before = await rw.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { can: s.net.canRewatch, last: s.net.checks.at(-1)?.mine ?? null };
});
await rw.evaluate(() => window.__WORMS__.scene.getScene('Game').rewatchDuel());
await rw.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.net?.phase === 'replay', null, { timeout: 30000 }).catch(() => {});
const sawReplay = await rw.evaluate(() => window.__WORMS__.scene.getScene('Game').net.forceShow === true);
await waitPhase(rw, ['play', 'wait', 'over']);
const after = await rw.evaluate(() => window.__WORMS__.scene.getScene('Game').net.checks.at(-1)?.mine ?? null);
const lastTurn = serverTurns.at(-1);
check('«Пересмотреть ход»: последний ход показан заново, итог тот же',
  before.can && sawReplay && (lastTurn.kind !== 'move' || after === lastTurn.hash),
  JSON.stringify({ ...before, sawReplay, after, server: lastTurn.hash }));
check('ни расхождений, ни ошибок в консоли', diverged.length === 0 && errors.length === 0, [...diverged, ...errors].slice(0, 5).join(' | '));
console.log(`  ходов в дуэли: ${turns}`);

for (const b of browsers) await b.close();
server.close();
db.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nдуэль по переписке: партии сходятся');
