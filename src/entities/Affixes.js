import { CFG, DEPTH } from '../config.js';
import { subRng } from '../core/rng.js';
import { Projectile } from './Projectile.js';
import { Weapon } from '../weapons/Weapon.js';

/**
 * Аффиксы — особые правила уровня, которые заставляют двигаться.
 *
 * У каждого уровня свой список (match.affixes), по умолчанию — от вида
 * башни (DEFAULT_AFFIXES). Срабатывают в паузе между ходами, вместе с ходом
 * монстров (GameScene.runMonsters): «фаза» — одна такая пауза.
 *
 *   vent     — жерло под ногами: под случайным бойцом трескается пол и
 *              дымит; через полный круг ходов (каждый успел походить)
 *              жерло извергается. Надо уйти или улететь тросом;
 *   eruption — извержение: с неба падают лавовые бомбы, место — метка;
 *   gust     — порыв метели: всех стоящих бойцов толкает по ветру;
 *   icicles  — сосульки: над бойцами под потолком вырастают сосульки и
 *              через полный круг ходов падают; место падения — метка;
 *   meteors  — метеоритный дождь наискосок, место — метка.
 *
 * Всё решается от зерна партии и номера хода — у двух игроков это было бы
 * одинаково, поэтому аффиксы потом можно включить и в сетевой игре. Пока
 * они только без сети: фаз между ходами в сетевой партии нет.
 */

export const AFFIXES = {
  vent: { name: 'Жерло под ногами', desc: 'под бойцом трескается пол — через круг извергается' },
  eruption: { name: 'Извержение', desc: 'с неба падают лавовые бомбы' },
  gust: { name: 'Метель', desc: 'порывы ветра толкают бойцов' },
  icicles: { name: 'Сосульки', desc: 'с потолков над бойцами падают сосульки' },
  meteors: { name: 'Метеориты', desc: 'метеоритный дождь наискосок' },
};

/** Аффиксы по виду башни, если уровень не задал свои. */
export const DEFAULT_AFFIXES = {
  ice: ['gust'],
  lava: ['eruption'],
  space: ['meteors'],
};

const LAVA_BOMB = new Weapon({
  id: 'fireball', name: 'Лавовая бомба', color: 0xff7a2a,
  projectile: { radius: 9, windScale: 0, gravityScale: 1 },
  explosion: { radius: 34, damageRadius: 64, damage: 24, knockback: 260, shake: 0.008 },
});
const METEOR = new Weapon({
  id: 'rock', name: 'Метеорит', color: 0x9a8a7a,
  projectile: { radius: 8, windScale: 0, gravityScale: 1 },
  explosion: { radius: 30, damageRadius: 60, damage: 22, knockback: 240, shake: 0.007 },
});
const ICICLE = new Weapon({
  id: 'icicle', name: 'Сосулька', color: 0xbfe8ff,
  projectile: { radius: 6, windScale: 0, gravityScale: 1.2, trail: false },
  explosion: { radius: 18, damageRadius: 40, damage: 30, knockback: 160, shake: 0.004 },
});
const VENT_BLAST = { radius: 34, damageRadius: 62, damage: 38, knockback: 480, shake: 0.012 };

/** Сколько фаз ждать до срабатывания: полный круг — каждая команда походила. */
const ROUND = 2;

export class Affixes {
  constructor(scene, ids, seed = 0) {
    this.scene = scene;
    this.ids = ids.filter((id) => AFFIXES[id]);
    this.seed = seed >>> 0;
    this.timers = [];     // { left, fire(), cancel() } — отложенные события
    this.pending = 0;     // снаряды, которые вот-вот вылетят
    this.phase = 0;
    this._iceTex();
  }

  get list() { return this.ids.map((id) => ({ id, ...AFFIXES[id] })); }

  /** Сказать в начале боя, что здесь особенного. */
  announce() {
    if (!this.ids.length) return;
    const text = this.list.map((a) => a.name).join(' · ');
    // Сеть поднимается позже, чем строится башня: проверяем в момент показа
    this.scene.time.delayedCall(3400, () => {
      if (!this.scene.net) this.scene.fx.banner(`Аффиксы: ${text}`, '#ffd166', 2600, null);
    });
  }

  /**
   * Фаза между ходами. turn — номер только что отыгранного хода.
   * @returns {boolean} есть ли чего ждать
   */
  run(turn) {
    const s = this.scene;
    if (s.net || !this.ids.length) return false;
    this.phase += 1;
    let any = false;
    // Сначала — то, что подготовлено раньше
    for (const t of [...this.timers]) {
      t.left -= 1;
      if (t.left <= 0) {
        this.timers.splice(this.timers.indexOf(t), 1);
        t.fire();
        any = true;
      } else t.tick?.(t.left);
    }
    if (turn < 2) return any;
    const r = subRng(this.seed ^ 0x9e37, turn);
    for (const id of this.ids) {
      if (this[`_${id}`]?.(r, turn)) any = true;
    }
    return any;
  }

  get busy() { return this.pending > 0; }

  _alive() { return this.scene.worms.filter((w) => w.alive); }

  // ------------------------------------------------------------ жерло

  _vent(r, turn) {
    if (turn % 3 !== 0 || this.timers.filter((t) => t.kind === 'vent').length >= 2) return false;
    const s = this.scene;
    const alive = this._alive();
    if (!alive.length) return false;
    const w = alive[Math.floor(r() * alive.length)];
    const x = Math.round(w.x), y = Math.round(w.y);
    // Трещина в полу, дым и отсчёт
    const g = s.rig.world(s.add.graphics().setDepth(DEPTH.WORM - 1));
    // Свечение, тёмная трещина и раскалённая щель — видно из-под бойца
    g.fillStyle(0xff2a00, 0.6).fillEllipse(x, y + 1, 96, 28);
    g.fillStyle(0x1a0a05, 0.95).fillEllipse(x, y + 2, 64, 13);
    g.fillStyle(0xffb347, 0.95).fillEllipse(x, y + 2, 42, 5);
    // Отсчёт — под полом, чтобы не налезать на здоровье бойца
    const label = s.rig.world(s.add.text(x, y + 26, `${ROUND}`, { fontFamily: '"Worms UI", system-ui, sans-serif', fontSize: '26px', fontStyle: '800', color: '#ff8a3d' })
      .setOrigin(0.5).setStroke('#1a0a05', 5).setDepth(DEPTH.FX));
    s.tweens.add({ targets: g, alpha: 0.7, yoyo: true, repeat: -1, duration: 320 });
    const smoke = s.time.addEvent({
      delay: 380, loop: true, callback: () => {
        const p = s.rig.world(s.add.circle(x + (Math.random() - 0.5) * 20, y - 4, 7, 0x3a3030, 0.55).setDepth(DEPTH.WORM - 1));
        s.tweens.add({ targets: p, y: y - 70, scale: 2.4, alpha: 0, duration: 1500, onComplete: () => p.destroy() });
      },
    });
    s.fx.banner('Под бойцом трещит пол — уходи!', '#ffb37a', 1600);
    const cleanup = () => { smoke.remove(); g.destroy(); label.destroy(); };
    this.timers.push({
      kind: 'vent', left: ROUND,
      tick: (left) => label.setText(`${left}`),
      fire: () => {
        cleanup();
        // Столб огня — и взрыв снизу вверх
        const col = s.rig.world(s.add.rectangle(x, y, 26, 10, 0xff7a2a, 0.9).setOrigin(0.5, 1).setDepth(DEPTH.FX));
        s.tweens.add({ targets: col, displayHeight: 220, alpha: 0, duration: 650, ease: 'Quad.easeOut', onComplete: () => col.destroy() });
        s.explode(x, y - 6, VENT_BLAST, null);
      },
    });
    return true;
  }

  // ------------------------------------------------------------ сосульки

  _iceTex() {
    const s = this.scene;
    if (s.textures.exists('shot_icicle')) return;
    // Сосулька носом вправо: снаряд поворачивается по полёту и падает носом вниз
    const t = s.textures.createCanvas('shot_icicle', 40, 16);
    const ctx = t.getContext();
    ctx.fillStyle = '#d8f3ff'; ctx.strokeStyle = '#3d6f8f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(2, 2); ctx.lineTo(38, 8); ctx.lineTo(2, 14); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(4, 5, 14, 2);
    t.refresh();
  }

  _icicles(r, turn) {
    if (turn % 2 !== 0 || r() > 0.75) return false;
    const s = this.scene;
    let made = 0;
    for (const w of this._alive()) {
      if (made >= 2 || r() > 0.6) continue;
      // Потолок над головой: первая твердь вверх в пределах 320 px
      const x = Math.round(w.x);
      let cy = null;
      for (let y = Math.round(w.y - CFG.WORM_H - 6); y > w.y - 320; y -= 2) {
        if (s.terrain.solidAt(x, y)) { cy = y + 2; break; }
      }
      if (cy === null) continue;
      made += 1;
      const ice = s.rig.world(s.add.image(x, cy, 'shot_icicle').setOrigin(0.05, 0.5).setAngle(90).setDepth(DEPTH.WORM));
      s.tweens.add({ targets: ice, angle: { from: 86, to: 94 }, yoyo: true, repeat: -1, duration: 160 });
      const floor = s.terrain.surfaceYAt(x, cy + 20) ?? CFG.WATER_Y;
      const mark = s.rig.world(s.add.circle(x, floor - 3, 13, 0x9fd8ff, 0.3).setStrokeStyle(3, 0xffffff, 0.8).setDepth(DEPTH.FX));
      s.tweens.add({ targets: mark, scale: 0.6, yoyo: true, repeat: -1, duration: 300 });
      this.timers.push({
        kind: 'icicle', left: ROUND,
        fire: () => {
          ice.destroy(); mark.destroy();
          s.projectiles.push(new Projectile(s, x, cy + 18, 0, 60, ICICLE, null));
        },
      });
    }
    if (made) s.fx.banner('Над головой растут сосульки', '#cfeaff', 1400);
    return made > 0;
  }

  // ------------------------------------------------------------ метель

  _gust(r, turn) {
    if (turn % 2 !== 0 || r() > 0.6) return false;
    const s = this.scene;
    const dir = (s.wind ?? 0) >= 0 ? 1 : -1;
    const power = 150 + r() * 90;
    s.fx.banner(dir > 0 ? 'Порыв метели → ' : ' ← Порыв метели', '#cfeaff', 1400);
    s.ambience?.gust(dir);
    for (const w of s.worms) {
      if (!w.alive || !w.grounded || w.hang || w.zip) continue;
      w.applyImpulse(dir * power, -90);
    }
    s.rig.shake(300, 0.003);
    return true;
  }

  // ------------------------------------------------------- падает с неба

  _eruption(r, turn) {
    if (turn % 3 !== 0) return false;
    return this._fallers(r, LAVA_BOMB, 'Извержение! Берегись лавовых бомб', '#ffb37a', 3, 0);
  }

  _meteors(r, turn) {
    if (turn % 3 !== 0) return false;
    return this._fallers(r, METEOR, 'Метеоритный дождь!', '#c9b8ff', 3, 0.35);
  }

  /** С неба падают снаряды: метка на полу за секунду до удара. */
  _fallers(r, weapon, text, color, count, slant) {
    const s = this.scene;
    const alive = this._alive();
    if (!alive.length) return false;
    s.fx.banner(text, color, 1600);
    for (let i = 0; i < count; i++) {
      const target = alive[Math.floor(r() * alive.length)];
      const tx = Math.round(Math.max(30, Math.min(s.terrain.width - 30, target.x + (r() - 0.5) * 260)));
      const floor = s.terrain.surfaceYAt(tx, 0) ?? CFG.WATER_Y;
      const mark = s.rig.world(s.add.circle(tx, floor - 3, 16, 0xff4a2a, 0.35)
        .setStrokeStyle(3, 0xffd166, 0.9).setDepth(DEPTH.FX));
      s.tweens.add({ targets: mark, scale: 0.6, alpha: 0.9, yoyo: true, repeat: -1, duration: 260 });
      const fall = 520;
      const vx = slant * fall * (r() < 0.5 ? -1 : 1);
      this.pending += 1;
      s.time.delayedCall(700 + i * 380, () => {
        this.pending -= 1;
        mark.destroy();
        if (!s.sys.isActive()) return;
        // Стартуем над экраном так, чтобы прийти точно в метку
        const h = 700;
        const t = (-fall + Math.sqrt(fall * fall + 2 * CFG.GRAVITY * h)) / CFG.GRAVITY;
        s.projectiles.push(new Projectile(s, tx - vx * t, floor - h, vx, fall, weapon, null));
      });
    }
    return true;
  }
}
