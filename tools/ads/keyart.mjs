#!/usr/bin/env node
/**
 * Надписи на нарисованные картинки кампании — шрифтом игры, RU и EN.
 *
 *   node tools/ads/keyart.mjs http://127.0.0.1:5199
 *
 * Берёт docs/ads/keyart/src/*.png (картинки без текста) и кладёт готовые
 * docs/ads/keyart/<lang>/{poster,duel,tournament,arsenal}.jpg, плюс аватарку
 * бота и иконку каталога (docs/ads/keyart/avatar-640.jpg, icon-512.png).
 * Текст рисуется в браузере, где загружен шрифт игры (Nunito).
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.argv[2] || 'http://127.0.0.1:5199';
const SRC = 'docs/ads/keyart/src';
const OUT = 'docs/ads/keyart';

const TEXT = {
  ru: {
    poster: ['SMILES', 'Попади, если сможешь', 'Играть в Telegram · @Fatalgame'],
    duel: ['Вызови друга на дуэль', 'напиши @Fatalgame в любом чате'],
    tournament: ['Турнир недели', 'суббота, 19:00 МСК · 16 мест · бесплатно', 'Записаться · @Fatalgame'],
    arsenal: ['18 видов оружия', 'ящики с редкостью и оружейный дождь', '@Fatalgame'],
  },
  en: {
    poster: ['SMILES', 'Hit it if you can', 'Play in Telegram · @Fatalgame'],
    duel: ['Challenge a friend to a duel', 'type @Fatalgame in any chat'],
    tournament: ['Weekly Tournament', 'Saturday 19:00 MSK · 16 slots · free', 'Sign up · @Fatalgame'],
    arsenal: ['18 weapons', 'crates with rarity and weapon rain', '@Fatalgame'],
  },
};
const FILES = { poster: '01_poster.png', duel: '02_duel.png', tournament: '05_tournament.png', arsenal: '06_arsenal.png' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
await page.goto(`${URL}/?lang=ru`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
await page.evaluate(() => document.fonts.ready);

const data = (f) => `data:image/png;base64,${readFileSync(join(SRC, f)).toString('base64')}`;

for (const lang of ['ru', 'en']) {
  mkdirSync(join(OUT, lang), { recursive: true });
  for (const [kind, file] of Object.entries(FILES)) {
    const url = await page.evaluate(async ([src, kind, t]) => {
      const img = new Image(); img.src = src; await img.decode();
      const W = img.width, H = img.height;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const fam = '"Worms UI", system-ui, sans-serif';
      g.lineJoin = 'round'; g.textBaseline = 'middle';
      // Заголовок: золотой градиент, тонкая тёплая обводка, мягкая тень.
      // Подписи: белые, без обводки — только тень, чтобы читались на картинке.
      const fit = (s, size, maxW) => {
        let sz = size; g.font = `800 ${sz}px ${fam}`;
        while (g.measureText(s).width > maxW && sz > 20) { sz -= 2; g.font = `800 ${sz}px ${fam}`; }
        return sz;
      };
      const text = (s, x, y, size, color, align = 'center', maxW = W - 120) => {
        const sz = fit(s, size, maxW); g.textAlign = align;
        const gold = color === '#ffd166';
        g.save();
        g.shadowColor = 'rgba(10,6,30,0.55)'; g.shadowBlur = sz / 5; g.shadowOffsetY = sz / 14;
        if (gold) {
          g.lineWidth = Math.max(3, sz / 10); g.strokeStyle = '#5a2a08'; g.strokeText(s, x, y);
          g.shadowColor = 'transparent';
          const gr = g.createLinearGradient(0, y - sz * 0.5, 0, y + sz * 0.45);
          gr.addColorStop(0, '#fff6c2'); gr.addColorStop(0.45, '#ffd04a'); gr.addColorStop(1, '#f39a1e');
          g.fillStyle = gr;
        } else {
          g.fillStyle = color;
        }
        g.fillText(s, x, y);
        g.restore();
        return sz;
      };
      const pill = (x, y, w, h, label) => {
        g.save(); g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
        const bg = g.createLinearGradient(0, y, 0, y + h);
        bg.addColorStop(0, '#ff6a55'); bg.addColorStop(1, '#d4322a');
        g.fillStyle = bg; g.beginPath(); g.roundRect(x, y, w, h, h / 2.4); g.fill(); g.restore();
        g.lineWidth = Math.max(3, h / 30); g.strokeStyle = 'rgba(90,15,10,0.9)'; g.beginPath(); g.roundRect(x, y, w, h, h / 2.4); g.stroke();
        // блик сверху
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.roundRect(x + 10, y + 6, w - 20, h * 0.38, h / 3); g.fill();
        text(label, x + w / 2, y + h / 2, h * 0.4, '#ffffff', 'center', w - 50);
      };
      const shade = (x0, y0, x1, y1, from, to) => {
        const gr = g.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, from); gr.addColorStop(1, to);
        g.fillStyle = gr;
        g.fillRect(Math.min(x0, x1) || 0, Math.min(y0, y1) || 0, Math.abs(x1 - x0) || W, Math.abs(y1 - y0) || H);
      };
      if (kind === 'poster') {
        // Небо сверху спокойное — туда заголовок; кнопка — внизу, на облаках
        shade(0, 0, 0, 520, 'rgba(20,14,50,0.55)', 'rgba(20,14,50,0)');
        text(t[0], W / 2, 150, 170, '#ffd166');
        text(t[1], W / 2, 300, 86, '#ffffff');
        shade(0, H - 380, 0, H, 'rgba(20,14,50,0)', 'rgba(20,14,50,0.6)');
        pill((W - 820) / 2, H - 230, 820, 140, t[2]);
      } else if (kind === 'duel') {
        shade(0, H * 0.7, 0, H, 'rgba(30,14,30,0)', 'rgba(30,14,30,0.78)');
        text(t[0], W / 2, H - 170, 78, '#ffd166');
        text(t[1], W / 2, H - 80, 48, '#ffffff');
      } else if (kind === 'tournament') {
        // Левая треть — небо: туда текст, на градиенте
        shade(0, 0, W * 0.5, 0, 'rgba(40,20,70,0.72)', 'rgba(40,20,70,0)');
        const x = 60, mw = W * 0.31;
        text('🏆', x + 50, H * 0.2, 110, '#ffffff', 'center');
        text(t[0], x, H * 0.38, 92, '#ffd166', 'left', mw);
        text(t[1], x, H * 0.5, 38, '#ffffff', 'left', mw);
        pill(x, H * 0.62, mw, 96, t[2]);
      } else if (kind === 'arsenal') {
        shade(0, H * 0.72, 0, H, 'rgba(20,10,50,0)', 'rgba(20,10,50,0.85)');
        text(t[0], 70, H - 140, 86, '#ffd166', 'left', W * 0.55);
        text(t[1], 70, H - 62, 40, '#ffffff', 'left', W * 0.55);
        pill(W - 70 - 380, H - 150, 380, 100, t[2]);
      }
      return c.toDataURL('image/jpeg', 0.9);
    }, [data(file), kind, TEXT[lang][kind]]);
    writeFileSync(join(OUT, lang, `${kind}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  }
}

// Аватарка бота (Telegram просит квадрат, 640 — с запасом) и иконка каталога
const sq = async (file, size, type) => page.evaluate(async ([src, size, type]) => {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, size, size);
  return c.toDataURL(type, 0.92);
}, [data(file), size, type]);
writeFileSync(join(OUT, 'avatar-640.jpg'), Buffer.from((await sq('03_avatar.png', 640, 'image/jpeg')).split(',')[1], 'base64'));
writeFileSync(join(OUT, 'icon-512.png'), Buffer.from((await sq('04_catalog_icon.png', 512, 'image/png')).split(',')[1], 'base64'));
await browser.close();
console.log('готово:', OUT);
