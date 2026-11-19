#!/usr/bin/env node
/**
 * Сценки для роликов: завязка → шутка → реакция, спокойной камерой.
 *
 *   node tools/ads/record_skits.mjs http://127.0.0.1:5199 <out-dir> [сценка…]
 *
 * В отличие от record_fun здесь не «побольше выстрелов», а одна ситуация на
 * ролик: бойцы стоят там, где нужно для шутки, камера неподвижно держит обоих,
 * в момент удара — замедление, потом рожи и фразы в пузырях (эмоции игры).
 * Снимается покадрово: 30 к/с, 1080×1920, ~15 с.
 *
 * Сценки: selfown, roof, trinity, chase, flyby.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const URL = process.argv[2] || 'http://127.0.0.1:5199';
const OUT = process.argv[3] || 'docs/ads/skits';
const ONLY = process.argv.slice(4);
const FPS = 30;
mkdirSync(OUT, { recursive: true });

const SEEDS = { selfown: 4242, roof: 4242, trinity: 777, chase: 4242, flyby: 4242 };

const browser = await chromium.launch();

async function skit(name) {
  const file = join(OUT, `${name}.mp4`);
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', 'scale=1080:1920:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await page.addInitScript(() => localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'rookie' })));
  await page.goto(`${URL}/?seed=${SEEDS[name]}&lang=ru`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
  await page.evaluate(async (sk) => {
    const { towerMatch } = await import('/src/core/match.js');
    const m = towerMatch('dummy');
    // Святой троице нужны трое синих
    if (sk === 'trinity') m.teams[1].worms = 3;
    window.__WORMS__.scene.getScene('Menu').start(m);
  }, name);
  await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.canPlayerAct?.(), null, { timeout: 40000 });
  await page.waitForTimeout(900);

  // ------------------------------------------------ помощники в странице
  await page.evaluate(async () => {
    const g = window.__WORMS__;
    g.loop.sleep();
    let virt = performance.now();
    performance.now = () => virt;
    const s = g.scene.getScene('Game');
    s.hud.setHelp?.(false);
    const { WEAPONS } = await import('/src/weapons/index.js');
    const { Bot } = await import('/src/ai/Bot.js');
    const { CFG } = await import('/src/config.js');
    const bot = new Bot(s, 'sniper');
    const T = s.terrain;
    const h = {
      s, T,
      step() { virt += 1000 / 30; g.step(virt, 1000 / 30); return g.canvas.toDataURL('image/jpeg', 0.92); },
      skip(n) { for (let i = 0; i < n; i++) { virt += 1000 / 30; g.step(virt, 1000 / 30); } },
      me: () => s.turn.activeWorm,
      foes: () => s.worms.filter((o) => o.alive && o.team !== s.turn.activeWorm.team),
      mates: () => s.worms.filter((o) => o.alive && o.team === s.turn.activeWorm.team && o !== s.turn.activeWorm),
      put(w, x, y, facing) {
        w.x = x; w.y = y; w.vx = 0; w.vy = 0; w.grounded = true; w.hang = null; w.zip = null;
        if (facing) w.facing = facing;
      },
      // Лишних — подальше и не в кадр: на самый низ, к краю
      park(w) {
        // На противоположный край карты, на самый низ — подальше от камеры
        const x = (window.__sceneX ?? T.width / 2) < T.width / 2 ? T.width - 50 : 50;
        let y = null; for (let yy = T.height - 40; yy > 0 && y === null; yy -= 20) if (T.solidAt(x, yy) && !T.solidAt(x, yy - 40)) y = yy;
        h.put(w, x, y ?? T.height - 100);
      },
      /** После шутки очередь не двигается: на экране не начнётся чужой ход. */
      freeze() { s.turn.next = () => {}; s.turn.endTurn = () => {}; s.turn.timeLeft = 999; },
      /** Ровная площадка: длина len, сверху свободно на 90 px. */
      // Самая длинная ровная площадка не короче min (до want): {x, y, len}
      flat(want, min = 150) {
        return h.flatIn(want, min, 520) ?? h.flatIn(want, min, 0) ?? h.flatIn(want, 110, 0);
      },
      flatIn(want, min, top) {
        let best = null;
        for (let x = 60; x < T.width - 60; x += 6) {
          const y = T.surfaceYAt(x, 60);
          // Не у самого верха мира: иначе камера упрётся и сцена уедет к краю кадра
          if (y === null || y > T.height - 200 || y < top) continue;
          let len = 0;
          for (let d = 0; d <= want && x + d < T.width - 40; d += 6) {
            const yy = T.surfaceYAt(x + d, y - 60);
            if (yy === null || Math.abs(yy - y) > 10) break;
            let head = true;
            for (let k = 24; k <= 64 && head; k += 10) if (T.solidAt(x + d, y - k)) head = false;
            if (!head) break;
            len = d;
          }
          if (len >= min && (!best || len > best.len)) best = { x, y, len };
          if (best && best.len >= want) break;
        }
        return best;
      },
      /** Точка на площадке: доля f от длины, y — по земле. */
      at(p, f) { const x = p.x + p.len * f; return [x, T.surfaceYAt(x, p.y - 40) ?? p.y]; },
      /** Этаж над этажом: тонкий пол сверху, под ним место для бойца. */
      stacked() {
        for (let x = 140; x < T.width - 140; x += 6) {
          const y1 = T.surfaceYAt(x, 60);
          if (y1 === null) continue;
          let b = y1; while (b < T.height && T.solidAt(x, b)) b++;
          const thick = b - y1;
          const y2 = T.surfaceYAt(x, b + 1);
          if (thick > 56 || y2 === null || y2 - b < 70 || y2 - b > 220) continue;
          // Наверху стрелку есть где встать рядом (в 70–110 px)
          for (const dx of [-90, 90, -70, 70, -110, 110]) {
            const ya = T.surfaceYAt(x + dx, y1 - 90);
            if (ya !== null && Math.abs(ya - y1) < 6) return { x, y1, y2, ax: x + dx };
          }
        }
        return null;
      },
      /** Камера стоит: кадр по центру точек, с полями. */
      frame(pts, pad = 95, minW = 270) {
        window.__sceneX = pts[0][0];
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const needW = Math.max(minW, Math.max(...xs) - Math.min(...xs) + pad * 2);
        const needH = Math.max(...ys) - Math.min(...ys) + pad * 2.4;
        const z = Math.min(s.rig.W / needW, s.rig.H / needH);
        s.rig.setZoom(z);
        s.rig.manual = true; s.rig.idle = -1e12;
        s.rig.setViewLeft(cx - s.rig.visibleW / 2);
        s.rig.setViewTop(s.rig.clampTop ? s.rig.clampTop(cy - s.rig.visibleH * 0.52) : cy - s.rig.visibleH * 0.52);
      },
      hold() { s.rig.manual = true; s.rig.idle = -1e12; },
      emote(w, id) {
        // showEmote берёт активного или первого в команде — подменяем на миг
        const was = s.turn.activeWorm; s.turn.activeWorm = w;
        s._emoteAt = {};
        s.showEmote(w.team, id);
        s.turn.activeWorm = was;
      },
      weapon(id) {
        const wi = WEAPONS.findIndex((x) => x.id === id);
        s.turn.ammo[s.turn.currentTeam][wi] = 3;
        s.turn.setWeaponIndex(wi);
        return wi;
      },
      solve(id, target) {
        const wi = h.weapon(id);
        const best = bot.solve(h.me(), target, wi);
        const sp = best.power * CFG.AIM_MAX_POWER;
        return [Math.cos(best.angle) * best.facing * sp, -Math.sin(best.angle) * sp];
      },
      aim(vx, vy) { h.me().facing = vx >= 0 ? 1 : -1; s.aimAngle = Math.atan2(-vy, Math.abs(vx)); s.remoteCharge = 0; },
      fire(vx, vy) { s.fireActiveWorm(vx, vy); },
      flying: () => s.projectiles.length > 0,
      booms: 0,
      slowmo: true,
      calm() { s.setWind?.(0); },
    };
    // Удар — замедление: шутка должна успеть дойти
    const impact = s._impact.bind(s);
    s._impact = (...a) => {
      h.booms++;
      if (h.slowmo && a[2] > 0) s._slow = { until: performance.now() + 1700, k: 0.3 };
      return impact(...a);
    };
    h.calm();
    window.__h = h;
  });

  let frames = 0;
  const step = async (n = 1) => {
    while (n > 0) {
      const k = Math.min(n, 10);
      const shots = await page.evaluate((m) => Array.from({ length: m }, () => window.__h.step()), k);
      for (const d of shots) ff.stdin.write(Buffer.from(d.split(',')[1], 'base64'));
      frames += k; n -= k;
    }
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const untilBoom = async (max = 150, freeze = true) => {
    const b0 = await ev(() => window.__h.booms);
    if (freeze) await ev(() => window.__h.freeze());
    for (let i = 0; i < max; i += 3) { if (await ev((n) => window.__h.booms > n, b0)) return; await step(3); }
  };
  const untilLanded = async (max = 240) => {
    for (let i = 0; i < max; i += 3) { if (!(await ev(() => window.__h.flying()))) return; await step(3); }
  };

  await SKITS[name]({ ev, step, untilBoom, untilLanded });
  await page.close();
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log(`${file}  ${(frames / FPS).toFixed(1)} с`);
}

// ---------------------------------------------------------------- сценки

const SKITS = {
  // Синий дразнит, жёлтый бросает гранату вверх — и себе же на голову
  async selfown({ ev, step, untilBoom }) {
    await ev(() => {
      const h = window.__h;
      const p = h.flat(240); window.__sceneX = p.x;
      const a = h.me(), b = h.foes()[0];
      h.put(a, ...h.at(p, 0.15), 1);
      h.put(b, ...h.at(p, 0.85), -1);
      h.foes().slice(1).forEach(h.park); h.mates().forEach(h.park);
      h.frame([[a.x, a.y - 230], [b.x, b.y]]);
    });
    await step(20);
    await ev(() => { const h = window.__h; h.emote(h.foes()[0], 'laugh'); });
    await step(55);
    await ev(() => { const h = window.__h; h.weapon('grenade'); h.aim(4, -620); });
    await step(30);
    await ev(() => window.__h.fire(4, -620));
    await untilBoom(200);
    await step(55);
    await ev(() => { const h = window.__h; h.emote(h.foes()[0], 'laugh'); });
    await step(40);
    await ev(() => { const h = window.__h; h.emote(h.s.worms.find((w) => w.team === 0 && w.alive), 'cry'); });
    await step(70);
  },

  // Синий прячется этажом ниже и смеётся — гиря пробивает пол ему на голову
  async roof({ ev, step, untilBoom }) {
    const ok = await ev(() => {
      const h = window.__h;
      const p = h.stacked();
      if (!p) return false;
      window.__sceneX = p.x;
      const a = h.me(), b = h.foes()[0];
      h.put(a, p.ax, p.y1, p.x > p.ax ? 1 : -1);
      h.put(b, p.x, p.y2, p.x > p.ax ? -1 : 1);
      h.foes().slice(1).forEach(h.park); h.mates().forEach(h.park);
      h.frame([[a.x, a.y - 160], [b.x, b.y]]);
      window.__p = p;
      return true;
    });
    if (!ok) { console.log('roof: нет подходящих этажей'); return; }
    await step(20);
    await ev(() => { const h = window.__h; h.emote(h.foes()[0], 'laugh'); });
    await step(60);
    // Гиря навесом прямо над синим: падает сверху на пол над ним
    await ev(() => {
      const h = window.__h, p = window.__p, a = h.me();
      h.weapon('weight');
      const t = 0.75, gs = 1.5 * 800;
      window.__v = [(p.x - a.x) / t, ((p.y1 - 4) - (a.y - 30) - 0.5 * gs * t * t) / t];
      h.aim(...window.__v);
    });
    await step(30);
    await ev(() => window.__h.fire(...window.__v));
    await untilBoom(200);
    await step(70);
    await ev(() => { const h = window.__h; const b = h.s.worms.find((w) => w.team === 1 && w.alive); if (b) h.emote(b, 'cry'); });
    await step(30);
    await ev(() => { const h = window.__h; h.emote(h.s.worms.find((w) => w.team === 0 && w.alive), 'laugh'); });
    await step(70);
  },

  // Трое синих болтают кучкой — святая граната
  async trinity({ ev, step, untilBoom }) {
    await ev(() => {
      const h = window.__h;
      const p = h.flat(360, 200); window.__sceneX = p.x;
      const a = h.me();
      const [b1, b2, b3] = h.foes();
      h.put(a, ...h.at(p, 0.06), 1);
      const bx = p.x + p.len - 90;
      h.put(b1, bx, h.T.surfaceYAt(bx, p.y - 40), -1);
      h.put(b2, bx + 34, h.T.surfaceYAt(bx + 34, p.y - 40), -1);
      h.put(b3, bx + 68, h.T.surfaceYAt(bx + 68, p.y - 40), 1);
      h.mates().forEach(h.park);
      h.frame([[a.x, a.y - 200], [b3.x, b3.y]]);
      window.__tri = [b1, b2, b3];
    });
    await step(15);
    await ev(() => { const h = window.__h; h.emote(window.__tri[0], 'laugh'); });
    await step(25);
    await ev(() => { const h = window.__h; h.emote(window.__tri[2], 'gg'); });
    await step(40);
    await ev(() => { const h = window.__h; window.__v = h.solve('holy', window.__tri[1]); h.aim(...window.__v); });
    await step(30);
    await ev(() => window.__h.fire(...window.__v));
    // Святая шипит в воздухе и на земле — пусть синие её заметят
    await step(40);
    await ev(() => { const h = window.__h; const b = window.__tri.find((w) => w.alive); if (b) h.emote(b, 'wow'); });
    await untilBoom(220);
    await step(80);
    await ev(() => { const h = window.__h; h.emote(h.s.worms.find((w) => w.team === 0 && w.alive), 'laugh'); });
    await step(70);
  },

  // Синий уходит, а магнитная мина ползёт за ним
  async chase({ ev, step, untilBoom, untilLanded }) {
    await ev(() => {
      const h = window.__h;
      h.slowmo = true;
      const p = h.flat(380, 240); window.__sceneX = p.x;
      const a = h.me(), b = h.foes()[0];
      h.put(a, ...h.at(p, 0.03), 1);
      h.put(b, p.x + 150, h.T.surfaceYAt(p.x + 150, p.y - 40), -1);
      h.foes().slice(1).forEach(h.park); h.mates().forEach(h.park);
      h.frame([[a.x, a.y - 150], [p.x + p.len, p.y]]);
      window.__p = p;
    });
    await step(20);
    await ev(() => { const h = window.__h; h.weapon('mine'); h.aim(150, -260); });
    await step(30);
    await ev(() => window.__h.fire(150, -260));
    await untilLanded(90);
    await ev(() => window.__h.freeze());
    await ev(() => { const h = window.__h; h.emote(h.foes()[0], 'wow'); });
    await step(30);
    // Синий уходит прочь — шагом, оглядываясь; мина ползёт быстрее
    for (let i = 0; i < 160; i++) {
      const boom = await ev((k) => {
        const h = window.__h, b = h.foes()[0], p = window.__p;
        if (!b) return true;
        if (b.x < p.x + p.len - 20 && b.grounded) {
          b.facing = (k % 50) < 40 ? 1 : -1;     // иногда оглядывается
          if (b.facing === 1) { b.x += 1.1; b.y = h.T.surfaceYAt(b.x, b.y - 30) ?? b.y; }
          b.remoteWalkUntil = h.s.time.now + 120;
        }
        if (k === 60) h.emote(b, 'cry');
        return h.booms > 0;
      }, i);
      await step(1);
      if (boom) break;
    }
    await step(75);
    await ev(() => { const h = window.__h; h.emote(h.s.worms.find((w) => w.team === 0 && w.alive), 'laugh'); });
    await step(60);
  },

  // Жёлтый перелетает на батуте — и сразу битой
  async flyby({ ev, step, untilBoom }) {
    await ev(() => {
      const h = window.__h;
      const p = h.flat(320, 220); window.__sceneX = p.x;
      const a = h.me(), b = h.foes()[0];
      h.put(a, ...h.at(p, 0.04), 1);
      h.put(b, ...h.at(p, 0.9), -1);
      window.__span = p.len;
      h.foes().slice(1).forEach(h.park); h.mates().forEach(h.park);
      h.frame([[a.x, a.y - 240], [b.x + 120, b.y]]);
      window.__b = b;
    });
    await step(20);
    await ev(() => { const h = window.__h; h.emote(window.__b, 'laugh'); });
    await step(45);
    // Дальность прыжка под длину площадки: x = vx · 2vy / g
    const sv = await ev(() => { const h = window.__h; const vy = -560; const vx = (window.__span * 0.8) / (2 * 560 / 800 * 0.8); h.weapon('spring'); h.aim(vx, vy); return [vx, vy]; });
    await step(25);
    await ev((v) => window.__h.fire(...v), sv);
    // Летит, приземляется рядом
    for (let i = 0; i < 120; i += 3) {
      await step(3);
      if (await ev(() => { const a = window.__h.s.worms.find((w) => w.team === 0 && w.alive && !w.grounded); return !a; })) break;
    }
    await ev(() => { const h = window.__h; h.emote(window.__b, 'wow'); });
    await step(30);
    // Ход синего проскакиваем: синий стоит, просто это был его ход
    await ev(() => {
      const h = window.__h;
      for (let i = 0; i < 400 && !h.s.canPlayerAct(); i++) h.skip(3);
      h.calm(); h.hold();
      const a = h.me(), b = window.__b;
      // Ход снова у жёлтого, но мог достаться напарнику — ставим нужного
      const jumper = h.s.worms.find((w) => w.team === 0 && w.alive && Math.abs(w.x - b.x) < 160) ?? a;
      h.s.turn.activeWorm = jumper;
      jumper.facing = b.x >= jumper.x ? 1 : -1;
      if (Math.abs(b.x - jumper.x) > 34) h.put(jumper, b.x - 30 * jumper.facing, b.y, jumper.facing);
    });
    await ev(() => window.__h.freeze());
    await step(25);
    await ev(() => { const h = window.__h; h.weapon('bat'); const a = h.me(); h.aim(a.facing * 500, -300); });
    await step(20);
    await ev(() => { const h = window.__h; const a = h.me(); h.fire(a.facing * 500, -300); });
    await step(110);
    await ev(() => { const h = window.__h; h.emote(h.me(), 'laugh'); });
    await step(60);
  },
};

for (const n of ONLY.length ? ONLY : Object.keys(SKITS)) await skit(n);
await browser.close();
