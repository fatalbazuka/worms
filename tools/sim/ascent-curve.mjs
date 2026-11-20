#!/usr/bin/env node
/**
 * Кривая сложности «Подъёма»: за игрока — бот среднего уровня, по N боёв
 * на уровень с разной случайностью (карта у уровня своя), итог — доля побед
 * по уровням в docs/ascent-curve.md.
 *
 *   node tools/sim/ascent-curve.mjs                     # 20 боёв на уровень, 2 потока
 *   node tools/sim/ascent-curve.mjs --runs 10 --only up-3,up-4 --workers 2
 *   node tools/sim/ascent-curve.mjs --player sniper     # кто играет за игрока
 *
 * Те же сервер, страница и агент, что у run.mjs (tools/sim/agent.js), только
 * набор боёв свой. Результаты дописываются в tools/sim/ascent-curve.json по
 * уровням: повторный прогон части уровней не стирает остальные.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from '../../tests/browser.mjs';
import { ASCENT, chapterOf } from '../../src/campaign/ascent.js';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const PORT = Number(opt('port', 5664));
const WORKERS = Number(opt('workers', 2));
const RUNS = Number(opt('runs', 20));
const PLAYER = opt('player', 'fighter');
const ONLY = opt('only', null)?.split(',') ?? null;
const JSON_OUT = opt('json', 'tools/sim/ascent-curve.json');
const MD_OUT = opt('md', 'docs/ascent-curve.md');
const HANG_MS = Number(opt('hang', 240)) * 1000;
const NOTE = opt('note', '');

const levels = ASCENT.filter((m) => !ONLY || ONLY.includes(m.id));
const list = [];
for (let r = 0; r < RUNS; r++) {
  for (const m of levels) list.push({ ascent: m.id, run: r, rand: m.seed * 31 + r * 7919 + 1 });
}

// ------------------------------------------------------------------ сервер
const tmp = mkdtempSync(join(tmpdir(), 'worms-curve-'));
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
process.on('exit', () => server.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });

const browser = await chromium.launch(launchOptions());
async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'fighter' }));
  });
  await page.goto(`${BASE}/?lang=ru`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu')
    && Object.keys(window.__WORMS__.scene.getScene('Menu').buttons ?? {}).length > 0, null, { timeout: 180000 });
  await page.evaluate(async () => {
    window.__WORMS__.scene.getScene('Menu').streakShown = true;
    window.__simRenderEvery = 0;
    await import('/tools/sim/agent.js');
  });
  return { ctx, page };
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

const results = [];
let done = 0;
const t0 = Date.now();
async function worker(queue) {
  let pg = await openPage();
  while (queue.length) {
    const b = queue.shift();
    const started = Date.now();
    let status = 'ok', res = null;
    try {
      const info = await pg.page.evaluate((c) => window.__sim.start(c), { id: b.ascent, kind: 'ascent', level0: PLAYER, rand: b.rand });
      if (!info.ok) throw new Error(info.error);
      // Боты детерминированы, и без этого 20 боёв одного уровня — один и
      // тот же бой. Башня остаётся своей, а ветер и ящики хода — от зерна
      // с солью прогона: как у живых игроков, у каждого свой расклад
      await pg.page.evaluate((salt) => {
        const s = window.__WORMS__.scene.getScene('Game');
        // Сцена одна на все бои: заворачиваем метод класса, а не прошлую обёртку
        const orig = Object.getPrototypeOf(s).beginTurnRandom.bind(s);
        s.beginTurnRandom = (n) => orig(n + salt * 1000);
      }, b.run);
      for (;;) {
        const r = await withTimeout(pg.page.evaluate(() => window.__sim.run(3000, { fps: 60 })), HANG_MS);
        if (r.done) break;
        if (r.stuck) { status = 'stuck'; break; }
        if (r.limit) { status = 'limit'; break; }
        if (r.lost) { status = 'lost'; break; }
        if (Date.now() - started > HANG_MS) { status = 'slow'; break; }
      }
      res = await pg.page.evaluate(() => window.__sim.result());
      await pg.page.evaluate(() => window.__sim.toMenu());
    } catch (e) {
      status = e.message === 'timeout' ? 'hang' : 'crash';
      await pg.ctx.close().catch(() => {});
      pg = await openPage();
    }
    done++;
    results.push({ ...b, status, winner: res?.winner ?? null, turns: res?.turns ?? null });
    console.log(`[${done}/${list.length}] ${b.ascent}: ${status} · победа ${res?.winner} · ходов ${res?.turns} · ${Math.round((Date.now() - started) / 1000)} с`);
  }
  await pg.ctx.close();
}
const queue = [...list];
await Promise.all(Array.from({ length: Math.min(WORKERS, list.length) }, () => worker(queue)));
await browser.close();
stop();

// ----------------------------------------------------------------- итог
const prev = existsSync(JSON_OUT) ? JSON.parse(readFileSync(JSON_OUT, 'utf8')) : { levels: {} };
for (const m of levels) {
  const rs = results.filter((r) => r.ascent === m.id);
  const played = rs.filter((r) => r.status === 'ok');
  const wins = played.filter((r) => r.winner === 0).length;
  const turns = played.filter((r) => r.winner === 0).map((r) => r.turns);
  prev.levels[m.id] = {
    runs: rs.length, played: played.length, wins, rate: played.length ? wins / played.length : null,
    medianWinTurns: turns.length ? turns.sort((a, b) => a - b)[Math.floor(turns.length / 2)] : null,
    player: PLAYER, at: new Date().toISOString(), note: NOTE || prev.levels[m.id]?.note || '',
  };
}
writeFileSync(JSON_OUT, JSON.stringify(prev, null, 1));

const rows = ASCENT.map((m, i) => {
  const r = prev.levels[m.id];
  const pct = r?.rate == null ? '—' : `${Math.round(r.rate * 100)}%`;
  const boss = m.boss ? ' (босс)' : '';
  return `| ${i + 1} | ${m.id} | ${chapterOf(m).title} | ${m.title}${boss} | ${r ? `${r.wins}/${r.played}` : '—'} | ${pct} | ${r?.medianWinTurns ?? '—'} | ${r?.note ?? ''} |`;
});
const md = `# «Подъём»: кривая сложности

Симуляция: за игрока — бот «${PLAYER}», по ${RUNS} боёв на уровень с разной
случайностью (карта у уровня своя), \`node tools/sim/ascent-curve.mjs\`.
Доля побед игрока; ходы — медиана всех ходов боя в победах. Боты в это время
меняет другая правка — после неё кривую надо перемерить.

| # | id | глава | бой | победы | доля | ходов | заметки |
|---|----|-------|-----|--------|------|-------|---------|
${rows.join('\n')}
`;
// Разделы после таблицы (что поправлено и почему) пишутся руками — их сохраняем
const prevMd = existsSync(MD_OUT) ? readFileSync(MD_OUT, 'utf8') : '';
const tail = prevMd.indexOf('\n## ') >= 0 ? prevMd.slice(prevMd.indexOf('\n## ')) : '';
writeFileSync(MD_OUT, md + tail);
console.log(`\n${results.length} боёв за ${Math.round((Date.now() - t0) / 6000) / 10} мин → ${MD_OUT}`);
