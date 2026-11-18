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
    // На экране итога — кнопка «В меню»; пока её нет, ждём
    const b = await page.evaluate(() => window.__WORMS__.scene.getScene('Game')?.overButtons?.menu ?? null);
    if (b) await page.mouse.click(Math.round(g.left + (b.x * g.cw) / g.w), Math.round(g.top + (b.y * g.ch) / g.h));
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
check('на главном экране «Играть», режимы и вкладки',
  ['play', 'modes', 'tournaments', 'top', 'account'].every((k) => rootButtons.includes(k)),
  rootButtons.join(', '));
await menuTap('modes');
const modeButtons = await page.evaluate(
  () => Object.keys(window.__WORMS__.scene.getScene('Menu').buttons));
check('в режимах башня и три прежних', ['tower', 'quick', 'campaign', 'online'].every((k) => modeButtons.includes(k)),
  modeButtons.join(', '));

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
await menuTap('modes');
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
  await menuTap('modes');
  await menuTap('campaign');
}

// --- быстрая игра против бота ---
await menuTap('back');     // из кампании — на экран режимов
await menuTap('quick');
await menuTap('sniper');
await gameReady();
await page.waitForTimeout(1000);
st = await info();
check('быстрая игра против бота собирается',
  st.mode === 'quick' && st.bots[1] === 'sniper' && st.sizes.join() === '2,2',
  `${st.mode}, боты ${JSON.stringify(st.bots)}`);

// --- быстрый бой онлайн: соперника нет — бой с ботом на башне ---
await page.evaluate(() => window.__WORMS__.scene.getScene('Game').toMenu());
await menuReady();
await menuTap('modes');
await menuTap('online');
await menuTap('quickmatch');
const searching = await page.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  return { bot: Boolean(m.buttons['bot-now']), text: m.fallbackText?.text ?? '' };
});
check('в поиске видно, когда начнётся бой с ботом', searching.bot && /ботом/.test(searching.text), searching.text);
await menuTap('bot-now');
await gameReady();
await page.waitForTimeout(800);
const fb = await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { fallback: Boolean(s.match.fallback), shape: s.shape.id, bot: s.match.teams[1].control, net: Boolean(s.net) };
});
check('«Сразу с ботом» — башня против бота, без сети и рейтинга',
  fb.fallback && fb.shape === 'tower' && fb.bot === 'bot' && !fb.net, JSON.stringify(fb));

// --- рогатка не стреляет, когда хотели двинуть камеру ---
// События подаются прямо в обработчик: через CDP касание идёт сотни
// миллисекунд, настоящий быстрый мазок так не изобразить
await page.evaluate(() => window.__WORMS__.scene.getScene('Game').hud.setHelp(false));
const gesture = (steps) => page.evaluate((steps) => {
  const s = window.__WORMS__.scene.getScene('Game');
  const a = s.aim, w = s.turn.activeWorm;
  const sx = (w.x - s.rig.viewLeft) * s.rig.zoom, sy = (w.centerY - s.rig.viewTop) * s.rig.zoom;
  const p = (dx, dy, down) => ({ x: sx + dx, y: sy + dy, isDown: down, id: 1, downTime: 1 });
  for (const [kind, dx, dy] of steps) {
    if (kind === 'down') a.onDown(p(dx, dy, true));
    if (kind === 'move') a.onMove(p(dx, dy, true));
    if (kind === 'up') a.onUp(p(dx, dy, false));
  }
}, steps);
const turnState = () => page.evaluate(() => window.__WORMS__.scene.getScene('Game').turn.state);
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game').canPlayerAct(), null, { timeout: 20000 });
await gesture([['down', 0, 0], ['move', 10, 60], ['move', 20, 140], ['up', 20, 140]]);
await page.waitForTimeout(200);
check('быстрый мазок с бойца — протяжка камеры, а не выстрел', await turnState() === 'aim');
await gesture([['down', 0, 0]]);
await page.waitForTimeout(350);
await gesture([['move', -60, 20], ['move', -120, 40], ['move', -10, 2], ['up', -10, 2]]);
await page.waitForTimeout(200);
check('натянул и вернул к бойцу — выстрела нет', await turnState() === 'aim');
await gesture([['down', 0, 0]]);
await page.waitForTimeout(350);
await gesture([['move', -60, 20], ['move', -140, 50], ['up', -140, 50]]);
await page.waitForTimeout(200);
check('спокойное натяжение — выстрел', await turnState() !== 'aim');

// --- испытания: все собираются, звёзды и монеты за победу ---
const challengeIds = await page.evaluate(async () => (await import('/src/campaign/challenges.js')).CHALLENGES.map((c) => c.id));
const broken = [];
for (const id of challengeIds) {
  await page.evaluate(async (id) => {
    const { challengeMatch } = await import('/src/core/match.js');
    window.__WORMS__.scene.getScene('Game').registry.set('match', challengeMatch(id));
    window.__WORMS__.scene.getScene('Game').registry.set('seed', challengeMatch(id).seed);
    window.__WORMS__.scene.getScene('Game').scene.restart();
  }, id);
  await gameReady();
  const ok = await page.evaluate(async () => {
    const { CFG } = await import('/src/config.js');
    const s = window.__WORMS__.scene.getScene('Game');
    return s.shape.id === 'tower' && s.turn.currentTeam === 0
      && s.worms.every((w) => w.grounded && w.y < CFG.DROWN_Y - 60);
  });
  if (!ok) broken.push(id);
}
check('все испытания собираются: башня, бойцы на этажах, первый ход за игроком', broken.length === 0, broken.join(','));

await page.evaluate(async () => {
  localStorage.removeItem('worms.challenges.v1');
  const { challengeMatch } = await import('/src/core/match.js');
  const g = window.__WORMS__.scene.getScene('Game');
  g.registry.set('match', challengeMatch('first'));
  g.registry.set('seed', challengeMatch('first').seed);
  g.scene.restart();
});
await gameReady();
const coins0 = await page.evaluate(() => JSON.parse(localStorage.getItem('worms.daily.v1') ?? '{}').coins ?? 0);
await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.hud.setHelp(false);
  const foe = s.worms.find((w) => w.team === 1);
  s.explode(foe.x, foe.centerY, { radius: 30, damageRadius: 60, damage: 150, knockback: 50 });
});
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game').overButtons?.menu, null, { timeout: 30000 });
const ch = await page.evaluate(() => ({
  stars: JSON.parse(localStorage.getItem('worms.challenges.v1') ?? '{}').first,
  coins: JSON.parse(localStorage.getItem('worms.daily.v1') ?? '{}').coins ?? 0,
}));
check('испытание за один ход без потерь — три звезды и монеты за них',
  ch.stars === 3 && ch.coins - coins0 >= 120, `звёзд ${ch.stars}, монет +${ch.coins - coins0}`);
const nextBtn = await page.evaluate(() => Boolean(window.__WORMS__.scene.getScene('Game').overButtons?.next));
check('после пройденного испытания на итоге есть «Дальше»', nextBtn);

// Голоса: фразы подгрузились после первого касания, итог боя сказан вслух
const vo = await page.evaluate(async () => {
  const { voice } = await import('./src/audio/Voice.js');
  const { sfx } = await import('./src/audio/Sfx.js');
  await voice.load();
  return { n: voice.buffers.size, last: voice.last ?? null, ctx: sfx.state, muted: sfx.muted };
});
check('голоса смайликов загружены, победа сказана голосом',
  vo.n === 10 && (vo.last === 'win' || vo.ctx !== 'running' || vo.muted), JSON.stringify(vo));

// --- кампания «Подъём»: все бои собираются, Великан ходит и падает ---
const upIds = await page.evaluate(async () => (await import('/src/campaign/ascent.js')).ASCENT.map((m) => m.id));
const upBroken = [];
for (const id of upIds) {
  await page.evaluate(async (id) => {
    const { ascentMatch } = await import('/src/core/match.js');
    const g = window.__WORMS__.scene.getScene('Game');
    g.registry.set('match', ascentMatch(id));
    g.registry.set('seed', ascentMatch(id).seed);
    g.scene.restart();
  }, id);
  await gameReady();
  const ok = await page.evaluate(async (id) => {
    const { ASCENT_BY_ID } = await import('/src/campaign/ascent.js');
    const { CFG } = await import('/src/config.js');
    const m = ASCENT_BY_ID[id];
    const s = window.__WORMS__.scene.getScene('Game');
    const want = Object.values(m.monsters ?? {}).reduce((a, n) => a + n, 0) + (m.boss ? 1 : 0);
    return s.shape.id === 'tower' && s.turn.currentTeam === 0 && s.monsters.length === want
      && s.worms.every((w) => w.grounded && w.y < CFG.DROWN_Y - 60)
      && s.monsters.every((x) => x.y < CFG.DROWN_Y - 60);
  }, id);
  if (!ok) upBroken.push(id);
}
check('«Подъём»: все 15 боёв собираются, монстры на этажах', upBroken.length === 0, upBroken.join(','));

await page.evaluate(async () => {
  localStorage.removeItem('worms.ascent.v1');
  const { ascentMatch } = await import('/src/core/match.js');
  const g = window.__WORMS__.scene.getScene('Game');
  g.registry.set('match', ascentMatch('up-5'));
  g.registry.set('seed', ascentMatch('up-5').seed);
  g.scene.restart();
});
await gameReady();
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game').canPlayerAct(), null, { timeout: 40000 });
const t0 = await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.hud.setHelp(false);
  s.turn.endTurn();
  return s.turn.turnNumber;
});
let rock = false;
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    return { n: s.turn.turnNumber, rock: s.projectiles.some((p) => p.weapon.id === 'rock') };
  });
  rock ||= st.rock;
  if (st.n > t0) break;
}
check('ход монстров: после хода игрока Великан кидает камень', rock);
await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.monsters.find((m) => m.kind === 'boss').damage(9999);
  s.turn.endTurn();
});
const bossWin = await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game').overButtons?.menu, null, { timeout: 20000 })
  .then(() => page.evaluate(() => ({
    done: JSON.parse(localStorage.getItem('worms.ascent.v1') ?? '[]'),
    next: Boolean(window.__WORMS__.scene.getScene('Game').overButtons?.next),
  }))).catch(() => null);
check('Великан повален — победа, бой пройден, есть «Дальше»',
  bossWin?.done?.includes('up-5') && bossWin.next, JSON.stringify(bossWin));

// --- выбор прицела в меню: прежние кнопки вместо рогатки ---
await page.goto(`${BASE}${BASE.includes('?') ? '&' : '?'}aim=buttons`, { waitUntil: 'domcontentloaded' });
await menuReady();
const pillLabel = await page.evaluate(() => Boolean(window.__WORMS__.scene.getScene('Menu').buttons['aim-mode']));
await menuTap('play');
await gameReady();
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game').canPlayerAct(), null, { timeout: 40000 });
const btnHud = await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.hud.setHelp(false);
  return { slingAim: s.slingAim, fire: Boolean(s.hud.buttons.fire), up: Boolean(s.hud.buttons.aimUp), turn: s.turn.turnNumber };
});
await page.evaluate(() => { window.__WORMS__.scene.getScene('Game').moveInput.fire = true; });
await page.waitForTimeout(600);
await page.evaluate(() => { window.__WORMS__.scene.getScene('Game').moveInput.fire = false; });
const fired = await page.waitForFunction(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return s.turn.state !== 'aim' || s.projectiles.length > 0;
}, null, { timeout: 5000 }).then(() => true).catch(() => false);
check('прицел «кнопки»: на башне ▲▼ и «Огонь», удержание и отпускание — выстрел',
  pillLabel && !btnHud.slingAim && btnHud.fire && btnHud.up && fired, JSON.stringify({ pillLabel, ...btnHud, fired }));

// --- новичок: первая «Играть» — обучение, после него «В бой!» с «Новичком» ---
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push(`pageerror(новичок): ${e.message}`));
  await p2.addInitScript(() => {
    // Бонус серии закрывает меню окном — для теста он уже забран
    const d = new Date();
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!localStorage.getItem('worms.daily.v1')) localStorage.setItem('worms.daily.v1', JSON.stringify({ streak: 1, streakDay: k }));
  });
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => window.__WORMS__?.scene.getScene('Menu')?.buttons?.play, null, { timeout: 40000 });
  const tapIn = async (scene, key, from = 'buttons') => {
    const r = await p2.evaluate(([sc, k, f]) => {
      const g = window.__WORMS__; const c = g.canvas.getBoundingClientRect();
      const b = g.scene.getScene(sc)[f][k];
      return { x: c.left + (b.x * c.width) / g.scale.width, y: c.top + (b.y * c.height) / g.scale.height };
    }, [scene, key, from]);
    await p2.mouse.click(r.x, r.y);
  };
  await tapIn('Menu', 'play');
  await p2.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.turn?.activeWorm, null, { timeout: 40000 });
  const tut = await p2.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    return { mode: s.match.mode, id: s.match.challengeId, tutorial: Boolean(s.match.tutorial) };
  });
  check('новичок: первая «Играть» — обучение «Первый выстрел»',
    tut.mode === 'challenge' && tut.id === 'first' && tut.tutorial, JSON.stringify(tut));
  await p2.waitForFunction(() => window.__WORMS__.scene.getScene('Game').canPlayerAct(), null, { timeout: 40000 });
  await p2.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    s.hud.setHelp(false);
    const foe = s.worms.find((w) => w.team === 1);
    s.explode(foe.x, foe.centerY, { radius: 30, damageRadius: 60, damage: 150, knockback: 50 });
  });
  await p2.waitForFunction(() => window.__WORMS__.scene.getScene('Game').overButtons?.next, null, { timeout: 30000 });
  await p2.waitForTimeout(300);
  await tapIn('Game', 'next', 'overButtons');
  await p2.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.match?.mode === 'quick'
    && window.__WORMS__.scene.getScene('Game').turn?.activeWorm, null, { timeout: 40000 });
  const after = await p2.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    return { level: s.match.teams[1].level, shape: s.shape.id };
  });
  check('после обучения «В бой!» — башня против «Новичка»',
    after.level === 'rookie' && after.shape === 'tower', JSON.stringify(after));
  await ctx.close();
}

check('нет ошибок в консоли', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
console.log(failures.length
  ? `\nПРОВАЛЕНО: ${failures.length} — ${failures.join(', ')}`
  : '\nпроверки одиночной игры пройдены');
process.exit(failures.length ? 1 : 0);
