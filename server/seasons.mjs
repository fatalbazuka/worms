/**
 * Сезоны рейтинга: две недели, потом награды и мягкий сброс.
 *
 * Сезон кончается в понедельник в 00:00 по поясу бота. Первый — тот, что
 * завёлся при запуске: до первого понедельника, до которого не меньше
 * недели; дальше — ровно по SEASON_DAYS. В конце сезона:
 *
 *   — все, кто сыграл за сезон хотя бы MIN_GAMES партий на рейтинг
 *     (дуэли и бои по сети; боты тоже), выстраиваются по рейтингу;
 *   — людям — награда: по лиге (монеты и коробки) и за место (коробки,
 *     монеты, титул «Чемпион сезона N» и т. п.). Награда ложится подарком
 *     (таблица bonus — как подарки из админки): игра заберёт её сама, а
 *     бот напишет итог;
 *   — рейтинг всех, кто играл, сжимается к 1000 вдвое: 1300 → 1150,
 *     800 → 900. Новичок догоняет, но верх остаётся верхом.
 *
 * Лиги — те же, что в игре (src/platform/league.js); их границы здесь
 * повторены, потому что сервер собирается без кода игры.
 */
import { tx } from './db.mjs';

export const SEASON_DAYS = 14;
export const MIN_GAMES = 3;
/** Во сколько раз сжимается расстояние до 1000 в конце сезона. */
export const RESET = 0.5;

export const LEAGUES = [
  { id: 'wood', name: 'Дерево', min: 0, coins: 50, boxes: 0 },
  { id: 'iron', name: 'Железо', min: 850, coins: 50, boxes: 0 },
  { id: 'bronze', name: 'Бронза', min: 950, coins: 100, boxes: 0 },
  { id: 'silver', name: 'Серебро', min: 1100, coins: 100, boxes: 1 },
  { id: 'gold', name: 'Золото', min: 1250, coins: 150, boxes: 2 },
  { id: 'ruby', name: 'Рубин', min: 1400, coins: 200, boxes: 3 },
  { id: 'legend', name: 'Легенда', min: 1600, coins: 300, boxes: 4 },
];

/** Награда за место — сверх награды лиги. */
export const PLACES = [
  { from: 1, to: 1, boxes: 3, coins: 500, title: '🏆 Чемпион сезона' },
  { from: 2, to: 2, boxes: 2, coins: 300, title: '🥈 Призёр сезона' },
  { from: 3, to: 3, boxes: 2, coins: 300, title: '🥉 Призёр сезона' },
  { from: 4, to: 10, boxes: 1, coins: 100, title: '⭐ Топ-10 сезона' },
];

export function leagueOf(rating) {
  let found = LEAGUES[0];
  for (const l of LEAGUES) if (rating >= l.min) found = l;
  return found;
}

/** Награда игроку за место rank с рейтингом rating в сезоне n. */
export function rewardFor(rank, rating, n) {
  const l = leagueOf(rating);
  const p = PLACES.find((x) => rank >= x.from && rank <= x.to);
  return {
    league: l.id, leagueName: l.name,
    boxes: l.boxes + (p?.boxes ?? 0),
    coins: l.coins + (p?.coins ?? 0),
    title: p ? `${p.title} ${n}` : null,
  };
}

export function createSeasons({ db, notify = async () => null, post = () => {}, tz = 'Europe/Moscow', now = () => Date.now(), log = console }) {
  const q = {
    current: db.prepare('select * from season where finished_at is null order by id desc limit 1'),
    last: db.prepare('select * from season where finished_at is not null order by id desc limit 1'),
    add: db.prepare('insert into season (starts_at, ends_at) values (?, ?)'),
    done: db.prepare('update season set finished_at = ? where id = ? and finished_at is null'),
    ranked: db.prepare(`select * from player where season_games >= ? and banned_at is null
                        order by rating desc, wins desc, created_at asc`),
    result: db.prepare(`insert or ignore into season_result (season_id, player_id, rank, rating, league, boxes, coins, title)
                        values (?, ?, ?, ?, ?, ?, ?, ?)`),
    gift: db.prepare(`insert into bonus (player_id, boxes, coins, skin, reason, ref, created_at)
                      values (?, ?, ?, null, 'season', ?, ?)`),
    titles: db.prepare('update player set titles = ? where id = ?'),
    reset: db.prepare(`update player set rating = cast(round(1000 + (rating - 1000) * ?) as integer), season_games = 0
                       where wins + losses > 0`),
    resetGames: db.prepare('update player set season_games = 0'),
    myResult: db.prepare('select * from season_result where player_id = ? order by season_id desc limit 1'),
    me: db.prepare('select season_games, rating from player where id = ?'),
    above: db.prepare(`select count(*) as n from player where season_games >= ? and banned_at is null and rating > ?
                         and (sim is null or not exists (select 1 from setting where key = 'simbots' and value = 'hide'))`),
  };

  // ------------------------------------------------------------ время

  function parts(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
  }

  /** Полночь дня y-m-d в поясе бота, мс. */
  function midnight(y, m, d) {
    const guess = Date.UTC(y, m - 1, d);
    const p = parts(guess);
    return guess - (Date.UTC(p.y, p.m - 1, p.d, p.h) - guess);
  }

  /** Ближайший понедельник 00:00 не раньше, чем через minDays дней. */
  function mondayAfter(ms, minDays) {
    const p = parts(ms + minDays * 86400_000);
    const ahead = (8 - p.wd) % 7 || 7;
    return midnight(p.y, p.m, p.d + ahead);
  }

  // ------------------------------------------------------------ сезоны

  /** Идущий сезон; нет — заводим (первый — до понедельника через неделю с лишним). */
  function current() {
    const s = q.current.get();
    if (s) return s;
    const t = now();
    const prev = q.last.get();
    const start = prev ? prev.ends_at : t;
    const end = prev ? start + SEASON_DAYS * 86400_000 : mondayAfter(t, 7);
    const id = q.add.run(start, end).lastInsertRowid;
    if (!prev) q.resetGames.run();
    return { id: Number(id), starts_at: start, ends_at: end, finished_at: null };
  }

  /**
   * Закрыть сезон: места, награды, титулы, сброс рейтинга. Всё — одной
   * транзакцией; сообщения — после неё.
   * @returns {{season:number, rewarded:number}|null}
   */
  function finish(s) {
    const t = now();
    const prizes = [];
    const ok = tx(db, () => {
      if (q.done.run(t, s.id).changes === 0) return false;
      q.ranked.all(MIN_GAMES).forEach((p, i) => {
        const rank = i + 1;
        if (p.sim) return;                           // боты (server/simbots.mjs) места занимают, награды — нет
        const r = rewardFor(rank, p.rating, s.id);
        q.result.run(s.id, p.id, rank, p.rating, r.league, r.boxes, r.coins, r.title);
        if (r.boxes || r.coins) q.gift.run(p.id, r.boxes, r.coins, String(s.id), t);
        if (r.title) {
          let titles = [];
          try { titles = JSON.parse(p.titles || '[]'); } catch { titles = []; }
          titles.unshift({ title: r.title, at: t });
          q.titles.run(JSON.stringify(titles.slice(0, 20)), p.id);
        }
        if (p.tg_id) prizes.push({ id: p.id, rank, ...r });
        if (rank === 1) post('season', p.id, `🏆 ${p.name} — чемпион сезона ${s.id}`);
      });
      q.reset.run(RESET);
      return true;
    });
    if (!ok) return null;
    log.info?.(`[seasons] сезон ${s.id} окончен, наград: ${prizes.length}`);
    // Бот пишет каждому итог — по очереди, без спешки
    (async () => {
      for (const p of prizes) {
        const gift = [p.boxes ? `🎁 ×${p.boxes}` : '', p.coins ? `+${p.coins} монет` : ''].filter(Boolean).join(', ');
        const text = `🏁 Сезон ${s.id} окончен!\nТвоё место: ${p.rank} · лига ${p.leagueName}.`
          + `${p.title ? `\nТитул: ${p.title}` : ''}${gift ? `\nНаграда: ${gift} — уже в игре.` : ''}`
          + '\n\nНовый сезон начался: рейтинг сжат к 1000 — самое время рвануть наверх.';
        await notify(p.id, text, { button: '🏆 Открыть рейтинг', params: '?top=1' }).catch(() => null);
      }
    })();
    return { season: s.id, rewarded: prizes.length };
  }

  /** Раз в полминуты: сезон кончился — закрываем и заводим следующий. */
  function tick() {
    const s = current();
    if (now() < s.ends_at) return null;
    const r = finish(s);
    current();
    return r;
  }

  /** Для игры: идущий сезон, награды, где игрок сейчас и чем кончился прошлый. */
  function info(meId = null) {
    const s = current();
    const out = {
      n: s.id, startsAt: s.starts_at, endsAt: s.ends_at, minGames: MIN_GAMES,
      leagues: LEAGUES.map(({ id, name, min, coins, boxes }) => ({ id, name, min, coins, boxes })),
      places: PLACES,
    };
    if (meId) {
      const me = q.me.get(meId);
      if (me) {
        const eligible = me.season_games >= MIN_GAMES;
        out.me = { games: me.season_games, eligible, rank: eligible ? q.above.get(MIN_GAMES, me.rating).n + 1 : null };
      }
      const last = q.myResult.get(meId);
      if (last) {
        out.last = { n: last.season_id, rank: last.rank, rating: last.rating, league: last.league,
          boxes: last.boxes, coins: last.coins, title: last.title };
      }
    }
    return out;
  }

  /** Сводка для админа. */
  function report() {
    const s = current();
    const left = Math.max(0, s.ends_at - now());
    const d = Math.floor(left / 86400_000), h = Math.floor((left % 86400_000) / 3600_000);
    const n = q.ranked.all(MIN_GAMES).length;
    return `Сезон ${s.id}: до конца ${d} д ${h} ч, в зачёте (≥${MIN_GAMES} партий): ${n}.\n/season end — закрыть сейчас`;
  }

  return { current, tick, finish: () => finish(current()), info, report };
}
