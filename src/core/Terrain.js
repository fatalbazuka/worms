import { CFG } from '../config.js';
import { makeNoise1D } from './rng.js';
import { planDetails, paintDetails } from './terrainDetails.js';

/** Ширина одного чанка видимой текстуры (см. this.chunks). */
const CHUNK_W = 640;

/**
 * Разрушаемый ландшафт.
 *
 * Источник истины по геометрии — offscreen canvas `maskCanvas`:
 * непрозрачный пиксель = твердь. Взрыв стирает круг через
 * globalCompositeOperation = 'destination-out'.
 *
 * Параллельно с маской ведётся зеркальный Uint8Array `solid` — это чисто
 * оптимизация чтения: getImageData на каждый пиксельный запрос физики
 * съел бы весь кадр. Массив обновляется теми же операциями, что и канвас.
 *
 * Висящие в воздухе куски после взрыва НЕ падают — как в оригинале.
 */
export class Terrain {
  constructor(width, height, biome, rng) {
    this.width = width;
    this.height = height;
    this.biome = biome;
    this.rng = rng;

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });

    // Видимая текстура нарезана на вертикальные чанки: после взрыва в GPU
    // заливается только задетый кусок, а не все 3200x720 (важно для мобилок).
    this.chunkW = CHUNK_W;
    this.chunks = [];
    for (let x0 = 0; x0 < width; x0 += CHUNK_W) {
      const w = Math.min(CHUNK_W, width - x0);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = height;
      this.chunks.push({ x0, w, canvas, ctx: canvas.getContext('2d'), pattern: null });
    }
    this.dirtyChunks = new Set();

    this.solid = new Uint8Array(width * height);
    this.surface = new Float32Array(width); // y поверхности на момент генерации
  }

  /** Чанки, пересекающие горизонтальный интервал [x0, x1]. */
  _chunksIn(x0, x1) {
    const a = Math.max(0, Math.floor(x0 / this.chunkW));
    const b = Math.min(this.chunks.length - 1, Math.floor(x1 / this.chunkW));
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }

  // ---------------------------------------------------------------- генерация

  /**
   * @param shape  форма карты (core/shapes.js) или null — обычный остров
   * @param srng   генератор формы: свой поток, основной не трогается
   */
  generate(shape = null, srng = null) {
    const { width: w, height: h, rng } = this;
    const gen = this.biome.gen;

    // Форма рисует карту сама (башня): профиля поверхности у неё нет,
    // «верхов» в каждом столбце несколько — по этажу на каждый
    if (shape?.build && srng) {
      shape.build(this, srng);
      if (this.walls) this._addWalls();
      this._syncSolidFromMask();
      this._findTops();
      this._paintTexture();
      return;
    }

    // Фазы синусоид — свои на каждой карте
    const phases = gen.octaves.map(() => rng() * Math.PI * 2);
    const noise = makeNoise1D(rng, w, gen.noiseCell);

    for (let x = 0; x < w; x++) {
      let hh = gen.baseH;
      for (let i = 0; i < gen.octaves.length; i++) {
        const [freq, amp] = gen.octaves[i];
        hh += Math.sin(x * freq + phases[i]) * amp;
      }
      hh += noise(x) * gen.noiseAmp;
      hh *= islandWindow(x / w, gen.edge); // края уходят под воду -> остров
      this.surface[x] = CFG.GROUND_BASE - hh;
    }
    if (shape?.profile && srng) shape.profile(this.surface, { rng: srng, width: w, height: h });

    this._paintMask();
    if (gen.caves > 0) this._carveCaves(gen.caves);
    if (shape?.carve && srng) shape.carve(this, srng);
    this._syncSolidFromMask();
    this._paintTexture();
  }

  /**
   * Каменные стены по краям башни (Ледник, Жерло): видимый край вместо
   * невидимого. Неровные, без ГПСЧ — у обоих игроков одинаковые; за них
   * цепляется трос, взрыв выгрызает в них дыры.
   */
  _addWalls() {
    const ctx = this.maskCtx, w = this.width, h = this.height;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    for (const side of [0, 1]) {
      ctx.beginPath();
      ctx.moveTo(side ? w : 0, 0);
      for (let y = 0; y <= h; y += 8) {
        const d = wallEdge(y, side);
        ctx.lineTo(side ? w - d : d, y);
      }
      ctx.lineTo(side ? w : 0, h);
      ctx.closePath();
      ctx.fill();
    }
  }

  _paintMask() {
    const ctx = this.maskCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, this.height);
    for (let x = 0; x < this.width; x++) ctx.lineTo(x, Math.round(this.surface[x]));
    ctx.lineTo(this.width, this.height);
    ctx.closePath();
    ctx.fill();
  }

  _carveCaves(count) {
    const ctx = this.maskCtx;
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(this.width * 0.18, this.width * 0.82);
      const top = this.surface[Math.floor(x)];
      const y = this.rng.range(top + 70, Math.min(this.height - 40, top + 210));
      const rx = this.rng.range(45, 110);
      const ry = this.rng.range(24, 55);
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, this.rng.range(-0.4, 0.4), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Все «верхи» в каждом столбце: где сверху вниз воздух сменяется землёй.
   * Нужны многоэтажной карте — трава рисуется на каждом этаже, а не только
   * на самой верхней кромке. Вместе с верхом запоминается толщина земли
   * под ним: полоса травы не должна свисать ниже тонкой плиты.
   */
  _findTops() {
    const { width: w, height: h, solid } = this;
    this.tops = new Array(w);
    for (let x = 0; x < w; x++) {
      const list = [];
      let prev = 0, start = -1;
      for (let y = 0; y < h; y++) {
        const v = solid[y * w + x];
        if (v && !prev) start = y;
        if (!v && prev && start >= 0) { list.push([start, y - start]); start = -1; }
        prev = v;
      }
      if (prev && start >= 0) list.push([start, h - start]);
      this.tops[x] = list;
      this.surface[x] = list.length ? list[0][0] : h;
    }
  }

  /** Полная перезапись solid[] из маски. Дорого — только при генерации. */
  _syncSolidFromMask() {
    const img = this.maskCtx.getImageData(0, 0, this.width, this.height).data;
    const solid = this.solid;
    for (let i = 0, p = 3; i < solid.length; i++, p += 4) {
      solid[i] = img[p] > 8 ? 1 : 0;
    }
  }

  /**
   * Подключить текстуры темы: тайл земли и полосу верхнего слоя.
   * Вызывается до generate(); если текстур нет — рисуются запасные цвета.
   */
  setTextures({ soil = null, grass = null } = {}) {
    this.soilImage = soil;
    this.grassImage = grass;
    for (const chunk of this.chunks) {
      chunk.pattern = soil ? chunk.ctx.createPattern(soil, 'repeat') : null;
    }
  }

  /**
   * Перерисовать видимую текстуру во всех чанках.
   * Внутри каждого чанка холст сдвинут так, что рисование идёт
   * в мировых координатах — формулы одни и те же для всех кусков.
   */
  _paintTexture() {
    const b = this.biome;
    const h = this.height;
    const grass = this.grassImage;
    // Насколько полоса травы выступает над линией поверхности. Держим
    // небольшим: визуальная кромка не должна заметно расходиться с той,
    // по которой считается физика, иначе игрок мажет.
    const over = grass ? Math.round(grass.height * (b.grassOver ?? 0.2)) : 0;
    // Детали места (камешки, трещины, кристаллы) — раскладка один раз
    if (this.look && this._details === undefined) this._details = planDetails(this, this.look, this.decorSeed ?? 0);

    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const ctx = chunk.ctx;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, chunk.w, h);
      ctx.setTransform(1, 0, 0, 1, -chunk.x0, 0);

      const x0 = chunk.x0, x1 = chunk.x0 + chunk.w;

      // --- тело земли ---
      if (chunk.pattern) {
        ctx.fillStyle = chunk.pattern;
      } else {
        const grad = ctx.createLinearGradient(0, CFG.GROUND_BASE - 340, 0, h);
        grad.addColorStop(0, b.fallback.fill);
        grad.addColorStop(1, b.fallback.fillDark);
        ctx.fillStyle = grad;
      }
      ctx.fillRect(x0, 0, chunk.w, h);

      // Обрезаем тело по маске
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this.maskCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';

      // Объём и контур — в стиле персонажей: снизу у плит тень, по краю
      // земли тёмная обводка. Только картинка: физика по маске не меняется
      paintDetails(ctx, this._details, x0, x1);
      this._shade(chunk);

      // --- верхний слой (трава / песок / снег) ---
      // Рисуется ПОСЛЕ обрезки, вертикальными срезами по одному пикселю:
      // так полоса точно повторяет рельеф и её кромка торчит над землёй,
      // а не срезается маской.
      if (grass) {
        const gw = grass.width, gh = grass.height;
        for (let x = x0; x < x1; x++) {
          const sx = ((x % gw) + gw) % gw;
          if (this.tops) {
            for (const [y, thick] of this.tops[x]) {
              const hh = Math.min(gh, thick + over);
              ctx.drawImage(grass, sx, 0, 1, hh, x, y - over, 1, hh);
            }
          } else {
            ctx.drawImage(grass, sx, 0, 1, gh, x, this.surface[x] - over, 1, gh);
          }
        }
      } else if (this.tops) {
        ctx.fillStyle = b.fallback.rim;
        for (let x = x0; x < x1; x++) {
          for (const [y, thick] of this.tops[x]) ctx.fillRect(x, y, 1, Math.min(14, thick));
        }
      } else {
        ctx.fillStyle = b.fallback.rim;
        ctx.beginPath();
        ctx.moveTo(x0, this.surface[x0]);
        for (let x = x0; x < x1; x++) ctx.lineTo(x, this.surface[x]);
        for (let x = x1 - 1; x >= x0; x--) ctx.lineTo(x, this.surface[x] + 14);
        ctx.closePath();
        ctx.fill();
      }

      this.dirtyChunks.add(i);
    }
  }

  // ------------------------------------------------------------- предметы

  /**
   * Впечатать предмет в землю: дерево, камень, ящик становятся частью
   * ландшафта — ловят снаряды, на них можно встать, взрыв выгрызает из них
   * куски, как из земли.
   *
   * Твердь — простой силуэт (shapes: прямоугольники и овалы в целых
   * координатах), а не альфа картинки: растр SVG в разных браузерах может
   * разойтись на пиксель, а земля у двух игроков по сети обязана совпадать.
   * Картинка рисуется поверх, в видимой текстуре, и откусывается взрывами
   * вместе с ней.
   *
   * @param shapes [{kind:'rect'|'ellipse', x, y, w, h}] — мировые координаты
   * @param image  что нарисовать (необязательно) и где: {src, x, y, w, h}
   */
  stamp(shapes, image = null) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const ctx = this.maskCtx;
    ctx.fillStyle = '#fff';
    for (const s of shapes) {
      const x = Math.round(s.x), y = Math.round(s.y), w = Math.round(s.w), h = Math.round(s.h);
      ctx.beginPath();
      if (s.kind === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(x, y, w, h);
      ctx.fill();
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    }
    // solid[] — по маске в задетом прямоугольнике
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1);
    x1 = Math.min(this.width, x1 + 1); y1 = Math.min(this.height, y1 + 1);
    if (x1 > x0 && y1 > y0) {
      const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      for (let y = y0, p = 3; y < y1; y++) {
        const row = y * this.width;
        for (let x = x0; x < x1; x++, p += 4) if (img[p] > 8) this.solid[row + x] = 1;
      }
    }
    if (image?.src) {
      for (const i of this._chunksIn(image.x, image.x + image.w)) {
        const chunk = this.chunks[i];
        chunk.ctx.setTransform(1, 0, 0, 1, -chunk.x0, 0);
        chunk.ctx.globalCompositeOperation = 'source-over';
        chunk.ctx.drawImage(image.src, image.x, image.y, image.w, image.h);
        this.dirtyChunks.add(i);
      }
    }
  }

  /**
   * Полоса маски у края: пиксели земли, у которых в (dx, dy) уже пусто
   * (или, если outside, — пустота рядом с землёй). Холст размером с чанк.
   */
  _edgeBand(chunk, offsets, outside = false) {
    const c = this._tmp ??= document.createElement('canvas');
    c.width = chunk.w; c.height = this.height;
    const t = c.getContext('2d');
    t.setTransform(1, 0, 0, 1, -chunk.x0, 0);
    if (outside) {
      // Расширенная маска минус сама маска — кольцо снаружи
      for (const [dx, dy] of offsets) t.drawImage(this.maskCanvas, dx, dy);
      t.globalCompositeOperation = 'destination-out';
      t.drawImage(this.maskCanvas, 0, 0);
    } else {
      t.drawImage(this.maskCanvas, 0, 0);
      t.globalCompositeOperation = 'destination-out';
      for (const [dx, dy] of offsets) t.drawImage(this.maskCanvas, dx, dy);
    }
    t.globalCompositeOperation = 'source-over';
    t.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  /** Залить полосу цветом и положить на чанк. */
  _paintBand(chunk, band, color, alpha) {
    const t = band.getContext('2d');
    t.globalCompositeOperation = 'source-in';
    t.fillStyle = color;
    t.fillRect(0, 0, band.width, band.height);
    t.globalCompositeOperation = 'source-over';
    const ctx = chunk.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(band, 0, 0);
    ctx.restore();
  }

  _shade(chunk) {
    const outline = this.biome.outline ?? '#1a1410';
    // Тень у нижнего края: мягкая широкая и плотная узкая
    this._paintBand(chunk, this._edgeBand(chunk, [[0, -16]]), '#000', 0.22);
    this._paintBand(chunk, this._edgeBand(chunk, [[0, -6]]), '#000', 0.25);
    // Светлый край слева и справа — лёгкий блик на гранях
    this._paintBand(chunk, this._edgeBand(chunk, [[5, 0]]), '#fff', 0.08);
    // Обводка снаружи, 3 px
    const ring = [];
    for (let a = 0; a < 16; a++) ring.push([Math.round(Math.cos((a / 16) * 6.283) * 3), Math.round(Math.sin((a / 16) * 6.283) * 3)]);
    this._paintBand(chunk, this._edgeBand(chunk, ring, true), outline, 0.9);
  }

  // ------------------------------------------------------------- разрушение

  /**
   * Вырезать круг из ландшафта.
   * Маска — destination-out, текстура — опалённая кромка + destination-out.
   */
  destroyCircle(cx, cy, radius) {
    const scorchR = radius + 7;

    for (const i of this._chunksIn(cx - scorchR, cx + scorchR)) {
      const chunk = this.chunks[i];
      const ctx = chunk.ctx;
      ctx.setTransform(1, 0, 0, 1, -chunk.x0, 0);

      // 1. Опалённая кромка: source-atop красит только по уже существующей
      // земле; поверх — тёмная обводка по краю воронки, как у всей земли
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = this.biome.scorch;
      ctx.beginPath();
      ctx.arc(cx, cy, scorchR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = this.biome.outline ?? '#1a1410';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 2. Сама воронка
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      this.dirtyChunks.add(i);
    }

    // 3. Маска — источник истины для физики
    this.maskCtx.globalCompositeOperation = 'destination-out';
    this.maskCtx.beginPath();
    this.maskCtx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.maskCtx.fill();
    this.maskCtx.globalCompositeOperation = 'source-over';

    this._clearSolidCircle(cx, cy, radius);
  }

  _clearSolidCircle(cx, cy, radius) {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const row = y * this.width;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2) this.solid[row + x] = 0;
      }
    }
  }

  // ------------------------------------------------------------ запросы

  /** Твердь ли пиксель. За пределами по бокам — «стена», сверху/снизу — пусто. */
  solidAt(x, y) {
    const ix = x | 0, iy = y | 0;
    if (ix < 0 || ix >= this.width) return false;
    if (iy < 0 || iy >= this.height) return false;
    return this.solid[iy * this.width + ix] === 1;
  }

  /** Есть ли твердь в горизонтальном отрезке строки y. */
  solidInRow(x0, x1, y) {
    const iy = y | 0;
    if (iy < 0 || iy >= this.height) return false;
    const a = Math.max(0, x0 | 0);
    const b = Math.min(this.width - 1, x1 | 0);
    const row = iy * this.width;
    for (let x = a; x <= b; x++) if (this.solid[row + x] === 1) return true;
    return false;
  }

  /** Есть ли твердь в прямоугольнике. */
  solidInRect(x0, y0, x1, y1) {
    const ax = Math.max(0, x0 | 0), bx = Math.min(this.width - 1, x1 | 0);
    const ay = Math.max(0, y0 | 0), by = Math.min(this.height - 1, y1 | 0);
    for (let y = ay; y <= by; y++) {
      const row = y * this.width;
      for (let x = ax; x <= bx; x++) if (this.solid[row + x] === 1) return true;
    }
    return false;
  }

  /** Первый твёрдый пиксель сверху вниз в столбце x. null — земли нет. */
  surfaceYAt(x, fromY = 0) {
    const ix = x | 0;
    if (ix < 0 || ix >= this.width) return null;
    for (let y = Math.max(0, fromY | 0); y < this.height; y++) {
      if (this.solid[y * this.width + ix] === 1) return y;
    }
    return null;
  }

  /**
   * Трассировка отрезка по пикселям (шаг 1px) — это и есть защита
   * от «проскока» сквозь тонкую землю внутри подшага.
   * Возвращает точку первого касания и последнюю свободную точку.
   */
  raycast(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist));
    const sx = dx / steps, sy = dy / steps;
    let px = x0, py = y0;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + sx * i;
      const y = y0 + sy * i;
      if (this.solidAt(x, y)) {
        return { hit: true, x, y, freeX: px, freeY: py };
      }
      px = x; py = y;
    }
    return { hit: false, x: x1, y: y1, freeX: x1, freeY: y1 };
  }

  /**
   * Нормаль поверхности в точке: усреднённое направление «в сторону воздуха».
   * Нужна для отскока гранаты.
   */
  normalAt(x, y, r = 4) {
    let nx = 0, ny = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (this.solidAt(x + dx, y + dy)) { nx -= dx; ny -= dy; }
      }
    }
    const len = Math.hypot(nx, ny);
    if (len < 1e-4) return { x: 0, y: -1 };
    return { x: nx / len, y: ny / len };
  }

  /**
   * Короткая свёртка геометрии — для сверки карты между игроками.
   * Считается по выборке, полного обхода 2.3 млн пикселей не нужно.
   */
  hash() {
    let h = 2166136261;
    for (let x = 0; x < this.width; x += 16) {
      const y = this.surfaceYAt(x, 0) ?? -1;
      h ^= y | 0;
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /**
   * Места, где боец может стоять, на всех этажах: [{x, y}], y — ноги.
   * Обычной карте хватает isSpawnable (одна поверхность на столбец).
   */
  standSpots(step = 8, margin = 50) {
    const out = [];
    if (!this.tops) return out;
    for (let x = margin; x < this.width - margin; x += step) {
      for (const [top] of this.tops[x]) {
        if (top < 60 || top > CFG.DROWN_Y - 70) continue;
        // Над головой должно быть свободно, под ногами — ровно: край плиты
        // и клин у её конца не годятся
        if (this.solidInRect(x - 14, top - 46, x + 14, top - 5)) continue;
        if (!this.solidAt(x - 12, top + 6) || !this.solidAt(x + 12, top + 6)) continue;
        out.push({ x, y: top - 1 });
      }
    }
    return out;
  }

  /** Свободна ли колонка сверху — для выбора точек спавна. */
  isSpawnable(x) {
    const top = this.surfaceYAt(x, 0);
    if (top === null) return false;
    if (top > CFG.DROWN_Y - 60) return false;      // слишком близко к воде
    if (this.solidInRect(x - 14, top - 40, x + 14, top - 4)) return false; // низкий потолок
    return true;
  }
}

/**
 * Толщина каменной стены башни на высоте y (side: 0 — левая, 1 — правая).
 * Нужна и генерации этажей (shapes.js): к стене либо прирастают, либо
 * оставляют просвет, в который пролезет боец.
 */
export function wallEdge(y, side) {
  const k = side * 3.1;
  return 22 + Math.sin(y / 41 + k) * 7 + Math.sin(y / 13 + k * 2) * 3;
}

/** Оконная функция острова: 1 в центре, плавно к 0 у краёв. */
function islandWindow(t, edge) {
  const e = Math.min(t, 1 - t) / edge;
  if (e >= 1) return 1;
  if (e <= 0) return 0;
  return e * e * (3 - 2 * e);
}
