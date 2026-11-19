#!/usr/bin/env node
/**
 * Монтаж рекламного ролика из сырой записи tools/ads/record_ad.mjs.
 *
 *   node tools/ads/cut.mjs <raw.mp4> <out-dir> <lang> [game-url]
 *
 * По журналу (raw.json) берутся выстрелы, которые попали: от выстрела до
 * попадания и чуть после; решающий — дольше, с замедлением, которое игра
 * делает сама. Подписи и финальная плашка рисуются в браузере шрифтом игры
 * (прозрачные PNG), склейка и наложение — ffmpeg. На выходе 1080×1920, 30 к/с:
 *   <out>/<lang>-weapons.mp4  — хук и пять видов оружия, ~17 с
 *   <out>/<lang>-decisive.mp4 — один решающий выстрел и плашка, ~8 с
 *   <out>/<lang>-endcard.png  — финальная плашка отдельно (для баннеров)
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const RAW = process.argv[2];
const OUT = process.argv[3] || 'docs/ads';
const LANG = process.argv[4] || 'ru';
const URL = process.argv[5] || 'http://127.0.0.1:5199';
const log = JSON.parse(readFileSync(RAW.replace(/\.\w+$/, '.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });
const TMP = join(OUT, `.tmp-${LANG}`);
mkdirSync(TMP, { recursive: true });

const T = {
  ru: {
    hook: ['Артиллерия смайликов', 'прямо в Telegram'],
    mortar: 'Сплит-ракета: тапни — и их три',
    boomerang: 'Бумеранг бьёт туда и обратно',
    homing: 'Самонаводка сама найдёт цель',
    banana: 'Попрыгунчик: отскок — и бабах!',
    cluster: 'Кассета накрывает всех',
    holy: 'Решающий выстрел!',
    bazooka: 'Решающий выстрел!',
    end: ['SMILES', 'Играй бесплатно в Telegram', 'Вызови друга на дуэль'],
    decisive: 'Попади, если сможешь 🎯',
  },
  en: {
    hook: ['Smiley artillery', 'right in Telegram'],
    mortar: 'Split rocket: tap — and there are three',
    boomerang: 'The boomerang hits both ways',
    homing: 'The homing missile finds its target',
    banana: 'Bouncer: bounce — and kaboom!',
    cluster: 'The cluster bomb hits everyone',
    holy: 'The decisive shot!',
    bazooka: 'The decisive shot!',
    end: ['SMILES', 'Play free in Telegram', 'Challenge a friend to a duel'],
    decisive: 'Hit it if you can 🎯',
  },
}[LANG];

// ---------------------------------------------------------- куски видео

const shots = log.shots;
const marks = log.marks;
const decisiveAt = marks.find((m) => m.kind === 'decisive')?.t ?? null;
const segs = [];
for (let i = 0; i < shots.length; i++) {
  const s = shots[i];
  const next = shots[i + 1]?.t ?? Infinity;
  const hits = marks.filter((m) => m.t > s.t && m.t < next && (m.kind !== 'hit' || m.dmg > 0));
  const decisive = decisiveAt !== null && decisiveAt > s.t && decisiveAt < next;
  if (!hits.length && !decisive) continue;
  const hitT = decisive ? decisiveAt : hits[0].t;
  const from = Math.max(0, s.t - 350);
  // Решающий — до экрана «Победа»: замедление игра делает сама
  const to = Math.min(next - 100, hitT + (decisive ? 1100 : 900));
  // Долгий полёт — режем середину: начало выстрела и подлёт к цели
  const seg = { weapon: s.weapon, decisive, parts: [] };
  if (hitT - from > 2600 && !decisive) {
    seg.parts.push([from, from + 700]);
    seg.parts.push([hitT - 1200, to]);
  } else {
    seg.parts.push([from, to]);
  }
  segs.push(seg);
}
console.log('куски:', segs.map((s) => `${s.weapon}${s.decisive ? '!' : ''}`).join(' '));

// ---------------------------------------------------------- подписи (PNG)

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
await page.goto(`${URL}/?lang=${LANG}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
await page.evaluate(() => document.fonts.ready);

async function png(name, spec) {
  const url = await page.evaluate(async (sp) => {
    const W = 1080, H = 1920;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const fam = '"Worms UI", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    const text = (t, y, size, color, stroke = '#141821') => {
      let s = size;
      g.font = `800 ${s}px ${fam}`;
      while (g.measureText(t).width > W - 110 && s > 30) { s -= 2; g.font = `800 ${s}px ${fam}`; }
      ((sz, t, x, y, color) => {
        g.save();
        g.shadowColor = 'rgba(10,6,30,0.55)'; g.shadowBlur = sz / 5; g.shadowOffsetY = sz / 14;
        if (color === '#ffd166') {
          g.lineJoin = 'round'; g.lineWidth = Math.max(3, sz / 10); g.strokeStyle = '#5a2a08'; g.strokeText(t, x, y);
          g.shadowColor = 'transparent';
          const gr = g.createLinearGradient(0, y - sz * 0.5, 0, y + sz * 0.45);
          gr.addColorStop(0, '#fff6c2'); gr.addColorStop(0.45, '#ffd04a'); gr.addColorStop(1, '#f39a1e');
          g.fillStyle = gr;
        } else g.fillStyle = color;
        g.fillText(t, x, y);
        g.restore();
      })(s, t, W / 2, y, color);
    };
    if (sp.kind === 'caption') {
      // Плашка сверху — под верхней полосой интерфейса игры
      const y = 300;
      g.fillStyle = 'rgba(12,14,30,0.72)';
      g.beginPath(); g.roundRect(60, y - 70, W - 120, 140, 36); g.fill();
      text(sp.text, y, 66, '#ffd166');
    } else if (sp.kind === 'hook') {
      g.fillStyle = 'rgba(12,14,30,0.55)'; g.fillRect(0, 0, W, H);
      text(sp.lines[0], H / 2 - 70, 104, '#ffd166');
      text(sp.lines[1], H / 2 + 50, 80, '#ffffff');
    } else if (sp.kind === 'end') {
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#3b2a7a'); bg.addColorStop(0.55, '#1b2350'); bg.addColorStop(1, '#0d1326');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      // Лучи
      g.save(); g.translate(W / 2, 820);
      for (let i = 0; i < 16; i++) {
        g.rotate(Math.PI / 8);
        g.fillStyle = i % 2 ? 'rgba(255,209,102,0.07)' : 'rgba(255,255,255,0.04)';
        g.beginPath(); g.moveTo(0, 0); g.lineTo(-90, -1200); g.lineTo(90, -1200); g.closePath(); g.fill();
      }
      g.restore();
      text(sp.lines[0], 360, 190, '#ffd166');
      if (sp.fighter) {
        const im = new Image(); im.src = sp.fighter;
        await im.decode();
        const k = 560 / Math.max(im.width || 100, im.height || 100);
        g.drawImage(im, W / 2 - (im.width * k) / 2, 820 - (im.height * k) / 2, im.width * k, im.height * k);
      }
      text(sp.lines[1], 1270, 72, '#ffffff');
      text(sp.lines[2], 1370, 54, '#c9d1e3');
      const bw = 760, bh = 150, bx = (W - bw) / 2, by = 1500;
      const bgr = g.createLinearGradient(0, by, 0, by + bh);
      bgr.addColorStop(0, '#ff6a55'); bgr.addColorStop(1, '#d4322a');
      g.save(); g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
      g.fillStyle = bgr; g.beginPath(); g.roundRect(bx, by, bw, bh, 44); g.fill(); g.restore();
      g.lineWidth = 4; g.strokeStyle = 'rgba(90,15,10,0.9)'; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.roundRect(bx + 10, by + 6, bw - 20, bh * 0.38, 40); g.fill();
      text('@Fatalgame', by + bh / 2, 76, '#ffffff', '#7a1712');
    }
    return c.toDataURL('image/png');
  }, spec);
  const p = join(TMP, `${name}.png`);
  writeFileSync(p, Buffer.from(url.split(',')[1], 'base64'));
  return p;
}

// Боец для плашки — кадр победы из листа скина
const fighter = await page.evaluate(async () => {
  const st = await import('/src/platform/story.js');
  const s = window.__WORMS__.scene.getScene('Menu');
  const c = st.fighterFrame(s, 'smiley', 13);
  return c ? c.toDataURL('image/png') : null;
});
await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));

const hookPng = await png('hook', { kind: 'hook', lines: T.hook });
const endPng = await png('end', { kind: 'end', lines: T.end, fighter });
const capPng = {};
for (const s of segs) capPng[s.weapon] ??= await png(`cap-${s.weapon}`, { kind: 'caption', text: T[s.weapon] ?? '' });
const decPng = await png('cap-decisive', { kind: 'caption', text: T.decisive });
await browser.close();

// ---------------------------------------------------------- ffmpeg

const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${args.join(' ')}`);
};
const enc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-an'];
const SCALE = 'scale=1080:1920:flags=lanczos,setsar=1';

/** Кусок сырой записи [a, b] мс с подписью поверх. */
function clip(name, a, b, overlay, fadeIn = false) {
  const out = join(TMP, `${name}.mp4`);
  const dur = (b - a) / 1000;
  const vf = overlay
    ? `[0:v]${SCALE}[v];[1:v]format=rgba${fadeIn ? ',fade=in:st=0:d=0.25:alpha=1' : ''}[o];[v][o]overlay=0:0`
    : `[0:v]${SCALE}`;
  ff(['-ss', (a / 1000).toFixed(3), '-t', dur.toFixed(3), '-i', RAW,
    ...(overlay ? ['-loop', '1', '-t', dur.toFixed(3), '-i', overlay] : []),
    '-filter_complex', vf, ...enc, out]);
  return out;
}

/** Финальная плашка: лёгкий наезд, 2.4 с. */
function endcard(name) {
  const out = join(TMP, `${name}.mp4`);
  // Одна картинка на входе: zoompan сам растягивает её на d кадров
  ff(['-i', endPng,
    '-vf', "zoompan=z='min(1+on*0.0012,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=72:s=1080x1920:fps=30,format=yuv420p",
    ...enc, out]);
  return out;
}

function concat(parts, out) {
  const list = join(TMP, `list-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(list, parts.map((p) => `file '${resolve(p)}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, ...enc, '-movflags', '+faststart', out]);
}

// 1) Оружие: хук на первом куске, дальше по куску на оружие, финал — решающий
const parts = [];
let first = true;
let k = 0;
for (const s of segs) {
  for (const [a, b] of s.parts) {
    if (first) {
      // Первые 1.6 с — хук поверх игры, потом подпись оружия
      parts.push(clip(`p${k++}`, a, a + 1600, hookPng));
      if (b - (a + 1600) > 300) parts.push(clip(`p${k++}`, a + 1600, b, capPng[s.weapon], true));
      first = false;
    } else {
      parts.push(clip(`p${k++}`, a, b, capPng[s.weapon]));
    }
  }
}
parts.push(endcard('end'));
const weapons = join(OUT, `${LANG}-weapons.mp4`);
concat(parts, weapons);

// 2) Один решающий выстрел: «Попади, если сможешь», замедление, плашка
const dec = segs.find((s) => s.decisive);
if (dec) {
  const [a, b] = dec.parts[dec.parts.length - 1];
  const d = [clip('dec', Math.max(0, a - 400), b + 400, decPng), endcard('end2')];
  concat(d, join(OUT, `${LANG}-decisive.mp4`));
}
writeFileSync(join(OUT, `${LANG}-endcard.png`), readFileSync(endPng));
rmSync(TMP, { recursive: true, force: true });
console.log('готово:', OUT);
