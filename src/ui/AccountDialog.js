import {
  loggedIn, syncMe, fetchHistory, donateInvoice, telegramLogin, ApiError,
} from '../net/server.js';
import { player } from '../platform/player.js';
import { leagueLabel } from '../platform/league.js';
import {
  inTelegram, canOfferHomeScreen, addToHomeScreen, openInvoice, haptic,
} from '../platform/telegram.js';
import { el, openOverlay, closeOverlay, closeButton, isOverlayOpen } from './Overlay.js';

/**
 * Личный кабинет. Аккаунт — это Telegram: имя и аватар оттуда, входить
 * отдельно не нужно. Здесь статистика, титулы, история боёв, иконка на
 * рабочий стол и поддержка игры звёздами.
 */

let current = null;

export function isAccountDialogOpen() { return isOverlayOpen() && Boolean(current); }

export function closeAccountDialog() {
  if (current) closeOverlay();
}

/** Аватар: фото из Telegram или первая буква имени. */
export function avatar(p, small = false) {
  const cls = `ov-ava${small ? ' sm' : ''}`;
  if (p?.photo) {
    const img = el('img', { class: cls, src: p.photo, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(el('div', { class: cls }, initial(p))));
    return img;
  }
  return el('div', { class: cls }, initial(p));
}

const initial = (p) => (p?.name ?? '?').trim().charAt(0).toUpperCase() || '?';

export const fmtDate = (ms) => (ms ? new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(new Date(ms)) : '');

/**
 * Открыть кабинет. onTop — таблица лидеров, onTours — турниры (их меню
 * показывает само).
 */
export function openAccountDialog({ onTop = null, onTours = null } = {}) {
  const ov = openOverlay({ closed: () => { current = null; } });
  current = ov;
  const { box } = ov;
  box.classList.add('wide');
  let history = null;

  const render = () => {
    box.replaceChildren(closeButton());
    if (!loggedIn()) { guestView(box, render); return; }
    profileView(box, { onTop, onTours, history });
  };
  render();
  if (loggedIn()) {
    syncMe().then(() => { if (ov.isOpen()) render(); });
    fetchHistory().then((items) => { history = items; if (ov.isOpen()) render(); })
      .catch(() => { history = []; if (ov.isOpen()) render(); });
  }
}

function guestView(box, render) {
  const note = inTelegram()
    ? 'Не получилось войти через Telegram. Проверь связь и попробуй ещё раз.'
    : 'Кабинет, рейтинг и турниры работают в Telegram: открой игру через бота.';
  const children = [el('h2', {}, 'Кабинет'), el('p', { class: 'acc-note' }, note)];
  if (inTelegram()) {
    children.push(el('div', { class: 'acc-row' }, el('button', {
      class: 'acc-btn primary', type: 'button',
      onclick: async () => { await telegramLogin(); render(); },
    }, 'Войти ещё раз')));
  }
  box.append(...children);
}

function profileView(box, { onTop, onTours, history }) {
  const p = player();
  const stat = (value, label) => el('div', { class: 'acc-stat' }, el('b', {}, String(value)), el('span', {}, label));
  const winrate = p.wins + p.losses > 0 ? `${Math.round((p.wins / (p.wins + p.losses)) * 100)}%` : '—';

  box.append(
    el('div', { class: 'ov-head' }, avatar(p),
      el('div', {}, el('div', { class: 'acc-name' }, p.name),
        el('div', { class: 'acc-note', style: 'margin:0' }, leagueLabel(p.rating)))),
    el('div', { class: 'acc-stats' },
      stat(p.rating, 'рейтинг'),
      stat(p.rank ? `#${p.rank}` : '—', p.rank ? 'место в таблице' : 'сыграй бой по сети'),
      stat(`${p.wins} / ${p.losses}`, 'побед / поражений'),
      stat(winrate, 'процент побед'),
      stat(`${p.streak ?? 0}`, `серия · лучшая ${p.bestStreak ?? 0}`),
      stat(p.tourneyWins ?? 0, 'турниров выиграно')),
  );

  if (p.titles?.length) {
    box.append(el('div', { class: 'ov-sec' }, 'Титулы'),
      el('div', { class: 'ov-list' }, ...p.titles.slice(0, 5).map((t) => el('div', { class: 'ov-row' },
        el('span', {}, '🏆'), el('span', { class: 'grow' }, t.title), el('span', { class: 'sub' }, fmtDate(t.at))))));
  }

  box.append(el('div', { class: 'ov-sec' }, 'Последние бои'));
  if (history === null) box.append(el('div', { class: 'ov-empty' }, 'загружаю…'));
  else if (!history.length) box.append(el('div', { class: 'ov-empty' }, 'Пока пусто — сыграй онлайн или в турнире.'));
  else {
    box.append(el('div', { class: 'ov-list' }, ...history.slice(0, 12).map((h) => {
      const pill = h.won === true ? el('span', { class: 'ov-pill ok' }, h.delta != null ? `+${h.delta}` : 'победа')
        : h.won === false ? el('span', { class: 'ov-pill bad' }, h.delta != null ? `${h.delta}` : 'поражение')
          : el('span', { class: 'ov-pill' }, 'спор');
      return el('div', { class: 'ov-row' }, avatar(h.opponent, true),
        el('span', { class: 'grow' }, h.opponent?.name ?? 'соперник',
          el('span', { class: 'sub' }, `${h.kind === 'tournament' ? h.note : 'дуэль на рейтинг'} · ${fmtDate(h.at)}`)),
        pill);
    })));
  }

  const err = el('div', { class: 'acc-err', role: 'alert' });
  const row = el('div', { class: 'acc-row' });
  if (onTours) row.append(el('button', { class: 'acc-btn primary', type: 'button',
    onclick: () => { closeAccountDialog(); onTours(); } }, '🏆 Турниры'));
  if (onTop) row.append(el('button', { class: 'acc-btn', type: 'button',
    onclick: () => { closeAccountDialog(); onTop(); } }, 'Таблица лидеров'));
  const row2 = el('div', { class: 'acc-row' });
  if (canOfferHomeScreen()) {
    row2.append(el('button', { class: 'acc-btn', type: 'button', onclick: () => addToHomeScreen() }, '📲 На рабочий стол'));
  }
  let donating = false;
  row2.append(el('button', { class: 'acc-btn', type: 'button',
    onclick: () => { if (!donating) { donating = true; donateView(box, err); } } }, '⭐ Поддержать игру'));
  box.append(err, row, row2);
}

/** Поддержка звёздами: 10, 50 или 100 — счёт открывает сам Telegram. */
function donateView(box, err) {
  const pick = el('div', { class: 'acc-row' }, ...[10, 50, 100].map((n) => el('button', {
    class: 'acc-btn', type: 'button',
    onclick: async () => {
      err.style.color = '';
      err.textContent = '';
      try {
        const link = await donateInvoice(n);
        const status = await openInvoice(link);
        if (status === 'paid') { haptic('win'); err.style.color = '#8ef0a0'; err.textContent = `Спасибо за ${n} ⭐!`; }
        else if (status === 'unsupported') err.textContent = 'Оплата звёздами работает в Telegram.';
      } catch (e) {
        err.textContent = e instanceof ApiError ? e.message : 'оплата недоступна';
      }
    },
  }, `${n} ⭐`)));
  box.append(el('div', { class: 'ov-sec' }, 'Поддержать игру звёздами'), pick);
  pick.scrollIntoView?.({ block: 'nearest' });
}
