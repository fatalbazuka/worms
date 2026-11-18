import { CFG, DEPTH } from '../config.js';
import { has, fitScale } from '../core/assets.js';

/**
 * Батут: пружина на полу. Кто на неё встанет или упадёт — летит вверх.
 *
 * Свой поставил — лифт на этаж выше; поставил у чужого — ловушка, которая
 * подбросит его под удар или с этажа. Живёт, как мина, между ходами (в
 * списке сцены, не снарядов), но не взрывается: взрыв рядом её ломает, и
 * после USES прыжков она изнашивается.
 *
 * Всё решает только положение бойца, поэтому у обоих игроков по сети
 * батут срабатывает одинаково: подбрасывание идёт из той же физики шага.
 */
export const SPRING_VY = -880;     // скорость вверх: примерно два этажа башни
const USES = 4;
const HALF = 18;                   // полуширина площадки

export class Spring {
  constructor(scene, x, y, owner = null, uses = USES) {
    this.scene = scene;
    this.terrain = scene.terrain;
    this.owner = owner;
    this.x = x;
    this.y = y;
    this.vy = 0;
    this.uses = uses;
    this.alive = true;
    this.cool = new Map();          // боец → сек, пока батут его не трогает

    if (has(scene, 'shot_spring')) {
      this.view = scene.add.image(x, y, 'shot_spring').setOrigin(0.5, 1)
        .setScale(fitScale(scene, 'shot_spring', 40));
    } else {
      this.view = scene.add.rectangle(x, y, HALF * 2, 10, 0xec4848).setOrigin(0.5, 1);
    }
    this.baseScaleY = this.view.scaleY;
    scene.rig.world(this.view.setDepth(DEPTH.WORM - 1));
  }

  update(dt) {
    if (!this.alive) return;
    // Опуститься на пол: ставят стоя, под ногами может быть пусто
    if (!this.terrain.solidInRow(this.x - 6, this.x + 6, this.y + 1)) {
      this.vy = Math.min(this.vy + CFG.GRAVITY * dt, 700);
      const step = this.vy * dt;
      const ray = this.terrain.raycast(this.x, this.y, this.x, this.y + step);
      if (ray.hit) { this.y = ray.freeY; this.vy = 0; } else this.y += step;
      if (this.y > CFG.DROWN_Y) { this.destroy(); return; }
    }

    for (const [w, t] of this.cool) {
      if (t - dt <= 0) this.cool.delete(w); else this.cool.set(w, t - dt);
    }
    for (const w of this.scene.worms) {
      if (!w.alive || w.zip || w.hang || this.cool.has(w)) continue;
      if (Math.abs(w.x - this.x) > HALF) continue;
      // Ноги бойца на площадке: стоит на ней или падает на неё сверху
      const feet = w.y;
      const top = this.y - 14;
      if (feet < top - 6 || feet > this.y + 2) continue;
      if (!w.grounded && w.vy < 0) continue;
      this._launch(w);
    }
    this.view.setPosition(Math.round(this.x), Math.round(this.y));
  }

  _launch(w) {
    w.applyImpulse(0, 0);
    w.vx *= 0.5;
    w.vy = SPRING_VY;
    w.fallStartY = w.y;
    w.squash = -0.9;
    this.cool.set(w, 0.6);
    this.uses -= 1;
    this.scene.fx?.sound('jump');
    this.scene.tweens?.add({
      targets: this.view, scaleY: { from: this.baseScaleY * 0.55, to: this.baseScaleY },
      duration: 260, ease: 'Back.easeOut',
    });
    if (this.uses <= 0) this.scene.time?.delayedCall(300, () => this.destroy());
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.view.destroy();
  }
}
