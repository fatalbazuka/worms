/**
 * Промокоды: код → коробки, монеты и/или скин.
 *
 * Один код — одна активация на игрока. У кода может быть лимит активаций
 * всего и срок. Выдача — обычной записью в bonus (reason = 'promo'), так что
 * игра забирает подарок тем же путём, что покупки и подарки админа
 * (/api/shop → owned).
 *
 * Код хранится в нижнем регистре: «SKIPPER77» и «skipper77» — одно и то же.
 */
import { SKIN_IDS } from './shop.mjs';

const CODE_RE = /^[a-z0-9_-]{3,32}$/;

export function normCode(code) {
  return String(code ?? '').trim().toLowerCase();
}

export function createPromos({ db, now = () => Date.now() }) {
  const q = {
    get: db.prepare('select * from promo where code = ?'),
    add: db.prepare(`insert into promo (code, boxes, coins, skin, max_uses, expires_at, created_at)
                     values (?, ?, ?, ?, ?, ?, ?)`),
    list: db.prepare('select * from promo order by created_at desc limit 100'),
    used: db.prepare('select 1 from promo_use where code = ? and player_id = ?'),
    use: db.prepare('insert into promo_use (code, player_id, created_at) values (?, ?, ?)'),
    bump: db.prepare('update promo set uses = uses + 1 where code = ?'),
    disable: db.prepare('update promo set disabled_at = ? where code = ? and disabled_at is null'),
    bonus: db.prepare(`insert into bonus (player_id, boxes, coins, skin, reason, ref, created_at)
                       values (?, ?, ?, ?, 'promo', ?, ?)`),
  };

  const view = (p) => p && ({
    code: p.code, boxes: p.boxes, coins: p.coins, skin: p.skin,
    maxUses: p.max_uses, uses: p.uses, expiresAt: p.expires_at,
    disabled: Boolean(p.disabled_at), createdAt: p.created_at,
  });

  /** Завести код. days — срок в днях (0/пусто — бессрочный), maxUses — лимит (0/пусто — без лимита). */
  function create({ code, boxes = 0, coins = 0, skin = null, maxUses = null, days = null } = {}) {
    const c = normCode(code);
    if (!CODE_RE.test(c)) return { ok: false, error: 'код — 3–32 знака: латиница, цифры, _ и -' };
    const b = Math.max(0, Math.min(99, Math.floor(Number(boxes) || 0)));
    const m = Math.max(0, Math.min(100000, Math.floor(Number(coins) || 0)));
    const s = skin ? String(skin) : null;
    if (s && !SKIN_IDS.includes(s)) return { ok: false, error: 'нет такого скина' };
    if (!b && !m && !s) return { ok: false, error: 'код ничего не даёт: укажи коробки, монеты или скин' };
    if (q.get.get(c)) return { ok: false, error: 'такой код уже есть' };
    const lim = Math.floor(Number(maxUses) || 0) || null;
    const d = Number(days) || 0;
    const exp = d > 0 ? now() + d * 86400_000 : null;
    q.add.run(c, b, m, s, lim, exp, now());
    return { ok: true, promo: view(q.get.get(c)) };
  }

  /**
   * Активировать код игроком. @returns {{ok, boxes, coins, skin} | {ok:false, status, error}}
   */
  function redeem(playerId, code) {
    const c = normCode(code);
    const p = CODE_RE.test(c) ? q.get.get(c) : null;
    if (!p || p.disabled_at) return { ok: false, status: 404, error: 'нет такого промокода' };
    if (p.expires_at && now() > p.expires_at) return { ok: false, status: 410, error: 'срок промокода истёк' };
    if (p.max_uses && p.uses >= p.max_uses) return { ok: false, status: 410, error: 'промокод закончился' };
    if (q.used.get(c, playerId)) return { ok: false, status: 409, error: 'ты уже активировал этот промокод' };
    db.exec('begin');
    try {
      q.use.run(c, playerId, now());
      q.bump.run(c);
      q.bonus.run(playerId, p.boxes, p.coins, p.skin, c, now());
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      // Два нажатия разом: второе упрётся в первичный ключ promo_use
      if (/UNIQUE|PRIMARY/i.test(String(e?.message))) return { ok: false, status: 409, error: 'ты уже активировал этот промокод' };
      throw e;
    }
    return { ok: true, boxes: p.boxes, coins: p.coins, skin: p.skin };
  }

  function list() { return q.list.all().map(view); }

  function disable(code) {
    const r = q.disable.run(now(), normCode(code));
    return r.changes ? { ok: true } : { ok: false, error: 'нет такого действующего кода' };
  }

  return { create, redeem, list, disable };
}
