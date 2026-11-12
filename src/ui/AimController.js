import { CFG, DEPTH } from '../config.js';
import { has } from '../core/assets.js';
import { isDesktop } from '../platform/device.js';

/**
 * Шкала силы как в Worms Armageddon: 16 «шариков» от бойца вдоль прицела,
 * каждый следующий крупнее, от тёмно-красного к бледно-жёлтому. Радиусы и
 * цвета сняты с оригинального спрайта (raw/general/Effects/blob.png), а
 * рисуются своими средствами — сам спрайт в игру не копируется.
 */
const POWER_BLOBS = [
  [3.5, 0xaa0000], [4.0, 0xae0f06], [4.5, 0xb41f0e], [5.0, 0xb82f16],
  [5.5, 0xbe3f1e], [6.0, 0xc44f24], [6.5, 0xc85f2c], [7.0, 0xce6f34],
  [7.5, 0xd47f3c], [8.0, 0xd88f42], [8.5, 0xde9f4a], [9.0, 0xe4af52],
  [9.5, 0xe8bf5a], [10.0, 0xeecf60], [10.5, 0xf4df68], [11.0, 0xf8ef70],
];
const BLOB_START = 14;     // от центра бойца до первого шарика
const BLOB_STEP = 4.6;     // шаг между шариками: соседние перекрываются клином

/**
 * Прицеливание и протяжка камеры.
 *
 * Схем две, работают одновременно:
 *
 * 1. Кнопочная (основная, удобна на телефоне): угол крутится кнопками ▲▼
 *    и хранится в сцене, сила набирается удержанием «Огонь». Палец при
 *    этом лежит в углу экрана и ничего не закрывает.
 * 2. Свайп по бойцу: направление задаёт угол, длина — силу, отпустили =
 *    выстрел. Быстрее на мыши, но на тач-экране кисть накрывает поле.
 *
 * Показано как в оригинале: перед бойцом прицел-крестик на постоянном
 * расстоянии, а пока копится сила — шкала «шариков» вдоль прицела. Ни
 * траектории, ни точки падения, ни цифр угла и силы: куда упадёт снаряд с
 * поправкой на ветер, игрок угадывает сам — в этом и игра. Исключение —
 * оружие с целью (авиаудар, телепорт): там метка цели, как выбор точки на
 * карте в оригинале.
 */
export class AimController {
  constructor(scene) {
    this.scene = scene;
    this.mode = null;          // 'aim' | 'pan' | null
    this.startX = 0; this.startY = 0;
    this.dragX = 0; this.dragY = 0;
    this.camStart = 0;

    this.gfx = scene.rig.world(scene.add.graphics().setDepth(DEPTH.AIM));

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
      if (this.crosshair) this.crosshair.setVisible(false);
      return;
    }

    // Свайп имеет приоритет; иначе показываем прицел кнопочной схемы
    if (this.mode === 'aim') this._drawSwipe();
    else this._drawButtonAim(scene.charging ? scene.charge : 0);
  }

  /** Прицел и — во время набора силы — шкала силы для кнопочной схемы. */
  _drawButtonAim(charge) {
    const scene = this.scene;
    const o = this.origin();
    const d = scene.aimDirection();
    const weapon = scene.turn.weapon;

    this._ensureCrosshair();
    this.crosshair.setVisible(true);
    this.crosshair.setPosition(o.x + d.x * CFG.AIM_RAY_LEN, o.y + d.y * CFG.AIM_RAY_LEN);

    if (!(charge > 0)) return;
    // Пошёл заряд — стрелка «чей ход» своё сказала, убираем её
    if (this.worm?.marker?.visible) this.worm.setActiveMarker(false);

    this._drawPower(o, d, charge);
    if (weapon.targeted) {
      const speed = charge * CFG.AIM_MAX_POWER;
      this._drawTarget(d.x * speed, d.y * speed, weapon);
    }
  }

  /** Шкала силы: столько шариков, сколько набрано, от бойца вдоль прицела. */
  _drawPower(o, d, charge) {
    const n = Math.min(POWER_BLOBS.length, Math.ceil(charge * POWER_BLOBS.length));
    for (let i = 0; i < n; i++) {
      const [r, color] = POWER_BLOBS[i];
      const dist = BLOB_START + i * BLOB_STEP;
      this.gfx.fillStyle(color, 1);
      this.gfx.fillCircle(o.x + d.x * dist, o.y + d.y * dist, r * 0.8);
    }
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
    if (this.worm?.marker?.visible) this.worm.setActiveMarker(false);
    const shot = this.computeShot();
    if (!shot) return;

    // Свайп — тот же прицел и та же шкала силы, только направление и сила
    // берутся из движения пальца
    const o = this.origin();
    const len = Math.hypot(shot.vx, shot.vy);
    const d = { x: shot.vx / len, y: shot.vy / len };
    this._ensureCrosshair();
    this.crosshair.setVisible(true);
    this.crosshair.setPosition(o.x + d.x * CFG.AIM_RAY_LEN, o.y + d.y * CFG.AIM_RAY_LEN);
    this._drawPower(o, d, shot.power / CFG.AIM_MAX_POWER);
    const weapon = this.scene.turn.weapon;
    if (weapon.targeted) this._drawTarget(shot.vx, shot.vy, weapon);
  }

  destroy() {
    const i = this.scene.input;
    i.off('pointerdown', this.onDown, this);
    i.off('pointermove', this.onMove, this);
    i.off('pointerup', this.onUp, this);
    i.off('pointerupoutside', this.onUp, this);
    this.gfx.destroy();
    if (this.crosshair) this.crosshair.destroy();
  }
}
