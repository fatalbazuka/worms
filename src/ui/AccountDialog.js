import {
  loggedIn, login, register, logout, renameAccount, syncMe, ApiError,
} from '../net/server.js';
import { player } from '../platform/player.js';
import { leagueLabel } from '../platform/league.js';

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

const CSS = `
.acc-shade { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center;
  justify-content: center; background: rgba(5, 8, 16, 0.72); padding: 16px;
  -webkit-user-select: text; user-select: text; touch-action: auto; }
.acc-box { position: relative; width: min(420px, 100%); max-height: calc(100dvh - 32px); overflow: auto;
  background: linear-gradient(#3a4150, #262b36); border: 2px solid #12151c; border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.55); padding: 22px 22px 18px; color: #f4ece0;
  font-family: 'Worms UI', system-ui, sans-serif; font-weight: 700; }
.acc-box h2 { margin: 0 0 6px; font-size: 22px; font-weight: 800; color: #ffc247; letter-spacing: 0.5px; }
.acc-note { margin: 0 0 16px; font-size: 13px; color: #a9b3c4; line-height: 1.45; }
.acc-box label { display: block; font-size: 12px; color: #a9b3c4; margin: 10px 0 4px; }
.acc-box input { width: 100%; box-sizing: border-box; padding: 11px 12px; font: inherit; font-size: 16px;
  color: #f4ece0; background: #161a22; border: 2px solid #12151c; border-radius: 10px; outline: none; }
.acc-box input:focus { border-color: #ffc247; }
.acc-box input[aria-invalid="true"] { border-color: #ff6b6b; }
.acc-err { min-height: 18px; margin: 10px 0 2px; font-size: 13px; color: #ff9a9a; }
.acc-row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.acc-btn { flex: 1 1 140px; padding: 12px 14px; font: inherit; font-size: 15px; font-weight: 800;
  color: #f4ece0; background: linear-gradient(#4a5263, #343a47); border: 2px solid #12151c;
  border-radius: 10px; cursor: pointer; }
.acc-btn.primary { background: linear-gradient(#e0574f, #a8302b); }
.acc-btn:disabled { opacity: 0.55; cursor: default; }
.acc-btn:not(:disabled):hover { filter: brightness(1.12); }
.acc-close { position: absolute; top: 10px; right: 12px; width: 34px; height: 34px; font-size: 22px;
  line-height: 1; color: #a9b3c4; background: none; border: 0; cursor: pointer; }
.acc-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 14px 0 6px; }
.acc-stat { background: #161a22; border-radius: 10px; padding: 9px 12px; }
.acc-stat b { display: block; font-size: 20px; font-weight: 800; }
.acc-stat span { font-size: 12px; color: #a9b3c4; }
.acc-name { font-size: 24px; font-weight: 800; margin: 2px 0 2px; word-break: break-word; }
.acc-badge { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 8px; font-size: 11px;
  vertical-align: middle; background: #2b5d8a; color: #dff0ff; }
`;

let open = null;

// Esc закрывает окно, где бы ни был фокус: после входа форма пересобирается,
// и фокус остаётся на body, а не внутри окна
function onEsc(e) {
  if (e.key === 'Escape' && open) { e.stopPropagation(); closeAccountDialog(); }
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

/**
 * Пока окно открыто, ввод игры спит. Клавиатура Phaser ловит пробел и
 * стрелки, а мышь и касания Phaser слушает на всём окне браузера: без
 * этого клик по кнопке формы доходил и до кнопки меню под ней.
 */
function gameInput(on) {
  const input = globalThis.__WORMS__?.input;
  if (!input) return;
  input.enabled = on;
  if (input.keyboard) input.keyboard.enabled = on;
}

const SWALLOW = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove',
  'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown', 'keyup'];

export function isAccountDialogOpen() { return Boolean(open); }

export function closeAccountDialog() {
  if (!open) return;
  open.remove();
  open = null;
  document.removeEventListener('keydown', onEsc, true);
  gameInput(true);
}

/**
 * Открыть окно. onTop — показать таблицу лидеров (меню само знает как),
 * onChange — что-то поменялось (вошли, вышли, сменили ник).
 */
export function openAccountDialog({ onTop = null, onChange = null } = {}) {
  closeAccountDialog();
  if (!document.getElementById('acc-css')) {
    document.head.append(el('style', { id: 'acc-css' }, CSS));
  }
  const box = el('div', { class: 'acc-box', role: 'dialog', 'aria-modal': 'true' });
  const shade = el('div', { class: 'acc-shade' }, box);
  // Закрытие по клику, а не по нажатию: отпускание кнопки тогда тоже
  // достаётся окну и не нажимает кнопку меню под ним
  shade.addEventListener('click', (e) => { if (e.target === shade) closeAccountDialog(); });
  // События окна дальше него не идут — до слушателей игры на window
  for (const type of SWALLOW) shade.addEventListener(type, (e) => e.stopPropagation());
  document.body.append(shade);
  open = shade;
  document.addEventListener('keydown', onEsc, true);
  gameInput(false);

  const done = () => { onChange?.(); render(); };
  const render = () => {
    box.replaceChildren(el('button', { class: 'acc-close', 'aria-label': 'Закрыть', onclick: closeAccountDialog }, '×'));
    if (loggedIn()) profileView(box, { onTop, done });
    else loginView(box, { done });
  };
  render();
  if (loggedIn()) syncMe().then((p) => { if (p && open === shade) render(); });
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
