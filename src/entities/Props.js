import { CFG, DEPTH } from '../config.js';
import { has } from '../core/assets.js';
import { subRng } from '../core/rng.js';

/**
 * Эмодзи на башне: фон и предметы на этажах.
 *
 * Фон — крупные эмодзи за башней (горы, солнце, облака, деревья), на
 * параллаксе, полупрозрачные. Их не трогает ничего.
 *
 * Предметы на этажах двух видов.
 *
 * Укрытия (SOLID: деревья, камни, ящики, грибы, снеговики, лёд) впечатаны
 * в саму землю (Terrain.stamp): ловят снаряды, на них можно встать, взрыв
 * выгрызает из них куски так же, как из земли. За камнем можно спрятаться,
 * но его можно и снести.
 *
 * Мелочь (трава, цветы) и бочки — отдельные предметы: бойцам не мешают,
 * взрыв рядом их ломает — лопаются осколками. Бочка ещё и взрывается сама —
 * цепочка через бочки рядом. Пол под ними снесли — падают.
 *
 * Расстановка — от зерна партии, поэтому у обоих игроков по сети она
 * одинаковая. Ломает их взрыв; у смотрящего чужой ход взрывы приходят
 * снимком (protocol.applyState → hit), и бочки там не рвутся второй раз:
 * их взрыв уже лежит в журнале ходившего.
 */

const SALT = 0x51ed;

// Наборы по виду башни: что стоит на этажах и что видно за башней
const THEMES = {
  classic: {
    props: ['tree', 'pine', 'mushroom', 'herb', 'sunflower', 'rock', 'box', 'barrel'],
    back: ['mountain', 'tree', 'pine', 'cloud', 'sun'],
  },
  wind: {
    props: ['palm', 'herb', 'rock', 'box', 'barrel', 'sunflower'],
    back: ['cloud', 'cloud', 'palm', 'mountain', 'sun'],
  },
  ice: {
    props: ['pine', 'snowman', 'ice', 'rock', 'box', 'barrel'],
    back: ['mountain', 'snowflake', 'pine', 'cloud', 'snowflake'],
  },
  lava: {
    props: ['rock', 'mushroom', 'bricks', 'box', 'barrel', 'barrel'],
    back: ['volcano', 'fire', 'mountain', 'cloud', 'volcano'],
  },
  space: {
    props: ['rock', 'gem', 'gem', 'satellite', 'rocket', 'barrel'],
    back: ['planet', 'moon', 'star', 'comet', 'ufo'],
  },
};

const SIZE = {
  tree: 84, pine: 84, palm: 88, mushroom: 52, herb: 46, sunflower: 62, rock: 52, box: 48,
  barrel: 52, snowman: 70, ice: 48, bricks: 54, gem: 50, satellite: 60, rocket: 70,
};

/**
 * Силуэт укрытия в долях размера s, от точки «низ по центру»: что из
 * картинки станет землёй. Чуть уже самой картинки — края эмодзи не держат.
 * [kind, x, y, w, h]: x от центра, y вверх от низа (отрицательный).
 */
const SILHOUETTE = {
  tree: [['rect', -0.08, -0.36, 0.16, 0.36], ['ellipse', -0.4, -0.95, 0.8, 0.66]],
  pine: [['rect', -0.07, -0.2, 0.14, 0.2], ['ellipse', -0.33, -0.95, 0.66, 0.8]],
  palm: [['rect', -0.07, -0.7, 0.14, 0.7], ['ellipse', -0.42, -0.98, 0.84, 0.36]],
  rock: [['ellipse', -0.43, -0.6, 0.86, 0.6]],
  box: [['rect', -0.38, -0.78, 0.76, 0.78]],
  ice: [['rect', -0.38, -0.78, 0.76, 0.78]],
  bricks: [['rect', -0.45, -0.62, 0.9, 0.62]],
  mushroom: [['rect', -0.13, -0.42, 0.26, 0.42], ['ellipse', -0.43, -0.9, 0.86, 0.52]],
  snowman: [['ellipse', -0.3, -0.58, 0.6, 0.58], ['ellipse', -0.21, -0.98, 0.42, 0.44]],
  gem: [['ellipse', -0.4, -0.8, 0.8, 0.8]],
};
export const SOLID = new Set(Object.keys(SILHOUETTE));

const BARREL_BLAST = { radius: 34, damageRadius: 70, damage: 30, knockback: 300, shake: 0.008 };

export class Props {
  /** painted — у места нарисованный фон: эмодзи-задник не ставим. */
  constructor(scene, seed, variantId = 'classic', { painted = false } = {}) {
    this.scene = scene;
    this.painted = painted;
    this.terrain = scene.terrain;
    this.theme = THEMES[variantId] ?? THEMES.classic;
    this.rng = subRng(seed >>> 0, SALT);
    this.items = [];
    this.backs = [];
    this.stamped = [];
    this._tick = 0;
  }

  /** Расставить всё. avoid — точки, рядом с которыми предметы не ставим. */
  build(avoid = []) {
    this._buildBack();
    this._buildProps(avoid);
    return this;
  }

  _img(name, x, y, size) {
    const key = `emoji_${name}`;
    if (!has(this.scene, key)) return null;
    const img = this.scene.add.image(x, y, key).setOrigin(0.5, 1);
    img.setScale(size / 128);
    return img;
  }

  _buildBack() {
    const r = this.rng;
    const W = this.terrain.width;
    const ground = CFG.WATER_Y;
    // Горы и деревья у подножия, облака и солнце выше — на параллаксе
    const n = 7;
    for (let i = 0; i < n; i++) {
      const name = this.theme.back[r.int(0, this.theme.back.length - 1)];
      const high = ['cloud', 'sun', 'snowflake', 'planet', 'moon', 'star', 'comet', 'ufo'].includes(name);
      const x = (W / n) * (i + 0.2 + r() * 0.6);
      const y = high ? ground - 520 - r() * 900 : ground + 10;
      const size = high ? 130 + r() * 80 : 240 + r() * 160;
      // ГПСЧ уже потрачен как обычно — предметы на этажах встанут те же
      if (this.painted) continue;
      const img = this._img(name, x, y, size);
      if (!img) continue;
      img.setAlpha(high ? 0.35 : 0.3).setTint(0xb8c4dd).setScrollFactor(0.55, 0.85)
        .setDepth(DEPTH.PARALLAX + 1);
      this.scene.rig.world(img);
      this.backs.push(img);
    }
  }

  _buildProps(avoid) {
    const spots = this.terrain.standSpots(10, 40);
    const r = this.rng;
    for (let i = spots.length - 1; i > 0; i--) {
      const j = r.int(0, i);
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const want = Math.min(14, Math.max(6, Math.round(spots.length / 14)));
    for (const p of spots) {
      const all = [...this.items, ...this.stamped];
      if (all.length >= want) break;
      if (avoid.some((a) => Math.hypot(a.x - p.x, a.y - p.y) < 56)) continue;
      if (all.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 100)) continue;
      const name = this.theme.props[r.int(0, this.theme.props.length - 1)];
      const size = SIZE[name] ?? 36;
      if (SOLID.has(name)) {
        this._stamp(name, p.x, p.y + 2, size);
        continue;
      }
      const img = this._img(name, p.x, p.y + 3, size);
      if (!img) continue;
      img.setDepth(DEPTH.WORM - 2).setFlipX(r() < 0.5);
      this.scene.rig.world(img);
      this.items.push({ name, x: p.x, y: p.y + 3, size, img, vy: 0, alive: true });
    }
  }

  /** Укрытие — в землю: силуэт твердью, картинка поверх. */
  _stamp(name, x, y, size) {
    const shapes = SILHOUETTE[name].map(([kind, sx, sy, sw, sh]) => ({
      kind, x: Math.round(x + sx * size), y: Math.round(y + sy * size),
      w: Math.round(sw * size), h: Math.round(sh * size),
    }));
    const key = `emoji_${name}`;
    const src = has(this.scene, key) ? this.scene.textures.get(key).getSourceImage() : null;
    this.terrain.stamp(shapes, src && { src, x: x - size / 2, y: y - size, w: size, h: size });
    this.stamped.push({ name, x, y, size });
  }

  /**
   * Взрыв в (x, y) радиусом r: всё, что в нём, ломается. chain — бочки
   * взрываются (кроме показа чужого хода и применения снимка).
   */
  hit(x, y, r, chain = true) {
    for (const it of this.items) {
      if (!it.alive) continue;
      if (Math.hypot(it.x - x, it.y - it.size / 2 - y) > r + it.size / 3) continue;
      this._break(it, chain);
    }
  }

  _break(it, chain) {
    it.alive = false;
    const s = this.scene;
    const { img } = it;
    // Лопается: подскок, разворот, тает — и пара осколков-копий
    s.tweens.add({
      targets: img, y: img.y - 26, angle: img.flipX ? -40 : 40, scale: img.scale * 1.25, alpha: 0,
      duration: 380, ease: 'Quad.easeOut', onComplete: () => img.destroy(),
    });
    for (let k = 0; k < 3; k++) {
      const bit = this._img(it.name, it.x, it.y - it.size / 2, it.size * 0.35);
      if (!bit) break;
      s.rig.world(bit.setDepth(DEPTH.FX).setOrigin(0.5));
      const dx = (k - 1) * 40 + (it.x % 7) * 2;
      s.tweens.add({
        targets: bit, x: bit.x + dx, y: bit.y - 30 - k * 8, angle: dx * 4, alpha: 0,
        duration: 520, ease: 'Quad.easeOut', onComplete: () => bit.destroy(),
      });
    }
    if (it.name === 'barrel' && chain && !s.replaying) {
      // Не сразу: взрыв из взрыва в том же кадре ушёл бы в рекурсию
      const { x } = it;
      const y = it.y - it.size / 2;
      s.time.delayedCall(140, () => s.explode(x, y, BARREL_BLAST, null));
      s.barrelsPending = (s.barrelsPending ?? 0) + 1;
      s.time.delayedCall(160, () => { s.barrelsPending -= 1; });
    }
  }

  /** Предмет без опоры падает; в воду — пропадает. */
  update(dt) {
    this._tick += dt;
    if (this._tick < 0.05) return;
    const step = this._tick;
    this._tick = 0;
    for (const it of this.items) {
      if (!it.alive) continue;
      const below = this.terrain.solidInRow(it.x - 6, it.x + 6, it.y);
      if (below && it.vy === 0) continue;
      it.vy = Math.min(it.vy + CFG.GRAVITY * step, 800);
      const ny = it.y + it.vy * step;
      const ray = this.terrain.raycast(it.x, it.y - 1, it.x, ny);
      if (ray.hit) { it.y = ray.freeY + 1; it.vy = 0; } else it.y = ny;
      it.img.setY(it.y);
      if (it.y > CFG.DROWN_Y) { it.alive = false; it.img.destroy(); }
    }
  }

  /** Сколько отдельных (не впечатанных) предметов цело. */
  get count() { return this.items.filter((it) => it.alive).length; }

  destroy() {
    for (const it of this.items) if (it.alive) it.img.destroy();
    for (const b of this.backs) b.destroy();
    this.items = [];
    this.backs = [];
  }
}
