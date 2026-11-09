/**
 * Аккаунт в браузере: регистрация, вход, выход — через настоящее окно и
 * настоящий сервер (tests/run.mjs поднимает server/index.mjs с пустой
 * базой).
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  // 401 на неверный пароль — штатный ответ, браузер всё равно пишет его в консоль
  if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`console: ${t}`);
});

const nick = `Тест ${Math.random().toString(36).slice(2, 7)}`;
const menu = () => page.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Menu') && window.__WORMS__.scene.getScene('Menu').buttons.account,
  null, { timeout: 30000 });
const accountLabel = () => page.evaluate(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  const b = m.buttons.account;
  return m.items.filter((o) => o.type === 'Text' && Math.abs(o.x - b.x) < 2 && Math.abs(o.y - (b.y - m.oy)) < 30)
    .map((o) => o.text).join(' | ');
});
async function clickMenu(key) {
  const p = await page.evaluate((k) => {
    const g = window.__WORMS__;
    const b = g.scene.getScene('Menu').buttons[k];
    const r = g.canvas.getBoundingClientRect();
    const s = r.width / g.scale.width;
    const f = window.__WORMS_FRAME__ ?? { left: 0, top: 0 };
    return { x: r.left + (b.x + f.left) * s, y: r.top + (b.y + f.top) * s };
  }, key);
  await page.mouse.click(p.x, p.y);
}

await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded' });
await menu();
check('без входа в меню кнопка «Аккаунт»', (await accountLabel()).startsWith('Аккаунт'), await accountLabel());

await clickMenu('account');
await page.waitForSelector('.acc-box #acc-name');
check('окно входа открылось: ник и пароль, ничего больше',
  await page.evaluate(() => document.querySelectorAll('.acc-box input').length === 2));

// Пробел в нике печатается: клавиатура игры не перехватывает его, пока окно открыто
await page.fill('#acc-pass', '12');
await page.click('#acc-name');
await page.keyboard.type(nick);
await page.click('text=Создать аккаунт');
await page.waitForFunction(() => document.querySelector('.acc-err')?.textContent, null, { timeout: 5000 });
check('короткий пароль — понятная ошибка', /пароль короче/.test(await page.textContent('.acc-err')),
  await page.textContent('.acc-err'));
check('ник с пробелом напечатан целиком', (await page.inputValue('#acc-name')) === nick, await page.inputValue('#acc-name'));

await page.fill('#acc-pass', 'secret1');
await page.click('text=Создать аккаунт');
await page.waitForSelector('.acc-box .acc-name', { timeout: 5000 });
check('после регистрации — профиль', (await page.textContent('.acc-name')).includes(nick));
const stored = await page.evaluate(() => ({
  token: JSON.parse(localStorage.getItem('worms.account.v1') ?? 'null')?.token,
  p: JSON.parse(localStorage.getItem('worms.player.v1')),
}));
check('токен сохранён, профиль — с сервера', Boolean(stored.token) && stored.p.id.startsWith('u')
  && stored.p.name === nick && stored.p.rating === 1000, `${stored.p.id} ${stored.p.name}`);

await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.acc-shade'));
check('Esc закрывает окно, в меню ник', (await accountLabel()).includes(nick), await accountLabel());

await page.reload({ waitUntil: 'domcontentloaded' });
await menu();
check('после перезагрузки вход сохранился', (await accountLabel()).includes(nick), await accountLabel());

// Выход и вход
await clickMenu('account');
await page.click('text=Выйти');
await page.waitForSelector('.acc-box #acc-name');
const anon = await page.evaluate(() => ({
  ...JSON.parse(localStorage.getItem('worms.player.v1')),
  token: localStorage.getItem('worms.account.v1'),
}));
check('после выхода — аноним', !anon.account && !anon.id.startsWith('u') && !anon.token,
  `${anon.id} ${anon.name}`);

await page.fill('#acc-name', nick.toUpperCase());
await page.fill('#acc-pass', 'wrong');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.acc-err')?.textContent, null, { timeout: 5000 });
check('неверный пароль — подсказка про регистрацию', /неверный ник или пароль.*Создать/.test(await page.textContent('.acc-err')),
  await page.textContent('.acc-err'));
await page.fill('#acc-pass', 'secret1');
await page.keyboard.press('Enter');
await page.waitForSelector('.acc-box .acc-name', { timeout: 5000 });
check('вход по нику в другом регистре и Enter', (await page.textContent('.acc-name')).includes(nick));

// Таблица лидеров из профиля
await page.click('text=Таблица лидеров');
const top = await page.waitForFunction(() => {
  const m = window.__WORMS__.scene.getScene('Menu');
  return m.section === m.showTop && m.topRows !== undefined;
}, null, { timeout: 5000 }).then(() => true).catch(() => false);
check('таблица лидеров открывается и грузится с сервера', top && !(await page.$('.acc-shade')));

check('нет ошибок в консоли', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
if (failures.length) {
  console.log(`\nПРОВАЛЕНО: ${failures.length} — ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nпроверки аккаунта пройдены');
