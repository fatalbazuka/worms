/**
 * Турниры: сетка на выбывание.
 *
 * Жизнь турнира: open (запись) → running (сетка) → finished, либо
 * cancelled. Создаёт и запускает только админ (команды бота). Запуск —
 * вручную или сам в назначенное время; если записалось меньше двух — турнир
 * отменяется, взносы возвращаются.
 *
 * Сетка. Размер — ближайшая степень двойки к числу записавшихся. Каждый
 * матч первого раунда получает игрока, вторые места заполняются, пока
 * хватает людей, — так «проходы без игры» достаются разным парам, а не
 * сбиваются в пустые матчи. Слот k раунда r питается победителями слотов
 * 2k и 2k+1 раунда r−1; следующий матч появляется, как только готовы оба
 * его «питателя», не дожидаясь конца всего раунда.
 *
 * Матч играется обычной сетевой партией в своей комнате (код на «T»). Итог
 * засчитывается, когда обе стороны сообщили согласный результат. Не
 * уложились в окно матча — решает тот, кто отчитался: «победил» без ответа
 * соперника — победа, «проиграл» — поражение, никто не отчитался — дальше
 * не проходит никто. Спор решает админ (/settle).
 *
 * Матчи турнира рейтинг Эло не меняют: иначе турнир стал бы фермой очков.
 * Чемпиону — титул в профиле, счётчик побед в турнирах и +25 к рейтингу.
 */
import { randomInt } from 'node:crypto';
import { tx } from './db.mjs';

export const SIZES = [4, 8, 16];
export const MATCH_WINDOW = 20 * 60_000;
export const CHAMPION_BONUS = 25;
const ROOM_ABC = 'ABCDEFGHJKLMNPQRSTUVWXY23456789';   // без Z: Z — бои без рейтинга

export function createTournaments({ db, now = () => Date.now(), notify = async () => {}, refund = async () => false,
  notifyAdmins = async () => {}, matchWindow = MATCH_WINDOW }) {
  const q = {
    t: db.prepare('select * from tournament where id = ?'),
    tAdd: db.prepare(`insert into tournament (name, size, fee, starts_at, created_at)
                      values (?, ?, ?, ?, ?)`),
    tName: db.prepare('update tournament set name = ? where id = ?'),
    tStatus: db.prepare('update tournament set status = ? where id = ?'),
    tStart: db.prepare("update tournament set status = 'running', started_at = ? where id = ?"),
    tFinish: db.prepare("update tournament set status = 'finished', finished_at = ?, winner = ? where id = ?"),
    tList: db.prepare(`select * from tournament where status in ('open', 'running')
                         or (status = 'finished' and finished_at > ?)
                       order by case status when 'running' then 0 when 'open' then 1 else 2 end, id desc limit 20`),
    tDue: db.prepare("select * from tournament where status = 'open' and starts_at is not null and starts_at <= ?"),
    players: db.prepare(`select p.id, p.name, p.photo, tp.joined_at, tp.charge_id from tournament_player tp
                         join player p on p.id = tp.player_id where tp.tid = ? order by tp.joined_at`),
    count: db.prepare('select count(*) as n from tournament_player where tid = ?'),
    entry: db.prepare('select * from tournament_player where tid = ? and player_id = ?'),
    join: db.prepare('insert into tournament_player (tid, player_id, joined_at, charge_id) values (?, ?, ?, ?)'),
    leave: db.prepare('delete from tournament_player where tid = ? and player_id = ?'),
    mAdd: db.prepare(`insert into tournament_match (tid, round, slot, p1, p2, room, winner, status, deadline, settled_at)
                      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    m: db.prepare('select * from tournament_match where id = ?'),
    mByRoom: db.prepare('select * from tournament_match where room = ?'),
    mAt: db.prepare('select * from tournament_match where tid = ? and round = ? and slot = ?'),
    mOf: db.prepare('select * from tournament_match where tid = ? order by round, slot'),
    mRoundCount: db.prepare('select count(*) as n from tournament_match where tid = ? and round = 1'),
    mClaim1: db.prepare('update tournament_match set p1_claim = ? where id = ?'),
    mClaim2: db.prepare('update tournament_match set p2_claim = ? where id = ?'),
    mDone: db.prepare("update tournament_match set status = 'done', winner = ?, settled_at = ? where id = ?"),
    mDispute: db.prepare("update tournament_match set status = 'disputed', settled_at = ? where id = ?"),
    mExpired: db.prepare("select * from tournament_match where status = 'pending' and deadline is not null and deadline <= ?"),
    mMine: db.prepare(`select * from tournament_match where tid = ? and status in ('pending', 'disputed')
                         and (p1 = ? or p2 = ?) order by round desc limit 1`),
    roomTaken: db.prepare('select 1 from tournament_match where room = ?'),
    player: db.prepare('select id, name, photo, tg_id, rating, titles from player where id = ?'),
    champion: db.prepare(`update player set tourney_wins = tourney_wins + 1, rating = rating + ?, titles = ?
                          where id = ?`),
    history: db.prepare(`select m.*, t.name as tname from tournament_match m join tournament t on t.id = m.tid
                         where m.status = 'done' and m.p2 is not null and (m.p1 = ? or m.p2 = ?)
                         order by m.settled_at desc limit ?`),
  };

  const name = (id) => (id ? q.player.get(id)?.name ?? 'игрок' : null);
  const playerView = (id) => {
    if (!id) return null;
    const p = q.player.get(id);
    return p ? { id: p.id, name: p.name, photo: p.photo } : null;
  };

  function newRoom() {
    for (;;) {
      let code = 'T';
      for (let i = 0; i < 6; i++) code += ROOM_ABC[randomInt(ROOM_ABC.length)];
      if (!q.roomTaken.get(code)) return code;
    }
  }

  // ---------------------------------------------------------------- запись

  function create({ name: title, size, fee = 0, startsAt = null }) {
    if (!SIZES.includes(size)) throw new Error(`мест может быть ${SIZES.join(', ')}`);
    const f = Math.max(0, Math.floor(Number(fee) || 0));
    const id = Number(q.tAdd.run(String(title || '').slice(0, 60) || 'Турнир', size, f, startsAt, now()).lastInsertRowid);
    if (!title) q.tName.run(`Турнир #${id}`, id);
    return q.t.get(id);
  }

  /** Можно ли игроку записаться (без учёта оплаты). null — можно, иначе причина. */
  function joinProblem(tid, playerId) {
    const t = q.t.get(tid);
    if (!t) return 'турнира нет';
    if (t.status !== 'open') return 'запись закрыта';
    if (q.entry.get(tid, playerId)) return 'уже записан';
    if (q.count.get(tid).n >= t.size) return 'мест нет';
    return null;
  }

  /** Записаться. Платный турнир — только через оплату (addPaid). */
  function join(tid, playerId) {
    const problem = joinProblem(tid, playerId);
    if (problem) return { ok: false, error: problem };
    const t = q.t.get(tid);
    if (t.fee > 0) return { ok: false, pay: true, fee: t.fee };
    q.join.run(tid, playerId, now(), null);
    afterJoin(t);
    return { ok: true };
  }

  /** Оплата взноса прошла — записываем. false — места уже нет, взнос вернуть. */
  function addPaid(tid, playerId, chargeId) {
    if (joinProblem(tid, playerId)) return false;
    q.join.run(tid, playerId, now(), chargeId);
    afterJoin(q.t.get(tid));
    return true;
  }

  /** Набралось полное число — стартуем сразу, если время старта не назначено. */
  function afterJoin(t) {
    if (t.starts_at == null && q.count.get(t.id).n >= t.size) start(t.id);
  }

  async function leave(tid, playerId) {
    const t = q.t.get(tid);
    const e = q.entry.get(tid, playerId);
    if (!t || !e) return { ok: false, error: 'ты не записан' };
    if (t.status !== 'open') return { ok: false, error: 'турнир уже идёт' };
    q.leave.run(tid, playerId);
    if (e.charge_id) await refund(e.charge_id, playerId);
    return { ok: true };
  }

  // ----------------------------------------------------------------- сетка

  function start(tid) {
    const t = q.t.get(tid);
    if (!t || t.status !== 'open') return { ok: false, error: 'турнир не в записи' };
    const players = q.players.all(tid).map((p) => p.id);
    if (players.length < 2) return { ok: false, error: 'нужно хотя бы двое' };

    // Порядок в сетке — случайный, но честный: криптографический генератор
    for (let i = players.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [players[i], players[j]] = [players[j], players[i]];
    }
    let size = 2;
    while (size < players.length) size *= 2;
    const slots = size / 2;
    const t0 = now();
    const created = [];
    tx(db, () => {
      q.tStart.run(t0, tid);
      for (let k = 0; k < slots; k++) {
        const p1 = players[k];
        const p2 = players[k + slots] ?? null;
        if (p2) {
          q.mAdd.run(tid, 1, k, p1, p2, newRoom(), null, 'pending', t0 + matchWindow, null);
        } else {
          q.mAdd.run(tid, 1, k, p1, null, newRoom(), p1, 'done', null, t0);   // проход без игры
        }
        created.push(q.mAt.get(tid, 1, k));
      }
    });
    for (const m of created) {
      if (m.status === 'pending') announceMatch(t, m);
      else advance(m);
    }
    return { ok: true };
  }

  function announceMatch(t, m) {
    for (const [me, foe] of [[m.p1, m.p2], [m.p2, m.p1]]) {
      notify(me, `⚔️ Турнир «${t.name}», раунд ${m.round}: твой соперник — ${name(foe)}.\n`
        + `На матч ${Math.round(matchWindow / 60_000)} минут. Открой игру → Турниры → «Играть матч».`, { tour: t.id });
    }
  }

  /** Матч решён: собираем следующий, когда готовы оба его «питателя». */
  function advance(m) {
    const t = q.t.get(m.tid);
    if (t.status !== 'running') return;
    const firstRound = q.mRoundCount.get(m.tid).n;
    const inRound = firstRound / 2 ** (m.round - 1);
    if (inRound <= 1) { finish(t, m.winner); return; }

    const sibling = q.mAt.get(m.tid, m.round, m.slot ^ 1);
    if (!sibling || sibling.status !== 'done') return;
    const slot = m.slot >> 1;
    if (q.mAt.get(m.tid, m.round + 1, slot)) return;           // уже собран
    const even = m.slot % 2 === 0 ? m : sibling;
    const odd = even === m ? sibling : m;
    const p1 = even.winner ?? odd.winner ?? null;
    const p2 = even.winner && odd.winner ? odd.winner : null;
    const t0 = now();
    if (p1 && p2) {
      q.mAdd.run(m.tid, m.round + 1, slot, p1, p2, newRoom(), null, 'pending', t0 + matchWindow, null);
      announceMatch(t, q.mAt.get(m.tid, m.round + 1, slot));
    } else {
      // Проход без игры (или никого — оба выбыли): решаем сразу и идём дальше
      q.mAdd.run(m.tid, m.round + 1, slot, p1, null, newRoom(), p1, 'done', null, t0);
      advance(q.mAt.get(m.tid, m.round + 1, slot));
    }
  }

  function finish(t, winnerId) {
    q.tFinish.run(now(), winnerId ?? null, t.id);
    if (winnerId) {
      const p = q.player.get(winnerId);
      let titles = [];
      try { titles = JSON.parse(p.titles || '[]'); } catch { titles = []; }
      titles.unshift({ title: `Чемпион «${t.name}»`, at: now() });
      q.champion.run(CHAMPION_BONUS, JSON.stringify(titles.slice(0, 20)), winnerId);
    }
    const text = winnerId
      ? `🏆 Турнир «${t.name}» окончен. Победитель — ${name(winnerId)}!`
      : `Турнир «${t.name}» окончен без победителя: финал не сыгран.`;
    for (const p of q.players.all(t.id)) {
      notify(p.id, p.id === winnerId
        ? `🏆 Ты выиграл турнир «${t.name}»! Титул в профиле и +${CHAMPION_BONUS} к рейтингу.`
        : text, { tour: t.id });
    }
  }

  async function cancel(tid) {
    const t = q.t.get(tid);
    if (!t || (t.status !== 'open' && t.status !== 'running')) return { ok: false, error: 'отменять нечего' };
    q.tStatus.run('cancelled', tid);
    for (const p of q.players.all(tid)) {
      if (p.charge_id) await refund(p.charge_id, p.id);
      notify(p.id, `Турнир «${t.name}» отменён.${p.charge_id ? ' Взнос вернётся на твой счёт звёзд.' : ''}`);
    }
    return { ok: true };
  }

  // ----------------------------------------------------------------- матчи

  const isTournamentRoom = (room) => Boolean(q.mByRoom.get(String(room ?? '').toUpperCase()));

  /** Отчёт игрока о матче турнира. null — это не турнирная комната. */
  function report(playerId, room, won) {
    const m = q.mByRoom.get(String(room ?? '').toUpperCase());
    if (!m) return null;
    if (m.p1 !== playerId && m.p2 !== playerId) return { status: 'tournament', error: 'это не твой матч' };
    if (m.status !== 'pending') return { status: 'tournament', match: m.status, winner: m.winner };
    const claim = won ? 'win' : 'loss';
    if (m.p1 === playerId) q.mClaim1.run(claim, m.id); else q.mClaim2.run(claim, m.id);
    const cur = q.m.get(m.id);
    if (!cur.p1_claim || !cur.p2_claim) return { status: 'tournament', match: 'waiting' };
    if (cur.p1_claim === cur.p2_claim) {
      q.mDispute.run(now(), m.id);
      const t = q.t.get(m.tid);
      notifyAdmins(`⚠️ Спор в турнире «${t.name}», матч ${m.id}: ${name(m.p1)} и ${name(m.p2)} `
        + `оба заявили «${cur.p1_claim === 'win' ? 'победил' : 'проиграл'}». `
        + `Реши: /settle ${m.id} 1 — победил ${name(m.p1)}, /settle ${m.id} 2 — ${name(m.p2)}.`);
      return { status: 'tournament', match: 'disputed' };
    }
    const winner = cur.p1_claim === 'win' ? m.p1 : m.p2;
    q.mDone.run(winner, now(), m.id);
    advance(q.m.get(m.id));
    return { status: 'tournament', match: 'done', winner };
  }

  /** Решение админа по спорному или зависшему матчу: 1 или 2. */
  function settle(matchId, which) {
    const m = q.m.get(matchId);
    if (!m || m.status === 'done') return { ok: false, error: 'матча нет или он уже решён' };
    const winner = Number(which) === 1 ? m.p1 : Number(which) === 2 ? m.p2 : null;
    if (!winner) return { ok: false, error: 'укажи 1 или 2' };
    q.mDone.run(winner, now(), m.id);
    advance(q.m.get(m.id));
    return { ok: true, winner: name(winner) };
  }

  /** Раз в полминуты: автостарт по времени и матчи, вышедшие за окно. */
  function tick() {
    const t0 = now();
    for (const t of q.tDue.all(t0)) {
      if (q.count.get(t.id).n >= 2) start(t.id);
      else cancel(t.id);
    }
    for (const m of q.mExpired.all(t0)) {
      let winner = null;
      if (m.p1_claim === 'win' && !m.p2_claim) winner = m.p1;
      else if (m.p2_claim === 'win' && !m.p1_claim) winner = m.p2;
      else if (m.p1_claim === 'loss') winner = m.p2;
      else if (m.p2_claim === 'loss') winner = m.p1;
      q.mDone.run(winner, t0, m.id);
      const t = q.t.get(m.tid);
      for (const p of [m.p1, m.p2]) {
        notify(p, `⏱ Время матча в турнире «${t.name}» вышло. `
          + (winner ? `Дальше проходит ${name(winner)}.` : 'Никто не отчитался — дальше не проходит никто.'), { tour: t.id });
      }
      advance(q.m.get(m.id));
    }
  }

  // ---------------------------------------------------------------- чтение

  function summary(t, meId) {
    return {
      id: t.id, name: t.name, size: t.size, fee: t.fee, status: t.status,
      startsAt: t.starts_at, startedAt: t.started_at, finishedAt: t.finished_at,
      count: q.count.get(t.id).n,
      joined: meId ? Boolean(q.entry.get(t.id, meId)) : false,
      winner: playerView(t.winner),
    };
  }

  function list(meId) {
    return q.tList.all(now() - 3 * 86400_000).map((t) => summary(t, meId));
  }

  function get(tid, meId) {
    const t = q.t.get(tid);
    if (!t) return null;
    const rounds = [];
    for (const m of q.mOf.all(tid)) {
      (rounds[m.round - 1] ??= []).push({
        id: m.id, round: m.round, slot: m.slot, status: m.status,
        p1: playerView(m.p1), p2: playerView(m.p2), winner: m.winner, deadline: m.deadline,
      });
    }
    let my = null;
    if (meId && t.status === 'running') {
      const m = q.mMine.get(tid, meId, meId);
      if (m) {
        const mine = m.p1 === meId ? m.p1_claim : m.p2_claim;
        my = {
          matchId: m.id, room: m.room, round: m.round, status: m.status, deadline: m.deadline,
          opponent: playerView(m.p1 === meId ? m.p2 : m.p1), reported: mine ?? null,
        };
      }
    }
    return {
      ...summary(t, meId),
      players: q.players.all(tid).map((p) => ({ id: p.id, name: p.name, photo: p.photo })),
      rounds, my,
    };
  }

  function historyFor(playerId, limit = 20) {
    return q.history.all(playerId, playerId, limit).map((m) => ({
      kind: 'tournament', at: m.settled_at, won: m.winner === playerId,
      opponent: playerView(m.p1 === playerId ? m.p2 : m.p1),
      note: `${m.tname}, раунд ${m.round}`,
    }));
  }

  return {
    create, join, addPaid, joinProblem, leave, start, cancel, report, settle, tick,
    list, get, historyFor, isTournamentRoom, byId: (id) => q.t.get(id),
  };
}
