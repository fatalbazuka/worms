#!/usr/bin/env node
/**
 * Сервер игры: аккаунты Telegram, рейтинг, турниры, бот и звёзды.
 * Node 22+, без единой зависимости: HTTP — node:http, база — node:sqlite.
 *
 *   PORT=3000 DB_PATH=./data/worms.db TELEGRAM_BOT_TOKEN=… node server/index.mjs
 *
 * Отдаёт /api/*. Если задан STATIC_DIR, заодно раздаёт игру — так можно
 * обойтись одним процессом без nginx (и так гоняются тесты).
 *
 * Переменные:
 *   PORT, HOST          — где слушать (3000, 0.0.0.0)
 *   DB_PATH             — файл базы (./data/worms.db)
 *   TELEGRAM_BOT_TOKEN  — токен бота: вход в игру, команды, звёзды
 *   ADMIN_TG_IDS        — Telegram ID админов через запятую: турниры, возвраты
 *   PUBLIC_URL          — адрес игры снаружи (https://домен/worms): вебхук и
 *                         кнопки «Играть»; без него бот не настраивается
 *   BOT_TZ              — часовой пояс для «/newtour 20:00» (Europe/Moscow)
 *   TELEGRAM_API_BASE   — адрес Bot API (для тестов — поддельный Telegram)
 *   BOT_WEBHOOK_SECRET  — свой секрет вебхука (по умолчанию выводится из токена)
 *   TRUST_PROXY         — 1, если впереди nginx/Caddy: IP клиента из X-Real-IP
 *   STATIC_DIR          — папка с игрой, если раздавать её этим же процессом
 *
 * API (JSON; вход — заголовок Authorization: Bearer <токен>):
 *   POST /api/telegram {initData}         → {token, player}  вход по подписи Telegram
 *   GET  /api/me                          → {player}
 *   GET  /api/me/history                  → {items}          бои: дуэли и турниры
 *   POST /api/result {room, seed, opponent, won} → итог боя (дуэль или турнир)
 *   GET  /api/top?kind=rating|tourney     → {players}
 *   GET  /api/tournaments                 → {items}
 *   GET  /api/tournaments/:id             → турнир, сетка, мой матч
 *   POST /api/tournaments/:id/join        → {ok} | {invoice} (платный)
 *   POST /api/tournaments/:id/leave       → {ok}
 *   POST /api/tournaments/:id/start       → {ok}             только админ
 *   POST /api/stars/donate {amount}       → {invoice}
 *   POST /api/bot/webhook                 ← обновления Telegram
 *   GET  /api/config, /api/health
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.mjs';
import { newToken, tokenHash } from './lib/accounts.js';
import { verifyInitData } from './lib/telegram.js';
import { settle } from './lib/elo.js';
import { isCasualRoom } from './lib/rooms.js';
import { HttpError, limiter, send, readJson, clientIp, serveStatic } from './http.mjs';
import { createTelegramApi } from './tgapi.mjs';
import { createPlayers } from './players.mjs';
import { createTournaments } from './tournaments.mjs';
import { createBot, webhookSecret } from './bot.mjs';

export function createApp({
  db, botToken = '', trustProxy = false, staticDir = null, now = () => Date.now(),
  adminIds = [], publicUrl = '', telegramApiBase = 'https://api.telegram.org', secret = '', tz = 'Europe/Moscow',
  log = console,
}) {
  const admins = new Set(adminIds.map(Number).filter(Boolean));
  const limits = { write: limiter(120, 60_000) };
  const api = createTelegramApi({ token: botToken, base: telegramApiBase, log });
  const players = createPlayers({ db, now, adminIds: admins });
  let bot = null;
  const tournaments = createTournaments({
    db, now,
    notify: (...a) => bot?.notify(...a),
    notifyAdmins: (...a) => bot?.notifyAdmins(...a),
    refund: (chargeId) => bot?.refund(chargeId) ?? false,
  });
  bot = createBot({ db, api, players, tournaments, adminIds: admins, publicUrl, tz, now, log });
  const hookSecret = botToken ? webhookSecret(botToken, secret) : '';

  const q = {
    sessionAdd: db.prepare('insert into session (token_hash, player_id, created_at, seen_at) values (?, ?, ?, ?)'),
    session: db.prepare('select player_id, seen_at from session where token_hash = ?'),
    sessionSeen: db.prepare('update session set seen_at = ? where token_hash = ?'),
    seen: db.prepare('update player set seen_at = ? where id = ?'),
    match: db.prepare('select * from match where room = ? and seed = ?'),
    matchAdd: db.prepare('insert into match (room, seed, p1, p2, p1_claim, created_at) values (?, ?, ?, ?, ?, ?)'),
    matchClose: db.prepare('update match set p2_claim = ?, status = ?, delta = ?, settled_at = ? where id = ?'),
    won: db.prepare(`update player set rating = ?, wins = wins + 1, streak = streak + 1,
                     best_streak = max(best_streak, streak + 1) where id = ?`),
    lost: db.prepare('update player set rating = ?, losses = losses + 1, streak = 0 where id = ?'),
  };

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
    if (!s) throw new HttpError(401, 'вход устарел — открой игру заново');
    const p = players.byId(s.player_id);
    if (!p) throw new HttpError(401, 'аккаунт не найден');
    const t = now();
    if (t - s.seen_at > 3600_000) { q.sessionSeen.run(t, h); q.seen.run(t, p.id); }
    return p;
  }

  // --------------------------------------------------------------- вход

  async function telegramLogin(body) {
    if (!botToken) throw new HttpError(503, 'вход через Telegram не настроен');
    const v = await verifyInitData(String(body.initData ?? ''), botToken, { now: now() });
    if (!v.ok) throw new HttpError(401, v.reason);
    const photo = typeof v.user.photo_url === 'string' && /^https:\/\//.test(v.user.photo_url)
      ? v.user.photo_url.slice(0, 300) : null;
    const p = players.upsertTg(v.user, photo);
    return { token: issueToken(p.id), player: players.view(p, { self: true }) };
  }

  // --------------------------------------------------------------- бои

  /**
   * Итог сетевого боя. Комната турнира — в турнир. Иначе дуэль на рейтинг:
   * первый отчёт открывает запись, второй закрывает; согласны — Эло обоим,
   * нет — спор. Повтор того же отчёта ничего не меняет.
   */
  function result(me, body) {
    const room = String(body.room ?? '').toUpperCase();
    const seed = Number(body.seed);
    const opponent = String(body.opponent ?? '');
    const claim = body.won ? 'win' : 'loss';
    if (!/^[A-Z0-9]{4,16}$/.test(room) || !Number.isSafeInteger(seed)) throw new HttpError(400, 'плохая комната');
    if (!opponent || opponent === me.id) throw new HttpError(400, 'нет соперника');
    const view = () => players.view(players.byId(me.id), { self: true });

    const tour = tournaments.report(me.id, room, Boolean(body.won));
    if (tour) return { ...tour, player: view() };
    // Бой без рейтинга: режим зашит в код комнаты, клиенту здесь не верим
    if (isCasualRoom(room)) return { status: 'unrated', reason: 'casual', player: view() };
    if (!players.byId(opponent)) return { status: 'unrated', player: view() };

    return tx(db, () => {
      const t = now();
      let m = q.match.get(room, seed);
      if (!m) {
        q.matchAdd.run(room, seed, me.id, opponent, claim, t);
        return { status: 'pending', player: view() };
      }
      const mine = (s) => ({ status: s, delta: m.delta == null ? undefined
        : (claim === 'win' ? m.delta : -m.delta), player: view() });
      if (m.status !== 'pending') {
        if (m.p1 !== me.id && m.p2 !== me.id) throw new HttpError(403, 'это не ваш бой');
        return mine(m.status);
      }
      if (m.p1 === me.id) return { status: 'pending', player: view() };
      if (m.p2 !== me.id || m.p1 !== opponent) throw new HttpError(403, 'это не ваш бой');

      if (m.p1_claim === claim) {
        q.matchClose.run(claim, 'disputed', null, t, m.id);
        return { status: 'disputed', player: view() };
      }
      const winnerId = m.p1_claim === 'win' ? m.p1 : m.p2;
      const loserId = winnerId === m.p1 ? m.p2 : m.p1;
      const w = players.byId(winnerId);
      const l = players.byId(loserId);
      const s = settle(w.rating, l.rating);
      q.won.run(s.winner, w.id);
      q.lost.run(s.loser, l.id);
      q.matchClose.run(claim, 'confirmed', s.delta, t, m.id);
      m = q.match.get(room, seed);
      return mine('confirmed');
    });
  }

  function history(me) {
    const items = [...players.duelHistory(me.id, 20), ...tournaments.historyFor(me.id, 20)]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 20);
    return { items };
  }

  function top(url) {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    const rows = url.searchParams.get('kind') === 'tourney' ? players.topTourney(limit) : players.top(limit);
    return { players: rows };
  }

  // --------------------------------------------------------------- турниры

  async function joinTour(me, tid) {
    const r = tournaments.join(tid, me.id);
    if (r.ok) return { ok: true };
    if (!r.pay) throw new HttpError(409, r.error);
    const link = await bot.tourInvoice(me, tournaments.byId(tid));
    if (!link) throw new HttpError(503, 'оплата звёздами сейчас недоступна');
    return { invoice: link, fee: r.fee };
  }

  async function donate(me, body) {
    const link = await bot.donateInvoice(me, Number(body.amount));
    if (!link) throw new HttpError(400, 'оплата звёздами недоступна или неизвестная сумма');
    return { invoice: link };
  }

  // --------------------------------------------------------------- маршруты

  async function api_(req, url) {
    const ip = clientIp(req, trustProxy);
    const path = url.pathname;
    const method = req.method;

    if (method === 'POST' && path === '/api/bot/webhook') {
      if (!hookSecret || req.headers['x-telegram-bot-api-secret-token'] !== hookSecret) {
        throw new HttpError(401, 'нет');
      }
      await bot.handleUpdate(await readJson(req));
      return { ok: true };
    }
    if (method === 'POST' && !limits.write.hit(ip)) throw new HttpError(429, 'слишком часто');

    const tm = /^\/api\/tournaments\/(\d+)(?:\/(join|leave|start))?$/.exec(path);
    if (tm) {
      const tid = Number(tm[1]);
      const me = auth(req);
      if (method === 'GET' && !tm[2]) {
        const t = tournaments.get(tid, me.id);
        if (!t) throw new HttpError(404, 'турнира нет');
        return { tournament: t };
      }
      if (method === 'POST' && tm[2] === 'join') return joinTour(me, tid);
      if (method === 'POST' && tm[2] === 'leave') {
        const r = await tournaments.leave(tid, me.id);
        if (!r.ok) throw new HttpError(409, r.error);
        return r;
      }
      if (method === 'POST' && tm[2] === 'start') {
        if (!players.isAdmin(me)) throw new HttpError(403, 'только для админа');
        const r = tournaments.start(tid);
        if (!r.ok) throw new HttpError(409, r.error);
        return r;
      }
    }

    switch (`${method} ${path}`) {
      case 'GET /api/health': return { ok: true };
      case 'GET /api/config': return { bot: bot.username || null, stars: api.enabled };
      case 'GET /api/top': return top(url);
      case 'POST /api/telegram': return telegramLogin(await readJson(req));
      case 'GET /api/me': return { player: players.view(auth(req), { self: true }) };
      case 'GET /api/me/history': return history(auth(req));
      case 'POST /api/result': { const me = auth(req); return result(me, await readJson(req)); }
      case 'GET /api/tournaments': {
        const me = auth(req);
        return { items: tournaments.list(me.id), admin: players.isAdmin(me) };
      }
      case 'POST /api/stars/donate': { const me = auth(req); return donate(me, await readJson(req)); }
      default: throw new HttpError(404, 'нет такого адреса');
    }
  }

  const root = staticDir ? resolve(staticDir) : null;

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
    if (url.pathname.startsWith('/api/')) {
      try {
        send(res, 200, await api_(req, url));
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.message, ...e.extra });
        else {
          log.error?.('[api]', req.method, url.pathname, e);
          send(res, 500, { error: 'ошибка сервера' });
        }
      }
      return;
    }
    if (root && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(root, url, req, res);
    res.writeHead(404).end('not found');
  }

  handle.tournaments = tournaments;
  handle.bot = bot;
  handle.players = players;
  handle.webhookSecret = hookSecret;
  /** Настроить бота (вебхук, меню) — вызывается при запуске сервера. */
  handle.setupBot = () => bot.setup({ secret: hookSecret });
  return handle;
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
    adminIds: String(env.ADMIN_TG_IDS || '').split(/[,\s]+/).filter(Boolean),
    publicUrl: env.PUBLIC_URL || '',
    telegramApiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    secret: env.BOT_WEBHOOK_SECRET || '',
    tz: env.BOT_TZ || 'Europe/Moscow',
  });
  const server = createServer(handle);
  server.listen(Number(env.PORT ?? 3000), env.HOST || '0.0.0.0', () => {
    const { port } = server.address();
    console.log(`worms api: порт ${port}, база ${env.DB_PATH || './data/worms.db'}`
      + `${env.TELEGRAM_BOT_TOKEN ? ', бот включён' : ', без бота'}`
      + `${env.STATIC_DIR ? `, игра из ${env.STATIC_DIR}` : ''}`);
    handle.setupBot().catch((e) => console.warn('[bot] настройка не удалась', e.message));
  });
  // Турниры живут по часам: автостарт и матчи, вышедшие за окно
  const ticker = setInterval(() => {
    try { handle.tournaments.tick(); } catch (e) { console.error('[tournaments] tick', e); }
  }, 30_000);
  const stop = () => {
    clearInterval(ticker);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
