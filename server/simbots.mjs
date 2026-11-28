/**
 * Игроки-боты: временное оживление, пока живых игроков мало.
 *
 * Двенадцать аккаунтов (player.sim = weak | mid | strong, по четыре) — с
 * именами, скинами и рейтингом, как у людей. Каждый играет 3–4 партии в
 * день, днём (с 9 до 23 по поясу бота), равномерно по дню:
 *
 *   — между собой: партия не разыгрывается, считается только итог — по
 *     силе уровня и рейтингу, как обычная дуэль (Эло, победы, серии);
 *   — с людьми: бот вызывает на дуэль новичка или того, у кого нет ни одной
 *     идущей дуэли, не чаще раза в сутки на человека. Слабый бот — новичку,
 *     иначе — ближайший по рейтингу. Дальше это обычная дуэль на рейтинг
 *     (server/duels.mjs): ход бота наступает через несколько минут, и его
 *     разыгрывает у себя игра соперника — тем же ИИ, что в бою с ботом.
 *
 * Выключатель — команда /simbots у админа: off — боты больше не играют и не
 * вызывают (идущие дуэли доигрываются), hide — ещё и прячутся из таблицы.
 */
import { createHash } from 'node:crypto';
import { settle } from './lib/elo.js';
import { SKIN_IDS } from './shop.mjs';

/** Сила уровня для партий бот-бот и уровень ИИ в игре (src/ai/Bot.js). */
export const SIM_LEVELS = {
  weak: { strength: 0.6, ai: 'rookie' },
  mid: { strength: 1.0, ai: 'fighter' },
  strong: { strength: 1.6, ai: 'sniper' },
};

// Десять русских имён и два дагестанских
const ROSTER = [
  ['Дима', 'weak'], ['Kirill_99', 'weak'], ['Тёма', 'weak'], ['Саня_77', 'weak'],
  ['Никита 🔥', 'mid'], ['Серый', 'mid'], ['Рамазан', 'mid'], ['Лёха', 'mid'],
  ['Артём К.', 'strong'], ['Вова', 'strong'], ['Магомед', 'strong'], ['Egor_Pro', 'strong'],
];
const START = {
  weak: { rating: [930, 990], wins: [3, 8], losses: [5, 10] },
  mid: { rating: [1030, 1090], wins: [8, 15], losses: [6, 12] },
  strong: { rating: [1150, 1240], wins: [15, 25], losses: [5, 10] },
};

const PLAY_FROM = 9, PLAY_TO = 23;
/** Доля партий-вызовов людям среди партий бота. */
const HUMAN_SHARE = 0.4;
/** Не больше стольких вызовов людям в день на всех ботов. */
const HUMANS_PER_DAY = 40;
/** Вызванный человек снова может получить вызов от бота через столько. */
const CHALLENGE_GAP = 24 * 3600_000;
/** Кого вызывать: заходил в игру за последние столько. */
const ACTIVE_MS = 3 * 86400_000;
const TICK_MS = 30_000;

export function createSimBots({ db, players, duels, analytics, social = null, now = () => Date.now(), log = console, random = Math.random }) {
  const q = {
    bots: db.prepare('select * from player where sim is not null and banned_at is null'),
    count: db.prepare('select count(*) as n from player where sim is not null'),
    add: db.prepare(`insert into player (id, name, name_key, pass_hash, tg_id, rating, wins, losses, best_streak, created_at, seen_at, app_at, sim)
                     values (?, ?, null, null, null, ?, ?, ?, ?, ?, ?, ?, ?)`),
    skin: db.prepare(`insert or replace into save_kv (player_id, key, value, updated_at) values (?, 'worms.skins.v1', ?, ?)`),
    day: db.prepare('update player set sim_day = ?, sim_games = 0 where id = ?'),
    played: db.prepare('update player set sim_games = sim_games + 1, seen_at = ? where id = ?'),
    setting: db.prepare('select value from setting where key = ?'),
    setSetting: db.prepare('insert or replace into setting (key, value) values (?, ?)'),
    humans: db.prepare(`select p.* from player p
      where p.sim is null and p.tg_id is not null and p.banned_at is null and p.remind = 1
        and p.app_at is not null and p.seen_at > $active
        and not exists (select 1 from duel d where (d.p1 = p.id or d.p2 = p.id) and d.status in ('open', 'active'))
        and not exists (select 1 from sim_challenge c where c.player_id = p.id and c.at > $gap)
      order by random() limit 20`),
    challenged: db.prepare('insert or replace into sim_challenge (player_id, at) values (?, ?)'),
    challengesToday: db.prepare('select count(*) as n from sim_challenge where at >= ?'),
  };

  const mode = () => q.setting.get('simbots')?.value ?? 'on';
  const enabled = () => mode() === 'on';

  /** Сколько партий бот сыграет сегодня: 3 или 4, у каждого своё, от дня. */
  function quota(id, day) {
    const h = createHash('sha1').update(`${id}:${day}`).digest();
    return 3 + (h[0] % 2);
  }

  const between = ([a, b]) => Math.round(a + random() * (b - a));

  /** Завести ботов, если их ещё нет. @returns {number} сколько заведено */
  function ensure() {
    if (q.count.get().n > 0) return 0;
    const t = now();
    const skins = SKIN_IDS.filter((s) => s !== 'classic');
    ROSTER.forEach(([name, level], i) => {
      const st = START[level];
      const id = `u${createHash('sha1').update(`sim:${name}:${t}`).digest('hex').slice(0, 12)}`;
      // Аккаунт «завёлся» несколько недель назад, заходил недавно
      const created = t - between([10, 40]) * 86400_000;
      const wins = between(st.wins);
      q.add.run(id, name, between(st.rating), wins, between(st.losses), Math.min(wins, between([2, 6])),
        created, t - between([1, 30]) * 60_000, created, level);
      // Скин: у кого-то обычный смайлик, у остальных — разные
      const skin = i % 5 === 0 || !skins.length ? 'classic' : skins[(i * 7 + between([0, skins.length - 1])) % skins.length];
      q.skin.run(id, JSON.stringify({ owned: [skin], equipped: skin, boxes: 0 }), t);
    });
    log.info?.(`[simbots] заведено ботов: ${ROSTER.length}`);
    return ROSTER.length;
  }

  /** Итог партии двух ботов: по силе уровня, с поправкой на рейтинг. */
  function playBots(a, b) {
    const sa = SIM_LEVELS[a.sim]?.strength ?? 1, sb = SIM_LEVELS[b.sim]?.strength ?? 1;
    const byLevel = sa / (sa + sb);
    const byRating = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    const p = 0.7 * byLevel + 0.3 * byRating;
    const [w, l] = random() < p ? [a, b] : [b, a];
    const r = settle(w.rating, l.rating);
    players.rate(w.id, r.winner, l.id, r.loser);
    social?.onRated({ winnerId: w.id, loserId: l.id, before: w.rating, after: r.winner, delta: r.delta });
    const t = now();
    q.played.run(t, a.id);
    q.played.run(t, b.id);
    return { winner: w.id, loser: l.id, delta: r.delta };
  }

  /** Бот вызывает человека на дуэль. @returns {boolean} вызвал ли */
  function challengeHuman(bot, bots) {
    if (q.challengesToday.get(dayStartMs()).n >= HUMANS_PER_DAY) return false;
    const t = now();
    const list = q.humans.all({ active: t - ACTIVE_MS, gap: t - CHALLENGE_GAP });
    for (const h of list) {
      const newbie = h.wins + h.losses < 5;
      // Новичку — слабый бот; остальным — ближайший по рейтингу (этот или другой с запасом партий)
      const pool = bots.filter((b) => b.left > 0 && (!newbie || b.sim === 'weak'));
      if (!pool.length) continue;
      const pick = newbie ? (pool.find((b) => b.id === bot.id) ?? pool[0])
        : pool.reduce((best, b) => (Math.abs(b.rating - h.rating) < Math.abs(best.rating - h.rating) ? b : best));
      const r = duels.create(pick, { opponent: h.id, theyFirst: true });
      if (!r?.duel || r.existing) continue;
      q.challenged.run(h.id, t);
      q.played.run(t, pick.id);
      pick.left--;
      return true;
    }
    return false;
  }

  /** Начало текущего дня по поясу бота (пояс — с целым числом часов). */
  function dayStartMs() {
    const t = now();
    return t - analytics.hourOf(t) * 3600_000 - (t % 3600_000);
  }

  /**
   * Раз в полминуты: кому из ботов пора сыграть. Вероятность на такт —
   * оставшиеся партии на оставшиеся такты дня: партии ложатся равномерно.
   * @returns {{bots:number, humans:number}} сколько партий сыграно сейчас
   */
  function tick() {
    const out = { bots: 0, humans: 0 };
    if (!enabled()) return out;
    const hour = analytics.hourOf(now());
    if (hour < PLAY_FROM || hour >= PLAY_TO) return out;
    const day = analytics.dayOf(now());
    const bots = q.bots.all().map((b) => {
      if (b.sim_day !== day) { q.day.run(day, b.id); b.sim_games = 0; }
      return { ...b, left: quota(b.id, day) - (b.sim_day === day ? b.sim_games : 0) };
    });
    const minutesLeft = Math.max(1, (PLAY_TO - hour) * 60 - new Date(now()).getUTCMinutes());
    const ticksLeft = Math.max(1, (minutesLeft * 60_000) / TICK_MS);
    for (const bot of bots) {
      if (bot.left <= 0 || random() >= bot.left / ticksLeft) continue;
      try {
        if (random() < HUMAN_SHARE && challengeHuman(bot, bots)) { out.humans++; continue; }
        const foes = bots.filter((b) => b.id !== bot.id && b.left > 0);
        const foe = foes.length ? foes[Math.floor(random() * foes.length)] : bots.find((b) => b.id !== bot.id);
        if (!foe) continue;
        const r = playBots(bot, foe);
        // Рейтинг в памяти — для следующих партий этого такта
        for (const b of [bot, foe]) {
          b.left--;
          b.rating = players.byId(b.id)?.rating ?? b.rating;
        }
        if (r) out.bots++;
      } catch (e) { log.warn?.('[simbots]', e.message); }
    }
    return out;
  }

  /** Сводка для админа. */
  function report() {
    const list = q.bots.all();
    const lines = list.sort((a, b) => b.rating - a.rating)
      .map((b) => `${b.name} · ${b.sim} · ${b.rating} · ${b.wins}/${b.losses} · сегодня ${b.sim_games}`);
    return `Боты: ${mode()}\n${lines.join('\n') || 'нет'}\n\n/simbots on · off · hide`;
  }

  function setMode(m) {
    if (!['on', 'off', 'hide'].includes(m)) return false;
    q.setSetting.run('simbots', m);
    return true;
  }

  return { ensure, tick, report, setMode, mode, enabled, playBots, quota };
}
