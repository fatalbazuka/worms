/**
 * Статистика и напоминания.
 *
 * Игра присылает три вида событий (POST /api/event):
 *   open   — открыл игру; в props.streak — серия дней на этот момент;
 *   battle — доиграл бой: режим, победа, ходов;
 *   step   — шаг воронки (STEPS): первый выстрел, первый трос, первая
 *            победа, обучение пройдено, магазин открыт, «купить», «позвать»,
 *            уровни игрока 2, 5, 10 и 20.
 * Этого хватает, чтобы ответить на главные вопросы: сколько людей заходит,
 * сколько новых, сколько боёв, где новички отваливаются, возвращаются ли
 * через день, три и семь. Отчёт — команда бота /metrics, только админу.
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
const MODES = new Set(['quick', 'campaign', 'ascent', 'daily', 'challenge', 'online', 'fallback', 'hotseat']);

/** Шаги воронки и их подписи в отчёте — по порядку, как их проходит новичок. */
export const STEPS = {
  first_shot: 'выстрелил', first_hook: 'пустил трос', tutorial_done: 'прошёл обучение',
  first_win: 'победил', shop_open: 'открыл магазин', buy_click: 'нажал «купить»',
  invite: 'позвал друга', story: 'выложил сторис', clip: 'сохранил клип',
  level_2: 'уровень 2', level_5: 'уровень 5', level_10: 'уровень 10', level_20: 'уровень 20',
};

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
    steps: db.prepare(`select json_extract(props, '$.step') as step, count(distinct player_id) as n
                       from event where day = ? and name = 'step' group by step`),
    stepsOf: db.prepare(`select count(distinct player_id) as n from event
                         where name = 'step' and json_extract(props, '$.step') = ?
                           and player_id in (select id from player where created_at >= ? and created_at < ?)`),
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
    if (name === 'step') return Object.hasOwn(STEPS, p.step) ? { step: p.step } : null;
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
    // Возврат через 3 и 7 дней: пришли тогда — заходили сегодня
    const backOn = (n) => {
      const d = shiftDay(today, -n);
      const fresh = q.newPlayers.all(dayStart(d), dayStart(shiftDay(d, 1)));
      return { all: fresh.length, back: fresh.filter((p) => q.seenOn.get(p.id, today)).length };
    };
    const d3 = backOn(3), d7 = backOn(7);
    // Воронка новичков за 7 дней: из пришедших — сколько дошли до каждого шага
    const weekFrom = dayStart(shiftDay(today, -6)), weekTo = dayStart(shiftDay(today, 1));
    const weekFresh = q.newPlayers.all(weekFrom, weekTo).length;
    const funnel = Object.entries(STEPS)
      .map(([id, label]) => `${label} ${q.stepsOf.get(id, weekFrom, weekTo).n}`).join(' · ');
    const todaySteps = Object.fromEntries(q.steps.all(today).map((r) => [r.step, r.n]));
    const names = {
      quick: 'с ботом', campaign: 'классика', ascent: 'подъём', daily: 'башня дня', challenge: 'испытания', online: 'по сети',
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
      `Через 3 дня: ${d3.back} из ${d3.all}${pct(d3.back, d3.all)} · через 7: ${d7.back} из ${d7.all}${pct(d7.back, d7.all)}`,
      `Новички за 7 дней (${weekFresh}): ${funnel}`,
      `Сегодня: магазин ${todaySteps.shop_open ?? 0} · «купить» ${todaySteps.buy_click ?? 0} · позвали ${todaySteps.invite ?? 0}`,
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

  /**
   * То же, что report, но данными — для графиков админки: по дням за days
   * дней (игроки, новички, бои по режимам), возврат через 1/3/7 дней и
   * воронка новичков за неделю.
   */
  function stats(days = 14) {
    const today = dayOf();
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = shiftDay(today, -i);
      const rows = q.battles.all(d);
      series.push({
        day: d,
        active: q.active.get(d).n,
        fresh: q.newPlayers.all(dayStart(d), dayStart(shiftDay(d, 1))).length,
        battles: rows.reduce((a, r) => a + r.n, 0),
        modes: Object.fromEntries(rows.map((r) => [r.mode ?? '?', r.n])),
      });
    }
    const backOn = (n) => {
      const d = shiftDay(today, -n);
      const fresh = q.newPlayers.all(dayStart(d), dayStart(shiftDay(d, 1)));
      return { all: fresh.length, back: fresh.filter((p) => q.seenOn.get(p.id, today)).length };
    };
    const from = dayStart(shiftDay(today, -6)), to = dayStart(shiftDay(today, 1));
    return {
      today,
      series,
      week: q.activeRange.get(shiftDay(today, -6), today).n,
      retention: { d1: backOn(1), d3: backOn(3), d7: backOn(7) },
      funnel: {
        fresh: q.newPlayers.all(from, to).length,
        steps: Object.entries(STEPS).map(([id, label]) => ({ id, label, n: q.stepsOf.get(id, from, to).n })),
      },
    };
  }

  return { record, report, stats, remindDue, markReminded, setRemind, dayOf };
}
