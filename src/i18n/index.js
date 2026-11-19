/**
 * Английский язык поверх русского кода.
 *
 * Код игры пишет тексты по-русски, как писал. Перевод случается там, где
 * текст попадает на экран: в Text.setText у Phaser и в узлах DOM (диалоги,
 * экран входа). Словарь — src/i18n/en.js: русская строка → английская.
 *
 * Строка, собранная из кусков (`+${n} монет${extra}`), ищется по образцам:
 * в словаре она записана как «+{0} монет{1}», значения подставляются в
 * английский шаблон и сами переводятся тем же путём. Не нашлось целиком —
 * переводится по строкам и по кускам между « · ». Не нашлось совсем —
 * остаётся по-русски: лучше русская строка, чем пустое место.
 *
 * Язык: выбранный вручную (worms.lang.v1), иначе язык Telegram, иначе
 * браузера. Русский — для ru и соседних языков, где русский понятнее
 * английского; остальным — английский.
 */
import { EN } from './en.js';

const KEY = 'worms.lang.v1';
const CYR = /[А-Яа-яЁё]/;
const RU_LIKE = /^(ru|uk|be|kk|ky|uz|tg|tt|ba|hy|az|ka|mn)\b/i;

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch { /* инкогнито */ }
  const tg = globalThis.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  const code = String(tg || globalThis.navigator?.language || 'ru');
  // ?lang=en в адресе — для проверки и скриншотов
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('lang');
    if (q === 'ru' || q === 'en') return q;
  } catch { /* нет location */ }
  return RU_LIKE.test(code) ? 'ru' : 'en';
}

export const LANG = detect();
export const isEn = () => LANG === 'en';

/** Сменить язык: запоминаем и перезапускаем страницу — тексты уже нарисованы. */
export function setLang(lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* инкогнито */ }
  globalThis.location?.reload();
}

// ------------------------------------------------------------ образцы

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Образец из записи словаря с {0}, {1}…: регулярка и английский шаблон.
 * Соседние места ({0}{1}) склеиваются в одно — иначе ленивая группа
 * отрезала бы первому один символ. Если в английском они не соседи, такой
 * образец не годится и пропускается.
 */
function compile(ru, en) {
  const groups = [];
  let src = '';
  let last = 0;
  const re = /(\{\d+\})+/g;
  let m;
  while ((m = re.exec(ru))) {
    // Одно место — без « · » и переносов внутри: иначе «Башня дня: {0} {1}»
    // проглотил бы и хвост «· +60 монет». Склейка может нести что угодно
    src += esc(ru.slice(last, m.index)) + (m[0].length > 3 ? '(.+?)' : '([^·\\n]+?)');
    groups.push(m[0]);
    last = m.index + m[0].length;
  }
  src += esc(ru.slice(last));
  // Английский шаблон: каждая склейка → номер группы; одиночные места из
  // склейки по отдельности в английском не поддерживаем
  let tpl = en;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.length > 3 && !tpl.includes(g)) {
      // Склейка в английском разорвана: годится, только если её частей там нет вовсе
      const parts = g.match(/\{\d+\}/g);
      if (parts.some((p) => tpl.includes(p))) return null;
    }
    tpl = tpl.split(g).join(`\u0000${i}\u0000`);
  }
  // Одиночные места внутри склеек, оставшиеся в шаблоне, — убираем
  tpl = tpl.replace(/\{\d+\}/g, '');
  const literal = ru.replace(/\{\d+\}/g, '').length;
  return { re: new RegExp(`^${src}$`, 's'), tpl, literal };
}

let PATTERNS = null;
function patterns() {
  if (PATTERNS) return PATTERNS;
  PATTERNS = [];
  for (const [ru, en] of Object.entries(EN)) {
    if (!/\{\d+\}/.test(ru)) continue;
    const p = compile(ru, en);
    if (p) PATTERNS.push(p);
  }
  // Чем больше в образце своего текста, тем он точнее: «{0} · {1}м» — последним
  PATTERNS.sort((a, b) => b.literal - a.literal);
  return PATTERNS;
}

// ------------------------------------------------------------- перевод

const cache = new Map();

function translate(s, depth) {
  if (!CYR.test(s)) return s;
  const exact = EN[s];
  if (exact !== undefined) return exact;
  // Пробелы по краям — часть склейки («  и коробка!»): ищем без них
  const t = s.trim();
  if (t !== s && EN[t] !== undefined) return s.replace(t, EN[t]);
  // ЗАГЛАВНЫМИ — значит, код сам поднял регистр: ищем строчными
  if (s === s.toUpperCase()) {
    const low = s.toLowerCase();
    if (EN[low] !== undefined) return EN[low].toUpperCase();
  }
  if (depth > 3) return s;
  for (const p of patterns()) {
    const m = p.re.exec(s);
    if (!m) continue;
    return p.tpl.replace(/\u0000(\d+)\u0000/g, (_, i) => translate(m[Number(i) + 1], depth + 1));
  }
  // По строкам, по кускам между « · », по фразам
  for (const sep of ['\n', ' · ', ' — ', '. ']) {
    if (!s.includes(sep)) continue;
    const parts = s.split(sep);
    const out = parts.map((x) => translate(x, depth + 1));
    if (out.some((x, i) => x !== parts[i])) return out.join(sep);
  }
  return s;
}

/** Перевести строку для экрана (на русском — как есть). */
export function tr(s) {
  if (LANG === 'ru' || typeof s !== 'string' || !s) return s;
  let v = cache.get(s);
  if (v === undefined) {
    v = translate(s, 0);
    if (cache.size > 5000) cache.clear();
    cache.set(s, v);
  }
  return v;
}

// ------------------------------------------------------------ установка

function translateNode(node) {
  if (node.nodeType === 3) {
    const v = node.data;
    if (CYR.test(v)) {
      const t = v.trim();
      const out = tr(t);
      if (out !== t) node.data = v.replace(t, out);
    }
    return;
  }
  if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
  for (const a of ['placeholder', 'title', 'aria-label']) {
    const v = node.getAttribute?.(a);
    if (v && CYR.test(v)) node.setAttribute(a, tr(v));
  }
  if (node.tagName === 'INPUT' && /^(button|submit)$/i.test(node.type) && CYR.test(node.value)) node.value = tr(node.value);
  for (const c of node.childNodes) translateNode(c);
}

/**
 * Включить перевод: Phaser.Text и DOM. На русском ничего не делает.
 * Зовётся до создания игры.
 */
export function installI18n(Phaser) {
  if (LANG === 'ru') return;
  const T = Phaser?.GameObjects?.Text?.prototype;
  if (T && !T.__i18n) {
    const setText = T.setText;
    T.setText = function (value) {
      if (typeof value === 'string') value = tr(value);
      else if (Array.isArray(value)) value = value.map((x) => (typeof x === 'string' ? tr(x) : x));
      return setText.call(this, value);
    };
    T.__i18n = true;
  }
  const doc = globalThis.document;
  if (!doc) return;
  doc.documentElement.lang = 'en';
  doc.title = tr(doc.title);
  translateNode(doc.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') translateNode(m.target);
      else if (m.type === 'attributes') translateNode(m.target);
      else for (const n of m.addedNodes) translateNode(n);
    }
  }).observe(doc.body, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['placeholder', 'title', 'aria-label'],
  });
}
