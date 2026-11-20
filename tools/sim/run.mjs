#!/usr/bin/env node
/**
 * Бот против бота: сотни полных боёв на ускоренном времени — и цифры.
 *
 *   node tools/sim/run.mjs                    # весь набор (~230 боёв)
 *   node tools/sim/run.mjs --only tower       # один вид: tower|classic|ascent|challenge|campaign
 *   node tools/sim/run.mjs --repro tower-ice-sniper-rookie-1   # один бой по id из отчёта
 *   node tools/sim/run.mjs --rounds 2 --workers 3 --out tools/sim/report.json
 *
 * Поднимает сервер игры на 5613 (как tests/run.mjs, с временной базой),
 * открывает страницы в headless Chromium, грузит в каждую tools/sim/agent.js
 * и гонит бои подряд в одной странице: так заодно видно, растёт ли память
 * от боя к бою. Итог — tools/sim/report.json и docs/sim-report.md
 * (тот пишет tools/sim/report.mjs).
 *
 * Всё детерминировано: зерно карты и Math.random на бой заданы, время
 * виртуальное. Повтор по --repro идёт в чистой странице, поэтому от прогона
 * подряд может отличаться прогрессом в localStorage, но не картой и ботами.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../../tests/browser.mjs';
import { ASCENT } from '../../src/campaign/ascent.js';
import { CHALLENGES } from '../../src/campaign/challenges.js';
import { MISSIONS } from '../../src/campaign/missions.js';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const PORT = Number(opt('port', 5613));
const WORKERS = Number(opt('workers', 3));
const ROUNDS = Number(opt('rounds', 3));
const ONLY = opt('only', null);
const REPRO = opt('repro', null);
const OUT = opt('out', 'tools/sim/report.json');
const FPS = Number(opt('fps', 60));
const LIMIT = Number(opt('limit', 0));
// На бой — не больше стольких минут настоящего времени, иначе «завис»
const HANG_MS = Number(opt('hang', 240)) * 1000;
// Отрисовка в headless идёт программным WebGL и стоит в десятки раз
// дороже самой игры: даже кадр из трёхсот растягивал бой втрое. Поэтому
// по умолчанию бой не рисуется (0), рисуются только кадры перехода
// меню ↔ бой и экран итога. --render N — рисовать каждый N-й кадр боя
const RENDER = Number(opt('render', 0));

// --------------------------------------------------------------- набор боёв

const LEVELS = ['rookie', 'fighter', 'sniper'];
const VARIANTS = ['classic', 'ice', 'lava', 'wind', 'space'];
const SHAPES = ['island', 'archipelago', 'canyon', 'mesas', 'caverns'];

function battles() {
  const out = [];
  for (let r = 1; r <= ROUNDS; r++) {
    // Башня: все пары уровней на всех видах башни
    VARIANTS.forEach((v, vi) => {
      for (const l0 of LEVELS) {
        for (const l1 of LEVELS) {
          out.push({ id: `tower-${v}-${l0}-${l1}-${r}`, kind: 'tower', variant: v, level0: l0, level1: l1,
            seed: 7000 + r * 1000 + vi * 100 + LEVELS.indexOf(l0) * 10 + LEVELS.indexOf(l1) });
        }
      }
      // Все стволы против бойца — чтобы в ход пошли не только четыре ствола ботов
      out.push({ id: `tower-${v}-sim_all-fighter-${r}`, kind: 'tower', variant: v, level0: 'sim_all', level1: 'fighter',
        seed: 7000 + r * 1000 + vi * 100 + 99 });
    });
    // Классика: все формы карты
    SHAPES.forEach((sh, si) => {
      for (const [l0, l1] of [['fighter', 'fighter'], ['sniper', 'rookie'], ['rookie', 'sniper'], ['sim_all', 'fighter']]) {
        out.push({ id: `classic-${sh}-${l0}-${l1}-${r}`, kind: 'classic', shape: sh, level0: l0, level1: l1,
          seed: 31000 + r * 1000 + si * 100 + LEVELS.indexOf(l0) * 10 + LEVELS.indexOf(l1) });
      }
    });
  }
  // «Подъём»: все 20 боёв, за игрока — боец и снайпер (зерно у уровня своё)
  for (const m of ASCENT) {
    for (const l0 of ['fighter', 'sniper']) out.push({ id: `ascent-${m.id}-${l0}`, kind: 'ascent', ascent: m.id, level0: l0, rand: m.seed + LEVELS.indexOf(l0) });
  }
  for (const c of CHALLENGES) {
    for (const l0 of ['sniper', 'sim_all']) out.push({ id: `challenge-${c.id}-${l0}`, kind: 'challenge', challenge: c.id, level0: l0, rand: c.seed + (l0 === 'sniper' ? 0 : 1) });
  }
  for (const m of MISSIONS) out.push({ id: `campaign-${m.id}-fighter`, kind: 'campaign', mission: m.id, level0: 'fighter', rand: (m.seed ?? 1) + 5 });
  return out;
}

let list = battles();
if (ONLY) list = list.filter((b) => b.kind === ONLY || b.id.startsWith(ONLY));
if (REPRO) list = list.filter((b) => b.id === REPRO);
if (LIMIT) list = list.slice(0, LIMIT);
if (!list.length) { console.log('нет таких боёв'); process.exit(1); }

// ------------------------------------------------------------------ сервер

const tmp = mkdtempSync(join(tmpdir(), 'worms-sim-'));
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
const stop = () => { server.kill(); rmSync(tmp, { recursive: true, force: true }); };
// Сервер не должен пережить прогон: иначе порт занят до перезагрузки
process.on('exit', () => server.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });

// ------------------------------------------------------------------ браузер

const browser = await chromium.launch(launchOptions());

async function openPage(errors) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 400)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`console: ${t}`.slice(0, 400));
  });
  await page.addInitScript(() => {
    // Первый запуск: без обучения и всплывашек меню
    localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'fighter' }));
  });
  await page.goto(`${BASE}/?lang=ru`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu')
    && Object.keys(window.__WORMS__.scene.getScene('Menu').buttons ?? {}).length > 0, null, { timeout: 180000 });
  await page.evaluate(async (r) => {
    window.__WORMS__.scene.getScene('Menu').streakShown = true;
    window.__simRenderEvery = r;
    await import('/tools/sim/agent.js');
  }, RENDER);
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp };
}

async function heap(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const h = await cdp.send('Runtime.getHeapUsage');
  return Math.round(h.usedSize / 1024 / 1024 * 10) / 10;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

const results = [];
const memory = [];   // [{worker, n, heapMB, counts}]
let done = 0;
const t0 = Date.now();

async function worker(wi, queue) {
  const errors = [];
  let pg = await openPage(errors);
  let n = 0;
  memory.push({ worker: wi, n, heapMB: await heap(pg.cdp), counts: await pg.page.evaluate(() => window.__sim.counts()) });
  while (queue.length) {
    const b = queue.shift();
    const cfg = {
      id: b.id, kind: b.kind, level0: b.level0, level1: b.level1, variant: b.variant, shape: b.shape,
      seed: b.seed, rand: b.rand ?? b.seed, id2: b.ascent ?? b.challenge ?? b.mission,
    };
    if (b.kind === 'ascent') cfg.id = b.ascent;
    if (b.kind === 'challenge') cfg.id = b.challenge;
    if (b.kind === 'campaign') cfg.id = b.mission;
    errors.length = 0;
    const started = Date.now();
    let info = null, res = null, status = 'ok';
    const phases = {};
    try {
      const tStart = Date.now();
      info = await pg.page.evaluate((c) => window.__sim.start(c), cfg);
      phases.start = Date.now() - tStart;
      let tRun = Date.now();
      if (process.env.SIM_PROFILE) { await pg.cdp.send('Profiler.enable'); await pg.cdp.send('Profiler.start'); }
      if (!info.ok) throw new Error(info.error);
      for (;;) {
        const tc = Date.now();
        const r = await withTimeout(pg.page.evaluate((f) => window.__sim.run(3000, { fps: f }), FPS), HANG_MS);
        if (process.env.SIM_DEBUG) console.error(`  run: ${Date.now() - tc} мс снаружи, ${Math.round(r.realMs)} мс внутри`);
        phases.inPage = Math.round((phases.inPage ?? 0) + r.realMs);
        if (r.done) break;
        if (r.stuck) { status = 'stuck'; break; }
        if (r.limit) { status = 'limit'; break; }
        if (r.lost) { status = 'lost'; break; }
        if (Date.now() - started > HANG_MS) { status = 'slow'; break; }
      }
      phases.run = Date.now() - tRun;
      if (process.env.SIM_PROFILE) {
        const { profile } = await pg.cdp.send('Profiler.stop');
        const byId = new Map(profile.nodes.map((x) => [x.id, x])); const self = new Map();
        for (let i = 0; i < profile.samples.length; i++) { const cf = byId.get(profile.samples[i]).callFrame; const k = `${cf.functionName} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + profile.timeDeltas[i]); }
        console.error([...self].sort((x, y) => y[1] - x[1]).slice(0, 20).map(([k, v]) => `  ${Math.round(v / 1000)} мс ${k}`).join('\n'));
      }
      res = await pg.page.evaluate(() => window.__sim.result());
      tRun = Date.now();
      await pg.page.evaluate(() => window.__sim.toMenu());
      phases.menu = Date.now() - tRun;
    } catch (e) {
      status = e.message === 'timeout' ? 'hang' : 'crash';
      res = { error: e.message.slice(0, 300) };
      // Страница могла умереть — дальше в новой
      await pg.ctx.close().catch(() => {});
      pg = await openPage(errors);
      n = 0;
    }
    n++;
    const rec = { ...b, status, phases, realSec: Math.round((Date.now() - started) / 100) / 10, info, ...res, errors: [...new Set(errors)] };
    results.push(rec);
    if (n % 5 === 0 || !queue.length) {
      memory.push({ worker: wi, n, heapMB: await heap(pg.cdp), counts: await pg.page.evaluate(() => window.__sim.counts()) });
    }
    done++;
    const anomalies = (rec.anomalies ?? []).map((a) => a.kind);
    console.log(`[${done}/${list.length}] ${b.id}: ${status} · победа ${rec.winner} · ходов ${rec.turns} · ${rec.gameTime} с игры · ${rec.realSec} с`
      + `${anomalies.length ? ` · ${anomalies.join(',')}` : ''}${rec.errors.length ? ` · ошибок ${rec.errors.length}` : ''}`);
  }
  await pg.ctx.close();
}

const queue = [...list];
await Promise.all(Array.from({ length: Math.min(WORKERS, list.length) }, (_, i) => worker(i, queue)));
await browser.close();
stop();

const report = {
  at: new Date().toISOString(), fps: FPS, workers: WORKERS, battles: results.length,
  realMinutes: Math.round((Date.now() - t0) / 6000) / 10, results, memory,
};
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`\n${results.length} боёв за ${report.realMinutes} мин → ${OUT}`);
