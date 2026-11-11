/**
 * HTML-окна поверх игры: общая основа для окна аккаунта и полей ввода.
 *
 * Обычный HTML, а не Phaser: настоящие поля — это экранная клавиатура на
 * телефоне, вставка из буфера, менеджер паролей и автозаполнение. Окно
 * одно на всю игру: открытие нового закрывает предыдущее.
 *
 * Пока окно открыто, ввод игры спит, события окна наружу не уходят, Esc и
 * клик мимо окна его закрывают.
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
.acc-box.wide { width: min(560px, 100%); }
.ov-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
.ov-ava { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; flex: 0 0 auto;
  background: #161a22; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 800; color: #ffc247; }
.ov-ava.sm { width: 28px; height: 28px; font-size: 13px; }
.ov-sec { margin: 16px 0 6px; font-size: 12px; color: #ffc247; text-transform: uppercase; letter-spacing: 0.6px; }
.ov-list { display: flex; flex-direction: column; gap: 6px; }
.ov-row { display: flex; align-items: center; gap: 10px; background: #161a22; border-radius: 10px; padding: 9px 12px;
  font-size: 14px; }
.ov-row.click { cursor: pointer; }
.ov-row.click:hover { filter: brightness(1.2); }
.ov-row .grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-row .sub { display: block; font-size: 12px; color: #a9b3c4; font-weight: 700; }
.ov-pill { flex: 0 0 auto; padding: 3px 9px; border-radius: 999px; font-size: 12px; background: #2b3242; color: #dfe6f3; }
.ov-pill.ok { background: #1f5a33; color: #c8f5d6; }
.ov-pill.bad { background: #5a1f24; color: #ffd0d4; }
.ov-pill.gold { background: #6b4b10; color: #ffe2a6; }
.ov-card { background: #1d2230; border: 2px solid #ffc247; border-radius: 12px; padding: 12px 14px; margin: 12px 0; }
.ov-card b { font-size: 17px; }
.ov-bracket { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; }
.ov-round { flex: 0 0 150px; display: flex; flex-direction: column; gap: 6px; }
.ov-round-matches { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: space-around; gap: 8px; }
.ov-round h4 { margin: 0; font-size: 12px; color: #a9b3c4; text-align: center; }
.ov-match { background: #161a22; border-radius: 8px; padding: 6px 8px; font-size: 13px; }
.ov-match div { display: flex; justify-content: space-between; gap: 6px; padding: 2px 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #a9b3c4; }
.ov-match div.win { color: #f4ece0; font-weight: 800; }
.ov-match.mine { outline: 2px solid #ffc247; }
.ov-empty { color: #a9b3c4; font-size: 14px; padding: 10px 0; }
.ov-back { background: none; border: 0; color: #a9b3c4; font: inherit; font-size: 14px; cursor: pointer; padding: 0 0 8px; }
.acc-badge { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 8px; font-size: 11px;
  vertical-align: middle; background: #2b5d8a; color: #dff0ff; }
`;

let open = null;
let onClose = null;

// Esc закрывает окно, где бы ни был фокус: после входа форма пересобирается,
// и фокус остаётся на body, а не внутри окна
function onEsc(e) {
  if (e.key === 'Escape' && open) { e.stopPropagation(); closeOverlay(); }
}

export function el(tag, attrs = {}, ...children) {
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

export function isOverlayOpen() { return Boolean(open); }

export function closeOverlay() {
  if (!open) return;
  open.remove();
  open = null;
  document.removeEventListener('keydown', onEsc, true);
  gameInput(true);
  const cb = onClose;
  onClose = null;
  cb?.();
}

/**
 * Открыть пустое окно. Возвращает коробку, которую наполняет вызывающий.
 * closed — вызовется, когда окно закроют любым способом.
 */
export function openOverlay({ closed = null } = {}) {
  closeOverlay();
  if (!document.getElementById('acc-css')) {
    document.head.append(el('style', { id: 'acc-css' }, CSS));
  }
  const box = el('div', { class: 'acc-box', role: 'dialog', 'aria-modal': 'true' });
  const shade = el('div', { class: 'acc-shade' }, box);
  // Закрытие по клику, а не по нажатию: отпускание кнопки тогда тоже
  // достаётся окну и не нажимает кнопку меню под ним
  shade.addEventListener('click', (e) => { if (e.target === shade) closeOverlay(); });
  // События окна дальше него не идут — до слушателей игры на window
  for (const type of SWALLOW) shade.addEventListener(type, (e) => e.stopPropagation());
  document.body.append(shade);
  open = shade;
  onClose = closed;
  document.addEventListener('keydown', onEsc, true);
  gameInput(false);
  return { box, shade, isOpen: () => open === shade };
}

/** Крестик в углу окна. */
export function closeButton() {
  return el('button', { class: 'acc-close', 'aria-label': 'Закрыть', onclick: closeOverlay }, '×');
}

/**
 * Спросить строку — замена window.prompt. Тот в Telegram на телефоне
 * работает через раз и выглядит чужеродно.
 *
 * @returns {Promise<string|null>} введённое (обрезанное) или null — передумали
 */
export function askText({
  title, note = '', label = '', value = '', placeholder = '', maxLength = 40, okText = 'Готово',
  upper = false, validate = null,
} = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (v) => { if (!answered) { answered = true; resolve(v); } };
    const { box } = openOverlay({ closed: () => finish(null) });
    const input = el('input', {
      id: 'ask-input', value, placeholder, maxlength: String(maxLength), autocomplete: 'off',
      autocapitalize: upper ? 'characters' : 'off', spellcheck: 'false',
    });
    if (upper) input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
    const err = el('div', { class: 'acc-err', role: 'alert' });
    const form = el('form', { novalidate: true },
      label ? el('label', { for: 'ask-input' }, label) : null, input, err,
      el('div', { class: 'acc-row' },
        el('button', { class: 'acc-btn primary', type: 'submit' }, okText),
        el('button', { class: 'acc-btn', type: 'button', onclick: closeOverlay }, 'Отмена')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      const problem = validate?.(v);
      if (problem) { err.textContent = problem; input.setAttribute('aria-invalid', 'true'); return; }
      finish(v);
      closeOverlay();
    });
    box.append(closeButton(), el('h2', {}, title), note ? el('p', { class: 'acc-note' }, note) : null, form);
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
