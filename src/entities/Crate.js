import { CFG, DEPTH } from '../config.js';
import { has, fitScale } from '../core/assets.js';

/**
 * Ящик, сброшенный на карту.
 *
 * Спускается на парашюте с постоянной скоростью, при касании земли
 * парашют пропадает. Подбирается бойцом, который наступил на него.
 * Взрыв рядом ящик уничтожает — иначе он вечно висел бы над воронкой.
 *
 * Типы:
 *   weapon — даёт патроны случайного оружия с конечным запасом;
 *   health — лечит.
 */
export class Crate {
  /** weaponIndex — что внутри оружейного ящика (решено при сбросе); rarity — его цвет. */
  constructor(scene, x, kind, weaponIndex = null, rarity = null) {
    this.scene = scene;
    this.terrain = scene.terrain;
    this.kind = kind;
    this.weaponIndex = weaponIndex;
    this.rarity = rarity;
    this.x = x;
    this.y = -40;
    this.vy = CFG.CRATE_FALL_SPEED;
    this.alive = true;
    this.landed = false;

    this.w = CFG.CRATE_W;
    this.h = CFG.CRATE_H;

    const old = kind === 'health' ? 'crate_health' : 'crate_weapon';
    const s = scene;
    // Свой ящик, если загрузился; рисуется чуть шире своей коробки
    const key = has(s, `shot_${old}`) ? `shot_${old}` : old;
    if (has(s, key)) {
      this.view = s.add.image(x, this.y, key);
      if (key !== old) this.view.setScale(fitScale(s, key, this.w + 8));
    } else {
      this.view = s.add.rectangle(x, this.y, this.w, this.h,
        kind === 'health' ? 0xff6b6b : 0xc79a52);
      this.view.setStrokeStyle(2, 0x1a1a24, 0.8);
    }
    this.view.setOrigin(0.5, 1);
    s.rig.world(this.view.setDepth(DEPTH.WORM - 1));
    // Редкость видна издалека: обычный ящик как есть, у редкого — синяя
    // рамка, у эпического — фиолетовая, у легендарного — золотая; эпик и
    // легенда ещё и сияют
    const rc = { rare: 0x6fb7ff, epic: 0xc58bff, legendary: 0xffc23a }[rarity];
    if (rc) {
      const fw = this.w + 12, fh = this.h + 10;
      if (rarity !== 'rare') {
        this.glow = s.rig.world(s.add.circle(0, 0, this.w * 0.95, rc, 0.45).setDepth(DEPTH.WORM - 2));
        s.tweens.add({ targets: this.glow, scale: 1.3, alpha: 0.12, yoyo: true, repeat: -1, duration: 650 });
      }
      this.frame = s.rig.world(s.add.graphics().setDepth(DEPTH.WORM));
      this.frame.lineStyle(5, 0x1a1410, 0.9).strokeRoundedRect(-fw / 2, -fh, fw, fh, 7);
      this.frame.lineStyle(3, rc, 1).strokeRoundedRect(-fw / 2, -fh, fw, fh, 7);
      this.frame.fillStyle(rc, 1).fillCircle(0, -fh - 2, 5).lineStyle(2, 0x1a1410, 0.9).strokeCircle(0, -fh - 2, 5);
      this.frame.setPosition(x, this.y + 4);
    }

    const chute = has(s, 'shot_chute') ? 'shot_chute' : 'crate_chute';
    if (has(s, chute)) {
      this.chute = s.rig.world(s.add.image(x, this.y - this.h + 6, chute)
        .setOrigin(0.5, 1).setDepth(DEPTH.WORM - 2));
      if (chute === 'shot_chute') this.chute.setScale(fitScale(s, chute, 46));
    }
  }

  /** Есть ли твердь под нижней гранью. */
  _supported(cy) {
    return this.terrain.solidInRow(this.x - this.w / 2 + 2, this.x + this.w / 2 - 2, cy + 1);
  }

  update(dt) {
    if (!this.alive) return;

    if (!this.landed) {
      // Спуск равномерный: ящик на парашюте, свободного падения нет
      const step = this.vy * dt;
      const ray = this.terrain.raycast(this.x, this.y, this.x, this.y + step);
      if (ray.hit) {
        this.y = ray.freeY;
        this._land();
      } else {
        this.y += step;
        if (this.y > CFG.DROWN_Y) { this.destroy(); return; }
      }
    } else if (!this._supported(this.y)) {
      // Землю под ящиком снесло — падает дальше
      this.landed = true;
      const ray = this.terrain.raycast(this.x, this.y, this.x, this.y + this.vy * dt);
      if (ray.hit) this.y = ray.freeY;
      else {
        this.y += this.vy * dt;
        if (this.y > CFG.DROWN_Y) { this.destroy(); return; }
      }
    }

    this.view.setPosition(Math.round(this.x), Math.round(this.y));
    this.glow?.setPosition(Math.round(this.x), Math.round(this.y) - this.h / 2);
    this.frame?.setPosition(Math.round(this.x), Math.round(this.y) + 4);
    if (this.chute) this.chute.setPosition(Math.round(this.x), Math.round(this.y) - this.h);
  }

  _land() {
    this.landed = true;
    if (this.chute) { this.chute.destroy(); this.chute = null; }
  }

  /** Пересекается ли с прямоугольником бойца. */
  overlapsWorm(w) {
    return w.right >= this.x - this.w / 2 && w.left <= this.x + this.w / 2
      && w.y >= this.y - this.h && w.top <= this.y;
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.view.destroy();
    this.glow?.destroy();
    this.frame?.destroy();
    if (this.chute) this.chute.destroy();
  }
}
