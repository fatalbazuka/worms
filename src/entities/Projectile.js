import { CFG, DEPTH } from '../config.js';
import { has, rotFrame, meta, fitScale } from '../core/assets.js';

/**
 * Снаряд с самописной физикой.
 *
 * Интегрирование мелкими подшагами (CFG.SUBSTEPS на кадр), и внутри каждого
 * подшага — попиксельная трассировка отрезка по маске ландшафта. Даже очень
 * быстрый снаряд не проскочит сквозь тонкую перемычку.
 */
export class Projectile {
  constructor(scene, x, y, vx, vy, weapon, owner) {
    this.scene = scene;
    this.terrain = scene.terrain;
    this.weapon = weapon;
    this.owner = owner;

    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;

    this.alive = true;
    this.age = 0;
    this.fuseLeft = weapon.projectile.fuse || 0;
    this.digging = false;
    this.digLeft = 0;
    this.resting = false;

    // Если вылетаем из земли (боец в яме) — не считаем это попаданием,
    // пока снаряд не окажется в воздухе.
    this.insideGround = this.terrain.solidAt(x, y);
    this.ownerGrace = 0.12;

    this.trailPts = [];
    this._buildView();
  }

  _buildView() {
    const s = this.scene;
    const p = this.weapon.projectile;
    const key = this.weapon.spriteKey;
    this.sprited = Boolean(key) && has(s, key);
    // Своя картинка снаряда: одна на все повороты. Ракеты и мины смотрят
    // носом по курсу, остальное кувыркается в полёте
    const own = `shot_${this.weapon.id}`;
    if (has(s, own)) {
      this.own = true;
      this.sprited = false;
      this.pointed = ['bazooka', 'mole', 'mortar', 'airmissile'].includes(this.weapon.id);
      // Авиаракета нарисована носом вниз-вправо, остальные — вправо
      this.tilt = this.weapon.id === 'airmissile' ? -Math.PI / 4 : 0;
      const size = Math.max(14, (meta(key)?.frameWidth ?? p.radius * 4) * 1.35);
      this.view = s.add.image(this.x, this.y, own).setScale(fitScale(s, own, size));
      if (this.pointed) this.view.setRotation(Math.atan2(this.vy, this.vx) + this.tilt);
    } else if (this.sprited) {
      this.view = s.add.sprite(this.x, this.y, key);
      // rotational — кадры это 32 предрассчитанных поворота, а не анимация
      if (this.weapon.rotational) this.view.setFrame(rotFrame(this.vx, this.vy));
      else if (s.anims.exists(key)) this.view.play(key);
    } else {
      this.view = s.add.circle(this.x, this.y, p.radius, this.weapon.color);
      this.view.setStrokeStyle(2, 0x1a1a24, 0.6);
    }
    s.rig.world(this.view.setDepth(DEPTH.PROJECTILE));

    if (p.trail) {
      this.trail = s.rig.world(s.add.graphics().setDepth(DEPTH.PROJECTILE - 1));
    }
  }

  update(dt) {
    if (!this.alive) return;
    this.age += dt;
    if (this.ownerGrace > 0) this.ownerGrace -= dt;

    if (this.fuseLeft > 0) {
      this.fuseLeft -= dt;
      if (this.fuseLeft <= 0) { this.detonate(this.x, this.y); return; }
    }

    // Страховка: снаряд без фитиля и с отскоком мог бы прыгать вечно,
    // и ход не сдвинулся бы никогда. Через PROJECTILE_MAX_LIFE подрываем.
    if (this.age > CFG.PROJECTILE_MAX_LIFE) {
      this.detonate(this.x, this.y);
      return;
    }

    const sdt = dt / CFG.SUBSTEPS;
    for (let i = 0; i < CFG.SUBSTEPS && this.alive; i++) this._substep(sdt);

    if (this.alive) this._syncView();
  }

  _substep(dt) {
    const p = this.weapon.projectile;

    if (this.digging) { this._digStep(dt); return; }

    if (this.resting) {
      // Лежит на земле (граната). Если землю под ней снесли — снова падает.
      if (!this.terrain.solidInRow(this.x - p.radius, this.x + p.radius, this.y + p.radius + 1)) {
        this.resting = false;
      } else {
        return;
      }
    }

    // Интегрирование скорости: гравитация + ветер как горизонтальное ускорение
    this.vx += this.scene.wind * p.windScale * dt;
    this.vy += CFG.GRAVITY * p.gravityScale * dt;
    if (p.drag > 0) {
      const f = Math.exp(-p.drag * dt);
      this.vx *= f; this.vy *= f;
    }

    const nx = this.x + this.vx * dt;
    const ny = this.y + this.vy * dt;

    // Вылет за пределы мира
    if (nx < -80 || nx > this.terrain.width + 80 || ny > this.terrain.height + 120) {
      if (ny > CFG.WATER_Y && nx > 0 && nx < this.terrain.width) {
        this.scene.fx.splash(Math.min(Math.max(nx, 0), this.terrain.width), CFG.WATER_Y);
      }
      this.destroy();
      return;
    }
    if (ny < -3000) { this.destroy(); return; }

    // Прямое попадание в бойца — по всему отрезку, а не по его концу.
    // Землю мы и так трассируем попиксельно, а бойца проверяли одной
    // точкой: на большой скорости подшаг длиннее бойца, и снаряд проходил
    // сквозь него насквозь. Крот на полной силе улетал за цель на треть
    // экрана и рвался там.
    const wormHit = this._wormOnSegment(this.x, this.y, nx, ny);
    if (wormHit) {
      this.x = wormHit.x; this.y = wormHit.y;
      this.detonate(wormHit.x, wormHit.y);
      return;
    }

    // Попиксельная трассировка по маске
    const ray = this.terrain.raycast(this.x, this.y, nx, ny);

    if (this.insideGround) {
      // Ждём, пока снаряд покинет землю, только потом включаем коллизию
      this.x = nx; this.y = ny;
      if (!this.terrain.solidAt(nx, ny)) this.insideGround = false;
      this._pushTrail();
      return;
    }

    if (!ray.hit) {
      this.x = nx; this.y = ny;
      this._pushTrail();
      return;
    }

    // --- касание земли ---
    if (p.digRadius > 0) {
      this.digging = true;
      this.digLeft = p.digTime;
      this.x = ray.x; this.y = ray.y;
      this.scene.rig.shake(90, 0.002);
      return;
    }

    if (p.bounciness > 0) {
      this._bounce(ray, p);
      return;
    }

    this.x = ray.x; this.y = ray.y;
    this.detonate(ray.x, ray.y);
  }

  _bounce(ray, p) {
    const n = this.terrain.normalAt(ray.x, ray.y, 5);
    const vn = this.vx * n.x + this.vy * n.y;
    // Правила партии могут приглушить отскок: на тесных этажах башни
    // прыгучая граната скатывалась с плиты раньше, чем взрывалась
    const rules = this.scene.rules ?? {};
    const bounce = p.bounciness * (rules.bounce ?? 1);
    const friction = p.friction * (rules.roll ?? 1);

    // Отражение с потерей энергии + касательное трение
    let rx = this.vx - (1 + bounce) * vn * n.x;
    let ry = this.vy - (1 + bounce) * vn * n.y;
    const tvn = rx * n.x + ry * n.y;
    const tx = rx - tvn * n.x, ty = ry - tvn * n.y;
    rx = tvn * n.x + tx * friction;
    ry = tvn * n.y + ty * friction;

    this.vx = rx; this.vy = ry;
    // Отодвигаем от поверхности, чтобы не залипнуть внутри пикселя
    this.x = ray.freeX + n.x * 1.5;
    this.y = ray.freeY + n.y * 1.5;

    if (Math.hypot(this.vx, this.vy) < 42) {
      this.vx = 0; this.vy = 0;
      this.resting = true;
    }
  }

  _digStep(dt) {
    const p = this.weapon.projectile;
    this.digLeft -= dt;

    const speed = Math.hypot(this.vx, this.vy) || 1;
    const step = Math.min(speed * dt, 6);
    this.x += (this.vx / speed) * step;
    this.y += (this.vy / speed) * step;

    this.terrain.destroyCircle(this.x, this.y, p.digRadius);
    // В историю — для вернувшегося после обрыва: его земля восстанавливается
    // из журнала. Показ чужого хода не пишем: у него своя траектория
    if (!this.scene.replaying) {
      this.scene.explosionHistory?.push({ x: Math.round(this.x), y: Math.round(this.y), r: p.digRadius });
    }

    if (this.digLeft <= 0 || this.y > this.terrain.height - 4) {
      this.detonate(this.x, this.y);
    }
  }

  _wormAt(x, y) {
    for (const w of this.scene.worms) {
      if (!w.alive) continue;
      if (w === this.owner && this.ownerGrace > 0) continue;
      if (w.containsPoint(x, y)) return w;
    }
    return null;
  }

  /**
   * Первый боец на отрезке, если он там есть, и точка касания.
   *
   * Шаг в четыре пикселя: боец уже вдвое шире, так что проскочить сквозь
   * него нельзя, а считать чаще незачем — это самый горячий цикл полёта.
   * Возвращаем именно точку входа, а не конец подшага: воронка должна лечь
   * там, где снаряд встретил цель.
   */
  _wormOnSegment(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + dx * t, y = y0 + dy * t;
      if (this._wormAt(x, y)) return { x, y };
    }
    return null;
  }

  _pushTrail() {
    if (!this.trail) return;
    this.trailPts.push(this.x, this.y);
    if (this.trailPts.length > 120) this.trailPts.splice(0, 2);
  }

  _syncView() {
    this.view.setPosition(this.x, this.y);
    if (this.own && !this.resting && (this.vx || this.vy)) {
      if (this.pointed) this.view.setRotation(Math.atan2(this.vy, this.vx) + this.tilt);
      else this.view.rotation += (this.vx >= 0 ? 1 : -1) * 0.14;
    }
    if (this.sprited && this.weapon.rotational && !this.resting) {
      this.view.setFrame(rotFrame(this.vx, this.vy));
    }
    if (this.fuseLeft > 0) {
      // мигание фитиля
      const blink = Math.sin(this.age * 22) > 0;
      this.view.setAlpha(blink ? 1 : 0.55);
    }
    if (this.trail) {
      this.trail.clear();
      const pts = this.trailPts;
      for (let i = 2; i < pts.length; i += 2) {
        const a = (i / pts.length) * 0.45;
        this.trail.lineStyle(2, this.weapon.color, a);
        this.trail.lineBetween(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
      }
    }
  }

  detonate(x, y) {
    if (!this.alive) return;
    this.alive = false;
    const spawned = this.weapon.onDetonate(this.scene, this, x, y);
    this._cleanupView();
    if (spawned && spawned.length) this.scene.projectiles.push(...spawned);
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this._cleanupView();
  }

  _cleanupView() {
    this.view.destroy();
    if (this.trail) this.trail.destroy();
  }
}
