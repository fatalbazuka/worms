#!/usr/bin/env node
/**
 * Сырой материал для рекламы: настоящий бой, где «игрок» по сценарию
 * стреляет нужным оружием, снятый покадрово — ровно 30 кадров в секунду,
 * как бы медленно ни рисовал браузер.
 *
 *   node tools/ads/record_ad.mjs http://127.0.0.1:5199 <out.mp4> [lang] [seed]
 *
 * Игровой цикл Phaser останавливается, время шагает по 1/30 с вручную
 * (performance.now тоже подменён — на нём стоп-кадры и замедления), каждый
 * кадр снимается с холста и уходит в ffmpeg. Рядом — <out>.json: выстрелы
 * {t, weapon} и моменты {t, kind, dmg} в мс видео. Монтаж — tools/ads/cut.mjs.
 *
 * AD_PLAN — оружие по очереди (последний выстрел — добивание).
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const URL = process.argv[2] || 'http://127.0.0.1:5199';
const OUT = process.argv[3] || '/tmp/ad-raw.mp4';
const LANG = process.argv[4] || 'ru';
const SEED = process.argv[5] || '4242';
const PLAN = (process.env.AD_PLAN || 'mortar,boomerang,homing,banana,cluster,holy').split(',');
const FPS = 30;

const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
await page.addInitScript(() => localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'rookie' })));
await page.goto(`${URL}/?seed=${SEED}&lang=${LANG}&az=${process.env.AD_ZOOM || 2}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
await page.evaluate(async () => {
  const { towerMatch } = await import('/src/core/match.js');
  window.__WORMS__.scene.getScene('Menu').start(towerMatch('dummy'));
});
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.canPlayerAct?.(), null, { timeout: 40000 });
await page.waitForTimeout(800);

// Остановить цикл и подменить часы; дальше всё — только шагами
await page.evaluate(async () => {
  const g = window.__WORMS__;
  g.loop.sleep();
  let virt = performance.now();
  const realNow = performance.now.bind(performance);
  performance.now = () => virt;
  window.__real = realNow;
  const s = g.scene.getScene('Game');
  s.hud.setHelp?.(false);
  s.rig.setZoom(s.rig.zoom * Number(new URLSearchParams(location.search).get('az') || 2));
  const { WEAPONS } = await import('/src/weapons/index.js');
  const { Bot } = await import('/src/ai/Bot.js');
  const { CFG } = await import('/src/config.js');
  const bot = new Bot(s, 'sniper');
  const ad = { frame: 0, shots: [], marks: [], queue: [] };
  window.__ad = ad;
  const T = () => Math.round((ad.frame * 1000) / 30);
  const impact = s._impact.bind(s);
  s._impact = (x, y, dmg, foes) => { ad.marks.push({ t: T(), kind: foes >= 2 ? 'multi' : 'hit', dmg }); return impact(x, y, dmg, foes); };
  const died = s.onWormDied.bind(s);
  s.onWormDied = (w) => { ad.marks.push({ t: T(), kind: s.checkVictory() !== null ? 'decisive' : 'kill' }); return died(w); };

  // Один кадр: шаг игры и снимок холста (в той же задаче — буфер ещё цел)
  ad.step = () => {
    virt += 1000 / 30;
    g.step(virt, 1000 / 30);
    ad.frame++;
    return g.canvas.toDataURL('image/jpeg', 0.92);
  };
  // Выстрел по сценарию — как в record_ad раньше, только без ожиданий
  ad.fire = (id, last) => {
    const w = s.turn.activeWorm;
    const foes = s.worms.filter((o) => o.alive && o.team !== w.team);
    const e = foes.sort((a, b) => Math.hypot(a.x - w.x, a.y - w.y) - Math.hypot(b.x - w.x, b.y - w.y))[0];
    if (!e) return false;
    // Постановка: соперник на том же этаже в 220–320 px — попадание видно целиком
    let placed = false;
    const clear = (x0, y0, x1) => {
      // Между ними нет стены выше плеч
      for (let x = Math.min(x0, x1) + 20; x < Math.max(x0, x1) - 20; x += 12) {
        if (s.terrain.solidAt(x, y0 - 40) || s.terrain.solidAt(x, y0 - 70)) return false;
      }
      return true;
    };
    const spots = [];
    for (let d = 110; d <= 340; d += 10) {
      for (const sg of [1, -1]) {
        const x = w.x + sg * d;
        const y = s.terrain.surfaceYAt(x, w.y - 60);
        if (y === null || y > w.y + 170 || y < w.y - 40) continue;
        const same = Math.abs(y - w.y) <= 25;
        if (!clear(w.x, Math.min(w.y, y), x)) continue;
        spots.push({ x, y, score: (same ? 0 : 100) + Math.abs(d - 190) });
      }
    }
    spots.sort((a, b) => a.score - b.score);
    if (spots[0]) {
      e.x = spots[0].x; e.y = spots[0].y; e.vx = 0; e.vy = 0; e.grounded = true; e.hang = null; e.zip = null;
      placed = true;
    }
    for (const f of foes) f.health = last ? (f === e ? 30 : 100) : 100;
    if (last) for (const f of foes) if (f !== e) f.kill?.('реклама');
    const wi = WEAPONS.findIndex((x) => x.id === id);
    s.turn.ammo[s.turn.currentTeam][wi] = 3;
    s.turn.setWeaponIndex(wi);
    w.facing = e.x >= w.x ? 1 : -1;
    let vx, vy;
    if (id === 'boomerang') {
      const dx = e.x - w.x, dy = e.centerY - w.centerY, len = Math.hypot(dx, dy) || 1;
      vx = dx / len * 700; vy = dy / len * 700;
    } else if (id === 'homing') {
      vx = w.facing * 380; vy = -620;
    } else {
      const best = bot.solve(w, e, wi);
      const sp = best.power * CFG.AIM_MAX_POWER;
      vx = Math.cos(best.angle) * best.facing * sp; vy = -Math.sin(best.angle) * sp;
    }
    s.aimAngle = Math.atan2(-vy, Math.abs(vx));
    ad.pending = { vx, vy, id };
    return placed ? 'placed' : 'far';
  };
  ad.shoot = () => {
    const p = ad.pending;
    ad.shots.push({ t: T(), weapon: p.id });
    s.fireActiveWorm(p.vx, p.vy);
    ad.pending = null;
  };
  ad.ready = () => Boolean(s.canPlayerAct?.());
  ad.flying = () => s.projectiles.length > 0;
  ad.over = () => Boolean(s.gameOverUi);
  ad.split = () => s.trySplit();
});

let frames = 0;
async function step(n = 1) {
  // Снимаем пачками: меньше переходов между node и страницей
  while (n > 0) {
    const k = Math.min(n, 10);
    const shots = await page.evaluate((m) => Array.from({ length: m }, () => window.__ad.step()), k);
    for (const d of shots) ff.stdin.write(Buffer.from(d.split(',')[1], 'base64'));
    frames += k;
    n -= k;
  }
}
async function stepUntil(fn, max) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate(fn)) return true;
    await step(3);
  }
  return false;
}

await step(20);
for (let k = 0; k < PLAN.length; k++) {
  await stepUntil(() => window.__ad.ready() || window.__ad.over(), 400);
  if (await page.evaluate(() => window.__ad.over())) break;
  await step(12);
  const ok = await page.evaluate(([id, last]) => window.__ad.fire(id, last), [PLAN[k], k === PLAN.length - 1]);
  if (!ok) break;
  await step(10);                                      // прицел виден
  await page.evaluate(() => window.__ad.shoot());
  if (PLAN[k] === 'mortar') { await step(14); await page.evaluate(() => window.__ad.split()); }
  await stepUntil(() => !window.__ad.flying(), 300);
  await step(36);
  process.stdout.write(`${PLAN[k]}(${ok}) `);
}
// Добивание не вышло — бьём базукой ещё, пока не будет «Решающего»
for (let tries = 0; tries < 4; tries++) {
  const decided = await page.evaluate(() => window.__ad.marks.some((m) => m.kind === 'decisive') || window.__ad.over());
  if (decided) break;
  await stepUntil(() => window.__ad.ready() || window.__ad.over(), 400);
  if (await page.evaluate(() => window.__ad.over())) break;
  await step(12);
  const ok = await page.evaluate(() => window.__ad.fire('bazooka', true));
  if (!ok) break;
  await step(10);
  await page.evaluate(() => window.__ad.shoot());
  await stepUntil(() => !window.__ad.flying(), 300);
  await step(36);
  process.stdout.write(`bazooka(${ok}) `);
}
await step(75);
const log = await page.evaluate(() => ({ shots: window.__ad.shots, marks: window.__ad.marks }));
await browser.close();
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
writeFileSync(OUT.replace(/\.\w+$/, '.json'), JSON.stringify({ fps: FPS, frames, ...log }, null, 1));
console.log('\nзаписано', OUT, `${(frames / FPS).toFixed(1)} с`, JSON.stringify(log));
