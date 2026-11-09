import { CFG, DEPTH } from '../config.js';
import { has } from '../core/assets.js';
import { font } from './theme.js';
import { isDesktop } from '../platform/device.js';

/**
 * Прицеливание и протяжка камеры.
 *
 * Схем две, работают одновременно:
 *
 * 1. Кнопочная (основная, удобна на телефоне): угол крутится кнопками ▲▼
 *    и хранится в сцене, сила набирается удержанием «Огонь». Здесь эта
 *    схема только рисуется — прицел на луче от бойца и траектория, пока
 *    идёт набор силы. Палец при этом лежит в углу экрана и ничего не
 *    закрывает.
 * 2. Свайп по бойцу: направление задаёт угол, длина — силу, отпустили =
 *    выстрел. Быстрее на мыши, но на тач-экране кисть накрывает поле.
 *
 * В обоих случаях подсказка — первые CFG.TRAJ_POINTS точек реальной
 * траектории (та же математика, что в Projectile, с учётом ветра и
 * параметров оружия), обрезанная по столкновению с землёй.
 */
export class AimController {
  constructor(scene) {
    this.scene = scene;
    this.mode = null;          // 'aim' | 'pan' | null
    this.startX = 0; this.startY = 0;
    this.dragX = 0; this.dragY = 0;
    this.camStart = 0;

    this.gfx = scene.rig.world(scene.add.graphics().setDepth(DEPTH.AIM));
    this.info = scene.add.text(0, 0, '', font(15, 800))
      .setOrigin(0.5, 1).setDepth(DEPTH.AIM);
    scene.rig.world(this.info);
    this.info.setVisible(false);

    // На ПК своя схема: прицел — курсором, сила — удержанием левой кнопки,
    // карта тянется правой или средней. Свайп по бойцу там не нужен.
    this.desktop = isDesktop();
    if (this.desktop) scene.input.mouse?.disableContextMenu();

    scene.input.on('pointerdown', this.onDown, this);
    scene.input.on('pointermove', this.onMove, this);
    scene.input.on('pointerup', this.onUp, this);
    scene.input.on('pointerupoutside', this.onUp, this);
  }

  get worm() { return this.scene.turn.activeWorm; }

  origin() {
    const w = this.worm;
    return w ? { x: w.x, y: w.centerY } : { x: 0, y: 0 };
  }

  onDown(pointer) {
    if (this.scene.hud.isOverUI(pointer) || this.scene.rig.pinching) return;
    if (this.desktop) { this._mouseDown(pointer); return; }

    const w = this.worm;
    const canAim = this.scene.canPlayerAct() && w && w.alive;
    const o = this.origin();
    // pointer.worldX смотрит на камеру неба — мировую точку берём у рига
    const p = this.scene.rig.worldPoint(pointer);
    const near = canAim && Math.hypot(p.x - o.x, p.y - o.y) <= CFG.AIM_GRAB_RADIUS;

    if (near) {
      this.mode = 'aim';
      this.startX = p.x;
      this.startY = p.y;
      this.dragX = 0; this.dragY = 0;
    } else {
      this.mode = 'pan';
      this.scene.rig.panStart(pointer);
    }
  }

  onMove(pointer) {
    if (this.desktop && this.mode !== 'pan') this.aimAtPointer(pointer);
    if (!this.mode || !pointer.isDown) return;

    if (this.mode === 'pan') {
      this.scene.rig.panMove(pointer);
      return;
    }
    if (this.scene.rig.pinching) { this.cancel(); return; }

    const p = this.scene.rig.worldPoint(pointer);
    this.dragX = p.x - this.startX;
    this.dragY = p.y - this.startY;
  }

  onUp() {
    this.scene.rig.panEnd();
    if (this.mode === 'charge') this.scene.mouseFire = false;
    if (this.mode === 'aim') {
      const shot = this.computeShot();
      if (shot) {
        // Синхронизируем угол кнопочной схемы со свайпом, иначе после
        // выстрела свайпом ▲▼ продолжали бы крутить со старого значения
        const w = this.worm;
        if (w) {
          w.facing = shot.vx >= 0 ? 1 : -1;
          this.scene.aimAngle = Phaser.Math.Clamp(
            Math.atan2(-shot.vy, Math.abs(shot.vx)),
            -CFG.AIM_ANGLE_LIMIT, CFG.AIM_ANGLE_LIMIT,
          );
        }
        this.scene.fireActiveWorm(shot.vx, shot.vy);
      }
    }
    this.mode = null;
    this.dragX = 0; this.dragY = 0;
    this.gfx.clear();
    this.info.setVisible(false);
  }

  // ------------------------------------------------------- мышь на ПК

  /**
   * Левая кнопка в свой ход — набор силы (отпустил — выстрел), в чужой —
   * протяжка карты. Правая и средняя тянут карту всегда.
   */
  _mouseDown(pointer) {
    const left = pointer.leftButtonDown?.() ?? true;
    const w = this.worm;
    if (left && this.scene.canPlayerAct() && w && w.alive) {
      this.aimAtPointer(pointer);
      this.mode = 'charge';
      this.scene.mouseFire = true;
      return;
    }
    this.mode = 'pan';
    this.scene.rig.panStart(pointer);
  }

  /** Боец смотрит на курсор: разворот и угол — как если бы целился рукой. */
  aimAtPointer(pointer) {
    const scene = this.scene;
    const w = this.worm;
    if (!w || !w.alive || !scene.canPlayerAct()) return;
    if (scene.hud.isOverUI(pointer)) return;
    const o = this.origin();
    const p = scene.rig.worldPoint(pointer);
    const dx = p.x - o.x, dy = p.y - o.y;
    if (Math.hypot(dx, dy) < 12) return;   // курсор на самом бойце — угол не определён
    if (Math.abs(dx) > 3) w.facing = dx >= 0 ? 1 : -1;
    scene.aimAngle = Phaser.Math.Clamp(Math.atan2(-dy, Math.abs(dx)),
      -CFG.AIM_ANGLE_LIMIT, CFG.AIM_ANGLE_LIMIT);
  }

  cancel() {
    if (this.mode === 'charge') this.scene.mouseFire = false;
    this.mode = null;
    this.dragX = 0; this.dragY = 0;
    this.gfx.clear();
    this.info.setVisible(false);
  }

  /** Вектор выстрела из текущего свайпа, либо null, если свайп слишком короткий. */
  computeShot() {
    const len = Math.hypot(this.dragX, this.dragY);
    if (len < CFG.AIM_MIN_DRAG) return null;

    const sign = CFG.AIM_INVERT ? -1 : 1;
    const dirX = (this.dragX / len) * sign;
    const dirY = (this.dragY / len) * sign;
    const power = Math.min(len, CFG.AIM_MAX_DRAG) / CFG.AIM_MAX_DRAG * CFG.AIM_MAX_POWER;

    return {
      vx: dirX * power,
      vy: dirY * power,
      power,
      angle: Math.atan2(-dirY, dirX),
    };
  }

  update() {
    this.gfx.clear();
    const w = this.worm;
    const scene = this.scene;
    // Ход соперника по сети: его прицел и заряд приходят живьём и рисуются
    // так же, как свои, — только читать их надо из remote*, а не из ввода
    if (w && scene.remoteAim && scene.awaitingPeer?.() && scene.turn.state === 'aim') {
      this._drawButtonAim(scene.remoteCharge);
      return;
    }
    if (!w || !scene.canPlayerAct()) {
      this.info.setVisible(false);
      if (this.crosshair) this.crosshair.setVisible(false);
      return;
    }

    // Свайп имеет приоритет; иначе показываем прицел кнопочной схемы
    if (this.mode === 'aim') this._drawSwipe();
    else this._drawButtonAim(scene.charging ? scene.charge : 0);
  }

  /** Прицел и — во время набора силы — траектория для кнопочной схемы. */
  _drawButtonAim(charge) {
    const scene = this.scene;
    const o = this.origin();
    const d = scene.aimDirection();
    const weapon = scene.turn.weapon;

    this._ensureCrosshair();
    this.crosshair.setVisible(true);
    this.crosshair.setPosition(o.x + d.x * CFG.AIM_RAY_LEN, o.y + d.y * CFG.AIM_RAY_LEN);

    this.gfx.lineStyle(2, 0xffffff, 0.28);
    this.gfx.lineBetween(o.x + d.x * 16, o.y + d.y * 16,
      o.x + d.x * (CFG.AIM_RAY_LEN - 12), o.y + d.y * (CFG.AIM_RAY_LEN - 12));

    if (!(charge > 0)) { this.info.setVisible(false); return; }
    // Пошёл заряд — стрелка «чей ход» своё сказала, а над головой теперь
    // подпись угла и силы: вдвоём они налезали друг на друга
    if (this.worm?.marker?.visible) this.worm.setActiveMarker(false);

    const speed = charge * CFG.AIM_MAX_POWER;
    const sx = o.x + d.x * CFG.MUZZLE_OFFSET;
    const sy = o.y + d.y * CFG.MUZZLE_OFFSET;
    this._drawTrajectory(sx, sy, d.x * speed, d.y * speed, weapon);

    const deg = Math.round((scene.aimAngle * 180) / Math.PI);
    this.info.setText(`${deg}°  ${Math.round(charge * 100)}%`);
    this.info.setPosition(o.x, o.y - 58);
    this.info.setVisible(true);
  }

  _ensureCrosshair() {
    const s = this.scene;
    const team = s.turn.currentTeam % 2;
    if (this.crosshair && this.crosshairTeam === team) return;

    const key = `crosshair_${team}`;
    if (!this.crosshair) {
      this.crosshair = s.rig.world(has(s, key)
        ? s.add.image(0, 0, key).setDepth(DEPTH.AIM)
        : s.add.circle(0, 0, 6).setStrokeStyle(2, 0xffffff, 0.8).setDepth(DEPTH.AIM));
    } else if (this.crosshair.setTexture && has(s, key)) {
      this.crosshair.setTexture(key); // прицел перекрашивается под команду
    }
    this.crosshairTeam = team;
  }

  _drawTrajectory(sx, sy, vx, vy, weapon) {
    if (weapon.targeted) { this._drawTarget(vx, vy, weapon); return; }
    const pts = this.simulate(sx, sy, vx, vy, weapon);
    for (let i = 0; i < pts.length; i++) {
      const a = 0.95 - (i / CFG.TRAJ_POINTS) * 0.6;
      const r = 3.4 - (i / CFG.TRAJ_POINTS) * 1.4;
      this.gfx.fillStyle(weapon.color, a);
      this.gfx.fillCircle(pts[i].x, pts[i].y, r);
    }
  }

  /**
   * Оружие с целью (авиаудар, телепорт): вместо траектории — метка там,
   * куда придётся удар или где появится боец. Точку считает само оружие,
   * той же функцией, что и при выстреле, — метка не врёт.
   */
  _drawTarget(vx, vy, weapon) {
    const w = this.worm;
    if (!w) return;
    const t = weapon.targetPoint(this.scene, w, vx, vy);
    const g = this.gfx;
    const c = weapon.color;
    if (weapon.id === 'teleport') {
      // Силуэт бойца в точке появления; над водой — красный: утонет
      const col = t.water ? 0xff6b6b : c;
      g.lineStyle(2, col, 0.9);
      g.strokeRoundedRect(t.x - CFG.WORM_W / 2, t.y - CFG.WORM_H, CFG.WORM_W, CFG.WORM_H, 8);
      g.fillStyle(col, 0.18);
      g.fillRoundedRect(t.x - CFG.WORM_W / 2, t.y - CFG.WORM_H, CFG.WORM_W, CFG.WORM_H, 8);
      for (let i = 1; i <= 6; i++) {
        const k = i / 7;
        g.fillStyle(c, 0.25 + k * 0.5);
        g.fillCircle(w.x + (t.x - w.x) * k, w.centerY + (t.y - CFG.WORM_H / 2 - w.centerY) * k, 2.2);
      }
      return;
    }
    // Авиаудар: пунктир сверху до земли и полоса накрытия
    const top = Math.max(0, this.scene.rig.viewTop);
    for (let y = top; y < t.y - 8; y += 18) {
      g.fillStyle(c, 0.55);
      g.fillRect(t.x - 1, y, 2, 10);
    }
    const half = ((weapon.missiles ?? 5) - 1) / 2 * (weapon.spacing ?? 26) + 20;
    g.lineStyle(3, c, 0.85);
    g.lineBetween(t.x - half, t.y + 2, t.x + half, t.y + 2);
    g.strokeCircle(t.x, t.y - 6, 10);
  }

  _drawSwipe() {
    if (this.crosshair) this.crosshair.setVisible(false);
    if (this.worm?.marker?.visible) this.worm.setActiveMarker(false);
    const shot = this.computeShot();
    if (!shot) { this.info.setVisible(false); return; }

    const o = this.origin();
    const weapon = this.scene.turn.weapon;
    const nx = shot.vx / Math.hypot(shot.vx, shot.vy);
    const ny = shot.vy / Math.hypot(shot.vx, shot.vy);
    const sx = o.x + nx * CFG.MUZZLE_OFFSET;
    const sy = o.y + ny * CFG.MUZZLE_OFFSET;

    // Пунктирная траектория — первые CFG.TRAJ_POINTS точек
    this._drawTrajectory(sx, sy, shot.vx, shot.vy, weapon);

    // Линия силы от бойца
    this.gfx.lineStyle(2, 0xffffff, 0.35);
    this.gfx.lineBetween(o.x, o.y, o.x + nx * 46, o.y + ny * 46);

    const pct = Math.round((shot.power / CFG.AIM_MAX_POWER) * 100);
    const deg = Math.round((shot.angle * 180) / Math.PI);
    this.info.setText(`${deg}°  ${pct}%`);
    this.info.setPosition(o.x, o.y - 58);
    this.info.setVisible(true);
  }

  /** Та же интеграция, что и у снаряда, но без разрушений. */
  simulate(x, y, vx, vy, weapon) {
    const p = weapon.projectile;
    const terrain = this.scene.terrain;
    const wind = this.scene.wind;
    const out = [];
    let px = x, py = y;

    for (let i = 0; i < CFG.TRAJ_POINTS; i++) {
      for (let s = 0; s < CFG.TRAJ_STEP; s++) {
        vx += wind * p.windScale * CFG.TRAJ_DT;
        vy += CFG.GRAVITY * p.gravityScale * CFG.TRAJ_DT;
        if (p.drag > 0) {
          const f = Math.exp(-p.drag * CFG.TRAJ_DT);
          vx *= f; vy *= f;
        }
        const nx2 = px + vx * CFG.TRAJ_DT;
        const ny2 = py + vy * CFG.TRAJ_DT;
        const ray = terrain.raycast(px, py, nx2, ny2);
        px = nx2; py = ny2;
        if (ray.hit || py > terrain.height || px < 0 || px > terrain.width) {
          out.push({ x: ray.x, y: ray.y });
          return out;
        }
      }
      out.push({ x: px, y: py });
    }
    return out;
  }

  destroy() {
    const i = this.scene.input;
    i.off('pointerdown', this.onDown, this);
    i.off('pointermove', this.onMove, this);
    i.off('pointerup', this.onUp, this);
    i.off('pointerupoutside', this.onUp, this);
    this.gfx.destroy();
    this.info.destroy();
    if (this.crosshair) this.crosshair.destroy();
  }
}
