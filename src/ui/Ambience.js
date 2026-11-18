import { CFG, DEPTH, canvasSize } from '../config.js';
import { subRng } from '../core/rng.js';

/**
 * Атмосфера вида башни: дальний фон и частицы в воздухе — только для
 * красоты, у всех и везде (и в сетевой игре).
 *
 *   classic — холмы в два слоя и птицы; падают листья;
 *   ice     — северное сияние и ледяные пики; метель по ветру;
 *   lava    — зарево снизу и дым; искры летят вверх;
 *   wind    — пыль несётся по ветру;
 *   space   — туманности и падающие звёзды.
 *
 * Правила, которые меняют бой (метель толкает, извержение, сосульки…), —
 * в entities/Affixes.js.
 */

export class Ambience {
  constructor(scene, variantId = 'classic', seed = 0) {
    this.scene = scene;
    this.kind = variantId;
    this.seed = seed >>> 0;
    this.items = [];
    this._build();
  }

  // ------------------------------------------------------------ фон

  _tex(key, w, h, draw) {
    const s = this.scene;
    if (!s.textures.exists(key)) {
      const t = s.textures.createCanvas(key, w, h);
      draw(t.getContext(), w, h);
      t.refresh();
    }
    return key;
  }

  /** Дальний слой: картинка на всю ширину мира, медленный параллакс. */
  _far(key, y, alpha = 1, sf = 0.3) {
    const s = this.scene;
    const img = s.rig.world(s.add.tileSprite(0, y, CFG.WORLD_W, s.textures.get(key).getSourceImage().height, key)
      .setOrigin(0, 1).setScrollFactor(sf, 0.6).setAlpha(alpha).setDepth(DEPTH.PARALLAX - 1));
    this.items.push(img);
    return img;
  }

  _build() {
    const r = subRng(this.seed, 0xa7b1);
    const [cw, ch] = canvasSize();
    const ground = CFG.WATER_Y;
    if (this.kind === 'classic') {
      // Два ряда мягких холмов
      // Повторяемые текстуры — со сторонами степени двойки: иначе WebGL не
      // умеет их тайлить, и слой просто не рисуется
      for (const [k, color, hgt, a] of [['amb-hills-far', '#41617a', 220, 0.55], ['amb-hills-near', '#2f4b3f', 160, 0.6]]) {
        this._tex(k, 1024, 256, (ctx, w, h) => {
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.moveTo(0, h);
          for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h - hgt * 0.65 + Math.sin(x / 90 + hgt) * hgt * 0.18 + Math.sin(x / 37) * hgt * 0.06);
          ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
        });
        this._far(k, ground + 20, a, k.endsWith('far') ? 0.2 : 0.35);
      }
      this._particles('leaf', {
        x: { min: 0, max: cw }, y: -10, lifespan: 9000, speedY: { min: 30, max: 60 }, speedX: { min: -30, max: 30 },
        rotate: { start: 0, end: 360 }, scale: { min: 0.8, max: 1.4 }, frequency: 380, alpha: 0.9,
      }, (ctx) => {
        ctx.fillStyle = '#9ccc4a'; ctx.beginPath(); ctx.ellipse(12, 7, 11, 6, 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#5e8a2a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(2, 9); ctx.lineTo(22, 5); ctx.stroke();
      }, 24, 14);
      this._birds(r);
    } else if (this.kind === 'ice') {
      // Северное сияние: полупрозрачные ленты, медленно колышутся
      this._tex('amb-aurora', 1024, 256, (ctx, w, h) => {
        for (const [c, off] of [['rgba(80,255,180,0.7)', 0], ['rgba(90,200,255,0.6)', 40], ['rgba(170,120,255,0.45)', 80]]) {
          const g = ctx.createLinearGradient(0, 0, 0, h);
          g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, c); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(0, h);
          for (let x = 0; x <= w; x += 8) ctx.lineTo(x, 60 + off + Math.sin(x / 120 + off) * 50);
          for (let x = w; x >= 0; x -= 8) ctx.lineTo(x, 160 + off + Math.sin(x / 140 + off) * 40);
          ctx.closePath(); ctx.fill();
        }
      });
      // Над задником биома (он непрозрачный), под башней: камера мира
      // По вертикали закреплено вверху экрана, по горизонтали — медленный параллакс
      const aurora = this.scene.rig.world(this.scene.add.tileSprite(0, 70, CFG.WORLD_W * 1.6, 256, 'amb-aurora')
        .setOrigin(0, 0).setScrollFactor(0.3, 0).setDepth(DEPTH.PARALLAX + 0.5).setAlpha(1).setScale(1, 1.6));
      this.items.push(aurora);
      this.scene.tweens.add({ targets: aurora, alpha: 0.6, yoyo: true, repeat: -1, duration: 3200, ease: 'Sine.easeInOut' });
      this._auroraScroll = aurora;
      this._tex('amb-peaks', 1024, 256, (ctx, w, h) => {
        ctx.fillStyle = '#9fb6d8';
        ctx.beginPath(); ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 64) { ctx.lineTo(x + 32, h * (0.15 + ((x * 7) % 5) * 0.08)); ctx.lineTo(x + 64, h * 0.7); }
        ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
      });
      this._far('amb-peaks', ground + 30, 0.35, 0.2);
      this.snow = this._particles('snow', {
        x: { min: -200, max: cw + 200 }, y: -10, lifespan: 9000, speedY: { min: 110, max: 220 },
        speedX: { min: -20, max: 20 }, scale: { min: 0.5, max: 1.3 }, frequency: 35, alpha: { min: 0.6, max: 1 },
      }, (ctx) => { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(8, 8, 7, 0, Math.PI * 2); ctx.fill(); }, 16, 16);
    } else if (this.kind === 'lava') {
      // Сторона не степень двойки — WebGL не повторяет текстуру, и верхний
      // край не смешивается с ярким нижним (иначе поперёк неба полоса)
      this._tex('amb-glow', 6, 250, (ctx, w, h) => {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, 'rgba(255,80,20,0)'); g.addColorStop(0.35, 'rgba(255,80,20,0.12)');
        g.addColorStop(1, 'rgba(255,90,20,0.9)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      });
      const glow = this.scene.rig.world(this.scene.add.image(-400, ground + 40, 'amb-glow').setOrigin(0, 1)
        .setDisplaySize(CFG.WORLD_W + 800, 1100).setDepth(DEPTH.PARALLAX + 0.5));
      this.items.push(glow);
      this.scene.tweens.add({ targets: glow, alpha: 0.6, yoyo: true, repeat: -1, duration: 1400, ease: 'Sine.easeInOut' });
      this._particles('smoke', {
        x: { min: 0, max: CFG.WORLD_W }, y: ground, lifespan: 12000, speedY: { min: -70, max: -40 }, speedX: { min: -8, max: 8 },
        scale: { start: 1.5, end: 6 }, alpha: { start: 0.35, end: 0 }, frequency: 500,
      }, (ctx) => { ctx.fillStyle = '#2a1e1e'; ctx.beginPath(); ctx.arc(16, 16, 15, 0, Math.PI * 2); ctx.fill(); }, 32, 32, DEPTH.PARALLAX + 0.6, 'world');
      this._particles('ember', {
        x: { min: 0, max: cw }, y: ch + 10, lifespan: 6000, speedY: { min: -220, max: -110 }, speedX: { min: -25, max: 25 },
        scale: { start: 1.2, end: 0.2 }, alpha: { start: 1, end: 0 }, frequency: 70, blendMode: 'ADD',
      }, (ctx) => { ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.arc(6, 6, 5.5, 0, Math.PI * 2); ctx.fill(); }, 12, 12);
    } else if (this.kind === 'wind') {
      this.dust = this._particles('dust', {
        x: -20, y: { min: 0, max: ch }, lifespan: 4000, speedX: { min: 200, max: 380 }, speedY: { min: -10, max: 10 },
        scale: { min: 0.8, max: 1.6 }, alpha: { min: 0.25, max: 0.55 }, frequency: 60,
      }, (ctx) => { ctx.fillStyle = '#f3e0b5'; ctx.fillRect(0, 1, 28, 3); }, 28, 5);
    } else if (this.kind === 'space') {
      // Туманности: большие мягкие пятна цвета
      this._tex('amb-nebula', 512, 512, (ctx, w, h) => {
        for (const [x, y, rr, c] of [[150, 180, 200, '120,60,200'], [360, 300, 180, '40,120,220'], [260, 120, 140, '220,60,160']]) {
          const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
          g.addColorStop(0, `rgba(${c},0.35)`); g.addColorStop(1, `rgba(${c},0)`);
          ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        }
      });
      for (let i = 0; i < 3; i++) {
        const n = this.scene.rig.world(this.scene.add.image(CFG.WORLD_W * (0.15 + i * 0.4), 300 + i * 450, 'amb-nebula')
          .setScale(2.2).setScrollFactor(0.25, 0.4).setDepth(DEPTH.PARALLAX + 0.5).setAngle(i * 70));
        this.items.push(n);
      }
      this._shootingStars();
    }
  }

  /** Эмиттер частиц поверх поля (под интерфейсом), координаты — экранные. */
  _particles(name, cfg, draw, w, h, depth = DEPTH.HUD - 5, where = 'ui') {
    const s = this.scene;
    const key = this._tex(`amb-p-${name}`, w, h, draw);
    const em = s.add.particles(0, 0, key, cfg).setDepth(depth);
    if (where === 'world') s.rig.world(em);
    else s.rig.ui(em.setScrollFactor(0));
    this.items.push(em);
    return em;
  }

  _birds(r) {
    const s = this.scene;
    const key = this._tex('amb-bird', 20, 10, (ctx) => {
      ctx.strokeStyle = '#1e2a38'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(1, 3); ctx.quadraticCurveTo(5, 0, 10, 6); ctx.quadraticCurveTo(15, 0, 19, 3); ctx.stroke();
    });
    const [cw, ch] = canvasSize();
    const fly = () => {
      if (!s.sys.isActive()) return;
      const y = ch * (0.12 + r() * 0.25);
      for (let i = 0; i < 3; i++) {
        const b = s.rig.bg(s.add.image(-40 - i * 26, y + i * 10, key).setScrollFactor(0).setDepth(DEPTH.SKY + 3).setAlpha(0.7));
        s.tweens.add({ targets: b, x: cw + 60, duration: 14000 + i * 600, onComplete: () => b.destroy() });
        s.tweens.add({ targets: b, scaleY: 0.4, yoyo: true, repeat: -1, duration: 260 });
      }
      s.time.delayedCall(16000 + r() * 12000, fly);
    };
    s.time.delayedCall(2500, fly);
  }

  _shootingStars() {
    const s = this.scene;
    const [cw, ch] = canvasSize();
    const r = subRng(this.seed, 0x5e77);
    const go = () => {
      if (!s.sys.isActive()) return;
      const g = s.rig.bg(s.add.graphics().setScrollFactor(0).setDepth(DEPTH.SKY + 3));
      const x0 = r() * cw, y0 = r() * ch * 0.4;
      const t = { k: 0 };
      s.tweens.add({
        targets: t, k: 1, duration: 900, onUpdate: () => {
          g.clear();
          const x = x0 + t.k * 260, y = y0 + t.k * 120;
          g.lineStyle(2, 0xffffff, 1 - t.k).lineBetween(x - 60, y - 28, x, y);
        }, onComplete: () => g.destroy(),
      });
      s.time.delayedCall(3000 + r() * 5000, go);
    };
    s.time.delayedCall(1500, go);
  }

  /** Каждый кадр: метель и пыль летят по ветру, сияние едет. */
  update(dt) {
    const wind = this.scene.wind ?? 0;
    if (this.snow) this.snow.speedX = wind * 0.5;
    if (this._auroraScroll) this._auroraScroll.tilePositionX += dt * 6;
    if (this.dust) this.dust.speedX = 200 + Math.abs(wind);
  }

  /** Порыв метели (аффикс gust): снег на секунду несёт вбок. */
  gust(dir) {
    if (!this.snow) return;
    this.snow.speedX = dir * 600;
    this.scene.time.delayedCall(1200, () => { if (this.snow) this.snow.speedX = (this.scene.wind ?? 0) * 0.5; });
  }

  destroy() {
    for (const o of this.items) o?.destroy?.();
    this.items = [];
  }
}
