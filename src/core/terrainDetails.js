/**
 * Живые детали в теле земли — у каждого места свои: камешки у подножия,
 * блики во льду, светящиеся трещины в жерле, кристаллы в астероидах,
 * пласты песка на ветреной башне.
 *
 * Только картинка: физика по маске не меняется, основной ГПСЧ не трогается
 * (свой поток от сида), поэтому онлайн-сверка земли не расходится.
 */
import { makeRng } from './rng.js';

/** Сколько деталей на 10 000 px² тела и как далеко от края держаться. */
const LOOKS = {
  classic: { density: 0.9, margin: 12, draw: pebble },
  wind: { density: 0.55, margin: 14, draw: strata },
  ice: { density: 0.7, margin: 14, draw: glint },
  lava: { density: 0.6, margin: 16, draw: crack },
  space: { density: 0.55, margin: 14, draw: crystal },
};

/**
 * Разложить детали: точки внутри земли, не ближе margin к краю.
 * @returns {{draw: Function, items: Array}}
 */
export function planDetails(terrain, look, seed) {
  const spec = LOOKS[look];
  if (!spec) return null;
  const { width: w, height: h, solid } = terrain;
  const rng = makeRng(((seed >>> 0) ^ 0x5eed7e11) >>> 0);
  const m = spec.margin;
  const inside = (x, y) => x >= m && y >= m && x < w - m && y < h - m
    && solid[y * w + x] && solid[(y - m) * w + x] && solid[(y + m) * w + x]
    && solid[y * w + x - m] && solid[y * w + x + m];
  // Площадь тела — по разреженной сетке, чтобы не считать все пиксели
  let area = 0;
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) area += solid[y * w + x];
  area *= 64;
  const want = Math.round((area / 10000) * spec.density);
  const items = [];
  for (let tries = 0; items.length < want && tries < want * 12; tries++) {
    const x = Math.floor(rng() * w), y = Math.floor(rng() * h);
    if (!inside(x, y)) continue;
    items.push({ x, y, r: rng(), s: rng(), t: rng() });
  }
  return { draw: spec.draw, items };
}

/** Нарисовать детали, задевающие чанк (мировые координаты уже выставлены). */
export function paintDetails(ctx, plan, x0, x1) {
  if (!plan) return;
  ctx.save();
  // Только поверх уже нарисованной земли
  ctx.globalCompositeOperation = 'source-atop';
  for (const it of plan.items) {
    if (it.x < x0 - 40 || it.x > x1 + 40) continue;
    plan.draw(ctx, it);
  }
  ctx.restore();
}

// --------------------------------------------------------------- рисунки

/** Подножие: округлые камешки с бликом и тенью. */
function pebble(ctx, { x, y, r, s, t }) {
  const rx = 3 + r * 5, ry = rx * (0.6 + s * 0.25);
  const rot = (t - 0.5) * 0.8;
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#1c130b';
  ctx.beginPath(); ctx.ellipse(x + 1, y + 2, rx, ry, rot, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = s < 0.5 ? '#8a7c6c' : '#7a6a58';
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = '#e8dccb';
  ctx.beginPath(); ctx.ellipse(x - rx * 0.3, y - ry * 0.35, rx * 0.4, ry * 0.3, rot, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

/** Ветреная: светлые волнистые пласты песка. */
function strata(ctx, { x, y, r, s }) {
  const len = 40 + r * 70;
  ctx.globalAlpha = 0.22 + s * 0.12;
  ctx.strokeStyle = s < 0.5 ? '#fff2cc' : '#5a3a1a';
  ctx.lineWidth = 2 + r * 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    const px = x - len / 2 + (len * i) / 8;
    const py = y + Math.sin(i * 0.9 + s * 6) * 3;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Ледник: косые блики и пузырьки воздуха во льду. */
function glint(ctx, { x, y, r, s, t }) {
  if (t < 0.6) {
    const len = 14 + r * 22;
    ctx.globalAlpha = 0.35 + s * 0.2;
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x - len / 2, y + len / 2); ctx.lineTo(x + len / 2, y - len / 2); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - len / 2 + 7, y + len / 2); ctx.lineTo(x + len / 2 - 2, y - len / 2 + 9); ctx.stroke();
  } else {
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = '#eaf6ff';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const bx = x + (i - 1) * 7 + r * 4, by = y + Math.sin(i * 2 + s * 6) * 6, br = 2 + ((r * 7 + i) % 3);
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** Жерло: светящаяся трещина — ломаная с ответвлением. */
function crack(ctx, { x, y, r, s, t }) {
  const pts = [[x, y]];
  let a = t * Math.PI * 2, px = x, py = y;
  const n = 4 + Math.floor(r * 4);
  for (let i = 0; i < n; i++) {
    a += (((s * 97 + i * 31) % 10) / 10 - 0.5) * 1.4;
    px += Math.cos(a) * (8 + r * 6); py += Math.sin(a) * (8 + r * 6);
    pts.push([px, py]);
  }
  const path = (from = 0) => {
    ctx.beginPath(); ctx.moveTo(pts[from][0], pts[from][1]);
    for (let i = from + 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.35; ctx.strokeStyle = '#ff6a1a'; ctx.lineWidth = 9; path(); ctx.stroke();
  ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffb02e'; ctx.lineWidth = 3.5; path(); ctx.stroke();
  ctx.globalAlpha = 0.9; ctx.strokeStyle = '#fff1a8'; ctx.lineWidth = 1.2; path(); ctx.stroke();
  // Ответвление от середины
  const mid = pts[Math.floor(pts.length / 2)];
  const b = a + (s < 0.5 ? 1.2 : -1.2);
  ctx.globalAlpha = 0.8; ctx.strokeStyle = '#ffb02e'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(mid[0], mid[1]);
  ctx.lineTo(mid[0] + Math.cos(b) * 12, mid[1] + Math.sin(b) * 12); ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Космос: гроздь кристаллов с прожилкой. */
function crystal(ctx, { x, y, r, s, t }) {
  const hue = s < 0.5 ? ['#5ad8ff', '#c8f4ff', '#1a6a9a'] : ['#c07aff', '#f0d8ff', '#5a2a8a'];
  // Прожилка
  ctx.globalAlpha = 0.45; ctx.strokeStyle = hue[0]; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, y);
  ctx.quadraticCurveTo(x + (t - 0.5) * 40, y + 14, x + (r - 0.5) * 60, y + 26); ctx.stroke();
  const n = 2 + Math.floor(r * 3);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.5 + (t - 0.5) * 0.6;
    const len = 9 + ((r * 13 + i * 5) % 8), wd = 3.2;
    const cx = Math.cos(a), cy = Math.sin(a), nx = -cy, ny = cx;
    const tip = [x + cx * len, y + cy * len];
    ctx.globalAlpha = 0.95; ctx.fillStyle = hue[2];
    ctx.beginPath(); ctx.moveTo(x + nx * wd, y + ny * wd); ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(x - nx * wd, y - ny * wd); ctx.closePath(); ctx.fill();
    ctx.fillStyle = hue[0];
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tip[0], tip[1]);
    ctx.lineTo(x - nx * wd, y - ny * wd); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.8; ctx.strokeStyle = hue[1]; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + cx * 2, y + cy * 2); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
