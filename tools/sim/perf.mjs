#!/usr/bin/env node
/**
 * Слабый телефон: FPS экранов при замедлении процессора в 4 раза.
 *
 *   node tools/sim/perf.mjs [--rate 4] [--secs 5] [--profile] [--out tools/sim/perf.json] [--label до]
 *
 * Поднимает сервер на 5614, открывает игру в окне 390×844 (мобильный),
 * включает CDP Emulation.setCPUThrottlingRate и по очереди меряет экраны:
 * главное меню, магазин (крутящиеся лучи), скины, дорогу наград, открытие
 * коробки, бой на башне во время прицеливания, бой во время большого
 * взрыва и экран итога. Плюс время от загрузки страницы до меню.
 *
 * Кадры считаются по requestAnimationFrame в самой странице: медиана и 95-я
 * перцентиль времени кадра (это и есть «5-й перцентиль FPS»). С --profile
 * на каждом экране снимается CPU-профиль и в отчёт идут самые тяжёлые
 * функции по собственному времени.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../../tests/browser.mjs';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const PORT = Number(opt('port', 5614));
const RATE = Number(opt('rate', 4));
const SECS = Number(opt('secs', 5));
const PROFILE = argv.includes('--profile');
const OUT = opt('out', 'tools/sim/perf.json');
const LABEL = opt('label', 'run');
const RUNS = Number(opt('runs', 1));

const tmp = mkdtempSync(join(tmpdir(), 'worms-perf-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.mjs'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', STATIC_DIR: ROOT, DB_PATH: join(tmp, 'x.db') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  let out = '';
  server.stdout.on('data', (c) => { out += c; if (/порт \d+/.test(out)) resolve(); });
  server.on('exit', (code) => reject(new Error(`сервер не запустился (код ${code})`)));
});
server.stdout.resume();
const BASE = `http://127.0.0.1:${PORT}`;
process.on('exit', () => server.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

const browser = await chromium.launch(launchOptions());

/** Самые тяжёлые функции профиля по собственному времени. */
function topSelf(profile, n = 12) {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const self = new Map();
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const cf = node.callFrame;
    const file = cf.url ? cf.url.replace(/^.*\/(src|vendor)\//, '$1/') : '';
    const key = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
  }
  const total = [...self.values()].reduce((a, v) => a + v, 0) || 1;
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${(v / total * 100).toFixed(1)}% ${k}`);
}

async function measureOnce() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'fighter' }));
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE });
  if (PROFILE) await cdp.send('Profiler.enable');

  // --- до меню ---
  await page.goto(`${BASE}/?lang=ru&seed=4242`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu')
    && Object.keys(window.__WORMS__.scene.getScene('Menu').buttons ?? {}).length > 0, null, { timeout: 120000, polling: 50 });
  const toMenu = await page.evaluate(() => Math.round(performance.now()));
  await page.evaluate(() => { window.__WORMS__.scene.getScene('Menu').streakShown = true; });
  await page.waitForTimeout(1500);

  const frames = async (secs) => page.evaluate((ms) => new Promise((resolve) => {
    const out = [];
    let last = 0;
    const t0 = performance.now();
    const tick = (t) => {
      if (last) out.push(t - last);
      last = t;
      if (t - t0 < ms) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  }), secs * 1000);

  const stats = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    const med = q(0.5), p95 = q(0.95);
    return { frames: s.length, medianMs: +med.toFixed(1), p95Ms: +p95.toFixed(1), maxMs: +(s.at(-1) ?? 0).toFixed(1), fps: +(1000 / med).toFixed(1), fps5: +(1000 / p95).toFixed(1) };
  };

  const screens = {};
  async function screen(name, setup, opts = {}) {
    await page.evaluate(setup);
    await page.waitForTimeout(opts.settle ?? 900);
    if (PROFILE) await cdp.send('Profiler.start');
    const f = await frames(opts.secs ?? SECS);
    const res = stats(f);
    if (PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      res.top = topSelf(profile);
    }
    screens[name] = res;
    console.log(`${name.padEnd(12)} медиана ${res.medianMs} мс (${res.fps} к/с) · p95 ${res.p95Ms} мс (${res.fps5} к/с) · худший ${res.maxMs} мс · кадров ${res.frames}`);
    if (PROFILE) for (const l of res.top.slice(0, 6)) console.log(`      ${l}`);
  }

  const menu = 'window.__WORMS__.scene.getScene("Menu")';
  await screen('menu', `${menu}.showRoot ? ${menu}.showRoot() : null`);
  await screen('shop', `${menu}.showShop()`);
  await screen('skins', `${menu}.showSkins()`);
  await screen('road', `${menu}.showRoad()`);
  // Коробку выдаём и открываем: замер — на самой анимации раскрытия
  await screen('box', `(async () => { const m = await import('/src/platform/skins.js'); m.grantBoxes(1); ${menu}._openBox(() => ${menu}.showShop()); })()`,
    { settle: 50, secs: Math.min(SECS, 4) });

  // --- бой на башне ---
  await page.evaluate(async () => {
    const { towerMatch } = await import('/src/core/match.js');
    window.__WORMS__.scene.getScene('Menu').start({ ...towerMatch('fighter'), seed: 4242 });
  });
  await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.canPlayerAct?.(), null, { timeout: 120000 });
  await screen('battle-aim', '0', { settle: 1500 });
  await screen('explosion', `(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    const w = s.turn.activeWorm;
    const boom = (k) => s.explode(w.x + (k % 2 ? 160 : -160), w.centerY + 40, { radius: 80, damageRadius: 10, damage: 0, knockback: 0, shake: 0.012 });
    boom(0);
    for (let k = 1; k < 8; k++) s.time.delayedCall(k * 600, () => boom(k));
  })()`, { settle: 30 });
  // Ход бота: раздумье (перебор траекторий) и выстрел — смотрим на худший кадр
  await screen('bot-turn', `(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    s.turn.endTurn();
  })()`, { settle: 30, secs: Math.max(SECS, 6) });
  await screen('result', `window.__WORMS__.scene.getScene('Game').turn._gameOver(0)`, { settle: 1200 });

  await ctx.close();
  return { toMenuMs: toMenu, screens, errors };
}

const runs = [];
for (let r = 0; r < RUNS; r++) {
  console.log(`\n— прогон ${r + 1}/${RUNS}, CPU ×${RATE}`);
  const m = await measureOnce();
  console.log(`до меню: ${m.toMenuMs} мс${m.errors.length ? ` · ошибок ${m.errors.length}: ${m.errors[0]}` : ''}`);
  runs.push(m);
}
await browser.close();
server.kill();
rmSync(tmp, { recursive: true, force: true });

// Медиана по прогонам
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const summary = { toMenuMs: med(runs.map((r) => r.toMenuMs)), screens: {} };
for (const k of Object.keys(runs[0].screens)) {
  summary.screens[k] = {
    medianMs: med(runs.map((r) => r.screens[k].medianMs)),
    p95Ms: med(runs.map((r) => r.screens[k].p95Ms)),
    fps: med(runs.map((r) => r.screens[k].fps)),
    fps5: med(runs.map((r) => r.screens[k].fps5)),
    maxMs: med(runs.map((r) => r.screens[k].maxMs)),
    top: runs[0].screens[k].top,
  };
}
const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
all[LABEL] = { at: new Date().toISOString(), rate: RATE, viewport: '390x844', runs: RUNS, ...summary };
writeFileSync(OUT, JSON.stringify(all, null, 1));
console.log(`\n→ ${OUT} [${LABEL}]`);
