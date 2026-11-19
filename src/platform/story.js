/**
 * Сторис из боя: карточка победы с кадром лучшего момента и ссылкой на игру.
 *
 * Telegram (Bot API 7.8+) публикует сторис только по HTTPS-ссылке на
 * картинку, поэтому карточка рисуется на холсте, уходит на сервер
 * (/api/media) и уже оттуда — в shareToStory. Ссылка-виджет на сторис
 * ведёт по рефералке: пришедший и позвавший получают по коробке.
 */
import { tgApi, tgSupports, refLink, haptic } from './telegram.js';
import { uploadMedia, loggedIn, trackStep } from '../net/server.js';
import { UI } from '../ui/theme.js';
import { tr } from '../i18n/index.js';

export const STORY_W = 1080;
export const STORY_H = 1920;

/** Можно ли выложить сторис прямо отсюда. */
export function canStory() {
  const tg = tgApi();
  return Boolean(tg && typeof tg.shareToStory === 'function' && tgSupports('7.8') && loggedIn());
}

/** Кадр игрового холста: следующий отрисованный кадр как <img>. */
export function snapshot(scene) {
  return new Promise((resolve) => {
    try {
      scene.game.renderer.snapshot((img) => resolve(img instanceof HTMLImageElement ? img : null), 'image/jpeg', 0.9);
    } catch {
      resolve(null);
    }
  });
}

/** Кадр листа бойца на отдельном холсте — чтобы нарисовать его на карточке. */
export function fighterFrame(scene, sheet, frame = 13) {
  try {
    const f = scene.textures.getFrame(sheet, frame);
    if (!f) return null;
    const c = document.createElement('canvas');
    c.width = f.cutWidth; c.height = f.cutHeight;
    c.getContext('2d').drawImage(f.source.image, f.cutX, f.cutY, f.cutWidth, f.cutHeight, 0, 0, f.cutWidth, f.cutHeight);
    return c;
  } catch {
    return null;
  }
}

/**
 * Надпись на карточке. Золотой заголовок — градиент с тонкой тёплой
 * обводкой; остальное — без обводки, только мягкая тень: толстый чёрный
 * контур на большой картинке смотрится грубо.
 */
function strokeText(g, text, x, y, size, color, stroke = null, weight = 900) {
  text = tr(text);
  g.font = `${weight} ${size}px ${UI.fontFamily}`;
  g.lineJoin = 'round';
  g.save();
  g.shadowColor = 'rgba(10,6,30,0.55)'; g.shadowBlur = size / 5; g.shadowOffsetY = size / 14;
  if (color === '#ffd166') {
    g.lineWidth = Math.max(3, size / 10); g.strokeStyle = '#5a2a08'; g.strokeText(text, x, y);
    g.shadowColor = 'transparent';
    const gr = g.createLinearGradient(0, y - size * 0.5, 0, y + size * 0.45);
    gr.addColorStop(0, '#fff6c2'); gr.addColorStop(0.45, '#ffd04a'); gr.addColorStop(1, '#f39a1e');
    g.fillStyle = gr;
  } else {
    g.fillStyle = color;
  }
  g.fillText(text, x, y);
  g.restore();
}

/**
 * Нарисовать карточку. @returns {HTMLCanvasElement}
 * @param {object} o
 * @param {HTMLImageElement|null} o.shot  кадр боя (фоном, «обложкой»)
 * @param {HTMLCanvasElement|null} o.fighter  свой боец в позе победы
 * @param {string} o.title  «ПОБЕДА!»
 * @param {string[]} o.lines  строки под заголовком
 * @param {string} o.cta  призыв внизу
 * @param {string} o.handle  @бот
 */
export function drawStory({ shot = null, fighter = null, title, lines = [], cta, handle = '' }) {
  const c = document.createElement('canvas');
  c.width = STORY_W; c.height = STORY_H;
  const g = c.getContext('2d');

  // Фон: кадр боя «обложкой», иначе ночное небо
  const sky = g.createLinearGradient(0, 0, 0, STORY_H);
  sky.addColorStop(0, '#2a1f5c'); sky.addColorStop(1, '#0d1326');
  g.fillStyle = sky; g.fillRect(0, 0, STORY_W, STORY_H);
  if (shot?.width) {
    const k = Math.max(STORY_W / shot.width, STORY_H / shot.height);
    const w = shot.width * k, h = shot.height * k;
    g.drawImage(shot, (STORY_W - w) / 2, (STORY_H - h) / 2, w, h);
  }
  // Затемнение сверху и снизу — под надписи
  const top = g.createLinearGradient(0, 0, 0, 520);
  top.addColorStop(0, 'rgba(8,10,20,0.85)'); top.addColorStop(1, 'rgba(8,10,20,0)');
  g.fillStyle = top; g.fillRect(0, 0, STORY_W, 520);
  const bot = g.createLinearGradient(0, STORY_H - 900, 0, STORY_H);
  bot.addColorStop(0, 'rgba(8,10,20,0)'); bot.addColorStop(0.45, 'rgba(8,10,20,0.78)'); bot.addColorStop(1, 'rgba(8,10,20,0.95)');
  g.fillStyle = bot; g.fillRect(0, STORY_H - 900, STORY_W, 900);

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  strokeText(g, 'SMILES', STORY_W / 2, 170, 120, '#ffd166');
  strokeText(g, 'артиллерия смайликов в Telegram', STORY_W / 2, 270, 40, '#e8ecf5', '#141821', 800);

  // Боец — крупно, в позе победы, с лучами за спиной
  if (fighter) {
    const fy = STORY_H - 760;
    const rays = g.createRadialGradient(STORY_W / 2, fy, 30, STORY_W / 2, fy, 420);
    rays.addColorStop(0, 'rgba(255,209,102,0.55)'); rays.addColorStop(1, 'rgba(255,209,102,0)');
    g.fillStyle = rays; g.beginPath(); g.arc(STORY_W / 2, fy, 420, 0, Math.PI * 2); g.fill();
    const size = 520;
    const k = size / Math.max(fighter.width, fighter.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(fighter, STORY_W / 2 - (fighter.width * k) / 2, fy - (fighter.height * k) / 2, fighter.width * k, fighter.height * k);
  }

  strokeText(g, title, STORY_W / 2, STORY_H - 420, 150, '#ffd166');
  lines.slice(0, 2).forEach((t, i) => strokeText(g, t, STORY_W / 2, STORY_H - 300 + i * 66, 50, '#ffffff', '#141821', 800));

  // Призыв: плашка-кнопка
  const bw = 820, bh = 120, bx = (STORY_W - bw) / 2, by = STORY_H - 200;
  const bgr = g.createLinearGradient(0, by, 0, by + bh);
  bgr.addColorStop(0, '#ff6a55'); bgr.addColorStop(1, '#d4322a');
  g.save(); g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
  g.fillStyle = bgr; g.beginPath(); g.roundRect(bx, by, bw, bh, 36); g.fill(); g.restore();
  g.lineWidth = 4; g.strokeStyle = 'rgba(90,15,10,0.9)'; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.roundRect(bx + 10, by + 6, bw - 20, bh * 0.38, 30); g.fill();
  strokeText(g, cta, STORY_W / 2, by + bh / 2, 52, '#ffffff', '#7a1712', 900);
  if (handle) strokeText(g, handle, STORY_W / 2, STORY_H - 45, 40, '#c9d1e3', '#141821', 800);
  return c;
}

function toBlob(canvas, type = 'image/jpeg', q = 0.86) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, q));
}

/**
 * Выложить карточку в сторис. @returns {Promise<'ok'|'upload'|'unsupported'>}
 */
export async function shareStory(canvas, { text = '', button = 'Играть' } = {}) {
  if (!canStory()) return 'unsupported';
  const blob = await toBlob(canvas);
  const up = await uploadMedia(blob);
  if (!up) return 'upload';
  return postStory(up.url, { text, button });
}

/** Отдать Telegram готовую ссылку на картинку или MP4. */
export function postStory(url, { text = '', button = 'Играть' } = {}) {
  const tg = tgApi();
  if (!canStory()) return 'unsupported';
  const link = refLink();
  const opts = { text: tr(text).slice(0, 200) };
  // Ссылка-виджет на сторис есть только у Premium; без Premium Telegram её молча опустит
  if (link) opts.widget_link = { url: link, name: tr(button).slice(0, 48) };
  try {
    tg.shareToStory(url, opts);
    haptic('win');
    trackStep('story');
    return 'ok';
  } catch {
    return 'unsupported';
  }
}
