/**
 * Дуэли по переписке: бой на двоих, где каждый ходит, когда ему удобно.
 *
 * Сервер боя не считает — он хранит историю. Ход — то, что сделал игрок
 * за свой ход (ходьба, трос, выбор оружия, выстрел: те же приказы, что
 * идут по сети в онлайне), и снимок итога хода — тот же captureState,
 * которым онлайн-клиенты сводят партию. Следующий клиент собирает партию
 * с зерна, накатывает снимки по порядку, а последний ход соперника
 * показывает по приказам — «повтор хода соперника» — и только потом даёт
 * ходить. Физика у нас по кадровой дельте, повтор одних приказов на другом
 * телефоне разошёлся бы; поэтому истина — снимок, а приказы — картинка.
 *
 * С каждым ходом приходит свёртка итога (hash) у ходившего, а со
 * следующим ходом — что вышло у того, кто этот итог восстановил
 * (prevHash; prevTurn — какой это был ход: за пропуском свёртки нет).
 * Не совпало — пишем в журнал и в seen_hash, партия идёт дальше по
 * истории сервера: её снимки и есть то, что видят оба.
 *
 * Очередь. Ход n делает p1 при нечётном n и p2 при чётном: команды в бою
 * чередуются строго (в бою двое, выбитая команда — конец партии). На ход —
 * TURN_MS. Не успел — ход пропущен (запись kind = 'skip', клиент просто
 * передаёт очередь); MAX_SKIPS пропусков подряд — поражение.
 *
 * Бот пишет (все сообщения — с /mute, ночью без звука, как о друзьях):
 *   «⚔️ твой ход против X» — когда очередь перешла к игроку. Не пишем, если
 *   он прямо сейчас смотрит эту дуэль (опрашивал её за WATCH_MS) — он и так
 *   увидит; и не больше TURN_PINGS_PER_DAY таких сообщений в день одному;
 *   «⏳ осталось 2 часа» — один раз за ход, за REMIND_BEFORE до срока;
 *   итог — обоим (при сдаче — только тому, кто не сдавался).
 *
 * Создать дуэль можно только с другом (server/friends.mjs) или с тем, с
 * кем уже была дуэль (реванш), — либо ссылкой с кодом: кто первым её
 * принял, тот и соперник. Активных дуэлей у игрока не больше MAX_ACTIVE.
 * Дуэль без рейтинга: монеты, опыт и задания игра начисляет как за бой
 * с человеком.
 */
import { randomInt } from 'node:crypto';
import { tx } from './db.mjs';
import { skinSql } from './players.mjs';
import { SKIN_IDS } from './shop.mjs';
import { settle } from './lib/elo.js';

/** Версия правил новых дуэлей: 2 — с «арсеналом боя» (клиент: net/duel.js duelMatch). */
export const RULES = 2;
export const TURN_MS = 24 * 3600_000;
export const REMIND_BEFORE = 2 * 3600_000;
export const MAX_ACTIVE = 5;
export const MAX_SKIPS = 3;
export const OPEN_TTL = 7 * 86400_000;      // ссылку никто не принял за неделю — дуэль отменяется
export const WATCH_MS = 25_000;             // опрос у смотрящего — раз в 10 секунд
export const NOTIFY_LATE = 45_000;          // через сколько досылаем «твой ход», если его не увидели
export const TURN_PINGS_PER_DAY = 40;
const FINISHED_SHOWN = 7 * 86400_000;       // доигранные видны в списке неделю
const DAY_FROM = 9, DAY_TO = 23;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createDuels({ db, players, friends, analytics, notify, now = () => Date.now(), log = console }) {
  const q = {
    byId: db.prepare('select * from duel where id = ?'),
    byCode: db.prepare('select * from duel where code = ?'),
    active: db.prepare(`select count(*) as n from duel where (p1 = $p or p2 = $p) and status in ('open', 'active')`),
    add: db.prepare(`insert into duel (p1, p2, code, seed, status, deadline, created_at, updated_at, rules)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ${RULES})`),
    mine: db.prepare(`select * from duel where (p1 = $p or p2 = $p)
                        and (status in ('open', 'active') or coalesce(finished_at, 0) > $since)
                      order by case when status in ('open', 'active') then 0 else 1 end, updated_at desc limit 30`),
    pub: db.prepare(`select id, name, photo, ${skinSql('player.id')} as skin from player where id = ?`),
    turns: db.prepare('select * from duel_turn where duel_id = ? order by n'),
    turn: db.prepare('select * from duel_turn where duel_id = ? and n = ?'),
    addTurn: db.prepare(`insert into duel_turn (duel_id, n, player_id, kind, cmds, state, hash, created_at)
                         values (?, ?, ?, ?, ?, ?, ?, ?)`),
    seenHash: db.prepare('update duel_turn set seen_hash = ? where duel_id = ? and n = ?'),
    next: db.prepare(`update duel set turn = ?, deadline = ?, reminded_turn = null, skips1 = ?, skips2 = ?,
                      updated_at = ? where id = ?`),
    finish: db.prepare(`update duel set status = 'finished', winner = ?, reason = ?, deadline = null,
                        code = null, finished_at = ?, updated_at = ? where id = ?`),
    cancel: db.prepare(`update duel set status = 'cancelled', deadline = null, code = null, finished_at = ?,
                        updated_at = ? where id = ?`),
    join: db.prepare(`update duel set p2 = ?, status = 'active', code = null, deadline = coalesce(deadline, ?),
                      updated_at = ? where id = ?`),
    // Создатель ещё не ходил: принявший становится первым (p1), создатель —
    // вторым. В UPDATE справа старые значения, поэтому p2 = p1 — создатель
    joinFirst: db.prepare(`update duel set p1 = ?, p2 = p1, status = 'active', code = null, deadline = ?,
                           updated_at = ? where id = ?`),
    openInvite: db.prepare(`select * from duel where p1 = ? and p2 is null and status = 'open' and turn = 1
                              and created_at > ? order by created_at desc limit 1`),
    seen1: db.prepare('update duel set seen1 = ? where id = ?'),
    seen2: db.prepare('update duel set seen2 = ? where id = ?'),
    reminded: db.prepare('update duel set reminded_turn = turn where id = ?'),
    notified: db.prepare('update duel set notified_turn = turn where id = ?'),
    setDelta: db.prepare('update duel set delta = ? where id = ? and delta is null'),
    between: db.prepare(`select * from duel where status in ('open', 'active')
                           and ((p1 = $a and p2 = $b) or (p1 = $b and p2 = $a)) limit 1`),
    unnotified: db.prepare(`select * from duel where status = 'active' and deadline is not null
                              and coalesce(notified_turn, 0) != turn and updated_at <= ? limit 200`),
    due: db.prepare(`select * from duel where status = 'active' and deadline is not null and deadline <= ? limit 200`),
    remindDue: db.prepare(`select * from duel where status = 'active' and deadline is not null
                             and deadline > $now and deadline - $now <= $before
                             and coalesce(reminded_turn, 0) != turn limit 200`),
    staleOpen: db.prepare(`select id from duel where status = 'open' and created_at < ? limit 200`),
    pinged: db.prepare("select count(*) as n from friend_ping where kind = 'duel_turn' and to_id = ? and day = ?"),
    ping: db.prepare("insert into friend_ping (kind, from_id, to_id, day, created_at) values ('duel_turn', ?, ?, ?, ?)"),
  };

  const moverOf = (d) => (d.turn % 2 === 1 ? d.p1 : d.p2);
  const otherOf = (d, id) => (d.p1 === id ? d.p2 : d.p1);
  const daytime = () => { const h = analytics.hourOf(); return h >= DAY_FROM && h < DAY_TO; };
  const activeCount = (id) => q.active.get({ p: id }).n;
  const isInvite = (d) => d.status === 'open' && d.turn === 1 && d.deadline === null;

  function pub(id) {
    const r = id ? q.pub.get(id) : null;
    return r ? { id: r.id, name: r.name, photo: r.photo ?? null, skin: SKIN_IDS.includes(r.skin) ? r.skin : 'classic' } : null;
  }

  function code() {
    for (;;) {
      let c = '';
      while (c.length < 6) c += CODE_ABC[randomInt(CODE_ABC.length)];
      if (!q.byCode.get(c)) return c;
    }
  }

  function parse(s) {
    try { return s ? JSON.parse(s) : null; } catch { return null; }
  }

  /** Дуэль наружу: для игрока meId; withTurns — со всей историей ходов. */
  function view(d, meId, { withTurns = false } = {}) {
    const team = d.p1 === meId ? 0 : 1;
    const mover = moverOf(d);
    // Вызов «позвал и ушёл», который ещё никто не принял: ходить создателю
    // не надо — первым пойдёт принявший
    const invite = isInvite(d);
    const out = {
      id: d.id, seed: d.seed, status: d.status, turn: d.turn, deadline: d.deadline, rules: d.rules ?? 1,
      // Сдвиг рейтинга для этого игрока: + победителю, − проигравшему
      delta: d.delta == null ? null : (d.winner === meId ? d.delta : -d.delta),
      winner: d.winner ? (d.winner === d.p1 ? 0 : 1) : null, reason: d.reason ?? null,
      me: team, p1: pub(d.p1), p2: pub(d.p2), opponent: pub(team === 0 ? d.p2 : d.p1),
      myTurn: !invite && (d.status === 'active' || d.status === 'open') && mover === meId,
      ...(invite ? { invite: true } : {}),
      skips: [d.skips1, d.skips2],
      ...(d.code && d.p1 === meId ? { code: d.code } : {}),
      updatedAt: d.updated_at,
    };
    if (withTurns) {
      out.turns = q.turns.all(d.id).map((t) => ({
        n: t.n, team: t.player_id === d.p1 ? 0 : 1, kind: t.kind,
        cmds: parse(t.cmds) ?? [], state: parse(t.state), hash: t.hash ?? null,
      }));
    }
    return out;
  }

  /** Своя дуэль или ошибка. */
  function own(meId, id) {
    const d = q.byId.get(Number(id));
    if (!d || (d.p1 !== meId && d.p2 !== meId)) return null;
    return d;
  }

  // -------------------------------------------------------------- сообщения

  /**
   * Сообщение игроку о дуэли с кнопкой прямо в неё. kind = 'turn' — с
   * ограничениями «смотрит сейчас» и дневным лимитом (см. шапку).
   */
  async function ping(d, toId, text, kind = 'other', button = '⚔️ Ходить', { late = false } = {}) {
    const p = toId ? players.byId(toId) : null;
    if (!p?.tg_id || !p.remind || p.banned_at) return null;
    if (kind === 'turn') {
      const seen = p.id === d.p1 ? d.seen1 : d.seen2;
      // Смотрит дуэль прямо сейчас — увидит сам. Но если он тут же закрыл
      // игру, хода он не увидит: tick дошлёт сообщение (late), когда станет
      // ясно, что новое состояние он так и не открыл
      if (!late && seen && now() - seen < WATCH_MS) return null;
      const day = analytics.dayOf();
      if (q.pinged.get(p.id, day).n >= TURN_PINGS_PER_DAY) return null;
      q.ping.run(otherOf(d, p.id) ?? p.id, p.id, day, now());
    }
    return notify(p.id, `${text}\n\n/mute — не писать самому`,
      { button, params: `?duel=${d.id}`, silent: !daytime() })
      .catch((e) => { log.warn?.('[duels]', e.message); return null; });
  }

  const nameOf = (id) => players.byId(id)?.name ?? 'соперник';

  async function turnNotice(d, skippedBy = null, { late = false } = {}) {
    const to = moverOf(d);
    if (!to) return null;
    const foe = nameOf(otherOf(d, to));
    const why = skippedBy ? `\n${foe} не успел походить — его ход пропущен.` : '';
    const sent = d.turn === 1 && !skippedBy
      ? await ping(d, to, `⚔️ ${foe} вызывает тебя на дуэль в Smiles!\n`
        + 'Ходите по очереди, когда удобно, — твой ход первый. На ход 24 часа.', 'turn', '⚔️ Принять и ходить', { late })
      : await ping(d, to, `⚔️ Твой ход против ${foe}!${why}\nДуэль по переписке: на ход 24 часа.`, 'turn', '⚔️ Ходить', { late });
    // Написали — отмечаем; не написали («смотрит») — tick проверит позже
    if (sent || late) q.notified.run(d.id);
    return sent;
  }

  async function resultNotice(d, { only = null } = {}) {
    const why = { resign: 'сдался', timeout: 'пропустил три хода подряд' }[d.reason] ?? null;
    for (const id of [d.p1, d.p2]) {
      if (!id || (only && id !== only)) continue;
      const foe = nameOf(otherOf(d, id));
      let text;
      if (!d.winner) text = `🤝 Дуэль против ${foe} — ничья.`;
      else if (d.winner === id) text = `🏆 Победа в дуэли против ${foe}!${why ? ` Соперник ${why}.` : ''}${d.delta ? ` Рейтинг +${d.delta}.` : ''}`;
      else text = `Дуэль против ${foe} проиграна${why ? `: ты ${why}` : ''}.${d.delta ? ` Рейтинг −${d.delta}.` : ''} Реванш?`;
      await ping(d, id, text, 'result', '🎬 Открыть дуэль');
    }
  }

  // ------------------------------------------------------------- действия

  /**
   * Дуэль окончена с победителем — рейтинг обоим, как за бой по сети (Эло,
   * одно число на двоих). Ничья и отменённая — без рейтинга. Раз на дуэль:
   * delta пишется один раз. Зовётся внутри той же транзакции, что и finish.
   * @returns {{winnerId, loserId, before, after} | null} для «обогнал друга»
   */
  function rateDuel(id) {
    const d = q.byId.get(id);
    if (!d || d.status !== 'finished' || !d.winner || !d.p1 || !d.p2 || d.delta != null) return null;
    const loserId = d.winner === d.p1 ? d.p2 : d.p1;
    const w = players.byId(d.winner), l = players.byId(loserId);
    if (!w || !l) return null;
    const r = settle(w.rating, l.rating);
    players.rate(w.id, r.winner, l.id, r.loser);
    q.setDelta.run(r.delta, d.id);
    return { winnerId: w.id, loserId: l.id, before: w.rating, after: r.winner };
  }

  /** Победитель мог обогнать друзей — им напишет бот (server/friends.mjs). */
  function afterRated(rated) {
    if (rated) friends.onRated?.(rated)?.catch?.((e) => log.warn?.('[duels] обогнал', e.message));
  }

  /** Список моих дуэлей: идущие и доигранные за неделю. */
  function list(meId) {
    const items = q.mine.all({ p: meId, since: now() - FINISHED_SHOWN }).map((d) => view(d, meId));
    return { items, myTurn: items.filter((x) => x.myTurn).length, max: MAX_ACTIVE };
  }

  /**
   * Новая дуэль: с другом (opponent) или ссылкой (link). Обычно создатель
   * ходит первым и тут же делает первый ход.
   *
   * theyFirst — вызов «позвал и ушёл»: первым ходит тот, кого позвали.
   * С другом — бот сразу пишет ему «твой ход»; ссылкой — создатель не
   * ходит, а принявший ссылку станет первым (join). Незанятый вызов-ссылка
   * у игрока один: карточку шлют в разные чаты — дуэль та же, кто первым
   * принял, тот и соперник. Ждать никому не надо: о ходе пишет бот.
   */
  function create(me, { opponent = null, code: playerCode = null, link = false, theyFirst = false } = {}) {
    const t = now();
    if (link && theyFirst) {
      const open = q.openInvite.get(me.id, t - OPEN_TTL);
      if (open) return { duel: view(open, me.id) };
    }
    if (activeCount(me.id) >= MAX_ACTIVE) return { status: 409, error: `дуэлей уже ${MAX_ACTIVE} — доиграй одну` };
    const seed = randomInt(1, 2 ** 31);
    if (link) {
      const id = q.add.run(me.id, null, code(), seed, 'open', theyFirst ? null : t + TURN_MS, t, t).lastInsertRowid;
      return { duel: view(q.byId.get(id), me.id) };
    }
    // Вызвать можно любого: друга, знакомого, игрока из рейтинга или по
    // коду. От потока вызовов держат лимит на создание (index.mjs), не
    // больше MAX_ACTIVE дуэлей у каждого, одна идущая дуэль на пару и /mute
    const f = playerCode ? players.byCode(playerCode) : players.byId(String(opponent ?? ''));
    if (!f || f.banned_at) return { status: 404, error: playerCode ? 'нет игрока с таким кодом' : 'нет такого игрока' };
    if (f.id === me.id) return { status: 400, error: playerCode ? 'это твой собственный код' : 'нельзя вызвать себя' };
    const going = q.between.get({ a: me.id, b: f.id });
    if (going) return { duel: view(going, me.id), existing: true };
    if (activeCount(f.id) >= MAX_ACTIVE) return { status: 409, error: `у ${f.name} уже ${MAX_ACTIVE} дуэлей` };
    const [p1, p2] = theyFirst ? [f.id, me.id] : [me.id, f.id];
    const id = q.add.run(p1, p2, null, seed, 'active', t + TURN_MS, t, t).lastInsertRowid;
    const d = q.byId.get(id);
    // Создатель, который ходит сам, про свой ход знает; позванному — пишем
    if (theyFirst) turnNotice(d);
    else q.notified.run(d.id);
    return { duel: view(d, me.id) };
  }

  /** Принять дуэль по коду ссылки. */
  function join(me, rawCode) {
    const d = q.byCode.get(String(rawCode ?? '').toUpperCase());
    if (!d || d.status !== 'open') return { status: 404, error: 'дуэль уже началась или отменена' };
    if (d.p1 === me.id) return { duel: view(d, me.id) };
    if (activeCount(me.id) >= MAX_ACTIVE) return { status: 409, error: `дуэлей уже ${MAX_ACTIVE} — доиграй одну` };
    const t = now();
    // Создатель ещё не ходил (вызов «позвал и ушёл») — первым ходит принявший;
    // иначе первый ход уже сделан, и часы второго идут с этой минуты
    if (d.turn === 1) q.joinFirst.run(me.id, t + TURN_MS, t, d.id);
    else q.join.run(me.id, t + TURN_MS, t, d.id);
    // Принявший ходит сейчас и сам — писать ему «твой ход» не о чем
    q.notified.run(d.id);
    return { duel: view(q.byId.get(d.id), me.id) };
  }

  /** Дуэль целиком, с историей ходов. Отмечает, что игрок её смотрит. */
  function get(meId, id) {
    const d = own(meId, id);
    if (!d) return null;
    (d.p1 === meId ? q.seen1 : q.seen2).run(now(), d.id);
    return view(d, meId, { withTurns: true });
  }

  /**
   * Ход игрока. Повтор того же хода (сеть оборвалась после записи) — не
   * ошибка, а тот же ответ: клиент шлёт, пока не услышит «принято».
   */
  async function submit(me, id, body) {
    const d = own(me.id, id);
    if (!d) return { status: 404, error: 'нет такой дуэли' };
    const n = Number(body.turn);
    const was = Number.isSafeInteger(n) ? q.turn.get(d.id, n) : null;
    if (was && was.player_id === me.id && was.kind === 'move') return { duel: view(q.byId.get(d.id), me.id), repeated: true };
    if (d.status !== 'active' && !(d.status === 'open' && d.turn === 1)) return { status: 409, error: 'дуэль окончена', duel: view(d, me.id) };
    if (isInvite(d)) return { status: 409, error: 'первым ходит тот, кто примет вызов', duel: view(d, me.id) };
    if (n !== d.turn) return { status: 409, error: 'этот ход уже не твой', duel: view(d, me.id) };
    if (moverOf(d) !== me.id) return { status: 409, error: 'сейчас ход соперника', duel: view(d, me.id) };

    const state = body.state;
    const cmds = Array.isArray(body.cmds) ? body.cmds : null;
    const over = body.over === true;
    const winner = over ? Number(body.winner) : null;
    if (!state || typeof state !== 'object' || !Array.isArray(state.worms) || !cmds || cmds.length > 600) {
      return { status: 400, error: 'плохой ход' };
    }
    // Очередь после хода — у соперника и со следующим номером: иначе
    // история разъедется у следующего, кто будет её восстанавливать
    if (over ? ![0, 1, -1].includes(winner) : (state.turn !== n + 1 || state.team !== n % 2)) {
      return { status: 400, error: 'ход не сходится с очередью' };
    }
    const hash = typeof body.hash === 'string' ? body.hash.slice(0, 32) : null;
    const t = now();
    let rated = null;
    const fin = tx(db, () => {
      q.addTurn.run(d.id, n, me.id, 'move', JSON.stringify(cmds), JSON.stringify(state), hash, t);
      // Как у меня сошёлся последний восстановленный ход (prevTurn; за
      // пропуском свёртки нет — тогда это ход до него)
      const pn = Number.isSafeInteger(body.prevTurn) && body.prevTurn < n ? body.prevTurn : n - 1;
      const prev = pn >= 1 ? q.turn.get(d.id, pn) : null;
      if (prev?.kind === 'move' && typeof body.prevHash === 'string') {
        q.seenHash.run(body.prevHash.slice(0, 32), d.id, pn);
        if (prev.hash && prev.hash !== body.prevHash) {
          log.warn?.(`[duels] дуэль ${d.id}, ход ${pn}: состояние разошлось ${prev.hash} != ${body.prevHash}`);
        }
      }
      const s1 = d.p1 === me.id ? 0 : d.skips1, s2 = d.p2 === me.id ? 0 : d.skips2;
      if (over) {
        const w = winner === -1 ? null : (winner === 0 ? d.p1 : d.p2);
        q.finish.run(w, winner === -1 ? 'draw' : 'kill', t, t, d.id);
        rated = rateDuel(d.id);
        return true;
      }
      // Ходить дальше некому (ссылку ещё не приняли) — часы стоят
      const nextMover = (n + 1) % 2 === 1 ? d.p1 : d.p2;
      q.next.run(n + 1, nextMover ? t + TURN_MS : null, s1, s2, t, d.id);
      return false;
    });
    const fresh = q.byId.get(d.id);
    afterRated(rated);
    if (fin) await resultNotice(fresh);
    else await turnNotice(fresh);
    return { duel: view(fresh, me.id) };
  }

  /** Сдаться. Ссылку, которую никто не принял, — просто отменить. */
  async function resign(me, id) {
    const d = own(me.id, id);
    if (!d) return { status: 404, error: 'нет такой дуэли' };
    if (d.status !== 'open' && d.status !== 'active') return { status: 409, error: 'дуэль уже окончена' };
    const t = now();
    if (!d.p2) {
      q.cancel.run(t, t, d.id);
      return { duel: view(q.byId.get(d.id), me.id) };
    }
    const rated = tx(db, () => {
      q.finish.run(otherOf(d, me.id), 'resign', t, t, d.id);
      return rateDuel(d.id);
    });
    afterRated(rated);
    const fresh = q.byId.get(d.id);
    await resultNotice(fresh, { only: otherOf(d, me.id) });
    return { duel: view(fresh, me.id) };
  }

  // ------------------------------------------------------------- по часам

  let ticking = false;
  /**
   * Раз в полминуты (как турниры и напоминания): просроченные ходы —
   * пропуск или поражение, за два часа до срока — напоминание, ссылки,
   * которые неделю никто не принял, — отмена.
   * @returns {Promise<{skipped: number, lost: number, reminded: number}>}
   */
  async function tick() {
    const out = { skipped: 0, lost: 0, reminded: 0, late: 0 };
    if (ticking) return out;
    ticking = true;
    try {
      const t = now();
      for (const d of q.due.all(t)) {
        const mover = moverOf(d);
        if (!mover) continue;
        const lost = tx(db, () => {
          q.addTurn.run(d.id, d.turn, mover, 'skip', null, null, null, t);
          const s1 = d.p1 === mover ? d.skips1 + 1 : d.skips1, s2 = d.p2 === mover ? d.skips2 + 1 : d.skips2;
          if (Math.max(s1, s2) >= MAX_SKIPS) {
            q.next.run(d.turn + 1, null, s1, s2, t, d.id);
            q.finish.run(otherOf(d, mover), 'timeout', t, t, d.id);
            afterRated(rateDuel(d.id));
            return true;
          }
          q.next.run(d.turn + 1, t + TURN_MS, s1, s2, t, d.id);
          return false;
        });
        const fresh = q.byId.get(d.id);
        if (lost) { out.lost++; await resultNotice(fresh); } else { out.skipped++; await turnNotice(fresh, mover); }
      }
      // «Твой ход» не писали, потому что игрок смотрел дуэль, — а он ушёл,
      // не дождавшись: новое состояние так и не открыл. Досылаем
      for (const d of q.unnotified.all(t - NOTIFY_LATE)) {
        const mover = moverOf(d);
        const seen = mover === d.p1 ? d.seen1 : d.seen2;
        if (seen && seen > d.updated_at) { q.notified.run(d.id); continue; }
        if (await turnNotice(d, null, { late: true })) out.late++;
      }
      for (const d of q.remindDue.all({ now: t, before: REMIND_BEFORE })) {
        q.reminded.run(d.id);
        const foe = nameOf(otherOf(d, moverOf(d)));
        const ok = await ping(d, moverOf(d), `⏳ Осталось 2 часа на ход против ${foe}.\n`
          + `Не успеешь — ход пропадёт, а ${MAX_SKIPS} пропуска подряд — поражение.`);
        if (ok) out.reminded++;
      }
      for (const { id } of q.staleOpen.all(t - OPEN_TTL)) q.cancel.run(t, t, id);
    } finally {
      ticking = false;
    }
    return out;
  }

  return {
    list, create, join, get, submit, resign, tick, view,
    byId: (id) => q.byId.get(Number(id)),
    byCode: (c) => q.byCode.get(String(c ?? '').toUpperCase()) ?? null,
  };
}
