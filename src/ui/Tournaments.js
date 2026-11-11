import {
  loggedIn, fetchTournaments, fetchTournament, joinTournament, leaveTournament, startTournament, ApiError,
} from '../net/server.js';
import { player } from '../platform/player.js';
import { openInvoice, requestWriteAccess, haptic, inTelegram } from '../platform/telegram.js';
import { el, openOverlay, closeOverlay, closeButton } from './Overlay.js';
import { avatar, fmtDate } from './AccountDialog.js';

/**
 * Турниры в мини-приложении: список, запись, сетка, свой матч.
 *
 * Создаёт турниры админ командой бота (/newtour), начинает — бот сам, когда
 * набрались все или пришло время, либо админ кнопкой здесь. Матч играется
 * обычной сетевой партией в комнате турнира: кнопка «Играть матч» уводит
 * в бой, итог засчитывается, когда отчитались обе стороны.
 *
 * Пока окно открыто, оно само обновляется раз в 8 секунд: соперник мог
 * доиграть свой матч, сетка — сдвинуться.
 */

const STATUS = { open: 'запись', running: 'идёт', finished: 'завершён', cancelled: 'отменён' };
const roundName = (r, total) => (r === total ? 'Финал' : r === total - 1 ? 'Полуфинал'
  : r === total - 2 ? 'Четвертьфинал' : `Раунд ${r}`);

/**
 * @param onPlay (room, tournamentId) — уйти в бой своего матча
 * @param tour  сразу открыть этот турнир (id) или список
 */
export function openTournaments({ onPlay, tour = null } = {}) {
  const ov = openOverlay({ closed: () => clearInterval(timer) });
  const { box } = ov;
  box.classList.add('wide');
  let view = tour ? { id: Number(tour) } : null;
  let timer = 0;
  let note = '';

  const refresh = async () => {
    if (!ov.isOpen()) return;
    if (!loggedIn()) { box.replaceChildren(closeButton(), el('h2', {}, 'Турниры'),
      el('p', { class: 'acc-note' }, inTelegram()
        ? 'Входим через Telegram… если не получается — закрой и открой игру заново.'
        : 'Турниры работают в Telegram: открой игру через бота.')); return; }
    try {
      if (view) renderOne(await fetchTournament(view.id));
      else renderList(await fetchTournaments());
    } catch (e) {
      box.replaceChildren(closeButton(), el('h2', {}, 'Турниры'),
        el('p', { class: 'acc-err' }, e instanceof ApiError ? e.message : 'сервер недоступен'));
    }
  };
  const go = (next) => { view = next; note = ''; refresh(); };

  function renderList({ items = [], admin = false }) {
    box.replaceChildren(closeButton(), el('h2', {}, 'Турниры'));
    box.append(el('p', { class: 'acc-note' }, 'Сетка на выбывание: проиграл — выбыл. '
      + 'Чемпиону — титул в кабинете и +25 к рейтингу.'));
    if (admin) box.append(el('p', { class: 'acc-note' }, 'Ты админ: новый турнир — командой /newtour в боте.'));
    if (!items.length) { box.append(el('div', { class: 'ov-empty' }, 'Сейчас турниров нет. Бот напишет, когда появятся.')); return; }
    box.append(el('div', { class: 'ov-list' }, ...items.map((t) => el('div', {
      class: 'ov-row click', role: 'button', tabindex: '0', onclick: () => go({ id: t.id }),
    },
    el('span', {}, t.status === 'finished' ? '🏆' : t.status === 'running' ? '⚔️' : '📝'),
    el('span', { class: 'grow' }, t.name, el('span', { class: 'sub' }, describe(t))),
    t.joined ? el('span', { class: 'ov-pill gold' }, 'ты в турнире') : el('span', { class: 'ov-pill' }, STATUS[t.status])))));
  }

  function describe(t) {
    if (t.status === 'open') {
      return `запись ${t.count}/${t.size}${t.startsAt ? ` · старт ${fmtDate(t.startsAt)}` : ''}`
        + `${t.fee ? ` · взнос ${t.fee} ⭐` : ' · бесплатно'}`;
    }
    if (t.status === 'running') return `идёт · ${t.count} игроков`;
    if (t.status === 'finished') return t.winner ? `чемпион — ${t.winner.name}` : 'завершён';
    return STATUS[t.status];
  }

  function renderOne(t) {
    const me = player();
    box.replaceChildren(closeButton(),
      el('button', { class: 'ov-back', type: 'button', onclick: () => go(null) }, '← все турниры'),
      el('h2', {}, t.name),
      el('p', { class: 'acc-note', style: 'margin-bottom:4px' }, describe(t)));
    const err = el('div', { class: 'acc-err', role: 'alert' }, note);

    // Мой матч — главное на экране, пока турнир идёт
    if (t.my?.eliminated) {
      box.append(el('p', { class: 'acc-note' }, `Ты выбыл: ${roundName(t.my.round, t.rounds.length
        ? Math.log2(t.rounds[0].length * 2) : 1).toLowerCase()}. Следи за сеткой — и до следующего турнира!`));
    } else if (t.my) {
      const left = t.my.deadline ? Math.max(0, Math.round((t.my.deadline - Date.now()) / 60_000)) : null;
      const card = el('div', { class: 'ov-card' },
        el('div', { class: 'acc-note', style: 'margin:0 0 4px' }, `${roundName(t.my.round, t.rounds.length
          ? Math.log2(t.rounds[0].length * 2) : 1)} · твой матч${left != null ? ` · осталось ~${left} мин` : ''}`),
        el('div', { class: 'ov-head' }, avatar(t.my.opponent), el('b', {}, `против ${t.my.opponent?.name ?? '…'}`)));
      if (t.my.status === 'disputed') {
        card.append(el('p', { class: 'acc-note' }, 'Итоги разошлись — решит админ.'));
      } else if (t.my.reported) {
        card.append(el('p', { class: 'acc-note' }, 'Ты отчитался. Ждём соперника — или конца времени матча.'));
      } else {
        card.append(el('div', { class: 'acc-row' }, el('button', {
          class: 'acc-btn primary', type: 'button',
          onclick: () => { haptic('tap'); closeOverlay(); onPlay?.(t.my.room, t.id); },
        }, '⚔️ Играть матч')));
      }
      box.append(card);
    } else if (t.status === 'running' && t.joined) {
      box.append(el('p', { class: 'acc-note' }, 'Твой следующий матч появится, когда доиграет соседняя пара.'));
    }

    // Запись
    const row = el('div', { class: 'acc-row' });
    if (t.status === 'open' && !t.joined && t.count < t.size) {
      row.append(el('button', { class: 'acc-btn primary', type: 'button', onclick: () => join(t) },
        t.fee ? `Записаться за ${t.fee} ⭐` : 'Записаться'));
    }
    if (t.status === 'open' && t.joined) {
      row.append(el('button', { class: 'acc-btn', type: 'button', onclick: () => leave(t) }, 'Выйти из турнира'));
    }
    if (t.status === 'open' && me?.admin && t.count >= 2) {
      row.append(el('button', { class: 'acc-btn', type: 'button', onclick: () => start(t) }, 'Начать сейчас'));
    }
    box.append(err, row);

    if (t.rounds.length) box.append(el('div', { class: 'ov-sec' }, 'Сетка'), bracket(t, me));
    box.append(el('div', { class: 'ov-sec' }, `Участники · ${t.count}/${t.size}`));
    if (!t.players.length) box.append(el('div', { class: 'ov-empty' }, 'Пока никого — будь первым.'));
    else {
      box.append(el('div', { class: 'ov-list' }, ...t.players.map((p) => el('div', { class: 'ov-row' },
        avatar(p, true), el('span', { class: 'grow' }, p.name),
        t.winner?.id === p.id ? el('span', { class: 'ov-pill gold' }, 'чемпион')
          : p.id === me?.id ? el('span', { class: 'ov-pill' }, 'ты') : null))));
    }
  }

  function bracket(t, me) {
    const total = t.rounds.length ? Math.log2(t.rounds[0].length * 2) : 0;
    const cols = [];
    for (let r = 1; r <= total; r++) {
      const ms = t.rounds[r - 1] ?? [];
      const n = t.rounds[0].length / 2 ** (r - 1);
      const inner = el('div', { class: 'ov-round-matches' });
      const col = el('div', { class: 'ov-round' }, el('h4', {}, roundName(r, total)), inner);
      for (let k = 0; k < n; k++) {
        const m = ms.find((x) => x.slot === k);
        const line = (p) => el('div', { class: m?.winner && p && m.winner === p.id ? 'win' : '' },
          el('span', {}, p ? p.name : (m && m.status === 'done' ? '—' : '…')));
        const mine = m && me && (m.p1?.id === me.id || m.p2?.id === me.id) && m.status !== 'done';
        inner.append(el('div', { class: `ov-match${mine ? ' mine' : ''}` },
          line(m?.p1), m && m.status === 'done' && !m.p2 && m.p1 ? el('div', {}, el('span', {}, 'проход')) : line(m?.p2)));
      }
      cols.push(col);
    }
    return el('div', { class: 'ov-bracket' }, ...cols);
  }

  async function join(t) {
    note = '';
    // Чтобы бот мог написать о старте и соперниках, даже если игру открыли
    // по ссылке: Telegram спросит разрешение один раз
    await requestWriteAccess();
    try {
      const r = await joinTournament(t.id);
      if (r.invoice) {
        const status = await openInvoice(r.invoice);
        if (status === 'paid') { note = 'Оплата прошла — записываем…'; setTimeout(refresh, 1500); }
        else if (status === 'unsupported') note = 'Оплата звёздами работает в Telegram.';
      } else {
        haptic('win');
      }
    } catch (e) {
      note = e instanceof ApiError ? e.message : 'не получилось записаться';
      haptic('warn');
    }
    refresh();
  }

  async function leave(t) {
    try { await leaveTournament(t.id); note = t.fee ? 'Ты вышел. Взнос вернётся на счёт звёзд.' : 'Ты вышел из турнира.'; } catch (e) {
      note = e instanceof ApiError ? e.message : 'не получилось';
    }
    refresh();
  }

  async function start(t) {
    try { await startTournament(t.id); haptic('win'); } catch (e) {
      note = e instanceof ApiError ? e.message : 'не получилось';
    }
    refresh();
  }

  timer = setInterval(refresh, 8000);
  refresh();
}
