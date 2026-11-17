import { IMAGES, SHEETS, meta, missing } from '../core/assets.js';
import { onlineMatch } from '../core/match.js';
import { startRoom } from '../platform/telegram.js';

/**
 * Загрузка спрайтов. Отсутствие любого файла не ломает игру:
 * ключ помечается как missing, и вместо спрайта рисуется плейсхолдер.
 *
 * Размеры кадров спрайтшитов берутся из sprite-meta.js, который
 * генерирует tools/build_assets.py вместе с самими картинками.
 */
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  preload() {
    const W = this.scale.width, H = this.scale.height;
    this.add.rectangle(0, 0, W, H, 0x0b1021).setOrigin(0, 0);
    const label = this.add.text(W / 2, H / 2, 'Загрузка…', {
      fontFamily: '"Worms UI", system-ui, sans-serif', fontSize: '22px',
      fontStyle: '800', color: '#93a4bd',
    }).setOrigin(0.5);

    this.load.on('loaderror', (file) => missing.add(file.key));
    this.load.on('progress', (p) => label.setText(`Загрузка… ${Math.round(p * 100)}%`));

    for (const [key, path] of Object.entries(IMAGES)) {
      this.load.image(key, path);
    }
    for (const key of Object.keys(SHEETS)) {
      const m = meta(key);
      if (!m) { console.warn(`[assets] нет размеров кадра для ${key}`); continue; }
      this.load.spritesheet(key, `assets/${key}.png`, {
        frameWidth: m.frameWidth,
        frameHeight: m.frameHeight,
      });
    }
  }

  create() {
    for (const [key, def] of Object.entries(SHEETS)) {
      if (!def.anims || missing.has(key) || !this.textures.exists(key)) continue;
      const total = this.textures.get(key).frameTotal - 1; // минус служебный __BASE
      for (const [animKey, a] of Object.entries(def.anims)) {
        if (this.anims.exists(animKey)) continue;
        const start = a.start ?? 0;
        const end = a.end ?? total - 1;
        if (end < start) continue;
        this.anims.create({
          key: animKey,
          // Либо отрезок кадров подряд, либо явный список номеров
          frames: a.frames
            ? a.frames.map((frame) => ({ key, frame }))
            : this.anims.generateFrameNumbers(key, { start, end }),
          frameRate: a.frameRate,
          repeat: a.repeat,
        });
      }
    }

    const total = Object.keys(IMAGES).length + Object.keys(SHEETS).length;
    if (missing.size) {
      console.info(
        `[assets] загружено ${total - missing.size}/${total}. ` +
        `Плейсхолдеры для: ${[...missing].join(', ')}`,
      );
    }

    // Ссылка-приглашение ведёт прямо в партию, минуя меню: открыл — играешь
    const online = Boolean(startRoom());
    if (online) this.registry.set('match', onlineMatch());
    this.scene.start(online ? 'Game' : 'Menu');
  }
}
