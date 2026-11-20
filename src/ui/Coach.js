import { CFG, DEPTH } from '../config.js';
import { WEAPONS } from '../weapons/index.js';
import { font } from './theme.js';
import { haptic } from '../platform/telegram.js';

/**
 * Пошаговая тренировка новичка — в испытании «Первый выстрел» (match.tutorial).
 * Сначала самое весёлое — взрыв, потом остальное, по одному приёму за раз:
 *
 *   1. shoot  — граната уже в руке: потянуть рычаг от мишени и отпустить;
 *   2. walk   — стиком дойти до флажка;
 *   3. jump   — прыжок (рывок стика вверх или круглая кнопка);
 *   4. hook   — коснуться светящейся точки: трос подтянет туда;
 *   5. finish — добить мишень.
 *
 * Мишень живучая (100 жизней, граната снимает 50), так что первый выстрел
 * её почти никогда не добивает, а если добьёт — тоже хорошо: урок короче,
 * ходьбе и тросу научат подсказки в следующих боях.
 *
 * Шаг засчитывается сам, как только игрок это сделал. Над шагом — панель с
 * номером и одной строкой, к нужному месту прыгает стрелка. Пока целишься,
 * ход не сгорает; на шагах ходьбы, прыжка и троса рычаг заперт — случайно
 * выстрелить посреди урока значит пропустить его. Звезда за испытание и
 * всё, что дальше, — как у обычного «Первого выстрела».
 */
const STEPS = [
  { id: 'shoot', title: 'Выстрел', text: 'Тяни жёлтый рычаг ОТ мишени и отпусти' },
  { id: 'walk', title: 'Ходьба', text: 'Веди стик внизу слева в сторону — дойди до флажка' },
  { id: 'jump', title: 'Прыжок', text: 'Рывок стика вверх или круглая кнопка справа — прыжок' },
  { id: 'hook', title: 'Трос', text: 'Коснись светящейся точки — трос подтянет туда' },
  { id: 'finish', title: 'Добей', text: 'Мишень ещё стоит — тяни рычаг и добей её!' },
];
const SHOOTS = new Set(['shoot', 'finish']);

export class Coach {
  constructor(scene) {
    this.scene = scene;
    this.step = 0;
    this.items = [];
    this.flag = null;
    this.doneAt = 0;
    this.misses = 0;
    this._build();
  }

  get current() { return STEPS[this.step] ?? null; }
  get finished() { return this.step >= STEPS.length; }

  /** Рычаг и натяжка с бойца — только на шагах выстрела. */
  get lockShot() { return !this.finished && !SHOOTS.has(this.current?.id); }
  /** Подсказки игры — только к своему шагу, иначе две вещи сразу. */
  get wantsSlingHint() { return SHOOTS.has(this.current?.id); }
  get wantsHookHint() { return this.current?.id === 'hook'; }

  _build() {
    const s = this.scene;
    const W = CFG.VIEW_W;
    const hud = s.hud;
    const topH = (hud.strip ? hud.strip.y + hud.strip.r + 10 : 110);
    const L = this._layout(W, topH);
    const y = L.y;
    const fix = (o, d = DEPTH.HUD + 6) => { s.rig.ui(o.setScrollFactor(0).setDepth(d)); this.items.push(o); return o; };
    this.panel = fix(s.add.graphics());
    this.titleText = fix(s.add.text(L.cx, y + L.titleY, '', font(L.title, 800, '#5a4413')).setOrigin(0.5, 0), DEPTH.HUD + 7);
    this.bodyText = fix(s.add.text(L.cx, y + L.bodyY, '', font(L.body, 800, '#1a1408'))
      .setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(L.w - L.pad * 2), DEPTH.HUD + 7);
    this.arrow = fix(s.add.graphics(), DEPTH.HUD + 8);
    this.cheer = fix(s.add.text(L.cx, L.cheerY, '', font(40, 800, '#8ef0a0')).setOrigin(0.5).setStroke('#10131a', 6).setAlpha(0), DEPTH.HUD + 8);
    // Лишнее на первой минуте — приглушить: верхняя полоса (ветер, команды,
    // лента оружия) и плашка троса, пока до неё не дошли. Касания проходят
    // насквозь: это только тень
    this.dimTop = fix(s.add.rectangle(0, -400, W, topH + 400, 0x0b1021, 0.6).setOrigin(0, 0), DEPTH.HUD + 5);
    const hp = hud.hookPlate;
    this.dimHook = hp
      ? fix(s.add.rectangle(hp.x, hp.y, hp.displayWidth + 8, hp.displayHeight + 8, 0x0b1021, 0.6), DEPTH.HUD + 5)
      : null;
    this.flagGfx = s.rig.world(s.add.graphics().setDepth(DEPTH.WORM - 2));
    this.items.push(this.flagGfx);
    this.layout = L;
    this.panelY = y;
    this._show();
    // Низ панели нужен сразу: плашка первого хода встаёт под неё
    this.panelBottom = y + this._panelH();
  }

  /**
   * Где панель. В портрете — во всю ширину под лентой оружия: экран
   * высокий, боец и мишень далеко внизу. В альбомной высота всего 720, и
   * та же панель на y=214 ложилась ровно на этаж бойца, а плашка хода под
   * ней — на него самого. Поэтому в альбомной панель компактная и встаёт
   * в верхнюю полосу, между лентой оружия и кнопками «☺ ⋯»: полоса на
   * время обучения всё равно приглушена.
   */
  _layout(W, topH) {
    const hud = this.scene.hud;
    const port = { y: 214, x: 28, w: W - 56, title: 23, body: 28, titleY: 14, bodyY: 50, pad: 17, tail: 18 };
    if (W <= CFG.VIEW_H) return { ...port, cx: W / 2, cheerY: port.y + 190 };
    const st = hud.strip;
    const left = (hud.buttons?.arsenal?.x ?? 0) + 30 + 16;
    const right = W - 14 - 60 - 68 - 18;
    const land = { title: 18, body: 24, titleY: 7, bodyY: 29, pad: 22, tail: 9 };
    // Полосы не хватает (узкий экран) — под ней, но тоже компактно
    const inStrip = st && right - left >= 520;
    const x = inStrip ? left : 28;
    const w = inStrip ? right - left : W - 56;
    const y = inStrip ? st.y - st.r - 4 : topH + 4;
    return { ...land, x, w, y, cx: x + w / 2, cheerY: Math.round(CFG.VIEW_H * 0.3) + 4 };
  }

  _panelH() {
    const L = this.layout;
    return L.bodyY + this.bodyText.height + L.tail;
  }

  _show() {
    const st = this.current;
    if (!st) return;
    this.titleText.setText(`Шаг ${this.step + 1} из ${STEPS.length} · ${st.title}`);
    this.bodyText.setText(st.text);
  }

  /** Игрок выстрелил (GameScene): шаг выстрела сделан. */
  onShot() {
    // Шаг «Добей» не закрывается выстрелом: он длится до конца боя, а после
    // промаха панель подсказывает, как поправиться
    if (this.current?.id === 'shoot') this._next('Бабах!');
  }

  /** Шаг сделан: «Отлично!», звук, вибрация — и к следующему. */
  _next(cheer = null) {
    const s = this.scene;
    s.fx?.sound('pickup');
    haptic('win');
    this.cheer.setText(cheer ?? ['Отлично!', 'Есть!', 'Так держать!', 'Супер!'][this.step % 4]).setAlpha(1).setScale(0.6);
    s.tweens.add({ targets: this.cheer, scale: 1, duration: 260, ease: 'Back.easeOut' });
    s.tweens.add({ targets: this.cheer, alpha: 0, delay: 800, duration: 300 });
    this.step++;
    this.doneAt = s.time.now;
    this.shotTurn = undefined;   // промах считаем от хода, в который начался шаг
    if (this.finished) { this.destroy(); return; }
    this._show();
  }

  /** Флажок на том же этаже, в ту сторону, где пол тянется дальше. */
  _placeFlag(w) {
    for (const dir of [1, -1]) {
      let ok = true;
      for (let d = 10; d <= 120; d += 10) {
        const y = w.footYAt(w.x + dir * d, w.y);
        if (y === null || Math.abs(y - w.y) > 26) { ok = false; break; }
      }
      if (ok) return { x: w.x + dir * 110, y: w.footYAt(w.x + dir * 110, w.y) };
    }
    return { x: w.x + 60, y: w.y };
  }

  /** Мировая точка → координаты интерфейса. */
  _ui(x, y) {
    const r = this.scene.rig;
    return [r.uiX(x), (y - r.viewTop) * r.zoom - CFG.FRAME.top];
  }

  update() {
    const s = this.scene;
    if (this.finished || !this.items.length) return;
    const w = s.turn.activeWorm;
    const mine = w && w.team === 0 && s.canPlayerAct();
    // Пока учимся и целимся, ход не сгорает (отход после выстрела — по часам)
    if (mine && s.turn.state === 'aim' && !s.turn.retreating) s.turn.timeLeft = Math.max(s.turn.timeLeft, 25);
    this._drawPanel(mine);
    this.dimHook?.setVisible(this.current?.id !== 'hook');
    this.arrow.clear();
    this.flagGfx.clear();
    if (!mine) return;
    // Свежий шаг — дать полсекунды, чтобы «Отлично!» не съел следующее действие
    if (s.time.now - this.doneAt < 350) return;

    const hud = s.hud;
    switch (this.current.id) {
      case 'walk': {
        this.flag ??= this._placeFlag(w);
        this._drawFlag(this.flag);
        const [fx, fy] = this._ui(this.flag.x, this.flag.y - 70);
        this._drawArrow(fx, fy, 'down');
        if (hud.stick) this._drawArrow(hud.stick.cx + hud.stick.R + 14, hud.stick.cy, 'left');
        if (Math.abs(w.x - this.flag.x) < 18 && w.grounded) this._next();
        break;
      }
      case 'jump': {
        const j = hud.buttons?.jump;
        if (j) this._drawArrow(j.x, j.y - 80, 'down');
        if (!w.grounded && !w.zip && !w.hang && w.vy < -60) this._next();
        break;
      }
      case 'hook': {
        const spots = s.aim?._hints ?? [];
        if (spots[0]) {
          const [hx, hy] = this._ui(spots[0].x, spots[0].y - 40);
          this._drawArrow(hx, hy, 'down');
        }
        if (w.zip) this._next();
        break;
      }
      case 'shoot':
      case 'finish': {
        // Граната — сразу в руке: выбирать оружие на первой минуте незачем
        if (!this.armed) {
          const gi = WEAPONS.findIndex((x) => x.id === 'grenade');
          if (gi >= 0 && s.turn.weaponIndex !== gi) s.turn.setWeaponIndex(gi);
          this.armed = true;
        }
        const p = hud.slingPad;
        if (p) this._drawArrow(p.x, p.y - p.r - 26, 'down');
        // Промах на добивании: ход ушёл к мишени и вернулся — подбодрить и поправить
        if (this.current.id === 'finish' && s.turn.turnNumber > (this.shotTurn ?? s.turn.turnNumber)) {
          this.misses++;
          this.bodyText.setText('Мимо — не беда! Тяни дальше, если недолёт, и выше, если упёрлось в пол');
        }
        this.shotTurn = s.turn.turnNumber;
        break;
      }
      default: break;
    }
  }

  _drawPanel(mine) {
    const L = this.layout, y = this.panelY;
    const h = this._panelH();
    const g = this.panel;
    g.clear();
    this.panelBottom = y + h;
    const r = L.title < 20 ? 14 : 18;
    g.fillStyle(0xffe27a, mine ? 0.97 : 0.6).fillRoundedRect(L.x, y, L.w, h, r);
    g.lineStyle(3, 0x1a1408, 0.9).strokeRoundedRect(L.x, y, L.w, h, r);
    // Кружки шагов
    const right = L.x + L.w - (L.title < 20 ? 18 : 28);
    const dy = L.title < 20 ? 15 : 24;
    STEPS.forEach((_, i) => {
      g.fillStyle(i < this.step ? 0x3fa45b : i === this.step ? 0x1a1408 : 0x1a1408, i <= this.step ? 1 : 0.25)
        .fillCircle(right - (STEPS.length - 1 - i) * (L.title < 20 ? 15 : 18), y + dy, L.title < 20 ? 5 : 6);
    });
    this.titleText.setAlpha(mine ? 1 : 0.6);
    this.bodyText.setAlpha(mine ? 1 : 0.6);
  }

  /** Прыгающая стрелка: остриём в точку (x, y); dir — куда смотрит остриё. */
  _drawArrow(x, y, dir) {
    const g = this.arrow;
    const b = Math.sin(this.scene.time.now / 160) * 9;
    // Стрелка «вниз» в своих осях: (u — поперёк, v — вдоль, от острия назад)
    const [ax, ay] = { down: [0, -1], up: [0, 1], left: [1, 0], right: [-1, 0] }[dir];
    const tx = x - ax * b, ty = y - ay * b;
    const P = (u, v) => [tx + ay * u * -1 + ax * v, ty + ax * u + ay * v];
    const pts = [P(0, 0), P(-24, 28), P(-10, 28), P(-10, 56), P(10, 56), P(10, 28), P(24, 28)];
    g.fillStyle(0xffd166, 1).lineStyle(4, 0x1a1408, 1);
    g.beginPath();
    g.moveTo(...pts[0]);
    for (const p of pts.slice(1)) g.lineTo(...p);
    g.closePath();
    g.fillPath();
    g.strokePath();
  }

  _drawFlag({ x, y }) {
    const g = this.flagGfx;
    const wave = Math.sin(this.scene.time.now / 200) * 3;
    g.lineStyle(4, 0x3b2a1a, 1).lineBetween(x, y, x, y - 46);
    g.fillStyle(0xff5a5a, 1).lineStyle(3, 0x1a1410, 1);
    g.beginPath(); g.moveTo(x, y - 46); g.lineTo(x + 30, y - 38 + wave); g.lineTo(x, y - 28); g.closePath();
    g.fillPath(); g.strokePath();
    g.fillStyle(0xffffff, 0.35).fillEllipse(x, y + 2, 34, 8);
  }

  destroy() {
    for (const o of this.items) o?.destroy?.();
    this.items = [];
  }
}
