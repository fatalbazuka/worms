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
 *   TELEGRAM_APP        — короткое имя мини-приложения (t.me/бот/ИМЯ) для ссылок инлайн-вызова
 *   MEDIA_DIR           — куда класть картинки сторис и клипы (рядом с базой, папка media)
 *
 * API (JSON; вход — заголовок Authorization: Bearer <токен>):
 *   POST /api/telegram {initData}         → {token, player}  вход по подписи Telegram
 *   GET  /api/me                          → {player}
 *   GET  /api/me/history                  → {items}          бои: дуэли и турниры
 *   POST /api/result {room, seed, opponent, won} → итог боя (дуэль или турнир)
 *   GET  /api/top?kind=rating|tourney     → {players}
 *   GET  /api/friends                     → {friends, place, total}  топ друзей, сам игрок в нём с местом
 *   POST /api/friends/challenge {id, room} → {sent}          вызов другу через бота; sent=false — звать карточкой
 *   GET  /api/duels                       → {items, myTurn, max}  дуэли по переписке (server/duels.mjs)
 *   POST /api/duels {opponent} | {link}   → {duel}            новая: с другом или ссылкой с кодом
 *        + theyFirst                                          первым ходит позванный, создатель не ждёт
 *   POST /api/duels {code, theyFirst}     → {duel, existing?} вызов по коду игрока (любого, без дружбы)
 *   POST /api/duels/join {code}           → {duel}            принять по ссылке
 *   GET  /api/duels/:id                   → {duel}            с историей ходов
 *   POST /api/duels/:id/turn {turn, cmds, state, hash, prevHash, prevTurn, over, winner} → {duel}
 *   POST /api/duels/:id/resign            → {duel}
 *   GET  /api/tournaments                 → {items}
 *   GET  /api/tournaments/:id             → турнир, сетка, мой матч
 *   POST /api/tournaments/:id/join        → {ok} | {invoice} (платный)
 *   POST /api/tournaments/:id/leave       → {ok}
 *   POST /api/tournaments/:id/start       → {ok}             только админ
 *   POST /api/stars/donate {amount}       → {invoice}
 *   POST /api/event {name, props}         → {ok}             статистика: open | battle
 *   POST /api/promo {code}                → {boxes, coins, skin, owned}  активировать промокод
 *   POST /api/media (JPEG/PNG/WebM/MP4)   → {id, ext, path}  картинка для сторис, клип; GET /api/media/<id>.<ext>
 *   GET  /api/shop                        → {items, skinStars, owned}  товары и что положено
 *   POST /api/shop/buy {item}             → {invoice}        box1 | box5 | skin-<id>
 *   POST /api/challenge {room, link}      → {id}             карточка «вызов на бой» для shareMessage
 *   POST /api/login {login, password}     → {token, player}  вход с сайта (логин и пароль выдаёт /web)
 *   GET  /api/save · PUT /api/save {key, value}            прогресс игры на сервере
 *   GET  /api/daily-tower                 → {day, seed, top, me, players}  «Башня дня»
 *   POST /api/daily-tower {day, won, turns, hp} → то же + accepted       итог попытки
 *   POST /api/bot/webhook                 ← обновления Telegram
 *   GET  /api/config, /api/health
 */
import { createServer } from 'node:http';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.mjs';
import { newToken, tokenHash, verifyPassword } from './lib/accounts.js';
import { verifyInitData } from './lib/telegram.js';
import { settle } from './lib/elo.js';
import { isCasualRoom } from './lib/rooms.js';
import { HttpError, limiter, send, readJson, clientIp, serveStatic } from './http.mjs';
import { createTelegramApi } from './tgapi.mjs';
import { createPlayers } from './players.mjs';
import { createTournaments } from './tournaments.mjs';
import { createBot, webhookSecret } from './bot.mjs';
import { createAnalytics } from './analytics.mjs';
import { createShop, SHOP, SKIN_STARS, SKIN_IDS, shopItem } from './shop.mjs';
import { createDailyTower } from './dailytower.mjs';
import { createSaves } from './saves.mjs';
import { createAdmin } from './admin.mjs';
import { createMedia } from './media.mjs';
import { createWeekly } from './weekly.mjs';
import { createPromos } from './promo.mjs';
import { createFriends } from './friends.mjs';
import { createDuels } from './duels.mjs';

export function createApp({
  db, botToken = '', trustProxy = false, staticDir = null, now = () => Date.now(),
  adminIds = [], publicUrl = '', telegramApiBase = 'https://api.telegram.org', secret = '', tz = 'Europe/Moscow',
  log = console, mediaDir = null, appName = '',
}) {
  const admins = new Set(adminIds.map(Number).filter(Boolean));
  // login — подбор пароля: не больше 10 попыток в минуту с одного адреса
  const limits = { write: limiter(120, 60_000), login: limiter(10, 60_000), media: limiter(30, 3600_000), promo: limiter(10, 60_000),
    // Новых дуэлей и входов по ссылке — не больше 20 в час на игрока
    duel: limiter(20, 3600_000) };
  // Картинки для сторис и клипы: лежат несколько дней (server/media.mjs)
  const media = createMedia({ dir: mediaDir, now });
  const api = createTelegramApi({ token: botToken, base: telegramApiBase, log });
  const players = createPlayers({ db, now, adminIds: admins });
  let bot = null;
  const tournaments = createTournaments({
    db, now,
    notify: (...a) => bot?.notify(...a),
    notifyAdmins: (...a) => bot?.notifyAdmins(...a),
    refund: (chargeId) => bot?.refund(chargeId) ?? false,
    onFinish: (...a) => weekly?.onFinish(...a),
  });
  let weekly = null;
  const analytics = createAnalytics({ db, now, tz });
  const shop = createShop({ db, now });
  const promos = createPromos({ db, now });
  const saves = createSaves({ db, now });
  const daily = createDailyTower({ db, players, dayOf: () => analytics.dayOf(), now });
  const admin = createAdmin({ db, players, analytics, tournaments, shop, saves, api, now, log });
  // Дуэли заводятся ниже (им нужны друзья, а друзьям — бот): боту — ссылка
  bot = createBot({ db, api, players, tournaments, analytics, admin, adminIds: admins, publicUrl, tz, now, log, appName, promos,
    duels: () => duels });
  weekly = createWeekly({ db, tournaments, shop, notify: (...a) => bot.notify(...a), tz, now, log });
  const friends = createFriends({
    db, players, analytics, now, log,
    notify: (...a) => bot.notify(...a),
    invite: (...a) => bot.inviteDuel(...a),
  });
  const duels = createDuels({ db, players, friends, analytics, now, log, notify: (...a) => bot.notify(...a) });
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
    if (p.banned_at) throw new HttpError(403, 'аккаунт заблокирован');
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
    // Новичок — кто игру ещё не открывал. Нажать /start в чате с ботом
    // раньше, чем открыть игру по ссылке друга, — нормально, подарок от
    // этого не пропадает
    const was = players.byId(`tg${Number(v.user.id)}`);
    const fresh = !was || !was.app_at;
    const p = players.upsertTg(v.user, photo);
    if (players.byId(p.id)?.banned_at) throw new HttpError(403, 'аккаунт заблокирован');
    if (fresh) players.markApp(p.id);
    // Новичок по ссылке друга — обоим по коробке; другу — сообщение в бот
    if (fresh) {
      // Ссылка на шахматную партию (duel_КОД) — приглашение от её создателя
      const dc = /^duel_([A-Z0-9]{4,10})$/i.exec(String(v.startParam ?? ''))?.[1];
      const dh = dc ? duels.byCode(dc) : null;
      const host = shop.referral(p, v.startParam, players, dh && !dh.p2 ? dh.p1 : null);
      if (host) {
        bot.notify(host, `🎁 ${p.name} пришёл в игру по твоему приглашению — вам обоим по коробке со скином! `
          + 'Открой игру, коробка уже там.').catch(() => {});
      }
    }
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

    let rated = null;
    const out = tx(db, () => {
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
      rated = { winnerId: w.id, loserId: l.id, before: w.rating, after: s.winner };
      return mine('confirmed');
    });
    // Победитель мог обогнать друзей — им напишет бот, ответ игроку не ждёт
    if (rated) friends.onRated(rated).catch((e) => log.error?.('[friends] обогнал', e));
    return out;
  }

  function history(me) {
    const items = [...players.duelHistory(me.id, 20), ...tournaments.historyFor(me.id, 20), ...duels.history(me.id, 20)]
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, 20);
    return { items };
  }

  function top(url) {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    const rows = url.searchParams.get('kind') === 'tourney' ? players.topTourney(limit) : players.top(limit);
    // Скин — только из известных: в копию прогресса пишет клиент
    return { players: rows.map((r) => ({ ...r, skin: SKIN_IDS.includes(r.skin) ? r.skin : 'classic' })) };
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
    if ((method === 'POST' || method === 'PUT') && !limits.write.hit(ip)) throw new HttpError(429, 'слишком часто');

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

    const dm = /^\/api\/duels\/(\d+)(?:\/(turn|resign))?$/.exec(path);
    if (dm) {
      const me = auth(req);
      const fail = (r) => { if (r.error) throw new HttpError(r.status ?? 400, r.error, r.duel ? { duel: r.duel } : {}); return r; };
      if (method === 'GET' && !dm[2]) {
        const d = duels.get(me.id, dm[1]);
        if (!d) throw new HttpError(404, 'нет такой дуэли');
        return { duel: d };
      }
      // Ход — приказы и снимок: длиннее обычного запроса
      if (method === 'POST' && dm[2] === 'turn') return fail(await duels.submit(me, dm[1], await readJson(req, 96 * 1024)));
      if (method === 'POST' && dm[2] === 'resign') return fail(await duels.resign(me, dm[1]));
    }

    if (path.startsWith('/api/admin/')) return adminApi(method, path, url, req, ip);

    switch (`${method} ${path}`) {
      case 'GET /api/health': return { ok: true };
      case 'GET /api/config': return { bot: bot.username || null, stars: api.enabled };
      case 'GET /api/top': return top(url);
      case 'GET /api/friends': return friends.list(auth(req).id);
      case 'POST /api/friends/challenge': {
        const me = auth(req);
        const { id, room } = await readJson(req);
        const code = String(room ?? '').toUpperCase();
        // Только комната башни с другом — как у карточки вызова
        if (!/^ZW[A-Z0-9]{2,10}$/.test(code)) throw new HttpError(400, 'не та комната');
        const r = await friends.challenge(me, String(id ?? ''), code);
        if (r.error) throw new HttpError(403, r.error);
        return r;
      }
      case 'POST /api/room/knock': {
        const me = auth(req);
        if (!limits.duel.hit(me.id)) throw new HttpError(429, 'слишком часто');
        const code = String((await readJson(req)).room ?? '').toUpperCase();
        if (!/^ZW[A-Z0-9]{2,10}$/.test(code)) throw new HttpError(400, 'не та комната');
        return bot.knockRoom(me, code);
      }
      case 'GET /api/duels': return duels.list(auth(req).id);
      case 'POST /api/duels':
      case 'POST /api/duels/join': {
        const me = auth(req);
        if (!limits.duel.hit(me.id)) throw new HttpError(429, 'слишком много дуэлей за час');
        const body = await readJson(req);
        const r = path.endsWith('/join') ? duels.join(me, body.code)
          : duels.create(me, { opponent: body.opponent, code: body.code ?? null, link: body.link === true, theyFirst: body.theyFirst === true });
        if (r.error) throw new HttpError(r.status ?? 400, r.error);
        return r;
      }
      case 'POST /api/telegram': return telegramLogin(await readJson(req));
      case 'POST /api/login': {
        if (!limits.login.hit(ip)) throw new HttpError(429, 'слишком много попыток, подожди минуту');
        const { login, password } = await readJson(req);
        const p = players.byLogin(login);
        if (!p || !verifyPassword(password, p.pass_hash)) throw new HttpError(401, 'неверный логин или пароль');
        if (p.banned_at) throw new HttpError(403, 'аккаунт заблокирован');
        return { token: issueToken(p.id), player: players.view(p, { self: true }) };
      }
      case 'GET /api/save': return { items: saves.all(auth(req).id) };
      case 'PUT /api/save': {
        const me = auth(req);
        const { key, value } = await readJson(req);
        const err = saves.put(me.id, String(key ?? ''), value);
        if (err) throw new HttpError(400, err);
        return { ok: true };
      }
      case 'GET /api/me': return { player: players.view(auth(req), { self: true }) };
      case 'GET /api/me/history': return history(auth(req));
      case 'POST /api/result': { const me = auth(req); return result(me, await readJson(req)); }
      case 'GET /api/tournaments': {
        const me = auth(req);
        return { items: tournaments.list(me.id), admin: players.isAdmin(me) };
      }
      case 'POST /api/stars/donate': { const me = auth(req); return donate(me, await readJson(req)); }
      case 'GET /api/shop': {
        const me = auth(req);
        return { items: SHOP, skinStars: SKIN_STARS, owned: shop.owned(me.id), stars: api.enabled };
      }
      case 'GET /api/daily-tower': return daily.board(auth(req));
      case 'POST /api/daily-tower': { const me = auth(req); return daily.submit(me, await readJson(req)); }
      case 'POST /api/challenge': {
        const me = auth(req);
        const { room, duel, link } = await readJson(req);
        // Комната башни с другом или своя дуэль-вызов, ссылка — на неё же
        const code = String(duel ?? room ?? '').toUpperCase();
        if (duel != null) {
          const d = duels.byCode(code);
          if (!d || d.p1 !== me.id || d.status !== 'open') throw new HttpError(400, 'не та дуэль');
        } else if (!/^ZW[A-Z0-9]{2,10}$/.test(code)) throw new HttpError(400, 'не та комната');
        const param = duel != null ? `duel_${code}` : code;
        const url = String(link ?? '');
        if (!/^https:\/\/t\.me\/[\w/]+\?startapp=[A-Za-z0-9_-]+$/.test(url) || !url.endsWith(`startapp=${param}`)) {
          throw new HttpError(400, 'не та ссылка');
        }
        const id = await bot.prepareChallenge(me, code, url, { duel: duel != null });
        if (!id) throw new HttpError(503, 'карточка сейчас недоступна');
        return { id };
      }
      case 'POST /api/shop/buy': {
        const me = auth(req);
        const it = shopItem((await readJson(req)).item);
        if (!it) throw new HttpError(400, 'нет такого товара');
        // Скин, уже купленный за звёзды, второй раз не продаём
        if (it.kind === 'skin' && shop.owned(me.id).skins.includes(it.skin)) {
          throw new HttpError(409, 'этот скин уже куплен');
        }
        const link = await bot.shopInvoice(me, it);
        if (!link) throw new HttpError(503, 'оплата звёздами сейчас недоступна');
        return { invoice: link };
      }
      case 'POST /api/promo': {
        // Подбор кода: не больше 10 попыток в минуту на игрока
        const me = auth(req);
        if (!limits.promo.hit(me.id)) throw new HttpError(429, 'слишком много попыток, подожди минуту');
        const r = promos.redeem(me.id, (await readJson(req)).code);
        if (!r.ok) throw new HttpError(r.status, r.error);
        return { ...r, owned: shop.owned(me.id) };
      }
      case 'POST /api/media': {
        const me = auth(req);
        if (!limits.media.hit(me.id)) throw new HttpError(429, 'слишком много файлов, попробуй через час');
        return media.upload(req);
      }
      case 'POST /api/event': {
        const me = auth(req);
        const body = await readJson(req);
        return { ok: analytics.record(me, body.name, body.props) };
      }
      default: throw new HttpError(404, 'нет такого адреса');
    }
  }

  // ------------------------------------------------------------- админка

  async function adminApi(method, path, url, req, ip) {
    if (method === 'POST' && path === '/api/admin/enter') {
      if (!limits.login.hit(ip)) throw new HttpError(429, 'слишком много попыток, подожди минуту');
      const { key } = await readJson(req);
      const id = admin.useKey(key);
      const p = id ? players.byId(id) : null;
      if (!p || !players.isAdmin(p)) throw new HttpError(401, 'ссылка устарела — попроси у бота новую: /admin');
      return { token: issueToken(p.id), player: players.view(p, { self: true }) };
    }
    const me = auth(req);
    if (!players.isAdmin(me)) throw new HttpError(403, 'только для админа');
    const body = method === 'POST' ? await readJson(req) : null;
    const fail = (r, status = 400) => { if (!r.ok) throw new HttpError(status, r.error); return r; };
    switch (`${method} ${path}`) {
      case 'GET /api/admin/me': return { player: players.view(me, { self: true }) };
      case 'GET /api/admin/overview': return admin.overview();
      case 'GET /api/admin/players': return { players: admin.search(url.searchParams.get('q') ?? '') };
      case 'GET /api/admin/player': {
        const c = admin.card(url.searchParams.get('id'));
        if (!c) throw new HttpError(404, 'нет такого игрока');
        return c;
      }
      case 'POST /api/admin/ban': return fail(admin.setBan(body.id, Boolean(body.ban)), 409);
      case 'POST /api/admin/gift': return fail(await admin.gift(body.id, body));
      case 'POST /api/admin/accounts': return fail(admin.createAccount(body), 409);
      case 'POST /api/admin/password': return fail(admin.setPassword(body.id, body), 409);
      case 'GET /api/admin/tours': return { items: admin.tours() };
      case 'POST /api/admin/tours': {
        try {
          const t = tournaments.create({
            name: body.name, size: Number(body.size), fee: Number(body.fee) || 0,
            startsAt: body.startsAt ? Number(body.startsAt) : null,
          });
          return { tournament: t };
        } catch (e) { throw new HttpError(400, e.message); }
      }
      case 'GET /api/admin/promos': return { items: promos.list() };
      case 'POST /api/admin/promos': return fail(promos.create(body), 409);
      case 'POST /api/admin/promos/disable': return fail(promos.disable(body.code), 404);
      case 'POST /api/admin/tours/start': return fail(tournaments.start(Number(body.id)), 409);
      case 'POST /api/admin/tours/cancel': return fail(await tournaments.cancel(Number(body.id)), 409);
      case 'GET /api/admin/broadcast': return { audience: admin.audience().length, items: admin.broadcasts() };
      case 'POST /api/admin/broadcast':
        // Без confirm — только сколько человек получат: отправка — вторым нажатием
        if (!body.confirm) return { preview: true, audience: admin.audience().length };
        return fail(admin.broadcast(body.text));
      default: throw new HttpError(404, 'нет такого адреса');
    }
  }

  /** Копия базы файлом — не JSON, поэтому отдельно от остального API. */
  function adminBackup(req, res) {
    try {
      const me = auth(req);
      if (!players.isAdmin(me)) throw new HttpError(403, 'только для админа');
    } catch (e) {
      send(res, e.status ?? 500, { error: e.message });
      return;
    }
    const snap = admin.snapshot();
    const name = snap.path.split('/').pop();
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': snap.size,
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    snap.stream().on('close', snap.cleanup).pipe(res);
  }

  const root = staticDir ? resolve(staticDir) : null;

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end(); return; }
    if (url.pathname === '/api/admin/backup' && req.method === 'GET') { adminBackup(req, res); return; }
    if (url.pathname.startsWith('/api/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const download = url.searchParams.get('dl') === '1';
      if (!media.serve(url.pathname.slice('/api/media/'.length), req, res, { download })) res.writeHead(404).end('not found');
      return;
    }
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
  handle.weekly = weekly;
  handle.analytics = analytics;
  handle.bot = bot;
  handle.players = players;
  handle.friends = friends;
  handle.duels = duels;
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
    appName: env.TELEGRAM_APP || '',
    mediaDir: env.MEDIA_DIR || join(dirname(resolve(env.DB_PATH || './data/worms.db')), 'media'),
  });
  const server = createServer(handle);
  server.listen(Number(env.PORT ?? 3000), env.HOST || '0.0.0.0', () => {
    const { port } = server.address();
    console.log(`worms api: порт ${port}, база ${env.DB_PATH || './data/worms.db'}`
      + `${env.TELEGRAM_BOT_TOKEN ? ', бот включён' : ', без бота'}`
      + `${env.STATIC_DIR ? `, игра из ${env.STATIC_DIR}` : ''}`);
    // Telegram мог быть недоступен при запуске — пробуем ещё, пока не выйдет
    const trySetup = () => handle.setupBot()
      .then((ok) => { if (!ok) setTimeout(trySetup, 5 * 60_000); })
      .catch((e) => { console.warn('[bot] настройка не удалась', e.message); setTimeout(trySetup, 5 * 60_000); });
    trySetup();
  });
  // Турниры живут по часам: автостарт и матчи, вышедшие за окно
  const ticker = setInterval(() => {
    try { handle.tournaments.tick(); } catch (e) { console.error('[tournaments] tick', e); }
    // Турнир недели заводим, только когда бот настроен: иначе анонс уйдёт в никуда
    if (handle.bot.username) {
      try { handle.weekly.tick(); } catch (e) { console.error('[weekly] tick', e); }
    }
    handle.bot.remind().catch((e) => console.error('[bot] напоминания', e));
    // Дуэли по переписке: просроченный ход — пропуск, за два часа — напоминание
    handle.duels.tick().catch((e) => console.error('[duels] tick', e));
  }, 30_000);
  const stop = () => {
    clearInterval(ticker);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
