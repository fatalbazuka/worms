#!/usr/bin/env node
/**
 * Ролик для приветствия бота и каталогов: бой двух снайперов на башне,
 * склеенный из самых громких моментов.
 *
 *   node tools/record_promo.mjs http://127.0.0.1:5199 [out-dir]
 *
 * Игра должна быть поднята (node server/index.mjs со STATIC_DIR). Холст
 * пишется прямо в странице (MediaRecorder → MP4), заодно журнал моментов:
 * попадания, добивания. Потом ffmpeg вырезает по ~2.6 с вокруг лучших и
 * склеивает в assets/promo/welcome.mp4 (540 px в ширину, без звука).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const URL = process.argv[2] || 'http://127.0.0.1:5199';
const OUT = process.argv[3] || 'assets/promo';
const TMP = process.env.TMPDIR || '/tmp';
const LIMIT_MS = Number(process.env.PROMO_MS || 70000);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await page.addInitScript(() => localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'rookie' })));
await page.goto(`${URL}/?seed=${process.env.PROMO_SEED || 4242}&lang=${process.env.PROMO_LANG || 'ru'}&pz=${process.env.PROMO_ZOOM || 1.7}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
await page.evaluate(async () => {
  const { towerMatch } = await import('/src/core/match.js');
  const m = towerMatch('sniper');
  m.teams[0] = { worms: 2, control: 'bot', level: 'sniper' };
  window.__WORMS__.scene.getScene('Menu').start(m);
});
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.turn?.state, null, { timeout: 40000 });
await page.waitForTimeout(800);

const result = await page.evaluate(async (limit) => {
  const s = window.__WORMS__.scene.getScene('Game');
  s.hud.setHelp?.(false);
  // Ближе, чем в игре: в ролике шириной 540 px бойцы иначе с булавку
  const zoom = Number(new URLSearchParams(location.search).get('pz') || 1.7);
  s.rig.setZoom(s.rig.zoom * zoom);
  const canvas = s.game.canvas;
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9'].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  const marks = [];
  const impact = s._impact.bind(s);
  s._impact = (x, y, dmg, foes) => { marks.push({ t: performance.now() - t0, w: dmg + foes * 20 }); return impact(x, y, dmg, foes); };
  const died = s.onWormDied.bind(s);
  s.onWormDied = (w) => { marks.push({ t: performance.now() - t0, w: 60 + (s.checkVictory() !== null ? 60 : 0) }); return died(w); };
  rec.start(500);
  await new Promise((res) => {
    const end = performance.now() + limit;
    const tick = () => (s.gameOverUi || performance.now() > end ? res() : setTimeout(tick, 250));
    tick();
  });
  await new Promise((res) => setTimeout(res, 1800));
  await new Promise((res) => { rec.onstop = res; rec.stop(); });
  const blob = new Blob(chunks, { type });
  return { type, marks, data: Array.from(new Uint8Array(await blob.arrayBuffer())) };
}, LIMIT_MS);
await browser.close();

const raw = join(TMP, `promo-raw.${result.type.includes('mp4') ? 'mp4' : 'webm'}`);
writeFileSync(raw, Buffer.from(result.data));
console.log('сырая запись', raw, 'моментов', result.marks.length);

// Лучшие моменты, не ближе 3 с друг к другу, в порядке времени
const picked = [];
for (const m of [...result.marks].sort((a, b) => b.w - a.w)) {
  if (picked.length >= 5) break;
  if (picked.every((p) => Math.abs(p.t - m.t) > 3000)) picked.push(m);
}
picked.sort((a, b) => a.t - b.t);
if (!picked.length) { console.log('ярких моментов нет — оставляю сырую запись'); process.exit(1); }

mkdirSync(OUT, { recursive: true });
const parts = picked.map((m, i) => {
  const from = Math.max(0, m.t / 1000 - 1.6);
  const out = join(TMP, `promo-part${i}.mp4`);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', from.toFixed(2), '-i', raw, '-t', '2.6',
    '-vf', 'scale=540:-2,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-an', out], { stdio: 'inherit' });
  return out;
});
const list = join(TMP, 'promo-list.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const dst = join(OUT, 'welcome.mp4');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', dst], { stdio: 'inherit' });
console.log('готово', dst, picked.map((p) => `${(p.t / 1000).toFixed(1)}с`).join(' '));
