import { CFG } from '../config.js';

/**
 * Просчёт полёта снаряда без самого снаряда.
 *
 * Бот не «знает» правильный ответ и не читает его из формулы: он гоняет тот
 * же интегратор, что и настоящий снаряд, по той же маске земли. Формулы
 * баллистики тут не хватило бы — остров дырявый, между стволом и целью
 * бывает холм, и попадание решает именно рельеф.
 *
 * Считается только прямой полёт: отскоки гранаты и бурение крота не
 * моделируются, поэтому бот и стреляет ими лишь тогда, когда прямая
 * траектория и так упирается в цель.
 */

const DT = 1 / 60;
const SUBSTEPS = 2;              // вдвое меньше, чем в игре: точности хватает
const MAX_TIME = 8;              // дольше снаряд всё равно не живёт

/**
 * @returns {{kind:'terrain'|'worm'|'water'|'out', x:number, y:number,
 *            worm:object|null, time:number}}
 */
export function simulateShot(scene, x0, y0, vx, vy, weapon, ignoreWorm = null) {
  const terrain = scene.terrain;
  const p = weapon.projectile;
  const wind = scene.wind;
  const W = terrain.width, H = terrain.height, solid = terrain.solid;
  const gravity = CFG.GRAVITY * (p.gravityScale ?? 1);
  const push = wind * (p.windScale ?? 1);
  const drag = p.drag > 0 ? p.drag : 0;

  // Бойцы за время полёта не двигаются: их прямоугольники считаем один
  // раз (как Worm.containsPoint), а не через геттеры на каждом подшаге
  const boxes = [];
  for (const w of scene.worms) {
    if (!w.alive || w === ignoreWorm) continue;
    boxes.push(w, w.left, w.right, w.top, w.y);
  }

  let x = x0, y = y0;
  const sub = DT / SUBSTEPS;
  const dragK = drag ? Math.exp(-drag * sub) : 1;

  for (let t = 0; t < MAX_TIME; t += DT) {
    for (let s = 0; s < SUBSTEPS; s++) {
      vx += push * sub;
      vy += gravity * sub;
      if (drag) { vx *= dragK; vy *= dragK; }

      const nx = x + vx * sub;
      const ny = y + vy * sub;

      if (nx < -80 || nx > W + 80 || ny > H + 120) {
        const kind = ny > CFG.WATER_Y && nx > 0 && nx < W ? 'water' : 'out';
        return { kind, x: nx, y: ny, worm: null, time: t };
      }

      for (let i = 0; i < boxes.length; i += 5) {
        if (nx >= boxes[i + 1] && nx <= boxes[i + 2] && ny >= boxes[i + 3] && ny <= boxes[i + 4]) {
          return { kind: 'worm', x: nx, y: ny, worm: boxes[i], time: t };
        }
      }

      // Та же попиксельная трассировка, что Terrain.raycast, только без
      // объекта на каждый подшаг: их выходили миллионы за одно решение
      const dx = nx - x, dy = ny - y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
      const sx = dx / steps, sy = dy / steps;
      for (let i = 1; i <= steps; i++) {
        const rx = x + sx * i, ry = y + sy * i;
        const ix = rx | 0, iy = ry | 0;
        if (ix >= 0 && ix < W && iy >= 0 && iy < H && solid[iy * W + ix] === 1) {
          return { kind: ry >= CFG.WATER_Y ? 'water' : 'terrain', x: rx, y: ry, worm: null, time: t };
        }
      }
      x = nx; y = ny;
    }
  }
  return { kind: 'out', x, y, worm: null, time: MAX_TIME };
}

/**
 * Точка вылета: та же, что у настоящего выстрела, — иначе бот считал бы
 * траекторию из точки, в которой снаряда никогда не будет.
 */
export function muzzle(scene, worm, dx, dy) {
  const ray = scene.terrain.raycast(
    worm.x, worm.centerY,
    worm.x + dx * CFG.MUZZLE_OFFSET, worm.centerY + dy * CFG.MUZZLE_OFFSET,
  );
  return ray.hit ? { x: ray.freeX, y: ray.freeY } : { x: ray.x, y: ray.y };
}
