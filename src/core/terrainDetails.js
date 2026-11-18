/**
 * Живые детали в теле земли поверх текстуры. Камешки, трещины лавы,
 * кристаллы и пласты песка уже нарисованы на самих текстурах мест
 * (tools/build_location_art.py), кодом добавляем только блики во льду.
 *
 * Только картинка: физика по маске не меняется, основной ГПСЧ не трогается
 * (свой поток от сида), поэтому онлайн-сверка земли не расходится.
 */
import { makeRng } from './rng.js';

/** Сколько деталей на 10 000 px² тела и как далеко от края держаться. */
const LOOKS = {
  ice: { density: 0.7, margin: 14, draw: glint },
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

