/**
 * Одиночная игра: меню, боты, кампания.
 *
 *   node tests/single.mjs http://127.0.0.1:5187
 *
 * Проверяется не «бот что-то сделал», а то, ради чего он написан: что его
 * решение действительно попадает по цели, что игрок в это время не может
 * помешать и что миссии кампании собираются в играбельные карты.
 */
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:5173';

const failures = [];
const errors = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch(
  launchOptions(),
);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, hasTouch: true });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`console: ${t}`);
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const menuReady = () => page.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Menu')
    && Object.keys(window.__WORMS__.scene.getScene('Menu').buttons).length > 0,
  null, { timeout: 40000 },
);
const gameReady = () => page.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game')
    && window.__WORMS__.scene.getScene('Game').turn?.activeWorm && !window.__WORMS__.scene.getScene('Game').landing(),
  null, { timeout: 40000 },
);

/**
 * Тапать по центру, пока не откроется меню.
 *
 * Экран итога отдаёт управление не сразу: обработчик «тап — в меню»
 * ставится с задержкой, а задержка считается кадрами игры. Под нагрузкой
 * кадров мало, и единственный тап по часам успевает уйти в пустоту —
 * тест потом сорок секунд ждёт меню, которое никто не открывал. Поэтому
 * стучимся, пока не откроют.
 */
async function tapToMenu(tries = 12) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(() => window.__WORMS__?.scene.isActive('Menu'))) return true;
    const g = await view();
    await page.mouse.click(Math.round(g.left + g.cw / 2), Math.round(g.top + g.ch / 2));
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => window.__WORMS__?.scene.isActive('Menu'));
}

const view = async () => page.evaluate(() => {
  const g = window.__WORMS__;
  const r = g.canvas.getBoundingClientRect();
  return { w: g.scale.width, h: g.scale.height, left: r.left, top: r.top,
    cw: r.width, ch: r.height };
});

/** Клик по кнопке меню — координаты берём у самой сцены. */
async function menuTap(key) {
  const b = await page.evaluate((k) => window.__WORMS__.scene.getScene('Menu').buttons[k] ?? null, key);
  if (!b) throw new Error(`нет кнопки меню: ${key}`);
  const g = await view();
  await page.mouse.click(
    Math.round(g.left + (b.x * g.cw) / g.w),
    Math.round(g.top + (b.y * g.ch) / g.h),
  );
  await page.waitForTimeout(350);
}

const info = () => page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return {
    mode: s.match.mode,
    mission: s.match.missionId ?? null,
    biome: s.terrain.biome.id,
    seed: s.seed,
    teams: s.match.teams.map((t) => `${t.control}:${t.worms}`).join(' vs '),
    sizes: [0, 1].map((t) => s.worms.filter((w) => w.team === t).length),
    bots: (s.bots ?? []).map((b) => (b ? b.level.id : null)),
    turn: s.turn.turnNumber,
    team: s.turn.currentTeam,
    state: s.turn.state,
    wind: Math.round(s.wind),
    canPlayerAct: s.canPlayerAct(),
    isBotTurn: s.isBotTurn(),
    alive: s.worms.filter((w) => w.alive).length,
    aboveWater: s.worms.every((w) => w.y < 630),
    // Разброс по горизонтали: слишком тесно — бой начинается в упор,
    // слишком далеко — стороны не достают друг друга даже полной силой.
    spread: Math.round(Math.max(...s.worms.map((w) => w.x))
      - Math.min(...s.worms.map((w) => w.x))),
    turnTime: s.turnTime,
    ammo: JSON.stringify(s.turn.ammo),
    shape: s.shape?.id,
  };
});

// --- меню ---
await menuReady();
const rootButtons = await page.evaluate(
  () => Object.keys(window.__WORMS__.scene.getScene('Menu').buttons));
check('в меню три пункта', ['quick', 'campaign', 'online'].every((k) => rootButtons.includes(k)),
  rootButtons.join(', '));

// --- кампания: миссия «Пристрелка» ---
await menuTap('campaign');
const missionButtons = await page.evaluate(
  () => window.__WORMS__.scene.getScene('Menu').buttons);
check('первая миссия открыта, остальные заперты',
  missionButtons.range?.enabled === true && missionButtons.siege?.enabled === false,
  Object.entries(missionButtons).map(([k, v]) => `${k}:${v.enabled ? 'открыта' : 'заперта'}`).join(' '));

await menuTap('range');
await menuTap('start');
await gameReady();
await page.waitForTimeout(1200);

let st = await info();
check('миссия запустилась с нужной картой',
  st.mode === 'campaign' && st.mission === 'range' && st.biome === 'forest',
  `${st.mode}/${st.mission}/${st.biome}`);
check('состав сторон из миссии: 2 против 1',
  st.sizes[0] === 2 && st.sizes[1] === 1, st.sizes.join(' vs '));
check('соперник — бот-новичок', st.bots[0] === null && st.bots[1] === 'rookie',
  JSON.stringify(st.bots));
check('в «Пристрелке» ветра нет', st.wind === 0, `${st.wind}`);
check('первым ходит человек', st.team === 0 && st.canPlayerAct === true,
  `команда ${st.team}`);

// --- решение бота действительно попадает ---
const aim = await page.evaluate(async () => {
  const { simulateShot, muzzle } = await import('/src/ai/ballistics.js');
  const s = window.__WORMS__.scene.getScene('Game');
  const bot = s.bots[1];
  const shooter = s.worms.find((w) => w.team === 1 && w.alive);
  const target = s.worms.find((w) => w.team === 0 && w.alive);

  const plan = bot.solve(shooter, target, 0);   // 0 = базука
  if (!plan) return null;

  const dx = Math.cos(plan.angle) * plan.facing;
  const dy = -Math.sin(plan.angle);
  const m = muzzle(s, shooter, dx, dy);
  const speed = plan.power * 1200;
  const res = simulateShot(s, m.x, m.y, dx * speed, dy * speed,
    s.turn.weapon, shooter);
  return {
    dist: Math.round(Math.hypot(res.x - target.x, res.y - target.centerY)),
    kind: res.kind,
    range: Math.round(Math.abs(target.x - shooter.x)),
    angle: Math.round((plan.angle * 180) / Math.PI),
    power: +plan.power.toFixed(2),
  };
});
check('бот считает траекторию и находит попадание',
  aim && aim.dist < 45, aim ? `промах ${aim.dist} px на дистанции ${aim.range} px, `
    + `угол ${aim.angle}°, сила ${aim.power}` : 'решения нет');

// --- ход бота ---
await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.hud.setHelp(false);
  s.turn.endTurn();          // отдаём ход, чтобы посмотреть на бота
});
await page.waitForFunction(
  () => window.__WORMS__.scene.getScene('Game').isBotTurn(),
  null, { timeout: 20000 },
);
st = await info();
check('пока ходит бот, игрок не может вмешаться', st.canPlayerAct === false);

const botShot = await page.waitForFunction(
  () => window.__WORMS__.scene.getScene('Game').projectiles.length > 0,
  null, { timeout: 20000 },
).then(() => true).catch(() => false);
check('бот сам стреляет', botShot);

const botDamage = await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { solid: s.terrain.solid.reduce((a, v) => a + v, 0),
    hp: s.worms.map((w) => w.health).join(',') };
});
await page.waitForFunction(
  (n) => window.__WORMS__.scene.getScene('Game').turn.turnNumber > n,
  (await info()).turn, { timeout: 40000 },
);
await page.waitForTimeout(700);
const after = await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { solid: s.terrain.solid.reduce((a, v) => a + v, 0),
    hp: s.worms.map((w) => w.health).join(',') };
});
check('выстрел бота меняет мир', after.solid < botDamage.solid,
  `${botDamage.solid} → ${after.solid}, здоровье ${botDamage.hp} → ${after.hp}`);
check('ход вернулся игроку', (await info()).team === 0);

// --- победа в миссии засчитывается ---
await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.worms.filter((w) => w.team === 1).forEach((w) => w.damage(999));
});
await page.waitForFunction(
  () => window.__WORMS__.scene.getScene('Game').turn.state === 'over',
  null, { timeout: 40000 },
);
const progress = await page.evaluate(() => localStorage.getItem('worms.campaign.v1'));
check('пройденная миссия записана', (progress ?? '').includes('range'), progress ?? 'пусто');

await page.waitForTimeout(1200);
await tapToMenu();
await menuReady();
check('после миссии возвращаемся в меню', true);

// --- все миссии собираются в играбельные карты ---
await menuTap('campaign');
const unlocked = await page.evaluate(
  () => window.__WORMS__.scene.getScene('Menu').buttons.storm?.enabled);
check('следующая миссия открылась после победы', unlocked === true);

// Зерно каждой миссии закреплено, и плохое зерно делает её непроходимой:
// бойцы в воде или на расстоянии, которое не перекрыть выстрелом.
// Дешевле проверить все миссии здесь, чем узнать об этом от игрока,
// застрявшего на пятой.
const CAMPAIGN = await page.evaluate(async () => {
  const { MISSIONS } = await import('/src/campaign/missions.js');
  return MISSIONS.map((m) => ({ id: m.id, sizes: m.teams.map((t) => t.worms) }));
});
check('в кампании двенадцать миссий', CAMPAIGN.length === 12, `${CAMPAIGN.length}`);

for (const { id, sizes: expected } of CAMPAIGN) {
  await page.evaluate(async (missionId) => {
    const { campaignMatch } = await import('/src/core/match.js');
    const menu = window.__WORMS__.scene.getScene('Menu');
    menu.start(campaignMatch(missionId));
  }, id);
  await gameReady();
  await page.waitForTimeout(1400);
  const m = await info();
  check(`миссия «${id}»: карта играбельна`,
    m.sizes[0] === expected[0] && m.sizes[1] === expected[1] && m.aboveWater && m.alive
      === expected[0] + expected[1],
    `${m.sizes.join(' vs ')}, все на суше: ${m.aboveWater}`);
  check(`миссия «${id}»: стороны в пределах выстрела`,
    m.spread > 250 && m.spread < 1800, `${m.spread} px между крайними`);
  if (id === 'storm') {
    check('в «Шторме» ветер сильный', Math.abs(m.wind) >= 190, `${m.wind}`);
  }
  if (id === 'islands') {
    const tp = await page.evaluate(async () => {
      const { WEAPONS } = await import('/src/weapons/index.js');
      const s = window.__WORMS__.scene.getScene('Game');
      return s.turn.ammoOf(WEAPONS.findIndex((w) => w.id === 'teleport'), 0);
    });
    check('в «Переправе» архипелаг и два телепорта', m.shape === 'archipelago' && tp === 2,
      `${m.shape}, телепортов ${tp}`);
  }
  if (id === 'siege') {
    check('в «В меньшинстве» свои патроны и время хода',
      m.turnTime === 40 && m.ammo.includes('4'), `${m.turnTime} c, ${m.ammo}`);
  }
  await page.evaluate(() => window.__WORMS__.scene.getScene('Game').toMenu());
  await menuReady();
  await menuTap('campaign');
}

// --- быстрая игра против бота ---
await menuTap('back');
await menuTap('quick');
await menuTap('sniper');
await gameReady();
await page.waitForTimeout(1000);
st = await info();
check('быстрая игра против бота собирается',
  st.mode === 'quick' && st.bots[1] === 'sniper' && st.sizes.join() === '2,2',
  `${st.mode}, боты ${JSON.stringify(st.bots)}`);

check('нет ошибок в консоли', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
console.log(failures.length
  ? `\nПРОВАЛЕНО: ${failures.length} — ${failures.join(', ')}`
  : '\nпроверки одиночной игры пройдены');
process.exit(failures.length ? 1 : 0);
