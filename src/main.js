import { CFG, fitViewToScreen, canvasSize } from './config.js';
import BootScene from './scenes/BootScene.js';
import MenuScene from './scenes/MenuScene.js';
import GameScene from './scenes/GameScene.js';
import { initTelegram, startRoom, screenInsets, inTelegram, botLink } from './platform/telegram.js';
import { apiBase } from './net/server.js';
import { applyUiClass } from './platform/device.js';
import { loggedIn, telegramLogin, syncMe } from './net/server.js';
import { loadCloudProfile, player, dropAccount } from './platform/player.js';

initTelegram();
applyUiClass();

// Игра живёт в Telegram. На сервере env.js включает WORMS_TELEGRAM_ONLY, и
// в обычном браузере вместо игры — ссылка на бота. Локально и в тестах
// флага нет — игра открывается как есть.
if (globalThis.WORMS_TELEGRAM_ONLY && !inTelegram()) {
  await showTelegramGate();
  await new Promise(() => {});   // дальше не грузимся: игра здесь не запускается
}

async function showTelegramGate() {
  let link = botLink();
  if (!link) {
    try {
      const res = await fetch(new URL(`${apiBase()}/config`, document.baseURI));
      const cfg = await res.json();
      if (cfg?.bot) link = `https://t.me/${cfg.bot}`;
    } catch { /* ссылки не будет — останется текст */ }
  }
  const gate = document.getElementById('gate');
  if (!gate) return;
  gate.style.display = 'flex';
  const a = gate.querySelector('a');
  if (link) { a.href = link; a.textContent = `Открыть в Telegram`; } else a.remove();
}

// Логическая ширина подгоняется под пропорции экрана ДО создания игры:
// иначе на вытянутом телефоне 16:9 вписывается с чёрными полями по бокам
// (на замере — 29% ширины впустую). Высота остаётся 720, поэтому вся
// геометрия мира, физика и генерация ландшафта не меняются вовсе.
fitViewToScreen(window.innerWidth, window.innerHeight, screenInsets());

// Шрифт должен приехать ДО первого текста: Phaser меряет и кеширует
// метрики при создании, и текст, созданный на запасном шрифте, так и
// останется криво расположенным. Профиль из облака Telegram — тоже до
// старта: имя и рейтинг читаются синхронно, второго шанса подменить их нет.
await Promise.all([loadUiFont(), loadCloudProfile()]);

// Аккаунт. Профиль помнит, что вход был, а токена уже нет (вышли в другой
// вкладке, почистили хранилище) — значит, мы аноним. Иначе — освежаем
// рейтинг с сервера, а в Telegram входим сами по подписи клиента. Ничего
// из этого запуск не ждёт: сервер может и не ответить.
if (player().account && !loggedIn()) dropAccount();
if (loggedIn()) syncMe();
else telegramLogin();


async function loadUiFont() {
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load('800 32px "Worms UI"', 'Ход1'),
      document.fonts.load('700 32px "Worms UI"', 'Ход1'),
    ]);
  } catch (e) {
    console.warn('[ui] шрифт не загрузился, будет запасной', e);
  }
}

/**
 * Ни Arcade, ни Matter, ни Impact — блок `physics` в конфиге отсутствует
 * намеренно. Вся физика в src/entities и src/core написана вручную.
 */
// В одиночной игре пауза при уходе со вкладки — то, что нужно. В сетевой
// она вредна: соперник продолжает ходить, а у нас останавливается вообще
// всё, включая показ его выстрела и отправку собственного итога хода.
const online = Boolean(startRoom());

// Канвас на весь экран, включая безопасную область: мир и небо рисуются
// до краёв, интерфейс — внутри рамки CFG.FRAME (см. CameraRig).
const [canvasW, canvasH] = canvasSize();
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: canvasW,
  height: canvasH,
  backgroundColor: '#0b1021',
  disableVisibilityChange: online,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  input: {
    // Три, а не два: Phaser отдаёт под касания указатели с индекса 1 и
    // строго меньше activePointers, поэтому при 2 второй палец не
    // регистрируется вовсе и пинч не работает.
    activePointers: 3,
  },
  scene: [BootScene, MenuScene, GameScene],
});

window.__WORMS__ = game;
window.__WORMS_FRAME__ = CFG.FRAME;   // для диагностики экрана (index.html)

/**
 * Пересчёт размера при смене экрана.
 *
 * Логический размер считается из пропорций окна, а окно на телефоне живёт
 * своей жизнью: панель браузера то появляется, то уезжает, телефон
 * поворачивают. Посчитать один раз при запуске мало — стоит высоте
 * измениться, и Phaser.Scale.FIT начинает вписывать старые пропорции в
 * новые, оставляя чёрные поля по краям.
 *
 * Мелкие колебания игнорируем: пересборка интерфейса не бесплатная, а
 * пара пикселей на глаз всё равно не видна.
 */
let refitTimer = 0;
function refit() {
  const sizeBefore = canvasSize().join('x');
  const wBefore = CFG.VIEW_W;
  fitViewToScreen(window.innerWidth, window.innerHeight, screenInsets());
  const size = canvasSize();
  // Рамка меняется скачком (Telegram прислал отступы, повернули телефон):
  // её не игнорируем, мелкие колебания ширины — да
  if (Math.abs(CFG.VIEW_W - wBefore) < 24 && size.join('x') === sizeBefore) {
    // Логический размер тот же, но окно могло вырасти (Telegram ушёл в
    // полный экран): канвас всё равно вписываем заново
    game.scale.refresh();
    return;
  }
  // Именно setGameSize: resize() меняет размер, но не пересчитывает
  // пропорции, под которые вписывается канвас, — поля остаются на месте.
  // И размер — канваса, с рамкой: логический без рамки оставлял камеру
  // интерфейса торчать за край канваса, и HUD резался справа и снизу.
  game.scale.setGameSize(size[0], size[1]);
  window.__WORMS_FRAME__ = CFG.FRAME;
  game.events.emit('worms-resize', CFG.VIEW_W, CFG.VIEW_H);
}
function scheduleRefit(delay) {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refit, delay);
}
window.addEventListener('resize', () => scheduleRefit(200));
// Поворот телефона: размеры окна доезжают не сразу, поэтому ждём дольше
window.addEventListener('orientationchange', () => scheduleRefit(500));
// Telegram сообщил новые отступы безопасной области или новый размер окна
window.addEventListener('worms-safearea', () => scheduleRefit(50));
window.addEventListener('worms-viewport', () => scheduleRefit(150));

/**
 * Страховка: канвас должен занимать окно целиком. Если он заметно меньше
 * окна (браузер не прислал resize после полного экрана или поворота) —
 * переразложиться. Раз в секунду, это дёшево: два getBoundingClientRect.
 */
setInterval(() => {
  const r = game.canvas?.getBoundingClientRect();
  if (!r) return;
  const w = window.innerWidth, h = window.innerHeight;
  if (r.width < w * 0.9 && r.height < h * 0.9) refit();
}, 1000);
