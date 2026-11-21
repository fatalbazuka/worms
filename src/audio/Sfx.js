/**
 * Звук без единого аудиофайла: всё синтезируется в WebAudio на лету.
 *
 * Так сделано намеренно. Готовые сэмплы — это ещё сотни килобайт загрузки,
 * лицензии и папка, которую надо держать в порядке; для прототипа с десятком
 * коротких эффектов проще собрать их из осцилляторов и шума. Заодно у звука
 * появляются параметры: взрыв мелкого бомблета и взрыв крота — одна и та же
 * функция с разным радиусом, а не два разных файла.
 *
 * Пользоваться так:
 *
 *   import { sfx } from '../audio/Sfx.js';
 *   sfx.play('explosion', { radius: 40 });
 *
 * Контекст создаётся при первом касании экрана или нажатии клавиши: до
 * жеста пользователя браузеры звук не пускают, и созданный раньше контекст
 * так и остался бы в состоянии suspended.
 */

const STORE_KEY = 'worms.sound.v1';

// Один и тот же звук чаще этого — уже не звук, а треск: шаги идут по
// нескольку раз за кадр, осколки взрываются пачкой. Повторы глушим.
const THROTTLE_MS = 40;

const DEFAULT_VOLUME = 0.7;

// Звук назначается не «прямо сейчас», а чуть вперёд. Браузер считает
// аудиобуфер с опережением, и всё, что попало в уже посчитанный кусок,
// просто теряется: замеры показали, что при сдвиге в 5 мс короткие щелчки
// (шаг, тик) выходили в 40 раз тише положенного, а то и в тишину.
// 20 мс хватает с запасом и на слух как задержка не читаются.
const SCHEDULE_LEAD = 0.02;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Настройки звука. Хранилище может быть недоступно — это не повод падать. */
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const data = raw ? JSON.parse(raw) : null;
    const vol = Number(data?.volume);
    return {
      volume: Number.isFinite(vol) ? clamp(vol, 0, 1) : DEFAULT_VOLUME,
      muted: Boolean(data?.muted),
    };
  } catch {
    return { volume: DEFAULT_VOLUME, muted: false };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* режим инкогнито и прочее — просто не запоминаем */ }
}

// ---------------------------------------------------------------------------
// Кирпичики, из которых собраны голоса
// ---------------------------------------------------------------------------

// Секунда белого шума на контекст. Генерировать буфер на каждый выстрел
// дорого (это 44100 вызовов Math.random), а зациклить один и стартовать со
// случайного места — на слух то же самое.
const NOISE_BUFFERS = new WeakMap();

function noiseSource(ctx) {
  let buf = NOISE_BUFFERS.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    NOISE_BUFFERS.set(ctx, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

/**
 * Огибающая «щелчок и затухание»: короткая атака, дальше спад до тишины.
 * Спад экспоненциальный — линейный слышен как обрыв, а не как затухание.
 * Ноль в exponentialRamp запрещён, поэтому дно — неслышимая 0.0001.
 */
function envelope(ctx, { t, peak, attack = 0.005, dur }) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return g;
}

/** Тон: осциллятор с необязательным скольжением частоты from → to. */
function tone(ctx, out, { type = 'sine', from, to = from, t, dur, peak = 0.2, attack = 0.005 }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
  const env = envelope(ctx, { t, peak, attack, dur });
  osc.connect(env).connect(out);
  osc.start(t);
  // Хвост в 20 мс — чтобы источник не оборвался раньше конца огибающей.
  osc.stop(t + dur + 0.02);
  return osc;
}

/**
 * Шумовой пласт через фильтр. Скольжение среза from → to и делает характер:
 * вверх — брызги и шипение, вниз — оседающая после взрыва пыль.
 */
function hiss(ctx, out, {
  t, dur, peak = 0.2, attack = 0.005,
  filter = 'lowpass', from = 1000, to = from, q = 1,
}) {
  const src = noiseSource(ctx);
  const bq = ctx.createBiquadFilter();
  bq.type = filter;
  bq.Q.value = q;
  bq.frequency.setValueAtTime(from, t);
  if (to !== from) bq.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + dur);
  const env = envelope(ctx, { t, peak, attack, dur });
  src.connect(bq).connect(env).connect(out);
  // Старт со случайного места буфера: иначе все выстрелы шуршат одинаково.
  src.start(t, Math.random() * 0.9);
  src.stop(t + dur + 0.02);
  return src;
}

/** Ноты подряд с одинаковым шагом по времени — короткие мелодии-джинглы. */
function arpeggio(ctx, out, freqs, { t, step, dur, peak = 0.16, type = 'triangle' }) {
  freqs.forEach((f, i) => tone(ctx, out, { type, from: f, t: t + i * step, dur, peak }));
}

// ---------------------------------------------------------------------------
// Голоса. Каждый — короткая функция (ctx, out, t, opts).
// В комментарии написано, ЧТО звучит, а не какие ноды создаются.
// ---------------------------------------------------------------------------

const VOICES = {
  /** Выстрел: хлопок пороха (шум, срез падает 3 кГц → 500 Гц) плюс уходящий вниз свист снаряда. */
  shot(ctx, out, t) {
    hiss(ctx, out, { t, dur: 0.14, peak: 0.5, filter: 'lowpass', from: 3000, to: 500 });
    tone(ctx, out, { type: 'sawtooth', from: 780, to: 190, t, dur: 0.2, peak: 0.18 });
    tone(ctx, out, { type: 'sine', from: 150, to: 60, t, dur: 0.16, peak: 0.35 });
  },

  /**
   * Взрыв: шумовой всплеск с оседающим срезом (пыль и осколки) плюс низкий
   * удар в грудь. Чем больше радиус, тем длиннее хвост и ниже удар:
   * бомблет — сухой щелчок, крот — гулкий бабах.
   */
  explosion(ctx, out, t, opts = {}) {
    const r = clamp(Number(opts.radius) || 40, 10, 90);
    const dur = 0.34 + r / 130;                 // ~0.4 с у мелких, ~1 с у крупных
    const boom = 120 - r * 0.7;                 // большой взрыв бьёт ниже

    hiss(ctx, out, {
      t, dur, peak: 0.55, filter: 'lowpass', from: 1800 + r * 20, to: 110,
    });
    // Второй слой шума, узкий и короткий — резкость самого фронта
    hiss(ctx, out, {
      t, dur: 0.09, peak: 0.35, filter: 'bandpass', from: 2600, to: 1200, q: 0.8,
    });
    tone(ctx, out, { type: 'sine', from: boom, to: boom * 0.35, t, dur: dur * 0.8, peak: 0.75 });
  },

  /** Мелкий разрыв (бомблеты): тот же взрыв, но короткий и сухой. */
  smallExplosion(ctx, out, t) {
    hiss(ctx, out, { t, dur: 0.18, peak: 0.35, filter: 'lowpass', from: 2200, to: 300 });
    tone(ctx, out, { type: 'sine', from: 190, to: 70, t, dur: 0.14, peak: 0.4 });
  },

  /** Попадание по бойцу: короткий шлепок плюс сползающее вниз «ой». */
  hurt(ctx, out, t) {
    hiss(ctx, out, { t, dur: 0.06, peak: 0.3, filter: 'bandpass', from: 900, to: 500, q: 1.2 });
    tone(ctx, out, { type: 'square', from: 400, to: 170, t, dur: 0.18, peak: 0.14 });
  },

  /** Прыжок: короткий взлетающий свист. */
  jump(ctx, out, t) {
    tone(ctx, out, { type: 'sine', from: 250, to: 560, t, dur: 0.14, peak: 0.22 });
  },

  /** Шаг: щелчок по земле — очень короткий полосовой шум, без тона. */
  step(ctx, out, t) {
    hiss(ctx, out, {
      t, dur: 0.05, peak: 0.16, filter: 'bandpass',
      from: 330 + Math.random() * 160, q: 1.4,   // разброс частоты, чтобы шаги не были близнецами
    });
  },

  /** Падение в воду: гулкий «бульк» вниз и разлетающиеся брызги (срез шума ползёт вверх). */
  splash(ctx, out, t) {
    tone(ctx, out, { type: 'sine', from: 600, to: 130, t, dur: 0.22, peak: 0.3 });
    hiss(ctx, out, {
      t: t + 0.02, dur: 0.42, peak: 0.3, filter: 'bandpass', from: 500, to: 2600, q: 0.7,
    });
  },

  /** Ящик на парашюте: тихий нисходящий свист, следом мягкий стук о землю. */
  crateDrop(ctx, out, t) {
    tone(ctx, out, { type: 'triangle', from: 880, to: 420, t, dur: 0.42, peak: 0.14 });
    tone(ctx, out, { type: 'sine', from: 260, to: 120, t: t + 0.34, dur: 0.16, peak: 0.22 });
  },

  /** Подобрал ящик: восходящее трезвучие — награда должна звучать вверх. */
  pickup(ctx, out, t) {
    arpeggio(ctx, out, [660, 880, 1320], { t, step: 0.06, dur: 0.14, peak: 0.16 });
  },

  /**
   * Достижение: звонкое арпеджио вверх через октаву и искра сверху — ярче
   * ящика, но короче победы: может прозвучать посреди боя.
   */
  achievement(ctx, out, t) {
    arpeggio(ctx, out, [784, 988, 1175, 1568], { t, step: 0.07, dur: 0.16, peak: 0.15 });
    tone(ctx, out, { type: 'sine', from: 2093, to: 2350, t: t + 0.3, dur: 0.35, peak: 0.08 });
  },

  /** Выбор оружия и нажатия кнопок: сухой короткий клик, чтобы не мешал. */
  select(ctx, out, t) {
    tone(ctx, out, { type: 'square', from: 880, to: 660, t, dur: 0.05, peak: 0.1 });
  },

  /** Начало хода: две ноты вверх — сигнал «теперь ты». */
  turnStart(ctx, out, t) {
    arpeggio(ctx, out, [523, 784], { t, step: 0.11, dur: 0.2, peak: 0.16 });
  },

  /** Победа: мажорное арпеджио с задержанной верхней нотой. */
  victory(ctx, out, t) {
    arpeggio(ctx, out, [523, 659, 784], { t, step: 0.11, dur: 0.2, peak: 0.17 });
    tone(ctx, out, { type: 'triangle', from: 1046, t: t + 0.33, dur: 0.55, peak: 0.2 });
  },

  /** Поражение: то же трезвучие, но минорное и вниз, с проседающим басом. */
  defeat(ctx, out, t) {
    arpeggio(ctx, out, [523, 415, 349], { t, step: 0.14, dur: 0.26, peak: 0.16, type: 'sawtooth' });
    tone(ctx, out, { type: 'sine', from: 175, to: 110, t: t + 0.42, dur: 0.6, peak: 0.22 });
  },

  /** Трос пошёл: короткий свист разматывающейся верёвки, срез ползёт вверх. */
  rope(ctx, out, t) {
    hiss(ctx, out, { t, dur: 0.2, peak: 0.28, filter: 'bandpass', from: 500, to: 2800, q: 1.1 });
    tone(ctx, out, { type: 'triangle', from: 300, to: 900, t, dur: 0.16, peak: 0.1 });
  },

  /** Крюк впился в стену: глухой удар и сухой щелчок. */
  thunk(ctx, out, t) {
    tone(ctx, out, { type: 'sine', from: 190, to: 70, t, dur: 0.12, peak: 0.42 });
    hiss(ctx, out, { t, dur: 0.05, peak: 0.25, filter: 'bandpass', from: 1500, to: 700, q: 1 });
  },

  /** Натяжение рогатки: щелчок резинки, тем выше, чем сильнее натянул (opts.power 0…1). */
  stretch(ctx, out, t, opts = {}) {
    const f = 240 + clamp(Number(opts.power) || 0, 0, 1) * 620;
    tone(ctx, out, { type: 'triangle', from: f, to: f * 1.04, t, dur: 0.045, peak: 0.09 });
  },

  /** Рогатка отпущена: резинка хлопнула и дрожит, затухая. */
  twang(ctx, out, t) {
    tone(ctx, out, { type: 'sawtooth', from: 360, to: 150, t, dur: 0.2, peak: 0.16 });
    tone(ctx, out, { type: 'triangle', from: 720, to: 300, t, dur: 0.12, peak: 0.1 });
  },

  /** Боец выбит: тяжёлый удар и сползающая вниз нота — событие крупнее простого «ой». */
  knockout(ctx, out, t) {
    tone(ctx, out, { type: 'sine', from: 140, to: 45, t, dur: 0.45, peak: 0.6 });
    tone(ctx, out, { type: 'square', from: 520, to: 130, t: t + 0.03, dur: 0.4, peak: 0.12 });
    hiss(ctx, out, { t, dur: 0.12, peak: 0.3, filter: 'lowpass', from: 1400, to: 300 });
  },

  /** Тик таймера в последние секунды: сухой высокий щелчок часов. */
  tick(ctx, out, t) {
    tone(ctx, out, { type: 'square', from: 1600, t, dur: 0.035, peak: 0.1 });
  },
};

export const SFX_NAMES = Object.keys(VOICES);

// ---------------------------------------------------------------------------

class Sfx {
  constructor() {
    const { volume, muted } = loadState();
    this._volume = volume;
    this._muted = muted;
    this.ctx = null;
    this.master = null;
    // Время последнего запуска по имени звука — для ограничения частоты
    this._last = new Map();
    this._armed = false;
    // Кому сказать, что звук выключили или сменили громкость (музыке)
    this._watchers = new Set();
    this.arm();
  }

  /**
   * Ждём первого жеста: до него браузер держит контекст в suspended, и
   * все звуки уходят в никуда. Слушатели снимаются сразу после первого
   * срабатывания — дальше контекст живёт сам.
   */
  arm() {
    if (this._armed || typeof window === 'undefined') return;
    this._armed = true;
    const unlock = () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
      this.resume();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
  }

  /** Создаёт контекст при первом обращении и возвращает его (или null). */
  _context() {
    if (this.ctx) return this.ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      this.ctx = new AC();
    } catch {
      return null;                              // звука не будет, игра играется дальше
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this._muted ? 0 : this._volume;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Разбудить контекст. Вызывать только из обработчика жеста. */
  resume() {
    const ctx = this._context();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }

  get volume() { return this._volume; }

  get muted() { return this._muted; }

  /** Состояние контекста — удобно для отладки и тестов: null до первого жеста. */
  get state() { return this.ctx?.state ?? null; }

  /** Подписаться на смену громкости и «звук выкл». Возвращает отписку. */
  watch(fn) {
    this._watchers.add(fn);
    return () => this._watchers.delete(fn);
  }

  _changed() {
    for (const fn of this._watchers) {
      try { fn(); } catch { /* подписчик сломался — звук всё равно переключён */ }
    }
  }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
    saveState({ volume: this._volume, muted: this._muted });
    this._changed();
    return this._volume;
  }

  setMuted(on) {
    this._muted = Boolean(on);
    if (this.master) this.master.gain.value = this._muted ? 0 : this._volume;
    saveState({ volume: this._volume, muted: this._muted });
    this._changed();
    return this._muted;
  }

  toggleMuted() { return this.setMuted(!this._muted); }

  /**
   * Сыграть звук по имени. Неизвестное имя молча игнорируется: звук —
   * украшение, из-за опечатки в нём партия падать не должна.
   *
   * opts.radius — для взрыва, opts.gain — разовый множитель громкости.
   */
  play(name, opts = {}) {
    if (this._muted) return false;
    const voice = VOICES[name];
    if (!voice) return false;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - (this._last.get(name) ?? -Infinity) < THROTTLE_MS) return false;

    const ctx = this._context();
    if (!ctx) return false;
    // До жеста контекст спит — синтезировать в тишину незачем, да и
    // накопленные события потом сыграли бы залпом.
    if (ctx.state !== 'running') { this.resume(); return false; }

    this._last.set(name, now);

    let out = this.master;
    const gain = Number(opts.gain);
    if (Number.isFinite(gain) && gain !== 1) {
      out = ctx.createGain();
      out.gain.value = clamp(gain, 0, 4);
      out.connect(this.master);
    }

    try {
      voice(ctx, out, ctx.currentTime + SCHEDULE_LEAD, opts);
    } catch {
      return false;
    }
    return true;
  }
}

/** Синглтон: контекст в браузере имеет смысл держать ровно один. */
export const sfx = new Sfx();
