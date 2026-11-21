/**
 * Проходимость карт: где боец не пролезает, хотя щель видна, откуда не
 * выбраться и не заперт ли кто-то на старте.
 *
 * Карта строится тем же кодом, что в игре (Terrain, shapes.js, Props), но
 * без браузера: маску рисует маленький программный «холст» ниже — ровно
 * те операции, что нужны генерации (контуры, эллипсы, дуги, линия с
 * круглыми концами, стирание), со сглаживанием краёв, как у браузера.
 * Расстановка бойцов, монстров и укрытий повторяет GameScene по шагам и
 * расходует те же ГПСЧ, поэтому совпадает с игрой.
 *
 * Что считается (боец — CFG.WORM_W x CFG.WORM_H, проверки — Worm.bodyClear):
 *   щели   — просвет в земле, через который видно насквозь (воздух с двух
 *            сторон), шириной не меньше GAP_VISIBLE, но корпус бойца
 *            (с запасом MARGIN) в него не входит. «Глухо» — не пролезть
 *            совсем, «впритык» — пролезает без запаса;
 *   ловушки — места, куда можно попасть, но откуда не вернуться к
 *            стартам ходьбой, прыжком и (на башне) тросом;
 *   запертые старты — стартовая точка, с которой не добраться до других.
 *
 * Запуск: node tools/passability.mjs [--seeds 200] [--only tower,ascent,...]
 *         [--render <папка>] [--json <файл>]
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ------------------------------------------------------------ холст-заглушка

/**
 * Маска как у браузера: альфа 0…255 на пиксель, заливка по ненулевому
 * правилу, покрытие края — по 4 подстрокам с точной шириной пролёта.
 */
class MaskCtx {
  constructor(canvas) {
    this.canvas = canvas;
    this.globalCompositeOperation = 'source-over';
    this.fillStyle = '#fff';
    this.strokeStyle = '#fff';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.globalAlpha = 1;
    this._paths = [];
    this._cur = null;
  }

  get alpha() {
    const c = this.canvas;
    if (!c._alpha || c._alpha.length !== c.width * c.height) c._alpha = new Uint8Array(c.width * c.height);
    return c._alpha;
  }

  // Рисование картинок, трансформы, градиенты — только для видимой текстуры
  setTransform() {}
  save() {}
  restore() {}
  drawImage() {}
  createPattern() { return null; }
  createLinearGradient() { return { addColorStop() {} }; }
  fillRect(x, y, w, h) { this.beginPath(); this.rect(x, y, w, h); this.fill(); }

  beginPath() { this._paths = []; this._cur = null; }
  moveTo(x, y) { this._cur = [[x, y]]; this._paths.push(this._cur); }
  lineTo(x, y) { if (!this._cur) this.moveTo(x, y); else this._cur.push([x, y]); }
  closePath() {
    if (!this._cur?.length) return;
    const [x, y] = this._cur[0];
    this._cur.push([x, y]);
    this._cur = [[x, y]];
    this._paths.push(this._cur);
  }
  _last() { return this._cur?.[this._cur.length - 1] ?? null; }
  quadraticCurveTo(cx, cy, x, y) {
    const p = this._last();
    if (!p) { this.moveTo(x, y); return; }
    const [x0, y0] = p;
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      this._cur.push([u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y]);
    }
  }
  rect(x, y, w, h) {
    this._paths.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    this._cur = [[x, y]];
    this._paths.push(this._cur);
  }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep += Math.PI * 2;
    if (ccw && sweep > 0) sweep -= Math.PI * 2;
    if (Math.abs(a1 - a0) >= Math.PI * 2) sweep = ccw ? -Math.PI * 2 : Math.PI * 2;
    const n = Math.max(32, Math.ceil(Math.abs(sweep) * Math.max(rx, ry) / 1.5));
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
      const px = x + ex * cr - ey * sr, py = y + ex * sr + ey * cr;
      if (i === 0 && !this._cur) this.moveTo(px, py); else this.lineTo(px, py);
    }
  }
  arc(x, y, r, a0, a1, ccw = false) { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }

  clearRect(x, y, w, h) {
    const c = this.canvas, a = this.alpha;
    const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(c.width, Math.ceil(x + w));
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(c.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) a.fill(0, yy * c.width + x0, yy * c.width + x1);
  }

  fill() { this._raster(this._paths); }

  /** Линия: каждый отрезок — прямоугольник, круглые концы — кругами. */
  stroke() {
    const hw = this.lineWidth / 2;
    for (const sp of this._paths) {
      for (let i = 0; i + 1 < sp.length; i++) {
        const [x0, y0] = sp[i], [x1, y1] = sp[i + 1];
        const d = Math.hypot(x1 - x0, y1 - y0) || 1;
        const nx = (-(y1 - y0) / d) * hw, ny = ((x1 - x0) / d) * hw;
        const poly = [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny], [x0 + nx, y0 + ny]];
        if (this.lineCap === 'round') {
          // Капсула одним контуром: полукруги на концах
          const a = Math.atan2(y1 - y0, x1 - x0);
          const cap = [];
          const n = 24;
          for (let k = 0; k <= n; k++) { const t = a - Math.PI / 2 + (Math.PI * k) / n; cap.push([x1 + Math.cos(t) * hw, y1 + Math.sin(t) * hw]); }
          for (let k = 0; k <= n; k++) { const t = a + Math.PI / 2 + (Math.PI * k) / n; cap.push([x0 + Math.cos(t) * hw, y0 + Math.sin(t) * hw]); }
          cap.push(cap[0]);
          this._raster([cap]);
        } else this._raster([poly]);
      }
    }
  }

  getImageData(x, y, w, h) {
    const c = this.canvas, a = this.alpha;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      const sy = y + yy;
      if (sy < 0 || sy >= c.height) continue;
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx;
        if (sx < 0 || sx >= c.width) continue;
        data[(yy * w + xx) * 4 + 3] = a[sy * c.width + sx];
      }
    }
    return { data, width: w, height: h };
  }

  _raster(paths) {
    const c = this.canvas, W = c.width, H = c.height, A = this.alpha;
    const S = 4;
    const edges = [];
    let minY = Infinity, maxY = -Infinity;
    for (const sp of paths) {
      const n = sp.length;
      if (n < 2) continue;
      for (let i = 0; i < n; i++) {
        const [x0, y0] = sp[i], [x1, y1] = sp[(i + 1) % n];
        if (y0 === y1) continue;
        const dir = y1 > y0 ? 1 : -1;
        const top = Math.min(y0, y1), bot = Math.max(y0, y1);
        const xt = y0 < y1 ? x0 : x1;
        edges.push({ top, bot, xt, k: (x1 - x0) / (y1 - y0), dir });
        if (top < minY) minY = top;
        if (bot > maxY) maxY = bot;
      }
    }
    if (!edges.length) return;
    edges.sort((a, b) => a.top - b.top);
    const r0 = Math.max(0, Math.floor(minY)), r1 = Math.min(H - 1, Math.ceil(maxY));
    const cov = new Float32Array(W + 1);
    const op = this.globalCompositeOperation;
    let next = 0;
    let active = [];
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      while (next < edges.length && edges[next].top < r + 1) active.push(edges[next++]);
      active = active.filter((e) => e.bot > r);
      if (!active.length) continue;
      let lo = W, hi = -1;
      for (let s = 0; s < S; s++) {
        const ys = r + (s + 0.5) / S;
        xs.length = 0;
        for (const e of active) if (e.top <= ys && ys < e.bot) xs.push([e.xt + (ys - e.top) * e.k, e.dir]);
        if (xs.length < 2) continue;
        xs.sort((a, b) => a[0] - b[0]);
        let wind = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          wind += xs[i][1];
          if (wind === 0) continue;
          let xa = Math.max(0, xs[i][0]), xb = Math.min(W, xs[i + 1][0]);
          if (xb <= xa) continue;
          const ia = Math.floor(xa), ib = Math.floor(xb);
          if (ia < lo) lo = ia;
          if (ib > hi) hi = ib;
          if (ia === ib) { cov[ia] += (xb - xa) / S; continue; }
          cov[ia] += (ia + 1 - xa) / S;
          for (let x = ia + 1; x < ib; x++) cov[x] += 1 / S;
          cov[ib] += (xb - ib) / S;
        }
      }
      if (hi < 0) continue;
      const row = r * W;
      for (let x = lo; x <= Math.min(hi, W - 1); x++) {
        const k = Math.min(1, cov[x]);
        cov[x] = 0;
        if (k <= 0) continue;
        const a = A[row + x];
        A[row + x] = Math.round(op === 'destination-out' ? a * (1 - k) : k * 255 + a * (1 - k));
      }
      if (hi >= W) cov[W] = 0;
    }
  }
}

class MaskCanvas {
  constructor() { this.width = 300; this.height = 150; this._ctx = null; }
  getContext() { return (this._ctx ??= new MaskCtx(this)); }
}

globalThis.document ??= { createElement: () => new MaskCanvas() };
globalThis.location ??= { search: '' };

// Модули игры — после заглушки: Terrain создаёт холсты в конструкторе
const { CFG, applyWorld } = await import('../src/config.js');
const { Terrain } = await import('../src/core/Terrain.js');
const { pickShape, towerVariant, shapeRng, TOWER_VARIANTS, SHAPES } = await import('../src/core/shapes.js');
const { BIOMES, pickBiome } = await import('../src/core/biomes.js');
const { makeRng, subRng } = await import('../src/core/rng.js');
const { Props } = await import('../src/entities/Props.js');
const { Worm } = await import('../src/entities/Worm.js');
const M = await import('../src/core/match.js');
const { ASCENT } = await import('../src/campaign/ascent.js');
const { CHALLENGES } = await import('../src/campaign/challenges.js');
const { MISSIONS } = await import('../src/campaign/missions.js');

// Видимая текстура без браузера не нужна: физика живёт по маске
Terrain.prototype._paintTexture = function () {};

const BASE_GRAVITY = CFG.GRAVITY;
const BASE_HOOK = CFG.HOOK_RANGE;

// ------------------------------------------------------------- сборка карты

/** Заглушка сцены для Props: всё есть, ничего не рисуется. */
function propsScene(terrain) {
  const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : () => stub) });
  return {
    terrain,
    textures: { exists: () => true, get: () => ({ getSourceImage: () => null }) },
    add: { image: () => stub },
    rig: { world: (o) => o },
  };
}

/** Только земля партии — как GameScene._buildTerrain (и всё, что до неё). */
function makeTerrain(match, seed) {
  const shape = pickShape(seed, match.shape ?? (match.mode === 'campaign' ? 'island' : null));
  applyWorld(shape.world);
  const variant = shape.id === 'tower' ? towerVariant(seed, match.variant ?? null) : null;
  let rules = match.rules ?? {};
  if (variant) {
    const v = variant.rules;
    rules = { ...rules, ...v, flood: 'flood' in v ? v.flood : rules.flood };
  }
  CFG.GRAVITY = BASE_GRAVITY * (Number(rules.gravity) || 1);
  CFG.HOOK_RANGE = BASE_HOOK * (Number(rules.hookRange) || 1);
  const rng = makeRng(seed);
  let biome = BIOMES.find((b) => b.id === match.biome) ?? BIOMES.find((b) => b.id === variant?.biome);
  if (!biome) {
    const picked = pickBiome(rng);
    const list = variant?.biomes;
    biome = list?.length ? BIOMES.find((b) => b.id === list[BIOMES.indexOf(picked) % list.length]) ?? picked : picked;
  }
  const terrain = new Terrain(CFG.WORLD_W, CFG.WORLD_H, biome, rng);
  terrain.layout = variant?.layout ?? null;
  terrain.walls = Boolean(variant?.walls);
  terrain.generate(shape, shapeRng(seed));
  return { shape, variant, rules, rng, terrain };
}

export const buildTerrainOnly = (match, seed = match.seed) => makeTerrain(match, seed).terrain;

/**
 * Построить карту партии так же, как GameScene.create: форма, вид башни,
 * правила, место, земля, бойцы (snapToGround), монстры, укрытия.
 */
export function buildMap(match, seed = match.seed) {
  const { shape, variant, rules, rng, terrain } = makeTerrain(match, seed);
  const sizes = match.teams.map((t) => t.worms ?? CFG.WORMS_PER_TEAM);
  const order = [];
  for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((n, team) => { if (i < n) order.push({ team, idx: i }); });

  const phys = new Physics(terrain, rules);
  const spawns = [];
  if (terrain.tops) {
    // _findFloorSpots
    const all = terrain.standSpots();
    for (let i = all.length - 1; i > 0; i--) { const j = rng.int(0, i); [all[i], all[j]] = [all[j], all[i]]; }
    let picked = null;
    for (let minDist = 420; minDist >= 60 && !picked; minDist -= 40) {
      const got = [];
      for (const p of all) {
        if (got.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= minDist)) got.push(p);
        if (got.length === order.length) { picked = got; break; }
      }
    }
    picked ??= all.slice(0, order.length);
    order.forEach(({ team }, i) => {
      const p = picked[i] ?? { x: CFG.WORLD_W / 2, y: 100 };
      const w = phys.worm(p.x, p.y);
      w.snapToGround();
      spawns.push({ x: w.x, y: w.y, team });
    });
  } else {
    // _findSpawnSpots: десант — встанет на поверхность столбца
    const all = [];
    for (let x = 180; x < CFG.WORLD_W - 180; x += 6) if (terrain.isSpawnable(x)) all.push(x);
    let xs = [];
    if (all.length) {
      const lo = all[0], hi = all[all.length - 1];
      const span = Math.min(CFG.SPAWN_SPAN, hi - lo);
      const start = lo + rng() * Math.max(0, (hi - lo) - span);
      let pool = all.filter((x) => x >= start && x <= start + span);
      if (pool.length < order.length) pool = all;
      const sh = pool.slice();
      for (let i = sh.length - 1; i > 0; i--) { const j = rng.int(0, i); [sh[i], sh[j]] = [sh[j], sh[i]]; }
      for (let minDist = CFG.SPAWN_MIN_DIST; minDist >= 40 && !xs.length; minDist -= 40) {
        const got = [];
        for (const x of sh) {
          if (got.every((p) => Math.abs(p - x) >= minDist)) got.push(x);
          if (got.length === order.length) break;
        }
        if (got.length === order.length) xs = got.sort((a, b) => a - b);
      }
      if (!xs.length) xs = sh.slice(0, order.length).sort((a, b) => a - b);
    }
    order.forEach(({ team }, i) => {
      const x = xs[i] ?? 1600;
      const top = terrain.surfaceYAt(x, 0) ?? CFG.GROUND_BASE - 100;
      spawns.push({ x, y: top - 1, team });
    });
  }

  // _spawnMonsters
  const monsters = [];
  const want = match.monsters ?? {};
  if (terrain.tops && (match.boss || Object.keys(want).length)) {
    const mr = subRng(seed >>> 0, 0xb055);
    const spots = terrain.standSpots(10, 40);
    for (let i = spots.length - 1; i > 0; i--) { const j = mr.int(0, i); [spots[i], spots[j]] = [spots[j], spots[i]]; }
    const taken = spawns.map((w) => ({ x: w.x, y: w.y, r: 150 }));
    let k = 1;
    const free = (p, r) => taken.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= Math.max(r, q.r) * k);
    if (match.boss) {
      const roomy = spots.filter((p) => !terrain.solidInRect(p.x - 46, p.y - 104, p.x + 46, p.y - 6) && free(p, 260));
      const top = (roomy.length ? roomy : spots).reduce((a, b) => (b.y < a.y ? b : a));
      monsters.push({ x: top.x, y: top.y, boss: true });
      taken.push({ x: top.x, y: top.y, r: 160 });
    }
    for (const [kind, n] of Object.entries(want)) {
      let placed = 0;
      for (k = 1; k >= 0.4 && placed < n; k -= 0.2) {
        for (const p of spots) {
          if (placed >= n) break;
          if (!free(p, 90)) continue;
          monsters.push({ x: p.x, y: p.y, kind });
          taken.push({ x: p.x, y: p.y, r: 90 });
          placed++;
        }
      }
    }
  }

  let props = [];
  if (terrain.tops) {
    const pr = new Props(propsScene(terrain), seed, variant?.id ?? 'classic', { painted: false });
    pr.build([...spawns, ...monsters].map((w) => ({ x: w.x, y: w.y })));
    props = pr.stamped;
  }
  phys.reindex();
  return {
    seed, terrain, spawns, monsters, props, rules, phys,
    shape: shape.id, variant: variant?.id ?? null,
    hook: Number(rules.hook) > 0,
  };
}

// ---------------------------------------------------------------- физика

/**
 * Быстрые проверки корпуса по суммам на префиксах (земля во время разбора
 * не меняется) и боец-призрак: методы Worm без картинки.
 */
class Physics {
  constructor(terrain, rules) {
    this.t = terrain;
    this.rules = rules;
    this.reindex();
  }

  reindex() {
    const { width: W, height: H, solid } = this.t;
    const P = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let run = 0;
      for (let x = 0; x < W; x++) {
        run += solid[y * W + x];
        P[(y + 1) * (W + 1) + x + 1] = P[y * (W + 1) + x + 1] + run;
      }
    }
    this.P = P;
  }

  /** Сколько тверди в прямоугольнике (включительно), с обрезкой как в solidInRect. */
  count(x0, y0, x1, y1) {
    const W = this.t.width, H = this.t.height;
    const ax = Math.max(0, x0), bx = Math.min(W - 1, x1), ay = Math.max(0, y0), by = Math.min(H - 1, y1);
    if (bx < ax || by < ay) return 0;
    const P = this.P, s = W + 1;
    return P[(by + 1) * s + bx + 1] - P[ay * s + bx + 1] - P[(by + 1) * s + ax] + P[ay * s + ax];
  }

  worm(x, y) {
    const phys = this;
    const hw = CFG.WORM_W >> 1;
    const w = Object.create(Worm.prototype);
    Object.assign(w, {
      scene: { rules: this.rules, fx: null, time: { now: 0 } },
      terrain: this.t, x, y, vx: 0, vy: 0, alive: true, grounded: false, facing: 1,
      hang: null, zip: null, parachuting: false, health: 100, fallStartY: y, jumping: false,
    });
    w._syncView = () => {};
    w.damage = () => {};
    w.foldChute = () => {};
    w._drown = function () { this.alive = false; };
    w.bodyClear = (cx, cy) => {
      const X = Math.round(cx), Y = Math.round(cy);
      return phys.count(X - hw + 2, Y - CFG.WORM_H + 1, X + hw - 2, Y) === 0;
    };
    w.rectClear = w.bodyClear;
    w.supported = (cx, cy) => {
      const X = Math.round(cx), Y = Math.round(cy) + 1;
      return Y >= 0 && Y < phys.t.height && phys.count(X - hw + 2, Y, X + hw - 2, Y) > 0;
    };
    return w;
  }
}

// ------------------------------------------------------------- разбор карты

export const BODY = { hw: (CFG.WORM_W >> 1) - 2, h: CFG.WORM_H };   // половина ширины без центра, рост
export const MARGIN = { x: 3, y: 6 };     // запас: «впритык» — меньше этого
export const GAP_VISIBLE = 6;             // щель уже этого — трещина, не проход

/**
 * Где помещается корпус (ноги в (x, y)) с запасом mx по бокам и my над
 * головой, и какой воздух он при этом покрывает.
 */
function configSpace(map, mx, my) {
  const { terrain: t, phys } = map;
  const W = t.width, H = t.height;
  const water = CFG.DROWN_Y;
  const hw = BODY.hw + mx, bh = BODY.h + my;
  // Корпус может стоять и за краем карты (столбцы там пустые) — поле с полями
  const pad = hw, CW = W + pad * 2;
  const C = new Uint8Array(CW * H);
  for (let y = 0; y < Math.min(H, water); y++) {
    for (let x = -pad; x < W + pad; x++) {
      if (phys.count(x - hw, y - bh + 1, x + hw, y) === 0) C[y * CW + x + pad] = 1;
    }
  }
  // Покрытый воздух: есть положение корпуса, задевающее пиксель
  const s = CW + 1;
  const PC = new Int32Array(s * (H + 1));
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x < CW; x++) { run += C[y * CW + x]; PC[(y + 1) * s + x + 1] = PC[y * s + x + 1] + run; }
  }
  const cnt = (x0, y0, x1, y1) => {
    const ax = Math.max(0, x0 + pad), bx = Math.min(CW - 1, x1 + pad), ay = Math.max(0, y0), by = Math.min(H - 1, y1);
    if (bx < ax || by < ay) return 0;
    return PC[(by + 1) * s + bx + 1] - PC[ay * s + bx + 1] - PC[(by + 1) * s + ax] + PC[ay * s + ax];
  };
  const covered = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (t.solid[y * W + x]) continue;
      // Корпус с ногами в (cx, cy) занимает cx±hw, cy-bh+1…cy
      if (cnt(x - hw, y, x + hw, y + bh - 1) > 0) covered[y * W + x] = 1;
    }
  }
  return { covered, C, pad, CW };
}

/** Расстояние от воздуха до тверди (фаска 3-4, в пикселях). */
function distance(t) {
  const W = t.width, H = t.height;
  const D = new Float32Array(W * H);
  const INF = 1e9;
  for (let i = 0; i < W * H; i++) D[i] = t.solid[i] ? 0 : INF;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!D[i]) continue;
    let d = D[i];
    if (x > 0) d = Math.min(d, D[i - 1] + 3);
    if (y > 0) {
      d = Math.min(d, D[i - W] + 3);
      if (x > 0) d = Math.min(d, D[i - W - 1] + 4);
      if (x < W - 1) d = Math.min(d, D[i - W + 1] + 4);
    }
    D[i] = d;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (!D[i]) continue;
    let d = D[i];
    if (x < W - 1) d = Math.min(d, D[i + 1] + 3);
    if (y < H - 1) {
      d = Math.min(d, D[i + W] + 3);
      if (x < W - 1) d = Math.min(d, D[i + W + 1] + 4);
      if (x > 0) d = Math.min(d, D[i + W - 1] + 4);
    }
    D[i] = d;
  }
  for (let i = 0; i < W * H; i++) D[i] /= 3;
  return D;
}

/**
 * Щели: связные куски «мёртвого» воздуха (корпус туда не входит), которые
 * касаются доступного воздуха в двух и более раздельных местах — сквозной
 * просвет. Ширина — диаметр самого большого круга внутри куска.
 */
function findGaps(map, D, mx, my) {
  const { terrain: t } = map;
  const W = t.width, H = t.height;
  const water = Math.min(H, CFG.DROWN_Y);
  const { covered } = configSpace(map, mx, my);
  const label = new Int32Array(W * H);
  const contact = new Int32Array(W * H);
  const gaps = [];
  let id = 0;
  const stack = [];
  for (let y0 = 0; y0 < water; y0++) {
    for (let x0 = 0; x0 < W; x0++) {
      const i0 = y0 * W + x0;
      if (t.solid[i0] || covered[i0] || label[i0]) continue;
      id++;
      label[i0] = id;
      stack.push(i0);
      const cells = [];
      const touch = [];
      let best = 0, bx = x0, by = y0, edgeTouch = false;
      while (stack.length) {
        const i = stack.pop();
        cells.push(i);
        const x = i % W, y = (i / W) | 0;
        if (D[i] > best) { best = D[i]; bx = x; by = y; }
        if (x === 0 || x === W - 1 || y === 0) edgeTouch = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= water) continue;
          const j = ny * W + nx;
          if (t.solid[j]) continue;
          if (covered[j]) { if (contact[j] !== id) { contact[j] = id; touch.push(j); } continue; }
          if (!label[j]) { label[j] = id; stack.push(j); }
        }
      }
      const width = best * 2;
      if (width < GAP_VISIBLE || touch.length < 2) continue;
      // Раздельные места касания: связность по 8 соседям среди точек касания
      const seen = new Set();
      const arcs = [];
      const inTouch = new Set(touch);
      for (const s0 of touch) {
        if (seen.has(s0)) continue;
        let n = 0;
        const q = [s0];
        seen.add(s0);
        let ax = 0, ay = 0;
        while (q.length) {
          const i = q.pop();
          n++;
          ax += i % W; ay += (i / W) | 0;
          const x = i % W, y = (i / W) | 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const j = (y + dy) * W + x + dx;
            if (inTouch.has(j) && !seen.has(j)) { seen.add(j); q.push(j); }
          }
        }
        if (n >= 3) arcs.push({ n, x: ax / n, y: ay / n });
      }
      if (arcs.length < 2) continue;
      // Насколько далеко разнесены касания: сквозной просвет, а не выемка
      let span = 0;
      for (let a = 0; a < arcs.length; a++) for (let b = a + 1; b < arcs.length; b++) {
        span = Math.max(span, Math.hypot(arcs[a].x - arcs[b].x, arcs[a].y - arcs[b].y));
      }
      let minx = W, maxx = 0, miny = H, maxy = 0;
      for (const i of cells) {
        const x = i % W, y = (i / W) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      gaps.push({ x: bx, y: by, width: Math.round(width * 10) / 10, area: cells.length, span: Math.round(span),
        box: [minx, miny, maxx, maxy], edge: edgeTouch, cells });
    }
  }
  return gaps;
}

/**
 * Граф стояний: где боец стоит, куда попадает шагом, прыжком, падением и
 * тросом. Тросом — из точек через ROPE_STEP по полу и с каждого места, где
 * повис; лучи веером через ROPE_DEG.
 */
const ROPE_STEP = 12;
const ROPE_DEG = 6;
const JUMP_STEP = 3;
const SEALED_FLOOR = 300;
const HANG_Q = 6;
const DT = 1 / 60;

function graph(map, { rope }) {
  const { terrain: t, phys } = map;
  const W = t.width;
  // Стояние — с точностью до пикселя; висение — до HANG_Q (их много, и
  // соседние ведут в одно и то же). Точное место висения — в rep
  const rep = new Map();
  const key = (x, y, hang = 0) => {
    const q = hang ? HANG_Q : 1;
    const k = ((Math.round(y / q) * q + 64) * (W + 256) + Math.round(x / q) * q + 128) * 2 + hang;
    if (hang && !rep.has(k)) rep.set(k, { x, y, hang: 1 });
    return k;
  };
  const unkey = (k) => {
    if (rep.has(k)) return rep.get(k);
    const hang = k & 1, r = k >> 1;
    return { x: (r % (W + 256)) - 128, y: Math.floor(r / (W + 256)) - 64, hang };
  };
  const w = phys.worm(0, 0);
  const DEAD = -1;

  /** Досчитать полёт/скольжение до покоя: ключ стоянки, висения или DEAD. */
  const settle = () => {
    for (let f = 0; f < 900; f++) {
      if (!w.alive || w.y > CFG.DROWN_Y || w.y > t.height + 40) return DEAD;
      if (w.hang) return key(w.x, w.y, 1);
      if (w.grounded && w.vx === 0) {
        if (!w.supported(w.x, w.y)) { w.grounded = false; w.fallStartY = w.y; }
        else return key(w.x, w.y);
      }
      w.update(DT);
    }
    return DEAD;
  };
  const place = (x, y, hang) => {
    Object.assign(w, { x, y, vx: 0, vy: 0, alive: true, zip: null, hang: hang ? (w._hangSide(x, y) ?? 'ceil') : null,
      grounded: !hang, jumping: false, parachuting: false, fallStartY: y });
  };
  /** Шаг ходьбы на пиксель, как Worm.walk. */
  const walkStep = (x, y, dir) => {
    place(x, y, false);
    const nx = x + dir;
    const ny = w.footYAt(nx, y);
    if (ny === null) { w.x = nx; w.grounded = false; return settle(); }
    if (!w.bodyClear(nx, ny)) return null;
    return key(nx, ny);
  };
  const jump = (x, y, dir, hang) => {
    place(x, y, hang);
    w.facing = dir;
    if (hang) w.letGo(); else w.jump(dir);
    return settle();
  };
  const drop = (x, y, dir) => { place(x, y, true); w.dropFromHang(dir); return settle(); };
  const zip = (x, y, hang, ang) => {
    place(x, y, hang);
    const ox = w.x, oy = w.centerY;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const ray = t.raycast(ox, oy, ox + dx * CFG.HOOK_RANGE, oy + dy * CFG.HOOK_RANGE);
    if (!ray.hit || Math.hypot(ray.x - ox, ray.y - oy) < CFG.HOOK_MIN) return null;
    w.startZip(ray.x, ray.y);
    while (w._zipMove(40)) { /* до упора */ }
    w.zip = null;
    w.vx = 0; w.vy = 0;
    if (w.supported(w.x, w.y)) { w.grounded = true; w.hang = null; } else { w.hang = w._hangSide(); w.grounded = false; }
    return settle();
  };
  const angles = [];
  for (let a = -180; a <= 0; a += ROPE_DEG) angles.push((a * Math.PI) / 180);
  for (const a of [20, 45, 135, 160]) angles.push((a * Math.PI) / 180);

  const edges = new Map();     // ключ -> [ключи]
  const explore = (k) => {
    const { x, y, hang } = unkey(k);
    const out = [];
    const add = (v) => { if (v !== null && v !== undefined) out.push(v); };
    if (hang) {
      add(jump(x, y, 1, true));
      add(drop(x, y, 1)); add(drop(x, y, -1));
    } else {
      const right = walkStep(x, y, 1), left = walkStep(x, y, -1);
      add(right); add(left);
      // Прыжок — с каждого JUMP_STEP-го пикселя и там, где ходьба упирается
      if (x % JUMP_STEP === 0 || right === null || left === null) {
        add(jump(x, y, 1, false)); add(jump(x, y, -1, false));
      }
    }
    if (rope && (hang || x % ROPE_STEP === 0)) for (const a of angles) add(zip(x, y, hang, a));
    edges.set(k, out);
    return out;
  };
  const snap = (x, y) => {
    place(x, y, false);
    w.grounded = false;
    w.snapToGround();
    const s = settle();
    return s;
  };
  return { key, unkey, explore, edges, DEAD, snap };
}

/**
 * Достижимость от стартов: прямой обход, затем обратный от стартов —
 * что достижимо, но назад не ведёт, то ловушка.
 */
function reach(map, { rope }) {
  const g = graph(map, { rope });
  const starts = map.spawns.map((s) => g.snap(s.x, s.y));
  const seen = new Set();
  const order = [];
  const q = starts.filter((k) => k !== g.DEAD);
  for (const k of q) seen.add(k);
  while (q.length) {
    const k = q.pop();
    order.push(k);
    for (const v of g.explore(k)) {
      if (v === g.DEAD || seen.has(v)) continue;
      seen.add(v); q.push(v);
    }
  }
  const rev = new Map();
  for (const [k, out] of g.edges) for (const v of out) {
    if (v === g.DEAD) continue;
    if (!rev.has(v)) rev.set(v, []);
    rev.get(v).push(k);
  }
  // Кто откуда достижим: по старту — свой обход вперёд
  const fwdFrom = (s) => {
    const seenS = new Set([s]);
    const qq = [s];
    while (qq.length) { const k = qq.pop(); for (const v of g.edges.get(k) ?? []) if (v !== g.DEAD && !seenS.has(v)) { seenS.add(v); qq.push(v); } }
    return seenS;
  };
  const back = new Set();
  const qb = starts.filter((k) => k !== g.DEAD);
  for (const k of qb) back.add(k);
  while (qb.length) { const k = qb.pop(); for (const v of rev.get(k) ?? []) if (!back.has(v)) { back.add(v); qb.push(v); } }
  const trapped = [...seen].filter((k) => !back.has(k)).map(g.unkey);
  // Ловушки по местам: соседние по ходьбе стояния — одно место
  const traps = groupSpots(trapped);
  const fwd = starts.map((s) => (s === g.DEAD ? new Set() : fwdFrom(s)));
  // Заперт старт: оттуда не выбраться — доступного пола меньше SEALED_FLOOR
  // (карман). Разрыв: кто-то из стартов не доходит до другого — на башне
  // тросом это бывает и от выборки лучей (верхний камень без зацепа),
  // поэтому отдельно и только для сведения
  const sealed = [];
  let split = 0;
  starts.forEach((s, i) => {
    const sp = map.spawns[i];
    const cant = starts.filter((o, j) => j !== i && (s === g.DEAD || !fwd[i].has(o))).length;
    const floor = new Set([...fwd[i]].map((k) => g.unkey(k)).filter((p) => !p.hang).map((p) => `${p.x},${p.y}`)).size;
    if (cant) split++;
    if (s === g.DEAD) sealed.push({ ...sp, why: 'не встать' });
    else if (cant > 0 && floor < SEALED_FLOOR) sealed.push({ ...sp, why: `карман: ${floor} px пола`, floor });
  });
  return { nodes: seen.size, traps, sealed, split: split > 0, starts, reachable: seen, g, fwd };
}

function groupSpots(list) {
  const set = new Map(list.map((p) => [`${p.x},${p.y},${p.hang}`, p]));
  const done = new Set();
  const out = [];
  for (const p of list) {
    const k0 = `${p.x},${p.y},${p.hang}`;
    if (done.has(k0)) continue;
    const q = [p]; done.add(k0);
    const grp = [];
    while (q.length) {
      const a = q.pop();
      grp.push(a);
      for (let dx = -3; dx <= 3; dx++) for (let dy = -8; dy <= 8; dy++) {
        const k = `${a.x + dx},${a.y + dy},${a.hang}`;
        if (set.has(k) && !done.has(k)) { done.add(k); q.push(set.get(k)); }
      }
    }
    const xs = grp.map((a) => a.x), ys = grp.map((a) => a.y);
    out.push({ x: Math.round(xs.reduce((s, v) => s + v, 0) / grp.length), y: Math.round(ys.reduce((s, v) => s + v, 0) / grp.length),
      size: grp.length, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  return out;
}

/**
 * Старты в закрытом кармане: корпус бойца, двигаясь как угодно (без
 * тяжести, тросом, прыжком — всё равно), не выходит из него к небу.
 * Дёшево и без выборки лучей — годится и для быстрого теста.
 */
function closed(map) {
  const { terrain: t } = map;
  const H = t.height;
  const { C, pad, CW } = configSpace(map, 0, 0);
  const out = [];
  for (const sp of map.spawns) {
    const x0 = Math.round(sp.x), y0 = Math.round(sp.y);
    let i0 = y0 * CW + x0 + pad;
    // Стоит чуть выше или ниже — ищем ближайшее свободное положение
    for (let d = 1; !C[i0] && d < 8; d++) if (C[i0 - d * CW]) i0 -= d * CW;
    if (!C[i0]) { out.push({ ...sp, why: 'корпус не помещается' }); continue; }
    const seen = new Uint8Array(CW * H);
    const stack = [i0];
    seen[i0] = 1;
    let open = false, n = 0;
    while (stack.length && !open) {
      const i = stack.pop();
      n++;
      if (i < CW * 2) { open = true; break; }
      // Вверх кладём последним — берётся первым: к небу идём напрямик
      for (const j of [i + CW, i - 1, i + 1, i - CW]) {
        if (j < 0 || j >= C.length || seen[j] || !C[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (!open) out.push({ ...sp, why: `закрытый карман (${n} положений)` });
  }
  return out;
}

/** Для отладочных картинок: щели с клетками и обходы от каждого старта. */
export function debugGaps(map) {
  const D = distance(map.terrain);
  const hard = findGaps(map, D, 0, 0);
  const soft = findGaps(map, D, MARGIN.x, MARGIN.y);
  const hardCells = new Set();
  for (const g of hard) for (const i of g.cells) hardCells.add(i);
  return { hard, tight: soft.filter((g) => !g.cells.some((i) => hardCells.has(i))) };
}
export function debugReach(map) {
  const r = reach(map, { rope: map.hook });
  return { ...r, fwd: r.fwd };
}

/** Полный разбор одной карты. */
export function analyze(map, { traps = true } = {}) {
  const D = distance(map.terrain);
  const hard = findGaps(map, D, 0, 0);
  const soft = findGaps(map, D, MARGIN.x, MARGIN.y);
  // «Впритык» — щели с запасом, которых нет среди глухих
  const hardCells = new Set();
  for (const g of hard) for (const i of g.cells) hardCells.add(i);
  const tight = soft.filter((g) => !g.cells.some((i) => hardCells.has(i)));
  const res = { gaps: hard, tight, traps: [], sealed: closed(map), split: false, nodes: 0 };
  if (traps) {
    const r = reach(map, { rope: map.hook });
    res.traps = r.traps.filter((p) => p.size >= 4);
    for (const s of r.sealed) if (!res.sealed.some((q) => q.x === s.x && q.y === s.y)) res.sealed.push(s);
    res.split = r.split;
    res.nodes = r.nodes;
  }
  for (const g of [...res.gaps, ...res.tight]) delete g.cells;
  return res;
}

// --------------------------------------------------------------- картинки

function png(w, h, rgb) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Вырезка карты вокруг (cx, cy) в масштабе k: земля серая, вода синяя,
 * щель красная, рядом — корпус бойца зелёной рамкой для сравнения.
 */
export function render(map, file, { cx, cy, half = 90, k = 3, marks = [], gaps = [] }) {
  const t = map.terrain;
  const W = t.width;
  const x0 = Math.round(cx - half), y0 = Math.round(cy - half), n = half * 2;
  const red = new Set();
  for (const g of gaps) for (const i of g.cells ?? []) red.add(i);
  const img = Buffer.alloc(n * k * n * k * 3);
  const put = (px, py, c) => {
    if (px < 0 || py < 0 || px >= n * k || py >= n * k) return;
    const o = (py * n * k + px) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const wx = x0 + x, wy = y0 + y;
    const i = wy * W + wx;
    let c = [214, 232, 246];
    if (wx < 0 || wx >= W || wy < 0 || wy >= t.height) c = [180, 180, 190];
    else if (t.solid[i]) c = [96, 86, 74];
    else if (red.has(i)) c = [235, 40, 40];
    else if (wy > CFG.WATER_Y) c = [70, 120, 200];
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) put(x * k + b, y * k + a, c);
  }
  for (const m of marks) {
    const hw = BODY.hw;
    const bx0 = (Math.round(m.x) - hw - x0) * k, bx1 = (Math.round(m.x) + hw + 1 - x0) * k;
    const by0 = (Math.round(m.y) - BODY.h + 1 - y0) * k, by1 = (Math.round(m.y) + 1 - y0) * k;
    const col = m.color ?? [20, 170, 60];
    for (let x = bx0; x < bx1; x++) for (let d = 0; d < 2; d++) { put(x, by0 + d, col); put(x, by1 - 1 - d, col); }
    for (let y = by0; y < by1; y++) for (let d = 0; d < 2; d++) { put(bx0 + d, y, col); put(bx1 - 1 - d, y, col); }
  }
  writeFileSync(file, png(n * k, n * k, img));
}

/** Ближайшее к точке место, где боец стоит, — для рамки «вот его размер». */
export function nearestStand(map, x, y) {
  const { phys, terrain: t } = map;
  const w = phys.worm(0, 0);
  let best = null, bd = Infinity;
  for (let yy = Math.max(32, y - 90); yy < Math.min(t.height - 1, y + 90); yy++) {
    for (let xx = Math.max(12, x - 90); xx < Math.min(t.width - 12, x + 90); xx++) {
      if (!w.bodyClear(xx, yy) || !w.supported(xx, yy)) continue;
      const d = Math.hypot(xx - x, yy - y);
      if (d < bd) { bd = d; best = { x: xx, y: yy }; }
    }
  }
  return best;
}

// -------------------------------------------------------------- набор карт

/** Все карты, которые проверяем: вид — список {group, label, match, seed}. */
export function catalog(seeds = 200) {
  const out = [];
  const base = M.towerMatch('fighter');
  for (const v of TOWER_VARIANTS) {
    for (let i = 0; i < seeds; i++) {
      const seed = 100000 + i * 7919;
      out.push({ group: `tower:${v.id}`, label: `${v.id} #${seed}`, match: { ...base, variant: v.id }, seed });
    }
  }
  for (const a of ASCENT) out.push({ group: 'ascent', label: `${a.id} (${a.seed})`, match: M.ascentMatch(a.id), seed: a.seed });
  for (const c of CHALLENGES) out.push({ group: 'challenge', label: `${c.id} (${c.seed})`, match: M.challengeMatch(c.id), seed: c.seed });
  // Башня дня: 60 дней подряд
  const d0 = Date.UTC(2026, 9, 1);
  for (let i = 0; i < Math.max(10, Math.round(seeds * 0.3)); i++) {
    const day = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
    const m = M.dailyMatch(day);
    out.push({ group: 'daily', label: `${day} (${m.seed})`, match: m, seed: m.seed });
  }
  // Широкие карты: формы быстрой игры и миссии кампании
  for (const s of SHAPES.filter((x) => !x.hidden)) {
    for (let i = 0; i < Math.max(5, Math.round(seeds * 0.15)); i++) {
      const seed = 500000 + i * 104729;
      out.push({ group: `classic:${s.id}`, label: `${s.id} #${seed}`, match: M.quickMatch(null, { shape: s.id }), seed });
    }
  }
  for (const m of MISSIONS) out.push({ group: 'campaign', label: `${m.id} (${m.seed})`, match: M.campaignMatch(m.id), seed: m.seed });
  return out;
}

// --------------------------------------------------------------------- CLI

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1];
}

async function main() {
  const seeds = Number(arg('seeds', 200));
  const only = arg('only', '')?.split(',').filter(Boolean) ?? [];
  const renderDir = arg('render', null);
  const jsonOut = arg('json', null);
  const noTraps = process.argv.includes('--no-traps');
  const shard = arg('shard', '0/1').split('/').map(Number);
  let list = catalog(seeds).filter((e) => !only.length || only.some((o) => e.group.startsWith(o)));
  list = list.filter((_, i) => i % shard[1] === shard[0]);
  if (renderDir) mkdirSync(renderDir, { recursive: true });
  const groups = new Map();
  const rows = [];
  const t0 = Date.now();
  let rendered = 0;
  for (const [n, e] of list.entries()) {
    if (n % 20 === 0) process.stderr.write(`${n}/${list.length} ${Math.round((Date.now() - t0) / 1000)} с\n`);
    const map = buildMap(e.match, e.seed);
    const res = analyze(map, { traps: !noTraps });
    const g = groups.get(e.group) ?? { maps: 0, withGap: 0, gaps: 0, withTight: 0, tight: 0, withTrap: 0, traps: 0, sealed: 0, split: 0, examples: [] };
    groups.set(e.group, g);
    g.maps++;
    if (res.gaps.length) g.withGap++;
    g.gaps += res.gaps.length;
    if (res.tight.length) g.withTight++;
    g.tight += res.tight.length;
    if (res.traps.length) g.withTrap++;
    g.traps += res.traps.length;
    g.sealed += res.sealed.length;
    if (res.split) g.split++;
    const bad = res.gaps.length || res.traps.length || res.sealed.length;
    if (bad && g.examples.length < 6) {
      g.examples.push(`${e.label}: ${[
        ...res.gaps.slice(0, 3).map((q) => `щель ${q.width}px @${q.x},${q.y}`),
        ...res.traps.slice(0, 2).map((q) => `ловушка @${q.x},${q.y} (${q.size})`),
        ...res.sealed.slice(0, 2).map((q) => `заперт старт @${Math.round(q.x)},${Math.round(q.y)} ${q.why}`),
      ].join('; ')}`);
    }
    rows.push({ group: e.group, label: e.label, seed: e.seed, variant: map.variant, shape: map.shape, ...res });
    if (renderDir && rendered < 40 && (res.gaps.length || res.traps.length || res.sealed.length)) {
      // Перестроить с клетками щелей — для картинки
      const D = distance(map.terrain);
      const gaps = findGaps(map, D, 0, 0);
      const at = gaps[0] ?? res.traps[0] ?? res.sealed[0];
      const stand = nearestStand(map, Math.round(at.x), Math.round(at.y));
      const file = join(renderDir, `${e.group.replace(':', '-')}-${e.seed}-${Math.round(at.x)}x${Math.round(at.y)}.png`);
      render(map, file, { cx: at.x, cy: at.y, gaps, marks: stand ? [stand] : [] });
      rendered++;
    }
  }
  console.log(`карт: ${list.length}, ${Math.round((Date.now() - t0) / 1000)} с`);
  console.log('группа'.padEnd(22), 'карт', 'со щелью', 'щелей', 'впритык', 'с ловушкой', 'запертых стартов', 'разрыв');
  for (const [name, g] of groups) {
    console.log(name.padEnd(22), String(g.maps).padStart(4), String(g.withGap).padStart(8), String(g.gaps).padStart(6),
      String(g.withTight).padStart(7), String(g.withTrap).padStart(10), String(g.sealed).padStart(16), String(g.split).padStart(6));
  }
  for (const [name, g] of groups) {
    if (!g.examples.length) continue;
    console.log(`\n${name}:`);
    for (const s of g.examples) console.log(`  ${s}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ groups: Object.fromEntries(groups), rows }, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
