/**
 * Клип красивого выстрела — для TikTok, Reels, Shorts и сторис.
 *
 * Пишем не всё подряд, а свой выстрел: от отпускания рычага до конца хода.
 * Был в нём «Бабах!», дуплет или решающий удар — клип остаётся, иначе
 * выбрасывается. Холст снимается через captureStream + MediaRecorder: на
 * iOS это MP4, на Android обычно WebM — сервер перекодирует его в MP4
 * (иначе Telegram не возьмёт его в сторис).
 *
 * Сохранить в Telegram можно только по ссылке (downloadFile, Bot API 8.0),
 * поэтому клип уходит на сервер (/api/media), как и картинка для сторис.
 */
import { tgApi, tgSupports, haptic } from './telegram.js';
import { uploadMedia, loggedIn, trackStep } from '../net/server.js';
import { postStory, canStory } from './story.js';

const MAX_MS = 9000;      // дольше полёт не длится; дальше — обрезаем
const TAIL_MS = 700;      // хвост после хода: взрыв успевает осесть

function pickType() {
  const MR = globalThis.MediaRecorder;
  if (!MR?.isTypeSupported) return null;
  for (const t of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MR.isTypeSupported(t)) return t;
  }
  return null;
}

/** Умеет ли браузер писать холст. */
export function canClip() {
  const c = globalThis.document?.querySelector('#game canvas');
  return Boolean(c?.captureStream && pickType());
}

export class ClipRecorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.rec = null;
    this.chunks = [];
    this.worthy = false;
    this.best = null;       // {blob, type} — лучший клип боя
    this.bestScore = 0;
  }

  /** Начать запись своего выстрела. */
  start() {
    if (this.rec || !canClip()) return;
    const type = pickType();
    try {
      const stream = this.canvas.captureStream(30);
      this.rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
    } catch {
      this.rec = null;
      return;
    }
    this.type = type.split(';')[0];
    this.chunks = [];
    this.score = 0;
    this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.cap = setTimeout(() => this.finish(), MAX_MS);
  }

  /** Отметить красивый момент: чем больше score, тем клип ценнее. */
  mark(score) {
    if (this.rec) this.score = Math.max(this.score, score);
  }

  /** Ход кончился: дописываем хвост и решаем, оставить ли клип. */
  finish() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    clearTimeout(this.cap);
    const score = this.score;
    const done = () => {
      try { rec.stream?.getTracks().forEach((t) => t.stop()); } catch { /* уже */ }
      if (score > 0 && score >= this.bestScore && this.chunks.length) {
        this.best = { blob: new Blob(this.chunks, { type: this.type }), type: this.type };
        this.bestScore = score;
      }
      this.chunks = [];
    };
    setTimeout(() => {
      rec.onstop = done;
      try { rec.stop(); } catch { done(); }
    }, score > 0 ? TAIL_MS : 0);
  }

  destroy() {
    clearTimeout(this.cap);
    try { this.rec?.stop(); } catch { /* уже */ }
    this.rec = null;
    this.best = null;
  }
}

/**
 * Отдать клип игроку: на сервер, потом «сохранить» (Telegram 8.0+) или
 * скачать файлом в браузере. @returns {Promise<{ok: boolean, url?: string, mp4?: boolean}>}
 */
export async function saveClip(clip) {
  if (!clip?.blob) return { ok: false };
  const tg = tgApi();
  if (tg && loggedIn()) {
    const up = await uploadMedia(clip.blob);
    if (!up) return { ok: false };
    const name = `smiles-${Date.now().toString(36)}.${up.ext}`;
    if (typeof tg.downloadFile === 'function' && tgSupports('8.0')) {
      try {
        tg.downloadFile({ url: `${up.url}?dl=1`, file_name: name });
        haptic('win');
        trackStep('clip');
        return { ok: true, url: up.url, mp4: up.ext === 'mp4' };
      } catch { /* ниже — просто ссылка */ }
    }
    tg.openLink?.(up.url);
    return { ok: true, url: up.url, mp4: up.ext === 'mp4' };
  }
  // Обычный браузер: скачать файлом прямо из памяти
  const a = document.createElement('a');
  a.href = URL.createObjectURL(clip.blob);
  a.download = `smiles-clip.${clip.type === 'video/mp4' ? 'mp4' : 'webm'}`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  trackStep('clip');
  return { ok: true };
}

/** Клип — в сторис (только MP4: WebM Telegram в сторис не берёт). */
export async function clipToStory(clip) {
  if (!clip?.blob || !canStory()) return 'unsupported';
  const up = await uploadMedia(clip.blob);
  if (!up) return 'upload';
  if (up.ext !== 'mp4') return 'format';
  return postStory(up.url, { text: 'Мой выстрел в Smiles 💥 Сыграй со мной!' });
}
