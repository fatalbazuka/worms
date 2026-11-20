import { CFG } from '../config.js';
import { simulateShot, muzzle } from '../ai/ballistics.js';

/**
 * Готовый выстрел для обучения: перебор углов и силы той же баллистикой,
 * что у бота, — каким жестом попасть по мишени с этого места.
 *
 * Нужен шагу «Добей»: после промаха «палец» подсказки показывает не жест
 * вообще, а ровно тот, что попадёт. Слепые тестеры без этого бросали по
 * 16–25 раз подряд мимо и не понимали, куда тянуть.
 *
 * @returns {{dx:number, dy:number, frac:number}|null} направление выстрела
 *   и доля полной натяжки рогатки (0..1)
 */
export function solveShot(scene, worm, foe, weapon) {
  if (!worm || !foe || !weapon?.projectile) return null;
  const side = foe.x >= worm.x ? 1 : -1;
  let best = null;
  for (let deg = 14; deg <= 82; deg += 2) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a) * side, dy = -Math.sin(a);
    const m = muzzle(scene, worm, dx, dy);
    for (let pf = 0.2; pf <= 1.0001; pf += 0.025) {
      const v = pf * CFG.AIM_MAX_POWER;
      const r = simulateShot(scene, m.x, m.y, dx * v, dy * v, weapon, worm);
      const direct = r.kind === 'worm' && r.worm === foe;
      const miss = direct ? 0 : Math.hypot(r.x - foe.x, r.y - foe.centerY);
      // Свой взрыв рядом с собой — не выстрел, а подрыв
      if (Math.hypot(r.x - worm.x, r.y - worm.centerY) < 90) continue;
      // При равном промахе — выстрел попроще: средний угол, сила поменьше
      const score = miss + Math.abs(deg - 45) * 0.15 + pf * 4;
      if (!best || score < best.score) best = { dx, dy, pf, miss, score };
    }
  }
  if (!best || best.miss > 40) return null;
  // Сила → длина натяжки: обратное к формуле рогатки в AimController
  const len = CFG.SLING_MIN + best.pf * (CFG.SLING_MAX - CFG.SLING_MIN);
  return { dx: best.dx, dy: best.dy, frac: Math.min(1, len / CFG.SLING_MAX), pf: best.pf };
}

/**
 * Поставить мишень туда, куда с места игрока есть простой прямой выстрел.
 *
 * На башне мишень по зерну нередко оказывается этажом ниже под козырьком:
 * с места старта по ней не попасть вообще, и «Добей» превращался в десятки
 * бросков наугад. Ищем опору по сторонам от игрока на его высоте или чуть
 * ниже/выше и берём первую, где выстрел средней силы достаёт мишень.
 *
 * @returns {boolean} переставили ли
 */
export function placeTarget(scene, worm, foe, weapon) {
  if (!worm || !foe) return false;
  const easy = (sol) => sol && sol.pf >= 0.3 && sol.pf <= 0.75;
  if (easy(solveShot(scene, worm, foe, weapon))) return false;
  const ox = foe.x, oy = foe.y;
  const T = scene.terrain;
  for (const d of [260, 220, 300, 180, 340, 380]) {
    for (const side of [1, -1]) {
      const x = Math.round(worm.x + side * d);
      if (x < 40 || x > T.width - 40) continue;
      for (const from of [worm.y - 120, worm.y - 30, worm.y + 60]) {
        const top = T.surfaceYAt(x, Math.max(0, from));
        if (top === null || top >= CFG.WATER_Y - 20 || Math.abs(top - worm.y) > 220) continue;
        const y = top - 1;
        if (!foe.bodyClear(x, y) || !foe.supported(x, y)) continue;
        foe.x = x; foe.y = y;
        if (easy(solveShot(scene, worm, foe, weapon))) {
          foe.vx = 0; foe.vy = 0; foe.grounded = true;
          foe.facing = worm.x >= x ? 1 : -1;
          return true;
        }
      }
    }
  }
  foe.x = ox; foe.y = oy;
  return false;
}
