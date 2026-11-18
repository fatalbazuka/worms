/**
 * «Башня дня»: одна башня на всех на сутки и таблица результатов.
 *
 * Башню строит игра сама — от зерна, которое выводится из даты (dailySeed;
 * то же правило в src/core/match.js). Сервер знает только день и хранит
 * лучшую попытку каждого игрока за этот день: победил ли, за сколько своих
 * ходов и сколько здоровья осталось у его бойцов.
 *
 * Место в таблице: сначала победы, среди победивших — меньше ходов, при
 * равных ходах — больше здоровья, при полном равенстве — кто раньше.
 * Переигрывать можно сколько угодно, в таблице остаётся лучшая попытка.
 *
 * Итог присылает клиент, сервер проверяет только, что числа в разумных
 * пределах: от подделки это не защищает, но награда здесь — место в
 * таблице, а не звёзды.
 */

const TOP = 20;
// Порядок мест: победы, у победивших — меньше ходов, потом больше здоровья, потом кто раньше
const ORDER = 'order by won desc, case when won = 1 then turns else 0 end asc, hp desc, created_at asc';

/** Зерно башни дня из строки YYYY-MM-DD. То же — dailySeed в src/core/match.js. */
export function dailySeed(day) {
  let h = 2166136261;
  for (const ch of `daily:${day}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 900000 + 100000;
}

/** Лучше ли попытка a, чем b (обе — {won, turns, hp}). */
export function betterRun(a, b) {
  if (!b) return true;
  if (a.won !== b.won) return a.won > b.won;
  if (!a.won) return a.hp > b.hp;
  if (a.turns !== b.turns) return a.turns < b.turns;
  return a.hp > b.hp;
}

export function createDailyTower({ db, players, dayOf, now = () => Date.now() }) {
  const q = {
    get: db.prepare('select * from daily_tower where day = ? and player_id = ?'),
    put: db.prepare(`insert into daily_tower (day, player_id, won, turns, hp, tries, created_at)
                     values (?, ?, ?, ?, ?, 1, ?)
                     on conflict (day, player_id) do update set
                       won = excluded.won, turns = excluded.turns, hp = excluded.hp,
                       tries = daily_tower.tries + 1, created_at = excluded.created_at`),
    try: db.prepare('update daily_tower set tries = tries + 1 where day = ? and player_id = ?'),
    top: db.prepare(`select d.*, p.name from daily_tower d join player p on p.id = d.player_id
                     where d.day = ?
                     ${ORDER.replace(/\b(won|turns|hp|created_at)\b/g, 'd.$1')}
                     limit ${TOP}`),
    count: db.prepare('select count(*) as n from daily_tower where day = ?'),
    place: db.prepare(`select place from (
                         select player_id, row_number() over (${ORDER}) as place
                         from daily_tower where day = ?) where player_id = ?`),
  };

  const row = (r) => ({ name: r.name, won: Boolean(r.won), turns: r.turns, hp: r.hp });

  /** Таблица дня и место игрока. */
  function board(player = null) {
    const day = dayOf();
    const top = q.top.all(day).map(row);
    let me = null;
    if (player) {
      const r = q.get.get(day, player.id);
      if (r) {
        const place = q.place.get(day, player.id).place;
        me = { place, won: Boolean(r.won), turns: r.turns, hp: r.hp, tries: r.tries };
      }
    }
    return { day, seed: dailySeed(day), top, me, players: q.count.get(day).n };
  }

  /**
   * Итог попытки. day — какой день игрок играл: в полночь попытка вчерашней
   * башни уже не засчитывается.
   */
  function submit(player, body) {
    const day = dayOf();
    if (String(body?.day ?? '') !== day) return { ...board(player), accepted: false };
    const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || 0)));
    const run = { won: body.won ? 1 : 0, turns: int(body.turns, 1, 200), hp: int(body.hp, 0, 1000) };
    const was = q.get.get(day, player.id);
    const better = betterRun(run, was);
    if (better) q.put.run(day, player.id, run.won, run.turns, run.hp, now());
    else q.try.run(day, player.id);
    return { ...board(player), accepted: better };
  }

  return { board, submit };
}
