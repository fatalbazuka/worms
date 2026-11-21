import { CFG, DEPTH, TEAM_COLORS } from '../config.js';
import { TOP_H } from './Hud.js';
import { font } from './theme.js';

/**
 * Журнал хода: кто выбыл и почему — строкой в углу, пока свежо.
 * Выкрик над бойцом можно прозевать (камера ушла за снарядом), а строка
 * висит несколько секунд. Не больше четырёх строк: старые уходят первыми.
 */
const LIFE = 5200;
const MAX = 4;

export class KoLog {
  constructor(scene) {
    this.scene = scene;
    this.rows = [];
  }

  /** Справа под лентой оружия и строкой подсказки: слева — плашки достижений. */
  _place() {
    const W = CFG.VIEW_W;
    const top = TOP_H + 150;
    return { x: W - 16 - (CFG.CORNER || 0), y: top };
  }

  add(team, text) {
    const s = this.scene;
    const color = `#${(TEAM_COLORS[team] ?? 0xffffff).toString(16).padStart(6, '0')}`;
    const t = s.rig.ui(s.add.text(0, 0, `✖ ${text}`, font(18, 800, color))
      .setOrigin(1, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 4).setStroke('#10131a', 5).setAlpha(0));
    this.rows.unshift(t);
    while (this.rows.length > MAX) this.rows.pop().destroy();
    this._layout();
    s.tweens.add({ targets: t, alpha: 1, duration: 200 });
    s.time.delayedCall(LIFE, () => {
      if (!t.active) return;
      s.tweens.add({
        targets: t, alpha: 0, duration: 400,
        onComplete: () => { this.rows = this.rows.filter((r) => r !== t); t.destroy(); },
      });
    });
  }

  _layout() {
    const p = this._place();
    this.rows.forEach((t, i) => t.setPosition(p.x, p.y + i * 26));
  }

  clear() {
    for (const t of this.rows) t.destroy();
    this.rows = [];
  }
}
