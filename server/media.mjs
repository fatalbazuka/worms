/**
 * Картинки и клипы для сторис и «сохранить клип».
 *
 * Telegram берёт сторис и файл на скачивание только по HTTPS-ссылке, а не из
 * памяти страницы. Поэтому клиент отдаёт сюда карточку победы (JPEG) или клип
 * выстрела (WebM/MP4), а получает адрес /api/media/<id>.<ext>, который живёт
 * несколько дней и потом стирается.
 *
 * WebM из Android-браузера Telegram в сторис не возьмёт — если на сервере
 * есть ffmpeg, клип перекодируется в MP4 (H.264). Нет ffmpeg — остаётся как
 * есть: сохранить его можно, в сторис — нет (клиент это видит по ext).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, createReadStream, existsSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.mjs';

export const MEDIA_LIMIT = 8 * 1024 * 1024;
const KEEP_MS = 3 * 24 * 3600 * 1000;
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};
const MIME = { jpg: 'image/jpeg', png: 'image/png', webm: 'video/webm', mp4: 'video/mp4' };

/** Тело запроса как есть, не больше limit байт. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!tooBig) { tooBig = true; chunks.length = 0; reject(new HttpError(413, 'файл слишком большой')); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/** Есть ли ffmpeg: один раз на процесс. */
let ffmpegOk = null;
function hasFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve((ffmpegOk = false)));
    p.on('exit', (code) => resolve((ffmpegOk = code === 0)));
  });
}

function toMp4(src, dst) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      // Сторис требует чётные стороны
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', '-an', dst],
    { stdio: 'ignore' });
    const kill = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('error', () => { clearTimeout(kill); resolve(false); });
    p.on('exit', (code) => { clearTimeout(kill); resolve(code === 0); });
  });
}

export function createMedia({ dir, now = () => Date.now() }) {
  if (dir) mkdirSync(dir, { recursive: true });

  function sweep() {
    if (!dir) return;
    const t = now();
    for (const f of readdirSync(dir)) {
      try {
        if (t - statSync(join(dir, f)).mtimeMs > KEEP_MS) unlinkSync(join(dir, f));
      } catch { /* уже стёрт */ }
    }
  }

  /** Принять файл. @returns {{id, ext, path}} */
  async function upload(req) {
    if (!dir) throw new HttpError(503, 'хранилище не настроено');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const ext = TYPES[type];
    if (!ext) throw new HttpError(415, 'только JPEG, PNG, WebM или MP4');
    const body = await readBody(req, MEDIA_LIMIT);
    if (body.length < 64) throw new HttpError(400, 'пустой файл');
    sweep();
    const id = randomBytes(12).toString('hex');
    const file = join(dir, `${id}.${ext}`);
    await writeFile(file, body);
    if (ext === 'webm' && await hasFfmpeg()) {
      const tmp = join(dir, `${id}.tmp.mp4`);
      if (await toMp4(file, tmp)) {
        await rename(tmp, join(dir, `${id}.mp4`));
        try { unlinkSync(file); } catch { /* ладно */ }
        return { id, ext: 'mp4', path: `/api/media/${id}.mp4` };
      }
      try { unlinkSync(tmp); } catch { /* не создался */ }
    }
    return { id, ext, path: `/api/media/${id}.${ext}` };
  }

  /** Отдать файл. @returns {boolean} нашёлся ли */
  function serve(name, req, res, { download = false } = {}) {
    const m = /^([0-9a-f]{24})\.(jpg|png|webm|mp4)$/.exec(name);
    if (!dir || !m) return false;
    const file = join(dir, name);
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    const head = {
      'Content-Type': MIME[m[2]],
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      // «Сохранить» в Telegram (downloadFile) берёт имя отсюда; Telegram Web
      // качает файл сам из браузера — ему нужен CORS
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="smiles-${m[1].slice(0, 6)}.${m[2]}"`,
      'Access-Control-Allow-Origin': '*',
    };
    // Видео в WebView просит кусками
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start); end = Math.min(size - 1, end);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return true; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return true; }
      createReadStream(file, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file).pipe(res);
    return true;
  }

  return { upload, serve, hasFfmpeg };
}
