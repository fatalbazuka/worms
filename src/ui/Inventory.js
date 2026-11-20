import { CFG, DEPTH } from '../config.js';
import { WEAPONS, WEAPON_RARITY } from '../weapons/index.js';
import { weaponIcon, fitScale } from '../core/assets.js';
import { UI, font, ensureButton, ensureRoundButton } from './theme.js';
import { isDesktop } from '../platform/device.js';

// Слой инвентаря: выше всего HUD, включая подсказку управления (HUD + 21).
const D = DEPTH.HUD + 30;

// Размеры плашки. Шире и выше, чем в нижнем ряду HUD: здесь под иконкой
// помещается полное название, а не обрезок, и панель читается как список.
// Размеры — под мышь. Под палец всё в полтора раза крупнее (applyScale):
// на телефоне логический пиксель — около половины экранного, и клетка
// 96x64 выходила с ноготь, а подпись в ней не читалась.
let K = 1;
let BW = 96;
let BH = 64;
let GAP = 10;
const PAD = 20;         // поля панели
let HEAD_H = 44;        // строка заголовка «АРСЕНАЛ» + кнопка закрытия
let CAT_H = 24;         // строка названия категории
let CAT_GAP = 14;       // воздух между категориями
let FOOT_H = 24;        // подсказка «Esc — закрыть»

function applyScale(k) {
  K = k;
  BW = Math.round(96 * k);
  BH = Math.round(64 * k);
  GAP = Math.round(10 * k);
  HEAD_H = Math.round(44 * k);
  CAT_H = Math.round(24 * k);
  CAT_GAP = Math.round(14 * k);
  FOOT_H = Math.round(24 * k);
}
const fz = (n) => Math.round(n * K);

const SCREEN_MARGIN = 24;      // минимальный отступ панели от краёв экрана
const MAX_COLS_PREFERRED = 6;  // шире панель делать незачем: глаз теряет ряд

/**
 * Инвентарь оружия — всплывающая панель поверх игры.
 *
 * Нижний ряд плашек в HUD рассчитан на четыре ствола: с десятком он вылезет
 * за края экрана. Здесь то же самое разложено сеткой по категориям, панель
 * открывается поверх поля и сразу закрывается после выбора — ряд внизу
 * остаётся быстрым доступом к нескольким последним, а полный список живёт тут.
 *
 * Как и HUD, панель не пользуется Container: хит-тест интерактивных объектов
 * внутри контейнера ведёт себя непредсказуемо, а объекты всё равно надо
 * поимённо отдавать интерфейсной камере через rig.ui().
 *
 * Наружу выставлены this.rects (прямоугольники плашек) и this.buttons
 * (id оружия -> центр плашки): раскладка зависит от пропорций экрана, и
 * ни HUD, ни тесты не должны повторять её вычисления у себя.
 */
export class Inventory {
  constructor(scene) {
    this.scene = scene;
    this.items = [];        // всё созданное — для destroy() при повороте экрана
    this.cells = [];        // {index, plate, name, ammo, icon, enabled}
    this.rects = [];
    this.buttons = {};
    this._open = false;

    this.fix = (o, d = D) => scene.rig.ui(o.setScrollFactor(0).setDepth(d));
    applyScale(isDesktop() ? 1 : 1.5);

    this._build();
    this.close();

    // Esc — привычный выход из любого модального окна; в меню он уже так работает
    this._onEsc = () => { if (this._open) this.close(); };
    scene.input.keyboard?.on('keydown-ESC', this._onEsc);
  }

  get isOpen() { return this._open; }

  // ------------------------------------------------------------- раскладка

  /**
   * Категории в порядке первого появления: реестр оружия задаёт и порядок
   * разделов, отдельного списка категорий заводить не нужно — он бы разъезжался
   * с реестром. Оружию без категории достаётся раздел «оружие», так что панель
   * работает и на нынешнем реестре, где категорий ещё нет.
   *
   * Читается поле экземпляра: чтобы `category` из конфига до него доехал,
   * конструктор Weapon должен его сохранять (`this.category = cfg.category`).
   */
  _groups() {
    const order = [];
    const byName = new Map();
    WEAPONS.forEach((w, index) => {
      const cat = w.category || 'оружие';
      if (!byName.has(cat)) { byName.set(cat, []); order.push(cat); }
      byName.get(cat).push({ weapon: w, index });
    });
    return order.map((name) => ({ name, entries: byName.get(name) }));
  }

  /**
   * Число колонок. Сначала берём компактную сетку, но если панель по высоте
   * не влезает в экран, расширяем её вбок: лучше широкая панель, чем ряды,
   * уехавшие под нижние кнопки.
   */
  _pickCols(groups) {
    const availW = CFG.VIEW_W - SCREEN_MARGIN * 2;
    const availH = CFG.VIEW_H - SCREEN_MARGIN * 2;
    const maxCols = Math.max(1, Math.floor((availW - PAD * 2 + GAP) / (BW + GAP)));
    const biggest = Math.max(...groups.map((g) => g.entries.length));

    let cols = Math.min(maxCols, biggest, MAX_COLS_PREFERRED);
    while (cols < maxCols && this._panelHeight(groups, cols) > availH) cols++;
    return cols;
  }

  _panelHeight(groups, cols) {
    let h = PAD + HEAD_H;
    groups.forEach((g, i) => {
      const rows = Math.ceil(g.entries.length / cols);
      h += CAT_H + rows * (BH + GAP) - GAP;
      if (i < groups.length - 1) h += CAT_GAP;
    });
    return h + FOOT_H + PAD;
  }

  // -------------------------------------------------------------- сборка

  _build() {
    const s = this.scene;
    const W = CFG.VIEW_W, H = CFG.VIEW_H;
    const groups = this._groups();
    const cols = this._pickCols(groups);

    const panelW = PAD * 2 + cols * BW + (cols - 1) * GAP;
    const panelH = this._panelHeight(groups, cols);
    const px = Math.round((W - panelW) / 2);
    const py = Math.max(SCREEN_MARGIN, Math.round((H - panelH) / 2));
    this.panelRect = { x: px, y: py, w: panelW, h: panelH };

    this._buildBackdrop(W, H);

    ensureButton(s, `ui-inv-${panelW}x${panelH}`, panelW, panelH, 'normal');
    this.items.push(this.fix(
      s.add.image(px + panelW / 2, py + panelH / 2, `ui-inv-${panelW}x${panelH}`), D + 1,
    ));

    this.items.push(this.fix(
      s.add.text(px + PAD, py + 14, 'АРСЕНАЛ', font(fz(19), 800, UI.accent)).setOrigin(0, 0), D + 2,
    ));
    this._buildClose(px + panelW - PAD - fz(15), py + 14 + fz(9));

    this.cellKey = `ui-inv-cell-${BW}`;
    ensureButton(s, this.cellKey, BW, BH, 'normal');
    ensureButton(s, `${this.cellKey}-on`, BW, BH, 'active');

    let y = py + PAD + HEAD_H;
    for (const g of groups) {
      this.items.push(this.fix(
        s.add.text(px + PAD, y, g.name.toUpperCase(), font(fz(12), 800, UI.textDim))
          .setOrigin(0, 0), D + 2,
      ));
      y += CAT_H;

      g.entries.forEach((entry, k) => {
        const col = k % cols;
        const row = Math.floor(k / cols);
        // Неполный последний ряд центрируем: прижатый влево хвост читается
        // как обрыв списка, а не как его конец.
        const inRow = Math.min(cols, g.entries.length - row * cols);
        const rowW = inRow * BW + (inRow - 1) * GAP;
        const x0 = px + Math.round((panelW - rowW) / 2);
        this._buildCell(entry, x0 + col * (BW + GAP), y + row * (BH + GAP));
      });

      y += Math.ceil(g.entries.length / cols) * (BH + GAP) - GAP + CAT_GAP;
    }

    this.items.push(this.fix(
      s.add.text(px + panelW / 2, py + panelH - PAD - 6, isDesktop() ? 'Esc или клик мимо — закрыть' : 'касание мимо — закрыть',
        font(fz(12), 700, UI.textDim)).setOrigin(0.5, 1), D + 2,
    ));
  }

  /**
   * Затемнение на весь экран. Оно же ловит касание мимо панели: собственного
   * «фона» у сцены нет, а ловить pointerdown глобально нельзя — тот же тап,
   * которым инвентарь открыли, закрыл бы его в этом же кадре.
   */
  _buildBackdrop(W, H) {
    const back = this.scene.add.rectangle(0, 0, W, H, 0x070a10, 0.55).setOrigin(0, 0);
    back.setInteractive({ useHandCursor: false });
    back.on('pointerdown', () => this.close());
    this.backdrop = this.fix(back, D);
    this.items.push(this.backdrop);
  }

  _buildClose(cx, cy) {
    const s = this.scene;
    const r = fz(15);
    ensureRoundButton(s, `ui-inv-close-${r}`, r, 'primary');
    const img = this.fix(s.add.image(cx, cy, `ui-inv-close-${r}`), D + 2);
    img.setInteractive(new Phaser.Geom.Circle(img.width / 2, img.height / 2, r),
      Phaser.Geom.Circle.Contains);
    img.on('pointerdown', () => { img.setScale(0.94); });
    img.on('pointerup', () => { img.setScale(1); this.close(); });
    img.on('pointerout', () => img.setScale(1));
    this.items.push(img);
    this.items.push(this.fix(s.add.text(cx, cy - 1, '✕', font(fz(15), 800)).setOrigin(0.5), D + 3));
    this.buttons.close = { x: cx, y: cy };
    this.rects.push({ x: cx - r, y: cy - r, w: r * 2, h: r * 2 });
  }

  _buildCell({ weapon, index }, x, y) {
    const s = this.scene;
    const cx = x + BW / 2;

    const plate = this.fix(s.add.image(cx, y + BH / 2, this.cellKey), D + 1);
    plate.setInteractive({ useHandCursor: true });
    plate.on('pointerdown', () => plate.setScale(0.94).setTint(0xc9c9c9));
    const release = () => plate.setScale(1).clearTint();
    plate.on('pointerout', release);
    plate.on('pointerup', () => { release(); this._choose(index); });

    // Иконки может не быть (assets собираются отдельным скриптом и файла
    // может не оказаться) — тогда рисуем юникодный значок из реестра.
    const iconKey = weaponIcon(s, weapon);
    const icon = iconKey
      ? this.fix(s.add.image(cx, y + fz(24), iconKey).setOrigin(0.5)
        .setScale(fitScale(s, iconKey, fz(38))), D + 2)
      : this.fix(s.add.text(cx, y + fz(24), weapon.icon, font(fz(20), 800)).setOrigin(0.5), D + 2);

    const name = this.fix(s.add.text(cx, y + fz(43), weapon.name, font(fz(12), 700, UI.textDim))
      .setOrigin(0.5, 0), D + 2);
    // Длинное название иначе наползёт на соседнюю плашку
    if (name.width > BW - 8) name.setScale((BW - 8) / name.width);

    // Номер клавиши: с клавиатуры оружие по-прежнему выбирается цифрами
    if (index < 9) {
      // Цифра — горячая клавиша; под пальцами клавиш нет
      if (isDesktop()) {
        this.items.push(this.fix(s.add.text(x + 7, y + 3, `${index + 1}`,
          font(10, 700, UI.textDim)).setOrigin(0, 0), D + 2));
      }
    }
    const ammo = this.fix(s.add.text(x + BW - fz(7), y + fz(3), '', font(fz(12), 800, UI.accent))
      .setOrigin(1, 0), D + 2);

    this.items.push(plate, icon, name, ammo);
    // Полоска редкости внизу плашки: обычному не нужна
    const rar = WEAPON_RARITY[weapon.rarity];
    if (rar && weapon.rarity !== 'common') {
      this.items.push(this.fix(s.add.rectangle(cx, y + BH - fz(5), BW - fz(22), fz(4), rar.color)
        .setOrigin(0.5), D + 2));
    }
    this.cells.push({ index, weapon, plate, icon, name, ammo, enabled: true, x, y });
    this.rects.push({ x, y, w: BW, h: BH });
    this.buttons[weapon.id] = { x: cx, y: y + BH / 2 };
  }

  // ------------------------------------------------------------- поведение

  _choose(index) {
    const cell = this.cells.find((c) => c.index === index);
    if (cell && !cell.enabled) return;    // пустое оружие не выбирается
    this.scene.turn?.setWeaponIndex(index);
    this.close();
  }

  /** Сколько патронов у текущей команды. Infinity — безлимитное оружие. */
  _ammoOf(index) {
    const turn = this.scene.turn;
    if (!turn) return Infinity;
    if (turn.ammoOf) return turn.ammoOf(index);
    const row = Array.isArray(turn.ammo?.[turn.currentTeam ?? 0])
      ? turn.ammo[turn.currentTeam ?? 0]
      : turn.ammo;
    const n = row?.[index];
    return n === null || n === undefined ? Infinity : n;
  }

  /** Перечитать патроны и подсветить выбранное. Вызывается при каждом открытии. */
  refresh() {
    const current = this.scene.turn?.weaponIndex;
    const guests = this.scene.loadout ?? [];
    for (const c of this.cells) {
      // Арсенал боя — звёздочкой: «это у обеих сторон только в этом бою»
      if (guests.includes(c.weapon.id) && !c.tag) {
        c.tag = this.fix(this.scene.add.text(c.x + fz(8), c.y + fz(22), '★', font(fz(16), 800, '#ffd23f'))
          .setOrigin(0.5), D + 3);
        this.items.push(c.tag);
      }
      const n = this._ammoOf(c.index);
      const empty = n <= 0;
      const on = c.index === current && !empty;

      c.enabled = !empty;
      c.plate.setTexture(on ? `${this.cellKey}-on` : this.cellKey);
      c.plate.setAlpha(empty ? 0.45 : 1);
      c.plate.input.enabled = !empty;
      c.ammo.setText(Number.isFinite(n) ? `${n}` : '∞');
      // На выбранной плашке фон янтарный — светлый текст на нём не читается
      c.ammo.setColor(empty ? '#ff7b7b' : on ? '#2a1c06' : UI.accent);
      c.name.setColor(on ? '#2a1c06' : UI.textDim);
      c.name.setAlpha(empty ? 0.5 : 1);
      if (c.icon.setColor) c.icon.setColor(on ? '#2a1c06' : UI.text);
      c.icon.setAlpha(empty ? 0.4 : 1);
    }
  }

  open() {
    if (this._open) return;
    this._open = true;
    this.refresh();
    for (const o of this.items) o.setVisible(true);
  }

  close() {
    this._open = false;
    for (const o of this.items) o.setVisible(false);
  }

  toggle() { if (this._open) this.close(); else this.open(); }

  /** Пока панель открыта, она перехватывает весь экран — это не прицеливание. */
  isOverUI() { return this._open; }

  destroy() {
    this.scene.input.keyboard?.off('keydown-ESC', this._onEsc);
    for (const o of this.items) o.destroy();
    this.items = [];
    this.cells = [];
    this.rects = [];
    this.buttons = {};
    this._open = false;
  }
}
