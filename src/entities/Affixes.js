import { CFG, DEPTH, canvasSize } from '../config.js';
import { has } from '../core/assets.js';
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
 *   meteors  — метеоритный дождь наискосок, место — метка;
 *   storm    — гроза: над самой высокой точкой башни собирается туча, через
 *              круг ходов бьёт молния и выбивает кусок вершины;
 *   gravity  — скачок гравитации: на один ход тяжесть слабеет вдвое.
 *
 * Где подходит эмодзи — он и есть картинка, оживлённый анимацией: дым 💨
 * из трещины, столб 🔥, метка ⚠️, удар 💥, ветер 🌬️, комета ☄️, туча 🌩️ и
 * ⚡, воронка 🌀 и ✨. Нет картинки — рисуем простыми фигурами.
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
  storm: { name: 'Гроза', desc: 'молния бьёт в вершину башни и выбивает кусок' },
  gravity: { name: 'Скачок гравитации', desc: 'на ход тяжесть слабеет — всё летит выше' },
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
  id: 'meteor', name: 'Метеорит', color: 0x9a8a7a,
  projectile: { radius: 8, windScale: 0, gravityScale: 1 },
  explosion: { radius: 30, damageRadius: 60, damage: 22, knockback: 240, shake: 0.007 },
});
const ICICLE = new Weapon({
  id: 'icicle', name: 'Сосулька', color: 0xbfe8ff,
  projectile: { radius: 6, windScale: 0, gravityScale: 1.2, trail: false },
  explosion: { radius: 18, damageRadius: 40, damage: 30, knockback: 160, shake: 0.004 },
});
const VENT_BLAST = { radius: 34, damageRadius: 62, damage: 38, knockback: 480, shake: 0.012 };
const BOLT = { radius: 46, damageRadius: 72, damage: 45, knockback: 380, shake: 0.016 };

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
    this._meteorTex();
  }

  /** Эмодзи-картинка в мире (или null, если не загрузилась). */
  _emoji(name, x, y, size, depth = DEPTH.FX) {
    const s = this.scene;
    const key = `emoji_${name}`;
    if (!has(s, key)) return null;
    return s.rig.world(s.add.image(x, y, key).setScale(size / 128).setDepth(depth));
  }

  /** Эмодзи поверх экрана (камера интерфейса, под кнопками). */
  _emojiUi(name, x, y, size) {
    const s = this.scene;
    const key = `emoji_${name}`;
    if (!has(s, key)) return null;
    return s.rig.ui(s.add.image(x, y, key).setScale(size / 128).setScrollFactor(0).setDepth(DEPTH.HUD - 4));
  }

  /** Метка «сюда упадёт»: ⚠️ пульсирует (или круг, если эмодзи нет). */
  _mark(x, y, color = 0xff4a2a) {
    const s = this.scene;
    const m = this._emoji('warning', x, y - 18, 34)
      ?? s.rig.world(s.add.circle(x, y - 3, 16, color, 0.35).setStrokeStyle(3, 0xffd166, 0.9).setDepth(DEPTH.FX));
    s.tweens.add({ targets: m, scale: m.scale * 0.7, alpha: 0.75, yoyo: true, repeat: -1, duration: 260 });
    return m;
  }

  /** 💥 на месте удара. */
  _boom(x, y, size = 70) {
    const s = this.scene;
    const b = this._emoji('boom', x, y, size * 0.4, DEPTH.FX + 1);
    if (!b) return;
    s.tweens.add({ targets: b, scale: (size / 128) * 1.3, alpha: 0, duration: 520, ease: 'Back.easeOut', onComplete: () => b.destroy() });
  }

  /** Комета ☄️ как снаряд: копия эмодзи под ключом shot_meteor. */
  _meteorTex() {
    const s = this.scene;
    if (s.textures.exists('shot_meteor') || !has(s, 'emoji_comet')) return;
    const t = s.textures.createCanvas('shot_meteor', 72, 72);
    t.getContext().drawImage(s.textures.get('emoji_comet').getSourceImage(), 0, 0, 72, 72);
    t.refresh();
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
      delay: 420, loop: true, callback: () => {
        const dx = (Math.random() - 0.5) * 24;
        const p = this._emoji('dash', x + dx, y - 4, 22, DEPTH.WORM - 1)
          ?? s.rig.world(s.add.circle(x + dx, y - 4, 7, 0x3a3030, 0.55).setDepth(DEPTH.WORM - 1));
        p.setAngle(-90);
        s.tweens.add({ targets: p, y: y - 80, scale: p.scale * 2.2, alpha: 0, duration: 1500, onComplete: () => p.destroy() });
      },
    });
    s.fx.banner('Под бойцом трещит пол — уходи!', '#ffb37a', 1600);
    const cleanup = () => { smoke.remove(); g.destroy(); label.destroy(); };
    this.timers.push({
      kind: 'vent', left: ROUND,
      tick: (left) => label.setText(`${left}`),
      fire: () => {
        cleanup();
        // Столб огня 🔥 — и взрыв снизу вверх
        for (let i = 0; i < 6; i++) {
          const f = this._emoji('fire', x + (i % 2 ? 6 : -6), y - 10, 40 - i * 3, DEPTH.FX);
          if (!f) break;
          s.tweens.add({
            targets: f, y: y - 40 - i * 34, alpha: 0, scale: f.scale * 1.4,
            delay: i * 45, duration: 700, ease: 'Quad.easeOut', onComplete: () => f.destroy(),
          });
        }
        if (!has(s, 'emoji_fire')) {
          const col = s.rig.world(s.add.rectangle(x, y, 26, 10, 0xff7a2a, 0.9).setOrigin(0.5, 1).setDepth(DEPTH.FX));
          s.tweens.add({ targets: col, displayHeight: 220, alpha: 0, duration: 650, ease: 'Quad.easeOut', onComplete: () => col.destroy() });
        }
        this._boom(x, y - 10, 80);
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
      const mark = this._mark(x, floor, 0x9fd8ff);
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
    const [cw, ch] = canvasSize();
    const face = this._emojiUi('windface', dir > 0 ? -80 : cw + 80, ch * 0.32, 150);
    if (face) {
      face.setFlipX(dir < 0);
      s.tweens.add({ targets: face, x: dir > 0 ? cw + 120 : -120, duration: 1300, ease: 'Sine.easeInOut', onComplete: () => face.destroy() });
    }
    for (let i = 0; i < 6; i++) {
      const f = this._emojiUi('snowflake', dir > 0 ? -40 : cw + 40, ch * (0.2 + i * 0.1), 40);
      if (!f) break;
      s.tweens.add({
        targets: f, x: dir > 0 ? cw + 60 : -60, angle: dir * 540, delay: i * 90,
        duration: 1100, onComplete: () => f.destroy(),
      });
    }
    for (const w of s.worms) {
      if (!w.alive || !w.grounded || w.hang || w.zip) continue;
      w.applyImpulse(dir * power, -90);
    }
    s.rig.shake(300, 0.003);
    return true;
  }

  // ------------------------------------------------------------ гроза

  /** Самая высокая точка башни: x и верх тверди. */
  _peak() {
    const t = this.scene.terrain;
    let best = null;
    for (let x = 30; x < t.width - 30; x += 6) {
      const y = t.surfaceYAt(x, 0);
      if (y !== null && y < CFG.WATER_Y - 40 && (!best || y < best.y)) best = { x, y };
    }
    return best;
  }

  _storm(r, turn) {
    if (turn % 3 !== 0 || this.timers.some((t) => t.kind === 'storm')) return false;
    const s = this.scene;
    const p = this._peak();
    if (!p) return false;
    // Туча 🌩️ над вершиной покачивается и мигает; на вершине — ⚠️
    // Вершина бывает у самого верха мира — туча не выше, чем видно под панелью
    const cy = Math.max(150, p.y - 110);
    const cloud = this._emoji('storm', p.x, cy, 110, DEPTH.FX)
      ?? s.rig.world(s.add.ellipse(p.x, cy, 120, 50, 0x3a4050, 0.9).setDepth(DEPTH.FX));
    s.tweens.add({ targets: cloud, x: p.x + 10, yoyo: true, repeat: -1, duration: 900, ease: 'Sine.easeInOut' });
    const flicker = s.time.addEvent({
      delay: 1100, loop: true, callback: () => {
        cloud.setTintFill?.(0xfff6a8);
        s.time.delayedCall(70, () => cloud.clearTint?.());
      },
    });
    const mark = this._mark(p.x, p.y);
    s.fx.banner('Гроза собирается над вершиной', '#ffe27a', 1500);
    this.timers.push({
      kind: 'storm', left: ROUND,
      fire: () => {
        flicker.remove(); mark.destroy();
        // Бьёт в то, что сейчас выше всех у этой точки
        const y = s.terrain.surfaceYAt(p.x, 0) ?? p.y;
        this._bolt(p.x, y);
        s.tweens.add({ targets: cloud, alpha: 0, delay: 400, duration: 500, onComplete: () => cloud.destroy() });
        s.explode(p.x, y + 6, BOLT, null);
      },
    });
    return true;
  }

  /** Молния ⚡: зигзаг сверху вниз, вспышка экрана. */
  _bolt(x, y) {
    const s = this.scene;
    const g = s.rig.world(s.add.graphics().setDepth(DEPTH.FX + 2));
    const pts = [[x, y - 520]];
    for (let i = 1; i < 9; i++) pts.push([x + (i % 2 ? 1 : -1) * (10 + (i * 13) % 17), y - 520 + i * 58]);
    pts.push([x, y]);
    for (const [w, c, a] of [[12, 0x8fd0ff, 0.45], [5, 0xfff6c8, 1]]) {
      g.lineStyle(w, c, a).beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (const [px, py] of pts.slice(1)) g.lineTo(px, py);
      g.strokePath();
    }
    s.tweens.add({ targets: g, alpha: 0, delay: 180, duration: 260, onComplete: () => g.destroy() });
    const z = this._emoji('zap', x, y - 30, 30, DEPTH.FX + 3);
    if (z) s.tweens.add({ targets: z, scale: 0.9, alpha: 0, duration: 600, ease: 'Back.easeOut', onComplete: () => z.destroy() });
    const [cw, ch] = canvasSize();
    const flash = s.rig.ui(s.add.rectangle(0, 0, cw, ch, 0xffffff, 0.55).setOrigin(0).setScrollFactor(0).setDepth(DEPTH.HUD - 3));
    s.tweens.add({ targets: flash, alpha: 0, duration: 260, onComplete: () => flash.destroy() });
    s.fx.sound?.('explosion', { radius: 60 });
  }

  // ------------------------------------------------------------ гравитация

  _gravity(r, turn) {
    if (turn % 3 !== 1 || r() > 0.8 || this.timers.some((t) => t.kind === 'gravity')) return false;
    const s = this.scene;
    s.setGravityMul?.(0.5);
    s.fx.banner('Скачок гравитации — на этот ход всё летит выше!', '#c9b8ff', 1800);
    const [cw, ch] = canvasSize();
    const vortex = this._emojiUi('cyclone', cw / 2, ch * 0.3, 130);
    if (vortex) {
      vortex.setAlpha(0.8);
      s.tweens.add({ targets: vortex, angle: 720, scale: vortex.scale * 1.6, alpha: 0, duration: 1600, onComplete: () => vortex.destroy() });
    }
    // ✨ всплывают вверх, пока тяжесть слабая
    const sparkle = s.time.addEvent({
      delay: 260, loop: true, callback: () => {
        const sp = this._emojiUi('sparkles', Math.random() * cw, ch + 10, 26 + Math.random() * 16);
        if (sp) s.tweens.add({ targets: sp, y: ch * 0.2, alpha: 0, duration: 2600, onComplete: () => sp.destroy() });
      },
    });
    this.timers.push({
      kind: 'gravity', left: 1,
      fire: () => { sparkle.remove(); s.setGravityMul?.(1); s.fx.banner('Тяжесть вернулась', '#c9b8ff', 1100); },
    });
    return false;
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
      const mark = this._mark(tx, floor);
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
