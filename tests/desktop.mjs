/**
 * Интерфейс для ПК: мышь и клавиатура.
 *
 * Браузер без сенсорного экрана, как обычный компьютер. Проверяется, что
 * игра сама выбрала схему для мыши, крупных тач-кнопок нет, боец целится
 * за курсором, удержание левой кнопки копит силу и стреляет, правая тянет
 * карту, горячие клавиши меняют оружие, а клик, закрывший подсказку, не
 * уходит в выстрел. И что в консоли чисто — SDK Telegram вне Telegram не
 * грузится вовсе.
 */
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
const requests = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if ((m.type() === 'error' || m.type() === 'warning') && !t.includes('Failed to load resource')
    && !t.includes('GL Driver')) errors.push(`${m.type()}: ${t}`);
});
page.on('request', (r) => requests.push(r.url()));

await page.goto(`${URL}/?seed=4242`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.isActive('Menu'), null, { timeout: 30000 });

const mode = await page.evaluate(async () => (await import('/src/platform/device.js')).uiMode());
check('без сенсорного экрана выбран интерфейс для ПК', mode === 'desktop', mode);
check('SDK Telegram вне Telegram не загружается',
  !requests.some((u) => u.includes('telegram-web-app.js')));
const menuButtons = await page.evaluate(() => Object.keys(window.__WORMS__.scene.getScene('Menu').buttons));
check('в меню есть переключатели управления и звука',
  menuButtons.includes('ui-mode') && menuButtons.includes('sound'), menuButtons.join(', '));

await page.evaluate(async () => {
  const m = await import('/src/core/match.js');
  window.__WORMS__.scene.getScene('Menu').start(m.quickMatch('forest'));
});
await page.waitForFunction(() => {
  const s = window.__WORMS__?.scene.getScene('Game');
  return window.__WORMS__.scene.isActive('Game') && s?.turn?.activeWorm && !s.landing();
}, null, { timeout: 40000 });

const state = () => page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  const w = s.turn.activeWorm;
  return {
    help: s.hud.helpVisible, angle: s.aimAngle, facing: w?.facing, charge: s.charge,
    state: s.turn.state, weapon: s.turn.weaponIndex, team: s.turn.currentTeam,
    view: s.rig.viewLeft, arsenal: Boolean(s.hud.inventory?.isOpen),
  };
});
// Экранная точка бойца в CSS-пикселях страницы
const wormOnPage = () => page.evaluate(() => {
  const g = window.__WORMS__;
  const s = g.scene.getScene('Game');
  const w = s.turn.activeWorm;
  const r = g.canvas.getBoundingClientRect();
  const k = r.width / g.scale.width;
  return {
    x: r.left + s.rig.screenX(w.x) * k,
    y: r.top + (w.centerY - s.rig.viewTop) * s.rig.zoom * k,
  };
});

const hud = await page.evaluate(() => {
  const h = window.__WORMS__.scene.getScene('Game').hud;
  return { desktop: h.desktop, touchButtons: Boolean(h.buttons), power: Boolean(h.powerBar) };
});
check('крупных тач-кнопок нет, есть шкала силы', hud.desktop && !hud.touchButtons && hud.power,
  JSON.stringify(hud));

// Подсказка открыта в начале боя. Клик по полю её закрывает — и только.
let s0 = await state();
check('подсказка показана в начале боя', s0.help);
const wp = await wormOnPage();
await page.mouse.move(wp.x + 300, wp.y - 200);
await page.mouse.down();
await page.waitForTimeout(400);
let s1 = await state();
await page.mouse.up();
await page.waitForTimeout(150);
let s2 = await state();
check('клик, закрывший подсказку, не копит силу и не стреляет',
  !s1.help && s1.charge === 0 && s2.state === 'aim', `заряд ${s1.charge.toFixed(2)}, ${s2.state}`);

// Прицел за курсором: влево-вверх и вправо-полого
await page.mouse.move(wp.x - 250, wp.y - 250);
await page.waitForTimeout(80);
const left = await state();
await page.mouse.move(wp.x + 400, wp.y - 120);
await page.waitForTimeout(80);
const right = await state();
check('боец разворачивается к курсору', left.facing === -1 && right.facing === 1,
  `${left.facing} → ${right.facing}`);
check('угол следует за курсором',
  Math.abs(left.angle - Math.PI / 4) < 0.05 && right.angle > 0.15 && right.angle < 0.45,
  `${Math.round(left.angle * 57.3)}° → ${Math.round(right.angle * 57.3)}°`);

// Оружие с клавиатуры
await page.keyboard.press('e');
const afterE = await state();
await page.keyboard.press('q');
const afterQ = await state();
await page.keyboard.press('2');
const after2 = await state();
await page.keyboard.press('1');
check('Q/E и цифры меняют оружие',
  afterE.weapon !== 0 && afterQ.weapon === 0 && after2.weapon === 1,
  `${afterE.weapon}, ${afterQ.weapon}, ${after2.weapon}`);
await page.keyboard.press('Tab');
const tabOpen = (await state()).arsenal;
await page.keyboard.press('Tab');
check('Tab открывает и закрывает арсенал', tabOpen && !(await state()).arsenal);

// Правая кнопка тянет карту
await page.mouse.move(800, 400);
const v0 = (await state()).view;
await page.mouse.down({ button: 'right' });
await page.mouse.move(400, 400, { steps: 6 });
await page.mouse.up({ button: 'right' });
const v1 = (await state()).view;
check('правая кнопка тянет карту', Math.abs(v1 - v0) > 100, `${Math.round(v0)} → ${Math.round(v1)}`);
await page.keyboard.press('f');

// Удержание левой кнопки копит силу, отпускание стреляет
const wp2 = await wormOnPage();
await page.mouse.move(wp2.x + 350, wp2.y - 250);
await page.mouse.down();
await page.waitForFunction(() => window.__WORMS__.scene.getScene('Game').charge > 0.25, null, { timeout: 5000 })
  .catch(() => {});
const charging = await state();
await page.mouse.up();
await page.waitForTimeout(120);
const fired = await state();
check('ЛКМ держать — сила копится', charging.charge > 0.2, charging.charge.toFixed(2));
check('ЛКМ отпустить — выстрел', fired.state !== 'aim' && fired.charge === 0, fired.state);

check('нет ошибок и предупреждений в консоли', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nпроверки интерфейса для ПК пройдены');
