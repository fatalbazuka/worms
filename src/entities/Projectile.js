import { CFG, DEPTH } from '../config.js';
import { item } from '../core/cosmetics.js';
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
      // Огненный шар нарисован с хвостом пламени — летит хвостом назад
      this.pointed = ['bazooka', 'mole', 'mortar', 'airmissile', 'fireball', 'icicle', 'meteor', 'homing', 'splitlet'].includes(this.weapon.id);
      // Авиаракета нарисована носом вниз-вправо, комета ☄️ — вниз-влево, остальные — вправо
      this.tilt = { airmissile: -Math.PI / 4, meteor: (-3 * Math.PI) / 4 }[this.weapon.id] ?? 0;
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
    if (p.boomerang) { this._boomerangStep(dt, p); return; }
    // Сплит по сети: соперник разделил ракету в этот момент полёта
    if (this.splitAt != null && this.age >= this.splitAt) { this.split(); return; }
    if (p.homing && this.age >= p.homeDelay) this._steer(dt, p);

    if (this.stuck) {
      // Прилипла. Стену под ней снесли — отваливается и липнет заново
      if (!this._touchesGround(p.radius + 3)) { this.stuck = false; } else return;
    }

    if (this.resting) {
      // Лежит на земле (граната). Если землю под ней снесли — снова падает.
      if (!this.terrain.solidInRow(this.x - p.radius, this.x + p.radius, this.y + p.radius + 1)) {
        this.resting = false;
      } else {
        return;
      }
    }

    // Интегрирование скорости: гравитация + ветер как горизонтальное ускорение.
    // Самонаводка после захвата цели летит ровно — сама держит курс
    const locked = p.homing && this.age >= p.homeDelay;
    this.vx += this.scene.wind * p.windScale * (locked ? 0.2 : 1) * dt;
    this.vy += CFG.GRAVITY * p.gravityScale * (locked ? 0 : 1) * dt;
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
    // Магнитная мина: легла — стала миной, без взрыва
    if (p.deploy === 'mine') {
      this.x = ray.freeX; this.y = ray.freeY;
      this.alive = false;
      this._cleanupView();
      this.scene.addMine(this.x, this.y, this.weapon, this.owner, { magnetic: true });
      this.scene.fx?.sound('thunk');
      return;
    }
    if (p.sticky) {
      this.x = ray.freeX; this.y = ray.freeY;
      this.vx = 0; this.vy = 0;
      this.stuck = true;
      if (this.fuseLeft <= 0) this.fuseLeft = p.stickFuse || 3;
      this.scene.fx?.sound('thunk');
      return;
    }

    // Гиря: первый пол проламывает насквозь и летит дальше вниз. Пролом
    // считается одинаково и при показе хода сопернику — как ходы крота
    if (p.pierce > 0 && !this.pierced) {
      this.pierced = true;
      const r = 13;
      for (let d = 0; d <= p.pierce; d += 6) {
        const cx = Math.round(ray.x), cy = Math.round(ray.y + d);
        this.terrain.destroyCircle(cx, cy, r);
        if (!this.scene.replaying) this.scene.explosionHistory?.push({ x: cx, y: cy, r });
      }
      this.x = ray.x; this.y = ray.y;
      this.vx *= 0.25;
      this.vy = Math.max(this.vy, 260);
      this.scene.rig.shake(120, 0.004);
      this.scene.fx?.sound('thunk');
      return;
    }

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

    // Заряд с фитилём и без отскока (динамит) ложится и ждёт фитиля, а не
    // рвётся от касания земли
    if (this.fuseLeft > 0) {
      this.x = ray.freeX; this.y = ray.freeY;
      this.vx = 0; this.vy = 0;
      this.resting = true;
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
    // Попрыгунчик: на N-м отскоке рвётся сам
    if (p.maxBounces > 0) {
      this.bounces = (this.bounces ?? 0) + 1;
      this.scene.fx?.sound('jump');
      if (this.bounces >= p.maxBounces) {
        this.x = ray.freeX; this.y = ray.freeY;
        this.detonate(this.x, this.y);
        return;
      }
    }
    // Отодвигаем от поверхности, чтобы не залипнуть внутри пикселя
    this.x = ray.freeX + n.x * 1.5;
    this.y = ray.freeY + n.y * 1.5;

    if (Math.hypot(this.vx, this.vy) < 42) {
      this.vx = 0; this.vy = 0;
      this.resting = true;
    }
  }

  /**
   * Сплит-ракета: тап в полёте — три ракеты веером по текущему курсу.
   * Не разделил — рвётся при ударе, как обычная.
   */
  split() {
    if (!this.alive || !this.weapon.projectile.split) return false;
    this.alive = false;
    const child = this.weapon.projectile.split;
    const speed = Math.hypot(this.vx, this.vy) || 1;
    const a0 = Math.atan2(this.vy, this.vx);
    const kids = [-0.24, 0, 0.24].map((da) => new Projectile(this.scene, this.x, this.y,
      Math.cos(a0 + da) * speed, Math.sin(a0 + da) * speed, child, this.owner));
    for (const k of kids) { k.insideGround = false; k.ownerGrace = 0; }
    this.scene.projectiles.push(...kids);
    this.scene.fx?.dust(this.x, this.y, 6);
    this.scene.fx?.sound('shot');
    this._cleanupView();
    return true;
  }

  /** Самонаводка: доворот курса к ближайшему врагу стрелка, скорость не меньше 380. */
  _steer(dt, p) {
    const foe = this._nearestFoe(700);
    if (!foe) return;
    const want = Math.atan2(foe.centerY - this.y, foe.x - this.x);
    const cur = Math.atan2(this.vy, this.vx);
    let d = want - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const turn = Math.max(-p.homing * dt, Math.min(p.homing * dt, d));
    const speed = Math.max(380, Math.hypot(this.vx, this.vy));
    this.vx = Math.cos(cur + turn) * speed;
    this.vy = Math.sin(cur + turn) * speed;
  }

  _nearestFoe(range) {
    let best = null, bd = range;
    for (const w of this.scene.worms) {
      if (!w.alive || (this.owner && w.team === this.owner.team)) continue;
      const d = Math.hypot(w.x - this.x, w.centerY - this.y);
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }

  /**
   * Бумеранг: летит по прицелу, тормозит и возвращается к хозяину. Бьёт
   * каждого, кого заденет, — по разу туда и по разу обратно. Стена его
   * ловит; вернулся к бросившему — пойман.
   */
  _boomerangStep(dt, p) {
    if (!this.dir) {
      const s = Math.hypot(this.vx, this.vy) || 1;
      this.dir = { x: this.vx / s, y: this.vy / s };
      this.hitOut = new Set();
      this.hitBack = new Set();
    }
    this.vx -= this.dir.x * p.boomerang * dt;
    this.vy -= this.dir.y * p.boomerang * dt;
    this.vy += CFG.GRAVITY * p.gravityScale * dt;
    this.vx += this.scene.wind * p.windScale * dt;
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
    const back = this.vx * this.dir.x + this.vy * this.dir.y < 0;
    const hit = back ? this.hitBack : this.hitOut;
    for (const w of this.scene.worms) {
      if (!w.alive || hit.has(w) || (w === this.owner && !back)) continue;
      if (w === this.owner && back) continue;
      if (Math.hypot(w.x - nx, w.centerY - ny) > 22) continue;
      hit.add(w);
      this.scene.boomerangHit?.(w, p.hitDamage, this.vx, this.vy, this.owner, back);
    }
    // Вернулся к бросившему — пойман
    if (back && this.owner?.alive && this.age > 0.4 && Math.hypot(this.owner.x - nx, this.owner.centerY - ny) < 24) {
      this.destroy();
      return;
    }
    if (this.insideGround) {
      this.x = nx; this.y = ny;
      if (!this.terrain.solidAt(nx, ny)) this.insideGround = false;
      return;
    }
    const ray = this.terrain.raycast(this.x, this.y, nx, ny);
    if (ray.hit || ny > this.terrain.height + 60 || nx < -120 || nx > this.terrain.width + 120 || this.age > 4.5) {
      this.scene.fx?.dust(this.x, this.y, 5);
      this.scene.fx?.sound('thunk');
      this.destroy();
      return;
    }
    this.x = nx; this.y = ny;
    this._pushTrail();
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

  /** Есть ли земля вплотную — по восьми направлениям на расстоянии r. */
  _touchesGround(r) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (this.terrain.solidAt(this.x + Math.cos(a) * r, this.y + Math.sin(a) * r)) return true;
    }
    return false;
  }

  _wormAt(x, y) {
    for (const w of this.scene.worms) {
      if (!w.alive) continue;
      if (w === this.owner && this.ownerGrace > 0) continue;
      if (w.containsPoint(x, y)) return w;
    }
    // Монстры кампании ловят снаряд так же, как бойцы
    for (const m of this.scene.monsters ?? []) {
      if (m.alive && m.containsPoint(x, y)) return m;
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
    if (this.weapon.projectile.boomerang) this.view.rotation += 0.45;
    if (this.own && !this.resting && !this.stuck && (this.vx || this.vy)) {
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
      // След по украшению стрелка: свой цвет, радуга или точки-звёздочки
      const cos = this.owner?.cos && item('trail', this.owner.cos.trail);
      const n = pts.length;
      for (let i = 2; i < n; i += 2) {
        const a = (i / n) * (cos?.price ? 0.85 : 0.45);
        let color = cos?.color ?? this.weapon.color;
        if (cos?.rainbow) color = Phaser.Display.Color.HSVToRGB(((i / n) + this.age) % 1, 0.8, 1).color;
        if (cos?.dots) {
          if (i % 8 === 0) this.trail.fillStyle(color, a).fillCircle(pts[i], pts[i + 1], 3.5);
          continue;
        }
        this.trail.lineStyle(cos?.price ? 3 : 2, color, a);
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
