/**
 * Оформление интерфейса: палитра, кнопки и иконки.
 *
 * Всё рисуется в canvas-текстуры один раз и дальше используется как обычные
 * картинки. Через Phaser.Graphics так не сделать: нужны градиенты, скругления
 * и тени, а Graphics их не умеет.
 *
 * Стиль — под оригинал: тёплая тёмная плашка с фаской, светлая кромка сверху,
 * тень снизу, янтарный акцент. Юникодные значки заменены на рисованные
 * иконки одной толщины: системный шрифт давал разный вес и размер.
 */

export const UI = {
  panelTop: '#4b5265',
  panelBottom: '#252a35',
  panelBorder: '#0d1015',
  highlight: 'rgba(255,255,255,0.22)',
  shadow: 'rgba(0,0,0,0.45)',

  primaryTop: '#d8544e',
  primaryBottom: '#7d2020',
  primaryBorder: '#2a0d0d',

  activeTop: '#f0b04a',
  activeBottom: '#9a6410',

  text: '#f4ece0',
  textDim: '#a9b0c0',
  accent: '#ffc247',
  bar: '#161a22',

  radius: 12,
  fontFamily: '"Worms UI", "Trebuchet MS", system-ui, sans-serif',
};

/** Шрифт интерфейса: размер + начертание, остальное одинаково. */
export function font(size, weight = 800, color = UI.text) {
  return {
    fontFamily: UI.fontFamily,
    fontSize: `${size}px`,
    fontStyle: `${weight}`,
    color,
    stroke: '#141821',
    strokeThickness: Math.max(2, Math.round(size / 7)),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Текстура кнопки: скруглённая плашка с вертикальным градиентом, тёмной
 * обводкой, светлой кромкой сверху и падающей тенью.
 */
export function ensureButton(scene, key, w, h, variant = 'normal') {
  if (scene.textures.exists(key)) return key;

  const pad = 6;
  const tex = scene.textures.createCanvas(key, w + pad * 2, h + pad * 2);
  const ctx = tex.getContext();
  const x = pad, y = pad;

  const tops = { normal: UI.panelTop, primary: UI.primaryTop, active: UI.activeTop };
  const bottoms = { normal: UI.panelBottom, primary: UI.primaryBottom, active: UI.activeBottom };
  const borders = { normal: UI.panelBorder, primary: UI.primaryBorder, active: UI.panelBorder };

  // Тень
  ctx.save();
  ctx.shadowColor = UI.shadow;
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = borders[variant] ?? UI.panelBorder;
  roundRect(ctx, x, y, w, h, UI.radius);
  ctx.fill();
  ctx.restore();

  // Тело
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, tops[variant] ?? UI.panelTop);
  g.addColorStop(1, bottoms[variant] ?? UI.panelBottom);
  ctx.fillStyle = g;
  roundRect(ctx, x + 2, y + 2, w - 4, h - 4, UI.radius - 2);
  ctx.fill();

  // Светлая кромка сверху — она и даёт ощущение объёма
  ctx.strokeStyle = UI.highlight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + UI.radius, y + 3);
  ctx.lineTo(x + w - UI.radius, y + 3);
  ctx.stroke();

  tex.refresh();
  return key;
}

/** Круглая кнопка — под «Огонь». */
export function ensureRoundButton(scene, key, r, variant = 'primary') {
  if (scene.textures.exists(key)) return key;

  const pad = 8;
  const size = r * 2 + pad * 2;
  const tex = scene.textures.createCanvas(key, size, size);
  const ctx = tex.getContext();
  const c = size / 2;

  ctx.save();
  ctx.shadowColor = UI.shadow;
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = variant === 'primary' ? UI.primaryBorder : UI.panelBorder;
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const g = ctx.createLinearGradient(0, c - r, 0, c + r);
  g.addColorStop(0, variant === 'primary' ? UI.primaryTop : UI.panelTop);
  g.addColorStop(1, variant === 'primary' ? UI.primaryBottom : UI.panelBottom);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, r - 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = UI.highlight;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, r - 5, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();

  tex.refresh();
  return key;
}

/** Иконки одной толщины: юникодные значки давали разный вес и размер. */
const ICONS = {
  left: (ctx, s) => tri(ctx, s, Math.PI),
  right: (ctx, s) => tri(ctx, s, 0),
  up: (ctx, s) => chevron(ctx, s, 1),
  down: (ctx, s) => chevron(ctx, s, -1),
  jump: (ctx, s) => {
    stroke(ctx, s);
    const c = s / 2;
    ctx.beginPath();
    ctx.moveTo(c, s * 0.72); ctx.lineTo(c, s * 0.26);
    ctx.moveTo(c - s * 0.17, s * 0.43); ctx.lineTo(c, s * 0.26);
    ctx.lineTo(c + s * 0.17, s * 0.43);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - s * 0.22, s * 0.82); ctx.lineTo(c + s * 0.22, s * 0.82);
    ctx.stroke();
  },
  focus: (ctx, s) => {
    stroke(ctx, s);
    const c = s / 2, r = s * 0.22;
    ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c, c - r - s * 0.14); ctx.lineTo(c, c - r + s * 0.02);
    ctx.moveTo(c, c + r - s * 0.02); ctx.lineTo(c, c + r + s * 0.14);
    ctx.moveTo(c - r - s * 0.14, c); ctx.lineTo(c - r + s * 0.02, c);
    ctx.moveTo(c + r - s * 0.02, c); ctx.lineTo(c + r + s * 0.14, c);
    ctx.stroke();
  },
  overview: (ctx, s) => corners(ctx, s, true),
  fullscreen: (ctx, s) => corners(ctx, s, false),
  // Домик: выход в меню
  home: (ctx, s) => {
    stroke(ctx, s);
    const c = s / 2, w = s * 0.26, h = s * 0.2;
    ctx.beginPath();
    ctx.moveTo(c - w - s * 0.05, c - h * 0.1);
    ctx.lineTo(c, c - h - s * 0.14);
    ctx.lineTo(c + w + s * 0.05, c - h * 0.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - w, c - h * 0.05);
    ctx.lineTo(c - w, c + h + s * 0.06);
    ctx.lineTo(c + w, c + h + s * 0.06);
    ctx.lineTo(c + w, c - h * 0.05);
    ctx.stroke();
  },

  // Два звена цепи: приглашение по ссылке
  link: (ctx, s) => {
    stroke(ctx, s);
    const c = s / 2, r = s * 0.15, d = s * 0.17;
    for (const k of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(c + d * k, c - d * k, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(c - d * 0.55, c + d * 0.55);
    ctx.lineTo(c + d * 0.55, c - d * 0.55);
    ctx.stroke();
  },
  // Динамик с волнами — звук включён; с крестом — выключен
  sound: (ctx, s) => speaker(ctx, s, false),
  mute: (ctx, s) => speaker(ctx, s, true),
  help: (ctx, s) => {
    stroke(ctx, s);
    ctx.lineCap = 'round';
    const c = s / 2;
    ctx.beginPath();
    ctx.arc(c, c - s * 0.09, s * 0.16, Math.PI * 0.9, Math.PI * 2.25);
    ctx.lineTo(c, c + s * 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c + s * 0.32, s * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = UI.text;
    ctx.fill();
  },
};

function speaker(ctx, s, muted) {
  stroke(ctx, s);
  const c = s / 2;
  ctx.fillStyle = UI.text;
  ctx.beginPath();
  ctx.moveTo(s * 0.2, c - s * 0.09);
  ctx.lineTo(s * 0.32, c - s * 0.09);
  ctx.lineTo(s * 0.47, c - s * 0.23);
  ctx.lineTo(s * 0.47, c + s * 0.23);
  ctx.lineTo(s * 0.32, c + s * 0.09);
  ctx.lineTo(s * 0.2, c + s * 0.09);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  if (muted) {
    ctx.moveTo(s * 0.58, c - s * 0.12); ctx.lineTo(s * 0.8, c + s * 0.12);
    ctx.moveTo(s * 0.8, c - s * 0.12); ctx.lineTo(s * 0.58, c + s * 0.12);
  } else {
    ctx.arc(s * 0.5, c, s * 0.14, -Math.PI / 4, Math.PI / 4);
    ctx.moveTo(s * 0.5 + Math.cos(-Math.PI / 4) * s * 0.27, c + Math.sin(-Math.PI / 4) * s * 0.27);
    ctx.arc(s * 0.5, c, s * 0.27, -Math.PI / 4, Math.PI / 4);
  }
  ctx.stroke();
}

function stroke(ctx, s) {
  ctx.strokeStyle = UI.text;
  ctx.lineWidth = Math.max(2, s * 0.09);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function tri(ctx, s, rot) {
  const c = s / 2, r = s * 0.28;
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(rot);
  ctx.fillStyle = UI.text;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(-r * 0.75, -r * 0.95);
  ctx.lineTo(-r * 0.75, r * 0.95);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** dir = 1 — «крышей» вверх, dir = -1 — вниз. */
function chevron(ctx, s, dir) {
  stroke(ctx, s);
  const c = s / 2, w = s * 0.26, h = s * 0.15;
  ctx.beginPath();
  ctx.moveTo(c - w, c + h * dir);
  ctx.lineTo(c, c - h * dir);
  ctx.lineTo(c + w, c + h * dir);
  ctx.stroke();
}

function corners(ctx, s, inward) {
  stroke(ctx, s);
  const a = s * 0.24, b = s * 0.76, k = s * 0.16;
  const seg = (x, y, dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * k, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * k);
    ctx.stroke();
  };
  if (inward) {
    seg(a, a, 1, 1); seg(b, a, -1, 1); seg(a, b, 1, -1); seg(b, b, -1, -1);
  } else {
    seg(a, a, 1, 1); seg(b, a, -1, 1); seg(a, b, 1, -1); seg(b, b, -1, -1);
    ctx.beginPath();
    ctx.moveTo(a + k, a + k); ctx.lineTo(b - k, b - k);
    ctx.moveTo(b - k, a + k); ctx.lineTo(a + k, b - k);
    ctx.stroke();
  }
}

export function ensureIcon(scene, name, size) {
  const key = `icon-${name}-${size}`;
  if (scene.textures.exists(key)) return key;
  const draw = ICONS[name];
  if (!draw) return null;
  const tex = scene.textures.createCanvas(key, size, size);
  const ctx = tex.getContext();
  draw(ctx, size);
  tex.refresh();
  return key;
}
