/**
 * Админка: данные и действия для страницы /admin.
 *
 * Вход — только админам (их Telegram ID в ADMIN_TG_IDS):
 *   • бот на /admin присылает одноразовую ссылку …/admin/?key=… на 10 минут;
 *     страница меняет ключ на обычный токен входа (POST /api/admin/enter);
 *   • или логин и пароль, выданные командой /web, — тот же вход, что с сайта.
 * Дальше все /api/admin/* проверяют токен и что это админ.
 *
 * Что умеет: сводка с графиками по дням, поиск и карточка игрока, бан,
 * подарок (монеты, коробки, скин — игра заберёт при следующем входе),
 * турниры, рассылка от бота (с превью и подтверждением) и копия базы.
 */
import { randomBytes } from 'node:crypto';
import { hashPassword, newPassword } from './lib/accounts.js';
import { mkdtempSync, rmSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY_TTL = 10 * 60_000;
const SEND_GAP = 50;          // мс между сообщениями рассылки: ~20 в секунду

export function createAdmin({ db, players, analytics, tournaments, shop, saves, api, now = () => Date.now(), log = console }) {
  const keys = new Map();      // одноразовый ключ → { playerId, exp }
  const q = {
    totals: db.prepare(`select count(*) as players,
                          sum(case when banned_at is not null then 1 else 0 end) as banned,
                          sum(case when created_at >= ? then 1 else 0 end) as fresh7
                        from player where sim is null`),
    stars: db.prepare(`select coalesce(sum(amount), 0) as all_time,
                         coalesce(sum(case when created_at >= ? then amount else 0 end), 0) as week
                       from payment where refunded_at is null`),
    payments: db.prepare('select * from payment where player_id = ? order by created_at desc limit 30'),
    bonus: db.prepare('select * from bonus where player_id = ? order by created_at desc limit 30'),
    events: db.prepare('select day, name, props, created_at from event where player_id = ? order by id desc limit 30'),
    refs: db.prepare('select count(*) as n from player where referred_by = ?'),
    recipients: db.prepare(`select id, tg_id from player
                            where tg_id is not null and banned_at is null and remind = 1`),
    bcAdd: db.prepare('insert into broadcast (text, total, created_at) values (?, ?, ?)'),
    bcStep: db.prepare('update broadcast set sent = ?, failed = ? where id = ?'),
    bcDone: db.prepare('update broadcast set done_at = ? where id = ?'),
    bc: db.prepare('select * from broadcast where id = ?'),
    bcList: db.prepare('select * from broadcast order by id desc limit 10'),
  };

  // --------------------------------------------------------------- вход

  /** Одноразовый ключ для ссылки из бота. */
  function newKey(playerId) {
    const key = randomBytes(18).toString('base64url');
    keys.set(key, { playerId, exp: now() + KEY_TTL });
    return key;
  }

  /** Обменять ключ на id игрока; ключ сгорает. */
  function useKey(key) {
    const k = keys.get(String(key ?? ''));
    keys.delete(String(key ?? ''));
    for (const [id, v] of keys) if (v.exp < now()) keys.delete(id);
    if (!k || k.exp < now()) return null;
    return k.playerId;
  }

  // ------------------------------------------------------------- данные

  function overview() {
    const week = now() - 7 * 86400_000;
    const t = q.totals.get(week);
    return {
      ...analytics.stats(14),
      totals: { players: t.players, banned: t.banned ?? 0, fresh7: t.fresh7 ?? 0 },
      stars: q.stars.get(week),
    };
  }

  function search(text) {
    return players.search(text, 50);
  }

  /** Прогресс из копии на сервере: монеты, скины, серия, «Подъём». */
  function progress(playerId) {
    const items = saves.all(playerId);
    const parse = (k) => { try { return JSON.parse(items[k] ?? 'null'); } catch { return null; } };
    const daily = parse('worms.daily.v1');
    const skins = parse('worms.skins.v1');
    const ascent = parse('worms.ascent.v1');
    return {
      coins: daily?.coins ?? null,
      streak: daily?.streak ?? null,
      skins: skins?.owned ?? null,
      equipped: skins?.equipped ?? null,
      boxes: skins?.boxes ?? null,
      ascent: Array.isArray(ascent) ? ascent.length : null,
    };
  }

  function card(id) {
    const p = players.byId(String(id ?? ''));
    if (!p) return null;
    const { pass_hash: _hidden, ...row } = p;
    return {
      player: { ...row, hasPassword: Boolean(p.pass_hash), admin: players.isAdmin(p) },
      progress: progress(p.id),
      payments: q.payments.all(p.id).map((r) => ({ ...r })),
      gifts: q.bonus.all(p.id).map((r) => ({ ...r })),
      duels: players.duelHistory(p.id, 15),
      events: q.events.all(p.id).map((r) => ({ ...r })),
      referrals: q.refs.get(p.id).n,
    };
  }

  // ------------------------------------------------------------ действия

  function setBan(id, on) {
    const p = players.byId(String(id ?? ''));
    if (!p) return { ok: false, error: 'нет такого игрока' };
    if (on && players.isAdmin(p)) return { ok: false, error: 'админа не банят' };
    players.setBan(p.id, on);
    return { ok: true };
  }

  async function gift(id, body) {
    const p = players.byId(String(id ?? ''));
    if (!p) return { ok: false, error: 'нет такого игрока' };
    const r = shop.gift(p.id, body);
    if (r.ok && body.notify && p.tg_id && api.enabled) {
      const parts = [r.coins && `${r.coins} монет`, r.boxes && `коробок: ${r.boxes}`, r.skin && `скин «${r.skin}»`].filter(Boolean);
      api.call('sendMessage', { chat_id: p.tg_id, text: `🎁 Тебе подарок: ${parts.join(', ')}. Открой игру — он уже там.` })
        .catch(() => {});
    }
    return r;
  }

  // ------------------------------------------------- аккаунты для сайта

  const LOGIN_RE = /^[a-z0-9_.-]{3,24}$/;

  /** Пароль: свой (6–64 знака) или придуманный. */
  function pickPassword(password) {
    const p = String(password ?? '');
    if (!p) return { password: newPassword(), generated: true };
    if (p.length < 6 || p.length > 64) return { error: 'пароль — от 6 до 64 знаков' };
    return { password: p, generated: false };
  }

  /**
   * Отдельный аккаунт только для сайта — для тех, у кого нет Telegram.
   * Вход на сайте логином и паролем, прогресс хранится на сервере.
   */
  function createAccount({ login, name, password } = {}) {
    const l = String(login ?? '').trim().toLowerCase();
    if (!LOGIN_RE.test(l)) return { ok: false, error: 'логин: 3–24 знака — латиница, цифры, _ . -' };
    if (players.byLogin(l)) return { ok: false, error: `логин «${l}» уже занят` };
    const nick = String(name ?? '').trim().slice(0, 24) || l;
    const pw = pickPassword(password);
    if (pw.error) return { ok: false, error: pw.error };
    const p = players.createWeb(l, nick, hashPassword(pw.password));
    return { ok: true, id: p.id, login: l, name: p.name, password: pw.generated ? pw.password : null };
  }

  /** Новый пароль (и при желании логин) уже существующему игроку. */
  function setPassword(id, { login, password } = {}) {
    const p = players.byId(String(id ?? ''));
    if (!p) return { ok: false, error: 'нет такого игрока' };
    const l = String(login ?? p.name_key ?? '').trim().toLowerCase();
    if (!LOGIN_RE.test(l)) return { ok: false, error: 'логин: 3–24 знака — латиница, цифры, _ . -' };
    const taken = players.byLogin(l);
    if (taken && taken.id !== p.id) return { ok: false, error: `логин «${l}» уже занят` };
    const pw = pickPassword(password);
    if (pw.error) return { ok: false, error: pw.error };
    players.setLogin(p.id, l, hashPassword(pw.password));
    return { ok: true, login: l, password: pw.generated ? pw.password : null };
  }

  // ----------------------------------------------------------- рассылка

  /** Сколько человек получит рассылку: с Telegram, не в бане, не отписались. */
  function audience() {
    return q.recipients.all();
  }

  /** Запустить рассылку в фоне. @returns id записи */
  function broadcast(text) {
    const msg = String(text ?? '').trim().slice(0, 3500);
    if (!msg) return { ok: false, error: 'пустой текст' };
    if (!api.enabled) return { ok: false, error: 'бот не настроен' };
    const list = audience();
    const id = Number(q.bcAdd.run(msg, list.length, now()).lastInsertRowid);
    (async () => {
      let sent = 0, failed = 0;
      for (const r of list) {
        try {
          const res = await api.call('sendMessage', { chat_id: r.tg_id, text: msg });
          if (res) sent++; else failed++;
        } catch { failed++; }
        if ((sent + failed) % 10 === 0) q.bcStep.run(sent, failed, id);
        await new Promise((ok) => setTimeout(ok, SEND_GAP));
      }
      q.bcStep.run(sent, failed, id);
      q.bcDone.run(now(), id);
      log.log?.(`[admin] рассылка #${id}: доставлено ${sent}, не дошло ${failed}`);
    })().catch((e) => log.error?.('[admin] рассылка', e));
    return { ok: true, id, total: list.length };
  }

  // -------------------------------------------------------- копия базы

  /** Снимок базы во временный файл: { path, size, cleanup }. */
  function snapshot() {
    const dir = mkdtempSync(join(tmpdir(), 'worms-admin-'));
    const path = join(dir, `smiles-${new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);
    db.exec(`vacuum into '${path.replace(/'/g, "''")}'`);
    return { path, size: statSync(path).size, stream: () => createReadStream(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  return {
    newKey, useKey, overview, search, card, setBan, gift, audience, broadcast, createAccount, setPassword,
    broadcasts: () => q.bcList.all().map((r) => ({ ...r })),
    broadcastStatus: (id) => q.bc.get(Number(id)) ?? null,
    tours: () => tournaments.list(null),
    snapshot,
  };
}
