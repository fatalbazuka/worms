#!/usr/bin/env node
/**
 * Сколько стоит одно решение бота и не поменялось ли оно.
 *
 *   node tools/sim/bench-bot.mjs [--port 5614] [--out file.json]
 *
 * Гоняет несколько боёв «Снайпер против Снайпера» на виртуальном времени
 * (tools/sim/agent.js) и в начале каждого хода зовёт Bot.decide на одной и
 * той же позиции: время (настоящее, без замедления) и сам план. Планы
 * сравниваются между прогонами до и после правки — ускорение не должно
 * менять, куда бот стреляет. Случайность промаха на замер подменяется
 * постоянной.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../../tests/browser.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', 5614));
const OUT = opt('out', null);

const tmp = mkdtempSync(join(tmpdir(), 'worms-bench-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', STATIC_DIR: process.cwd(), DB_PATH: join(tmp, 'x.db') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  let out = '';
  server.stdout.on('data', (c) => { out += c; if (/порт \d+/.test(out)) resolve(); });
  server.on('exit', (code) => reject(new Error(`сервер не запустился (код ${code})`)));
});
server.stdout.resume();
process.on('exit', () => server.kill());

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?lang=ru`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 180000 });
await page.evaluate(async () => { window.__simRenderEvery = 0; await import('/tools/sim/agent.js'); });

const all = [];
// Бои, где в симуляции решения были самыми долгими (docs/sim-report.md)
const CASES = [
  { id: 'tower-ice-sniper-sniper-1', kind: 'tower', variant: 'ice', level0: 'sniper', level1: 'sniper', seed: 8122 },
  { id: 'tower-classic-sniper-rookie-3', kind: 'tower', variant: 'classic', level0: 'sniper', level1: 'rookie', seed: 10020 },
  { id: 'tower-space-sniper-sniper-1', kind: 'tower', variant: 'space', level0: 'sniper', level1: 'sniper', seed: 8422 },
  { id: 'challenge-sniper', kind: 'challenge', level0: 'sniper', seed: 8484 },
  { id: 'challenge-windy', kind: 'challenge', level0: 'sniper', seed: 4242 },
];
for (const c of CASES) {
  const variant = c.id, seed = c.seed;
  await page.evaluate((cfg) => window.__sim.start(cfg), { ...c, id: c.kind === 'challenge' ? c.id.split('-')[1] : c.id, rand: c.seed });
  for (let turn = 0; turn < 10; turn++) {
    const r = await page.evaluate(() => {
      const g = window.__WORMS__;
      const s = g.scene.getScene('Game');
      // До начала следующего хода, где бот ещё думает
      const t = s.turn.turnNumber;
      for (let i = 0; i < 6000 && !(s.turn.turnNumber > t && s.turn.state === 'aim' && !s.landing()); i++) {
        if (s.turn.state === 'over') return null;
        window.__sim.run(1);
      }
      if (s.turn.state !== 'aim') return null;
      const bot = s.botFor(s.turn.currentTeam);
      const worm = s.turn.activeWorm;
      const rng = s.turnRng;
      s.turnRng = () => 0.5;
      const times = [];
      let plan = null;
      for (let k = 0; k < 3; k++) {
        bot.noHook = false; bot.noWalk = false;
        const t0 = window.__simRealNow();
        plan = bot.decide(worm, { allowMove: bot.level.moves });
        times.push(window.__simRealNow() - t0);
      }
      s.turnRng = rng;
      const round = (o) => (o ? JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v))) : null);
      return { turn: s.turn.turnNumber, ms: Math.min(...times), plan: round(plan), worm: [Math.round(worm.x), Math.round(worm.y)] };
    });
    if (!r) break;
    all.push({ variant, seed, ...r });
    console.log(`${variant}/${seed} ход ${r.turn}: ${r.ms.toFixed(1)} мс · ${JSON.stringify(r.plan)}`);
  }
}
const ms = all.map((r) => r.ms).sort((a, b) => a - b);
const sum = ms.reduce((a, v) => a + v, 0);
console.log(`\nрешений ${ms.length}: всего ${sum.toFixed(0)} мс, медиана ${ms[ms.length >> 1].toFixed(1)}, максимум ${ms.at(-1).toFixed(1)}`);
if (OUT) writeFileSync(OUT, JSON.stringify(all, null, 1));
await browser.close();
server.kill();
rmSync(tmp, { recursive: true, force: true });
