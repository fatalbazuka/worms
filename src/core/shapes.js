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
];

export const SHAPE_BY_ID = Object.fromEntries(SHAPES.map((s) => [s.id, s]));

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
