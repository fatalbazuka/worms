import {
  loggedIn, login, register, logout, renameAccount, syncMe, ApiError,
} from '../net/server.js';
import { player } from '../platform/player.js';
import { leagueLabel } from '../platform/league.js';
import { el, openOverlay, closeOverlay, closeButton, isOverlayOpen } from './Overlay.js';

/**
 * Окно аккаунта: вход, регистрация и профиль.
 *
 * Сделано обычной HTML-формой поверх канваса, а не средствами Phaser:
 * настоящие поля ввода — это экранная клавиатура на телефоне, вставка из
 * буфера, менеджер паролей и автозаполнение. Рисовать всё это в канвасе
 * значило бы потерять половину.
 *
 * Регистрация — ник и пароль, ничего больше: ни почты, ни подтверждений.
 */

let current = null;

export function isAccountDialogOpen() { return isOverlayOpen() && Boolean(current); }

export function closeAccountDialog() {
  if (current) closeOverlay();
}

/**
 * Открыть окно. onTop — показать таблицу лидеров (меню само знает как),
 * onChange — что-то поменялось (вошли, вышли, сменили ник).
 */
export function openAccountDialog({ onTop = null, onChange = null } = {}) {
  const ov = openOverlay({ closed: () => { current = null; } });
  current = ov;
  const { box } = ov;

  const done = () => { onChange?.(); render(); };
  const render = () => {
    box.replaceChildren(closeButton());
    if (loggedIn()) profileView(box, { onTop, done });
    else loginView(box, { done });
  };
  render();
  if (loggedIn()) syncMe().then((p) => { if (p && ov.isOpen()) render(); });
}

function loginView(box, { done }) {
  const name = el('input', {
    id: 'acc-name', name: 'username', autocomplete: 'username', maxlength: '20',
    autocapitalize: 'off', spellcheck: 'false', placeholder: 'например, Вася',
  });
  const pass = el('input', {
    id: 'acc-pass', name: 'password', type: 'password', autocomplete: 'current-password',
    maxlength: '100', placeholder: 'от 4 символов',
  });
  const err = el('div', { class: 'acc-err', role: 'alert' });
  const signIn = el('button', { class: 'acc-btn primary', type: 'submit' }, 'Войти');
  const signUp = el('button', { class: 'acc-btn', type: 'button' }, 'Создать аккаунт');

  const run = async (action) => {
    err.textContent = '';
    name.removeAttribute('aria-invalid');
    pass.removeAttribute('aria-invalid');
    if (action === register) pass.setAttribute('autocomplete', 'new-password');
    signIn.disabled = true; signUp.disabled = true;
    try {
      await action(name.value, pass.value);
      done();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'что-то пошло не так';
      err.textContent = action === login && e.status === 401
        ? `${msg}. Нет аккаунта — нажми «Создать аккаунт».`
        : msg;
      if (e.field === 'password') pass.setAttribute('aria-invalid', 'true');
      else if (e.field === 'name' || e.status === 401) name.setAttribute('aria-invalid', 'true');
      signIn.disabled = false; signUp.disabled = false;
    }
  };
  signUp.addEventListener('click', () => run(register));

  const form = el('form', { novalidate: true },
    el('label', { for: 'acc-name' }, 'Ник'), name,
    el('label', { for: 'acc-pass' }, 'Пароль'), pass,
    err,
    el('div', { class: 'acc-row' }, signIn, signUp));
  form.addEventListener('submit', (e) => { e.preventDefault(); run(login); });

  box.append(
    el('h2', {}, 'Аккаунт'),
    el('p', { class: 'acc-note' },
      'Только ник и пароль — без почты и телефона. С аккаунтом бои по сети идут в общий рейтинг, '
      + 'а профиль открывается с любого устройства.'),
    form,
  );
  setTimeout(() => name.focus(), 30);
}

function profileView(box, { onTop, done }) {
  const p = player();
  const err = el('div', { class: 'acc-err', role: 'alert' });
  const stat = (value, label) => el('div', { class: 'acc-stat' }, el('b', {}, String(value)), el('span', {}, label));

  box.append(
    el('h2', {}, 'Профиль'),
    el('div', { class: 'acc-name' }, p.name, p.telegram ? el('span', { class: 'acc-badge' }, 'Telegram') : null),
    el('p', { class: 'acc-note', style: 'margin-bottom:0' }, leagueLabel(p.rating)),
    el('div', { class: 'acc-stats' },
      stat(p.rating, 'рейтинг'),
      stat(p.rank ? `#${p.rank}` : '—', p.rank ? 'место в таблице' : 'сыграй бой по сети'),
      stat(p.wins, 'побед'),
      stat(p.losses, 'поражений')),
  );

  if (!p.telegram) {
    const input = el('input', { id: 'acc-rename', maxlength: '20', value: p.name, autocomplete: 'off' });
    const save = el('button', { class: 'acc-btn', type: 'submit', style: 'flex:0 0 auto' }, 'Сменить');
    const form = el('form', { novalidate: true },
      el('label', { for: 'acc-rename' }, 'Ник'),
      el('div', { class: 'acc-row', style: 'margin-top:0;flex-wrap:nowrap' }, input, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (input.value.trim() === p.name) return;
      save.disabled = true;
      err.textContent = '';
      try {
        await renameAccount(input.value);
        done();
      } catch (ex) {
        err.textContent = ex.message;
        save.disabled = false;
      }
    });
    box.append(form);
  }

  box.append(err);
  const row = el('div', { class: 'acc-row' });
  if (onTop) {
    row.append(el('button', { class: 'acc-btn primary', type: 'button',
      onclick: () => { closeAccountDialog(); onTop(); } }, 'Таблица лидеров'));
  }
  // Из Telegram вход автоматический — «выйти» там ничего бы не дало
  if (!p.telegram) {
    row.append(el('button', { class: 'acc-btn', type: 'button',
      onclick: async () => { await logout(); done(); } }, 'Выйти'));
  }
  box.append(row);
}
