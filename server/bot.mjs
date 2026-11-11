/**
 * Бот: команды, звёзды, сообщения игрокам.
 *
 * Telegram присылает обновления на вебхук (/api/bot/webhook) с секретом в
 * заголовке — без него запрос отклоняется. Бот отвечает на команды,
 * принимает оплату звёздами и пишет игрокам о турнирах. «Твой ход» не
 * пишет — так решено.
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
import { createHash } from 'node:crypto';

export const DONATE_AMOUNTS = [10, 50, 100];

export function webhookSecret(token, explicit = '') {
  if (explicit) return explicit;
  return createHash('sha256').update(`worms-webhook:${token}`).digest('hex').slice(0, 48);
}

export function createBot({ db, api, players, tournaments, adminIds = new Set(), publicUrl = '',
  tz = 'Europe/Moscow', now = () => Date.now(), log = console }) {
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

  async function send(chatId, text, markup) {
    return api.call('sendMessage', { chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) });
  }

  /** Сообщение игроку по id. tour — кнопка сразу в экран турнира. */
  async function notify(playerId, text, { tour = null } = {}) {
    const p = players.byId(playerId);
    if (!p?.tg_id) return null;
    return send(p.tg_id, text, playButton(tour ? '🏆 Открыть турнир' : '🎮 Играть', tour ? `?tour=${tour}` : ''));
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
    } else {
      await send(msg.chat.id, `💛 Спасибо за ${sp.total_amount} ⭐! Это правда помогает игре.`);
    }
  }

  // ------------------------------------------------------------ команды

  function statsText(p) {
    const v = players.view(p);
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

  function topText() {
    const rows = players.top(10);
    if (!rows.length) return 'Таблица пока пуста — сыграй первый бой по сети.';
    return ['🏅 Топ-10 по рейтингу', ...rows.map((r, i) => `${i + 1}. ${r.name} — ${r.rating}`)].join('\n');
  }

  function toursText() {
    const list = tournaments.list(null).filter((t) => t.status !== 'finished');
    if (!list.length) return 'Сейчас турниров нет. Следи за анонсами!';
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
  ].join('\n');

  async function onCommand(msg) {
    const text = String(msg.text ?? '').trim();
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.replace(/@.*$/, '').toLowerCase();
    const chat = msg.chat.id;
    const me = players.upsertTg(msg.from);
    const admin = players.isAdmin(me);

    switch (cmd) {
      case '/start':
        return send(chat, `Привет, ${me.name}! Это Worms — пошаговая артиллерия.\n\n`
          + 'Жми «Играть»: быстрые бои, кампания, онлайн и турниры. /stats — твоя статистика, '
          + '/top — лучшие, /tours — турниры.', playButton());
      case '/stats': return send(chat, statsText(me), playButton());
      case '/top': return send(chat, topText(), playButton());
      case '/tours': return send(chat, toursText(), playButton('🏆 Турниры', '?tour=list'));
      case '/help':
        return send(chat, '/stats — статистика\n/top — топ-10\n/tours — турниры'
          + (admin ? `\n\n${ADMIN_HELP}` : ''), playButton());
      default: break;
    }
    if (!admin) return send(chat, 'Не знаю такой команды. /help — что я умею.', playButton());

    switch (cmd) {
      case '/admin': return send(chat, ADMIN_HELP);
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
      default:
        return send(chat, `Не знаю такой команды.\n${ADMIN_HELP}`);
    }
  }

  // ------------------------------------------------------------- вебхук

  async function handleUpdate(update) {
    try {
      if (update.pre_checkout_query) return await onPreCheckout(update.pre_checkout_query);
      const msg = update.message;
      if (!msg?.from || msg.chat?.type !== 'private') return null;
      if (msg.successful_payment) return await onPaid(msg);
      if (typeof msg.text === 'string' && msg.text.startsWith('/')) return await onCommand(msg);
      if (typeof msg.text === 'string') return await send(msg.chat.id, 'Жми «Играть» 👇', playButton());
    } catch (e) {
      log.error?.('[bot] обновление не обработано', e);
    }
    return null;
  }

  /** Настроить бота при старте: вебхук, кнопка меню, команды. */
  async function setup({ secret }) {
    if (!api.enabled) return;
    const me = await api.call('getMe');
    username = me?.username ?? '';
    if (!publicUrl) {
      log.warn?.('[bot] PUBLIC_URL не задан — вебхук и кнопка меню не настроены');
      return;
    }
    await api.call('setWebhook', {
      url: `${publicUrl.replace(/\/+$/, '')}/api/bot/webhook`, secret_token: secret,
      allowed_updates: ['message', 'pre_checkout_query'], drop_pending_updates: false,
    });
    await api.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: appUrl() } } });
    const base = [
      { command: 'start', description: 'Играть' },
      { command: 'stats', description: 'Моя статистика' },
      { command: 'top', description: 'Топ-10 по рейтингу' },
      { command: 'tours', description: 'Турниры' },
    ];
    await api.call('setMyCommands', { commands: base });
    for (const id of adminIds) {
      await api.call('setMyCommands', {
        scope: { type: 'chat', chat_id: id },
        commands: [...base,
          { command: 'newtour', description: 'Новый турнир' },
          { command: 'starttour', description: 'Начать турнир' },
          { command: 'canceltour', description: 'Отменить турнир' },
          { command: 'settle', description: 'Решить спорный матч' },
          { command: 'stars', description: 'Звёзды' }],
      });
    }
    log.log?.(`[bot] @${username || '?'}: вебхук ${publicUrl}/api/bot/webhook`);
  }

  return {
    handleUpdate, setup, notify, notifyAdmins, refund, donateInvoice, tourInvoice,
    get username() { return username; },
  };
}
