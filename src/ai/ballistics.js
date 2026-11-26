import { CFG } from '../config.js';

/**
 * Просчёт полёта снаряда без самого снаряда.
 *
 * Бот не «знает» правильный ответ и не читает его из формулы: он гоняет тот
 * же интегратор, что и настоящий снаряд, по той же маске земли. Формулы
 * баллистики тут не хватило бы — остров дырявый, между стволом и целью
 * бывает холм, и попадание решает именно рельеф.
 *
 * simulateShot — только прямой полёт до первого касания (им пользуются и
 * тесты). simulateFlight — полёт с повадками ствола: отскоки и фитиль
 * гранаты, попрыгунчик, липучка, пролом гири, бурение крота, доворот
 * самонаводки, возврат бумеранга, мина, сплит-ракета. По нему бот и
 * выбирает ствол: граната за бугор, кассета в яму, самонаводка за угол.
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

/**
 * Полёт со всеми повадками ствола — тем же шагом, что у Projectile, только
 * без самого снаряда и без разрушения земли. Чем кончилось:
 *   kind — 'terrain' | 'worm' | 'water' | 'out' (как simulateShot),
 *          'fuse' (фитиль догорел там, где лежит), 'mine' (мина легла),
 *          'boomerang' (вернулся или упёрся; урон — в hits),
 *          'split' (сплит-ракета разделилась; итог — в parts);
 *   x, y — точка взрыва; worm — в кого попал напрямую; time — когда.
 *
 * opts.splitAt — через сколько секунд делить сплит-ракету (как тап игрока).
 *
 * Самый горячий код бота: за решение — тысячи полётов, а решение стоит
 * кадр. Поэтому без замыканий и объектов на шаг, а ствол без повадок
 * (базука, ракеты авиаудара) идёт прежним коротким путём — simulateShot.
 */
export function simulateFlight(scene, x0, y0, vx, vy, weapon, owner = null, opts = null) {
  const p = weapon.projectile;
  const plain = !p.bounciness && !p.fuse && !p.homing && !p.sticky && !p.pierce && !p.digRadius
    && !p.split && !p.boomerang && !p.deploy && !(p.drag > 0);
  if (plain) return simulateShot(scene, x0, y0, vx, vy, weapon, owner);
  if (p.boomerang) return boomerangFlight(scene, x0, y0, vx, vy, p, owner);

  const terrain = scene.terrain;
  const W = terrain.width, H = terrain.height, solid = terrain.solid;
  const gravity = CFG.GRAVITY * (p.gravityScale ?? 1);
  const windA = scene.wind * (p.windScale ?? 1);
  // Отскок чувствителен к шагу: с вдвое крупным шагом граната отскакивала
  // от другой точки склона и катилась не туда. Поэтому после первого
  // касания — шаг игры, а до него, на гладкой дуге, хватает крупного
  let subs = SUBSTEPS;
  let sub = DT / subs;
  const dragOf = (h) => (p.drag > 0 ? Math.exp(-p.drag * h) : 1);
  let dragK = dragOf(sub);
  const rules = scene.rules ?? {};
  const bounce = (p.bounciness ?? 0) * (rules.bounce ?? 1);
  const friction = (p.friction ?? 0.75) * (rules.roll ?? 1);
  const team = owner?.team;
  const splitAt = opts?.splitAt ?? null;
  const homeDelay = p.homeDelay ?? 0.6;
  const maxTime = Math.min(MAX_TIME, CFG.PROJECTILE_MAX_LIFE);

  const boxes = wormBoxes(scene, null);
  let tubeX = -1e9, tubeY0 = 0, tubeY1 = -1;   // пролом гири: тут земли уже нет

  let x = x0, y = y0;
  let fuse = p.fuse || 0;
  let bounces = 0, pierced = 0, touched = false;

  for (let t = 0; t < maxTime; t += DT) {
    // Коснулся земли — со следующего кадра мелкий шаг, как в игре
    if (touched && subs !== CFG.SUBSTEPS) { subs = CFG.SUBSTEPS; sub = DT / subs; dragK = dragOf(sub); }
    if (fuse > 0) {
      fuse -= DT;
      if (fuse <= 0) return { kind: 'fuse', x, y, worm: null, time: t };
    }
    for (let s = 0; s < subs; s++) {
      const age = t + s * sub;
      if (splitAt !== null && age >= splitAt) {
        const speed = Math.hypot(vx, vy) || 1;
        const a0 = Math.atan2(vy, vx);
        const parts = [-0.24, 0, 0.24].map((da) => simulateFlight(scene, x, y,
          Math.cos(a0 + da) * speed, Math.sin(a0 + da) * speed, p.split, null));
        return { kind: 'split', x, y, worm: null, time: age, parts };
      }
      const locked = p.homing && age >= homeDelay;
      if (locked) {
        // Доворот к ближайшему врагу стрелка, как Projectile._steer
        let foe = null, bd = 700;
        for (let i = 0; i < boxes.length; i += 5) {
          const w = boxes[i];
          if (team != null && w.team === team) continue;
          const d = Math.hypot(w.x - x, w.centerY - y);
          if (d < bd) { bd = d; foe = w; }
        }
        if (foe) {
          const cur = Math.atan2(vy, vx);
          let d = Math.atan2(foe.centerY - y, foe.x - x) - cur;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          const turn = Math.max(-p.homing * sub, Math.min(p.homing * sub, d));
          const speed = Math.max(380, Math.hypot(vx, vy));
          vx = Math.cos(cur + turn) * speed;
          vy = Math.sin(cur + turn) * speed;
        }
      }
      vx += windA * (locked ? 0.2 : 1) * sub;
      if (!locked) vy += gravity * sub;
      if (dragK !== 1) { vx *= dragK; vy *= dragK; }
      const nx = x + vx * sub, ny = y + vy * sub;

      if (nx < -80 || nx > W + 80 || ny > H + 120) {
        return { kind: ny > CFG.WATER_Y && nx > 0 && nx < W ? 'water' : 'out', x: nx, y: ny, worm: null, time: age };
      }
      if (ny < -3000) return { kind: 'out', x: nx, y: ny, worm: null, time: age };

      // Боец на отрезке — шагом в 4 px, как Projectile._wormOnSegment;
      // своего снаряд не трогает первые 0.12 с (ownerGrace)
      const segSteps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / 4));
      for (let i = 0; i < boxes.length; i += 5) {
        if (boxes[i] === owner && age < 0.12) continue;
        const bl = boxes[i + 1], br = boxes[i + 2], bt = boxes[i + 3], bb = boxes[i + 4];
        // Отрезок целиком в стороне от бойца — не шагаем по нему
        if (Math.max(x, nx) < bl || Math.min(x, nx) > br || Math.max(y, ny) < bt || Math.min(y, ny) > bb) continue;
        for (let k = 1; k <= segSteps; k++) {
          const wx = x + ((nx - x) * k) / segSteps, wy = y + ((ny - y) * k) / segSteps;
          if (wx >= bl && wx <= br && wy >= bt && wy <= bb) return { kind: 'worm', x: wx, y: wy, worm: boxes[i], time: age };
        }
      }

      // Попиксельно по маске; hx, hy — первая твердь, fx, fy — последняя свободная
      const dx = nx - x, dy = ny - y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy)));
      const sx = dx / steps, sy = dy / steps;
      let hit = false, hx = 0, hy = 0, fx = x, fy = y;
      for (let i = 1; i <= steps; i++) {
        const rx = x + sx * i, ry = y + sy * i;
        const ix = rx | 0, iy = ry | 0;
        if (ix >= 0 && ix < W && iy >= 0 && iy < H && solid[iy * W + ix] === 1
          && !(Math.abs(ix - tubeX) <= 13 && iy >= tubeY0 && iy <= tubeY1)) {
          hit = true; hx = rx; hy = ry;
          break;
        }
        fx = rx; fy = ry;
      }
      if (!hit) { x = nx; y = ny; continue; }

      if (p.deploy === 'mine') return { kind: 'mine', x: fx, y: fy, worm: null, time: age };
      if (p.sticky) return { kind: 'terrain', x: fx, y: fy, worm: null, time: age + (fuse > 0 ? fuse : (p.stickFuse || 3)) };
      if (p.pierce > 0 && pierced < (p.pierceTimes ?? 1)) {
        pierced++;
        tubeX = Math.round(hx); tubeY0 = Math.round(hy) - 13; tubeY1 = Math.round(hy) + p.pierce + 13;
        x = hx; y = hy;
        vx *= 0.25;
        vy = Math.max(vy, 260);
        continue;
      }
      if (p.digRadius > 0) {
        // Крот бурит по курсу digTime секунд, не быстрее 6 px за подшаг игры
        const speed = Math.hypot(vx, vy) || 1;
        const len = Math.min(speed, 6 * 60 * CFG.SUBSTEPS) * (p.digTime || 0.5);
        const ex = hx + (vx / speed) * len;
        const ey = Math.min(H - 4, hy + (vy / speed) * len);
        return { kind: ey >= CFG.WATER_Y ? 'water' : 'terrain', x: ex, y: ey, worm: null, time: age + (p.digTime || 0.5) };
      }
      if (bounce > 0) {
        // Нормаль — как Terrain.normalAt(x, y, 5), только без вызова на пиксель
        let mx = 0, my = 0;
        const cx = hx, cy = hy;
        for (let oy = -5; oy <= 5; oy++) {
          const iy = (cy + oy) | 0;
          if (iy < 0 || iy >= H) continue;
          const row = iy * W;
          for (let ox = -5; ox <= 5; ox++) {
            if (!ox && !oy) continue;
            const ix = (cx + ox) | 0;
            if (ix >= 0 && ix < W && solid[row + ix] === 1) { mx -= ox; my -= oy; }
          }
        }
        const len = Math.hypot(mx, my);
        const nX = len < 1e-4 ? 0 : mx / len, nY = len < 1e-4 ? -1 : my / len;
        const vn = vx * nX + vy * nY;
        let rx = vx - (1 + bounce) * vn * nX;
        let ry = vy - (1 + bounce) * vn * nY;
        const tvn = rx * nX + ry * nY;
        const tx = rx - tvn * nX, ty = ry - tvn * nY;
        rx = tvn * nX + tx * friction;
        ry = tvn * nY + ty * friction;
        vx = rx; vy = ry;
        touched = true;
        if (p.maxBounces > 0 && ++bounces >= p.maxBounces) return { kind: 'terrain', x: fx, y: fy, worm: null, time: age };
        x = fx + nX * 1.5;
        y = fy + nY * 1.5;
        const speed = Math.hypot(vx, vy);
        if (speed < 42) {
          // Лёг: дальше ничего не случится — рванёт здесь, когда догорит
          // фитиль, а без фитиля — по страховке времени жизни
          return { kind: 'fuse', x, y, worm: null, time: fuse > 0 ? age + fuse : CFG.PROJECTILE_MAX_LIFE };
        }
        // Катится медленно и далеко от всех бойцов — до кого-то докатиться
        // уже не успеет; где именно ляжет, для оценки неважно
        if (speed < 140 && fuse > 0) {
          let near = false;
          for (let i = 0; i < boxes.length && !near; i += 5) {
            near = Math.abs(boxes[i].x - x) < 230 && Math.abs(boxes[i].y - y) < 230;
          }
          if (!near) return { kind: 'fuse', x, y, worm: null, time: age + fuse };
        }
        continue;
      }
      // Заряд с фитилём без отскока ложится и ждёт фитиля
      if (fuse > 0) return { kind: 'fuse', x: fx, y: fy, worm: null, time: age + fuse };
      return { kind: hy >= CFG.WATER_Y ? 'water' : 'terrain', x: hx, y: hy, worm: null, time: age };
    }
  }
  return { kind: fuse > 0 ? 'fuse' : 'out', x, y, worm: null, time: maxTime };
}

/** Живые бойцы плоско: [боец, left, right, top, низ] — геттеры дороги в горячем цикле. */
function wormBoxes(scene, skip) {
  const boxes = [];
  for (const w of scene.worms) {
    if (!w.alive || w === skip) continue;
    boxes.push(w, w.left, w.right, w.top, w.y);
  }
  return boxes;
}

/**
 * Бумеранг: летит по прицелу, тормозит и возвращается; бьёт каждого на
 * пути по разу туда и по разу обратно (Projectile._boomerangStep).
 */
function boomerangFlight(scene, x, y, vx, vy, p, owner) {
  const terrain = scene.terrain;
  const W = terrain.width, H = terrain.height;
  const gravity = CFG.GRAVITY * (p.gravityScale ?? 1);
  const windA = scene.wind * (p.windScale ?? 1);
  const sub = DT / SUBSTEPS;
  const s0 = Math.hypot(vx, vy) || 1;
  const ux = vx / s0, uy = vy / s0;
  const worms = scene.worms.filter((w) => w.alive && w !== owner);
  const hits = [];
  const seen = new Set();
  for (let t = 0; t < 4.5; t += sub) {
    vx -= ux * p.boomerang * sub;
    vy -= uy * p.boomerang * sub;
    vy += gravity * sub;
    vx += windA * sub;
    const nx = x + vx * sub, ny = y + vy * sub;
    const back = vx * ux + vy * uy < 0;
    for (let i = 0; i < worms.length; i++) {
      const w = worms[i];
      const key = back ? -1 - i : i;
      if (seen.has(key) || Math.hypot(w.x - nx, w.centerY - ny) > 22) continue;
      seen.add(key);
      hits.push({ worm: w, back });
    }
    if (back && owner && t > 0.4 && Math.hypot(owner.x - nx, owner.centerY - ny) < 24) break;
    if (nx < -120 || nx > W + 120 || ny > H + 60) break;
    if (terrain.raycast(x, y, nx, ny).hit) break;
    x = nx; y = ny;
  }
  return { kind: 'boomerang', x, y, worm: null, time: 0, hits };
}
