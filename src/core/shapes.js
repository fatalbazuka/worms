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
        // Ход к соседней полости
        if (i > 0 && rng() < 0.6) {
          ctx.lineWidth = 26 + rng() * 10;
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

      // Плита с неровными краями. Верх волнистый, но пологий: по нему ходят
      // (подъём за шаг не выше STEP_UP), низ — грубее.
      const slab = (x0, x1, yTop, thick) => {
        const f1 = r(0.018, 0.03), f2 = r(0.05, 0.08), p1 = r(0, 6.3), p2 = r(0, 6.3);
        const top = [], bottom = [];
        for (let x = x0; x <= x1; x += 8) {
          const edge = Math.min(1, Math.min(x - x0, x1 - x) / 34);
          const k = edge * edge * (3 - 2 * edge);           // к краям плита сходит на клин
          const wave = Math.sin(x * f1 + p1) * 6 + Math.sin(x * f2 + p2) * 2;
          const mid = yTop + thick / 2;
          top.push([x, mid - (thick / 2 - wave) * k - 3]);
          bottom.push([x, mid + (thick / 2 + Math.sin(x * f2 * 1.7 + p1) * 7) * k + 3]);
        }
        ctx.beginPath();
        ctx.moveTo(top[0][0], top[0][1]);
        for (const [x, y] of top) ctx.lineTo(x, y);
        for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1]);
        ctx.closePath();
        ctx.fill();
      };
      // Столбик: сверху вниз от потолка (сталактит) или снизу вверх от пола
      const spike = (x, y0, y1, w) => {
        ctx.beginPath();
        ctx.moveTo(x - w / 2, y0);
        ctx.lineTo(x + w / 2, y0);
        ctx.lineTo(x + w * 0.28, y1);
        ctx.quadraticCurveTo(x, y1 + Math.sign(y1 - y0) * 12, x - w * 0.28, y1);
        ctx.closePath();
        ctx.fill();
      };

      // Основание — остров: края уходят под воду
      const baseY = H - 245;
      const f = r(0.006, 0.011), ph = r(0, 6.3);
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 6) {
        const e = Math.min(1, Math.min(x, W - x) / 90);
        const k = e * e * (3 - 2 * e);
        const y = baseY + Math.sin(x * f + ph) * 26 + Math.sin(x * 0.031 + ph * 2) * 7;
        ctx.lineTo(x, y + (CFG.WATER_Y + 50 - y) * (1 - k));
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();

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
          // Полочки у краёв — не всегда: за них цепляются и с них сбивают
          if (rng() < 0.6) { const w = r(84, 110); slab(12, 12 + w, y + r(-30, 30), thick * 0.8); parts.push([12, 12 + w]); }
          if (rng() < 0.6) { const w = r(84, 110); slab(W - 12 - w, W - 12, y + r(-30, 30), thick * 0.8); parts.push([W - 12 - w, W - 12]); }
          floors.push({ y, thick, parts });
        }
      }
      // Сталактиты под плитами (укрытие и зацеп) и пара столбиков на полу
      for (const fl of floors) {
        for (const [x0, x1] of fl.parts) {
          if (x1 - x0 < 200 || rng() < 0.45) continue;
          spike(r(x0 + 60, x1 - 60), fl.y + fl.thick - 6, fl.y + fl.thick + r(55, 95), r(40, 58));
        }
      }
      for (let i = 0; i < 2; i++) {
        const x = r(120, W - 120);
        spike(x, baseY + 30, baseY - r(45, 75), r(46, 64));
      }
    },
  },
];

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
  { id: 'classic', name: 'Башня', weight: 2, biome: null, rules: {}, intro: null },
  {
    id: 'ice', name: 'Ледяная башня', weight: 1, biome: 'snow',
    rules: { groundFriction: 0.9, landKeep: 0.85 },
    intro: 'Ледяная башня: скользко — от взрыва катишься далеко',
  },
  {
    id: 'lava', name: 'Лавовая башня', weight: 1, biome: 'hell',
    rules: { flood: { after: 5, step: 90 }, liquid: 'lava' },
    intro: 'Лавовая башня: лава пойдёт вверх уже с 6-го хода',
  },
  {
    id: 'wind', name: 'Ветреная башня', weight: 1, biome: 'desert',
    rules: { windRange: [170, 300] },
    intro: 'Ветреная башня: сильный ветер, бей с поправкой',
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
