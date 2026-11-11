/**
 * Мелочи HTTP для сервера: ошибки, JSON, адрес клиента, ограничитель,
 * раздача статики.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export const BODY_LIMIT = 16 * 1024;

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ------------------------------------------------------------ ограничитель

/**
 * Не больше n событий за окно с одного адреса. allow() только спрашивает,
 * hit() засчитывает. В памяти процесса: сервер один, этого достаточно.
 */
export function limiter(n, windowMs) {
  const hits = new Map();
  const fresh = (key, now) => {
    const h = hits.get(key);
    return h && now - h.start <= windowMs ? h : null;
  };
  return {
    allow(key) { return (fresh(key, Date.now())?.count ?? 0) < n; },
    hit(key) {
      const now = Date.now();
      const h = fresh(key, now);
      if (h) { h.count += 1; return h.count <= n; }
      hits.set(key, { start: now, count: 1 });
      if (hits.size > 50000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      return true;
    },
  };
}

// ------------------------------------------------------------- мелочи HTTP

export function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    // Лишнее дочитываем вхолостую, а не рвём соединение: иначе клиент не
    // увидит ответа 413. Больше мегабайта не пропустит nginx впереди.
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        if (!tooBig) { tooBig = true; chunks.length = 0; reject(new HttpError(413, 'слишком большой запрос')); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) { resolveBody({}); return; }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(v && typeof v === 'object' ? v : {});
      } catch { reject(new HttpError(400, 'не JSON')); }
    });
    req.on('error', reject);
  });
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const real = req.headers['x-real-ip'];
    if (real) return String(real);
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '?';
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export async function serveStatic(root, url, req, res) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const path = normalize(join(root, rel));
  if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  if (/[\\/]\./.test(path.slice(root.length))) { res.writeHead(404).end(); return; }
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

