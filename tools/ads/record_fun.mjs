#!/usr/bin/env node
/**
 * Забавные 15-секундные дубли прямо из игры — без монтажа, одним куском.
 *
 *   node tools/ads/record_fun.mjs http://127.0.0.1:5199 <out-dir> <сценарий…>
 *
 * Сценарии (ниже, SCENES): selfown — граната вверх и себе же на голову,
 * bouncer — попрыгунчик скачет по этажам, spring — батут швыряет бойца,
 * magnet — магнитная мина ползёт к врагу, weight — гиря пробивает этаж,
 * holy — святая граната по троим. Снимается покадрово, 30 к/с, 1080×1920.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:5199';
const OUT = process.argv[3] || 'docs/ads/fun';
const NAMES = process.argv.slice(4);
const FPS = 30;
const LEN = 15 * FPS;
mkdirSync(OUT, { recursive: true });

/**
 * Сценарий: seed карты и шаги. Шаг — [действие, ...аргументы]:
 *   place 'same'|'below'|'near' — поставить ближайшего врага
 *   gather — согнать всех врагов в кучку у цели
 *   aim weapon vx vy | aim weapon 'solve' — прицел (видно 10 кадров), потом выстрел
 *   wait n — n кадров; flight — ждать, пока снаряды летят
 *   ready — ждать своего хода
 */
// ready — перемотка до своего хода без записи: ход соперника в ролике не нужен
// ready — перемотка до своего хода без записи: ход соперника в ролике не нужен
const SCENES = {
  selfown: { seed: 4242, steps: [['ready'], ['place', 'same'], ['aim', 'grenade', 0, -640], ['flight'], ['wait', 45],
    ['ready'], ['aim', 'bazooka', 'solve'], ['flight'], ['wait', 30],
    ['ready'], ['aim', 'grenade', 0, -640], ['flight'], ['wait', 45]] },
  bouncer: { seed: 777, steps: [['ready'], ['place', 'near'], ['aim', 'banana', 'bounce'], ['flight'], ['wait', 30],
    ['ready'], ['place', 'near'], ['aim', 'banana', 'solve'], ['flight'], ['wait', 30],
    ['ready'], ['aim', 'banana', 'bounce'], ['flight'], ['wait', 30]] },
  spring: { seed: 4242, steps: [['ready'], ['place', 'same'], ['aim', 'spring', 'leap'], ['wait', 75],
    ['ready'], ['place', 'same'], ['aim', 'bazooka', 'solve'], ['flight'], ['wait', 30],
    ['ready'], ['aim', 'spring', 'leap'], ['wait', 75]] },
  magnet: { seed: 4242, steps: [['ready'], ['place', 'close'], ['aim', 'mine', 'drop'], ['flight'], ['boom', 260], ['wait', 30],
    ['ready'], ['place', 'same'], ['aim', 'bazooka', 'solve'], ['flight'], ['wait', 30]] },
  weight: { seed: 4242, steps: [['ready'], ['place', 'below'], ['aim', 'weight', 'drop'], ['flight'], ['wait', 35],
    ['ready'], ['place', 'below'], ['aim', 'weight', 'drop'], ['flight'], ['wait', 35],
    ['ready'], ['place', 'below'], ['aim', 'weight', 'drop'], ['flight'], ['wait', 35]] },
  holy: { seed: 777, steps: [['ready'], ['place', 'same'], ['gather'], ['aim', 'holy', 'solve'], ['flight'], ['wait', 50],
    ['ready'], ['place', 'same'], ['gather'], ['aim', 'cluster', 'solve'], ['flight'], ['wait', 40]] },
};

const browser = await chromium.launch();

async function record(name) {
  const scene = SCENES[name];
  const file = join(OUT, `${name}.mp4`);
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', 'scale=1080:1920:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await page.addInitScript(() => localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'rookie' })));
  await page.goto(`${URL}/?seed=${scene.seed}&lang=ru`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
  await page.evaluate(async () => {
    const { towerMatch } = await import('/src/core/match.js');
    window.__WORMS__.scene.getScene('Menu').start(towerMatch('dummy'));
  });
  await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.canPlayerAct?.(), null, { timeout: 40000 });
  await page.waitForTimeout(800);

  await page.evaluate(async () => {
    const g = window.__WORMS__;
    g.loop.sleep();
    let virt = performance.now();
    performance.now = () => virt;
    const s = g.scene.getScene('Game');
    s.hud.setHelp?.(false);
    s.rig.setZoom(s.rig.zoom * 2);
    const { WEAPONS } = await import('/src/weapons/index.js');
    const { Bot } = await import('/src/ai/Bot.js');
    const { CFG } = await import('/src/config.js');
    const bot = new Bot(s, 'sniper');
    const me = () => s.turn.activeWorm;
    const foes = () => s.worms.filter((o) => o.alive && o.team !== me().team);
    const nearest = () => foes().sort((a, b) => Math.hypot(a.x - me().x, a.y - me().y) - Math.hypot(b.x - me().x, b.y - me().y))[0];
    const put = (e, x, y) => { e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.grounded = true; e.hang = null; e.zip = null; };
    const clear = (x0, y0, x1) => {
      for (let x = Math.min(x0, x1) + 20; x < Math.max(x0, x1) - 20; x += 12) {
        if (s.terrain.solidAt(x, y0 - 40) || s.terrain.solidAt(x, y0 - 70)) return false;
      }
      return true;
    };
    const ad = {
      step() { virt += 1000 / 30; g.step(virt, 1000 / 30); return g.canvas.toDataURL('image/jpeg', 0.92); },
      // Без снимка: перемотка там, где смотреть нечего
      skip(n) { for (let i = 0; i < n; i++) { virt += 1000 / 30; g.step(virt, 1000 / 30); } s.setWind?.(0); },
      calm() { s.setWind?.(0); },
      booms: 0,
      ready: () => Boolean(s.canPlayerAct?.()),
      flying: () => s.projectiles.length > 0,
      place(kind) {
        const w = me(), e = nearest();
        if (!e) return false;
        for (const f of foes()) f.health = 100;
        if (kind === 'below') {
          for (let d = 0; d <= 160; d += 20) {
            for (const sg of [1, -1]) {
              const x = w.x + sg * (60 + d);
              const y = s.terrain.surfaceYAt(x, w.y + 25);
              if (y !== null && y > w.y + 70 && y < w.y + 320) { put(e, x, y); return 'below'; }
            }
          }
          return 'far';
        }
        const [lo, hi] = kind === 'near' ? [150, 300] : kind === 'close' ? [100, 140] : [110, 260];
        for (let d = lo; d <= hi; d += 10) {
          for (const sg of [1, -1]) {
            const x = w.x + sg * d;
            const y = s.terrain.surfaceYAt(x, w.y - 60);
            if (y === null || Math.abs(y - w.y) > 25 || !clear(w.x, w.y, x)) continue;
            put(e, x, y);
            return 'same';
          }
        }
        return 'far';
      },
      gather() {
        const e = nearest();
        foes().filter((f) => f !== e).forEach((f, i) => {
          const x = e.x + (i % 2 ? -1 : 1) * (26 + 10 * i);
          const y = s.terrain.surfaceYAt(x, e.y - 40);
          if (y !== null && Math.abs(y - e.y) < 30) put(f, x, y);
        });
      },
      aim(id, a, b) {
        const w = me(), e = nearest();
        const wi = WEAPONS.findIndex((x) => x.id === id);
        s.turn.ammo[s.turn.currentTeam][wi] = 3;
        s.turn.setWeaponIndex(wi);
        w.facing = e && e.x >= w.x ? 1 : -1;
        let vx, vy;
        if (typeof a === 'number') { vx = a * w.facing; vy = b; }
        else if (a === 'solve') {
          const best = bot.solve(w, e, wi);
          const sp = best.power * CFG.AIM_MAX_POWER;
          vx = Math.cos(best.angle) * best.facing * sp; vy = -Math.sin(best.angle) * sp;
        } else if (a === 'bounce') { vx = w.facing * 520; vy = -520; }
        else if (a === 'leap') { vx = w.facing * 380; vy = -720; }
        else if (a === 'drop') {
          // Навесом прямо над целью: время полёта ~0.9 с
          const t = 0.9;
          const gsc = WEAPONS[wi].projectile.gravityScale ?? 1;
          vx = (e.x - w.x) / t;
          vy = ((e.centerY - 140 - w.centerY) - 0.5 * CFG.GRAVITY * gsc * t * t) / t;
          if (id === 'mine') { vx = (e.x - w.x) * 0.45 / 0.7; vy = -260; }
        }
        s.aimAngle = Math.atan2(-vy, Math.abs(vx));
        this.pending = { vx, vy };
        return true;
      },
      shoot() { s.fireActiveWorm(this.pending.vx, this.pending.vy); },
    };
    const impact = s._impact.bind(s);
    s._impact = (...a) => { ad.booms++; return impact(...a); };
    window.__ad = ad;
  });

  let frames = 0;
  const step = async (n = 1) => {
    while (n > 0 && frames < LEN) {
      const k = Math.min(n, 10, LEN - frames);
      const shots = await page.evaluate((m) => Array.from({ length: m }, () => window.__ad.step()), k);
      for (const d of shots) ff.stdin.write(Buffer.from(d.split(',')[1], 'base64'));
      frames += k; n -= k;
    }
  };
  const until = async (fn, max, arg) => { for (let i = 0; i < max && frames < LEN; i++) { if (await page.evaluate(fn, arg)) return; await step(3); } };

  await step(15);
  for (const [act, ...args] of scene.steps) {
    if (frames >= LEN) break;
    if (act === 'ready') {
      for (let i = 0; i < 200 && !(await page.evaluate(() => window.__ad.ready())); i++) await page.evaluate(() => window.__ad.skip(6));
      await page.evaluate(() => window.__ad.calm());
    } else if (act === 'boom') {
      const b0 = await page.evaluate(() => window.__ad.booms);
      await until((n) => window.__ad.booms > n, args[0], b0);
    }
    if (act === 'ready' || act === 'boom') continue;
    else if (act === 'place') process.stdout.write(`${name}:${await page.evaluate((k) => window.__ad.place(k), args[0])} `);
    else if (act === 'gather') await page.evaluate(() => window.__ad.gather());
    else if (act === 'aim') {
      await step(8);
      await page.evaluate((a) => window.__ad.aim(...a), args);
      await step(12);
      await page.evaluate(() => window.__ad.shoot());
    } else if (act === 'flight') await until(() => !window.__ad.flying(), 250);
    else if (act === 'wait') await step(args[0]);
  }
  await step(LEN - frames);
  await page.close();
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log(`\n${file}`);
}

for (const n of NAMES.length ? NAMES : Object.keys(SCENES)) await record(n);
await browser.close();
