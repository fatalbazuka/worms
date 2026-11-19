/**
 * «Турнир недели»: бесплатный турнир, который сервер заводит сам.
 *
 * С понедельника идёт запись, старт — в субботу в 19:00 по поясу бота.
 * Создаётся один раз за неделю: если турнир недели с этой недели уже есть
 * (в любом статусе), второй не появится, — так же и после перезапуска.
 * Сразу после создания бот один раз зовёт тех, кто не отписался от
 * напоминаний (/mute). Чемпиону сверх обычного (титул, +25 к рейтингу) —
 * коробки со скинами.
 */
export const WEEKLY_PREFIX = 'Турнир недели';
export const WEEKLY_SIZE = 16;
export const WEEKLY_BOXES = 3;
const START_DAY = 6;      // суббота (0 — воскресенье)
const START_HOUR = 19;

export function createWeekly({ db, tournaments, shop, notify = async () => null, tz = 'Europe/Moscow', now = () => Date.now(), log = console }) {
  const q = {
    since: db.prepare('select id from tournament where name like ? and created_at >= ? limit 1'),
    recipients: db.prepare(`select id from player
                            where tg_id is not null and banned_at is null and remind = 1`),
  };

  /** Части даты в поясе бота. */
  function parts(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd };
  }

  /** Момент «день y-m-d, час h» в поясе бота, мс. */
  function at(y, m, d, h) {
    const guess = Date.UTC(y, m - 1, d, h);
    const p = parts(guess);
    const shift = Date.UTC(p.y, p.m - 1, p.d, p.h) - guess;
    return guess - shift;
  }

  /** Начало недели (понедельник 00:00) и старт турнира этой недели. */
  function week(ms = now()) {
    const p = parts(ms);
    const back = (p.wd + 6) % 7;                   // сколько дней назад был понедельник
    const mon = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
    const start = new Date(Date.UTC(p.y, p.m - 1, p.d - back + (START_DAY + 6) % 7));
    return {
      from: at(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate(), 0),
      startsAt: at(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), START_HOUR),
      label: `${String(start.getUTCDate()).padStart(2, '0')}.${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    };
  }

  let announcing = false;
  async function announce(t) {
    if (announcing) return 0;
    announcing = true;
    let sent = 0;
    try {
      const text = `🏆 ${t.name}: запись открыта!\n`
        + `Старт в субботу в ${START_HOUR}:00 (МСК), ${WEEKLY_SIZE} мест, бесплатно.\n`
        + `Чемпиону — титул, +25 к рейтингу и ${WEEKLY_BOXES} коробки со скинами.\n\n/mute — не присылать такое`;
      for (const r of q.recipients.all()) {
        try {
          if (await notify(r.id, text, { tour: t.id })) sent++;
        } catch {
          break;   // база закрыта (остановка сервера) — дорассылать некуда
        }
        await new Promise((res) => setTimeout(res, 40));   // Telegram: не больше ~30 в секунду
      }
    } finally {
      announcing = false;
    }
    return sent;
  }

  /** Раз в полминуты: пора ли завести турнир этой недели. @returns созданный или null */
  function tick() {
    const w = week();
    // После старта этой недели заводить поздно — ждём понедельника
    if (now() >= w.startsAt) return null;
    if (q.since.get(`${WEEKLY_PREFIX}%`, w.from)) return null;
    const t = tournaments.create({ name: `${WEEKLY_PREFIX} · ${w.label}`, size: WEEKLY_SIZE, fee: 0, startsAt: w.startsAt });
    log.log?.(`[weekly] заведён «${t.name}», старт ${new Date(w.startsAt).toISOString()}`);
    announce(t).catch((e) => log.error?.('[weekly] анонс', e));
    return t;
  }

  /** Турнир кончился: чемпиону турнира недели — коробки. */
  function onFinish(t, winnerId) {
    if (!winnerId || !String(t?.name ?? '').startsWith(WEEKLY_PREFIX)) return;
    shop.gift(winnerId, { boxes: WEEKLY_BOXES, note: t.name });
  }

  return { tick, onFinish, week };
}
