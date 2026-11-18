/**
 * Статистика и напоминания.
 *
 * Игра присылает два вида событий (POST /api/event):
 *   open   — открыл игру; в props.streak — серия дней на этот момент;
 *   battle — доиграл бой: режим, победа, ходов.
 * Этого хватает, чтобы ответить на главные вопросы: сколько людей заходит,
 * сколько новых, сколько боёв, возвращаются ли на следующий день. Отчёт —
 * команда бота /metrics, только админу.
 *
 * Напоминание. Вечером (REMIND_HOUR по часовому поясу бота) бот пишет тем,
 * кто вчера заходил, а сегодня ещё нет: серия сгорит в полночь. Не чаще
 * раза в день, только с серией и только тем, кто не отписался (/mute).
 * Больше бот сам ничего не пишет: «твой ход» и прочий шум — нет.
 *
 * День — строка YYYY-MM-DD в поясе бота: «сегодня» у сервера и в отчёте
 * одно и то же для всех игроков.
 */

export const REMIND_HOUR = 19;
const EVENTS_PER_DAY = 300;           // больше от одного игрока за сутки не пишем
const MODES = new Set(['quick', 'campaign', 'challenge', 'online', 'fallback', 'hotseat']);

export function createAnalytics({ db, now = () => Date.now(), tz = 'Europe/Moscow' }) {
  const q = {
    add: db.prepare('insert into event (player_id, day, name, props, created_at) values (?, ?, ?, ?, ?)'),
    countToday: db.prepare('select count(*) as n from event where player_id = ? and day = ?'),
    streak: db.prepare('update player set last_streak = ? where id = ?'),
    active: db.prepare('select count(distinct player_id) as n from event where day = ?'),
    activeRange: db.prepare('select count(distinct player_id) as n from event where day >= ? and day <= ?'),
    battles: db.prepare(`select json_extract(props, '$.mode') as mode, count(*) as n,
                         sum(json_extract(props, '$.won')) as wins
                         from event where day = ? and name = 'battle' group by mode`),
    newPlayers: db.prepare('select id from player where created_at >= ? and created_at < ?'),
    seenOn: db.prepare('select 1 from event where player_id = ? and day = ? limit 1'),
    due: db.prepare(`
      select p.* from player p
      where p.tg_id is not null and p.remind = 1 and coalesce(p.reminded_day, '') != ?
        and p.last_streak >= 1
        and exists (select 1 from event e where e.player_id = p.id and e.day = ?)
        and not exists (select 1 from event e where e.player_id = p.id and e.day = ?)
      limit 200`),
    reminded: db.prepare('update player set reminded_day = ? where id = ?'),
    remindedCount: db.prepare('select count(*) as n from player where reminded_day = ?'),
    mute: db.prepare('update player set remind = ? where id = ?'),
  };

  /** Части даты в поясе бота. */
  function parts(ms) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  }

  function dayOf(ms = now()) {
    const p = parts(ms);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function shiftDay(day, delta) {
    const [y, m, d] = day.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + delta));
    return t.toISOString().slice(0, 10);
  }

  /** Начало дня day в поясе бота, мс. */
  function dayStart(day) {
    const [y, m, d] = day.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    const p = parts(guess);
    // Сколько часов пояс опережает UTC в полночь этого дня
    const shift = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour) - guess) / 3600_000;
    return guess - shift * 3600_000;
  }

  /** Почистить то, что прислал клиент: только известные поля и типы. */
  function clean(name, props) {
    const p = props && typeof props === 'object' ? props : {};
    const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
    if (name === 'open' || name === 'streak') return { streak: int(p.streak, 10000) };
    if (name === 'battle') {
      return { mode: MODES.has(p.mode) ? p.mode : 'quick', won: p.won ? 1 : 0, turns: int(p.turns, 1000) };
    }
    return null;
  }

  /** Записать событие игрока. @returns {boolean} принято ли */
  function record(player, name, props) {
    const data = clean(String(name ?? ''), props);
    if (!data) return false;
    const day = dayOf();
    if (q.countToday.get(player.id, day).n >= EVENTS_PER_DAY) return false;
    q.add.run(player.id, day, name === 'streak' ? 'open' : name, JSON.stringify(data), now());
    if ('streak' in data) q.streak.run(data.streak, player.id);
    return true;
  }

  /** Отчёт для админа: сегодня, вчера, неделя, возврат новичков. */
  function report() {
    const today = dayOf();
    const yesterday = shiftDay(today, -1);
    const day = (d) => {
      const rows = q.battles.all(d);
      const total = rows.reduce((a, r) => a + r.n, 0);
      const fresh = q.newPlayers.all(dayStart(d), dayStart(shiftDay(d, 1)));
      return { active: q.active.get(d).n, fresh, total, rows };
    };
    const t = day(today);
    const y = day(yesterday);
    const week = q.activeRange.get(shiftDay(today, -6), today).n;
    const back = y.fresh.filter((p) => q.seenOn.get(p.id, today)).length;
    const names = {
      quick: 'с ботом', campaign: 'кампания', challenge: 'испытания', online: 'по сети',
      fallback: 'бот вместо соперника', hotseat: 'вдвоём',
    };
    const modes = t.rows.length
      ? t.rows.map((r) => `${names[r.mode] ?? r.mode} ${r.n}`).join(' · ')
      : 'пока ни одного';
    const pct = (a, b) => (b ? ` (${Math.round((a / b) * 100)}%)` : '');
    return [
      `📊 Сегодня (${today}): игроков ${t.active} · новых ${t.fresh.length} · боёв ${t.total}`,
      `Вчера: игроков ${y.active} · новых ${y.fresh.length} · боёв ${y.total}`,
      `За 7 дней: игроков ${week}`,
      `Вчерашние новички вернулись сегодня: ${back} из ${y.fresh.length}${pct(back, y.fresh.length)}`,
      `Бои сегодня: ${modes}`,
      `Напоминаний о серии сегодня: ${q.remindedCount.get(today).n}`,
    ].join('\n');
  }

  /**
   * Кому пора напомнить о серии. Пусто до REMIND_HOUR и после 23:00 —
   * ночью не пишем.
   */
  function remindDue() {
    const hour = Number(parts(now()).hour);
    if (hour < REMIND_HOUR || hour >= 23) return [];
    const today = dayOf();
    return q.due.all(today, shiftDay(today, -1), today);
  }

  function markReminded(playerId) { q.reminded.run(dayOf(), playerId); }
  function setRemind(playerId, on) { q.mute.run(on ? 1 : 0, playerId); }

  return { record, report, remindDue, markReminded, setRemind, dayOf };
}
