/**
 * Башня по сети: два игрока, комната на «ZW».
 *
 *   node tests/tower.mjs http://127.0.0.1:5187
 *
 * Проверяется то, чем башня отличается от обычной сетевой партии: оба по
 * коду комнаты получают одну и ту же высокую арену и правила с тросом;
 * рывок по тросу и зацеп за стену видны сопернику; после выстрела итог
 * хода у обоих один. Транспорт — мост между двумя страницами, как в
 * tests/net.mjs.
 */
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173';
const ROOM = 'ZWTEST';

const failures = [];
const errors = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browsers = [await chromium.launch(launchOptions()), await chromium.launch(launchOptions())];
const pages = [];
for (let i = 0; i < 2; i++) {
  const page = await browsers[i].newPage({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  page.on('pageerror', (e) => errors.push(`[${i}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`[${i}] console: ${t}`);
    if (t.startsWith('[net] состояние разошлось')) errors.push(`[${i}] ${t}`);
  });
  await page.exposeFunction('__netOut', (room, msg) => {
    setTimeout(() => {
      pages[1 - i]?.evaluate(([r, m]) => globalThis.__netIn?.(r, m), [room, msg]).catch(() => {});
    }, 40);
  });
  await page.addInitScript(() => {
    globalThis.__inboxes = new Map();
    globalThis.__netIn = (room, msg) => globalThis.__inboxes.get(room)?.(msg);
    globalThis.WORMS_TRANSPORT = () => ({
      id: `p${Math.random().toString(36).slice(2, 8)}`,
      async connect(room, onMessage) { this.room = room; globalThis.__inboxes.set(room, onMessage); },
      send(msg) { globalThis.__netOut(this.room, { ...msg, from: this.id }); },
      close() { globalThis.__inboxes.delete(this.room); },
    });
  });
  await page.goto(`${URL}/?seed=4242&room=${ROOM}`, { waitUntil: 'domcontentloaded' });
  pages.push(page);
}

const ready = (p) => p.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game')
    && window.__WORMS__.scene.getScene('Game').turn?.activeWorm,
  null, { timeout: 40000 },
);
await Promise.all(pages.map(ready));
await Promise.all(pages.map((p) => p.waitForFunction(
  () => window.__WORMS__.scene.getScene('Game').net?.connected === true, null, { timeout: 30000 },
)));
await Promise.all(pages.map(ready));
await Promise.all(pages.map((p) => p.waitForTimeout(1200)));

const info = (p) => p.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return {
    shape: s.shape.id, sling: s.sling, hooks: s.hookPerTurn, flood: !!s.rules.flood, variant: s.variant?.id,
    biome: s.terrain.biome.id,
    myTeam: s.net.myTeam, team: s.turn.currentTeam, turn: s.turn.turnNumber, state: s.turn.state,
    terrain: s.terrain.hash(),
    hp: s.worms.map((w) => `${w.health}${w.alive ? '' : '†'}`).join(','),
    pos: s.worms.map((w) => `${Math.round(w.x)}:${Math.round(w.y)}`).join(','),
    hang: s.worms.map((w) => w.hang ?? '-').join(','),
    rotate: getComputedStyle(document.getElementById('rotate')).display,
  };
});

let [a, b] = await Promise.all(pages.map(info));
check('оба получили башню с тросом по коду комнаты',
  a.shape === 'tower' && b.shape === 'tower' && a.sling && b.sling && a.hooks === 3 && a.flood,
  `${a.shape}/${b.shape}, тросов ${a.hooks}`);
check('карта и расстановка у обоих одни', a.terrain === b.terrain && a.pos === b.pos, `${a.pos} | ${b.pos}`);
check('вид башни и тема у обоих одни', a.variant && a.variant === b.variant && a.biome === b.biome,
  `${a.variant}/${a.biome} | ${b.variant}/${b.biome}`);
check('в портрете бой идёт, «поверни телефон» не показан', a.rotate === 'none' && b.rotate === 'none');
check('команды разные, ход у одного', a.myTeam !== b.myTeam && a.team === b.team);

// --- трос: ходящий цепляется, второй видит его там же ---
const mover = a.myTeam === a.team ? pages[0] : pages[1];
const watcher = mover === pages[0] ? pages[1] : pages[0];
const hooked = await mover.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  const w = s.turn.activeWorm;
  // Первый зацеп по кругу, после которого боец удержится и окажется не там, где стоял
  for (let k = 0; k < 32; k++) {
    const an = -Math.PI / 2 + Math.ceil(k / 2) * (Math.PI / 16) * (k % 2 ? 1 : -1);
    const p = s.hookAnchor(w, w.x + Math.cos(an) * 200, w.centerY + Math.sin(an) * 200);
    if (!p) continue;
    const end = w.zipEnd(p.x, p.y);
    if ((end.hang || end.grounded) && Math.hypot(end.x - w.x, end.y - w.y) > 80) {
      return { ok: s.tryHook(p.x, p.y), worm: s.worms.indexOf(w), left: s.hooksLeft };
    }
  }
  return { ok: false };
});
check('трос пущен, один списан', hooked.ok && hooked.left === 2, JSON.stringify(hooked));
await mover.waitForFunction((i) => !window.__WORMS__.scene.getScene('Game').worms[i].zip, hooked.worm, { timeout: 20000 });
await mover.waitForTimeout(900);
const at = (p) => p.evaluate((i) => {
  const w = window.__WORMS__.scene.getScene('Game').worms[i];
  return { x: Math.round(w.x), y: Math.round(w.y), hang: w.hang, zip: !!w.zip, grounded: w.grounded };
}, hooked.worm);
const [m1, w1] = [await at(mover), await at(watcher)];
check('соперник видит бойца там, куда его подтянул трос',
  Math.abs(m1.x - w1.x) <= 3 && Math.abs(m1.y - w1.y) <= 3 && m1.hang === w1.hang && !w1.zip,
  `${JSON.stringify(m1)} | ${JSON.stringify(w1)}`);
await watcher.waitForTimeout(700);
const w2 = await at(watcher);
check('у соперника висящий боец не падает', Math.abs(w2.y - m1.y) <= 3, `${w2.y} против ${m1.y}`);

// --- эмоция: соперник видит, как мой боец корчит рожу ---
const sentEmote = await mover.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return s.showEmote(s.myTeamIndex, 'laugh', { send: true });
});
const seen = await watcher.waitForFunction((team) => {
  const s = window.__WORMS__.scene.getScene('Game');
  return s.worms.some((w) => w.team === team && w.mood === 'worm_win');
}, a.team, { timeout: 5000 }).then(() => true).catch(() => false);
check('эмоция дошла до соперника', sentEmote && seen);

// --- выстрел: итог хода у обоих один ---
const turnBefore = a.turn;
await mover.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  const w = s.turn.activeWorm;
  const e = s.worms.find((o) => o.alive && o.team !== w.team);
  const dx = e.x - w.x, dy = e.centerY - w.centerY - 120, d = Math.hypot(dx, dy) || 1;
  s.fireActiveWorm((dx / d) * 560, (dy / d) * 560);
});
await Promise.all(pages.map((p) => p.waitForFunction(
  (from) => {
    const s = window.__WORMS__.scene.getScene('Game');
    return s.turn.turnNumber > from && ['aim', 'over'].includes(s.turn.state);
  }, turnBefore, { timeout: 60000 },
)));
await Promise.all(pages.map((p) => p.waitForTimeout(600)));
[a, b] = await Promise.all(pages.map(info));
check('после хода здоровье, позиции и зацепы у обоих совпали',
  a.hp === b.hp && a.pos === b.pos && a.hang === b.hang && a.terrain === b.terrain,
  `${a.hp} ${a.pos} ${a.hang} | ${b.hp} ${b.pos} ${b.hang}`);
check('ход перешёл сопернику у обоих', a.team === b.team && a.turn === b.turn && a.turn > turnBefore,
  `ход ${a.turn}/${b.turn}, команда ${a.team}/${b.team}`);

check('нет ошибок и расхождений', errors.length === 0, errors.slice(0, 4).join(' | '));

await Promise.all(browsers.map((br) => br.close()));
if (failures.length) {
  console.log(`\nпровалено: ${failures.length}`);
  process.exit(1);
}
console.log('\nбашня по сети работает');
