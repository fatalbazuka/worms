import { CFG, DEPTH, TEAM_COLORS, TEAM_NAMES } from '../config.js';
import { WEAPONS } from '../weapons/index.js';
import { has as hasAsset, weaponIcon, fitScale } from '../core/assets.js';
import { UI, font, ensureButton, ensureRoundButton, ensureIcon } from './theme.js';
import { Inventory } from './Inventory.js';
import { isDesktop } from '../platform/device.js';
import { sfx } from '../audio/Sfx.js';
import { EMOTES } from '../core/emotes.js';

export const TOP_H = 62;

/**
 * Интерфейс: ход, таймер, здоровье команд, ветер, выбор оружия и тач-кнопки.
 *
 * Всё живёт в интерфейсной камере (rig.ui): не масштабируется зумом и не
 * трясётся при взрывах. Container не используем — хит-тест интерактивных
 * объектов внутри контейнера ведёт себя непредсказуемо.
 *
 * Кнопки — картинки из theme.js: скруглённые плашки с фаской и тенью.
 * Раньше это были плоские прямоугольники с юникодными значками, и всё
 * вместе выглядело как отладочный оверлей поверх нарисованной игры.
 */
export class Hud {
  constructor(scene) {
    this.scene = scene;
    this.uiRects = [];
    this.weaponButtons = [];
    this.holdButtons = [];

    const W = CFG.VIEW_W;
    const H = CFG.VIEW_H;
    // Через fix проходит каждый объект интерфейса, поэтому здесь же он и
    // запоминается: иначе пересобрать HUD после поворота экрана нечем.
    this.items = [];
    this.fix = (o, d = DEPTH.HUD) => {
      this.items.push(o);
      return scene.rig.ui(o.setScrollFactor(0).setDepth(d));
    };

    this.desktop = isDesktop();
    // Арена с крюком на телефоне: рогатка и тап вместо «Огня» и стрелок
    // угла, кнопок втрое меньше, раскладка годится и вертикальному экрану
    this.compact = !this.desktop && !!scene.sling;

    // Инвентарь создаётся до плашки оружия: она его открывает
    this.inventory = new Inventory(scene);
    if (this.compact) this._buildTopBarCompact(W);
    else this._buildTopBar(W);
    if (this.compact) {
      this._buildCompactControls(W, H);
      this._buildHelp(W, H);
      this._buildWeapons(W, H);
      this._buildPowerBar();
    } else if (this.desktop) {
      // На ПК крупные кнопки под пальцы не нужны: ходьба, прицел и выстрел
      // — мышью и клавиатурой, внизу только плашка оружия и служебная полоса
      this._buildDesktopBar(W, H);
      this._buildHelp(W, H);
      this._buildWeapons(W, H);
      this._buildPowerBar();
    } else {
      // Оружие — после служебных кнопок: на узком экране плашка уступает
      // им место, а для этого надо знать, где они кончились
      this._buildControls(W, H);
      this._buildHelp(W, H);
      this._buildWeapons(W, H);
    }

    scene.input.on('pointerup', this._releaseAll, this);
    scene.input.on('pointerupoutside', this._releaseAll, this);
  }

  // ------------------------------------------------------- верхняя панель

  /** Подложка верхней панели: создаётся один раз на игру. */
  _topBarTexture() {
    const s = this.scene;
    const key = 'ui-topbar';
    if (!s.textures.exists(key)) {
      const tex = s.textures.createCanvas(key, 8, TOP_H);
      const ctx = tex.getContext();
      const g = ctx.createLinearGradient(0, 0, 0, TOP_H);
      g.addColorStop(0, 'rgba(16,19,26,0.94)');
      g.addColorStop(1, 'rgba(16,19,26,0.72)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 8, TOP_H);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, TOP_H - 2, 8, 2);
      tex.refresh();
    }
    return key;
  }

  _buildTopBar(W) {
    const s = this.scene;
    const key = this._topBarTexture();
    this.fix(s.add.image(0, 0, key).setOrigin(0, 0).setDisplaySize(W, TOP_H));

    // В полноэкранном Telegram по углам панели лежат кнопки клиента:
    // левый и правый блоки отодвигаются от них, середина остаётся на месте
    const pad = CFG.CORNER || 0;

    // Кто ходит: цветная метка команды + имя бойца
    this.teamChip = this.fix(s.add.rectangle(16 + pad, 14, 6, 32, 0xffffff).setOrigin(0, 0));
    this.turnText = this.fix(s.add.text(32 + pad, 10, '', font(19, 800)));
    this.subText = this.fix(s.add.text(32 + pad, 35, '', font(12, 700, UI.textDim)));

    // Таймер по центру — кольцо вокруг цифры
    this.timerGfx = this.fix(s.add.graphics());
    this.timerCx = Math.round(W / 2);
    this.timerCy = Math.round(TOP_H / 2) - 1;
    this.timerText = this.fix(s.add.text(this.timerCx, this.timerCy, '30',
      font(21, 800)).setOrigin(0.5));

    // Здоровье команд сходится к таймеру: слева красные, справа синие
    this.teamBars = [];
    const barW = 190, gap = 52;
    for (let t = 0; t < CFG.TEAMS; t++) {
      const right = t % 2 === 1;
      const x = right ? this.timerCx + gap : this.timerCx - gap - barW;
      this.fix(s.add.text(right ? x : x + barW, 8, TEAM_NAMES[t],
        font(13, 800, hex(TEAM_COLORS[t]))).setOrigin(right ? 0 : 1, 0));
      const cnt = this.fix(s.add.text(right ? x + barW : x, 8, '',
        font(12, 700, UI.textDim)).setOrigin(right ? 1 : 0, 0));
      this.fix(this._barImage(x, 36, barW, 12));
      const bar = this.fix(s.add.rectangle(right ? x + 2 : x + barW - 2, 36,
        barW - 4, 8, TEAM_COLORS[t]).setOrigin(right ? 0 : 1, 0.5), DEPTH.HUD + 1);
      this.teamBars.push({ bar, cnt, width: barW - 4 });
    }

    this.fix(s.add.text(W - 16 - pad, 8, 'ВЕТЕР', font(11, 700, UI.textDim)).setOrigin(1, 0));
    this.windText = this.fix(s.add.text(W - 16 - pad, 22, '0', font(17, 800)).setOrigin(1, 0));
    this.windGfx = this.fix(s.add.graphics());
    this.windCx = W - 150 - pad;
    this.windCy = 38;
  }

  /**
   * Верхняя панель для узкого экрана: слева ветер, по центру здоровье
   * команд и таймер, справа — сколько крюков осталось. Имени бойца и
   * строки с картой тут нет: чей ход, говорит баннер и стрелка над бойцом.
   */
  _buildTopBarCompact(W) {
    const s = this.scene;
    this.fix(s.add.image(0, 0, this._topBarTexture()).setOrigin(0, 0).setDisplaySize(W, TOP_H));
    const pad = CFG.CORNER || 0;

    this.timerGfx = this.fix(s.add.graphics());
    this.timerCx = Math.round(W / 2);
    this.timerCy = Math.round(TOP_H / 2) - 1;
    this.timerText = this.fix(s.add.text(this.timerCx, this.timerCy, '30',
      font(24, 800)).setOrigin(0.5));

    this.teamBars = [];
    const gap = 46;
    const barW = Math.round(Math.max(90, Math.min(190, W / 2 - gap - 126 - pad)));
    for (let t = 0; t < CFG.TEAMS; t++) {
      const right = t % 2 === 1;
      const x = right ? this.timerCx + gap : this.timerCx - gap - barW;
      this.fix(s.add.text(right ? x : x + barW, 4, TEAM_NAMES[t],
        font(17, 800, hex(TEAM_COLORS[t]))).setOrigin(right ? 0 : 1, 0));
      const cnt = this.fix(s.add.text(right ? x + barW : x, 5, '',
        font(15, 700, UI.textDim)).setOrigin(right ? 1 : 0, 0));
      this.fix(this._barImage(x, 40, barW, 14));
      const bar = this.fix(s.add.rectangle(right ? x + 2 : x + barW - 2, 40,
        barW - 4, 10, TEAM_COLORS[t]).setOrigin(right ? 0 : 1, 0.5), DEPTH.HUD + 1);
      this.teamBars.push({ bar, cnt, width: barW - 4 });
    }

    // Ветер — слева: подпись, число и шкала под ними
    this.windHalf = 46;
    this.fix(s.add.text(16 + pad, 6, 'ВЕТЕР', font(14, 700, UI.textDim)));
    this.windText = this.fix(s.add.text(16 + pad + this.windHalf * 2, 2, '0', font(19, 800)).setOrigin(1, 0));
    this.windGfx = this.fix(s.add.graphics());
    this.windCx = 16 + pad + this.windHalf;
    this.windCy = 40;

    // Подсказка новичку под панелью: гаснет сама после трёх тросов
    this.hintText = this.fix(s.add.text(Math.round(W / 2), TOP_H + 14,
      'коснись светящейся точки — трос подтянет туда', font(15, 800, '#1a1408'))
      .setOrigin(0.5, 0).setPadding(12, 6, 12, 6).setBackgroundColor('#ffe27a'), DEPTH.HUD + 1)
      .setVisible(false);
  }

  _barImage(x, y, w, h) {
    const s = this.scene;
    const key = `ui-bar-${w}x${h}`;
    if (!s.textures.exists(key)) {
      const tex = s.textures.createCanvas(key, w, h);
      const ctx = tex.getContext();
      ctx.fillStyle = UI.bar;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      tex.refresh();
    }
    return s.add.image(x, y, key).setOrigin(0, 0.5);
  }

  // --------------------------------------------------------------- оружие

  /**
   * Плашка текущего оружия. Раньше тут лежал ряд из всех стволов, но с
   * дюжиной он перестал влезать и наезжал на кнопки. Теперь видно одно —
   * то, чем стреляешь, — а весь арсенал открывается тапом по нему.
   */
  _buildWeapons(W, H) {
    const s = this.scene;
    const bw = 278, bh = 75;
    // По центру, но не поверх служебных кнопок: на 16:9 им тесно
    const bx = this.weaponSpot?.x ?? Math.max(Math.round((W - bw) / 2), (this.serviceEnd ?? 0) + 16);
    const by = this.weaponSpot?.y ?? H - bh - 14;

    ensureButton(s, 'ui-weapon-slot', bw, bh, 'active');
    const plate = this.fix(s.add.image(bx + bw / 2, by + bh / 2, 'ui-weapon-slot'));
    plate.setInteractive({ useHandCursor: true });
    this._register(plate, () => this.inventory?.toggle(), null);

    this.slot = {
      plate,
      icon: this.fix(s.add.image(bx + 42, by + bh / 2, 'icon_bazooka')
        .setOrigin(0.5).setScale(1.3), DEPTH.HUD + 1),
      name: this.fix(s.add.text(bx + 78, by + (this.compact ? 11 : 15), '', font(this.compact ? 23 : 20, 800, '#2a1c06')), DEPTH.HUD + 1),
      ammo: this.fix(s.add.text(bx + 78, by + (this.compact ? 42 : 43), '', font(this.compact ? 18 : 15, 700, '#5a4413')), DEPTH.HUD + 1),
      hint: this.fix(s.add.text(bx + bw - 12, by + 10, 'арсенал',
        font(12, 700, '#5a4413')).setOrigin(1, 0), DEPTH.HUD + 1),
      x: bx, y: by, w: bw, h: bh,
    };
    this.uiRects.push({ x: bx, y: by, w: bw, h: bh });
  }

  // --------------------------------------------------------------- кнопки

  _buildControls(W, H) {
    const s = this.scene;
    // Размеры под палец на телефоне: были 62/54/38, стали на 40% больше —
    // на iPhone в ландшафте логический пиксель это ~0.5 CSS-пикселя, и
    // квадрат 62 выходил 31 pt, меньше рекомендуемых 44
    const B = 87;         // сторона квадратной кнопки
    const FR = 76;        // радиус «Огня»
    const gap = 14;

    const JR = 53;        // радиус «Прыжка»

    // Левая рука — прицел и ходьба: угол крутится левым большим пальцем,
    // а правый в это время держит «Огонь» и не мешает.
    const lx = 24, lx2 = lx + B + gap, lx3 = lx2 + B + gap;
    const rowLow = H - B - 14;
    const rowHigh = rowLow - B - gap;

    this._hold(lx, rowLow, B, 'left', 'left');
    this._hold(lx2, rowLow, B, 'right', 'right');
    this._hold(lx3, rowHigh, B, 'up', 'aimUp');
    this._hold(lx3, rowLow, B, 'down', 'aimDown');
    this._tap(lx, rowHigh, B, 'overview', () => s.rig.toggleOverview());
    this._tap(lx2, rowHigh, B, 'focus', () => s.focusCamera());

    // Правая рука — только выстрел и прыжок, оба кругом. Прыжок вплотную к
    // «Огню» по диагонали: подпрыгнуть и ударить с высоты — один приём,
    // и палец между ними ходить не должен.
    const fireCx = W - 30 - FR, fireCy = H - 30 - FR;
    const d = (FR + gap + JR) * 0.7071;
    const jumpCx = Math.round(fireCx - d), jumpCy = Math.round(fireCy - d);

    this._holdRound(jumpCx, jumpCy, JR, 'jump', 'jumpQueued');
    this._fireButton(fireCx, fireCy, FR);

    // Центры кнопок наружу: раскладка зависит от пропорций экрана, и
    // тестам незачем повторять её вычисления у себя.
    this.buttons = {
      fire: { x: fireCx, y: fireCy },
      jump: { x: jumpCx, y: jumpCy },
      aimUp: { x: lx3 + B / 2, y: rowHigh + B / 2 },
      aimDown: { x: lx3 + B / 2, y: rowLow + B / 2 },
      overview: { x: lx + B / 2, y: rowHigh + B / 2 },
      focus: { x: lx2 + B / 2, y: rowHigh + B / 2 },
      left: { x: lx + B / 2, y: rowLow + B / 2 },
      right: { x: lx2 + B / 2, y: rowLow + B / 2 },
    };
  }

  /**
   * Кнопки арены с крюком: шаг влево-вправо под левой рукой, прыжок — под
   * правой. Стрельба и крюк — пальцем по полю, кнопок для них нет.
   */
  _buildCompactControls(W, H) {
    this.weaponSpot = null;
    const B = 96, gap = 14, JR = 62;
    const lx = 20, lx2 = lx + B + gap;
    const rowLow = H - B - 18;
    // Ходьба — стик под левым большим пальцем вместо двух мелких стрелок
    const SR = CFG.STICK_R;
    const stickCx = lx + SR + 6, stickCy = H - 22 - SR;
    this._buildStick(0, stickCy - SR - 10, lx2 + B + 10, H - (stickCy - SR - 10), stickCx, stickCy);
    // Кнопочная схема (выбор в меню): справа от стрелок — угол ▲▼, в углу
    // «Огонь», прыжок по диагонали от него, как в прежней раскладке
    const buttons = !this.scene.slingAim;
    const FR = 76;
    const fireCx = W - 24 - FR, fireCy = H - 24 - FR;
    const dj = (FR + gap + JR) * 0.7071;
    const jumpCx = buttons ? Math.round(fireCx - dj) : W - 24 - JR;
    const jumpCy = buttons ? Math.round(fireCy - dj) : H - 24 - JR;
    this._holdRound(jumpCx, jumpCy, JR, 'jump', 'jumpQueued');
    this.serviceEnd = lx2 + B;
    if (!buttons) this._buildSlingPad(W, jumpCy - JR);

    // Тросы — как патроны: плашка над стрелками, по кружку на каждый
    // оставшийся в этом ходу. Стоит у большого пальца, а не в углу панели:
    // там её не замечали
    const s = this.scene;
    const pw = B * 2 + gap, ph = 52, py = stickCy - SR - 14 - ph;
    ensureButton(s, `ui-hooks-${pw}x${ph}`, pw, ph, 'normal');
    this.hookPlate = this.fix(s.add.image(lx + pw / 2, py + ph / 2, `ui-hooks-${pw}x${ph}`));
    this.fix(s.add.text(lx + 16, py + ph / 2, 'ТРОС', font(20, 800)).setOrigin(0, 0.5), DEPTH.HUD + 1);
    this.hookGfx = this.fix(s.add.graphics(), DEPTH.HUD + 1);
    this.hookX = lx + pw - 14;
    this.hookY = py + ph / 2;
    this.uiRects.push({ x: lx, y: py, w: pw, h: ph });
    this.buttons = {
      left: { x: lx + B / 2, y: rowLow + B / 2 },
      right: { x: lx2 + B / 2, y: rowLow + B / 2 },
      jump: { x: jumpCx, y: jumpCy },
    };
    if (buttons) {
      const lx3 = lx2 + B + gap, rowHigh = rowLow - B - gap;
      this._hold(lx3, rowHigh, B, 'up', 'aimUp');
      this._hold(lx3, rowLow, B, 'down', 'aimDown');
      this._fireButton(fireCx, fireCy, FR);
      this.serviceEnd = lx3 + B;
      // Узкий экран: плашке оружия между ▲▼ и «Огнём» не уместиться —
      // она встаёт над левой рукой, выше плашки тросов
      const bw = 278, bh = 75;
      if (Math.max(Math.round((W - bw) / 2), this.serviceEnd + 16) + bw > jumpCx - JR - 8) {
        this.weaponSpot = { x: lx, y: rowHigh - bh - 12 };
      }
      Object.assign(this.buttons, {
        fire: { x: fireCx, y: fireCy },
        aimUp: { x: lx3 + B / 2, y: rowHigh + B / 2 },
        aimDown: { x: lx3 + B / 2, y: rowLow + B / 2 },
      });
    }
  }

  /**
   * Стик ходьбы: зона снизу слева. Палец в зону — там центр стика; повёл
   * вбок — боец идёт, чем дальше, тем быстрее; рывком вверх — прыжок.
   * Висит на потолке или стене — шаг отцепляет (Worm.walk).
   */
  _buildStick(x0, y0, w, h, cx, cy) {
    const s = this.scene;
    const R = CFG.STICK_R;
    this.stick = { cx, cy, R, id: null, ax: cx, ay: cy, dx: 0, dy: 0, jumped: false };
    this.stickGfx = this.fix(s.add.graphics(), DEPTH.HUD);
    const zone = this.fix(s.add.zone(x0, y0, w, h).setOrigin(0, 0).setInteractive(), DEPTH.HUD);
    this.uiRects.push({ x: x0, y: y0, w, h });
    const local = (p) => [p.x - CFG.FRAME.left, p.y - CFG.FRAME.top];
    zone.on('pointerdown', (p) => {
      const st = this.stick;
      if (st.id !== null) return;
      [st.ax, st.ay] = local(p);
      st.id = p.id; st.dx = 0; st.dy = 0; st.jumped = false;
    });
    this._stickMove = (p) => {
      const st = this.stick;
      if (st.id === null || p.id !== st.id) return;
      const [px, py] = local(p);
      st.dx = px - st.ax; st.dy = py - st.ay;
      const mi = s.moveInput;
      const ax = Math.abs(st.dx);
      mi.left = st.dx < -CFG.STICK_DEAD;
      mi.right = st.dx > CFG.STICK_DEAD;
      mi.walkScale = Math.max(0.35, Math.min(1, (ax - CFG.STICK_DEAD) / (R * 0.7)));
      if (!st.jumped && st.dy < -R * CFG.STICK_JUMP) { mi.jumpQueued = true; st.jumped = true; }
      if (st.dy > -R * 0.3) st.jumped = false;
    };
    this._stickUp = (p) => {
      const st = this.stick;
      if (st.id === null || (p && p.id !== st.id)) return;
      st.id = null; st.dx = 0; st.dy = 0;
      s.moveInput.left = false; s.moveInput.right = false; s.moveInput.walkScale = 1;
    };
    s.input.on('pointermove', this._stickMove);
    s.input.on('pointerup', this._stickUp);
    s.input.on('pointerupoutside', this._stickUp);
  }

  _drawStick() {
    const g = this.stickGfx, st = this.stick;
    g.clear();
    const on = st.id !== null;
    const x = on ? st.ax : st.cx, y = on ? st.ay : st.cy, R = st.R;
    g.fillStyle(0x10131a, on ? 0.55 : 0.4).fillCircle(x, y, R);
    g.lineStyle(3, 0xffffff, on ? 0.5 : 0.3).strokeCircle(x, y, R);
    // Стрелки по бокам и вверху — что умеет стик
    g.fillStyle(0xffffff, on ? 0.45 : 0.6);
    g.fillTriangle(x - R + 10, y, x - R + 26, y - 11, x - R + 26, y + 11);
    g.fillTriangle(x + R - 10, y, x + R - 26, y - 11, x + R - 26, y + 11);
    g.fillTriangle(x, y - R + 10, x - 10, y - R + 25, x + 10, y - R + 25);
    const len = Math.hypot(st.dx, st.dy) || 1;
    const k = Math.min(len, R * 0.75) / len;
    g.fillStyle(0xffd166, 1).fillCircle(x + st.dx * k, y + st.dy * k, 30);
    g.lineStyle(3, 0x1a1410, 0.9).strokeCircle(x + st.dx * k, y + st.dy * k, 30);
  }

  /**
   * Рычаг рогатки над прыжком. Стоит правее середины, чтобы тянуть было
   * куда в любую сторону: вправо — на полную силу, вниз — через кнопки.
   * В uiRects его нет: касание ловит AimController (padHit).
   */
  _buildSlingPad(W, top) {
    const R = CFG.SLING_PAD_R;
    const x = Math.round(W - CFG.SLING_PAD_MAX - 30);
    const y = Math.round(top - 26 - R);
    this.slingPad = { x, y, r: R };
    this.padPull = null;       // {dx, dy} — палец тянет, экранные пиксели
    this.padGfx = this.fix(this.scene.add.graphics(), DEPTH.HUD);
  }

  /** Попал ли палец в рычаг (с запасом вокруг). */
  padHit(pointer) {
    const p = this.slingPad;
    if (!p) return false;
    const px = pointer.x - CFG.FRAME.left, py = pointer.y - CFG.FRAME.top;
    return Math.hypot(px - p.x, py - p.y) <= p.r + CFG.SLING_PAD_SLOP;
  }

  _drawSlingPad(scene) {
    const g = this.padGfx, p = this.slingPad;
    g.clear();
    const w = scene.turn.activeWorm;
    const ready = scene.canPlayerAct() && w && !w.zip && !scene.turn.retreating;
    // Палец на рычаге — показываем его; иначе подсказка тянет сама
    let pull = this.padPull;
    if (!pull && ready && scene.aim?.padHint) pull = scene.aim.padHint;
    g.fillStyle(0x10131a, ready ? 0.5 : 0.25).fillCircle(p.x, p.y, p.r);
    g.lineStyle(3, 0xffffff, ready ? 0.55 : 0.2).strokeCircle(p.x, p.y, p.r);
    // Две «рогульки» рогатки по краям круга — чтобы было ясно, что это
    g.lineStyle(4, 0xffd166, ready ? 0.8 : 0.3);
    g.lineBetween(p.x - 20, p.y - p.r + 6, p.x - 14, p.y - p.r + 18);
    g.lineBetween(p.x + 20, p.y - p.r + 6, p.x + 14, p.y - p.r + 18);
    let kx = p.x, ky = p.y;
    if (pull) {
      const len = Math.hypot(pull.dx, pull.dy) || 1;
      const k = Math.min(len, CFG.SLING_PAD_MAX) / len;
      kx = p.x + pull.dx * k; ky = p.y + pull.dy * k;
      g.lineStyle(4, 0xffffff, 0.6).lineBetween(p.x - 14, p.y - p.r + 18, kx, ky);
      g.lineBetween(p.x + 14, p.y - p.r + 18, kx, ky);
    }
    g.fillStyle(0xffd166, ready ? 1 : 0.4).fillCircle(kx, ky, 22);
    g.lineStyle(3, 0x1a1410, ready ? 0.9 : 0.3).strokeCircle(kx, ky, 22);
  }

  /**
   * Редкие кнопки под одной: «⋯» в правом верхнем углу раскрывает столбик
   * (подсказка, звук, обзор, меню, полный экран). В бою они не нужны, а
   * место под большим пальцем — самое дорогое.
   */
  _buildCompactService(W) {
    const s = this.scene;
    const SB = 60, step = 68;
    const x = W - 14 - SB;
    let y = TOP_H + 12;
    const more = this._tap(x, y, SB, 'more', () => this.setMore(!this.moreOpen));
    this.buttons.more = { x: x + SB / 2, y: y + SB / 2 };
    // Эмоции — слева от «⋯»: смайлик, по нажатию — ряд рож с фразами
    this._tap(x - step, y, SB, 'emote', () => this.toggleEmotes());
    this.buttons.emote = { x: x - step + SB / 2, y: y + SB / 2 };
    this._buildEmotes(W, y + SB + 14);
    this.moreItems = [];
    const service = (icon, onTap) => {
      y += step;
      const from = this.uiRects.length;
      const img = this._tap(x, y, SB, icon, () => { onTap(); if (icon !== 'sound' && icon !== 'mute') this.setMore(false); });
      // Спрятанная кнопка не должна ловить касания поля: её прямоугольник
      // включается вместе с ней
      this.moreItems.push({ img, rect: this.uiRects[from], y });
      return img;
    };
    service('help', () => this.toggleHelp());
    this.soundBtn = service(sfx.muted ? 'mute' : 'sound', () => this.toggleSound());
    service('overview', () => s.rig.toggleOverview());
    service('home', () => s.toMenu());
    if (s.scale.fullscreen.available) {
      service('fullscreen', () => {
        if (s.scale.isFullscreen) s.scale.stopFullscreen();
        else s.scale.startFullscreen();
      });
    }
    if (s.match?.mode === 'online') service('link', () => s.shareInvite());
    this.moreBtn = more;
    this.setMore(false);

    this.netText = this.fix(s.add.text(16, TOP_H + 10, '', font(13, 800, UI.accent)), DEPTH.HUD + 1);
  }

  /** Ряд эмоций под верхней панелью; скрыт, пока не нажали смайлик. */
  _buildEmotes(W, y) {
    const s = this.scene;
    this.emoteItems = [];
    const list = EMOTES;
    const bw = Math.min(150, Math.floor((W - 24) / 3) - 8), bh = 64, gap = 8;
    const cols = 3;
    const x0 = Math.round((W - (cols * bw + (cols - 1) * gap)) / 2);
    ensureButton(s, `ui-emote-${bw}x${bh}`, bw, bh, 'normal');
    list.forEach((e, i) => {
      const x = x0 + (i % cols) * (bw + gap), yy = y + Math.floor(i / cols) * (bh + gap);
      const img = this.fix(s.add.image(x + bw / 2, yy + bh / 2, `ui-emote-${bw}x${bh}`), DEPTH.HUD + 6);
      const t = this.fix(s.add.text(x + bw / 2, yy + bh / 2, e.text, font(18, 800)).setOrigin(0.5), DEPTH.HUD + 7);
      if (t.width > bw - 12) t.setScale((bw - 12) / t.width);
      img.setInteractive({ useHandCursor: true });
      img.on('pointerup', () => {
        this.toggleEmotes(false);
        s.showEmote(s.myTeamIndex, e.id, { send: true });
      });
      const rect = { x, y: yy, w: bw, h: bh };
      this.uiRects.push(rect);
      this.emoteItems.push({ img, t, rect });
      this.buttons[`emote-${e.id}`] = { x: x + bw / 2, y: yy + bh / 2 };
    });
    this.toggleEmotes(false);
  }

  toggleEmotes(on = !this.emotesOpen) {
    this.emotesOpen = on;
    if (on) this.setMore(false);
    for (const it of this.emoteItems ?? []) {
      it.img.setVisible(on); it.t.setVisible(on);
      if (on) it.img.setInteractive(); else it.img.disableInteractive();
      it.rect.h = on ? 64 : 0;
    }
  }

  setMore(on) {
    this.moreOpen = on;
    if (on) this.toggleEmotes(false);
    for (const it of this.moreItems ?? []) {
      it.img.setVisible(on);
      it.img.iconImage?.setVisible(on);
      if (on) it.img.setInteractive(); else it.img.disableInteractive();
      it.rect.h = on ? it.img.plateSize : 0;
    }
  }

  /**
   * Нижняя полоса для мыши: маленькие кнопки слева с подсказкой при
   * наведении (в ней же горячая клавиша) и памятка по управлению справа.
   */
  _buildDesktopBar(W, H) {
    const s = this.scene;
    const SB = 50, step = 58;
    const sy = H - SB - 16;
    let sx = 20;
    this.tip = this.fix(s.add.text(0, 0, '', font(13, 800))
      .setOrigin(0, 1).setPadding(8, 5, 8, 5)
      .setBackgroundColor('rgba(16,19,26,0.92)'), DEPTH.HUD + 30).setVisible(false);

    const service = (icon, tip, onTap) => {
      const x = sx;
      const img = this._tap(x, sy, SB, icon, onTap);
      img.on('pointerover', () => {
        this.tip.setText(typeof tip === 'function' ? tip() : tip).setPosition(x, sy - 8).setVisible(true);
      });
      img.on('pointerout', () => this.tip.setVisible(false));
      sx += step;
      return img;
    };

    service('overview', 'Обзор карты · V', () => s.rig.toggleOverview());
    service('focus', 'Камера к бойцу · F', () => s.focusCamera());
    this.soundBtn = service(sfx.muted ? 'mute' : 'sound',
      () => (sfx.muted ? 'Включить звук · M' : 'Выключить звук · M'), () => this.toggleSound());
    service('help', 'Управление · F1', () => this.toggleHelp());
    service('home', 'В меню', () => s.toMenu());
    if (s.scale.fullscreen.available) {
      service('fullscreen', 'Полный экран · F11', () => {
        if (s.scale.isFullscreen) s.scale.stopFullscreen();
        else s.scale.startFullscreen();
      });
    }
    if (s.match?.mode === 'online') service('link', 'Позвать второго по ссылке', () => s.shareInvite());
    this.serviceEnd = sx - step + SB;

    this.netText = this.fix(s.add.text(20, sy - 8, '', font(13, 800, UI.accent))
      .setOrigin(0, 1), DEPTH.HUD + 1);

    // Памятка на подложке: полоса под ней пёстрая, голый текст тонул
    this.fix(s.add.text(W - 18, H - 16, [
      'мышь — прицел · ЛКМ держать — сила, отпустить — выстрел',
      'A/D — ходьба · Enter — прыжок · ПКМ — двигать карту · колесо — зум',
      'Tab — арсенал · 1–9, Q/E — оружие · F1 — все клавиши',
    ].join('\n'), font(12, 700, UI.textDim)).setOrigin(1, 1).setAlign('right')
      .setLineSpacing(3).setPadding(12, 7, 12, 7)
      .setBackgroundColor('rgba(16,19,26,0.82)'));
  }

  /** Переключить звук; иконка на кнопке меняется вместе с ним. */
  toggleSound() {
    sfx.setMuted(!sfx.muted);
    if (!this.soundBtn) return;
    const size = this.soundBtn.plateSize;
    const key = ensureIcon(this.scene, sfx.muted ? 'mute' : 'sound', Math.round(size * 0.62));
    this.soundBtn.iconImage?.setTexture(key);
    if (this.tip?.visible) this.tip.setText(sfx.muted ? 'Включить звук · M' : 'Выключить звук · M');
  }

  /** Шкала силы над плашкой оружия: на ПК кнопки «Огонь» с дугой нет. */
  _buildPowerBar() {
    const sl = this.slot;
    this.powerBar = { x: sl.x, y: sl.y - 16, w: sl.w, h: 10 };
    this.chargeGfx = this.fix(this.scene.add.graphics(), DEPTH.HUD + 2);
  }

  _plate(x, y, size, iconName) {
    const s = this.scene;
    const key = `ui-sq-${size}`;
    ensureButton(s, key, size, size, 'normal');
    const img = this.fix(s.add.image(x + size / 2, y + size / 2, key));
    img.setInteractive({ useHandCursor: true });
    img.plateSize = size;
    const iconKey = ensureIcon(s, iconName, Math.round(size * 0.62));
    if (iconKey) img.iconImage = this.fix(s.add.image(x + size / 2, y + size / 2, iconKey), DEPTH.HUD + 1);
    this.uiRects.push({ x, y, w: size, h: size });
    return img;
  }

  /**
   * Регистрирует кнопку, которую можно держать.
   *
   * Кнопка запоминает палец, который её нажал, и отпускается только им.
   * Иначе получалось так: держишь «Огонь» одним пальцем, поправляешь угол
   * другим — и на отпускании второго пальца выстрел уходил сам.
   */
  _register(img, onDown, onUp) {
    const entry = { pointerId: null, release: null };
    entry.release = (pointer) => {
      if (pointer && entry.pointerId !== null && pointer.id !== entry.pointerId) return;
      entry.pointerId = null;
      this._unpress(img);
      onUp?.();
    };
    img.on('pointerdown', (pointer) => {
      entry.pointerId = pointer?.id ?? null;
      this._press(img);
      onDown?.();
    });
    img.on('pointerup', (pointer) => entry.release(pointer));
    img.on('pointerout', (pointer) => entry.release(pointer));
    this.holdButtons.push(entry);
    return entry;
  }

  _hold(x, y, size, iconName, action) {
    const s = this.scene;
    const img = this._plate(x, y, size, iconName);
    this._register(img,
      () => { s.moveInput[action] = true; },
      // jumpQueued — одноразовый флаг, его сцена сама сбрасывает за кадр
      () => { if (action !== 'jumpQueued') s.moveInput[action] = false; });
  }

  _tap(x, y, size, iconName, onTap) {
    const img = this._plate(x, y, size, iconName);
    this._register(img, onTap, null);
    return img;
  }

  /** Круглая кнопка-удержание: то же, что _hold, но формой под «Огонь». */
  _holdRound(cx, cy, r, iconName, action) {
    const s = this.scene;
    const key = `ui-round-${r}`;
    ensureRoundButton(s, key, r, 'normal');
    const img = this.fix(s.add.image(cx, cy, key));
    img.setInteractive(new Phaser.Geom.Circle(img.width / 2, img.height / 2, r),
      Phaser.Geom.Circle.Contains);
    const iconKey = ensureIcon(s, iconName, Math.round(r * 1.05));
    if (iconKey) this.fix(s.add.image(cx, cy, iconKey), DEPTH.HUD + 1);
    this.uiRects.push({ x: cx - r, y: cy - r, w: r * 2, h: r * 2, round: true });

    this._register(img,
      () => { s.moveInput[action] = true; },
      () => { if (action !== 'jumpQueued') s.moveInput[action] = false; });
  }

  /**
   * Кнопка выстрела: удержание набирает силу, отпускание стреляет.
   * Отпускание ловится и глобально (_releaseAll), иначе увод пальца
   * за пределы кнопки оставил бы заряд висеть навсегда.
   */
  _fireButton(cx, cy, r) {
    const s = this.scene;
    ensureRoundButton(s, 'ui-fire', r, 'primary');
    const img = this.fix(s.add.image(cx, cy, 'ui-fire'));
    img.setInteractive(new Phaser.Geom.Circle(img.width / 2, img.height / 2, r),
      Phaser.Geom.Circle.Contains);
    this.fix(s.add.text(cx, cy, 'ОГОНЬ', font(22, 800)).setOrigin(0.5), DEPTH.HUD + 1);

    this._register(img,
      () => { s.moveInput.fire = true; },
      () => { s.moveInput.fire = false; });
    this.uiRects.push({ x: cx - r, y: cy - r, w: r * 2, h: r * 2, round: true });

    // Шкала заряда — дугой вокруг самой кнопки: видно, не отводя глаз
    this.chargeGfx = this.fix(s.add.graphics(), DEPTH.HUD + 2);
    this.chargeR = r + 11;
    this.chargeCx = cx;
    this.chargeCy = cy;
  }

  _press(img) {
    img.setScale(0.94).setTint(0xc9c9c9);
    this.scene.haptic?.('tap');
  }
  _unpress(img) { img.setScale(1).clearTint(); }
  /**
   * Глобальное отпускание: палец мог уйти с кнопки до того, как его подняли,
   * и тогда своего события кнопка не получит. Отпускаем только то, что
   * держал именно этот палец, — остальные кнопки других пальцев не трогаем.
   */
  _releaseAll(pointer) { for (const b of this.holdButtons) b.release(pointer); }

  // ------------------------------------------------------------ подсказка

  _buildHelp(W, H) {
    const s = this.scene;
    if (this.compact) this._buildCompactService(W);
    else if (!this.desktop) this._buildTouchService(W, H);

    const lines = this.compact && !s.slingAim ? [
      'ОГОНЬ — держи, набирается сила; отпустил — выстрел',
      '▲▼ — угол прицела, правится прямо на заряде',
      'свайп от бойца к цели — быстрый выстрел',
      'коснись стены или потолка — крюк подтянет бойца туда',
      'стрелки — шаг, круглая кнопка — прыжок или отцепиться',
      'тяни фон — камера · рогатка — в меню, «Прицел»',
    ] : this.compact ? [
      'жёлтый рычаг справа: тяни ОТ цели и отпусти — выстрел',
      'чем дальше тянешь, тем сильнее; вернул в центр — отмена',
      'можно тянуть и прямо с бойца',
      'коснись стены или потолка — крюк подтянет бойца туда',
      'стрелки — шаг, круглая кнопка — прыжок или отцепиться',
      'тяни фон — камера, два пальца — масштаб',
    ] : this.desktop && s.sling ? [
      'мышь — прицел · ЛКМ держать — сила, отпустить — выстрел',
      'ПКМ по стене или потолку — крюк подтянет бойца туда',
      'A/D — шаг · Enter — прыжок или отцепиться',
      'ПКМ тянуть — карта · колесо — зум',
      '1–9 или Q/E — оружие · Tab — арсенал · F1 — подсказка',
    ] : this.desktop ? [
      'мышь — прицел: боец смотрит туда, где курсор',
      'ЛКМ или Пробел — держать: копится сила; отпустил — выстрел',
      'W/S или ↑/↓ — точная подстройка угла, прямо на заряде',
      'A/D или ←/→ — ходьба · Enter — прыжок',
      'ПКМ или средняя кнопка — тянуть карту · колесо — зум',
      '1–9 или Q/E — оружие · Tab — арсенал',
      'F — камера к бойцу · V — обзор карты · M — звук',
      'F1 или H — эта подсказка · Esc — закрыть',
    ] : [
      'ОГОНЬ — держи, набирается сила; отпустил — выстрел',
      'вверх/вниз слева — угол прицела, правится прямо на заряде',
      'влево/вправо слева — ходьба, прыжок — круг у «ОГНЯ»',
      'тянуть фон — камера, два пальца — приблизить',
      'кнопки слева сверху — обзор карты и возврат к бойцу',
      'свайп прямо по бойцу — быстрый выстрел',
      'маленькие кнопки внизу — подсказка, звук, меню, полный экран',
      ...(s.match?.mode === 'online' ? ['звенья цепи — позвать второго по ссылке'] : []),
    ];
    const lh = this.compact ? 34 : 27;
    const w = Math.min(W - 24, this.desktop ? 620 : this.compact ? 680 : 560), h = lines.length * lh + 96;
    const x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);

    ensureButton(s, 'ui-help', w, h, 'normal');
    this.helpPanel = [
      this.fix(s.add.image(x + w / 2, y + h / 2, 'ui-help'), DEPTH.HUD + 20),
      this.fix(s.add.text(x + w / 2, y + 18, 'УПРАВЛЕНИЕ', font(19, 800, UI.accent))
        .setOrigin(0.5, 0), DEPTH.HUD + 21),
      this.fix(s.add.text(x + w / 2, y + h - 24, this.desktop
        ? 'клик или любая клавиша — закрыть'
        : 'коснись экрана, чтобы закрыть',
        font(12, 700, UI.textDim)).setOrigin(0.5, 0.5), DEPTH.HUD + 21),
    ];
    lines.forEach((line, i) => {
      this.helpPanel.push(this.fix(
        s.add.text(x + 26, y + 56 + i * lh, `·  ${line}`, font(this.compact ? 17 : 14, 700)), DEPTH.HUD + 21,
      ));
    });
    // Там, где жесты показывает сама игра (рогатка, трос), памятка с текстом
    // при входе не нужна — она остаётся под кнопкой «?»
    this.setHelp(!this.compact);

    // Подсказка закрывается любым касанием — искать кнопку не нужно.
    // Обработчик именованный: при пересборке HUD его надо снять, иначе
    // старый останется висеть и будет закрывать уже новую подсказку.
    // Нажатие, которым закрыли подсказку, дальше не идёт: иначе на ПК тот
    // же клик начинал бы набор силы, а на телефоне — протяжку камеры.
    this._closeHelp = (pointer) => {
      if (!this.helpVisible) return;
      this.setHelp(false);
      this._swallowDown = pointer?.downTime ?? null;
    };
    this.scene.input.on('pointerdown', this._closeHelp);
  }

  _buildTouchService(W, H) {
    const s = this.scene;
    // Редкие кнопки собраны в одну полосу между блоком ходьбы и панелью
    // оружия: маленькие, одинаковые, под большой палец не просятся.
    // Полоса начинается за колонкой прицела и обязана кончиться до оружия.
    const SB = 62, step = 70;
    let sx = 328;   // за колонкой прицела: 24 + 3·87 + 2·14 + 16
    const sy = H - SB - 16;
    const service = (icon, onTap) => {
      const img = this._tap(sx, sy, SB, icon, onTap);
      sx += step;
      return img;
    };

    service('help', () => this.toggleHelp());
    this.soundBtn = service(sfx.muted ? 'mute' : 'sound', () => this.toggleSound());
    service('home', () => s.toMenu());
    // Полного экрана нет в Safari на iPhone — там кнопку не показываем
    if (s.scale.fullscreen.available) {
      service('fullscreen', () => {
        if (s.scale.isFullscreen) s.scale.stopFullscreen();
        else s.scale.startFullscreen();
      });
    }
    // Приглашение по ссылке нужно только в сетевой партии: в кампании эта
    // кнопка молча бросала бы миссию
    if (s.match?.mode === 'online') service('link', () => s.shareInvite());
    this.serviceEnd = sx - step + SB;

    // Строка сетевого статуса живёт над этими кнопками и в локальной
    // партии пуста — обычной игре она не мешает
    this.netText = this.fix(s.add.text(328, sy - 8, '', font(13, 800, UI.accent))
      .setOrigin(0, 1), DEPTH.HUD + 1);
  }

  setHelp(on) {
    this.helpVisible = on;
    for (const o of this.helpPanel) o.setVisible(on);
  }

  toggleHelp() { this.setHelp(!this.helpVisible); }

  setNetStatus(text, color = UI.accent) {
    this.netText?.setText(text).setColor(color);
  }

  /** Снести интерфейс целиком — перед пересборкой под новый размер экрана. */
  destroy() {
    this.inventory?.destroy();
    this.inventory = null;
    this.scene.input.off('pointerup', this._releaseAll, this);
    this.scene.input.off('pointerupoutside', this._releaseAll, this);
    if (this._closeHelp) this.scene.input.off('pointerdown', this._closeHelp);
    if (this._stickMove) {
      this._stickUp();
      this.scene.input.off('pointermove', this._stickMove);
      this.scene.input.off('pointerup', this._stickUp);
      this.scene.input.off('pointerupoutside', this._stickUp);
    }
    for (const o of this.items) o.destroy();
    this.items = [];
    this.holdButtons = [];
    this.weaponButtons = [];
    this.uiRects = [];
    this.helpPanel = [];
  }

  // --------------------------------------------------------------- прочее

  /** Попал ли указатель в интерфейс — тогда это не прицеливание и не камера. */
  isOverUI(pointer) {
    // Указатель — в координатах канваса, интерфейс — внутри рамки
    const px = pointer.x - CFG.FRAME.left, py = pointer.y - CFG.FRAME.top;
    if (py < TOP_H) return true;
    if (this.helpVisible) return true;   // подсказка перекрывает всё поле
    if (pointer.isDown && this._swallowDown != null && pointer.downTime === this._swallowDown) return true;
    if (this.inventory?.isOpen) return true;   // и арсенал тоже
    for (const r of this.uiRects) {
      // Круглые кнопки и проверяются по кругу: по прямоугольнику углы
      // «Огня» и «Прыжка» задевали бы соседа, которого там нет.
      if (r.round) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        if (Math.hypot(px - cx, py - cy) <= r.w / 2) return true;
      } else if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        return true;
      }
    }
    return false;
  }

  setWeaponIndex(i) {
    const w = WEAPONS[i];
    if (!w || !this.slot) return;
    this.slot.name.setText(w.name);
    const key = weaponIcon(this.scene, w);
    if (key) {
      this.slot.icon.setTexture(key).setVisible(true)
        .setScale(fitScale(this.scene, key, this.compact ? 60 : 46));
    } else {
      this.slot.icon.setVisible(false);
    }
  }


  update() {
    const scene = this.scene;
    const turn = scene.turn;
    const team = turn.currentTeam;
    const worm = turn.activeWorm;

    if (this.turnText) {
      this.teamChip.fillColor = TEAM_COLORS[team];
      this.turnText.setText(worm ? `Боец ${worm.name}` : TEAM_NAMES[team]);
      this.turnText.setColor(hex(TEAM_COLORS[team]));
      const shape = scene.shape && scene.shape.id !== 'island' ? ` · ${scene.shape.name}` : '';
      const hooks = scene.hookPerTurn > 0 ? ` · крюков ${scene.hooksLeft}` : '';
      this.subText.setText(`${TEAM_NAMES[team]} · ${scene.terrain.biome.name}${shape} · ${turn.weapon.name}${hooks}`);
    }
    if (this.hookGfx) this._updateHooks(scene);
    if (this.padGfx) this._drawSlingPad(scene);
    if (this.stickGfx) this._drawStick();

    this._updateTimer(turn);
    this._updateWind(scene.wind);
    this._updateTeams(scene);
    this._updateCharge(scene);
    this._updateAmmo(turn);
  }

  _updateTimer(turn) {
    const left = Math.max(0, turn.timeLeft);
    const frac = Phaser.Math.Clamp(left / (this.scene.turnTime ?? CFG.TURN_TIME), 0, 1);
    const urgent = left <= 5;
    const color = urgent ? 0xff6b6b : left <= 12 ? 0xffd166 : 0x6ee36e;

    this.timerText.setText(Math.ceil(left).toString());
    this.timerText.setColor(urgent ? '#ff9a9a' : UI.text);
    // Под конец хода цифра пульсирует: одного цвета мало, его не замечают
    this.timerText.setScale(urgent ? 1 + Math.sin(this.scene.time.now / 90) * 0.09 : 1);

    const g = this.timerGfx;
    const r = 23;
    g.clear();
    g.lineStyle(5, 0x11151d, 0.9);
    g.strokeCircle(this.timerCx, this.timerCy, r);
    if (frac > 0) {
      g.lineStyle(5, color, 1);
      g.beginPath();
      g.arc(this.timerCx, this.timerCy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      g.strokePath();
    }
  }

  _updateWind(wind) {
    const g = this.windGfx;
    const half = this.windHalf ?? 52, cy = this.windCy, cx = this.windCx;
    this.windText.setText(`${Math.abs(Math.round(wind))}`);
    g.clear();
    g.fillStyle(0x11151d, 0.9).fillRect(cx - half, cy - 6, half * 2, 12);
    const k = Phaser.Math.Clamp(wind / CFG.WIND_MAX, -1, 1);
    g.fillStyle(k >= 0 ? 0x6ecbff : 0xffa46e, 1);
    if (k >= 0) g.fillRect(cx, cy - 5, half * k, 10);
    else g.fillRect(cx + half * k, cy - 5, -half * k, 10);
    g.fillStyle(0xffffff, 0.85).fillRect(cx - 1, cy - 9, 2, 18);
  }

  /** Кружки крюков: полные — остались, пустые — истрачены в этот ход. */
  _updateHooks(scene) {
    const g = this.hookGfx;
    g.clear();
    const n = scene.hookPerTurn;
    for (let i = 0; i < n; i++) {
      const x = this.hookX - 11 - (n - 1 - i) * 30;
      if (i < scene.hooksLeft) g.fillStyle(0xffe27a, 1).fillCircle(x, this.hookY, 10);
      else g.lineStyle(2.5, 0xffe27a, 0.35).strokeCircle(x, this.hookY, 9);
    }
    // Потратил трос — плашка вздрагивает: глаз ловит, что счёт изменился
    if (this._hooksShown != null && scene.hooksLeft < this._hooksShown) {
      scene.tweens.add({ targets: this.hookPlate, scaleX: 1.08, scaleY: 1.18, duration: 110, yoyo: true });
    }
    this._hooksShown = scene.hooksLeft;
    this.hookPlate.setAlpha(scene.hooksLeft > 0 ? 1 : 0.55);
    // Строка подсказки: сначала про рогатку, потом про трос
    if (this.hintText) {
      const sling = !!scene.slingHint;
      // Батут ведёт себя не как снаряд — подсказка, пока он в руках
      const spring = scene.slingAim && scene.turn.weapon?.id === 'spring';
      const show = !this.helpVisible && scene.canPlayerAct()
        && (spring || sling || (scene.hookHint && scene.hooksLeft > 0));
      if (show) {
        this.hintText.setText(spring
          ? 'батут: тяни рычаг — полетишь сам по дуге, пружина останется'
          : sling
            ? 'тяни жёлтый рычаг от цели и отпусти'
            : 'коснись светящейся точки — трос подтянет туда');
      }
      this.hintText.setVisible(!!show);
    }
  }

  _updateTeams(scene) {
    for (let t = 0; t < CFG.TEAMS; t++) {
      // Состав команды — из самой партии: в миссиях и в настройках быстрой
      // игры бойцов бывает и один, и четыре, а не всегда по два
      const all = scene.worms.filter((w) => w.team === t);
      const living = all.filter((w) => w.alive);
      const total = living.reduce((a, w) => a + w.health, 0);
      const size = Math.max(1, all.length);
      const b = this.teamBars[t];
      // Полоса не прыгает к новому значению, а стекает к нему
      const want = b.width * Phaser.Math.Clamp(total / (CFG.MAX_HEALTH * size), 0, 1);
      b.shown = b.shown == null ? want : b.shown + (want - b.shown) * 0.12;
      b.bar.width = Math.abs(want - b.shown) < 0.5 ? want : b.shown;
      b.cnt.setText(`${living.length}/${size}`);
    }
  }

  _updateCharge(scene) {
    const g = this.chargeGfx;
    g.clear();
    // Свой заряд или заряд соперника в его ход — дуга одна и та же
    const c = Phaser.Math.Clamp(Math.max(scene.charge, scene.remoteCharge ?? 0), 0, 1);
    if (c <= 0) return;
    const color = c > 0.85 ? 0xff6b6b : c > 0.55 ? 0xffa34d : 0xffd166;
    if (this.powerBar) {
      const b = this.powerBar;
      g.fillStyle(0x11151d, 0.92).fillRoundedRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4, 5);
      g.fillStyle(color, 1).fillRoundedRect(b.x, b.y, Math.max(4, b.w * c), b.h, 4);
      return;
    }
    g.lineStyle(7, c > 0.85 ? 0xff6b6b : c > 0.55 ? 0xffa34d : 0xffd166, 1);
    g.beginPath();
    g.arc(this.chargeCx, this.chargeCy, this.chargeR,
      -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c);
    g.strokePath();
  }

  _updateAmmo(turn) {
    if (!this.slot) return;
    const i = turn.weaponIndex;
    const n = turn.ammoOf ? turn.ammoOf(i) : Infinity;
    const shots = turn.shotsLeft > 1 ? ` · выстрелов ${turn.shotsLeft}` : '';
    this.slot.ammo.setText(
      (Number.isFinite(n) ? `патронов ${n}` : 'патронов ∞') + shots,
    );
  }

}

function hex(n) {
  return `#${n.toString(16).padStart(6, '0')}`;
}
