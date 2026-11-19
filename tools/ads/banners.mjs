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
      const fam = '"Worms UI", system-ui, sans-serif';
      g.lineJoin = 'round'; g.textBaseline = 'middle';
      const fit = (t, size, maxW) => {
        let sz = size; g.font = `800 ${sz}px ${fam}`;
        while (g.measureText(t).width > maxW && sz > 24) { sz -= 2; g.font = `800 ${sz}px ${fam}`; }
        return sz;
      };
      const text = (t, x, y, size, color, align = 'center', maxW = W - 100, stroke = '#141821') => {
        const sz = fit(t, size, maxW); g.textAlign = align;
        g.lineWidth = sz / 4.5; g.strokeStyle = stroke; g.strokeText(t, x, y);
        g.fillStyle = color; g.fillText(t, x, y);
        return sz;
      };
      // Несколько строк по ширине: слова переносятся, кегль общий
      const para = (t, x, y, size, color, maxW, lh = 1.15) => {
        g.font = `800 ${size}px ${fam}`;
        const words = t.split(' ');
        const rows = [];
        let row = '';
        for (const w of words) {
          const test = row ? `${row} ${w}` : w;
          if (g.measureText(test).width > maxW && row) { rows.push(row); row = w; } else row = test;
        }
        if (row) rows.push(row);
        rows.forEach((r, k) => text(r, x, y + k * size * lh, size, color, 'left', maxW));
        return y + rows.length * size * lh;
      };
      const pill = (x, y, bw, bh, label) => {
        g.fillStyle = '#e8463c'; g.beginPath(); g.roundRect(x, y, bw, bh, bh / 2.6); g.fill();
        g.lineWidth = 8; g.strokeStyle = '#141821'; g.stroke();
        text(label, x + bw / 2, y + bh / 2, bh * 0.4, '#ffffff', 'center', bw - 40, '#7a1712');
      };
      if (H > W) {
        // Сторис: кадр целиком, текст наверху (там полоса интерфейса игры),
        // кнопка внизу — поверх джойстиков
        g.drawImage(img, 0, 0, W, H);
        const top = g.createLinearGradient(0, 0, 0, 640);
        top.addColorStop(0, 'rgba(8,10,24,0.95)'); top.addColorStop(0.7, 'rgba(8,10,24,0.75)'); top.addColorStop(1, 'rgba(8,10,24,0)');
        g.fillStyle = top; g.fillRect(0, 0, W, 640);
        const bot = g.createLinearGradient(0, H - 420, 0, H);
        bot.addColorStop(0, 'rgba(8,10,24,0)'); bot.addColorStop(1, 'rgba(8,10,24,0.92)');
        g.fillStyle = bot; g.fillRect(0, H - 420, W, 420);
        text('SMILES', W / 2, 120, 96, '#ffd166');
        text(lines[0], W / 2, 270, 96, '#ffffff');
        text(lines[1], W / 2, 380, 54, '#ffd166');
        pill((W - 760) / 2, H - 230, 760, 140, `${cta} · @Fatalgame`);
      } else {
        // 1:1 и 16:9: фон кампании, кадр «телефоном» справа, текст слева
        const bg = g.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, '#3b2a7a'); bg.addColorStop(0.55, '#1b2350'); bg.addColorStop(1, '#0d1326');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);
        const ph = H - (W > H ? 70 : 90), pw = Math.round(ph * img.width / img.height);
        const px = W - pw - (W > H ? 70 : 50), py = (H - ph) / 2, r = 34;
        g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 40; g.shadowOffsetY = 14;
        g.beginPath(); g.roundRect(px, py, pw, ph, r); g.fillStyle = '#000'; g.fill(); g.restore();
        g.save(); g.beginPath(); g.roundRect(px, py, pw, ph, r); g.clip(); g.drawImage(img, px, py, pw, ph); g.restore();
        g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.2)'; g.beginPath(); g.roundRect(px, py, pw, ph, r); g.stroke();
        const tx = 60, tw = px - tx - 50;
        const big = W > H ? 74 : 70;
        text('SMILES', tx, W > H ? 90 : 110, W > H ? 64 : 76, '#ffd166', 'left', tw);
        let y = para(lines[0], tx, H * (W > H ? 0.36 : 0.34), big, '#ffffff', tw);
        y = para(lines[1], tx, y + 20, Math.round(big * 0.55), '#ffd166', tw, 1.25);
        pill(tx, H - (W > H ? 170 : 200), Math.min(tw, 520), W > H ? 100 : 110, `${cta} · @Fatalgame`);
      }
      return c.toDataURL('image/jpeg', 0.9);
    }, [src, W, H, TEXT[theme], TEXT.cta]);
    writeFileSync(join(OUT, `${LANG}-${theme}-${size}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  }
}
await browser.close();
rmSync(TMP, { recursive: true, force: true });
console.log('баннеры:', OUT);
