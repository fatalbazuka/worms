import { font } from './theme.js';
import { sfx } from '../audio/Sfx.js';
import { haptic } from '../platform/telegram.js';

/**
 * Плашка «🏅 Достижение: …» — в бою и в меню.
 *
 * Маленькая и сбоку от главного: в бою не закрывает ни кнопки, ни
 * прицел, ни плашку хода. Где ей стоять, говорит сцена (place): в
 * вертикальном экране — по центру под лентой оружия, в горизонтальном —
 * слева под ней (по центру там встаёт плашка «Твой ход»). Открылось сразу
 * несколько — показываются по очереди, а не стопкой.
 */
export class AchToasts {
  /**
   * @param {Phaser.Scene} scene
   * @param {object} o
   * @param {(obj) => obj} o.adopt  отдать объект своей камере интерфейса, на свою глубину
   * @param {() => {x:number, y:number, center:boolean}} o.place  где встать:
   *   center — x это середина, иначе левый край; y — верх плашки (экранный)
   */
  constructor(scene, { adopt, place }) {
    this.scene = scene;
    this.adopt = adopt;
    this.place = place;
    this.queue = [];
    this.busy = false;
    scene.events.once('shutdown', () => { this.queue = []; });
  }

  /**
   * Убрать плашку и очередь сразу: на экране итога открытое и так стоит
   * списком, а плашка легла бы поверх него.
   */
  clear() {
    this.queue = [];
    if (this.current) {
      const { timer, pos, parts } = this.current;
      timer.remove();
      this.scene.tweens.killTweensOf([pos, ...parts]);
      for (const o of parts) o.destroy();
    }
    this.current = null;
    this.busy = false;
  }

  /** Показать открытые достижения (описания из таблицы). */
  push(list) {
    for (const a of list ?? []) this.queue.push(a);
    if (!this.busy) this._next();
  }

  _next() {
    const a = this.queue.shift();
    if (!a || !this.scene.sys?.isActive()) { this.busy = false; return; }
    this.busy = true;
    const s = this.scene;
    const { x, y, center } = this.place();
    const h = 74, icon = 50;
    const parts = [];
    const add = (o) => { parts.push(this.adopt(o.setScrollFactor(0))); return o; };
    const title = add(s.add.text(0, 0, `🏅 Достижение: ${a.title}`, font(22, 800, '#ffe27a')).setOrigin(0, 0.5));
    const reward = [a.coins ? `+${a.coins} монет` : '', a.boxes ? 'коробка со скином' : ''].filter(Boolean).join(' · ');
    const sub = add(s.add.text(0, 0, reward || a.desc, font(17, 700, '#8ef0a0')).setOrigin(0, 0.5));
    const w = Math.round(Math.max(300, Math.max(title.width, sub.width) + icon + 52));
    const left = center ? x - w / 2 : x;
    const g = s.add.graphics();
    g.fillStyle(0x1c1440, 0.95).fillRoundedRect(0, 0, w, h, 20);
    g.lineStyle(3, 0xffc247, 0.95).strokeRoundedRect(0, 0, w, h, 20);
    parts.unshift(this.adopt(g.setScrollFactor(0)));
    g.setDepth(title.depth - 1);
    const key = `emoji_${a.icon}`;
    const img = s.textures.exists(key) ? add(s.add.image(0, 0, key).setScale(icon / 128)) : null;
    // Раскладка внутри плашки — от её левого верхнего угла
    const lay = (ox, oy) => {
      g.setPosition(ox, oy);
      img?.setPosition(ox + 16 + icon / 2, oy + h / 2);
      const tx = ox + (img ? 26 + icon : 18);
      title.setPosition(tx, oy + 24);
      sub.setPosition(tx, oy + 52);
    };
    // Въезжает сверху (по центру) или слева (у края) и уезжает обратно
    const from = center ? { x: left, y: y - h - 40 } : { x: left - w - 40, y };
    const pos = { ...from };
    lay(pos.x, pos.y);
    s.tweens.add({ targets: pos, x: left, y, duration: 380, ease: 'Back.easeOut', onUpdate: () => lay(pos.x, pos.y) });
    if (img) s.tweens.add({ targets: img, angle: { from: -25, to: 0 }, scale: { from: icon / 128 * 1.6, to: icon / 128 }, duration: 520, ease: 'Back.easeOut' });
    sfx.play('achievement');
    haptic('win');
    const timer = s.time.delayedCall(2700, () => {
      s.tweens.add({
        targets: pos, x: from.x, y: from.y, duration: 320, ease: 'Cubic.easeIn',
        onUpdate: () => lay(pos.x, pos.y),
        onComplete: () => {
          for (const o of parts) o.destroy();
          this.current = null;
          this._next();
        },
      });
    });
    this.current = { parts, pos, timer };
  }
}
