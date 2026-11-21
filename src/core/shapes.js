/**
 * Формы карты — поверх темы (биома).
 *
 * Тема отвечает за то, как карта выглядит и какой у неё «почерк» рельефа,
 * форма — за общий замысел: один остров, цепочка островов, ущелье, две
 * скалы, пещеры. Форма правит уже посчитанный профиль поверхности и
 * берёт случайность из своего генератора (subRng от зерна): основной поток
 * случайных чисел карты она не трогает, поэтому «остров» на любом зерне
 * остаётся ровно тем же островом, что и до появления форм, — проверенные
 * зерна кампании не разъезжаются.
 *
 * Форма выбирается из зерна, поэтому в сети у обоих игроков одна и та же.
 *
 * Поля:
 *   id, name — для меню и HUD
 *   weight   — вес при случайном выборе
 *   profile(surface, ctx) — правит массив высот поверхности (y земли)
 *   carve(terrain, rng)   — режет маску после заливки (пещеры)
 *   build(terrain, rng)   — рисует маску целиком сама, без профиля (башня)
 *   world                 — свои размеры мира (config.js, applyWorld)
 *   hidden                — не показывать в выборе карты быстрой игры
 */
import { CFG } from '../config.js';
import { subRng } from './rng.js';
import { wallEdge } from './Terrain.js';

const SHAPE_SALT = 0x5eed5;

/** Плавная «шапочка» 0…1…0 вокруг center шириной half. */
function bump(x, center, half) {
  const t = Math.abs(x - center) / half;
  if (t >= 1) return 0;
  const k = 1 - t;
  return k * k * (3 - 2 * k);
}

/** Поднять/опустить точку профиля, не залезая выше потолка мира. */
function setHeight(surface, x, y) {
  surface[x] = Math.max(80, y);
}

export const SHAPES = [
  {
    id: 'island',
    name: 'Остров',
    weight: 4,
  },
  {
    // Цепочка островов: два-три пролива, через которые не перейти ногами.
    // Перебраться — телепортом, прыжком с обрыва или никак: бой идёт
    // через воду.
    id: 'archipelago',
    name: 'Архипелаг',
    weight: 2,
    profile(surface, { rng, width }) {
      const straits = 3;
      const margin = width * 0.22;
      const step = (width - margin * 2) / (straits - 1);
      for (let i = 0; i < straits; i++) {
        const cx = margin + step * i + (rng() - 0.5) * step * 0.2;
        const half = 50 + rng() * 25;              // открытая вода ~100–150 px
        const x0 = Math.max(0, Math.floor(cx - half * 1.8));
        const x1 = Math.min(width - 1, Math.ceil(cx + half * 1.8));
        for (let x = x0; x <= x1; x++) {
          const k = bump(x, cx, half * 1.8);       // 1 в середине пролива
          const water = CFG.WATER_Y + 40;
          setHeight(surface, x, surface[x] + (water - surface[x]) * Math.min(1, k * 1.6));
        }
      }
    },
  },
  {
    // Ущелье: середина проваливается, края встают стенами. Сверху видно
    // всех, внизу — укрытие.
    id: 'canyon',
    name: 'Ущелье',
    weight: 2,
    profile(surface, { rng, width }) {
      const cx = width * (0.42 + rng() * 0.16);
      const half = 300 + rng() * 120;
      const floor = CFG.WATER_Y - 60;
      const wallTop = 300 + rng() * 50;
      for (let x = 0; x < width; x++) {
        // Борта: широкие плечи, поднятые к wallTop у самого края ущелья
        const shoulder = Math.max(bump(x, cx - half, 420), bump(x, cx + half, 420));
        if (shoulder > 0) {
          const y = surface[x] + (wallTop - surface[x]) * shoulder;
          if (y < surface[x]) setHeight(surface, x, y);
        }
        // Дно: середина проваливается почти до воды, склоны крутые
        const k = Math.min(1, bump(x, cx, half) * 1.5);
        if (k > 0) setHeight(surface, x, surface[x] + (floor - surface[x]) * k);
      }
    },
  },
  {
    // Две скалы с плоскими вершинами: сидеть наверху удобно и опасно —
    // оттуда видно всё, и тебя тоже.
    id: 'mesas',
    name: 'Две скалы',
    weight: 2,
    profile(surface, { rng, width }) {
      for (const at of [0.33, 0.67]) {
        const cx = width * (at + (rng() - 0.5) * 0.06);
        const half = 120 + rng() * 60;
        const top = 250 + rng() * 60;
        for (let x = Math.max(0, Math.floor(cx - half * 1.6)); x < Math.min(width, cx + half * 1.6); x++) {
          // Плоская вершина и крутые бока: «шапочка», возведённая в степень
          const k = Math.min(1, bump(x, cx, half * 1.6) * 1.8);
          const y = surface[x] + (top - surface[x]) * k;
          if (y < surface[x]) setHeight(surface, x, y);
        }
      }
    },
  },
  {
    // Пещеры: под поверхностью целая сеть полостей — копать, прятаться,
    // бить снизу.
    id: 'caverns',
    name: 'Пещеры',
    weight: 1,
    // Сначала земли становится больше — иначе полостям негде поместиться
    profile(surface, { width }) {
      for (let x = 0; x < width; x++) {
        const lift = 190 * Math.min(1, bump(x, width / 2, width * 0.45) * 1.4);
        setHeight(surface, x, surface[x] - lift);
      }
    },
    carve(terrain, rng) {
      const ctx = terrain.maskCtx;
      ctx.globalCompositeOperation = 'destination-out';
      const count = 7 + Math.floor(rng() * 4);
      for (let i = 0; i < count; i++) {
        const x = terrain.width * (0.15 + rng() * 0.7);
        const top = terrain.surface[Math.floor(x)];
        // Полость — только в толще земли над водой, не под ней
        if (top > CFG.WATER_Y - 140) continue;
        const y = Math.min(CFG.WATER_Y - 50, top + 55 + rng() * (CFG.WATER_Y - top - 110));
        ctx.beginPath();
        ctx.ellipse(x, y, 50 + rng() * 80, 22 + rng() * 30, (rng() - 0.5) * 0.8, 0, Math.PI * 2);
        ctx.fill();
        // Ход к соседней полости. Не ниже роста бойца с запасом (PASS): ход
        // в 26–36 px был виден, а пролезть по нему боец не мог
        if (i > 0 && rng() < 0.6) {
          ctx.lineWidth = PASS + rng() * 10;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + (rng() - 0.5) * 300, y + (rng() - 0.5) * 60);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    },
  },
  {
    // Башня: узкая и высокая арена из этажей. Целиком помещается в
    // вертикальный экран телефона; между этажами — крюком. Рисует маску
    // сама (build), профиль поверхности ей не нужен. В случайный выбор не
    // попадает (weight 0): её включает только свой режим, вместе с крюком.
    id: 'tower',
    name: 'Башня',
    weight: 0,
    hidden: true,
    // Ширина — ровно логическая ширина вертикального экрана (VIEW_BASE):
    // в портрете башня видна вся при масштабе 1, бойцы не мельчают
    world: { w: 720, h: 1560, ground: 1515, water: 1470, focus: 780, power: 1000, fallSafe: 190 },
    build(terrain, rng) {
      const ctx = terrain.maskCtx;
      const W = terrain.width, H = terrain.height;
      const r = (a, b) => a + rng() * (b - a);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#ffffff';

      // Всё нарисованное — контурами: новый кусок к соседу либо прирастает,
      // либо оставляет просвет, в который пролезет боец (см. Pieces)
      const walls = Boolean(terrain.walls);
      const pieces = new Pieces();
      const wallPieces = walls ? [0, 1].map((side) => Object.assign(pieces.add(wallOutline(W, H, side)), { wall: true })) : [];
      const fill = (pts) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fill();
        pieces.add(pts);
      };

      // Плита с неровными краями. Случайность (волна) берётся сразу, а
      // контур — когда спросят, с другим местом и концами: глыбу ставят,
      // когда известен карниз над ней, полочку укорачивают до прохода.
      const slabPlan = (x0, x1, yTop, thick) => {
        const wave = [r(0.018, 0.03), r(0.05, 0.08), r(0, 6.3), r(0, 6.3)];
        return (dx = 0, dy = 0, a = x0 + dx, b = x1 + dx) => slabOutline(a, b, yTop + dy, thick, wave);
      };
      const slab = (x0, x1, yTop, thick) => fill(slabPlan(x0, x1, yTop, thick)());
      // Столбик: сверху вниз от потолка (сталактит) или снизу вверх от пола
      const spike = (x, y0, y1, w) => {
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y0);
        ctx.lineTo(x + w / 2, y0);
        ctx.lineTo(x + w * 0.28, y1);
        ctx.quadraticCurveTo(x, y1 + Math.sign(y1 - y0) * 12, x - w * 0.28, y1);
        ctx.closePath();
        ctx.fill();
        pieces.add(spikeOutline(x, y0, y1, w));
      };
      // Сталактит, сосулька, столбик: если кончик оставляет щель с землёй
      // напротив (боец под ним не пролезет, а просвет видно) — короче; совсем
      // не помещается — не растёт. Дорастать до земли напротив тоже нельзя:
      // сосулька, упёршаяся в глыбу, закрывала карман
      const spikeFit = (x, y0, y1, w) => {
        const s = Math.sign(y1 - y0);
        const roots = pieces.touching(spikeOutline(x, y0, y0 + s * 8, w));
        for (let len = Math.abs(y1 - y0); len >= 20; len -= 5) {
          const pts = spikeOutline(x, y0, y0 + s * len, w);
          if (pieces.fits(pts) && pieces.touching(pts).every((q) => roots.includes(q))) { spike(x, y0, y0 + s * len, w); return; }
        }
      };
      // Поставить кусок туда, где он не оставит щелей: из вариантов
      // (контуров) — первый подходящий; ни один не подошёл — первый
      // (apart — к чему не прирастать; fallback — рисовать ли первый, если ни один)
      const settle = (variants, { apart = null, fallback = true } = {}) => {
        for (const v of variants) {
          const pts = v();
          if (pieces.fits(pts, apart)) { fill(pts); return; }
        }
        if (fallback) fill(variants[0]());
      };
      const g = { ctx, W, H, r, rng, walls, wallPieces, pieces, fill, slab, slabPlan, spikeFit, settle };

      // Своя форма у места (вид башни задаёт terrain.layout): ледяные
      // карнизы, вулкан, астероиды. Без неё — обычные этажи ниже
      const layout = TOWER_LAYOUTS[terrain.layout];
      if (layout) { layout(g); return; }

      // Основание — остров: края уходят под воду
      const baseY = H - 245;
      const f = r(0.006, 0.011), ph = r(0, 6.3);
      const island = [[0, H]];
      for (let x = 0; x <= W; x += 6) {
        const e = Math.min(1, Math.min(x, W - x) / 90);
        const k = walls ? 1 : e * e * (3 - 2 * e);
        const y = baseY + Math.sin(x * f + ph) * 26 + Math.sin(x * 0.031 + ph * 2) * 7;
        island.push([x, y + (CFG.WATER_Y + 50 - y) * (1 - k)]);
      }
      island.push([W, H]);
      fill(island);

      // Полочка у края этажа: до плиты рядом — либо проход шире бойца
      // (полочка короче), либо стык (дотягивается до плиты). dir 1 — слева.
      const shelf = (x0, x1, yTop, thick, dir, reach) => {
        const plan = slabPlan(x0, x1, yTop, thick);
        const variants = [];
        for (let cut = 0; cut <= x1 - x0 - 60; cut += 8) {
          variants.push(() => (dir > 0 ? plan(0, 0, x0, x1 - cut) : plan(0, 0, x0 + cut, x1)));
        }
        variants.push(() => (dir > 0 ? plan(0, 0, x0, reach + 24) : plan(0, 0, reach - 24, x1)));
        for (const v of variants) {
          const pts = v();
          if (pieces.fits(pts)) { fill(pts); return true; }
        }
        return false;
      };

      // Этажи: через один — две плиты с проёмом посередине и одна по центру.
      // Проёмы друг над другом не стоят: насквозь башню не простреливает,
      // но с этажа на этаж всегда есть куда зацепиться.
      const levels = 5, gap = 212;
      const floors = [];
      for (let k = 1; k <= levels; k++) {
        const y = baseY - gap * k + r(-14, 14);
        const thick = r(48, 64);
        const split = (k % 2 === 1) !== (rng() < 0.12);
        if (split) {
          const hole = r(150, 200), cx = W / 2 + r(-70, 70);
          const a = [r(20, 60), cx - hole / 2], b = [cx + hole / 2, W - r(20, 60)];
          slab(a[0], a[1], y, thick);
          slab(b[0], b[1], y, thick);
          floors.push({ y, thick, parts: [a, b] });
        } else {
          const half = r(150, 205), cx = W / 2 + r(-50, 50);
          const parts = [[cx - half, cx + half]];
          slab(cx - half, cx + half, y, thick);
          // Полочки у краёв — не всегда: за них цепляются и с них сбивают.
          // Сталактитов под ними нет (узкие), поэтому в parts они не идут
          if (rng() < 0.6) { const w = r(84, 110); shelf(12, 12 + w, y + r(-30, 30), thick * 0.8, 1, cx - half); }
          if (rng() < 0.6) { const w = r(84, 110); shelf(W - 12 - w, W - 12, y + r(-30, 30), thick * 0.8, -1, cx + half); }
          floors.push({ y, thick, parts });
        }
      }
      // Сталактиты под плитами (укрытие и зацеп) и пара столбиков на полу
      for (const fl of floors) {
        for (const [x0, x1] of fl.parts) {
          if (x1 - x0 < 200 || rng() < 0.45) continue;
          const sx = r(x0 + 60, x1 - 60);
          spikeFit(sx, fl.y + fl.thick - 6, fl.y + fl.thick + r(55, 95), r(40, 58));
        }
      }
      for (let i = 0; i < 2; i++) {
        const x = r(120, W - 120);
        spikeFit(x, baseY + 30, baseY - r(45, 75), r(46, 64));
      }
    },
  },
];

// Просвет между кусками земли, в который боец пролезает с запасом: корпус
// CFG.WORM_W x CFG.WORM_H (Worm.bodyClear) и ещё десяток пикселей. Уже —
// щель: её видно, а пройти нельзя, и боец на этаже застревает.
// Проверяет tools/passability.mjs.
export const PASS = CFG.WORM_H + 12;

/** Контур плиты: верх волнистый, но пологий (по нему ходят), низ грубее, к краям — клин. */
function slabOutline(x0, x1, yTop, thick, [f1, f2, p1, p2]) {
  const top = [], bottom = [];
  for (let x = x0; x <= x1; x += 8) {
    const edge = Math.min(1, Math.min(x - x0, x1 - x) / 34);
    const k = edge * edge * (3 - 2 * edge);
    const wave = Math.sin(x * f1 + p1) * 6 + Math.sin(x * f2 + p2) * 2;
    const mid = yTop + thick / 2;
    top.push([x, mid - (thick / 2 - wave) * k - 3]);
    bottom.push([x, mid + (thick / 2 + Math.sin(x * f2 * 1.7 + p1) * 7) * k + 3]);
  }
  return [...top, ...bottom.reverse()];
}

/** Контур столбика; закруглённый кончик — тремя точками кривой. */
function spikeOutline(x, y0, y1, w) {
  const s = Math.sign(y1 - y0);
  return [[x - w / 2, y0], [x + w / 2, y0], [x + w * 0.28, y1], [x + w * 0.14, y1 + s * 4.5],
    [x, y1 + s * 6], [x - w * 0.14, y1 + s * 4.5], [x - w * 0.28, y1]];
}

/** Контур каменной стены (Terrain._addWalls) — с ней тоже не оставляем щелей. */
function wallOutline(W, H, side) {
  const pts = [[side ? W : 0, 0]];
  for (let y = 0; y <= H; y += 8) pts.push([side ? W - wallEdge(y, side) : wallEdge(y, side), y]);
  pts.push([side ? W : 0, H]);
  return pts;
}

/** Сдвиги по порядку удалённости: [dx, dy] в пределах ±mx, ±my с шагом step. */
function nudges(mx, my, step) {
  const out = [];
  for (let dx = -mx; dx <= mx; dx += step) for (let dy = -my; dy <= my; dy += step) out.push([dx, dy]);
  return out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
}

function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function boxGap(a, b) {
  return Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
}

function pointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function segDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  return Math.min(pointSeg(ax, ay, cx, cy, dx, dy), pointSeg(bx, by, cx, cy, dx, dy),
    pointSeg(cx, cy, ax, ay, bx, by), pointSeg(dx, dy, ax, ay, bx, by));
}

function inside(px, py, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Расстояние между контурами (0 — пересекаются); дальше cap не считаем. */
function polyDist(a, b, cap = PASS) {
  if (boxGap(a.box, b.box) >= cap) return cap;
  if (inside(a.pts[0][0], a.pts[0][1], b.pts) || inside(b.pts[0][0], b.pts[0][1], a.pts)) return 0;
  let best = cap;
  const A = a.pts, B = b.pts, bb = b.box;
  for (let i = 0; i < A.length; i++) {
    const [ax, ay] = A[i], [bx, by] = A[(i + 1) % A.length];
    if (Math.min(ax, bx) - bb[2] >= best || bb[0] - Math.max(ax, bx) >= best
      || Math.min(ay, by) - bb[3] >= best || bb[1] - Math.max(ay, by) >= best) continue;
    for (let j = 0; j < B.length; j++) {
      const [cx, cy] = B[j], [dx, dy] = B[(j + 1) % B.length];
      const d = segDist(ax, ay, bx, by, cx, cy, dx, dy);
      if (d < best) { best = d; if (!best) return 0; }
    }
  }
  return best;
}

/**
 * Нарисованные куски башни. Новый кусок с каждым соседом либо срастается,
 * либо оставляет просвет не уже PASS. Щель с соседом, к которому кусок
 * прирос через общий третий (две сосульки под одним карнизом, два
 * столбика на полу), — тупик, а не проход: её не считаем. Кроме стены:
 * она волнистая, и за узким устьем у неё бывает ниша, куда видно, а не
 * пролезть, — со стеной только стык или проход.
 */
class Pieces {
  constructor() { this.list = []; }

  add(pts) {
    const p = { pts, box: bbox(pts), touch: new Set() };
    for (const q of this.list) {
      if (polyDist(p, q, 1) === 0) { p.touch.add(q); q.touch.add(p); }
    }
    this.list.push(p);
    return p;
  }

  /** Куски, с которыми контур соприкасается. */
  touching(pts) {
    const p = { pts, box: bbox(pts) };
    return this.list.filter((q) => polyDist(p, q, 1) === 0);
  }

  /** apart — куски, к которым и прирастать нельзя (только проход). */
  fits(pts, apart = null) {
    const p = { pts, box: bbox(pts) };
    const touch = [], near = [];
    for (const q of this.list) {
      const d = polyDist(p, q);
      if (d < PASS && apart?.includes(q)) return false;
      if (d === 0) touch.push(q);
      else if (d < PASS) near.push(q);
    }
    return near.every((q) => !q.wall && touch.some((c) => !c.wall && c.touch.has(q)));
  }
}

/** Основание башни — остров, края уходят под воду (у стен — до стен). width — доля ширины. */
function baseIsland({ W, H, r, fill, walls }, { y = H - 245, width = 1, lift = 0 } = {}) {
  const f = r(0.006, 0.011), ph = r(0, 6.3);
  const x0 = (W * (1 - width)) / 2, x1 = W - x0;
  const pts = [[x0, H]];
  for (let x = x0; x <= x1; x += 6) {
    const e = Math.min(1, Math.min(x - x0, x1 - x) / 90);
    // Между стеной и уходящим под воду краем оставалась расщелина до самой
    // воды — узкая, боец в ней застревал. Со стенами остров доходит до них
    const k = walls && width >= 1 ? 1 : e * e * (3 - 2 * e);
    // lift — горб посередине (вулкан начинается с холма)
    const hump = lift * Math.max(0, 1 - Math.abs(x - W / 2) / (W * 0.35)) ** 2;
    const yy = y - hump + Math.sin(x * f + ph) * 22 + Math.sin(x * 0.031 + ph * 2) * 6;
    pts.push([x, yy + (CFG.WATER_Y + 50 - yy) * (1 - k)]);
  }
  pts.push([x1, H]);
  fill(pts);
}

/**
 * Формы башни по месту. Каждая рисует маску целиком; что встать есть где,
 * проверяет tests/single.mjs (все бои кампании собираются), что щелей
 * уже бойца нет — tools/passability.mjs.
 */
const TOWER_LAYOUTS = {
  /**
   * Ледник: карнизы растут поочерёдно от левой и правой стены, зигзагом
   * вверх; снизу свисают сосульки. Посередине — пара ледяных глыб.
   */
  shelves(g) {
    const { W, H, r, rng, slab, slabPlan, spikeFit, settle } = g;
    const baseY = H - 245;
    baseIsland(g, { y: baseY });
    const n = 7, gap = (baseY - 150) / n;
    // Глыба карниза ставится на следующем шаге, когда известен карниз над
    // ней: висела вплотную под ним, и боец на ней не помещался
    let block = null;
    for (let i = 1; i <= n; i++) {
      const y = baseY - gap * i + r(-10, 10);
      const left = i % 2 === 1;
      const len = r(W * 0.5, W * 0.68);
      const [x0, x1] = left ? [-20, len] : [W - len, W + 20];
      const thick = r(40, 52);
      slab(x0, x1, y, thick);
      if (block) { block(); block = null; }
      // Сосульки под карнизом — укрытие и зацеп
      for (let k = 0; k < 3; k++) {
        if (rng() < 0.35) continue;
        const sx = left ? r(60, len - 50) : r(W - len + 50, W - 60);
        spikeFit(sx, y + thick - 6, y + thick + r(40, 85), r(26, 40));
      }
      // Ледяная глыба по другую сторону — не всегда. Не влезает с проходом
      // нигде рядом — прирастает к стене
      if (rng() < 0.55) {
        const cx = left ? r(W * 0.72, W - 70) : r(70, W * 0.28);
        const bx0 = cx - r(45, 65), bx1 = cx + r(45, 65);
        const plan = slabPlan(bx0, bx1, y + r(-60, -30), r(34, 42));
        const moves = nudges(64, 60, 8);
        block = () => settle([
          ...moves.map(([dx, dy]) => () => plan(dx, dy)),
          ...moves.map(([dx, dy]) => () => (left ? plan(0, dy, bx0 + dx, W + 20) : plan(0, dy, -20, bx1 + dx))),
        ]);
      }
    }
    if (block) block();
  },

  /**
   * Жерло: посередине вулкан — конус с кратером, на склонах выступы; над
   * кратером и по бокам парят обломки скал.
   */
  caldera(g) {
    const { ctx, W, H, r, rng, walls, pieces, slabPlan, settle } = g;
    const baseY = H - 245;
    baseIsland(g, { y: baseY, lift: 40 });
    // Конус: от широкого подножия к кратеру. Шаги — целые: дробный шаг не
    // доходил до подножия справа, и замыкающая линия срезала склон клином
    const peakY = baseY - r(560, 640), rimW = r(130, 170), footW = W * 0.82;
    const cx = W / 2 + r(-30, 30);
    const slope = (s, t) => [cx + s * (footW / 2 - (footW / 2 - rimW / 2) * t - Math.sin(t * 9) * 8),
      baseY + 30 - (baseY + 30 - peakY) * t ** 0.8];
    const ax = cx - rimW / 2 + 18, bx = cx + rimW / 2 - 18;
    ctx.beginPath();
    ctx.moveTo(cx - footW / 2, baseY + 30);
    for (let i = 0; i <= 20; i++) ctx.lineTo(...slope(-1, i / 20));
    // Кратер: впадина между краями
    ctx.lineTo(ax, peakY - 6);
    ctx.quadraticCurveTo(cx, peakY + 46, bx, peakY - 6);
    for (let i = 20; i >= 0; i--) ctx.lineTo(...slope(1, i / 20));
    ctx.closePath();
    ctx.fill();
    // Тот же контур точками — для проверки просветов
    const cone = [[cx - footW / 2, baseY + 30]];
    for (let i = 0; i <= 20; i++) cone.push(slope(-1, i / 20));
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      cone.push([u * u * ax + 2 * u * t * cx + t * t * bx, (u * u + t * t) * (peakY - 6) + 2 * u * t * (peakY + 46)]);
    }
    for (let i = 20; i >= 0; i--) cone.push(slope(1, i / 20));
    pieces.add(cone);
    // Выступы на склонах — по ним карабкаются. До стены выступ оставляет
    // проход шире бойца (короче): и не щель, и не крышка — приросший к
    // стене выступ закрывал карман между склоном и стеной, а в нём бывал
    // старт. Короче 60 px не бывает — тогда выступа нет
    const ledge = (x0, x1, y, thick, out) => {
      const plan = slabPlan(x0, x1, y, thick);
      const variants = [];
      for (let cut = 0; cut <= x1 - x0 - 60; cut += 8) {
        variants.push(() => (out < 0 ? plan(0, 0, x0 + cut, x1) : plan(0, 0, x0, x1 - cut)));
      }
      settle(variants, { apart: g.wallPieces, fallback: false });
    };
    for (let i = 1; i <= 3; i++) {
      const y = baseY - i * (baseY - peakY) / 4 + r(-12, 12);
      const t = (baseY + 30 - y) / (baseY + 30 - peakY);
      const half = footW / 2 - (footW / 2 - rimW / 2) * t ** 1.25;
      const w = r(90, 130);
      if (rng() < 0.85) ledge(cx - half - w + 30, cx - half + 36, y, r(34, 44), -1);
      if (rng() < 0.85) ledge(cx + half - 36, cx + half + w - 30, y + r(-30, 30), r(34, 44), 1);
    }
    // Обломки над кратером и по бокам: от соседей и стен — на проход
    const rocks = [[0.18, 0.2], [0.82, 0.22], [0.5, 0.1], [0.12, 0.42], [0.88, 0.45]];
    const moves = nudges(64, 48, 8);
    for (const [fx, fy] of rocks) {
      const x = W * fx + r(-30, 30), y = peakY * fy + 120 + r(-30, 30);
      const half = r(55, 85);
      const plan = slabPlan(x - half, x + half, y, r(38, 50));
      const side = walls && (x - half < 90 ? -1 : x + half > W - 90 ? 1 : 0);
      settle([
        ...moves.map(([dx, dy]) => () => plan(dx, dy)),
        ...(side ? moves.map(([, dy]) => () => (side < 0 ? plan(0, dy, -20, x + half) : plan(0, dy, x - half, W + 20))) : []),
      ]);
    }
  },

  /**
   * Космос: маленькое основание и россыпь астероидов — неровные «камни»
   * разного размера рядами, со сдвигом, чтобы между ними было куда лететь.
   */
  asteroids(g) {
    const { W, H, r, rng, settle } = g;
    const baseY = H - 245;
    baseIsland(g, { y: baseY + 30, width: 0.62 });
    // Неровный круг с приплюснутым верхом — на нём можно стоять. Соседи по
    // ряду либо срастаются, либо расходятся на проход
    const moves = nudges(56, 24, 6);
    const rock = (cx, cy, rad) => {
      const n = 22, ph = r(0, 6.3);
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = rad * (1 + Math.sin(a * 3 + ph) * 0.12 + Math.sin(a * 5 + ph * 2) * 0.06);
        let y = cy + Math.sin(a) * rr * 0.78;
        if (Math.sin(a) < -0.55) y = cy - rad * 0.6;        // плоская макушка
        pts.push([cx + Math.cos(a) * rr, y]);
      }
      // Центр не дальше от края, чем было задумано (70 px), — с запасом в 10
      const ok = moves.filter(([dx]) => cx + dx >= 60 && cx + dx <= W - 60);
      settle(ok.map(([dx, dy]) => () => pts.map(([x, y]) => [x + dx, y + dy])));
    };
    const rows = 6, gap = (baseY - 160) / rows;
    for (let i = 1; i <= rows; i++) {
      const y = baseY - gap * i + r(-15, 15);
      const count = rng() < 0.5 ? 2 : 3;
      for (let k = 0; k < count; k++) {
        const slot = W / count;
        const cx = slot * (k + 0.5) + r(-slot * 0.2, slot * 0.2) + (i % 2 ? 30 : -30);
        rock(Math.max(70, Math.min(W - 70, cx)), y, r(48, 82));
      }
    }
  },
};

export const SHAPE_BY_ID = Object.fromEntries(SHAPES.map((s) => [s.id, s]));

/**
 * Виды башни: та же арена, другие тема и правило. Выбирается от зерна
 * партии — в сети у обоих один. rules поверх правил партии:
 *   groundFriction — трение о землю (по умолчанию CFG.GROUND_FRICTION);
 *   landKeep       — сколько скорости остаётся при приземлении (0.3);
 *   flood, windRange — как у партии (match.js);
 *   liquid         — 'lava': жидкость внизу — лава.
 */
export const TOWER_VARIANTS = [
  // biomes — из чего выбирать землю, если своей нет: у подножия только зелень
  { id: 'classic', name: 'Башня', weight: 2, biome: null, biomes: ['jungle', 'forest'], rules: {}, intro: null },
  {
    // walls — каменные стены по краям вместо обрыва в воду
    id: 'ice', name: 'Ледяная башня', weight: 1, biome: 'snow', layout: 'shelves', walls: true,
    rules: { groundFriction: 0.9, landKeep: 0.85 },
    intro: 'Ледяная башня: скользко — от взрыва катишься далеко',
  },
  {
    id: 'lava', name: 'Лавовая башня', weight: 1, biome: 'hell', layout: 'caldera', walls: true,
    rules: { flood: { after: 5, step: 90 }, liquid: 'lava' },
    intro: 'Лавовая башня: лава пойдёт вверх уже с 6-го хода',
  },
  {
    id: 'wind', name: 'Ветреная башня', weight: 1, biome: 'desert',
    rules: { windRange: [170, 300] },
    intro: 'Ветреная башня: сильный ветер, бей с поправкой',
  },
  // Только для кампании (вес 0 — случайно не выпадает): тяжесть вдвое
  // слабее, трос тянет дальше, ветра нет, внизу — пустота вместо воды
  {
    id: 'space', name: 'Космическая башня', weight: 0, biome: 'urban', layout: 'asteroids',
    rules: { gravity: 0.55, hookRange: 1.35, wind: 0, liquid: 'void', flood: null },
    intro: 'Космос: всё летит дальше, трос тянет дальше, внизу — пустота',
  },
];

/** Вид башни для партии: явный (?variant=ice) или от зерна. */
export function towerVariant(seed, wanted = null) {
  const forced = TOWER_VARIANTS.find((v) => v.id === wanted);
  if (forced) return forced;
  const rng = subRng(seed, SHAPE_SALT + 7);
  const total = TOWER_VARIANTS.reduce((a, v) => a + v.weight, 0);
  let r = rng() * total;
  for (const v of TOWER_VARIANTS) {
    r -= v.weight;
    if (r < 0) return v;
  }
  return TOWER_VARIANTS[0];
}

/** Генератор формы: свой поток от зерна, основной не трогает. */
export function shapeRng(seed) {
  return subRng(seed, SHAPE_SALT);
}

/**
 * Форма для партии: явная (миссия, выбор в меню) или случайная от зерна.
 * 'random' и пустое значение — случайная по весам.
 */
export function pickShape(seed, wanted = null) {
  if (wanted && wanted !== 'random' && SHAPE_BY_ID[wanted]) return SHAPE_BY_ID[wanted];
  const rng = subRng(seed, SHAPE_SALT + 1);
  const total = SHAPES.reduce((a, s) => a + s.weight, 0);
  let r = rng() * total;
  for (const s of SHAPES) {
    r -= s.weight;
    if (r < 0) return s;
  }
  return SHAPES[0];
}
