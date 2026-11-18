import { CFG, DEPTH } from '../config.js';
import { has } from '../core/assets.js';
import { sfx } from '../audio/Sfx.js';
import { font, UI } from './theme.js';

// Мельче этого взрываются только бомблеты кассеты (радиус 22) — им
// положен сухой щелчок, а не полноценный бабах.
const SMALL_BLAST = 24;

// «Синие — ход 3»: так выглядит объявление хода и только оно.
const TURN_BANNER = /—\s*ход\s+\d/i;

/**
 * Визуальные эффекты: взрывы, брызги, всплывающие числа урона.
 *
 * Здесь же живёт и звук. Не потому, что ему тут место по смыслу, а потому
 * что каждый эффект уже вызывается ровно там, где событие произошло: один
 * вызов fx.explosion() даёт и картинку, и грохот, и остальному коду не надо
 * помнить про вторую подсистему.
 */
export class Fx {
  constructor(scene) {
    this.scene = scene;
    // Наружу — чтобы звуки без визуальной пары (шаг, прыжок, тик таймера,
    // выбор оружия) звались тем же fx, а не отдельным импортом в каждом файле.
    this.sfx = sfx;
  }

  // ---------------------------------------------------------------- частицы

  /** Белая точка — заготовка для всех частиц; красится оттенком. */
  _dot() {
    const s = this.scene;
    if (!s.textures.exists('fx-dot')) {
      const tex = s.textures.createCanvas('fx-dot', 12, 12);
      const ctx = tex.getContext();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(6, 6, 5.5, 0, Math.PI * 2); ctx.fill();
      tex.refresh();
    }
    return 'fx-dot';
  }

  /**
   * Разовый выброс частиц. Живёт столько, сколько живут частицы, потом
   * убирает за собой. ui — в экранных координатах поверх игры (конфетти).
   */
  burst(x, y, {
    count = 10, colors = [0xffffff], speed = [80, 220], angle = [0, 360], gravity = 600,
    life = [350, 700], scale = [0.9, 0.2], ui = false, depth = DEPTH.FX,
  } = {}) {
    const s = this.scene;
    const em = s.add.particles(x, y, this._dot(), {
      speed: { min: speed[0], max: speed[1] },
      angle: { min: angle[0], max: angle[1] },
      gravityY: gravity,
      lifespan: { min: life[0], max: life[1] },
      scale: { start: scale[0], end: scale[1] },
      alpha: { start: 1, end: 0.2 },
      tint: colors,
      emitting: false,
    });
    em.setDepth(depth);
    if (ui) s.rig.ui(em.setScrollFactor(0)); else s.rig.world(em);
    em.explode(count);
    s.time.delayedCall(life[1] + 150, () => em.destroy());
    return em;
  }

  /** Куски земли из воронки: летят вверх веером и падают. */
  debris(x, y, radius) {
    const b = this.scene.terrain?.biome?.fallback ?? {};
    const colors = [b.fill, b.fillDark, b.rim].filter(Boolean)
      .map((c) => Number.parseInt(String(c).replace('#', ''), 16)).filter(Number.isFinite);
    this.burst(x, y, {
      count: Math.round(6 + radius / 4), colors: colors.length ? colors : [0x6b4a2a, 0x4a3320],
      speed: [90 + radius * 2, 220 + radius * 4], angle: [205, 335], gravity: 900,
      life: [450, 900], scale: [0.5 + radius / 60, 0.25],
    });
  }

  /** Ударная волна: тонкое кольцо, быстро расходится и тает. */
  shockwave(x, y, radius) {
    const s = this.scene;
    const ring = s.rig.world(s.add.circle(x, y, radius * 0.4).setDepth(DEPTH.FX));
    ring.setStrokeStyle(4, 0xffffff, 0.75);
    s.tweens.add({
      targets: ring, radius: radius * 2.1, alpha: 0, duration: 300,
      ease: 'Cubic.easeOut', onComplete: () => ring.destroy(),
    });
  }

  /** Облачко пыли: приземлился, крюк впился в стену. */
  dust(x, y, count = 6) {
    this.burst(x, y, {
      count, colors: [0xd8cdb8, 0xb8ad98], speed: [30, 110], angle: [190, 350], gravity: 120,
      life: [250, 480], scale: [0.7, 0.1],
    });
  }

  /** Боец выбит: жёлтые брызги и тяжёлый звук. */
  knockout(x, y) {
    sfx.play('knockout');
    this.burst(x, y, {
      count: 16, colors: [0xffd21f, 0xffb300, 0xffffff], speed: [120, 320], angle: [0, 360],
      gravity: 700, life: [400, 800], scale: [0.9, 0.2],
    });
  }

  /** Конфетти сверху экрана — победа. */
  confetti() {
    const colors = [0xff5a5a, 0x5aa9ff, 0x6ee36e, 0xffd45a, 0xff8ad4, 0xffffff];
    for (let i = 0; i < 5; i++) {
      this.scene.time.delayedCall(i * 160, () => {
        this.burst(CFG.VIEW_W * (0.15 + Math.random() * 0.7), -10, {
          count: 22, colors, speed: [60, 320], angle: [20, 160], gravity: 420,
          life: [1500, 2600], scale: [1.1, 0.5], ui: true, depth: DEPTH.HUD + 10,
        });
      });
    }
  }

  // ------------------------------------------------------------------ ветер

  /**
   * Ветер на глаз: по экрану несёт короткие штрихи — в ту сторону и тем
   * быстрее, чем сильнее дует. Цифра в углу говорит «сколько», а штрихи —
   * «куда и насколько это много», их видно, не отрывая глаз от прицела.
   */
  updateWind(dt) {
    const s = this.scene;
    const wind = s.wind ?? 0;
    if (!this.windGfx) {
      this.windGfx = s.rig.ui(s.add.graphics().setScrollFactor(0).setDepth(DEPTH.HUD - 2));
      this.streaks = Array.from({ length: 18 }, () => ({
        x: Math.random() * CFG.VIEW_W, y: Math.random() * CFG.VIEW_H, k: 0.6 + Math.random() * 0.8,
      }));
    }
    const g = this.windGfx;
    g.clear();
    const force = Math.abs(wind) / CFG.WIND_MAX;
    if (force < 0.05) return;
    const W = CFG.VIEW_W, H = CFG.VIEW_H;
    const len = (10 + force * 46) * Math.sign(wind);
    for (const p of this.streaks) {
      p.x += wind * 1.5 * p.k * dt;
      p.y += 26 * p.k * dt;
      if (p.x < -60) { p.x = W + 40; p.y = Math.random() * H; }
      if (p.x > W + 60) { p.x = -40; p.y = Math.random() * H; }
      if (p.y > H + 10) p.y = -10;
      g.lineStyle(2, 0xffffff, 0.1 + force * 0.22 * p.k);
      g.lineBetween(p.x, p.y, p.x - len * p.k, p.y - 3);
    }
  }

  /** Звук без картинки: fx.sound('jump'), fx.sound('tick'). */
  sound(name, opts) {
    return sfx.play(name, opts);
  }

  /**
   * Телепорт: голубое кольцо схлопывается там, где боец был, и
   * разворачивается там, где он появился. Без взрыва и без грохота.
   */
  warp(x, y, outward = true) {
    const s = this.scene;
    sfx.play('pickup');
    for (let i = 0; i < 2; i++) {
      const ring = s.rig.world(s.add.circle(x, y, outward ? 6 : 34)
        .setStrokeStyle(3, i ? 0xffffff : 0x9fd2ff, 0.95).setDepth(DEPTH.FX));
      s.tweens.add({
        targets: ring, radius: outward ? 38 : 4, alpha: 0,
        duration: 380 + i * 140, ease: 'Cubic.easeOut', onComplete: () => ring.destroy(),
      });
    }
  }

  explosion(x, y, radius) {
    const s = this.scene;
    sfx.play(radius <= SMALL_BLAST ? 'smallExplosion' : 'explosion', { radius });
    // Волна, обломки и короткий «наезд» камеры — взрыв должен ощущаться
    this.shockwave(x, y, radius);
    if (radius > SMALL_BLAST) {
      this.debris(x, y, radius);
      s.rig.punch?.(0.012 + radius / 2600);
    }

    // Взрыв из оригинала собирается из двух примитивов: белая вспышка
    // (кадр 0 fx_flash), оранжевое кольцо (кадр 3) и облачка дыма.
    if (has(s, 'fx_flash')) {
      const flash = s.rig.world(s.add.sprite(x, y, 'fx_flash', 0).setDepth(DEPTH.FX));
      flash.setDisplaySize(radius * 2.2, radius * 2.2).setScale(flash.scaleX * 0.35);
      const full = radius * 2.2;
      s.tweens.add({
        targets: flash, displayWidth: full, displayHeight: full, alpha: 0,
        duration: 260, ease: 'Quad.easeOut', onComplete: () => flash.destroy(),
      });

      const ring = s.rig.world(s.add.sprite(x, y, 'fx_flash', 3).setDepth(DEPTH.FX));
      ring.setDisplaySize(radius * 0.7, radius * 0.7);
      s.tweens.add({
        targets: ring, displayWidth: radius * 3, displayHeight: radius * 3, alpha: 0,
        duration: 360, ease: 'Cubic.easeOut', onComplete: () => ring.destroy(),
      });

      if (has(s, 'fx_smoke') && s.anims.exists('fx_smoke')) {
        const puffs = Math.max(3, Math.round(radius / 12));
        for (let i = 0; i < puffs; i++) {
          const a = (i / puffs) * Math.PI * 2 + Math.random();
          const d = radius * (0.2 + Math.random() * 0.7);
          const puff = s.rig.world(s.add.sprite(x + Math.cos(a) * d, y + Math.sin(a) * d, 'fx_smoke')
            .setDepth(DEPTH.FX - 1));
          puff.setDisplaySize(radius * 1.1, radius * 1.1);
          puff.play({ key: 'fx_smoke', startFrame: Math.floor(Math.random() * 4) });
          puff.once('animationcomplete', () => puff.destroy());
        }
      }
      return;
    }

    // Плейсхолдер: вспышка + разлетающиеся искры
    const flash = s.rig.world(s.add.circle(x, y, radius, 0xfff1c1).setDepth(DEPTH.FX).setScale(0.4));
    s.tweens.add({
      targets: flash, scale: 1.5, alpha: 0, duration: 280,
      ease: 'Quad.easeOut', onComplete: () => flash.destroy(),
    });

    const ring = s.rig.world(s.add.circle(x, y, radius).setDepth(DEPTH.FX).setScale(0.25));
    ring.setStrokeStyle(4, 0xff9a3c, 0.9);
    ring.setFillStyle(0xff6a2c, 0.35);
    s.tweens.add({
      targets: ring, scale: 1.7, alpha: 0,
      duration: 340, ease: 'Cubic.easeOut', onComplete: () => ring.destroy(),
    });

    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = radius * (0.6 + Math.random() * 1.1);
      const p = s.rig.world(s.add.circle(x, y, 2 + Math.random() * 3, 0xffc46b).setDepth(DEPTH.FX));
      s.tweens.add({
        targets: p,
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        alpha: 0,
        duration: 300 + Math.random() * 300,
        ease: 'Quad.easeOut',
        onComplete: () => p.destroy(),
      });
    }
  }

  splash(x, y = CFG.WATER_Y) {
    const s = this.scene;
    sfx.play('splash');
    for (let i = 0; i < 8; i++) {
      const p = s.rig.world(s.add.circle(x, y, 2 + Math.random() * 3, 0x9fd8ff, 0.9).setDepth(DEPTH.FX));
      s.tweens.add({
        targets: p,
        x: x + (Math.random() - 0.5) * 70,
        y: y - 30 - Math.random() * 50,
        alpha: 0,
        duration: 420 + Math.random() * 220,
        ease: 'Quad.easeOut',
        onComplete: () => p.destroy(),
      });
    }
  }

  damageNumber(x, y, amount) {
    const s = this.scene;
    // Число урона всплывает над каждым получившим по шее — это и есть
    // единственная точка, общая для взрыва, падения и утопления.
    sfx.play('hurt');
    // Сильный удар — число крупнее и краснее: глаз должен отличать
    // царапину от попадания в упор
    const heavy = amount >= 35;
    const t = s.add.text(x, y, `-${amount}`, font(heavy ? 30 : 22, 800, heavy ? '#ff5a5a' : '#ff9a9a'))
      .setOrigin(0.5).setDepth(DEPTH.FX + 1).setStroke('#1a0a0a', 4).setScale(0.4);
    s.rig.world(t);
    s.tweens.add({ targets: t, scale: heavy ? 1.25 : 1, duration: 200, ease: 'Back.easeOut' });
    s.tweens.add({
      targets: t, y: y - (heavy ? 64 : 46), alpha: 0, duration: 800, delay: 260,
      ease: 'Quad.easeOut', onComplete: () => t.destroy(),
    });
  }

  /** Всплывающая подпись о подобранном ящике. */
  pickup(x, y, text, color = '#ffd166') {
    const s = this.scene;
    sfx.play('pickup');
    const t = s.rig.world(s.add.text(x, y - 18, text, font(16, 800, color))
      .setOrigin(0.5).setDepth(DEPTH.FX + 1));
    s.tweens.add({
      targets: t, y: y - 62, alpha: 0, duration: 1100,
      ease: 'Quad.easeOut', onComplete: () => t.destroy(),
    });
  }

  /**
   * Плашка по центру экрана.
   *
   * sound — имя звука; можно передать null, если плашка должна быть немой,
   * или 'victory' / 'defeat' в конце партии. По умолчанию объявление хода
   * (единственная плашка с распознаваемым форматом) звучит сигналом «теперь
   * ты», остальные — коротким кликом уведомления: они и есть уведомления.
   */
  banner(text, color = '#ffffff', duration = 1600, sound = undefined) {
    const s = this.scene;
    sfx.play(sound === undefined ? (TURN_BANNER.test(text) ? 'turnStart' : 'select') : sound);
    const t = s.add.text(CFG.VIEW_W / 2, 168, text, font(34, 800, color))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 5);
    t.setAlign('center');
    s.rig.ui(t);
    t.setScale(0.7);
    s.tweens.add({ targets: t, scale: 1, duration: 220, ease: 'Back.easeOut' });
    s.tweens.add({
      targets: t, alpha: 0, delay: duration - 400, duration: 400,
      onComplete: () => t.destroy(),
    });
    return t;
  }
}
