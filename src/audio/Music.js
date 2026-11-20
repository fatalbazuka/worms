/**
 * Фоновая музыка — тоже без единого файла: ноты синтезируются в WebAudio,
 * как и эффекты (Sfx.js), и звучат в том же аудиоконтексте.
 *
 * Тема — это данные: темп, лад, аккорды по тактам, мелодия цифрами ступеней
 * и рисунки баса, аккомпанемента и барабанов. Одна тема у меню и по одной на
 * каждое место боя: обычная башня, ледяная, лавовая и космос. Форма темы —
 * пять кусков по четыре такта (A, A повыше, B, A, B без мелодии), так что
 * круг длится около минуты и на повторе не надоедает за три хода.
 *
 * Ноты назначаются наперёд по часам контекста: таймер раз в ~0.1 с
 * дописывает то, что должно прозвучать в ближайшие 0.3 с. Покадровой
 * работы нет, а нод на ноту — две-три, это копейки даже на слабом телефоне.
 *
 *   import { music, battleTheme } from '../audio/Music.js';
 *   music.play('menu');
 *   music.play(battleTheme('ice'));
 *   music.sting('victory');
 *
 * Правила поведения:
 *   — до первого жеста не звучит (контекст создаёт и будит sfx);
 *   — общий «звук выкл» (sfx.setMuted) глушит и музыку, а отдельный
 *     переключатель «Музыка» (worms.music.v1) — только её;
 *   — свернули страницу — музыка встаёт, контекст засыпает; вернулись —
 *     тема начинается заново с плавного входа;
 *   — смена темы — перекрёстный переход, без обрыва.
 */
import { sfx } from './Sfx.js';

const STORE_KEY = 'worms.music.v1';

// Громкость музыки относительно общего регулятора эффектов: заметно тише
// взрывов, иначе после пары боёв её выключат совсем
const LEVEL = 0.3;
const FADE = 1.2;              // перекрёстный переход между темами, с
const LOOKAHEAD = 0.3;         // насколько вперёд назначать ноты, с
const TICK_MS = 90;            // как часто дописывать
const START_LEAD = 0.08;       // первая нота новой темы — чуть позже «сейчас»

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** Ступень лада → полутоны от тоники; ступени ниже нуля уходят октавой вниз. */
function degree(scale, d) {
  const oct = Math.floor(d / 7);
  return scale[((d % 7) + 7) % 7] + 12 * oct;
}

// ---------------------------------------------------------------------------
// Темы
//
// prog   — аккорды кусков A и B: ступень лада на каждый из четырёх тактов;
// lead   — мелодии A и B: четыре такта по восемь восьмых. Число — ступень
//          (0 — тоника, 7 — октава выше), «-» тянет предыдущую, «.» — пауза;
// bass   — рисунок баса на такт: R — основной тон аккорда, 3 и 5 — терция
//          и квинта, O — октава вверх, L — квинта вниз;
// comp   — аккомпанемент: stab (x — аккорд коротким ударом), arp (цифры —
//          звуки аккорда по очереди) или pad (аккорд тянется весь такт);
// drums  — kick, snare, hat: x — удар, o — тихий удар;
// echo   — эхо на мелодию и аккомпанемент (лёд и космос — простор).
// ---------------------------------------------------------------------------

const THEMES = {
  // Меню: ясный до мажор, укулеле на слабых долях и маримба — «добро пожаловать»
  menu: {
    bpm: 108, swing: 0.18, root: 60, scale: 'major',
    prog: { A: [0, 5, 3, 4], B: [3, 4, 2, 5] },
    lead: {
      A: ['4 . 4 5 4 . 2 .', '0 . 2 . 4 - - .', '5 . 5 6 5 . 3 .', '4 - 3 . 1 . . .'],
      B: ['7 . 6 . 5 . 3 .', '4 . 5 . 6 - 4 .', '2 . 4 . 6 . 4 2', '5 - - . 4 . 2 .'],
    },
    leadVoice: 'marimba', leadOct: 0, leadGain: 0.2,
    bass: 'R . 5 . O . 5 .', bassVoice: 'bass', bassOct: -1, bassGain: 0.2,
    comp: { style: 'stab', pattern: '. x . x . x . x', voice: 'pluck', gain: 0.055 },
    drums: { kick: 'x . . . x . . .', snare: '. . o . . . o .', hat: 'o o o o o o o o' },
  },

  // Обычная башня: соль мажор, бодрый «умпа-марш» — бас на сильных, аккорд на слабых
  battle: {
    bpm: 128, swing: 0.1, root: 55, scale: 'major',
    prog: { A: [0, 3, 4, 0], B: [5, 3, 1, 4] },
    lead: {
      A: ['0 . 2 4 7 . 4 .', '5 . 4 3 2 . 0 .', '1 . 3 . 4 . 6 .', '7 - 4 . 0 . . .'],
      B: ['4 . 4 2 4 . 5 .', '5 . 4 . 2 - 0 .', '1 . 3 . 5 . 3 .', '4 - 3 . 1 . -1 .'],
    },
    leadVoice: 'square', leadOct: 1, leadGain: 0.15,
    bass: 'R . . . 5 . . L', bassVoice: 'tuba', bassOct: -1, bassGain: 0.24,
    comp: { style: 'stab', pattern: '. . x . . . x .', voice: 'pluck', gain: 0.06 },
    drums: { kick: 'x . . . x . . .', snare: '. . x . . . x .', hat: 'o o o o o o o o' },
  },

  // Ледяная: ре лидийский, колокольчики с эхом и звенящая повышенная кварта
  ice: {
    bpm: 92, swing: 0, root: 62, scale: 'lydian', echo: true,
    prog: { A: [0, 1, 0, 4], B: [5, 1, 4, 4] },
    lead: {
      A: ['7 . 6 . 4 . . .', '5 . 3 . 1 . . .', '2 . 4 . 7 . 9 .', '8 - - . 6 . . .'],
      B: ['5 . 7 . 9 - . .', '8 . 7 . 5 . 3 .', '4 . 6 . 8 . 6 .', '4 - - - . . . .'],
    },
    leadVoice: 'bell', leadOct: 0, leadGain: 0.16,
    bass: 'R . . . 5 . . .', bassVoice: 'sub', bassOct: -1, bassGain: 0.24,
    comp: { style: 'arp', pattern: '0 1 2 1 3 2 1 2', voice: 'glass', gain: 0.035, oct: 1 },
    drums: { kick: 'o . . . . . . .', hat: '. . o . . . o .' },
  },

  // Лавовая: ре гармонический минор, крадущийся мультяшный злодей — туба и стаккато
  lava: {
    bpm: 120, swing: 0.12, root: 50, scale: 'harmonic',
    prog: { A: [0, 0, 5, 4], B: [3, 0, 5, 4] },
    lead: {
      A: ['0 1 2 3 4 . 2 .', '4 . 2 . 4 - . .', '5 . 4 . 3 . 2 .', '4 . -1 . 1 . . .'],
      B: ['3 4 5 4 3 . 0 .', '2 . 4 . 7 - . .', '7 . 5 . 4 . 2 .', '1 - -1 . 1 . 4 .'],
    },
    leadVoice: 'pluck', leadOct: 1, leadGain: 0.16,
    bass: 'R . 5 . R . 5 .', bassVoice: 'tuba', bassOct: -1, bassGain: 0.26,
    comp: { style: 'stab', pattern: '. x . x . x . x', voice: 'square', gain: 0.03 },
    drums: { kick: 'x . . x x . . .', snare: '. . x . . . x .', hat: 'o . o . o . o .' },
  },

  // Космос: ля минор, медленный, тянущийся пад, пиликающее арпеджио и эхо
  space: {
    bpm: 84, swing: 0, root: 57, scale: 'minor', echo: true,
    prog: { A: [0, 6, 5, 6], B: [3, 0, 5, 4] },
    lead: {
      A: ['4 . . . 2 . 4 .', '6 - - . 4 . . .', '5 . 7 . 9 - . .', '8 - - . 6 . . .'],
      B: ['3 . 5 . 7 - . .', '9 - 8 . 7 . . .', '7 . 5 . 2 . 5 .', '4 - - - . . . .'],
    },
    leadVoice: 'bell', leadOct: 0, leadGain: 0.13,
    bass: 'R . . . . . R .', bassVoice: 'bass', bassOct: -1, bassGain: 0.2,
    comp: { style: 'pad', voice: 'pad', gain: 0.035 },
    arp: { pattern: '0 1 2 3 2 1 2 1', voice: 'blip', gain: 0.03, oct: 0 },
    drums: { kick: 'o . . . . . . .', hat: '. . . . o . . .' },
  },
};

// Порядок кусков: m — мелодия (null — дать ей отдохнуть), up — на октаву выше
const FORM = [
  { p: 'A', m: 'A' },
  { p: 'A', m: 'A', up: true },
  { p: 'B', m: 'B' },
  { p: 'A', m: 'A' },
  { p: 'B', m: null },
];

export const MUSIC_THEMES = Object.keys(THEMES);

/**
 * Тема боя по месту: вид башни, а без башни — по земле (снега звучат
 * льдом, преисподняя — лавой). Всё прочее — обычная боевая.
 */
export function battleTheme(variant = null, biome = null) {
  if (variant === 'ice' || variant === 'lava' || variant === 'space') return variant;
  if (!variant || variant === 'classic' || variant === 'wind') {
    if (biome === 'snow') return 'ice';
    if (biome === 'hell') return 'lava';
  }
  return 'battle';
}

/** Мелодия строкой → по восемь клеток на такт: { d — ступень, len — длина в восьмых }. */
function parseBar(str) {
  const cells = str.trim().split(/\s+/);
  const out = new Array(8).fill(null);
  let last = null;
  for (let i = 0; i < 8; i++) {
    const c = cells[i] ?? '.';
    if (c === '-') { if (last) last.len++; continue; }
    if (c === '.') { last = null; continue; }
    last = { d: Number(c), len: 1 };
    out[i] = last;
  }
  return out;
}

const cells = (str) => (str ?? '').trim().split(/\s+/);

/** Разобрать строки темы один раз, чтобы в планировщике только читать. */
function compile(id) {
  const t = THEMES[id];
  return {
    ...t,
    id,
    scale: SCALES[t.scale],
    step: 60 / t.bpm / 2,                       // восьмая, с
    lead: Object.fromEntries(Object.entries(t.lead).map(([k, bars]) => [k, bars.map(parseBar)])),
    bass: cells(t.bass),
    comp: t.comp && { ...t.comp, pattern: cells(t.comp.pattern) },
    arp: t.arp && { ...t.arp, pattern: cells(t.arp.pattern) },
    drums: Object.fromEntries(Object.entries(t.drums ?? {}).map(([k, v]) => [k, cells(v)])),
  };
}

// ---------------------------------------------------------------------------
// Инструменты. Каждый — (ctx, out, t, f, dur, gain): одна нота частоты f,
// начинается в t и звучит примерно dur секунд.
// ---------------------------------------------------------------------------

/** Огибающая: быстрая атака, экспоненциальный спад. Ноль в exponentialRamp запрещён. */
function env(ctx, t, peak, attack, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
  return g;
}

function osc(ctx, type, f, t, stop, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (detune) o.detune.setValueAtTime(detune, t);
  o.start(t);
  o.stop(stop);
  return o;
}

const VOICES = {
  /** Маримба: чистый тон и короткий звонкий обертон сверху — деревянный «тук». */
  marimba(ctx, out, t, f, dur, gain) {
    const d = Math.min(0.5, dur + 0.15);
    osc(ctx, 'sine', f, t, t + d + 0.05).connect(env(ctx, t, gain, 0.004, d)).connect(out);
    osc(ctx, 'sine', f * 4, t, t + 0.1).connect(env(ctx, t, gain * 0.25, 0.002, 0.05)).connect(out);
  },

  /** Щипок: треугольник с быстрым спадом — укулеле или пиццикато. */
  pluck(ctx, out, t, f, dur, gain) {
    const d = Math.min(0.35, dur + 0.08);
    osc(ctx, 'triangle', f, t, t + d + 0.05).connect(env(ctx, t, gain, 0.004, d)).connect(out);
  },

  /** Квадрат через мягкий фильтр — «восьмибитная» дудочка, без резкости. */
  square(ctx, out, t, f, dur, gain) {
    const d = dur * 0.9 + 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(f * 5, 4200), t);
    osc(ctx, 'square', f, t, t + d + 0.05).connect(lp).connect(env(ctx, t, gain, 0.006, d)).connect(out);
  },

  /** Колокольчик: основной тон и негармонический обертон, долгий хвост. */
  bell(ctx, out, t, f, dur, gain) {
    const d = Math.max(0.9, dur * 1.5);
    osc(ctx, 'sine', f, t, t + d + 0.05).connect(env(ctx, t, gain, 0.003, d)).connect(out);
    osc(ctx, 'sine', f * 2.76, t, t + d * 0.4).connect(env(ctx, t, gain * 0.22, 0.002, d * 0.35)).connect(out);
  },

  /** Стекло: тихий колокольчик для арпеджио — короче и без обертона. */
  glass(ctx, out, t, f, dur, gain) {
    const d = 0.6;
    osc(ctx, 'sine', f, t, t + d + 0.05).connect(env(ctx, t, gain, 0.003, d)).connect(out);
  },

  /** Пиликалка: короткий квадрат высоко, для космического арпеджио. */
  blip(ctx, out, t, f, dur, gain) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    osc(ctx, 'square', f, t, t + 0.2).connect(lp).connect(env(ctx, t, gain, 0.003, 0.14)).connect(out);
  },

  /** Бас: треугольник, держится почти всю длину ноты. */
  bass(ctx, out, t, f, dur, gain) {
    const d = dur * 0.9 + 0.08;
    osc(ctx, 'triangle', f, t, t + d + 0.05).connect(env(ctx, t, gain, 0.006, d)).connect(out);
  },

  /** Саб: чистый синус — мягкий низ, когда басу не надо прыгать. */
  sub(ctx, out, t, f, dur, gain) {
    const d = dur + 0.2;
    osc(ctx, 'sine', f, t, t + d + 0.05).connect(env(ctx, t, gain, 0.02, d)).connect(out);
  },

  /** Туба: пила через фильтр, который чуть приоткрывается на атаке — «пум». */
  tuba(ctx, out, t, f, dur, gain) {
    const d = Math.min(0.32, dur * 0.8 + 0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(f * 6, t);
    lp.frequency.exponentialRampToValueAtTime(f * 2, t + d);
    osc(ctx, 'sawtooth', f, t, t + d + 0.05).connect(lp).connect(env(ctx, t, gain, 0.01, d)).connect(out);
  },

  /** Пад: две слегка расстроенные пилы под фильтром, медленный вход и выход. */
  pad(ctx, out, t, f, dur, gain) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    const g = ctx.createGain();
    const end = t + dur;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.5, dur * 0.3));
    g.gain.setValueAtTime(gain, end - 0.2);
    g.gain.linearRampToValueAtTime(0.0001, end + 0.4);
    lp.connect(g).connect(out);
    osc(ctx, 'sawtooth', f, t, end + 0.45, -7).connect(lp);
    osc(ctx, 'sawtooth', f, t, end + 0.45, 7).connect(lp);
  },
};

// Шум для барабанов — одна полсекунды на контекст, стартуем со случайного места
const NOISE = new WeakMap();
function noise(ctx, t, dur) {
  let buf = NOISE.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.round(ctx.sampleRate / 2), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    NOISE.set(ctx, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start(t, Math.random() * 0.4);
  src.stop(t + dur + 0.02);
  return src;
}

function filtered(ctx, type, f, q = 1) {
  const bq = ctx.createBiquadFilter();
  bq.type = type;
  bq.frequency.value = f;
  bq.Q.value = q;
  return bq;
}

const DRUMS = {
  /** Бочка: синус, скользящий вниз, — мягкий «бум», не клубный удар. */
  kick(ctx, out, t, gain) {
    const o = osc(ctx, 'sine', 140, t, t + 0.22);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
    o.connect(env(ctx, t, gain * 0.32, 0.003, 0.18)).connect(out);
  },
  /** Малый: шум в полосе и короткий тон — сухой «тщ». */
  snare(ctx, out, t, gain) {
    noise(ctx, t, 0.14).connect(filtered(ctx, 'bandpass', 1800, 0.7))
      .connect(env(ctx, t, gain * 0.13, 0.002, 0.12)).connect(out);
    osc(ctx, 'triangle', 190, t, t + 0.08).connect(env(ctx, t, gain * 0.06, 0.002, 0.06)).connect(out);
  },
  /** Хэт: верх шума, очень коротко. */
  hat(ctx, out, t, gain) {
    noise(ctx, t, 0.05).connect(filtered(ctx, 'highpass', 7000))
      .connect(env(ctx, t, gain * 0.05, 0.001, 0.035)).connect(out);
  },
};

// ---------------------------------------------------------------------------
// Дорожка: одна играющая тема со своей громкостью — для перехода их
// звучит две, старая затухает, новая разгорается.
// ---------------------------------------------------------------------------

class Track {
  constructor(ctx, dest, theme, start, fadeIn) {
    this.ctx = ctx;
    this.theme = theme;
    this.next = start;
    this.stepNo = 0;
    this.stopAt = Infinity;         // после этого времени новых нот не назначаем
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.out.gain.linearRampToValueAtTime(1, start + fadeIn);
    this.out.connect(dest);
    this.dry = this.out;
    // Мелодия и аккомпанемент идут сюда: без эха это тот же выход, с эхом —
    // ещё и в линию задержки. Бас и барабаны эха не получают — гулко
    this.mel = this.out;
    if (theme.echo) {
      // Эхо через три восьмых, с затухающими повторами под фильтром
      const delay = ctx.createDelay(2);
      delay.delayTime.value = theme.step * 3;
      const fb = ctx.createGain();
      fb.gain.value = 0.32;
      const lp = filtered(ctx, 'lowpass', 2600);
      const send = ctx.createGain();
      send.gain.value = 0.45;
      send.connect(delay).connect(lp).connect(fb).connect(delay);
      lp.connect(this.out);
      this.mel = ctx.createGain();
      this.mel.connect(this.out);
      this.mel.connect(send);
      this._fx = [delay, fb, lp, send, this.mel];
    }
  }

  /** Назначить все восьмые, что начинаются раньше until. */
  schedule(until) {
    while (this.next < until && this.next < this.stopAt) {
      this._step(this.stepNo, this.next);
      this.stepNo++;
      this.next += this.theme.step;
    }
  }

  _step(n, t0) {
    const th = this.theme, ctx = this.ctx;
    const pos = n % 8;
    const bar = Math.floor(n / 8) % (FORM.length * 4);
    const sec = FORM[Math.floor(bar / 4)];
    const inSec = bar % 4;
    const chord = th.prog[sec.p][inSec];
    // Свинг: слабые восьмые чуть запаздывают — походка вразвалочку
    const t = t0 + (pos % 2 ? th.swing * th.step : 0);
    const note = (d, oct = 0) => freq(th.root + degree(th.scale, d) + 12 * oct);

    // Бас
    const b = th.bass[pos];
    if (b && b !== '.') {
      const shift = { R: 0, 3: 2, 5: 4, O: 7, L: -3 }[b] ?? 0;
      VOICES[th.bassVoice](ctx, this.dry, t, note(chord + shift, th.bassOct), th.step, th.bassGain);
    }

    // Аккомпанемент
    const c = th.comp;
    if (c?.style === 'pad' && pos === 0) {
      for (const k of [0, 2, 4]) VOICES[c.voice](ctx, this.mel, t, note(chord + k, -1), th.step * 8, c.gain);
    } else if (c?.style === 'stab' && c.pattern[pos] === 'x') {
      for (const k of [0, 2, 4]) VOICES[c.voice](ctx, this.mel, t, note(chord + k), th.step * 0.6, c.gain);
    } else if (c?.style === 'arp') {
      this._arp(c, pos, t, chord, note);
    }
    if (th.arp) this._arp(th.arp, pos, t, chord, note);

    // Мелодия: на втором проходе A — октавой выше и чуть тише
    if (sec.m) {
      const cell = th.lead[sec.m][inSec][pos];
      if (cell) {
        const up = sec.up ? 1 : 0;
        VOICES[th.leadVoice](ctx, this.mel, t, note(cell.d, th.leadOct + up),
          cell.len * th.step, th.leadGain * (up ? 0.75 : 1) * (0.9 + Math.random() * 0.15));
      }
    }

    // Барабаны. В последнем такте круга малый барабан сбивкой — шов не слышен
    const last = bar === FORM.length * 4 - 1;
    for (const [name, pat] of Object.entries(th.drums)) {
      let hit = pat[pos];
      if (last && name === 'snare' && pos >= 4) hit = pos === 7 ? 'x' : 'o';
      if (hit === 'x' || hit === 'o') DRUMS[name](ctx, this.dry, t, hit === 'x' ? 1 : 0.55);
    }
  }

  _arp(a, pos, t, chord, note) {
    const k = a.pattern[pos];
    if (!k || k === '.') return;
    const shift = [0, 2, 4, 7][Number(k)] ?? 0;
    VOICES[a.voice](this.ctx, this.mel, t, note(chord + shift, a.oct ?? 0), this.theme.step, a.gain);
  }

  /** Плавно увести в тишину: ноты дописываются ещё fade секунд, потом всё. */
  fadeOut(fade) {
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, 0.0001), now);
    g.linearRampToValueAtTime(0.0001, now + fade);
    this.stopAt = now + fade;
    this.endAt = now + fade + 1.5;          // эхо и хвосты нот
  }

  destroy() {
    try {
      this.out.disconnect();
      for (const n of this._fx ?? []) n.disconnect();
    } catch { /* уже отключено */ }
  }
}

// ---------------------------------------------------------------------------
// Короткие заставки на конец боя — в ладу последней темы
// ---------------------------------------------------------------------------

const STINGS = {
  /** Победа: взлёт по трезвучию шестнадцатыми и звонкий мажорный аккорд с бочкой. */
  victory(ctx, out, t, root) {
    const s = 0.085;
    [0, 4, 7, 12, 16].forEach((k, i) => VOICES.square(ctx, out, t + i * s, freq(root + 12 + k), s, 0.1));
    const hit = t + 5 * s;
    for (const k of [0, 4, 7, 12]) VOICES.bell(ctx, out, hit, freq(root + 12 + k), 1.2, 0.07);
    VOICES.bass(ctx, out, hit, freq(root - 12), 0.8, 0.22);
    DRUMS.kick(ctx, out, hit, 1);
    DRUMS.snare(ctx, out, hit, 0.8);
  },

  /** Поражение: мультяшное «ва-ва-ва-ваа» — пила вниз по полутонам, последняя дрожит. */
  defeat(ctx, out, t, root) {
    const notes = [7, 6, 5, 4];
    notes.forEach((k, i) => {
      const at = t + i * 0.36;
      const lastOne = i === notes.length - 1;
      const dur = lastOne ? 1.1 : 0.3;
      const f = freq(root + k);
      const o = osc(ctx, 'sawtooth', f, at, at + dur + 0.1);
      if (lastOne) {
        // Вибрато и проседание в конце — «ну вот…»
        const lfo = osc(ctx, 'sine', 6, at, at + dur + 0.1);
        const depth = ctx.createGain();
        depth.gain.value = f * 0.025;
        lfo.connect(depth).connect(o.frequency);
        o.frequency.setValueAtTime(f, at + dur * 0.5);
        o.frequency.exponentialRampToValueAtTime(f * 0.9, at + dur);
      }
      // Фильтр раскрывается и закрывается на каждой ноте — «уа» сурдины
      const lp = filtered(ctx, 'lowpass', 400, 3);
      lp.frequency.setValueAtTime(350, at);
      lp.frequency.exponentialRampToValueAtTime(1400, at + 0.08);
      lp.frequency.exponentialRampToValueAtTime(500, at + dur);
      o.connect(lp).connect(env(ctx, at, 0.13, 0.03, dur)).connect(out);
    });
  },
};

// ---------------------------------------------------------------------------

function loadEnabled() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw)?.on !== false : true;
  } catch {
    return true;
  }
}

class Music {
  constructor() {
    this._enabled = loadEnabled();
    this._want = null;              // какую тему просили (её может быть не слышно)
    this._last = null;              // тема, что играла последней, — по ней тональность заставки
    this.tracks = [];               // звучащие дорожки; последняя — текущая
    this.bus = null;
    this._timer = null;
    this._hidden = false;
    this._hooked = null;            // контекст, на statechange которого подписаны
    this._compiled = new Map();
    // Общий «звук выкл» и громкость живут в sfx — узнаём о них оттуда
    sfx.watch?.(() => this._sync());
    this.arm();
    this._away = { page: false, tg: false };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange',
        () => this._setAway('page', document.visibilityState === 'hidden'));
    }
    // Telegram сворачивает мини-приложение, не всегда пряча страницу: на
    // это у него свои события (Bot API 8.0). У старых клиентов их нет
    try {
      const tg = globalThis.Telegram?.WebApp;
      tg?.onEvent?.('deactivated', () => this._setAway('tg', true));
      tg?.onEvent?.('activated', () => this._setAway('tg', false));
    } catch { /* старый клиент */ }
  }

  /**
   * Как у sfx: ждём первого жеста. Контекст будит sfx (его слушатель
   * повешен раньше), а мы после жеста только сверяемся с ним. После
   * возврата на страницу iOS иногда не даёт разбудить контекст без
   * касания — тогда ждём жеста снова.
   */
  arm() {
    if (this._armed || typeof window === 'undefined') return;
    this._armed = true;
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const unlock = () => {
      for (const e of events) window.removeEventListener(e, unlock, true);
      this._armed = false;
      sfx.resume();
      this._sync();
    };
    for (const e of events) window.addEventListener(e, unlock, true);
  }

  get enabled() { return this._enabled; }

  /** Тема, что звучит сейчас (null — тишина). Для отладки и тестов. */
  get theme() {
    const t = this.tracks[this.tracks.length - 1];
    return t && t.stopAt === Infinity ? t.theme.id : null;
  }

  /** Тема, которую просили, — даже если её сейчас не слышно (звук выключен). */
  get wanted() { return this._want; }

  setEnabled(on) {
    this._enabled = Boolean(on);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ on: this._enabled }));
    } catch { /* инкогнито — просто не запоминаем */ }
    this._sync();
    return this._enabled;
  }

  toggle() { return this.setEnabled(!this._enabled); }

  /** Играть тему: та же — продолжается как шла, другая — перекрёстным переходом. */
  play(id) {
    if (!THEMES[id]) return;
    this._want = id;
    this._sync();
  }

  /** Тишина с плавным уходом. */
  stop() {
    this._want = null;
    this._sync();
  }

  /**
   * Заставка конца боя: тема уходит, через delay секунд — короткая
   * мелодия (победа или поражение). Дальше тишина до следующей темы.
   */
  sting(kind, delay = 1.1) {
    const fn = STINGS[kind];
    this._want = null;
    const ctx = this._live();
    if (!ctx) return false;
    this._switch(null, 0.6);
    if (!fn || !this._audible()) return false;
    const root = THEMES[this._last ?? 'battle'].root;
    try {
      fn(ctx, this.bus, ctx.currentTime + delay, root);
    } catch {
      return false;
    }
    return true;
  }

  // --- внутренности ---

  _audible() { return this._enabled && !sfx.muted; }

  /** Контекст, если в него сейчас можно играть, иначе null. */
  _live() {
    const ctx = sfx.ctx;
    if (!ctx || this._hidden || ctx.state !== 'running') return null;
    this._bus(ctx);
    return ctx;
  }

  _bus(ctx) {
    if (this.bus?.context === ctx) return;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(ctx.destination);
  }

  _theme(id) {
    if (!this._compiled.has(id)) this._compiled.set(id, compile(id));
    return this._compiled.get(id);
  }

  /** Привести звучание к желаемому: громкость, тема, таймер. */
  _sync() {
    const ctx = sfx.ctx;
    // Контекст уснул или проснулся (свернули, iOS прервал звук) — узнаем сами
    if (ctx && this._hooked !== ctx && ctx.addEventListener) {
      this._hooked = ctx;
      ctx.addEventListener('statechange', () => this._sync());
    }
    const live = this._live();
    if (!live) { this._halt(); return; }
    const level = this._audible() ? LEVEL * sfx.volume : 0;
    this.bus.gain.setTargetAtTime(level, live.currentTime, 0.08);
    const want = this._audible() ? this._want : null;
    if (this.theme !== want) this._switch(want, FADE);
  }

  _switch(id, fade) {
    const ctx = sfx.ctx;
    for (const t of this.tracks) if (t.stopAt === Infinity) t.fadeOut(fade);
    if (id) {
      const start = ctx.currentTime + START_LEAD;
      // Первая тема после тишины входит быстрее, при смене — на весь переход
      const busy = this.tracks.some((t) => t.endAt > ctx.currentTime);
      this.tracks.push(new Track(ctx, this.bus, this._theme(id), start, busy ? fade : 0.6));
      this._last = id;
    }
    if (this.tracks.length && !this._timer) {
      this._timer = setInterval(() => this._tick(), TICK_MS);
      this._tick();
    }
  }

  _tick() {
    const ctx = sfx.ctx;
    if (!ctx || ctx.state !== 'running') { this._halt(); return; }
    const now = ctx.currentTime;
    for (const t of this.tracks) {
      // Таймер проспал (вкладку душили) — не догоняем пачкой, а идём от «сейчас»
      if (t.next < now - 0.25) t.next = now + 0.05;
      try {
        t.schedule(now + LOOKAHEAD);
      } catch {
        t.stopAt = now;                // сломалась тема — молча гасим её, игра важнее
        t.endAt = now;
      }
    }
    const done = this.tracks.filter((t) => t.endAt <= now);
    if (done.length) {
      for (const t of done) t.destroy();
      this.tracks = this.tracks.filter((t) => !done.includes(t));
    }
    if (!this.tracks.length) this._stopTimer();
  }

  /** Сразу всё в тишину: контекст спит, назначенное потом прозвучало бы залпом. */
  _halt() {
    for (const t of this.tracks) t.destroy();
    this.tracks = [];
    this._stopTimer();
  }

  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Свернули — тишина и спящий контекст (батарея); вернулись — будим и играем заново. */
  _setAway(why, away) {
    const ctx = sfx.ctx;
    this._away[why] = away;
    const was = this._hidden;
    this._hidden = this._away.page || this._away.tg;
    if (was === this._hidden) return;
    if (this._hidden) {
      this._halt();
      if (ctx?.state === 'running') ctx.suspend?.().catch(() => {});
      return;
    }
    if (ctx && ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      // Без жеста iOS может отказать — тогда разбудит первое касание
      this.arm();
    }
    this._sync();
  }
}

/** Синглтон: музыка одна на всю игру и живёт поверх сцен. */
export const music = new Music();
