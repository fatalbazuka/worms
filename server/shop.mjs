/**
 * Магазин за звёзды и подарки.
 *
 * Что куплено и что подарено, знает только сервер — это его и не даёт
 * накрутить. Игра при входе спрашивает owned(): сколько всего коробок
 * игроку положено (куплено + подарено) и какие скины куплены напрямую, и
 * применяет разницу к своему сохранению (platform/skins.js). Так покупка не
 * теряется, даже если игрок сменил телефон или стёр данные.
 *
 * Возврат звёзд (refundStarPayment) покупку из owned убирает, но уже
 * открытое не отбирает: коробку, ставшую скином, назад не забрать.
 *
 * Подарки (таблица bonus): коробка обоим за приглашённого друга. Друг
 * должен быть новым — прийти в игру впервые по ссылке t.me/бот?startapp=
 * ref_<tg id>. С одного пригласившего — не больше REF_LIMIT подарков.
 */

/** Скины, которые можно купить напрямую. Тот же список — в src/core/skins.js. */
export const SKIN_NAMES = {
  ice: 'Ледышка', alien: 'Пришелец', toxic: 'Токсик', pumpkin: 'Тыква',
  rage: 'Злюка', devil: 'Чертёнок', clown: 'Клоун',
  cool: 'Крутой', nerd: 'Ботаник', sleepy: 'Соня', ninja: 'Ниндзя', pirate: 'Пират',
  robot: 'Робот', astro: 'Космонавт', king: 'Король', rainbow: 'Радуга',
};
export const SKIN_IDS = Object.keys(SKIN_NAMES);

export const SHOP = [
  { id: 'box1', title: 'Коробка со скином', stars: 25, boxes: 1 },
  { id: 'box5', title: '5 коробок со скинами', stars: 99, boxes: 5 },
];
export const SKIN_STARS = 60;
export const REF_LIMIT = 20;

/**
 * Товар по ref из счёта: «box1», «box5» или «skin-devil». Двоеточия в ref
 * быть не может: им разделены части полезной нагрузки счёта.
 */
export function shopItem(ref) {
  const box = SHOP.find((i) => i.id === ref);
  if (box) return { ...box, kind: 'boxes' };
  const m = /^skin[-:]([a-z]+)$/.exec(String(ref ?? ''));
  if (m && SKIN_IDS.includes(m[1])) {
    return { id: `skin-${m[1]}`, title: `Скин «${SKIN_NAMES[m[1]]}»`, stars: SKIN_STARS, kind: 'skin', skin: m[1] };
  }
  return null;
}

export function createShop({ db, now = () => Date.now() }) {
  const q = {
    paid: db.prepare(`select ref from payment
                      where player_id = ? and purpose = 'shop' and refunded_at is null`),
    bonus: db.prepare('select coalesce(sum(boxes), 0) as n, coalesce(sum(coins), 0) as coins from bonus where player_id = ?'),
    giftSkins: db.prepare('select distinct skin from bonus where player_id = ? and skin is not null'),
    giftAdd: db.prepare(`insert into bonus (player_id, boxes, coins, skin, reason, ref, created_at)
                         values (?, ?, ?, ?, 'admin', ?, ?)`),
    bonusAdd: db.prepare('insert into bonus (player_id, boxes, reason, ref, created_at) values (?, ?, ?, ?, ?)'),
    refCount: db.prepare("select count(*) as n from bonus where reason = 'ref-host' and player_id = ?"),
    referred: db.prepare('update player set referred_by = ? where id = ? and referred_by is null'),
  };

  /**
   * Что положено игроку: всего коробок (куплено + подарено), монет в
   * подарок от админа, скины (купленные и подаренные) и сколько друзей
   * он привёл. Всё — итогами:
   * игра сама помнит, сколько уже положила, и добавляет только разницу.
   */
  function owned(playerId) {
    const b = q.bonus.get(playerId);
    let boxes = b.n;
    const coins = b.coins;
    const skins = new Set(q.giftSkins.all(playerId).map((r) => r.skin));
    for (const { ref } of q.paid.all(playerId)) {
      const it = shopItem(ref);
      if (it?.kind === 'boxes') boxes += it.boxes;
      if (it?.kind === 'skin') skins.add(it.skin);
    }
    // invited — сколько друзей пришло по ссылке игрока: игре для достижения
    return { boxes, coins, skins: [...skins], invited: q.refCount.get(playerId).n };
  }

  /**
   * Новичок пришёл по ссылке друга: обоим по коробке. Вызывается только
   * для только что созданного игрока.
   * @returns {string|null} id пригласившего, если подарок выдан
   */
  function referral(newcomer, startParam, players) {
    const m = /^ref_(\d{1,15})$/.exec(String(startParam ?? ''));
    if (!m) return null;
    const host = players.byId(`tg${m[1]}`);
    if (!host || host.id === newcomer.id) return null;
    if (q.refCount.get(host.id).n >= REF_LIMIT) return null;
    if (q.referred.run(host.id, newcomer.id).changes === 0) return null;
    const t = now();
    q.bonusAdd.run(host.id, 1, 'ref-host', newcomer.id, t);
    q.bonusAdd.run(newcomer.id, 1, 'ref-guest', host.id, t);
    return host.id;
  }

  /**
   * Подарок от админа: монеты, коробки и/или скин. Игра заберёт его при
   * следующем входе (owned). note — за что, видно в карточке игрока.
   */
  function gift(playerId, { coins = 0, boxes = 0, skin = null, note = '' } = {}) {
    const c = Math.max(0, Math.min(1_000_000, Math.floor(Number(coins) || 0)));
    const b = Math.max(0, Math.min(99, Math.floor(Number(boxes) || 0)));
    const s = skin && SKIN_IDS.includes(skin) ? skin : null;
    if (!c && !b && !s) return { ok: false, error: 'нечего дарить' };
    q.giftAdd.run(playerId, b, c, s, String(note || '').slice(0, 120) || null, now());
    return { ok: true, coins: c, boxes: b, skin: s };
  }

  return { owned, referral, gift };
}
