/**
 * Друзья: топ среди своих и вызов на бой в одно касание.
 *
 * Своей таблицы дружбы нет — друзья выводятся из того, что уже есть:
 *   • кого игрок позвал по своей ссылке (player.referred_by = он);
 *   • кто позвал его самого (его referred_by);
 *   • с кем он доиграл бой на рейтинг (match, status = 'confirmed').
 * Дружба взаимная: если ты мой друг, то и я твой. Спорные и неоконченные
 * бои не в счёт — иначе другом становился бы любой, кто прислал отчёт.
 *
 * Бот пишет о друзьях двумя сообщениями, и оба — с ограничениями (журнал
 * friend_ping, день — в поясе бота, как у напоминаний о серии):
 *
 *   «друг тебя обогнал» — когда бой на рейтинг засчитан и победитель
 *   поднялся выше друга, который до боя был выше него. Пишем обогнанному,
 *   не чаще раза в день на пару, не больше OVERTAKE_PER_DAY таких сообщений
 *   одному игроку за день, только тем, кто играл на рейтинг, не отписался
 *   (/mute) и только днём (DAY_FROM–DAY_TO). Соперника по этому самому бою
 *   не трогаем: он и так видел, что проиграл. Отметка ставится до отправки
 *   — одна попытка, как у напоминаний.
 *
 *   «вызов на бой» — игрок нажал «Вызвать» у друга: бот пишет другу с
 *   кнопкой прямо в комнату. Только другу, только тому, кто не отписался,
 *   не чаще раза в DUEL_GAP на пару, DUEL_PAIR_PER_DAY в день на пару и
 *   DUEL_PER_DAY в день от одного игрока. Ночью сообщение приходит без
 *   звука. Не вышло (лимит, отписался, бот у друга заблокирован) — игра
 *   зовёт обычной карточкой через выбор чата.
 */
import { skinSql } from './players.mjs';
import { SKIN_IDS } from './shop.mjs';

export const FRIENDS_MAX = 100;          // столько друзей в списке, сам игрок — всегда
export const KNOWN_MAX = 30;            // знакомых (друзей друзей) в списке
export const OVERTAKE_PER_DAY = 3;
export const DUEL_GAP = 10 * 60_000;
export const DUEL_PAIR_PER_DAY = 3;
export const DUEL_PER_DAY = 20;
const DAY_FROM = 9, DAY_TO = 23;

/** Друзья игрока $me — общая часть запросов. */
const FRIENDS_CTE = `f(id) as (
    select id from player where referred_by = $me
    union select referred_by from player where id = $me and referred_by is not null
    union select p2 from match where p1 = $me and status = 'confirmed'
    union select p1 from match where p2 = $me and status = 'confirmed'
  )`;

export function createFriends({ db, players, analytics, notify, invite, now = () => Date.now(), log = console }) {
  const q = {
    // Место — среди друзей и самого игрока, как в общем топе: рейтинг,
    // победы, кто раньше пришёл. Показываем первых FRIENDS_MAX и себя
    list: db.prepare(`with ${FRIENDS_CTE},
      ranked as (
        select id, name, photo, rating, wins, losses, tourney_wins, seen_at,
               row_number() over (order by rating desc, wins desc, created_at asc) as place
        from player where (id in (select id from f) or id = $me) and banned_at is null
      )
      select ranked.*, ${skinSql('ranked.id')} as skin, (select count(*) from ranked) as total
      from ranked where place <= $max or id = $me order by place`),
    isFriend: db.prepare(`select (
         exists (select 1 from player where id = $b and referred_by = $a)
      or exists (select 1 from player where id = $a and referred_by = $b)
      or exists (select 1 from match where p1 = $a and p2 = $b and status = 'confirmed')
      or exists (select 1 from match where p1 = $b and p2 = $a and status = 'confirmed')) as yes`),
    // Знакомые: друзья твоих друзей, которые тебе ещё не друзья, — пришли
    // по той же ссылке, позвали друга, сыграли с ним. Самые недавние сверху.
    // Позвать их на дуэль можно без общего чата: бот напишет сам
    known: db.prepare(`with ${FRIENDS_CTE},
      ff(id, via) as (
        select p.id, p.referred_by from player p where p.referred_by in (select id from f)
        union select p.referred_by, p.id from player p where p.id in (select id from f) and p.referred_by is not null
        union select m.p2, m.p1 from match m where m.p1 in (select id from f) and m.status = 'confirmed'
        union select m.p1, m.p2 from match m where m.p2 in (select id from f) and m.status = 'confirmed'
      )
      select player.id, player.name, player.photo, player.rating, player.wins, player.losses, player.seen_at,
             ${skinSql('player.id')} as skin, min(via.name) as via
      from ff join player on player.id = ff.id join player via on via.id = ff.via
      where player.id != $me and player.id not in (select id from f) and player.banned_at is null
      group by player.id order by player.seen_at desc limit $max`),
    // Кого обогнал: друг был выше до боя и стал ниже после
    passed: db.prepare(`with ${FRIENDS_CTE}
      select id, name, rating from player
      where id in (select id from f) and id != $skip
        and rating > $before and rating < $after
        and tg_id is not null and remind = 1 and banned_at is null and wins + losses > 0`),
    pinged: db.prepare('select count(*) as n from friend_ping where kind = ? and to_id = ? and from_id = ? and day = ?'),
    pingedTo: db.prepare('select count(*) as n from friend_ping where kind = ? and to_id = ? and day = ?'),
    pingedFrom: db.prepare('select count(*) as n from friend_ping where kind = ? and from_id = ? and day = ?'),
    lastPing: db.prepare('select max(created_at) as at from friend_ping where kind = ? and to_id = ? and from_id = ?'),
    ping: db.prepare('insert into friend_ping (kind, from_id, to_id, day, created_at) values (?, ?, ?, ?, ?)'),
    unping: db.prepare('delete from friend_ping where id = ?'),
  };

  const isFriend = (a, b) => a !== b && Boolean(q.isFriend.get({ a, b }).yes);
  const daytime = () => { const h = analytics.hourOf(); return h >= DAY_FROM && h < DAY_TO; };

  /**
   * Топ друзей: друзья и сам игрок по рейтингу, с местом.
   * Скин — только из известных, как в общем топе.
   */
  function list(meId) {
    const rows = q.list.all({ me: meId, max: FRIENDS_MAX });
    const me = rows.find((r) => r.id === meId);
    return {
      friends: rows.map((r) => ({
        id: r.id, name: r.name, photo: r.photo ?? null, rating: r.rating, wins: r.wins, losses: r.losses,
        tourney_wins: r.tourney_wins, skin: SKIN_IDS.includes(r.skin) ? r.skin : 'classic',
        seenAt: r.seen_at, place: r.place, ...(r.id === meId ? { me: true } : {}),
      })),
      place: me?.place ?? null,
      total: rows[0]?.total ?? 0,
      known: q.known.all({ me: meId, max: KNOWN_MAX }).map((r) => ({
        id: r.id, name: r.name, photo: r.photo ?? null, rating: r.rating, wins: r.wins, losses: r.losses,
        skin: SKIN_IDS.includes(r.skin) ? r.skin : 'classic', seenAt: r.seen_at, via: r.via,
      })),
    };
  }

  /**
   * Бой на рейтинг засчитан: победитель поднялся с before до after. Кого
   * из друзей он этим обогнал — тем сообщение (с ограничениями из шапки).
   * loserId — соперник по этому бою, ему не пишем.
   * @returns {Promise<number>} сколько сообщений ушло
   */
  async function onRated({ winnerId, loserId, before, after }) {
    if (!(after > before) || !daytime()) return 0;
    const w = players.byId(winnerId);
    if (!w) return 0;
    const day = analytics.dayOf();
    const t = now();
    const due = [];
    // Отметки ставятся сразу, до первой отправки: второй бой, засчитанный,
    // пока уходят сообщения, уже их видит
    for (const f of q.passed.all({ me: winnerId, skip: loserId ?? '', before, after })) {
      if (q.pinged.get('overtake', f.id, winnerId, day).n > 0) continue;
      if (q.pingedTo.get('overtake', f.id, day).n >= OVERTAKE_PER_DAY) continue;
      q.ping.run('overtake', winnerId, f.id, day, t);
      due.push(f);
    }
    let sent = 0;
    for (const f of due) {
      const ok = await notify(f.id, `📈 ${w.name} обогнал тебя в рейтинге друзей: ${after} против твоих ${f.rating}.\n`
        + 'Отыграйся — сыграй бой по сети на рейтинг.\n\n/mute — не писать о серии и друзьях',
      { button: '🏅 Друзья в топе', params: '?top=friends' }).catch((e) => { log.warn?.('[friends]', e.message); return null; });
      if (ok) sent++;
    }
    return sent;
  }

  /**
   * Вызов друга на бой через бота: сообщение с кнопкой в комнату башни.
   * @returns {Promise<{sent: boolean, reason?: string}>} не отправлено — игра зовёт карточкой
   */
  async function challenge(me, friendId, room) {
    const f = players.byId(friendId);
    if (!f || !isFriend(me.id, f.id)) return { error: 'это не твой друг' };
    if (!f.tg_id || f.banned_at || !f.remind) return { sent: false, reason: 'muted' };
    const day = analytics.dayOf();
    const t = now();
    if (t - (q.lastPing.get('duel', f.id, me.id).at ?? 0) < DUEL_GAP
      || q.pinged.get('duel', f.id, me.id, day).n >= DUEL_PAIR_PER_DAY
      || q.pingedFrom.get('duel', me.id, day).n >= DUEL_PER_DAY) return { sent: false, reason: 'limit' };
    // Отметка — до отправки, чтобы два нажатия подряд не прошли оба;
    // не дошло — убираем, лимит на неудачу не тратится
    const id = q.ping.run('duel', me.id, f.id, day, t).lastInsertRowid;
    const ok = await invite(f, me, room, { silent: !daytime() }).catch(() => null);
    if (ok) return { sent: true };
    q.unping.run(id);
    return { sent: false, reason: 'failed' };
  }

  return { list, isFriend, onRated, challenge };
}
