#!/usr/bin/env node
/**
 * Сервер аккаунтов и рейтинга. Node 22+, без единой зависимости: HTTP —
 * node:http, база — node:sqlite, пароли — scrypt из node:crypto.
 *
 *   PORT=3000 DB_PATH=./data/worms.db node server/index.mjs
 *
 * Отдаёт /api/*. Если задан STATIC_DIR, заодно раздаёт игру — так можно
 * обойтись одним процессом без nginx (и так гоняются тесты).
 *
 * Переменные:
 *   PORT                — порт (3000; 0 — любой свободный)
 *   HOST                — адрес (0.0.0.0)
 *   DB_PATH             — файл базы (./data/worms.db)
 *   TELEGRAM_BOT_TOKEN  — токен бота: вход из Telegram без пароля
 *   TRUST_PROXY         — 1, если впереди nginx/Caddy: IP клиента из X-Real-IP
 *   STATIC_DIR          — папка с игрой, если раздавать её этим же процессом
 *
 * API (JSON; вход — заголовок Authorization: Bearer <токен>):
 *   POST /api/register {name, password}       → {token, player}
 *   POST /api/login    {name, password}       → {token, player}
 *   POST /api/telegram {initData}             → {token, player}
 *   GET  /api/me                              → {player}
 *   POST /api/rename   {name}                 → {player}
 *   POST /api/logout                          → {ok}
 *   POST /api/result   {room, seed, opponent, won} → {status, delta?, player}
 *   GET  /api/top?limit=20                    → {players: [...]}
 *   GET  /api/health                          → {ok}
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.mjs';
import {
  cleanName, checkPassword, hashPassword, verifyPassword, DUMMY_HASH,
  newToken, tokenHash, newPlayerId,
} from './lib/accounts.js';
import { verifyInitData, displayName } from './lib/telegram.js';
import { settle, START_RATING } from './lib/elo.js';

const BODY_LIMIT = 16 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ------------------------------------------------------------ ограничитель

/**
 * Не больше n событий за окно с одного адреса — от перебора паролей и
 * массовой регистрации. allow() только спрашивает, hit() засчитывает:
 * регистрация считается удачная, вход — неудачный. В памяти процесса:
 * сервер один, этого достаточно.
 */
function limiter(n, windowMs) {
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

// --------------------------------------------------------------- приложение

export function createApp({ db, botToken = '', trustProxy = false, staticDir = null, now = () => Date.now() }) {
  const limits = {
    register: limiter(10, 60 * 60_000),
    login: limiter(20, 10 * 60_000),
    write: limiter(120, 60_000),
  };

  const q = {
    byId: db.prepare('select * from player where id = ?'),
    byKey: db.prepare('select * from player where name_key = ?'),
    byTg: db.prepare('select * from player where tg_id = ?'),
    insert: db.prepare(`insert into player (id, name, name_key, pass_hash, tg_id, rating, created_at, seen_at)
                        values (?, ?, ?, ?, ?, ?, ?, ?)`),
    tgName: db.prepare('update player set name = ?, seen_at = ? where id = ?'),
    rename: db.prepare('update player set name = ?, name_key = ? where id = ?'),
    seen: db.prepare('update player set seen_at = ? where id = ?'),
    score: db.prepare('update player set rating = ?, wins = wins + ?, losses = losses + ? where id = ?'),
    rank: db.prepare('select count(*) + 1 as rank from player where wins + losses > 0 and rating > ?'),
    top: db.prepare(`select id, name, rating, wins, losses from player where wins + losses > 0
                     order by rating desc, wins desc, created_at asc limit ?`),
    sessionAdd: db.prepare('insert into session (token_hash, player_id, created_at, seen_at) values (?, ?, ?, ?)'),
    session: db.prepare('select player_id, seen_at from session where token_hash = ?'),
    sessionSeen: db.prepare('update session set seen_at = ? where token_hash = ?'),
    sessionDel: db.prepare('delete from session where token_hash = ?'),
    match: db.prepare('select * from match where room = ? and seed = ?'),
    matchAdd: db.prepare(`insert into match (room, seed, p1, p2, p1_claim, created_at)
                          values (?, ?, ?, ?, ?, ?)`),
    matchClose: db.prepare('update match set p2_claim = ?, status = ?, delta = ?, settled_at = ? where id = ?'),
  };

  /** Игрок наружу: без хэшей и служебных полей, с местом в таблице. */
  function view(p) {
    if (!p) return null;
    const played = p.wins + p.losses > 0;
    return {
      id: p.id, name: p.name, rating: p.rating, wins: p.wins, losses: p.losses,
      telegram: p.tg_id != null,
      rank: played ? q.rank.get(p.rating).rank : null,
    };
  }

  function issueToken(playerId) {
    const token = newToken();
    const t = now();
    q.sessionAdd.run(tokenHash(token), playerId, t, t);
    return token;
  }

  function auth(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new HttpError(401, 'нужно войти');
    const h = tokenHash(m[1]);
    const s = q.session.get(h);
    if (!s) throw new HttpError(401, 'вход устарел — войди заново');
    const p = q.byId.get(s.player_id);
    if (!p) throw new HttpError(401, 'аккаунт не найден');
    const t = now();
    // Отметка «был в игре» — не чаще раза в час, чтобы не писать на каждый запрос
    if (t - s.seen_at > 3600_000) { q.sessionSeen.run(t, h); q.seen.run(t, p.id); }
    return { player: p, tokenHash: h };
  }

  // --------------------------------------------------------------- действия

  async function register(body, ip) {
    if (!limits.register.allow(ip)) throw new HttpError(429, 'слишком много регистраций, подожди немного');
    const n = cleanName(body.name);
    if (n.error) throw new HttpError(400, n.error, { field: 'name' });
    const pw = checkPassword(body.password);
    if (pw.error) throw new HttpError(400, pw.error, { field: 'password' });
    if (q.byKey.get(n.key)) throw new HttpError(409, 'этот ник занят', { field: 'name' });
    const hash = await hashPassword(pw.pass);
    const t = now();
    const id = newPlayerId();
    try {
      q.insert.run(id, n.name, n.key, hash, null, START_RATING, t, t);
      limits.register.hit(ip);
    } catch (e) {
      // Два одинаковых ника в одну и ту же миллисекунду
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'этот ник занят', { field: 'name' });
      throw e;
    }
    return { token: issueToken(id), player: view(q.byId.get(id)) };
  }

  async function login(body, ip) {
    if (!limits.login.allow(ip)) throw new HttpError(429, 'слишком много попыток, подожди пару минут');
    const n = cleanName(body.name);
    const p = n.error ? null : q.byKey.get(n.key);
    // Неизвестный ник проверяется так же долго, как известный: по времени
    // ответа нельзя узнать, какие ники заняты
    const ok = await verifyPassword(String(body.password ?? ''), p?.pass_hash ?? DUMMY_HASH);
    if (!p || !ok) {
      limits.login.hit(ip);
      throw new HttpError(401, 'неверный ник или пароль');
    }
    q.seen.run(now(), p.id);
    return { token: issueToken(p.id), player: view(p) };
  }

  async function telegram(body) {
    if (!botToken) throw new HttpError(503, 'вход через Telegram не настроен');
    const v = await verifyInitData(String(body.initData ?? ''), botToken, { now: now() });
    if (!v.ok) throw new HttpError(401, v.reason);
    const tgId = Number(v.user.id);
    const name = displayName(v.user).slice(0, 32);
    const id = `tg${tgId}`;
    const t = now();
    if (q.byTg.get(tgId)) q.tgName.run(name, t, id);
    else q.insert.run(id, name, null, null, tgId, START_RATING, t, t);
    return { token: issueToken(id), player: view(q.byId.get(id)) };
  }

  function rename(me, body) {
    if (me.tg_id != null) throw new HttpError(400, 'имя берётся из Telegram');
    const n = cleanName(body.name);
    if (n.error) throw new HttpError(400, n.error, { field: 'name' });
    const other = q.byKey.get(n.key);
    if (other && other.id !== me.id) throw new HttpError(409, 'этот ник занят', { field: 'name' });
    q.rename.run(n.name, n.key, me.id);
    return { player: view(q.byId.get(me.id)) };
  }

  /**
   * Итог сетевого боя. Первый отчёт открывает запись, второй закрывает:
   * если стороны согласны, кто победил, обоим пересчитывается Эло; если
   * нет — спор, рейтинг не трогаем. Повтор того же отчёта ничего не меняет.
   */
  function result(me, body) {
    const room = String(body.room ?? '').toUpperCase();
    const seed = Number(body.seed);
    const opponent = String(body.opponent ?? '');
    const claim = body.won ? 'win' : 'loss';
    if (!/^[A-Z0-9]{4,16}$/.test(room) || !Number.isSafeInteger(seed)) throw new HttpError(400, 'плохая комната');
    if (!opponent || opponent === me.id) throw new HttpError(400, 'нет соперника');
    if (!q.byId.get(opponent)) return { status: 'unrated', player: view(me) };

    return tx(db, () => {
      const t = now();
      let m = q.match.get(room, seed);
      if (!m) {
        q.matchAdd.run(room, seed, me.id, opponent, claim, t);
        return { status: 'pending', player: view(me) };
      }
      const mine = (s) => ({ status: s, delta: m.delta == null ? undefined
        : (claim === 'win' ? m.delta : -m.delta), player: view(q.byId.get(me.id)) });
      if (m.status !== 'pending') {
        if (m.p1 !== me.id && m.p2 !== me.id) throw new HttpError(403, 'это не ваш бой');
        return mine(m.status);
      }
      if (m.p1 === me.id) return { status: 'pending', player: view(me) };
      if (m.p2 !== me.id || m.p1 !== opponent) throw new HttpError(403, 'это не ваш бой');

      if (m.p1_claim === claim) {
        q.matchClose.run(claim, 'disputed', null, t, m.id);
        return { status: 'disputed', player: view(me) };
      }
      const winnerId = m.p1_claim === 'win' ? m.p1 : m.p2;
      const loserId = winnerId === m.p1 ? m.p2 : m.p1;
      const w = q.byId.get(winnerId);
      const l = q.byId.get(loserId);
      const s = settle(w.rating, l.rating);
      q.score.run(s.winner, 1, 0, w.id);
      q.score.run(s.loser, 0, 1, l.id);
      q.matchClose.run(claim, 'confirmed', s.delta, t, m.id);
      m = q.match.get(room, seed);
      return mine('confirmed');
    });
  }

  function top(url) {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    return { players: q.top.all(limit).map((r) => ({ ...r })) };
  }

  // --------------------------------------------------------------- маршруты

  async function api(req, url) {
    const ip = clientIp(req, trustProxy);
    const route = `${req.method} ${url.pathname}`;
    if (req.method === 'POST' && !limits.write.hit(ip)) throw new HttpError(429, 'слишком часто');
    switch (route) {
      case 'GET /api/health': return { ok: true };
      case 'GET /api/top': return top(url);
      case 'POST /api/register': return register(await readJson(req), ip);
      case 'POST /api/login': return login(await readJson(req), ip);
      case 'POST /api/telegram': return telegram(await readJson(req));
      case 'GET /api/me': return { player: view(auth(req).player) };
      case 'POST /api/rename': { const a = auth(req); return rename(a.player, await readJson(req)); }
      case 'POST /api/logout': { const a = auth(req); q.sessionDel.run(a.tokenHash); return { ok: true }; }
      case 'POST /api/result': { const a = auth(req); return result(a.player, await readJson(req)); }
      default: throw new HttpError(404, 'нет такого адреса');
    }
  }

  const root = staticDir ? resolve(staticDir) : null;

  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
    if (url.pathname.startsWith('/api/')) {
      try {
        const data = await api(req, url);
        send(res, 200, data);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.message, ...e.extra });
        else {
          console.error('[api]', req.method, url.pathname, e);
          send(res, 500, { error: 'ошибка сервера' });
        }
      }
      return;
    }
    if (root && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(root, url, req, res);
    res.writeHead(404).end('not found');
  };
}

// ------------------------------------------------------------- мелочи HTTP

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJson(req) {
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

function clientIp(req, trustProxy) {
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

async function serveStatic(root, url, req, res) {
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

// ------------------------------------------------------------------- запуск

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const env = process.env;
  const db = openDb(env.DB_PATH || './data/worms.db');
  const handle = createApp({
    db,
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    staticDir: env.STATIC_DIR || null,
  });
  const server = createServer(handle);
  server.listen(Number(env.PORT ?? 3000), env.HOST || '0.0.0.0', () => {
    const { port } = server.address();
    console.log(`worms api: порт ${port}, база ${env.DB_PATH || './data/worms.db'}`
      + `${env.TELEGRAM_BOT_TOKEN ? ', вход через Telegram включён' : ''}`
      + `${env.STATIC_DIR ? `, игра из ${env.STATIC_DIR}` : ''}`);
  });
  const stop = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
