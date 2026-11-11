/**
 * Игроки: заводятся из Telegram (вход в мини-приложение или /start в
 * боте), id — tg<id>. Здесь же вид игрока наружу и статистика кабинета.
 */
import { START_RATING } from './lib/elo.js';
import { displayName } from './lib/telegram.js';

export function createPlayers({ db, now = () => Date.now(), adminIds = new Set() }) {
  const q = {
    byId: db.prepare('select * from player where id = ?'),
    byTg: db.prepare('select * from player where tg_id = ?'),
    insert: db.prepare(`insert into player (id, name, name_key, pass_hash, tg_id, rating, photo, created_at, seen_at)
                        values (?, ?, null, null, ?, ?, ?, ?, ?)`),
    update: db.prepare('update player set name = ?, photo = coalesce(?, photo), seen_at = ? where id = ?'),
    rank: db.prepare('select count(*) + 1 as rank from player where wins + losses > 0 and rating > ?'),
    top: db.prepare(`select id, name, photo, rating, wins, losses, tourney_wins from player
                     where wins + losses > 0 order by rating desc, wins desc, created_at asc limit ?`),
    topTourney: db.prepare(`select id, name, photo, rating, tourney_wins from player
                            where tourney_wins > 0 order by tourney_wins desc, rating desc limit ?`),
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
    upsertTg, view, isAdmin, duelHistory,
    top: (n) => q.top.all(n).map((r) => ({ ...r })),
    topTourney: (n) => q.topTourney.all(n).map((r) => ({ ...r })),
  };
}
