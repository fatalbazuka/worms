import { DEPTH } from '../config.js';
import { has } from '../core/assets.js';

/**
 * Облако ядовитого газа.
 *
 * Висит там, где лопнула колба, turns ходов. В конце каждого хода (своего
 * и чужого) травит всех, кто внутри, на damage — GameScene.tickHazards — и
 * чуть сносится ветром. Как мины и батуты, живёт в списке сцены и едет в
 * снимке партии: урон считает только тот, кто ходил, зритель получает итог.
 */
export class GasCloud {
  constructor(scene, x, y, cfg, owner = null) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.r = cfg.radius ?? 72;
    this.turns = cfg.turns ?? 3;
    this.dmg = cfg.damage ?? 10;
    this.owner = owner;
    this.alive = true;
    this.t = 0;

    // Несколько зелёных клубов: эмодзи ☁️, перекрашенное в яд, или круги
    this.puffs = [];
    const cloud = has(scene, 'emoji_cloud');
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const k = i === 0 ? 0 : 0.55;
      const ox = Math.cos(a) * this.r * k, oy = Math.sin(a) * this.r * k * 0.6;
      const size = this.r * (i === 0 ? 1.2 : 0.85);
      const v = cloud
        ? scene.add.image(x + ox, y + oy, 'emoji_cloud').setScale(size / 128).setTint(0x7fdc3a)
        : scene.add.circle(x + ox, y + oy, size / 2, 0x7fdc3a);
      v.setAlpha(0).setDepth(DEPTH.FX ?? 50);
      scene.rig.world(v);
      this.puffs.push({ v, ox, oy, ph: i * 1.3 });
      scene.tweens.add({ targets: v, alpha: 0.5, duration: 400 });
    }
    this.label = scene.rig.world(scene.add.text(x, y, '☠️', { fontSize: '22px' })
      .setOrigin(0.5).setDepth((DEPTH.FX ?? 50) + 1).setAlpha(0.85));
  }

  contains(w) {
    return Math.hypot(w.x - this.x, w.centerY - this.y) <= this.r;
  }

  /** Только картинка: клубы колышутся. */
  update(dt) {
    if (!this.alive) return;
    this.t += dt;
    for (const p of this.puffs) {
      p.v.setPosition(this.x + p.ox + Math.sin(this.t * 0.9 + p.ph) * 5, this.y + p.oy + Math.cos(this.t * 0.7 + p.ph) * 3);
    }
    this.label.setPosition(this.x, this.y + Math.sin(this.t * 1.5) * 3);
  }

  /**
   * Конец хода: травим тех, кто внутри, сносимся ветром, стареем.
   * @returns {number} сколько бойцов задело
   */
  tick() {
    const s = this.scene;
    let hit = 0;
    for (const w of s.worms) {
      if (!w.alive || !this.contains(w)) continue;
      w.damage(this.dmg, 'газ');
      s._countHit?.(w, this.dmg);
      hit++;
    }
    this.x = Math.round(this.x + Math.max(-30, Math.min(30, (s.wind ?? 0) * 0.12)));
    this.turns--;
    if (this.turns <= 0) this.destroy();
    else for (const p of this.puffs) p.v.setAlpha(0.2 + 0.12 * this.turns);
    return hit;
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    for (const p of this.puffs) {
      this.scene.tweens.add({ targets: p.v, alpha: 0, duration: 500, onComplete: () => p.v.destroy() });
    }
    this.label.destroy();
  }
}
