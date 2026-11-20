/**
 * Пройденные бои «Подъёма»: на устройстве и копией в облаке Telegram.
 * Правила и сами бои — campaign/ascent.js.
 */
import { ASCENT_BY_ID, CHAPTERS, chapterCleared } from '../campaign/ascent.js';
import { STAR_COINS } from '../campaign/challenges.js';
import { cloudReady, cloudLoad, cloudSave } from './cloud.js';

const STORE_KEY = 'worms.ascent.v1';

function clean(raw) {
  return new Set(Array.isArray(raw) ? raw.filter((id) => ASCENT_BY_ID[id]) : []);
}

function save(done) {
  const raw = JSON.stringify([...done]);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  cloudSave(STORE_KEY, raw);
}

/** @returns {Set<string>} id пройденных боёв */
export function ascentDone() {
  try { return clean(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')); } catch { return new Set(); }
}

export function markAscentDone(id) {
  const done = ascentDone();
  if (done.has(id) || !ASCENT_BY_ID[id]) return false;
  done.add(id);
  save(done);
  return true;
}

/** Облачная копия: объединение пройденного. */
export async function syncAscentCloud() {
  if (!cloudReady()) return;
  const done = ascentDone();
  for (const raw of await cloudLoad(STORE_KEY)) {
    try { for (const id of clean(JSON.parse(raw))) done.add(id); } catch { /* битая копия — мимо */ }
  }
  save(done);
}

// ------------------------------------------------- звёзды и главы

/**
 * Звёзды боёв и главы, за которые выдана коробка, — отдельным ключом:
 * старые версии игры читают worms.ascent.v1 как список и другой формат
 * там бы не поняли. { stars: { id: 1…3 }, chapters: [id глав] }.
 */
const STARS_KEY = 'worms.ascentstars.v1';

function cleanStars(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const stars = {};
  for (const [id, n] of Object.entries(r.stars ?? {})) {
    if (ASCENT_BY_ID[id]) stars[id] = Math.max(0, Math.min(3, Math.floor(Number(n) || 0)));
  }
  const ids = new Set(CHAPTERS.map((c) => c.id));
  const chapters = Array.isArray(r.chapters) ? [...new Set(r.chapters.filter((c) => ids.has(c)))] : [];
  return { stars, chapters };
}

function loadStars() {
  try { return cleanStars(JSON.parse(localStorage.getItem(STARS_KEY) ?? 'null')); } catch { return cleanStars(null); }
}

function saveStars(st) {
  const raw = JSON.stringify(st);
  try { localStorage.setItem(STARS_KEY, raw); } catch { /* инкогнито */ }
  cloudSave(STARS_KEY, raw);
  return st;
}

/** @returns {Record<string, number>} лучшие звёзды по боям */
export function ascentStars() { return loadStars().stars; }

/**
 * Итог боя: лучшее — в память, монеты — за новые звёзды (как у испытаний).
 * @returns {{gained:number, coins:number}}
 */
export function saveAscentStars(id, stars) {
  const st = loadStars();
  const was = st.stars[id] ?? 0;
  if (stars <= was || !ASCENT_BY_ID[id]) return { gained: 0, coins: 0 };
  st.stars[id] = stars;
  saveStars(st);
  return { gained: stars - was, coins: (stars - was) * STAR_COINS };
}

/**
 * Главы, пройденные целиком, за которые коробка ещё не выдана, — отметить
 * выданными. Задним числом тоже: кто прошёл главу до появления наград,
 * получит их при первом открытии карты. Коробки кладёт вызывающий.
 * @returns {string[]} id глав
 */
export function claimChapterBoxes() {
  const done = ascentDone();
  const st = loadStars();
  const fresh = CHAPTERS.filter((c) => !st.chapters.includes(c.id) && chapterCleared(c.id, done)).map((c) => c.id);
  if (fresh.length) saveStars({ ...st, chapters: [...st.chapters, ...fresh] });
  return fresh;
}

/** Облачная копия звёзд: лучшее из двух, главы — объединение. */
export async function syncAscentStarsCloud() {
  if (!cloudReady()) return;
  const st = loadStars();
  for (const raw of await cloudLoad(STARS_KEY)) {
    let c = null;
    try { c = cleanStars(JSON.parse(raw)); } catch { continue; }
    for (const [id, n] of Object.entries(c.stars)) st.stars[id] = Math.max(st.stars[id] ?? 0, n);
    st.chapters = [...new Set([...st.chapters, ...c.chapters])];
  }
  saveStars(st);
}
