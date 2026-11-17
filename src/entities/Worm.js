import { CFG, DEPTH, TEAM_COLORS } from '../config.js';
import { has, meta } from '../core/assets.js';
import { font } from '../ui/theme.js';

/**
 * Боец. Прямоугольник CFG.WORM_W x CFG.WORM_H.
 *
 * Координата (x, y): x — центр по горизонтали, y — нижняя грань (ноги).
 * Занимаемые строки: y - H + 1 ... y. Опора — строка y + 1.
 *
 * Коллизия — попиксельно по маске ландшафта:
 *   • подъём по склону не выше CFG.STEP_UP за шаг, иначе стена;
 *   • падение выше CFG.FALL_SAFE наносит урон.
 */
export class Worm {
  constructor(scene, x, y, team, index) {
    this.scene = scene;
    this.terrain = scene.terrain;
    this.team = team;
    this.index = index;
    this.name = `${team + 1}-${index + 1}`;

    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;

    this.health = CFG.MAX_HEALTH;
    this.alive = true;
    this.grounded = false;
    this.facing = 1;
    this.walking = false;
    this.fallStartY = y;
    this.parachuting = false;   // спускается на парашюте: медленно и без урона
    this.chute = null;
    // Крюк-трос: zip — летит по тросу к точке; hang — висит, зацепившись
    // за стену или потолок ('ceil' | 'left' | 'right'), и не падает
    this.zip = null;
    this.hang = null;

    this._buildView();
  }

  /**
   * Раскрыть парашют: спуск равномерный, приземление без урона.
   *
   * Спрайт из оригинала — червяк уже висит под куполом, поэтому на время
   * спуска обычный вид прячется и рисуется он один. Без спрайта — купол
   * от ящика над головой.
   */
  deployChute() {
    this.parachuting = true;
    this.grounded = false;
    this.vy = Math.min(this.vy, CFG.CHUTE_SPEED);
    const s = this.scene;
    if (this.chute) return;
    if (!this.smiley && has(s, 'worm_chute')) {
      this.chute = s.rig.world(s.add.image(this.x, this.y + 2, 'worm_chute')
        .setOrigin(0.5, 1).setDepth(DEPTH.WORM));
      this.chuteWhole = true;
      this.view.setVisible(false);
      this.eye?.setVisible(false);
    } else if (has(s, 'crate_chute')) {
      this.chute = s.rig.world(s.add.image(this.x, this.y - CFG.WORM_H - 8, 'crate_chute')
        .setOrigin(0.5, 1).setDepth(DEPTH.WORM + 1));
      this.chuteWhole = false;
    }
  }

  /** Сложить парашют: приземлились или сняли извне. */
  foldChute() {
    this.parachuting = false;
    if (this.chute) { this.chute.destroy(); this.chute = null; }
    if (this.chuteWhole) {
      this.view.setVisible(this.alive);
      this.eye?.setVisible(this.alive);
      this.chuteWhole = false;
    }
  }

  _buildView() {
    const s = this.scene;
    const color = TEAM_COLORS[this.team % TEAM_COLORS.length];
    this.smiley = has(s, 'smiley');
    this.sprited = this.smiley || has(s, 'worm_idle');

    if (this.smiley) {
      // Смайлик: один лист на все позы, рисуется вдвое мельче кадра
      const m = meta('smiley');
      this.view = s.add.sprite(this.x, this.y, 'smiley', 0).setScale(m.scale);
      this.view.setOrigin(0.5, m.originY);
      this.view.play('smiley_idle');
      this.anim = 'smiley_idle';
    } else if (this.sprited) {
      // Спрайты WA нарисованы «мордой влево», ноги — не по низу кадра,
      // поэтому точка привязки берётся из sprite-meta.
      const m = meta('worm');
      this.view = s.add.sprite(this.x, this.y, 'worm_idle');
      this.view.setOrigin(0.5, m.originY);
      this.view.play('worm_idle');
      this.anim = 'worm_idle';
    } else {
      this.view = s.add.rectangle(this.x, this.y, CFG.WORM_W, CFG.WORM_H, color);
      this.view.setStrokeStyle(2, 0x141821, 0.85);
      this.view.setOrigin(0.5, 1);
      this.eye = s.add.rectangle(this.x, this.y - CFG.WORM_H + 9, 5, 5, 0x141821)
        .setDepth(DEPTH.WORM + 1);
    }
    s.rig.world(this.view.setDepth(DEPTH.WORM));
    if (this.eye) s.rig.world(this.eye);

    // Червяки в оригинале одинаковые, поэтому команду показываем цветом
    // числа здоровья и полоской под ним — как в самой игре.
    this.label = s.add.text(this.x, this.y - CFG.WORM_H - 20, `${this.health}`,
      font(15, 800, hexColor(color))).setOrigin(0.5, 0.5).setDepth(DEPTH.WORM + 2);
    s.rig.world(this.label);

    this.barBg = s.add.rectangle(this.x, this.y - CFG.WORM_H - 6, HP_BAR_W + 2, 5, 0x101420, 0.85)
      .setOrigin(0.5, 0.5).setDepth(DEPTH.WORM + 2);
    s.rig.world(this.barBg);
    this.bar = s.add.rectangle(this.x - HP_BAR_W / 2, this.y - CFG.WORM_H - 6, HP_BAR_W, 3, color)
      .setOrigin(0, 0.5).setDepth(DEPTH.WORM + 3);
    s.rig.world(this.bar);

    const markerKey = `marker_${this.team % 2}`;
    if (has(s, markerKey)) {
      this.marker = s.add.sprite(this.x, this.y - CFG.WORM_H - 40, markerKey)
        .setDepth(DEPTH.WORM + 2).setVisible(false);
      s.rig.world(this.marker);
      this.marker.play(markerKey);
      this.markerSprited = true;
    } else {
      this.marker = s.rig.world(s.add.triangle(this.x, this.y - CFG.WORM_H - 40, 0, 0, 14, 0, 7, 12, color)
        .setDepth(DEPTH.WORM + 2).setVisible(false));
    }
  }

  /** Переключить анимацию, если она отличается от текущей. */
  _setAnim(name) {
    // Имена анимаций исторически червячьи; у смайлика тот же набор и свои
    const key = this.smiley ? name.replace('worm_', 'smiley_') : name;
    if (!this.sprited || this.anim === key) return;
    this.anim = key;
    this.view.play(key, true);
  }

  // ------------------------------------------------------------ геометрия

  get left() { return Math.round(this.x) - (CFG.WORM_W >> 1); }
  get right() { return Math.round(this.x) + (CFG.WORM_W >> 1) - 1; }
  get top() { return Math.round(this.y) - CFG.WORM_H + 1; }
  get centerY() { return this.y - CFG.WORM_H / 2; }

  containsPoint(px, py) {
    return px >= this.left && px <= this.right && py >= this.top && py <= this.y;
  }

  /** Свободен ли прямоугольник бойца в позиции (cx, cy). */
  rectClear(cx, cy) {
    const hw = CFG.WORM_W >> 1;
    return !this.terrain.solidInRect(
      Math.round(cx) - hw + 1, Math.round(cy) - CFG.WORM_H + 1,
      Math.round(cx) + hw - 1, Math.round(cy),
    );
  }

  /** Есть ли твердь прямо под ногами. */
  supported(cx, cy) {
    const hw = CFG.WORM_W >> 1;
    return this.terrain.solidInRow(
      Math.round(cx) - hw + 2, Math.round(cx) + hw - 2, Math.round(cy) + 1,
    );
  }

  /**
   * Свободно ли туловище, если ноги стоят на (cx, cy).
   *
   * Ширина берётся та же, что у проверки опоры: разница даже в пиксель
   * означала бы, что боец «стоит», но при этом «упирается» — ровно на этом
   * ходьба и застревала.
   */
  bodyClear(cx, cy) {
    const hw = CFG.WORM_W >> 1;
    return !this.terrain.solidInRect(
      Math.round(cx) - hw + 2, Math.round(cy) - CFG.WORM_H + 1,
      Math.round(cx) + hw - 2, Math.round(cy),
    );
  }

  /**
   * На какой высоте окажутся ноги в точке cx.
   *
   * Боец стоит на самой высокой тверди под своей шириной, а не на земле
   * ровно под центром: корпус 24 px, и на склоне земля под передним краем
   * выше, чем под задним. Поиск идёт сверху вниз от «на шаг выше текущего»
   * и не глубже шага вниз — так не запрыгнуть на потолок и не провалиться.
   *
   * @returns {number|null} y ног или null, если опоры рядом нет (обрыв).
   */
  footYAt(cx, fromY = this.y) {
    const hw = CFG.WORM_W >> 1;
    const x0 = Math.round(cx) - hw + 2, x1 = Math.round(cx) + hw - 2;
    const top = Math.round(fromY) - CFG.STEP_UP;
    const bottom = Math.round(fromY) + CFG.STEP_UP;
    for (let y = top; y <= bottom; y++) {
      if (this.terrain.solidInRow(x0, x1, y)) return y - 1;
    }
    return null;
  }

  /** Поставить ноги на землю там, где боец стоит сейчас. */
  snapToGround() {
    const y = this.footYAt(this.x, this.y);
    if (y !== null && this.bodyClear(this.x, y)) this.y = y;
    this.grounded = this.supported(this.x, this.y);
    if (this.grounded && this.parachuting) this.foldChute();
  }

  // ---------------------------------------------------------------- крюк

  /** Касается ли корпус тверди хоть с какой-то стороны (на пиксель вокруг). */
  touching(cx = this.x, cy = this.y) {
    const hw = CFG.WORM_W >> 1;
    return this.terrain.solidInRect(
      Math.round(cx) - hw, Math.round(cy) - CFG.WORM_H,
      Math.round(cx) + hw, Math.round(cy) + 1,
    );
  }

  /** За что держится: потолок над головой, иначе стена сбоку. */
  _hangSide(cx = this.x, cy = this.y) {
    const hw = CFG.WORM_W >> 1;
    const x = Math.round(cx), y = Math.round(cy);
    const t = this.terrain;
    if (t.solidInRow(x - hw + 2, x + hw - 2, y - CFG.WORM_H)) return 'ceil';
    if (t.solidInRect(x + hw, y - CFG.WORM_H + 3, x + hw, y - 2)) return 'right';
    if (t.solidInRect(x - hw, y - CFG.WORM_H + 3, x - hw, y - 2)) return 'left';
    return this.touching(cx, cy) ? 'ceil' : null;
  }

  /**
   * Рывок по тросу к точке (ax, ay) на тверди. Летит по прямой; если корпус
   * задел выступ — скользит вдоль него, пока приближается к точке.
   */
  startZip(ax, ay) {
    if (!this.alive) return;
    this.foldChute();
    const d = Math.hypot(ax - this.x, ay - this.centerY);
    this.zip = { ax, ay, budget: d * 1.6 + 40 };
    this.hang = null;
    this.grounded = false;
    this.vx = 0; this.vy = 0;
    if (Math.abs(ax - this.x) > 4) this.facing = ax >= this.x ? 1 : -1;
  }

  /**
   * Один шаг рывка длиной dist. Вынесен отдельно: бот прогоняет рывок
   * целиком «в уме» (zipEnd), и шагать он должен ровно так же.
   * @returns {boolean} true — ещё летим
   */
  _zipMove(dist) {
    const z = this.zip;
    let remaining = dist;
    while (remaining > 0) {
      const step = Math.min(1, remaining);
      remaining -= step;
      const dx = z.ax - this.x, dy = z.ay - this.centerY;
      const d = Math.hypot(dx, dy);
      if (d < 3 || z.budget <= 0) return false;
      z.budget -= step;
      const nx = this.x + (dx / d) * step, ny = this.y + (dy / d) * step;
      if (this.rectClear(nx, ny)) { this.x = nx; this.y = ny; continue; }
      // Упёрлись: пробуем проскользнуть по одной оси — по той, по которой
      // до точки дальше
      const tryX = () => (Math.abs(dx) > 2 && this.rectClear(nx, this.y) ? ((this.x = nx), true) : false);
      const tryY = () => (Math.abs(dy) > 2 && this.rectClear(this.x, ny) ? ((this.y = ny), true) : false);
      const moved = Math.abs(dx) >= Math.abs(dy) ? (tryX() || tryY()) : (tryY() || tryX());
      if (!moved) return false;
    }
    return true;
  }

  _endZip() {
    this.zip = null;
    this.vx = 0; this.vy = 0;
    this.fallStartY = this.y;           // рывок — не падение: урона нет
    this._clampToWorld();
    if (this.supported(this.x, this.y)) { this.grounded = true; this.hang = null; return; }
    this.hang = this._hangSide();
    this.grounded = false;
  }

  /** Где окажется боец после рывка к точке — не двигая его самого. */
  zipEnd(ax, ay) {
    const keep = { x: this.x, y: this.y, zip: this.zip };
    const d = Math.hypot(ax - this.x, ay - this.centerY);
    this.zip = { ax, ay, budget: d * 1.6 + 40 };
    while (this._zipMove(40)) { /* до упора */ }
    const out = { x: this.x, y: this.y, grounded: this.supported(this.x, this.y) };
    out.hang = out.grounded ? null : this._hangSide();
    this.x = keep.x; this.y = keep.y; this.zip = keep.zip;
    return out;
  }

  /** Отцепиться: прыжок от стены или просто вниз с потолка. */
  letGo() {
    if (!this.hang) return;
    const side = this.hang;
    this.hang = null;
    this.fallStartY = this.y;
    if (side === 'left' || side === 'right') {
      this.facing = side === 'left' ? 1 : -1;
      this.vx = this.facing * CFG.JUMP_VX;
      this.vy = CFG.JUMP_VY * 0.7;
    } else {
      this.vx = this.facing * CFG.JUMP_VX * 0.5;
      this.vy = 0;
    }
  }

  // ------------------------------------------------------------- механика

  update(dt) {
    if (!this.alive) return;

    if (this.zip) {
      if (!this._zipMove(CFG.HOOK_SPEED * dt)) this._endZip();
      if (this.y > CFG.DROWN_Y) this._drown();
      this._syncView();
      return;
    }
    if (this.hang) {
      // Стену или потолок снесли — держаться не за что, падаем
      if (this.touching()) {
        this.vx = 0; this.vy = 0;
        this._syncView();
        return;
      }
      this.hang = null;
      this.fallStartY = this.y;
    }

    if (this.grounded && !this.supported(this.x, this.y)) {
      // Под ногами взорвали землю
      this.grounded = false;
      this.fallStartY = this.y;
    }

    if (this.grounded) {
      this.vy = 0;
      const damp = Math.exp(-CFG.GROUND_FRICTION * dt);
      this.vx *= damp;
      if (Math.abs(this.vx) < 6) this.vx = 0;
      if (this.vx !== 0) this._slideStep(dt);
    } else {
      this._airStep(dt);
    }

    if (this.y > CFG.DROWN_Y) this._drown();

    this._syncView();
  }

  /** Ходьба по команде игрока. Возвращает true, если сдвинулся. */
  walk(dir, dt) {
    if (!this.alive || !this.grounded) return false;
    this.facing = dir;
    this.walking = true;

    let remaining = CFG.WALK_SPEED * dt;
    let moved = false;

    while (remaining > 0) {
      const step = Math.min(1, remaining);
      remaining -= step;
      const nx = this.x + dir * step;

      // Куда встанут ноги: на самую высокую твердь под новой позицией
      const ny = this.footYAt(nx, this.y);

      // Опоры в пределах шага нет — это обрыв, шагаем и падаем
      if (ny === null) {
        this.x = nx;
        this.grounded = false;
        this.fallStartY = this.y;
        this._clampToWorld();
        return true;
      }

      // Туловище упирается — стена. Подъём выше STEP_UP сюда же и попадает:
      // ноги встали бы внутрь склона, и он пересёк бы корпус.
      if (!this.bodyClear(nx, ny)) break;

      this.x = nx;
      this.y = ny;
      moved = true;
      // Звук шага не на каждый пиксель: движок сам глушит частые повторы,
      // но лишние вызовы всё равно ни к чему
      if ((this._stepPhase = (this._stepPhase ?? 0) + step) > 14) {
        this._stepPhase = 0;
        this.scene.fx?.sound('step');
      }
    }

    this._clampToWorld();
    // Уперлись — стоим, а не перебираем ногами на месте
    if (!moved) this.walking = false;
    return moved;
  }

  jump(dir = this.facing) {
    if (!this.alive) return;
    if (this.hang) { this.scene.fx?.sound('jump'); this.letGo(); return; }
    if (!this.grounded) return;
    this.scene.fx?.sound('jump');
    this.grounded = false;
    this.fallStartY = this.y;
    this.vy = CFG.JUMP_VY;
    this.vx = dir * CFG.JUMP_VX;
  }

  /** Импульс от взрыва. */
  applyImpulse(ix, iy) {
    if (!this.alive) return;
    if (this.grounded || this.hang || this.zip) this.fallStartY = this.y;
    // Взрыв срывает со стены и обрывает рывок
    this.hang = null;
    this.zip = null;
    this.grounded = false;
    this.vx += ix;
    this.vy += iy;
  }

  /** Скольжение по земле после несильного толчка. */
  _slideStep(dt) {
    const dir = Math.sign(this.vx);
    let remaining = Math.abs(this.vx) * dt;
    while (remaining > 0) {
      const step = Math.min(1, remaining);
      remaining -= step;
      const nx = this.x + dir * step;
      let done = false;
      for (let dy = 0; dy >= -CFG.STEP_UP; dy--) {
        const ny = this.y + dy;
        if (this.rectClear(nx, ny) && this.supported(nx, ny)) {
          this.x = nx; this.y = ny; done = true; break;
        }
      }
      if (done) continue;
      if (this.rectClear(nx, this.y)) {
        this.x = nx;
        this.grounded = false;
        this.fallStartY = this.y;
        return;
      }
      this.vx = 0;
      break;
    }
    this._clampToWorld();
  }

  /** Полёт: те же мелкие подшаги, что и у снаряда. */
  _airStep(dt) {
    const sdt = dt / CFG.SUBSTEPS;
    for (let i = 0; i < CFG.SUBSTEPS && this.alive && !this.grounded; i++) {
      this.vy += CFG.GRAVITY * sdt;
      // Парашют держит скорость спуска, вбок не сносит
      if (this.parachuting) { this.vy = Math.min(this.vy, CFG.CHUTE_SPEED); this.vx = 0; }
      this.vx *= Math.exp(-CFG.AIR_FRICTION * sdt);

      const dx = this.vx * sdt;
      const dy = this.vy * sdt;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
      const stepX = dx / steps;
      const stepY = dy / steps;

      for (let s = 0; s < steps; s++) {
        // Горизонталь
        const nx = this.x + stepX;
        if (this.rectClear(nx, this.y)) {
          this.x = nx;
        } else {
          // Пробуем перешагнуть выступ, иначе гасим горизонтальную скорость
          let slid = false;
          for (let dyy = -1; dyy >= -CFG.STEP_UP; dyy--) {
            if (this.rectClear(nx, this.y + dyy)) {
              this.x = nx; this.y += dyy; slid = true; break;
            }
          }
          if (!slid) this.vx *= -0.25;
        }

        // Вертикаль
        const ny = this.y + stepY;
        if (this.rectClear(this.x, ny)) {
          this.y = ny;
        } else if (stepY > 0) {
          this._land();
          break;
        } else {
          this.vy = 0;
          break;
        }
      }
      this._clampToWorld();
    }
  }

  _land() {
    this.grounded = true;
    const drop = this.y - this.fallStartY;
    this.vy = 0;
    this.vx *= 0.3;
    if (this.parachuting) { this.foldChute(); this.fallStartY = this.y; return; }
    if (drop > CFG.FALL_SAFE) {
      const dmg = Math.min(CFG.FALL_DMG_MAX, (drop - CFG.FALL_SAFE) * CFG.FALL_DMG_PER_PX);
      this.damage(Math.round(dmg), 'падение');
    }
  }

  _clampToWorld() {
    const hw = CFG.WORM_W >> 1;
    if (this.x < hw) { this.x = hw; this.vx = 0; }
    if (this.x > this.terrain.width - hw) { this.x = this.terrain.width - hw; this.vx = 0; }
  }

  _drown() {
    this.scene.fx.splash(this.x, CFG.WATER_Y);
    this.health = 0;
    this.kill('утонул');
  }

  damage(amount, cause = '') {
    if (!this.alive || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    // Пару секунд лицо помнит, что было больно; после падения — кружится голова
    this.hurtPose = cause === 'падение' ? 'worm_dizzy' : 'worm_hurt';
    this.hurtUntil = this.scene.time.now + 1300;
    this.scene.fx.damageNumber(this.x, this.centerY - 10, amount);
    if (this.health <= 0) this.kill(cause);
  }

  heal(amount) {
    if (!this.alive) return;
    this.health = Math.min(CFG.MAX_HEALTH, this.health + amount);
  }

  kill(cause = '') {
    this.foldChute();
    if (!this.alive) return;
    this.zip = null;
    this.hang = null;
    this.rope?.destroy();
    this.rope = null;
    this.alive = false;
    this.health = 0;
    this.marker.setVisible(false);
    this.scene.onWormDied(this, cause);

    const s = this.scene;
    const gx = Math.round(this.x), gy = Math.round(this.y);
    if (this.smiley) this._ghost();
    s.tweens.add({
      targets: [this.view, this.label, this.bar, this.barBg, this.eye].filter(Boolean),
      alpha: 0,
      y: '+=6',
      duration: 400,
      onComplete: () => {
        this.view.destroy();
        this.label.destroy();
        this.bar.destroy();
        this.barBg.destroy();
        if (this.eye) this.eye.destroy();
        this.marker.destroy();
        this._placeGrave(gx, gy);
      },
    });
  }

  /** Надгробие на месте гибели — если под ним осталась земля. */
  _placeGrave(x, y) {
    const s = this.scene;
    // У смайлика вместо надгробия улетает призрак
    if (this.smiley || !has(s, 'grave')) return;
    const top = this.terrain.surfaceYAt(x, Math.max(0, y - 60));
    if (top === null || top > CFG.DROWN_Y) return;
    const grave = s.rig.world(s.add.image(x, top + 1, 'grave')
      .setOrigin(0.5, 1).setDepth(DEPTH.WORM - 1).setAlpha(0));
    s.tweens.add({ targets: grave, alpha: 1, duration: 300 });
  }

  /** Призрак: поднимается с места гибели и тает. */
  _ghost() {
    const s = this.scene;
    const m = meta('smiley');
    const g = s.rig.world(s.add.image(this.x, this.centerY, 'smiley', m.ghost)
      .setScale(m.scale).setDepth(DEPTH.WORM + 4).setAlpha(0.95));
    if (g.setFlipX) g.setFlipX(this.facing > 0);
    s.tweens.add({
      targets: g, y: this.centerY - 90, alpha: 0, duration: 1800, ease: 'Sine.easeOut',
      onComplete: () => g.destroy(),
    });
  }

  setActiveMarker(on) {
    if (!this.alive) return;
    this.marker.setVisible(on);
  }

  get settled() {
    if (!this.alive || this.hang) return true;
    return !this.zip && this.grounded && Math.abs(this.vx) < 4;
  }

  _syncView() {
    const rx = Math.round(this.x);
    const ry = Math.round(this.y);
    // На стене и потолке боец «стоит» на них ногами: поворачиваем вид
    // вокруг точки ног и ставим её на ту поверхность, за которую держится
    const hw = CFG.WORM_W >> 1;
    if (this.hang === 'ceil') { this.view.setPosition(rx, ry - CFG.WORM_H + 1); this.view.setRotation(Math.PI); }
    else if (this.hang === 'left') { this.view.setPosition(rx - hw, ry - CFG.WORM_H / 2); this.view.setRotation(Math.PI / 2); }
    else if (this.hang === 'right') { this.view.setPosition(rx + hw, ry - CFG.WORM_H / 2); this.view.setRotation(-Math.PI / 2); }
    else { this.view.setPosition(rx, ry); this.view.setRotation(0); }
    this._drawRope();

    // Спрайты нарисованы мордой влево, поэтому отражаем при движении вправо
    if (this.view.setFlipX) this.view.setFlipX(this.sprited ? this.facing > 0 : this.facing < 0);

    if (this.smiley) this._syncSmiley(rx, ry);
    else if (this.sprited) {
      if (this.hang) this._setAnim('worm_idle');
      else if (!this.grounded) this._setAnim('worm_fall');
      else if (this.walking || this.scene.time.now < (this.remoteWalkUntil ?? 0)) this._setAnim('worm_walk');
      else this._setAnim('worm_idle');
    }

    if (this.eye) this.eye.setPosition(rx + this.facing * 6, ry - CFG.WORM_H + 9);
    // Купол: под ним боец целиком — покачиваем; над головой — просто держим
    let lift = 0;
    if (this.chute) {
      if (this.chuteWhole) {
        this.chute.setPosition(rx, ry + 2);
        this.chute.setRotation(Math.sin(this.scene.time.now / 320) * 0.14);
        if (this.chute.setFlipX) this.chute.setFlipX(this.facing > 0);
        lift = this.chute.displayHeight - CFG.WORM_H + 4;
      } else {
        this.chute.setPosition(rx, ry - CFG.WORM_H - 8);
        lift = this.chute.displayHeight + 4;
      }
    }

    this.label.setPosition(rx, ry - CFG.WORM_H - 20 - lift);
    this.label.setText(`${this.health}`);
    this.barBg.setPosition(rx, ry - CFG.WORM_H - 7 - lift);
    this.bar.setPosition(rx - HP_BAR_W / 2, ry - CFG.WORM_H - 7 - lift);
    this.bar.width = HP_BAR_W * (this.health / CFG.MAX_HEALTH);

    if (this.marker.visible) {
      const bob = Math.sin(this.scene.time.now / 220) * 4;
      const dx = this.markerSprited ? 0 : -7;
      // Выше числа здоровья: раньше стрелка садилась прямо на него («1⬇0»)
      this.marker.setPosition(rx + dx, ry - CFG.WORM_H - 58 - lift + bob);
    }
    this.walking = false;
  }
}

/**
 * Поза смайлика: у него лицо, и оно должно отвечать на происходящее —
 * летит по тросу, больно, целится, победил. Полёт рисуется вокруг центра
 * и разворачивается по направлению рывка; остальное стоит на ногах.
 */
Worm.prototype._syncSmiley = function _syncSmiley(rx, ry) {
  const scene = this.scene;
  const m = meta('smiley');
  const now = scene.time.now;
  if (this.zip) {
    const dx = this.zip.ax - this.x, dy = this.zip.ay - this.centerY;
    this._setAnim('worm_fly');
    this.view.setOrigin(0.5, 0.5);
    this.view.setPosition(rx, Math.round(this.centerY));
    this.view.setFlipX(dx > 0);
    this.view.setRotation(dx > 0 ? Math.atan2(dy, dx) : Math.atan2(-dy, -dx));
    return;
  }
  this.view.setOrigin(0.5, m.originY);
  const aiming = scene.turn?.activeWorm === this
    && (scene.charging || scene.aim?.mode === 'aim');
  if (this.mood) this._setAnim(this.mood);
  else if (now < (this.hurtUntil ?? 0)) this._setAnim(this.hurtPose);
  else if (this.hang) this._setAnim(aiming ? 'worm_aim' : 'worm_idle');
  else if (!this.grounded) this._setAnim('worm_fall');
  else if (aiming) this._setAnim('worm_aim');
  else if (this.walking || now < (this.remoteWalkUntil ?? 0)) this._setAnim('worm_walk');
  else this._setAnim('worm_idle');
};

Worm.prototype._drawRope = function _drawRope() {
  if (!this.zip) { if (this.rope) this.rope.clear(); return; }
  const s = this.scene;
  if (!this.rope) this.rope = s.rig.world(s.add.graphics().setDepth(DEPTH.WORM - 1));
  const g = this.rope;
  const { ax, ay } = this.zip;
  g.clear();
  g.lineStyle(4, 0x1a1208, 0.55).lineBetween(this.x, this.centerY, ax, ay);
  g.lineStyle(2, 0xe8d9a8, 1).lineBetween(this.x, this.centerY, ax, ay);
  g.fillStyle(0xe8d9a8, 1).fillCircle(ax, ay, 4);
};

/** Ширина полоски здоровья над бойцом. */
const HP_BAR_W = 26;

function hexColor(n) {
  return `#${n.toString(16).padStart(6, '0')}`;
}
