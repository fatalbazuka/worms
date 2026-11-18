/**
 * Игроки: заводятся из Telegram (вход в мини-приложение или /start в
 * боте), id — tg<id>. Здесь же вид игрока наружу и статистика кабинета.
 */
import { randomBytes } from 'node:crypto';
import { START_RATING } from './lib/elo.js';
import { displayName } from './lib/telegram.js';

const SKIN_SQL = `(select case when json_valid(s.value) then json_extract(s.value, '$.equipped') end
  from save_kv s where s.player_id = player.id and s.key = 'worms.skins.v1')`;

export function createPlayers({ db, now = () => Date.now(), adminIds = new Set() }) {
  const q = {
    byId: db.prepare('select * from player where id = ?'),
    byTg: db.prepare('select * from player where tg_id = ?'),
    markApp: db.prepare('update player set app_at = ? where id = ? and app_at is null'),
    byLogin: db.prepare('select * from player where name_key = ?'),
    setLogin: db.prepare('update player set name_key = ?, pass_hash = ? where id = ?'),
    // Аккаунт только для сайта, без Telegram: id u<hex>, вход логином и паролем
    insertWeb: db.prepare(`insert into player (id, name, name_key, pass_hash, tg_id, rating, created_at, seen_at, app_at)
                           values (?, ?, ?, ?, null, ?, ?, ?, ?)`),
    insert: db.prepare(`insert into player (id, name, name_key, pass_hash, tg_id, rating, photo, created_at, seen_at)
                        values (?, ?, null, null, ?, ?, ?, ?, ?)`),
    update: db.prepare('update player set name = ?, photo = coalesce(?, photo), seen_at = ? where id = ?'),
    rank: db.prepare('select count(*) + 1 as rank from player where wins + losses > 0 and banned_at is null and rating > ?'),
    // skin — надетый скин из прогресса на сервере (save_kv): топ показывает
    // игроков в их модельках. Битая копия — null, а не ошибка всего топа
    top: db.prepare(`select id, name, photo, rating, wins, losses, tourney_wins, ${SKIN_SQL} as skin from player
                     where wins + losses > 0 and banned_at is null order by rating desc, wins desc, created_at asc limit ?`),
    topTourney: db.prepare(`select id, name, photo, rating, wins, losses, tourney_wins, ${SKIN_SQL} as skin from player
                            where tourney_wins > 0 and banned_at is null order by tourney_wins desc, rating desc limit ?`),
    // Админка: поиск по нику, Telegram ID или id; без запроса — последние зашедшие
    search: db.prepare(`select id, name, tg_id, rating, wins, losses, tourney_wins, created_at, seen_at, banned_at
                        from player where (? = '' or name like ? or cast(tg_id as text) = ? or id = ?)
                        order by seen_at desc limit ?`),
    ban: db.prepare('update player set banned_at = ? where id = ?'),
    duels: db.prepare(`select * from match where (p1 = ? or p2 = ?) and status in ('confirmed', 'disputed')
                       order by settled_at desc limit ?`),
  };

  /** Завести или освежить игрока по пользователю Telegram. */
  function upsertTg(user, photo = null) {
    const tgId = Number(user.id);
    const id = `tg${tgId}`;
    const name = displayName(user).slice(0, 32);
    const t = now();
    if (q.byTg.get(tgId)) q.update.run(name, photo, t, id);
    else q.insert.run(id, name, tgId, START_RATING, photo, t, t);
    return q.byId.get(id);
  }

  /** Вход с сайта: логин (в нижнем регистре) и хеш пароля. */
  function byLogin(login) { return q.byLogin.get(String(login ?? '').trim().toLowerCase()) ?? null; }
  function setLogin(id, login, passHash) { q.setLogin.run(String(login).toLowerCase(), passHash, id); }

  /** Игрок впервые открыл игру. */
  function markApp(id) { q.markApp.run(now(), id); }

  const isAdmin = (p) => Boolean(p?.tg_id && adminIds.has(Number(p.tg_id)));

  function titles(p) {
    try { return JSON.parse(p.titles || '[]'); } catch { return []; }
  }

  /** Игрок наружу: без служебных полей, с местом в таблице и статистикой. */
  function view(p, { self = false } = {}) {
    if (!p) return null;
    const played = p.wins + p.losses;
    const out = {
      id: p.id, name: p.name, photo: p.photo ?? null, rating: p.rating,
      wins: p.wins, losses: p.losses, telegram: true,
      rank: played > 0 ? q.rank.get(p.rating).rank : null,
      winrate: played > 0 ? Math.round((p.wins / played) * 100) : null,
      streak: p.streak, bestStreak: p.best_streak,
      tourneyWins: p.tourney_wins, titles: titles(p),
    };
    if (self && isAdmin(p)) out.admin = true;
    return out;
  }

  /** Дуэли на рейтинг для истории кабинета. */
  function duelHistory(playerId, limit = 20) {
    return q.duels.all(playerId, playerId, limit).map((m) => {
      const foeId = m.p1 === playerId ? m.p2 : m.p1;
      const foe = q.byId.get(foeId);
      const myClaim = m.p1 === playerId ? m.p1_claim : m.p2_claim;
      const won = m.status === 'confirmed' ? myClaim === 'win' : null;
      return {
        kind: 'duel', at: m.settled_at, won, status: m.status,
        delta: m.delta == null ? null : (won ? m.delta : -m.delta),
        opponent: foe ? { id: foe.id, name: foe.name, photo: foe.photo } : null,
      };
    });
  }

  return {
    byId: (id) => q.byId.get(id),
    byTg: (tgId) => q.byTg.get(Number(tgId)),
    upsertTg, markApp, byLogin, setLogin, view, isAdmin, duelHistory,
    createWeb: (login, name, passHash) => {
      const id = `u${randomBytes(6).toString('hex')}`;
      const t = now();
      q.insertWeb.run(id, name, String(login).toLowerCase(), passHash, START_RATING, t, t, t);
      return q.byId.get(id);
    },
    search: (text, limit = 50) => {
      const t = String(text ?? '').trim().slice(0, 60);
      return q.search.all(t, `%${t}%`, t, t, Math.max(1, Math.min(200, limit))).map((r) => ({ ...r }));
    },
    setBan: (id, on) => q.ban.run(on ? now() : null, id),
    top: (n) => q.top.all(n).map((r) => ({ ...r })),
    topTourney: (n) => q.topTourney.all(n).map((r) => ({ ...r })),
  };
}
