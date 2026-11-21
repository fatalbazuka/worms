import { CFG, canvasSize } from '../config.js';

/**
 * Три камеры вместо одной.
 *
 * Одна камера не годится: как только мир начинает масштабироваться, вместе
 * с ним уезжают небо и весь интерфейс — кнопки уползают в середину экрана
 * крошечными, по краям пустота. Поэтому рендер разделён:
 *
 *   bgCam    — небо. Не масштабируется, всегда на весь экран.
 *   worldCam — земля, бойцы, снаряды, эффекты. Только она зумится и скроллится.
 *   uiCam    — HUD поверх. Тоже не масштабируется и не трясётся при взрывах.
 *
 * Камеры рисуются в порядке добавления, поэтому bgCam (это cameras.main)
 * идёт первой. Принадлежность задаётся не слоями, а вызовом ignore на
 * каждый объект: порядок отрисовки по depth остаётся ровно прежним, а
 * забытый объект сразу заметен — он рисуется всеми тремя камерами.
 *
 * Важно: pointer.worldX/worldY Phaser считает относительно cameras.main,
 * то есть теперь относительно неба. Мировые координаты указателя брать
 * только через worldPoint().
 *
 * Безопасная область. Канвас занимает весь экран, включая «чёлку» и
 * полосу под кнопками Telegram: небо и мир рисуются до краёв. Интерфейс
 * же под кнопками не нужен, поэтому uiCam получает вьюпорт, сдвинутый
 * внутрь на рамку CFG.FRAME, а его собственные координаты остаются
 * (0,0)…(VIEW_W,VIEW_H) — HUD ничего про рамку не знает.
 */
export class CameraRig {
  constructor(scene) {
    this.scene = scene;
    const [W, H] = canvasSize();
    const f = CFG.FRAME;

    this.bgCam = scene.cameras.main;
    this.worldCam = scene.cameras.add(0, 0, W, H);
    this.uiCam = scene.cameras.add(f.left, f.top, CFG.VIEW_W, CFG.VIEW_H);

    // Границы не ставим: setBounds вместе с зумом дерётся с ручным
    // скроллом, поэтому clamp считаем сами.
    this.zoom = 1;
    this.baseZoom = 1;        // обычный масштаб партии (у башни свой)
    this.manual = false;      // камеру увели рукой
    this.idle = 0;
    this.pinching = false;
    this.panning = false;

    scene.input.on('wheel', this._onWheel, this);
  }

  /**
   * Экран сменил размер (поворот телефона, панель браузера уехала).
   * Своим камерам размер надо задать руками: автоматически подстраивается
   * только главная.
   */
  resize() {
    const [W, H] = canvasSize();
    const f = CFG.FRAME;
    this.bgCam.setSize(W, H);
    this.worldCam.setSize(W, H);
    this.uiCam.setViewport(f.left, f.top, CFG.VIEW_W, CFG.VIEW_H);
  }

  /** Размер мировой камеры — весь канвас, с рамкой. */
  get W() { return this.worldCam.width; }
  get H() { return this.worldCam.height; }

  // ------------------------------------------------------- принадлежность

  /** Объект мира: его не рисуют ни небо, ни интерфейс. */
  world(o) { this.bgCam.ignore(o); this.uiCam.ignore(o); return o; }

  /** Объект интерфейса: экранные координаты, без зума и тряски. */
  ui(o) { this.bgCam.ignore(o); this.worldCam.ignore(o); return o; }

  /** Фон: только небо. */
  bg(o) { this.worldCam.ignore(o); this.uiCam.ignore(o); return o; }

  /**
   * Короткий «наезд» на взрыв: мир на мгновение приближается и отпускает.
   * Меняется только зум самой камеры, расчёты вида идут по прежнему
   * масштабу — доли секунды картинка чуть крупнее, и только.
   */
  punch(amount = 0.03, ms = 170) {
    const cam = this.worldCam;
    const st = { k: 1 + amount };
    this.punchTween?.stop();
    this.punchTween = this.scene.tweens.add({
      targets: st, k: 1, duration: ms, ease: 'Quad.easeOut',
      onUpdate: () => cam.setZoom(this.zoom * st.k),
      onComplete: () => cam.setZoom(this.zoom),
    });
  }

  /** Трясём только мир — интерфейс при взрывах теперь стоит на месте. */
  shake(duration, intensity) { this.worldCam.shake(duration, intensity); }

  /**
   * Мировая точка под указателем.
   *
   * Считаем сами, а не через positionToCamera: тот опирается на матрицу
   * камеры, которая обновляется только при отрисовке, и сразу после смены
   * зума (пинч, колесо) отдаёт координаты от старого масштаба. Поворота у
   * камеры нет, так что формула точная.
   */
  worldPoint(pointer) {
    return {
      x: this.viewLeft + pointer.x / this.zoom,
      y: this.viewTop + pointer.y / this.zoom,
    };
  }

  // ------------------------------------------------------------------ зум

  get visibleW() { return this.W / this.zoom; }
  get visibleH() { return this.H / this.zoom; }

  /**
   * Масштаб, при котором в кадр влезает вся карта: по ширине, а у высокой
   * карты — ещё и по высоте. Обычной карте (3200x720) второе условие не
   * мешает: её высота и так равна экрану.
   */
  get fitZoom() { return Math.min(this.W / CFG.WORLD_W, this.H / CFG.WORLD_H); }

  /** Мир выше кадра: по вертикали есть куда вести камеру. */
  get tall() { return this.visibleH < CFG.WORLD_H; }

  // --- Видимая область ---
  // Внимание: cam.scrollX/scrollY — это НЕ левый верхний угол вида. Phaser
  // масштабирует вокруг центра камеры, поэтому угол считается отдельно,
  // иначе при зуме камера уезжает мимо мира.
  get viewLeft() { return this.worldCam.scrollX + (this.W - this.visibleW) / 2; }
  get viewTop() { return this.worldCam.scrollY + (this.H - this.visibleH) / 2; }

  setViewLeft(left) {
    this.worldCam.scrollX = this.clampLeft(left) + (this.visibleW - this.W) / 2;
  }

  setViewTop(top) {
    this.worldCam.scrollY = top + (this.visibleH - this.H) / 2;
  }

  /** Координата мировой точки на канвасе — нужна указателям у краёв. */
  screenX(worldX) { return (worldX - this.viewLeft) * this.zoom; }

  /** То же в координатах интерфейса: канвас минус рамка. */
  uiX(worldX) { return this.screenX(worldX) - CFG.FRAME.left; }

  setZoom(z, anchorX = null, anchorY = null) {
    const next = Phaser.Math.Clamp(z, CFG.ZOOM_MIN, CFG.ZOOM_MAX);
    if (next === this.zoom) return;

    // Точка мира под пальцем (или под курсором) должна остаться на месте,
    // иначе зум «уезжает» и им невозможно пользоваться прицельно.
    const ax = anchorX ?? this.W / 2;
    const ay = anchorY ?? this.H / 2;
    const worldUnderAnchor = this.viewLeft + ax / this.zoom;
    const worldYUnderAnchor = this.viewTop + ay / this.zoom;

    this.zoom = next;
    this.worldCam.setZoom(next);
    this.setViewLeft(worldUnderAnchor - ax / next);
    this.setViewTop(this.clampTop(worldYUnderAnchor - ay / next));
  }

  toggleOverview() {
    const overview = this.zoom > this.fitZoom * 1.05;
    this.setZoom(overview ? Math.max(CFG.ZOOM_MIN, this.fitZoom) : this.baseZoom);
    this.manual = overview;   // в обзоре камера не дёргается за бойцом
    this.idle = 0;
  }

  _onWheel(pointer, objs, dx, dy) {
    this.setZoom(this.zoom * (dy > 0 ? 0.9 : 1.1), pointer.x, pointer.y);
    this.manual = true;
    this.idle = 0;
  }

  /** Пинч двумя пальцами. Опрашивается, а не ловится событиями. */
  _updatePinch() {
    const input = this.scene.input;
    const p1 = input.pointer1, p2 = input.pointer2;
    if (!p1 || !p2 || !p1.isDown || !p2.isDown) { this.pinching = false; return; }

    const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
    const mid = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    if (!this.pinching) {
      this.pinching = true;
      this.pinchDist = dist;
      this.pinchZoom = this.zoom;
      this.scene.aim.cancel();   // второй палец отменяет начатое прицеливание
      this.manual = true;
      this.idle = 0;
      this.pinchMid = { x: mid, y: midY };
      return;
    }
    if (this.pinchDist > 12) this.setZoom(this.pinchZoom * (dist / this.pinchDist), mid, midY);
    // Два пальца ещё и двигают кадр: в схеме «с любого места» один палец
    // в свой ход занят рогаткой, камере нужен свой жест
    if (this.pinchMid) {
      this.setViewLeft(this.viewLeft - (mid - this.pinchMid.x) / this.zoom);
      this.setViewTop(this.clampTop(this.viewTop - (midY - this.pinchMid.y) / this.zoom));
    }
    this.pinchMid = { x: mid, y: midY };
    this.idle = 0;
  }

  // --------------------------------------------------------------- скролл

  clampLeft(left) {
    const vw = this.visibleW;
    if (vw >= CFG.WORLD_W) return (CFG.WORLD_W - vw) / 2;  // карта уже кадра
    return Phaser.Math.Clamp(left, 0, CFG.WORLD_W - vw);
  }

  /**
   * Вертикаль ведём сами. Когда в кадр влезает больше мира, чем в нём есть,
   * центрируемся на полосе земли: сверху остаётся небо, снизу — вода
   * (её прямоугольник специально уходит намного ниже мира).
   */
  _applyScrollY(targetY, k = 1) {
    const want = this.clampTop((targetY ?? CFG.WORLD_H / 2) - this.visibleH / 2);
    this.setViewTop(k >= 1 ? want : this.viewTop + (want - this.viewTop) * k);
  }

  /** Допустимый верх кадра для желаемого. */
  clampTop(top) {
    const vh = this.visibleH;
    // Центрируемся на полосе земли, но не опускаем вид ниже нуля: при
    // зуме 1 высота вида ровно равна миру, и любое смещение резало бы
    // небо сверху и показывало лишнюю воду снизу.
    if (vh >= CFG.WORLD_H) return Math.min(CFG.WORLD_FOCUS_Y - vh / 2, 0);
    return Phaser.Math.Clamp(top, 0, CFG.WORLD_H - vh);
  }

  // ------------------------------------------------------------ протяжка

  panStart(pointer) {
    this.panning = true;
    this.panPointerX = pointer.x;
    this.panPointerY = pointer.y;
    this.panLeft = this.viewLeft;
    this.panTop = this.viewTop;
    this.manual = true;
    this.idle = 0;
  }

  panMove(pointer) {
    if (!this.panning || this.pinching) return;
    this.setViewLeft(this.panLeft - (pointer.x - this.panPointerX) / this.zoom);
    if (this.tall) this.setViewTop(this.clampTop(this.panTop - (pointer.y - this.panPointerY) / this.zoom));
    this.idle = 0;
  }

  panEnd() { this.panning = false; }

  /** Снять ручной режим и мгновенно навестись. */
  focus(target) {
    this.manual = false;
    this.idle = 0;
    if (!target) return;
    this.setViewLeft(target.x - this.visibleW / 2);
    this._applyScrollY(target.y ?? target.centerY);
  }

  /** Поставить кадр по центру между точками (начало хода). */
  frame(centerX, centerY) {
    this.manual = false;
    this.idle = 0;
    this.setViewLeft(centerX - this.visibleW / 2);
    this._applyScrollY(centerY);
  }

  // ------------------------------------------------------------------ цикл

  update(dt, realDt, target, follow) {
    this._updatePinch();

    if (this.manual) {
      if (this.scene.input.activePointer.isDown || this.pinching) this.idle = 0;
      else this.idle += realDt;
      // В обзоре камера остаётся там, где её поставили
      if (this.idle < CFG.CAM_IDLE_RETURN || this.zoom <= this.fitZoom * 1.05) {
        // Высокую карту по вертикали тоже ведут рукой — там её не трогаем
        if (this.tall) this.setViewTop(this.clampTop(this.viewTop));
        else this._applyScrollY(target ? (target.y ?? target.centerY) : null);
        return;
      }
      this.manual = false;
    }

    if (target) {
      let desired = null;
      if (follow === 'center') {
        desired = target.x - this.visibleW / 2;
      } else {
        // Мёртвая зона: камера трогается, только когда цель подходит к краю
        const sx = this.screenX(target.x);
        const m = CFG.CAM_DEADZONE;
        if (sx < m) desired = target.x - m / this.zoom;
        else if (sx > this.W - m) desired = target.x - (this.W - m) / this.zoom;
      }
      if (desired !== null) {
        const lerp = follow === 'center' ? CFG.CAM_LERP_FAST : CFG.CAM_LERP;
        const to = this.clampLeft(desired);
        this.setViewLeft(this.viewLeft + (to - this.viewLeft) * Math.min(1, lerp * dt * 60));
      }
      // По вертикали за целью идём плавно, когда есть куда идти: рывок по
      // тросу на три этажа иначе дёргал бы кадр
      this._applyScrollY(target.y ?? target.centerY,
        this.tall ? Math.min(1, CFG.CAM_LERP_FAST * dt * 60) : 1);
    }
  }

  destroy() {
    this.scene.input.off('wheel', this._onWheel, this);
  }
}
