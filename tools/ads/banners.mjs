#!/usr/bin/env node
/**
 * Баннеры из лучших кадров боя: 9:16 (сторис), 1:1 (пост), 16:9 (обложка).
 *
 *   node tools/ads/banners.mjs <raw.mp4> <out-dir> <lang> [game-url]
 *
 * Кадры берутся из записи tools/ads/record_ad.mjs в моменты попаданий
 * (журнал raw.json), текст рисуется в браузере шрифтом игры.
 * На выходе <out>/banners/<lang>-<тема>-<размер>.jpg.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const RAW = process.argv[2];
const OUT = join(process.argv[3] || 'docs/ads', 'banners');
const LANG = process.argv[4] || 'ru';
const URL = process.argv[5] || 'http://127.0.0.1:5199';
const log = JSON.parse(readFileSync(RAW.replace(/\.\w+$/, '.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });
const TMP = join(OUT, `.tmp-${LANG}`);
mkdirSync(TMP, { recursive: true });

// Кадры: решающий (через 0.4 с — выкрик вырос), сильнейшее попадание, дуплет/кассета
const by = (k) => log.marks.filter((m) => m.kind === k);
const strongest = log.marks.filter((m) => m.kind === 'hit').sort((a, b) => b.dmg - a.dmg)[0];
const moments = {
  decisive: by('decisive')[0]?.t ?? null,
  boom: strongest?.t ?? null,
  multi: (by('multi')[0] ?? log.marks.filter((m) => m.kind === 'hit' && m.dmg > 0)[1])?.t ?? null,
};
const frame = (name, t, delay) => {
  if (t === null) return null;
  const p = join(TMP, `${name}.png`);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', ((t + delay) / 1000).toFixed(3), '-i', RAW,
    '-frames:v', '1', '-vf', 'scale=1080:1920:flags=lanczos', p], { stdio: 'inherit' });
  return p;
};
const frames = {
  decisive: frame('decisive', moments.decisive, 420),
  boom: frame('boom', moments.boom, 160),
  multi: frame('multi', moments.multi, 160),
};

const TEXT = {
  ru: {
    decisive: ['Попади, если сможешь', 'артиллерия смайликов в Telegram'],
    boom: ['18 видов оружия', 'бумеранг, сплит-ракета, самонаводка'],
    multi: ['Вызови друга на дуэль', 'напиши @Fatalgame в любом чате'],
    cta: 'Играть в Telegram',
  },
  en: {
    decisive: ['Hit it if you can', 'smiley artillery right in Telegram'],
    boom: ['18 weapons', 'boomerang, split rocket, homing missile'],
    multi: ['Challenge a friend to a duel', 'type @Fatalgame in any chat'],
    cta: 'Play in Telegram',
  },
}[LANG];
const SIZES = { story: [1080, 1920], square: [1080, 1080], wide: [1280, 720] };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
await page.goto(`${URL}/?lang=${LANG}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
await page.evaluate(() => document.fonts.ready);

for (const [theme, path] of Object.entries(frames)) {
  if (!path) continue;
  const src = `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  for (const [size, [W, H]] of Object.entries(SIZES)) {
    const url = await page.evaluate(async ([data, W, H, lines, cta]) => {
      const img = new Image(); img.src = data; await img.decode();
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      // Кадр «обложкой»: в квадрате и 16:9 — середина башни, где действие
      const k = Math.max(W / img.width, H / img.height);
      const w = img.width * k, h = img.height * k;
      const oy = H < img.height * k ? (H - h) * 0.42 : (H - h) / 2;
      g.drawImage(img, (W - w) / 2, oy, w, h);
      const wide = W > H;
      const fam = '"Worms UI", system-ui, sans-serif';
      // Затемнение под текст
      const grd = wide ? g.createLinearGradient(0, 0, W * 0.75, 0) : g.createLinearGradient(0, H * 0.45, 0, H);
      grd.addColorStop(0, wide ? 'rgba(8,10,24,0.92)' : 'rgba(8,10,24,0)');
      grd.addColorStop(wide ? 0.6 : 0.5, 'rgba(8,10,24,0.82)');
      grd.addColorStop(1, wide ? 'rgba(8,10,24,0)' : 'rgba(8,10,24,0.95)');
      g.fillStyle = grd;
      if (wide) g.fillRect(0, 0, W * 0.75, H); else g.fillRect(0, H * 0.45, W, H * 0.55);
      const top = g.createLinearGradient(0, 0, 0, 200);
      top.addColorStop(0, 'rgba(8,10,24,0.85)'); top.addColorStop(1, 'rgba(8,10,24,0)');
      g.fillStyle = top; g.fillRect(0, 0, W, 200);
      g.lineJoin = 'round'; g.textBaseline = 'middle';
      const text = (t, x, y, size, color, align = 'center', maxW = W - 100, stroke = '#141821') => {
        let s = size; g.textAlign = align;
        g.font = `800 ${s}px ${fam}`;
        while (g.measureText(t).width > maxW && s > 24) { s -= 2; g.font = `800 ${s}px ${fam}`; }
        g.lineWidth = s / 4.5; g.strokeStyle = stroke; g.strokeText(t, x, y);
        g.fillStyle = color; g.fillText(t, x, y);
      };
      // Логотип сверху
      text('SMILES', wide ? 60 : W / 2, wide ? 70 : 90, wide ? 64 : 92, '#ffd166', wide ? 'left' : 'center');
      // Заголовок, подзаголовок, кнопка
      const pill = (x, y, bw, bh, label) => {
        g.fillStyle = '#e8463c'; g.beginPath(); g.roundRect(x, y, bw, bh, bh / 2.6); g.fill();
        g.lineWidth = 8; g.strokeStyle = '#141821'; g.stroke();
        text(label, x + bw / 2, y + bh / 2, bh * 0.42, '#ffffff', 'center', bw - 40, '#7a1712');
      };
      if (wide) {
        text(lines[0], 60, H * 0.45, 76, '#ffd166', 'left', W * 0.6);
        text(lines[1], 60, H * 0.45 + 84, 40, '#ffffff', 'left', W * 0.6);
        pill(60, H - 170, 520, 104, `${cta} · @Fatalgame`);
      } else {
        const base = H - (H > 1200 ? 520 : 400);
        text(lines[0], W / 2, base, H > 1200 ? 96 : 84, '#ffd166');
        text(lines[1], W / 2, base + (H > 1200 ? 110 : 92), H > 1200 ? 52 : 44, '#ffffff');
        const bw = 720, bh = H > 1200 ? 140 : 118;
        pill((W - bw) / 2, H - (H > 1200 ? 250 : 190), bw, bh, `${cta} · @Fatalgame`);
      }
      return c.toDataURL('image/jpeg', 0.9);
    }, [src, W, H, TEXT[theme], TEXT.cta]);
    writeFileSync(join(OUT, `${LANG}-${theme}-${size}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  }
}
await browser.close();
rmSync(TMP, { recursive: true, force: true });
console.log('баннеры:', OUT);
