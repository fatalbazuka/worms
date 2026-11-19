import { CFG, DEPTH } from '../config.js';
import { has } from '../core/assets.js';
import { isDesktop } from '../platform/device.js';
import { SPRING_LAUNCH } from '../entities/Spring.js';

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
 * 3. Рогатка — на арене с крюком (scene.slingAim, по умолчанию; в меню
 *    можно вернуть первые две), вместо первых двух на телефоне: палец ставится на бойца и тянется НАЗАД, от цели; длина
 *    натяжения — сила, отпустил — выстрел. Палец при этом не закрывает то,
 *    куда летит снаряд. Натяжение меряется в экранных пикселях.
 *
 *    Главный способ — рычаг над прыжком (Hud._buildSlingPad): тянешь его,
 *    натягивается рогатка у бойца. В бойца попадать не надо, и мазок по
 *    рычагу камерой не считается: рычаг ни для чего другого не нужен.
 *
 * Крюк (там же): касание мимо бойца без движения — трос в эту сторону.
 * Пока палец прижат, виден пунктир до точки зацепа; повёл пальцем — это
 * уже протяжка камеры, крюк отменён.
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
    // Своя сплит-ракета в полёте: тап по полю делит её
    if (this.scene.trySplit?.()) return;
    if (this.desktop) { this._mouseDown(pointer); return; }

    const w = this.worm;
    const canAim = this.scene.canPlayerAct() && w && w.alive;
    const o = this.origin();
    // pointer.worldX смотрит на камеру неба — мировую точку берём у рига
    const p = this.scene.rig.worldPoint(pointer);

    if (this.scene.slingAim) {
      // Рычаг: касание в нём — всегда натяжение, без угадывания по скорости
      // Тренировка: до шага «Выстрел» рычаг заперт
      const locked = Boolean(this.scene.coach?.lockShot);
      if (this.scene.hud.padHit?.(pointer)) {
        if (canAim && !locked && !w.zip && !this.scene.turn.retreating) {
          this.mode = 'aim';
          this.pad = true;
          this._lastStep = 0;
          this.startX = pointer.x;
          this.startY = pointer.y;
          this.dragX = 0; this.dragY = 0;
          this.armed = true;
          this.downAt = performance.now() - CFG.SLING_MIN_HOLD;
          this.wasOut = false;
          this.scene.haptic?.('tap');
        }
        return;
      }
      // Рогатка: хват и натяжение — в экранных пикселях, зум не мешает
      const rig = this.scene.rig;
      const sx = (o.x - rig.viewLeft) * rig.zoom, sy = (o.y - rig.viewTop) * rig.zoom;
      const grab = canAim && !locked && !w.zip && !this.scene.turn.retreating
        && Math.hypot(pointer.x - sx, pointer.y - sy) <= CFG.SLING_GRAB;
      if (grab) {
        this.mode = 'aim';
        this._lastStep = 0;
        this.startX = pointer.x;
        this.startY = pointer.y;
        this.dragX = 0; this.dragY = 0;
        // Пока не ясно, натяжение это или мазок по камере, начавшийся на
        // бойце: решит скорость пальца в первые полторы десятых секунды
        this.armed = false;
        this.downAt = performance.now();
        this.downPointer = { x: pointer.x, y: pointer.y };
        this.wasOut = false;
      } else {
        this._beginPan(pointer);
      }
      return;
    }

    const near = canAim && Math.hypot(p.x - o.x, p.y - o.y) <= CFG.AIM_GRAB_RADIUS;

    if (near) {
      this.mode = 'aim';
      this.startX = p.x;
      this.startY = p.y;
      this.dragX = 0; this.dragY = 0;
    } else {
      this._beginPan(pointer);
    }
  }

  /**
   * Касание мимо бойца: протяжка камеры. Там, где есть крюк, она начинается
   * не сразу, а когда палец действительно поехал, — до того это возможный
   * тап, то есть крюк.
   */
  _beginPan(pointer) {
    this.mode = 'pan';
    if (this.scene.hookPerTurn > 0) {
      this.tap = { x: pointer.x, y: pointer.y, moved: false, at: performance.now() };
    } else {
      this.tap = null;
      this.scene.rig.panStart(pointer);
    }
  }

  onMove(pointer) {
    if (this.desktop && this.mode !== 'pan') this.aimAtPointer(pointer);
    if (!this.mode || !pointer.isDown) return;

    if (this.mode === 'pan') {
      if (this.tap && !this.tap.moved) {
        if (Math.hypot(pointer.x - this.tap.x, pointer.y - this.tap.y) < CFG.TAP_MOVE) return;
        this.tap.moved = true;
        this.scene.rig.panStart(pointer);
      }
      this.scene.rig.panMove(pointer);
      return;
    }
    if (this.scene.rig.pinching) { this.cancel(); return; }

    if (this.scene.slingAim && this.pad) {
      // Рычаг короче рогатки: его ход растягиваем до полной силы рогатки
      const dx = pointer.x - this.startX, dy = pointer.y - this.startY;
      this.scene.hud.padPull = { dx, dy };
      // Палец на круге «✕» — отпустит без выстрела
      const hud = this.scene.hud;
      const inCancel = hud.padCancelHit?.(pointer) ?? false;
      if (inCancel && !hud.padCancelOn) this.scene.haptic?.('warn');
      hud.padCancelOn = inCancel;
      const k = CFG.SLING_MAX / CFG.SLING_PAD_MAX;
      this.dragX = dx * k; this.dragY = dy * k;
      if (Math.hypot(this.dragX, this.dragY) > CFG.SLING_MIN) this.wasOut = true;
      return;
    }
    if (this.scene.slingAim) {
      this.dragX = pointer.x - this.startX;
      this.dragY = pointer.y - this.startY;
      const len = Math.hypot(this.dragX, this.dragY);
      if (!this.armed) {
        const quick = performance.now() - this.downAt < CFG.SLING_FLICK_MS;
        if (quick && len > CFG.SLING_FLICK_PX) {
          // Быстрый мазок: это камеру тянули. Переводим в протяжку с той
          // точки, где палец коснулся, — кадр не дёрнется
          this.mode = 'pan';
          this.tap = null;
          this.dragX = 0; this.dragY = 0;
          this.scene.rig.panStart(this.downPointer);
          this.scene.rig.panMove(pointer);
          return;
        }
        if (!quick) this.armed = true;
      }
      if (len > CFG.SLING_MIN) this.wasOut = true;
      return;
    }
    const p = this.scene.rig.worldPoint(pointer);
    this.dragX = p.x - this.startX;
    this.dragY = p.y - this.startY;
  }

  onUp() {
    this.scene.rig.panEnd();
    // Палец не двигался и не задержался — это тап: трос в сторону точки.
    // Подержал и отпустил — передумал, ничего не делаем
    if (this.mode === 'pan' && this.tap && !this.tap.moved
      && performance.now() - this.tap.at < CFG.TAP_TIME) {
      const p = this.scene.rig.worldPoint(this.tap);
      this.scene.tryHook(p.x, p.y);
    }
    this.tap = null;
    if (this.mode === 'charge') this.scene.mouseFire = false;
    const cancelled = this.pad && this.scene.hud.padCancelOn;
    if (this.pad) { this.pad = false; this.scene.hud.padPull = null; this.scene.hud.padCancelOn = false; }
    if (this.mode === 'aim' && cancelled) {
      this.mode = null;
      this.dragX = 0; this.dragY = 0;
      this.gfx.clear();
      return;
    }
    if (this.mode === 'aim') {
      const shot = this.computeShot();
      // Отпустил до того, как стало ясно, что это натяжение, или всё касание
      // было коротким мазком — не стреляем
      if (shot && this.scene.slingAim
        && (!this.armed || performance.now() - this.downAt < CFG.SLING_MIN_HOLD)) {
        this.mode = null;
        this.dragX = 0; this.dragY = 0;
        this.gfx.clear();
        return;
      }
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
        if (this.scene.slingAim) this.scene.fx.sound('twang');
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
    this._beginPan(pointer);
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
    if (this.pad) { this.pad = false; this.scene.hud.padPull = null; this.scene.hud.padCancelOn = false; }
    this.tap = null;
    this.mode = null;
    this.dragX = 0; this.dragY = 0;
    this.gfx.clear();
  }

  /** Вектор выстрела из текущего свайпа, либо null, если свайп слишком короткий. */
  computeShot() {
    const len = Math.hypot(this.dragX, this.dragY);
    if (this.scene.slingAim) {
      // Рогатка: летит в сторону, обратную натяжению
      if (len < CFG.SLING_MIN) return null;
      const k = Math.min(1, (len - CFG.SLING_MIN) / (CFG.SLING_MAX - CFG.SLING_MIN));
      const power = Math.max(CFG.CHARGE_MIN, k) * CFG.AIM_MAX_POWER;
      const dirX = -this.dragX / len, dirY = -this.dragY / len;
      return { vx: dirX * power, vy: dirY * power, power, angle: Math.atan2(-dirY, dirX) };
    }
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
      this.hintLabel?.setVisible(false);
      return;
    }

    // Свайп имеет приоритет; иначе показываем прицел кнопочной схемы
    if (this.mode === 'aim') { this.padHint = null; this.hintLabel?.setVisible(false); this._drawSwipe(); }
    else if (scene.slingAim && !this.desktop && !scene.charging) {
      // У рогатки прицела «в покое» нет: направления ещё никто не задал
      if (this.crosshair) this.crosshair.setVisible(false);
      this._drawSlingHint();
      this._drawHookHints();
      this._drawHookPreview();
    } else {
      this._drawButtonAim(scene.charging ? scene.charge : 0);
      // Кнопочная схема на башне: точки, куда достанет трос, — те же
      if (scene.sling && !this.desktop && !scene.charging) this._drawHookHints();
      this._drawHookPreview();
    }
  }

  /**
   * Подсказка рогатки: «палец» берёт бойца и тянет назад от ближайшего
   * врага, шкала силы растёт в сторону выстрела, палец отпускает — и по
   * кругу. Показывает жест целиком, без единого слова.
   */
  _drawSlingHint() {
    const scene = this.scene;
    const w = this.worm;
    this.padHint = null;
    if (!scene.slingHint || !w || this.tap || w.zip || scene.turn.retreating) return;
    const foes = scene.worms.filter((f) => f.alive && f.team !== w.team);
    if (!foes.length) return;
    const foe = foes.reduce((a, b) =>
      (Math.hypot(b.x - w.x, b.y - w.y) < Math.hypot(a.x - w.x, a.y - w.y) ? b : a));
    // Целимся чуть выше врага — так и надо стрелять навесом
    let dx = foe.x - w.x, dy = foe.centerY - w.centerY - 90;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const t = (scene.time.now % 2000) / 2000;
    const pull = t < 0.15 ? 0 : t < 0.7 ? (t - 0.15) / 0.55 : t < 0.85 ? 1 : 0;
    const k = pull * pull * (3 - 2 * pull);
    const reach = (CFG.SLING_MAX * 0.72 * k) / scene.rig.zoom;
    const o = this.origin();
    const fx = o.x - dx * reach, fy = o.y - dy * reach;
    // Рычаг на экране тянется так же — видно, за что браться
    const padReach = CFG.SLING_PAD_MAX * 0.72 * k;
    this.padHint = { dx: -dx * padReach, dy: -dy * padReach };
    const g = this.gfx;
    if (k > 0.02) {
      g.lineStyle(3, 0xffffff, 0.35).lineBetween(o.x, o.y, fx, fy);
      this._drawPower(o, { x: dx, y: dy }, k * 0.72);
    }
    // «Палец»: кружок с ободком; в момент отпускания вспыхивает
    const released = t >= 0.85;
    g.fillStyle(0xffffff, released ? 0.25 : 0.85).fillCircle(fx, fy, released ? 26 : 17);
    g.lineStyle(3, 0x1a1408, released ? 0.2 : 0.7).strokeCircle(fx, fy, released ? 26 : 17);
  }

  /**
   * Подсказка новичку: до трёх светящихся точек, куда трос точно достанет
   * и где боец удержится. Считается один раз на позицию бойца.
   */
  _hintSpots(w) {
    const key = `${Math.round(w.x)}:${Math.round(w.y)}:${w.hang ?? ''}`;
    if (this._hintKey === key) return this._hints;
    this._hintKey = key;
    const scene = this.scene;
    const out = [];
    for (let k = 0; k < 16 && out.length < 3; k++) {
      // Сначала вверх, потом веером в обе стороны
      const off = Math.ceil(k / 2) * (Math.PI / 10) * (k % 2 ? 1 : -1);
      const a = -Math.PI / 2 + off;
      const anchor = scene.hookAnchor(w, w.x + Math.cos(a) * 200, w.centerY + Math.sin(a) * 200);
      if (!anchor) continue;
      const end = w.zipEnd(anchor.x, anchor.y);
      if (!end.grounded && !end.hang) continue;
      if (Math.hypot(end.x - w.x, end.y - w.y) < 90) continue;
      if (out.some((o) => Math.hypot(o.x - anchor.x, o.y - anchor.y) < 130)) continue;
      out.push(anchor);
    }
    this._hints = out;
    return out;
  }

  _drawHookHints() {
    const scene = this.scene;
    const w = this.worm;
    const on = scene.hookHint && w && !this.tap && scene.canHook() && !scene.turn.retreating;
    if (!on) { this.hintLabel?.setVisible(false); return; }
    const spots = this._hintSpots(w);
    const g = this.gfx;
    const pulse = Math.sin(scene.time.now / 260);
    for (const p of spots) {
      g.lineStyle(3, 0xffe27a, 0.55 + pulse * 0.3).strokeCircle(p.x, p.y, 15 + pulse * 4);
      g.fillStyle(0xffe27a, 0.95).fillCircle(p.x, p.y, 5);
    }
    if (!spots.length) { this.hintLabel?.setVisible(false); return; }
    if (!this.hintLabel) {
      this.hintLabel = scene.rig.world(scene.add.text(0, 0, 'коснись', {
        fontFamily: 'Nunito, system-ui, sans-serif', fontSize: '15px', fontStyle: '800',
        color: '#1a1408', backgroundColor: '#ffe27a', padding: { x: 7, y: 3 },
      }).setOrigin(0.5, 1).setDepth(DEPTH.AIM));
    }
    this.hintLabel.setVisible(true).setPosition(spots[0].x, spots[0].y - 24 - pulse * 3);
  }

  /**
   * Начало дуги для того, что бросают рукой (граната, банан): первые
   * полсекунды полёта тем же счётом, что и у настоящего снаряда. Куда она
   * в итоге ляжет, не видно — только как пойдёт из руки.
   */
  _drawThrowArc(o, vx, vy, weapon) {
    const p = weapon.projectile;
    const terrain = this.scene.terrain;
    const d = Math.hypot(vx, vy) || 1;
    let x = o.x + (vx / d) * CFG.MUZZLE_OFFSET, y = o.y + (vy / d) * CFG.MUZZLE_OFFSET;
    const dt = 1 / 60;
    const steps = 36;
    for (let i = 1; i <= steps; i++) {
      vx += this.scene.wind * (p.windScale ?? 1) * dt;
      vy += CFG.GRAVITY * (p.gravityScale ?? 1) * dt;
      x += vx * dt; y += vy * dt;
      if (terrain.solidAt(x, y)) break;
      if (i % 3) continue;
      this.gfx.fillStyle(0xffffff, 0.9 * (1 - i / (steps + 6)));
      this.gfx.fillCircle(x, y, 3.2);
    }
  }

  /** Пока палец прижат и не поехал — пунктир троса до точки зацепа. */
  _drawHookPreview() {
    const scene = this.scene;
    const w = this.worm;
    if (!this.tap || this.tap.moved || !w || !scene.canHook()) return;
    const p = scene.rig.worldPoint(this.tap);
    const a = scene.hookAnchor(w, p.x, p.y);
    const g = this.gfx;
    const ox = w.x, oy = w.centerY;
    const tx = a ? a.x : p.x, ty = a ? a.y : p.y;
    const d = Math.hypot(tx - ox, ty - oy) || 1;
    const n = Math.min(Math.floor(d / 14), Math.floor(CFG.HOOK_RANGE / 14));
    g.fillStyle(a ? 0xe8d9a8 : 0xff8a8a, a ? 0.95 : 0.6);
    for (let i = 1; i <= n; i++) {
      const k = (i * 14) / d;
      g.fillCircle(ox + (tx - ox) * k, oy + (ty - oy) * k, 2.4);
    }
    if (a) {
      g.lineStyle(3, 0xe8d9a8, 1).strokeCircle(a.x, a.y, 9);
      g.fillStyle(0xe8d9a8, 1).fillCircle(a.x, a.y, 3.5);
    }
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
    // Палец на «✕» — выстрела не будет, прицел не рисуем
    if (this.pad && this.scene.hud.padCancelOn) { this.crosshair?.setVisible(false); return; }
    const shot = this.computeShot();
    // Рогатка: пока палец в круге отмены, круг виден — отпусти здесь, и
    // выстрела не будет. Особенно ясно, когда натянул и вернул обратно
    if (this.scene.slingAim) {
      const o = this.origin();
      const r = CFG.SLING_MIN / this.scene.rig.zoom;
      const inside = !shot;
      // Красным — только когда это правда отмена (натянул и вернул). С
      // первого касания красное кольцо под пальцем пугало и прятало прицел
      const cancel = inside && this.wasOut;
      this.gfx.lineStyle(3, cancel ? 0xff8a8a : 0xffffff, cancel ? 0.85 : 0.22).strokeCircle(o.x, o.y, r);
      if (inside && this.wasOut) {
        this.gfx.lineStyle(4, 0xff8a8a, 0.9);
        this.gfx.lineBetween(o.x - 9, o.y - 9, o.x + 9, o.y + 9);
        this.gfx.lineBetween(o.x + 9, o.y - 9, o.x - 9, o.y + 9);
      }
    }
    if (!shot) return;

    // Свайп — тот же прицел и та же шкала силы, только направление и сила
    // берутся из движения пальца
    const o = this.origin();
    const len = Math.hypot(shot.vx, shot.vy);
    const d = { x: shot.vx / len, y: shot.vy / len };
    this._ensureCrosshair();
    this.crosshair.setVisible(true);
    // Рогатка: крестик за кольцом и за пальцем, в экранных px — на отдалении
    // он не съёживается под палец; к нему — пунктир направления
    const zoom = this.scene.rig.zoom;
    const ray = this.scene.slingAim
      ? Math.max(CFG.AIM_RAY_LEN, (CFG.SLING_MIN + 50) / zoom) : CFG.AIM_RAY_LEN;
    this.crosshair.setPosition(o.x + d.x * ray, o.y + d.y * ray);
    if (this.scene.slingAim) {
      this.gfx.fillStyle(0xffffff, 0.6);
      for (let s = 22; s < ray - 10; s += 12) this.gfx.fillCircle(o.x + d.x * s, o.y + d.y * s, 2.2 / zoom);
    }
    this._drawPower(o, d, shot.power / CFG.AIM_MAX_POWER);
    if (this.scene.slingAim) {
      // Резинка «щёлкает» на каждом шаге шкалы — сила слышна и чувствуется
      // в руке, глаз можно держать на цели
      const stepN = Math.ceil((shot.power / CFG.AIM_MAX_POWER) * POWER_BLOBS.length);
      if (stepN !== this._lastStep) {
        this._lastStep = stepN;
        this.scene.fx.sound('stretch', { power: shot.power / CFG.AIM_MAX_POWER });
        if (stepN % 4 === 0) this.scene.haptic?.('select');
      }
      // Резинка рогатки: от бойца назад, к пальцу
      const pull = Math.min(Math.hypot(this.dragX, this.dragY), CFG.SLING_MAX) / this.scene.rig.zoom;
      this.gfx.lineStyle(3, 0xffffff, 0.35)
        .lineBetween(o.x, o.y, o.x - d.x * pull, o.y - d.y * pull);
      this.gfx.fillStyle(0xffffff, 0.5).fillCircle(o.x - d.x * pull, o.y - d.y * pull, 7);
      const pr = this.scene.turn.weapon.projectile;
      if (pr?.fuse > 0 && pr.bounciness > 0) this._drawThrowArc(o, shot.vx, shot.vy, this.scene.turn.weapon);
      // Батут бросает самого бойца: начало его дуги, без ветра
      if (this.scene.turn.weapon.id === 'spring') {
        this._drawThrowArc(o, shot.vx * SPRING_LAUNCH, shot.vy * SPRING_LAUNCH, { projectile: { windScale: 0 } });
      }
    }
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
    this.hintLabel?.destroy();
    if (this.crosshair) this.crosshair.destroy();
  }
}
