/**
 * Голоса смайликов: короткие фразы, записанные заранее (assets/voice).
 *
 * Эффекты синтезируются (Sfx.js), а речь так не собрать, поэтому здесь
 * всё-таки файлы — десять фраз по полсекунды-секунде, около 100 КБ вместе.
 * Грузятся не при старте, а после первого жеста, когда звук уже разрешён:
 * на загрузку игры голоса не влияют.
 *
 * Звучат через тот же общий регулятор, что и эффекты: выключенный звук
 * выключает и голоса. Говорит один за раз: пока фраза не кончилась, новая
 * не начинается — иначе после взрыва по троим выходил бы хор.
 *
 * У соперника голос чуть выше (playbackRate): одна актриса, но свою
 * команду от чужой на слух отличить можно.
 *
 *   import { voice } from '../audio/Voice.js';
 *   voice.say('laugh', { team: 1 });
 */
import { sfx } from './Sfx.js';

export const VOICE_LINES = {
  laugh: 'Ха-ха!',
  angry: 'Ну всё!',
  cry: 'Ну за что…',
  oops: 'Мимо!',
  wow: 'Ого!',
  gg: 'Хорошая игра!',
  hurt: 'Ой!',
  shot: 'Получай!',
  win: 'Победа!',
  lose: 'Не-е-ет!',
};

const PITCH = [1, 1.14, 0.92, 1.24];   // по команде
const GAP_MS = 250;                    // тишина между фразами

class Voice {
  constructor() {
    this.buffers = new Map();
    this._loading = null;
    this._busyUntil = 0;
  }

  /** Загрузить все фразы. Ошибка загрузки — просто без голоса. */
  load() {
    if (this._loading) return this._loading;
    const ctx = sfx.ctx;
    if (!ctx || typeof fetch === 'undefined') return Promise.resolve();
    this._loading = Promise.all(Object.keys(VOICE_LINES).map(async (name) => {
      try {
        const res = await fetch(`assets/voice/${name}.mp3`);
        if (!res.ok) return;
        const data = await res.arrayBuffer();
        // Старый Safari знает только форму с колбэками
        const buf = await new Promise((ok, fail) => {
          const p = ctx.decodeAudioData(data, ok, fail);
          if (p?.then) p.then(ok, fail);
        });
        this.buffers.set(name, buf);
      } catch { /* без этой фразы */ }
    }));
    return this._loading;
  }

  /**
   * Сказать фразу. opts.team — чей голос (высота), opts.force — перебить
   * правило «один за раз» (итог боя важнее всего).
   * @returns {boolean} прозвучало ли
   */
  say(name, { team = 0, force = false } = {}) {
    if (sfx.muted || !VOICE_LINES[name]) return false;
    const ctx = sfx.ctx;
    if (!ctx || ctx.state !== 'running') return false;
    if (!this._loading) this.load();
    const buf = this.buffers.get(name);
    if (!buf) return false;
    const now = performance.now();
    if (!force && now < this._busyUntil) return false;
    try {
      this._current?.stop();
    } catch { /* уже доиграла */ }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = PITCH[team % PITCH.length] ?? 1;
    src.playbackRate.value = rate;
    src.connect(sfx.master);
    src.start(ctx.currentTime + 0.02);
    this._current = src;
    this._busyUntil = now + (buf.duration / rate) * 1000 + GAP_MS;
    this.last = name;
    return true;
  }
}

export const voice = new Voice();

// Как только звук разрешён первым жестом — подгрузить фразы заранее
if (typeof window !== 'undefined') {
  const warm = () => {
    window.removeEventListener('pointerdown', warm, true);
    window.removeEventListener('keydown', warm, true);
    setTimeout(() => voice.load(), 0);
  };
  window.addEventListener('pointerdown', warm, true);
  window.addEventListener('keydown', warm, true);
}
