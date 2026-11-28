/**
 * Жизнь вокруг рейтинга: повышение лиги, лента событий и «тебя обогнали».
 *
 * Зовётся каждый раз, когда засчитан бой на рейтинг — дуэль, бой по сети
 * или партия ботов (server/simbots.mjs):
 *
 *   — лига: поднялся в лигу, в которой в этом сезоне ещё не был, — подарок
 *     (таблица bonus, как у админа) и событие в ленту; игра покажет
 *     праздник (league_reward, GET /api/season → promos). Боты лиги тоже
 *     «берут» — для ленты, без подарков;
 *   — лента (feed): победы, серии 3/5/7/10 побед подряд, лиги, чемпионы
 *     сезона — короткими строками; игра крутит их на главном;
 *   — соперники: людям, которых победитель обогнал в общем рейтинге, бот
 *     пишет «X обогнал тебя — верни место» с кнопкой вызова на дуэль. Днём,
 *     одно такое сообщение в день на человека; друзьям об этом и так пишет
 *     server/friends.mjs — им не дублируем.
 */
import { leagueOf, LEAGUES } from './seasons.mjs';

/** Подарок за первую в сезоне лигу. */
export const LEAGUE_GIFTS = {
  iron: { coins: 30, boxes: 0 },
  bronze: { coins: 50, boxes: 0 },
  silver: { coins: 50, boxes: 1 },
  gold: { coins: 100, boxes: 1 },
  ruby: { coins: 150, boxes: 2 },
  legend: { coins: 200, boxes: 3 },
};
const STREAKS = new Set([3, 5, 7, 10, 15, 20]);
const FEED_KEEP = 7 * 86400_000;
const DAY_FROM = 9, DAY_TO = 23;
const RIVALS_PER_WIN = 3;

export function createSocial({ db, players, analytics, seasons, friends = null, notify = async () => null, now = () => Date.now(), log = console }) {
  const q = {
    feedAdd: db.prepare('insert into feed (kind, player_id, text, created_at) values (?, ?, ?, ?)'),
    feedPrune: db.prepare('delete from feed where created_at < ?'),
    feed: db.prepare(`select f.kind, f.text, f.created_at from feed f left join player p on p.id = f.player_id
                      where p.id is null or p.sim is null
                         or not exists (select 1 from setting where key = 'simbots' and value = 'hide')
                      order by f.id desc limit ?`),
    reached: db.prepare('select league from league_reward where season_id = ? and player_id = ?'),
    reach: db.prepare('insert or ignore into league_reward (season_id, player_id, league, created_at) values (?, ?, ?, ?)'),
    gift: db.prepare(`insert into bonus (player_id, boxes, coins, skin, reason, ref, created_at)
                      values (?, ?, ?, null, 'league', ?, ?)`),
    promos: db.prepare('select league, created_at from league_reward where season_id = ? and player_id = ? order by created_at'),
    passed: db.prepare(`select * from player where sim is null and tg_id is not null and banned_at is null and remind = 1
                          and id != $me and id != $skip and rating >= $before and rating < $after
                        order by rating desc limit ${RIVALS_PER_WIN}`),
    pinged: db.prepare("select count(*) as n from friend_ping where kind = 'rival' and to_id = ? and day = ?"),
    ping: db.prepare("insert into friend_ping (kind, from_id, to_id, day, created_at) values ('rival', ?, ?, ?, ?)"),
  };

  function post(kind, playerId, text) {
    const t = now();
    q.feedAdd.run(kind, playerId, text, t);
    if (Math.random() < 0.05) q.feedPrune.run(t - FEED_KEEP);
  }

  /** Лиги, в которых игрок впервые за сезон: подарки и строки в ленту. */
  function promote(p, before, after) {
    const from = LEAGUES.indexOf(leagueOf(before)), to = LEAGUES.indexOf(leagueOf(after));
    if (to <= from) return [];
    const season = seasons.current().id;
    const had = new Set(q.reached.all(season, p.id).map((r) => r.league));
    const got = [];
    for (let i = from + 1; i <= to; i++) {
      const l = LEAGUES[i];
      if (had.has(l.id)) continue;
      // Уже бывал выше в этом сезоне — за ступени ниже не даём
      if (LEAGUES.slice(i + 1).some((x) => had.has(x.id))) continue;
      q.reach.run(season, p.id, l.id, now());
      const g = LEAGUE_GIFTS[l.id];
      if (!p.sim && g && (g.boxes || g.coins)) q.gift.run(p.id, g.boxes, g.coins, `${season}:${l.id}`, now());
      got.push(l);
    }
    if (got.length) post('league', p.id, `⬆️ ${p.name} поднялся в ${got.at(-1).name}`);
    return got;
  }

  /**
   * Бой засчитан: winnerId поднялся с before до after (delta — сколько).
   * Лента и лиги — сразу; сообщения соперникам — не дожидаясь.
   */
  function onRated({ winnerId, loserId, before, after, delta = null }) {
    try {
      const w = players.byId(winnerId), l = loserId ? players.byId(loserId) : null;
      if (!w) return;
      const d = delta ?? (after - before);
      if (l) post('win', w.id, `⚔️ ${w.name} победил ${l.name}${d > 0 ? ` (+${d})` : ''}`);
      if (STREAKS.has(w.streak)) post('streak', w.id, `🔥 ${w.name} — ${w.streak} побед подряд`);
      promote(w, before, after);
      rivals(w, loserId, before, after).catch((e) => log.warn?.('[social]', e.message));
    } catch (e) { log.warn?.('[social]', e.message); }
  }

  /** Обогнал людей в общем рейтинге — им бот: «верни место». */
  async function rivals(w, loserId, before, after) {
    if (!(after > before)) return 0;
    const h = analytics.hourOf();
    if (h < DAY_FROM || h >= DAY_TO) return 0;
    const day = analytics.dayOf();
    const due = [];
    for (const p of q.passed.all({ me: w.id, skip: loserId ?? '', before, after })) {
      if (friends?.isFriend?.(w.id, p.id)) continue;
      if (q.pinged.get(p.id, day).n > 0) continue;
      q.ping.run(w.id, p.id, day, now());
      due.push(p);
    }
    let sent = 0;
    for (const p of due) {
      const ok = await notify(p.id, `📈 ${w.name} обогнал тебя в рейтинге: ${after} против твоих ${p.rating}.\n`
        + 'Верни место — вызови на дуэль.\n\n/mute — не писать', { button: '⚔️ Вызвать', params: `?rival=${w.id}` })
        .catch(() => null);
      if (ok) sent++;
    }
    return sent;
  }

  /** Лента для главного: свежие события, новые сверху. */
  function feed(limit = 12) {
    return q.feed.all(Math.max(1, Math.min(30, limit))).map((r) => ({ kind: r.kind, text: r.text, at: r.created_at }));
  }

  /** Лиги игрока в этом сезоне с подарками — игра празднует те, что не видела. */
  function promos(meId) {
    const season = seasons.current().id;
    return q.promos.all(season, meId).map((r) => ({
      season, league: r.league, name: LEAGUES.find((l) => l.id === r.league)?.name ?? r.league,
      ...(LEAGUE_GIFTS[r.league] ?? { coins: 0, boxes: 0 }), at: r.created_at,
    }));
  }

  return { onRated, feed, promos, post };
}
