#!/usr/bin/env node
/**
 * Скриншоты для каталогов (Telegram Apps Center, тематические каналы):
 * пять экранов 1080×1920 на русском и английском.
 *
 *   node tools/store_shots.mjs http://127.0.0.1:5199 [out-dir]
 *
 * Снимаются настоящие экраны игры (360×640 при плотности 3), потом там же,
 * в браузере (там загружен шрифт игры), каждый кладётся в рамку с подписью:
 * OUT/<lang>/1.jpg … 5.jpg. Сырые кадры — OUT/raw (их в репозиторий не кладём).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.argv[2] || 'http://127.0.0.1:5199';
const DEST = process.argv[3] || 'docs/store';
const OUT = join(DEST, 'raw');
mkdirSync(OUT, { recursive: true });

const CAPTIONS = {
  ru: [
    ['Артиллерия смайликов', 'прямо в Telegram'],
    ['Взрывай, роняй с этажей,', 'цепляйся тросом'],
    ['18 видов оружия', 'бумеранг, сплит-ракета, самонаводка'],
    ['Ящики с редкостью', 'и оружейный дождь'],
    ['Делись победой в сторис', 'и зови друзей на дуэль'],
  ],
  en: [
    ['Smiley artillery', 'right in Telegram'],
    ['Blast, knock enemies off,', 'swing on a rope'],
    ['18 weapons', 'boomerang, split rocket, homing missile'],
    ['Crates with rarity', 'and weapon rain'],
    ['Share wins in your story', 'and challenge friends'],
  ],
};
const NAMES = ['1-aim', '2-boom', '3-arsenal', '4-crates', '5-story'];

const browser = await chromium.launch();

async function shoot(lang) {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await page.addInitScript(() => {
    localStorage.setItem('worms.play.v1', JSON.stringify({ level: 'rookie' }));
  });
  const shot = (name) => page.screenshot({ path: join(OUT, `${lang}-${name}.png`) });
  await page.goto(`${URL}/?seed=4242&lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
  await page.waitForTimeout(1500);
  // Меню: закрыть подарок дня, если всплыл
  await page.evaluate(() => {
    const m = window.__WORMS__.scene.getScene('Menu');
    m.closePopup?.(); m.dailyPopup?.close?.();
  });

  await page.evaluate(async () => {
    const { towerMatch } = await import('/src/core/match.js');
    window.__WORMS__.scene.getScene('Menu').start(towerMatch('sniper'));
  });
  await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game')?.canPlayerAct?.(), null, { timeout: 40000 });
  await page.waitForTimeout(1200);

  // 1. Прицел рогаткой: рычаг натянут, видна траектория
  await page.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    s.hud.setHelp?.(false);
    s.rig.setZoom(s.rig.zoom * 1.35);
    const w = s.turn.activeWorm;
    const e = s.worms.find((o) => o.alive && o.team !== w.team);
    w.facing = e.x >= w.x ? 1 : -1;
    s.aimAngle = 0.7;
    s.charging = true;
    s.charge = 0.62;
    s.rig.focus?.(w);
  });
  await page.waitForTimeout(500);
  await shot('1-aim');

  // 2. Взрыв: святая граната точно в соперника
  await page.evaluate(async () => {
    const s = window.__WORMS__.scene.getScene('Game');
    s.charging = false; s.charge = 0;
    const { WEAPONS_BY_ID } = await import('/src/weapons/index.js');
    const w = s.turn.activeWorm;
    const e = s.worms.find((o) => o.alive && o.team !== w.team);
    // Камеру — на соперника и не отпускать к стрелку
    s.rig.manual = true; s.rig.idle = -1e9;
    s.rig.setViewLeft(e.x - s.rig.visibleW / 2);
    s.rig.setViewTop(s.rig.clampTop(e.y - s.rig.visibleH * 0.45));
    window.__boomAt = () => s.explode(e.x, e.centerY, WEAPONS_BY_ID.holy.explosion, w);
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__boomAt());
  await page.waitForTimeout(140);
  await shot('2-boom');

  // 3. Арсенал: всё оружие с патронами
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const s = window.__WORMS__.scene.getScene('Game');
    const { WEAPONS } = await import('/src/weapons/index.js');
    WEAPONS.forEach((w, i) => { if (s.turn.ammo[s.turn.currentTeam][i] !== null) s.turn.ammo[s.turn.currentTeam][i] = 2; });
    s.hud.inventory.toggle();
  });
  await page.waitForTimeout(600);
  await shot('3-arsenal');

  // 4. Ящики редкостей и оружейный дождь
  await page.evaluate(async () => {
    const s = window.__WORMS__.scene.getScene('Game');
    s.hud.inventory.toggle();
    const { Crate } = await import('/src/entities/Crate.js');
    const w = s.turn.activeWorm;
    ['rare', 'epic', 'legendary'].forEach((r, k) => {
      const c = new Crate(s, w.x - 70 + k * 70, 'weapon', 0, r);
      c.y = (s.terrain.surfaceYAt(c.x, w.y - 80) ?? w.y);
      c._land?.();
      s.crates.push(c);
    });
    s.fx.banner(document.documentElement.lang === 'en' ? 'Оружейный дождь!' : 'Оружейный дождь!', '#8cc8ff', 3000);
  });
  await page.waitForTimeout(700);
  await shot('4-crates');

  // 5. Карточка сторис
  const card = await page.evaluate(async () => {
    const s = window.__WORMS__.scene.getScene('Game');
    const st = await import('/src/platform/story.js');
    const w = s.turn.activeWorm;
    const c = st.drawStory({ shot: await st.snapshot(s), fighter: st.fighterFrame(s, w.sheet, 13), title: 'ПОБЕДА!',
      lines: ['Урон за бой: 212 · добито: 2', 'Ходов: 7'], cta: 'Сыграй со мной!', handle: '@Fatalgame' });
    return c.toDataURL('image/png');
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(OUT, `${lang}-5-story.png`), Buffer.from(card.split(',')[1], 'base64'));
  await page.close();
}

/** Рамка: фон, подпись сверху, экран со скруглёнными углами. */
async function frame(lang) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  await page.goto(`${URL}/?lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 40000 });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(join(DEST, lang), { recursive: true });
  for (let i = 0; i < NAMES.length; i++) {
    const src = `data:image/png;base64,${readFileSync(join(OUT, `${lang}-${NAMES[i]}.png`)).toString('base64')}`;
    const url = await page.evaluate(async ([data, [l1, l2]]) => {
      const img = new Image();
      img.src = data;
      await img.decode();
      const W = 1080, H = 1920;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, '#3b2a7a'); bg.addColorStop(0.55, '#1b2350'); bg.addColorStop(1, '#0d1326');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      // Подпись
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const fam = '"Worms UI", system-ui, sans-serif';
      const text = (t, y, size, color) => {
        g.font = `800 ${size}px ${fam}`;
        let s = size;
        while (g.measureText(t).width > W - 100 && s > 30) { s -= 2; g.font = `800 ${s}px ${fam}`; }
        g.lineJoin = 'round'; g.lineWidth = s / 5; g.strokeStyle = '#141821'; g.strokeText(t, W / 2, y);
        g.fillStyle = color; g.fillText(t, W / 2, y);
      };
      text(l1, 150, 84, '#ffd166');
      text(l2, 250, 58, '#ffffff');
      // Экран
      const h = 1520, w = Math.round(h * img.width / img.height);
      const x = (W - w) / 2, y = 360, r = 44;
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 50; g.shadowOffsetY = 18;
      g.beginPath(); g.roundRect(x, y, w, h, r); g.fillStyle = '#000'; g.fill();
      g.restore();
      g.save(); g.beginPath(); g.roundRect(x, y, w, h, r); g.clip();
      g.drawImage(img, x, y, w, h);
      g.restore();
      g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.roundRect(x, y, w, h, r); g.stroke();
      return c.toDataURL('image/jpeg', 0.88);
    }, [src, CAPTIONS[lang][i]]);
    writeFileSync(join(DEST, lang, `${i + 1}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  }
  await page.close();
}

for (const lang of ['ru', 'en']) await shoot(lang);
for (const lang of ['ru', 'en']) await frame(lang);
await browser.close();
console.log('готово:', DEST);
