/**
 * Бот: команды, звёзды, сообщения игрокам.
 *
 * Telegram присылает обновления на вебхук (/api/bot/webhook) с секретом в
 * заголовке — без него запрос отклоняется. Бот отвечает на команды,
 * принимает оплату звёздами и пишет игрокам о турнирах, а о друзьях —
 * «обогнал» и вызов на бой (server/friends.mjs, с лимитами и /mute).
 * «Твой ход» не пишет — так решено.
 *
 * Звёзды (валюта XTR). Счёт создаётся сервером (createInvoiceLink), мини-
 * приложение открывает его родным окном Telegram. Перед списанием Telegram
 * спрашивает бота (pre_checkout_query) — тот проверяет, что покупка ещё
 * возможна (например, в турнире есть место); после списания приходит
 * successful_payment — запись в базу и выдача. Вернуть звёзды можно
 * (refundStarPayment), раздать игрокам как приз — нет: такого метода у
 * ботов нет.
 *
 * Полезная нагрузка счёта: «donate:<сумма>:<игрок>» или
 * «tour:<турнир>:<игрок>» — не длиннее 128 байт.
 */
import { createHash, randomInt } from 'node:crypto';
import { shopItem } from './shop.mjs';
import { hashPassword, newPassword } from './lib/accounts.js';

export const DONATE_AMOUNTS = [10, 50, 100];

/**
 * Описание бота. long — экран до «Старт» (до 512 знаков), short — профиль
 * бота и превью ссылки (до 120). '' — по умолчанию (русский), en — английский.
 */
export const DESCRIPTIONS = {
  '': {
    short: 'Smiles — пошаговая артиллерия со смайликами: башня, трос, рогатка, 18 видов оружия, онлайн и турниры.',
    long: '💥 Smiles — пошаговая артиллерия со смайликами прямо в Telegram.\n\n'
      + '🏰 Бои на высокой башне: цепляйся тросом, стреляй рогаткой, роняй врагов с этажей.\n'
      + '🎯 18 видов оружия: сплит-ракета, бумеранг, самонаводка, святая граната — и ящики с редкостью.\n'
      + '🤝 Онлайн-дуэли, турниры, таблица дня. Вызови друга из любого чата.\n'
      + '🎁 Задания каждый день, серия, скины и кампания с боссами.\n\n'
      + 'Жми «Старт» — и в бой!',
  },
  en: {
    short: 'Smiles — turn-based smiley artillery: a tower, a grappling rope, a slingshot, 18 weapons, online duels.',
    long: '💥 Smiles — turn-based smiley artillery right in Telegram.\n\n'
      + '🏰 Battle on a tall tower: swing on a rope, shoot with a slingshot, knock enemies off the floors.\n'
      + '🎯 18 weapons: split rocket, boomerang, homing missile, holy grenade — plus crates with rarity.\n'
      + '🤝 Online duels, tournaments, a daily leaderboard. Challenge a friend from any chat.\n'
      + '🎁 Daily tasks, streaks, skins and a campaign with bosses.\n\n'
      + 'Tap «Start» and fight!',
  },
};

export function webhookSecret(token, explicit = '') {
  if (explicit) return explicit;
  return createHash('sha256').update(`worms-webhook:${token}`).digest('hex').slice(0, 48);
}

export function createBot({ db, api, players, tournaments, analytics = null, admin: adminPanel = null, adminIds = new Set(), publicUrl = '',
  tz = 'Europe/Moscow', now = () => Date.now(), log = console, appName = '', promos = null }) {
  const q = {
    payAdd: db.prepare(`insert or ignore into payment (charge_id, player_id, tg_id, amount, purpose, ref, created_at)
                        values (?, ?, ?, ?, ?, ?, ?)`),
    pay: db.prepare('select * from payment where charge_id = ?'),
    payRefunded: db.prepare('update payment set refunded_at = ? where charge_id = ?'),
    payTotal: db.prepare("select coalesce(sum(amount), 0) as s, count(*) as n from payment where refunded_at is null"),
  };
  let username = '';
  const appUrl = (params = '') => (publicUrl ? `${publicUrl.replace(/\/+$/, '')}/${params}` : '');
  const playButton = (text = '🎮 Играть', params = '') => (publicUrl
    ? { inline_keyboard: [[{ text, web_app: { url: appUrl(params) } }]] } : undefined);

  /** Английский — тем, у кого Telegram не на русском и не на соседнем языке. */
  const enOf = (from) => {
    const c = String(from?.language_code ?? '');
    return c !== '' && !/^(ru|uk|be|kk|ky|uz|tg|tt|ba|hy|az|ka|mn)\b/i.test(c);
  };
  const play = (en) => playButton(en ? '🎮 Play' : '🎮 Играть');

  async function send(chatId, text, markup, { silent = false } = {}) {
    return api.call('sendMessage', {
      chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}), ...(silent ? { disable_notification: true } : {}),
    });
  }

  /**
   * Сообщение игроку по id. tour — кнопка сразу в экран турнира; button и
   * params — своя кнопка в игру (params — хвост адреса: «?top=friends»).
   */
  async function notify(playerId, text, { tour = null, button = null, params = '' } = {}) {
    const p = players.byId(playerId);
    if (!p?.tg_id) return null;
    if (tour) return send(p.tg_id, text, playButton('🏆 Открыть турнир', `?tour=${tour}`));
    return send(p.tg_id, text, playButton(button ?? '🎮 Играть', params));
  }

  /**
   * Вызов на бой от друга: кнопка открывает игру сразу в его комнате башни
   * (?room=, как ссылка-приглашение вне Telegram). Кто, кому и как часто —
   * решает server/friends.mjs. silent — ночью без звука.
   */
  async function inviteDuel(to, from, room, { silent = false } = {}) {
    if (!to?.tg_id || !publicUrl || !/^ZW[A-Z0-9]{2,10}$/.test(room)) return null;
    return send(to.tg_id, `⚔️ ${from.name} вызывает тебя на бой в Smiles!\n`
      + 'Башня, трос и рогатка — комната уже ждёт, жми кнопку.\n\n/mute — не писать о серии и друзьях',
    playButton('⚔️ Принять вызов', `?room=${room}`), { silent });
  }

  async function notifyAdmins(text) {
    for (const id of adminIds) await send(id, text);
  }

  // ------------------------------------------------------------- звёзды

  async function invoice({ purpose, ref, player, amount, title, description }) {
    return api.call('createInvoiceLink', {
      title, description,
      payload: `${purpose}:${ref}:${player.id}`.slice(0, 128),
      currency: 'XTR',
      prices: [{ label: title, amount }],
    });
  }

  function donateInvoice(player, amount) {
    if (!DONATE_AMOUNTS.includes(amount)) return null;
    return invoice({
      purpose: 'donate', ref: String(amount), player, amount,
      title: `Поддержать игру — ${amount} ⭐`,
      description: 'Спасибо! Звёзды идут на сервер и развитие игры.',
    });
  }

  function tourInvoice(player, t) {
    return invoice({
      purpose: 'tour', ref: String(t.id), player, amount: t.fee,
      title: `Взнос: ${t.name}`,
      description: `Участие в турнире «${t.name}» (${t.size} мест).`,
    });
  }

  function shopInvoice(player, item) {
    return invoice({
      purpose: 'shop', ref: item.id, player, amount: item.stars,
      title: item.title,
      description: item.kind === 'skin'
        ? 'Скин бойца навсегда. Только внешность — на бой не влияет.'
        : 'Внутри — случайный скин, которого у тебя ещё нет. На бой не влияет.',
    });
  }

  function parsePayload(s) {
    const [purpose, ref, playerId] = String(s ?? '').split(':');
    return { purpose, ref, playerId };
  }

  async function refund(chargeId) {
    const p = q.pay.get(chargeId);
    if (!p) return false;
    if (p.refunded_at) return true;
    const ok = await api.call('refundStarPayment', { user_id: p.tg_id, telegram_payment_charge_id: chargeId });
    if (ok) q.payRefunded.run(now(), chargeId);
    return Boolean(ok);
  }

  async function onPreCheckout(pq) {
    const { purpose, ref, playerId } = parsePayload(pq.invoice_payload);
    const p = players.byId(playerId);
    let error = null;
    if (!p || Number(p.tg_id) !== Number(pq.from.id)) error = 'Счёт выписан на другого игрока.';
    else if (purpose === 'tour') {
      const t = tournaments.byId(Number(ref));
      error = tournaments.joinProblem(Number(ref), playerId);
      if (!error && t.fee !== pq.total_amount) error = 'Взнос изменился — открой турнир заново.';
    } else if (purpose === 'donate') {
      if (!DONATE_AMOUNTS.includes(pq.total_amount)) error = 'Неизвестная сумма.';
    } else if (purpose === 'shop') {
      const it = shopItem(ref);
      if (!it) error = 'Такого товара больше нет.';
      else if (it.stars !== pq.total_amount) error = 'Цена изменилась — открой магазин заново.';
    } else error = 'Неизвестная покупка.';
    await api.call('answerPreCheckoutQuery', error
      ? { pre_checkout_query_id: pq.id, ok: false, error_message: error }
      : { pre_checkout_query_id: pq.id, ok: true });
  }

  async function onPaid(msg) {
    const sp = msg.successful_payment;
    const { purpose, ref, playerId } = parsePayload(sp.invoice_payload);
    const chargeId = sp.telegram_payment_charge_id;
    const fresh = q.payAdd.run(chargeId, playerId, msg.from.id, sp.total_amount, purpose, ref, now()).changes > 0;
    if (!fresh) return;                                   // Telegram прислал повтор
    if (purpose === 'tour') {
      const t = tournaments.byId(Number(ref));
      if (tournaments.addPaid(Number(ref), playerId, chargeId)) {
        await send(msg.chat.id, `✅ Взнос принят — ты в турнире «${t?.name}».`, playButton('🏆 Открыть турнир', `?tour=${ref}`));
      } else {
        await refund(chargeId);
        await send(msg.chat.id, 'Места в турнире закончились, пока шла оплата. Звёзды вернутся на счёт.');
      }
    } else if (purpose === 'shop') {
      await send(msg.chat.id, '✅ Покупка прошла! Открой игру — она уже в твоём профиле.', playButton());
    } else {
      await send(msg.chat.id, `💛 Спасибо за ${sp.total_amount} ⭐! Это правда помогает игре.`);
    }
  }

  // ------------------------------------------------------------ команды

  function statsText(p, en = false) {
    const v = players.view(p);
    if (en) {
      const out = [
        `👤 ${v.name}`,
        `Rating: ${v.rating}${v.rank ? ` · #${v.rank}` : ''}`,
        `Wins ${v.wins} · losses ${v.losses}${v.winrate != null ? ` · ${v.winrate}%` : ''}`,
        `Streak: ${v.streak} · best ${v.bestStreak}`,
        `Tournaments won: ${v.tourneyWins}`,
      ];
      if (v.titles.length) out.push(`Titles: ${v.titles.slice(0, 3).map((t) => t.title).join(', ')}`);
      return out.join('\n');
    }
    const lines = [
      `👤 ${v.name}`,
      `Рейтинг: ${v.rating}${v.rank ? ` · место ${v.rank}` : ''}`,
      `Побед ${v.wins} · поражений ${v.losses}${v.winrate != null ? ` · ${v.winrate}%` : ''}`,
      `Серия: ${v.streak} · лучшая ${v.bestStreak}`,
      `Турниров выиграно: ${v.tourneyWins}`,
    ];
    if (v.titles.length) lines.push(`Титулы: ${v.titles.slice(0, 3).map((t) => t.title).join(', ')}`);
    return lines.join('\n');
  }

  function topText(en = false) {
    const rows = players.top(10);
    if (!rows.length) return en ? 'The leaderboard is empty — play the first online battle.' : 'Таблица пока пуста — сыграй первый бой по сети.';
    return [en ? '🏅 Top 10 by rating' : '🏅 Топ-10 по рейтингу', ...rows.map((r, i) => `${i + 1}. ${r.name} — ${r.rating}`)].join('\n');
  }

  function toursText(en = false) {
    const list = tournaments.list(null).filter((t) => t.status !== 'finished');
    if (!list.length) return en ? 'No tournaments right now. Stay tuned!' : 'Сейчас турниров нет. Следи за анонсами!';
    if (en) {
      return ['🏆 Tournaments', ...list.map((t) => `#${t.id} «${t.name}» — ${t.status === 'open'
        ? `sign-up ${t.count}/${t.size}${t.fee ? `, fee ${t.fee} ⭐` : ''}` : 'in progress'}`)].join('\n');
    }
    return ['🏆 Турниры', ...list.map((t) => `#${t.id} «${t.name}» — ${t.status === 'open'
      ? `запись ${t.count}/${t.size}${t.startsAt ? `, старт ${fmtTime(t.startsAt)}` : ''}${t.fee ? `, взнос ${t.fee} ⭐` : ''}`
      : 'идёт'}`)].join('\n');
  }

  function fmtTime(ms) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      .format(new Date(ms));
  }

  /** «20:00» — сегодня (или завтра, если прошло) в часовом поясе бота; «+30» — через 30 минут. */
  function parseStart(token) {
    let m = /^\+(\d{1,4})$/.exec(token);
    if (m) return now() + Number(m[1]) * 60_000;
    m = /^(\d{1,2}):(\d{2})$/.exec(token);
    if (!m) return undefined;
    const d = new Date(now());
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    // Сдвиг пояса = локальное время в поясе минус UTC
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    const offset = asUtc - Math.floor(d.getTime() / 60_000) * 60_000;
    let at = Date.UTC(+parts.year, +parts.month - 1, +parts.day, Number(m[1]), Number(m[2])) - offset;
    if (at <= now()) at += 86400_000;
    return at;
  }

  const ADMIN_HELP = [
    'Команды админа:',
    '/newtour 8 [20:00 | +30] [взнос=0] [название] — новый турнир на 4/8/16 мест',
    '/starttour ID — начать сейчас',
    '/canceltour ID — отменить (взносы вернутся)',
    '/settle МАТЧ 1|2 — решить спорный матч',
    '/refund CHARGE_ID — вернуть платёж звёздами',
    '/stars — сколько звёзд пришло',
    '/metrics — игроки, новички, бои, возврат на второй день',
    '/web TG_ID логин — выдать вход на сайт (пароль придумаю сам; повтор — новый пароль)',
    '/newweb логин [имя] — отдельный аккаунт только для сайта, без Telegram',
    '/newpromo КОД [коробок=3] [монет=0] [скин=id] [раз=100] [дней=30] — новый промокод',
    '/promos — промокоды и сколько активировали · /delpromo КОД — выключить',
  ].join('\n');

  /**
   * /start: ролик с боем, пара строк и кнопка «Играть». Ролик лежит у игры
   * (assets/promo/welcome.mp4); не отправился — просто текст.
   * Англоязычным — кнопка меню «Play» в их чате (у всех остальных «Играть»).
   */
  async function welcome(chat, me, en, from) {
    const text = en
      ? `Hi, ${me.name}! This is Smiles — turn-based smiley artillery right in Telegram.\n\n`
        + 'Tower battles with a grappling rope and a slingshot, 18 weapons, daily tasks, skins, '
        + 'online duels and tournaments.\n\n'
        + 'Challenge a friend from any chat: type @' + (username || 'bot') + ' and pick «Challenge to a duel».'
      : `Привет, ${me.name}! Это Smiles — пошаговая артиллерия со смайликами прямо в Telegram.\n\n`
        + 'Бои на башне с тросом и рогаткой, 18 видов оружия, задания каждый день, скины, '
        + 'онлайн-дуэли и турниры.\n\n'
        + 'Вызвать друга можно из любого чата: напиши @' + (username || 'бот') + ' и выбери «Вызвать на дуэль».';
    if (en && publicUrl) {
      await api.call('setChatMenuButton', { chat_id: chat, menu_button: { type: 'web_app', text: 'Play', web_app: { url: appUrl() } } });
    }
    if (publicUrl) {
      const sent = await api.call('sendAnimation', {
        chat_id: chat, animation: appUrl('assets/promo/welcome.mp4'), caption: text, reply_markup: play(en),
      });
      if (sent) return sent;
    }
    return send(chat, text, play(en));
  }

  async function onCommand(msg) {
    const text = String(msg.text ?? '').trim();
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.replace(/@.*$/, '').toLowerCase();
    const chat = msg.chat.id;
    const me = players.upsertTg(msg.from);
    const admin = players.isAdmin(me);

    const en = enOf(msg.from);
    switch (cmd) {
      case '/start':
        return welcome(chat, me, en, msg.from);
      case '/stats': return send(chat, statsText(me, en), play(en));
      case '/top': return send(chat, topText(en), play(en));
      case '/tours': return send(chat, toursText(en), playButton(en ? '🏆 Tournaments' : '🏆 Турниры', '?tour=list'));
      case '/id':
        return send(chat, en ? `Your id: ${msg.from.id}. The admin needs it to give you a website login.`
          : `Твой id: ${msg.from.id}. Его спросит админ, чтобы выдать вход на сайт.`);
      case '/help':
        return send(chat, (en
          ? '/stats — your stats\n/top — top 10\n/tours — tournaments\n/promo CODE — activate a promo code\n/id — your id\n/mute — no reminders or friend messages\n/unmute — turn them back on'
          : '/stats — статистика\n/top — топ-10\n/tours — турниры\n/promo КОД — активировать промокод\n/id — твой id'
          + '\n/mute — не писать о серии и друзьях\n/unmute — снова писать')
          + (admin ? `\n\n${ADMIN_HELP}` : ''), play(en));
      case '/promo': {
        if (!promos) break;
        if (!args[0]) return send(chat, en ? 'Usage: /promo CODE' : 'Напиши так: /promo КОД', play(en));
        const r = promos.redeem(me.id, args[0]);
        if (!r.ok) return send(chat, `❌ ${r.error}`, play(en));
        const got = [r.boxes && `коробок: ${r.boxes}`, r.coins && `монет: ${r.coins}`, r.skin && `скин «${r.skin}»`].filter(Boolean).join(', ');
        return send(chat, en ? `🎁 Code activated: ${got}. Open the game — it's already there.`
          : `🎁 Промокод активирован: ${got}. Открой игру — всё уже там.`, play(en));
      }
      case '/mute':
        analytics?.setRemind(me.id, false);
        // Один выключатель на всё, что бот пишет сам: серия, «друг обогнал»,
        // вызовы на бой от друзей (их игра пошлёт карточкой через выбор чата)
        return send(chat, en ? "OK, no more streak reminders or friend messages. /unmute — turn them back on."
          : 'Хорошо, больше не пишу сам: ни о серии, ни о друзьях. /unmute — вернуть.');
      case '/unmute':
        analytics?.setRemind(me.id, true);
        return send(chat, en ? "I'll remind you in the evening if your daily streak is about to burn, and tell you when a friend overtakes you."
          : 'Буду напоминать вечером, если серия дней вот-вот сгорит, и напишу, если друг тебя обгонит.');
      default: break;
    }
    if (!admin) return send(chat, en ? "I don't know that command. /help — what I can do." : 'Не знаю такой команды. /help — что я умею.', play(en));

    switch (cmd) {
      case '/newpromo': {
        if (!promos) return send(chat, 'промокоды недоступны');
        const o = { code: args[0] };
        for (const a of args.slice(1)) {
          const m = /^(коробок|boxes|монет|coins|скин|skin|раз|uses|дней|days)=(\S+)$/i.exec(a);
          if (!m) continue;
          const k = m[1].toLowerCase();
          if (k === 'коробок' || k === 'boxes') o.boxes = m[2];
          else if (k === 'монет' || k === 'coins') o.coins = m[2];
          else if (k === 'скин' || k === 'skin') o.skin = m[2];
          else if (k === 'раз' || k === 'uses') o.maxUses = m[2];
          else o.days = m[2];
        }
        // Без параметров — 3 коробки, как чаще всего и нужно
        if (o.boxes === undefined && o.coins === undefined && o.skin === undefined) o.boxes = 3;
        const r = promos.create(o);
        if (!r.ok) return send(chat, `Не вышло: ${r.error}`);
        const p = r.promo;
        return send(chat, `🎟 Промокод ${p.code.toUpperCase()}: `
          + [p.boxes && `коробок ${p.boxes}`, p.coins && `монет ${p.coins}`, p.skin && `скин ${p.skin}`].filter(Boolean).join(', ')
          + `${p.maxUses ? ` · до ${p.maxUses} активаций` : ' · без лимита'}${p.expiresAt ? ` · до ${fmtTime(p.expiresAt)}` : ''}.\n`
          + `Игрок вводит его в игре (Скины → Промокод) или пишет боту /promo ${p.code}`);
      }
      case '/promos': {
        if (!promos) return send(chat, 'промокоды недоступны');
        const list = promos.list();
        if (!list.length) return send(chat, 'Промокодов нет. /newpromo КОД коробок=3');
        return send(chat, ['🎟 Промокоды', ...list.slice(0, 30).map((p) => `${p.disabled ? '⛔' : '✅'} ${p.code.toUpperCase()} — `
          + [p.boxes && `${p.boxes} кор.`, p.coins && `${p.coins} мон.`, p.skin].filter(Boolean).join(', ')
          + ` · ${p.uses}${p.maxUses ? `/${p.maxUses}` : ''} акт.`)].join('\n'));
      }
      case '/delpromo': {
        if (!promos) return send(chat, 'промокоды недоступны');
        const r = promos.disable(args[0]);
        return send(chat, r.ok ? `Промокод ${String(args[0]).toUpperCase()} выключен.` : `Не вышло: ${r.error}`);
      }
      case '/admin': {
        // Одноразовая ссылка в админку на 10 минут; без адреса сайта — только справка
        if (!adminPanel || !publicUrl) return send(chat, ADMIN_HELP);
        const link = `${publicUrl.replace(/\/$/, '')}/admin/?key=${adminPanel.newKey(me.id)}`;
        return send(chat, `🔑 Админка — ссылка одноразовая, живёт 10 минут:\n${link}\n\n${ADMIN_HELP}`,
          { inline_keyboard: [[{ text: '🔑 Открыть админку', url: link }]] });
      }
      case '/newtour': {
        const size = Number(args[0]);
        let startsAt = null;
        let fee = 0;
        const rest = [];
        for (const a of args.slice(1)) {
          const at = parseStart(a);
          const f = /^(?:взнос|fee)=(\d+)$/i.exec(a);
          if (at !== undefined && startsAt === null && rest.length === 0) startsAt = at;
          else if (f) fee = Number(f[1]);
          else rest.push(a);
        }
        try {
          const t = tournaments.create({ name: rest.join(' '), size, fee, startsAt });
          return send(chat, `Создан турнир #${t.id} «${t.name}» на ${t.size} мест`
            + `${startsAt ? `, старт ${fmtTime(startsAt)}` : ', старт — когда наберутся все или по /starttour'}`
            + `${fee ? `, взнос ${fee} ⭐` : ', бесплатно'}.`, playButton('🏆 Открыть турнир', `?tour=${t.id}`));
        } catch (e) {
          return send(chat, `Не вышло: ${e.message}\n${ADMIN_HELP}`);
        }
      }
      case '/starttour': {
        const r = tournaments.start(Number(args[0]));
        return send(chat, r.ok ? `Турнир #${args[0]} начался.` : `Не вышло: ${r.error}`);
      }
      case '/canceltour': {
        const r = await tournaments.cancel(Number(args[0]));
        return send(chat, r.ok ? `Турнир #${args[0]} отменён.` : `Не вышло: ${r.error}`);
      }
      case '/settle': {
        const r = tournaments.settle(Number(args[0]), args[1]);
        return send(chat, r.ok ? `Матч ${args[0]}: победил ${r.winner}.` : `Не вышло: ${r.error}`);
      }
      case '/refund': {
        const ok = await refund(args[0]);
        return send(chat, ok ? 'Возврат сделан.' : 'Не вышло: платежа нет или Telegram отказал.');
      }
      case '/stars': {
        const s = q.payTotal.get();
        return send(chat, `Платежей: ${s.n}, звёзд: ${s.s} ⭐ (без возвратов).`);
      }
      case '/metrics':
        return send(chat, analytics ? analytics.report() : 'Статистика не подключена.');
      case '/newweb': {
        // Аккаунт для человека без Telegram: логин и придуманный пароль
        if (!adminPanel) return send(chat, 'Админка не подключена.');
        const r = adminPanel.createAccount({ login: args[0], name: args.slice(1).join(' ') });
        if (!r.ok) return send(chat, r.error);
        const site = publicUrl ? `\nСайт: ${publicUrl}` : '';
        return send(chat, `Аккаунт для сайта «${r.name}»:\nлогин: ${r.login}\nпароль: ${r.password}${site}`);
      }
      case '/web': {
        // Вход на сайт: логин и пароль к уже существующему игроку из Telegram
        const who = players.byId(`tg${Number(args[0])}`);
        const login = String(args[1] ?? '').toLowerCase();
        if (!who) return send(chat, 'Нет такого игрока. Пусть он откроет игру или напишет боту /start, потом /id.');
        if (!/^[a-z0-9_.-]{3,24}$/.test(login)) return send(chat, 'Логин: 3–24 знака, латиница, цифры, _ . -');
        const taken = players.byLogin(login);
        if (taken && taken.id !== who.id) return send(chat, `Логин «${login}» уже занят.`);
        const password = newPassword();
        players.setLogin(who.id, login, hashPassword(password));
        const site = publicUrl ? `\nСайт: ${publicUrl}` : '';
        return send(chat, `Вход на сайт для ${who.name}:\nлогин: ${login}\nпароль: ${password}${site}`);
      }
      default:
        return send(chat, `Не знаю такой команды.\n${ADMIN_HELP}`);
    }
  }

  // ------------------------------------------------------- инлайн-вызов

  /** Ссылка в мини-приложение с кодом: t.me/бот/приложение?startapp=… */
  function startLink(param) {
    if (!username) return '';
    const base = appName ? `https://t.me/${username}/${appName}` : `https://t.me/${username}`;
    return `${base}?startapp=${encodeURIComponent(param)}`;
  }

  /** Комната башни без рейтинга — как randomRoom(true, true) в игре. */
  function towerRoom() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = 'ZW';
    while (out.length < 6) out += abc[randomInt(abc.length)];
    return out;
  }

  /**
   * @бот в любом чате: карточка «вызов на дуэль». Кнопка ведёт в одну и ту
   * же комнату башни — кто нажал первым, тот хозяин, второй садится к нему.
   * Вторая карточка — просто «позвать в игру» по рефералке.
   */
  async function onInline(iq) {
    const name = String(iq.from?.first_name ?? 'Друг').slice(0, 40);
    const en = /^en/i.test(String(iq.from?.language_code ?? '')) && !/^ru|^uk|^be|^kk/i.test(String(iq.from?.language_code ?? ''));
    const room = towerRoom();
    const duel = startLink(room);
    const ref = startLink(`ref_${iq.from?.id}`);
    if (!duel) return api.call('answerInlineQuery', { inline_query_id: iq.id, results: [], cache_time: 0 });
    const t = en ? {
      duelTitle: '⚔️ Challenge to a duel', duelDesc: 'A tower duel — tap to fight',
      duelText: `⚔️ ${name} challenges you to a duel in Smiles!
Tower, grappling hook, slingshot and smileys. Tap the button — you both land in the same battle.`,
      duelBtn: '⚔️ Accept the challenge',
      inviteTitle: '🎮 Invite to Smiles', inviteDesc: 'You both get a skin box',
      inviteText: `🎮 ${name} invites you to Smiles — smiley artillery in Telegram.
Join via this link and you both get a skin box 🎁`,
      inviteBtn: '🎮 Play',
    } : {
      duelTitle: '⚔️ Вызвать на дуэль', duelDesc: 'Бой на башне — жми и в бой',
      duelText: `⚔️ ${name} вызывает на дуэль в Smiles!
Башня, трос, рогатка и смайлики. Жми кнопку — окажетесь в одном бою.`,
      duelBtn: '⚔️ Принять вызов',
      inviteTitle: '🎮 Позвать в Smiles', inviteDesc: 'Обоим — коробка со скином',
      inviteText: `🎮 ${name} зовёт в Smiles — артиллерию смайликов в Telegram.
По этой ссылке вам обоим по коробке со скином 🎁`,
      inviteBtn: '🎮 Играть',
    };
    return api.call('answerInlineQuery', {
      inline_query_id: iq.id,
      cache_time: 0,
      is_personal: true,
      results: [
        {
          type: 'article', id: `duel-${room}`, title: t.duelTitle, description: t.duelDesc,
          input_message_content: { message_text: t.duelText },
          reply_markup: { inline_keyboard: [[{ text: t.duelBtn, url: duel }]] },
        },
        {
          type: 'article', id: `ref-${iq.from?.id}`.slice(0, 64), title: t.inviteTitle, description: t.inviteDesc,
          input_message_content: { message_text: t.inviteText },
          reply_markup: { inline_keyboard: [[{ text: t.inviteBtn, url: ref }]] },
        },
      ],
    });
  }

  // ------------------------------------------------------------- вебхук

  async function handleUpdate(update) {
    try {
      if (update.pre_checkout_query) return await onPreCheckout(update.pre_checkout_query);
      if (update.inline_query) return await onInline(update.inline_query);
      const msg = update.message;
      if (!msg?.from || msg.chat?.type !== 'private') return null;
      if (msg.successful_payment) return await onPaid(msg);
      if (typeof msg.text === 'string' && msg.text.startsWith('/')) return await onCommand(msg);
      if (typeof msg.text === 'string') {
        const en = enOf(msg.from);
        return await send(msg.chat.id, en ? 'Tap «Play» 👇' : 'Жми «Играть» 👇', play(en));
      }
    } catch (e) {
      log.error?.('[bot] обновление не обработано', e);
    }
    return null;
  }

  // -------------------------------------------------------- напоминания

  let reminding = false;
  /**
   * Вечернее напоминание о серии. Зовётся раз в полминуты; кому писать,
   * решает analytics (вчера был, сегодня нет, не отписался, сегодня ещё не
   * напоминали). Отметка ставится и при неудаче — одна попытка в день.
   */
  async function remind() {
    if (!api.enabled || !analytics || reminding) return 0;
    reminding = true;
    let sent = 0;
    try {
      for (const p of analytics.remindDue()) {
        analytics.markReminded(p.id);
        const n = p.last_streak;
        const word = n % 10 === 1 && n % 100 !== 11 ? 'день'
          : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'дня' : 'дней';
        const ok = await send(p.tg_id, `🔥 Серия ${n} ${word} подряд сгорит в полночь.\n`
          + 'Загляни: бонус дня и новые задания уже ждут.\n\n/mute — не напоминать', playButton());
        if (ok) sent++;
      }
    } finally {
      reminding = false;
    }
    return sent;
  }

  /** Настроить бота при старте: вебхук, кнопка меню, команды. */
  /** true — настроено; false — Telegram недоступен, стоит повторить позже. */
  async function setup({ secret }) {
    if (!api.enabled) return true;
    const me = await api.call('getMe');
    if (!me) { log.warn?.('[bot] Telegram недоступен — настрою позже'); return false; }
    username = me.username ?? '';
    if (!publicUrl) {
      log.warn?.('[bot] PUBLIC_URL не задан — вебхук и кнопка меню не настроены');
      return true;
    }
    const hooked = await api.call('setWebhook', {
      url: `${publicUrl.replace(/\/+$/, '')}/api/bot/webhook`, secret_token: secret,
      allowed_updates: ['message', 'pre_checkout_query', 'inline_query'], drop_pending_updates: false,
    });
    await api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: appUrl() } } });
    const base = [
      { command: 'start', description: 'Играть' },
      { command: 'stats', description: 'Моя статистика' },
      { command: 'top', description: 'Топ-10 по рейтингу' },
      { command: 'tours', description: 'Турниры' },
      { command: 'mute', description: 'Не писать о серии и друзьях' },
    ];
    await api.call('setMyCommands', { commands: base });
    await api.call('setMyCommands', {
      language_code: 'en',
      commands: [
        { command: 'start', description: 'Play' },
        { command: 'stats', description: 'My stats' },
        { command: 'top', description: 'Top 10 by rating' },
        { command: 'tours', description: 'Tournaments' },
        { command: 'mute', description: 'No reminders or friend messages' },
      ],
    });
    // Описание бота: видно до нажатия «Старт» и в каталогах
    for (const [lang, d] of Object.entries(DESCRIPTIONS)) {
      await api.call('setMyDescription', { description: d.long, ...(lang ? { language_code: lang } : {}) });
      await api.call('setMyShortDescription', { short_description: d.short, ...(lang ? { language_code: lang } : {}) });
    }
    for (const id of adminIds) {
      await api.call('setMyCommands', {
        scope: { type: 'chat', chat_id: id },
        commands: [...base,
          { command: 'newtour', description: 'Новый турнир' },
          { command: 'starttour', description: 'Начать турнир' },
          { command: 'canceltour', description: 'Отменить турнир' },
          { command: 'settle', description: 'Решить спорный матч' },
          { command: 'stars', description: 'Звёзды' },
          { command: 'metrics', description: 'Статистика игры' }],
      });
    }
    if (!hooked) { log.warn?.('[bot] вебхук не поставлен — повторю позже'); return false; }
    log.log?.(`[bot] @${username}: вебхук ${publicUrl.replace(/\/+$/, '')}/api/bot/webhook`);
    return true;
  }

  /**
   * Вызов на бой карточкой: сообщение с кнопкой «Принять вызов», которое
   * игра покажет родным окном Telegram «поделиться» (WebApp.shareMessage).
   * Кнопка — ссылка в мини-приложение сразу в комнату вызвавшего.
   * @returns {Promise<string|null>} id подготовленного сообщения
   */
  async function prepareChallenge(player, room, link) {
    if (!player?.tg_id) return null;
    const res = await api.call('savePreparedInlineMessage', {
      user_id: Number(player.tg_id),
      result: {
        type: 'article',
        id: `ch-${room}`.slice(0, 64),
        title: 'Вызов на бой ⚔️',
        description: `${player.name} зовёт на башню`,
        input_message_content: {
          message_text: `⚔️ ${player.name} вызывает тебя на бой в Smiles!\n`
            + 'Башня, тросы, рогатка и смайлики. Жми кнопку — и сразу в бой.',
        },
        reply_markup: { inline_keyboard: [[{ text: '⚔️ Принять вызов', url: link }]] },
      },
      allow_user_chats: true,
      allow_group_chats: true,
    });
    return res?.id ?? null;
  }

  return {
    handleUpdate, setup, notify, notifyAdmins, refund, donateInvoice, tourInvoice, shopInvoice, remind,
    prepareChallenge, inviteDuel,
    get username() { return username; },
  };
}
