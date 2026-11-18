/**
 * Пройденные бои «Подъёма»: на устройстве и копией в облаке Telegram.
 * Правила и сами бои — campaign/ascent.js.
 */
import { ASCENT_BY_ID } from '../campaign/ascent.js';
import { inTelegram, cloudGet, cloudSet } from './telegram.js';

const STORE_KEY = 'worms.ascent.v1';

function clean(raw) {
  return new Set(Array.isArray(raw) ? raw.filter((id) => ASCENT_BY_ID[id]) : []);
}

function save(done) {
  const raw = JSON.stringify([...done]);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  if (inTelegram()) cloudSet(STORE_KEY, raw);
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
  if (!inTelegram()) return;
  let cloud = null;
  try { cloud = clean(JSON.parse((await cloudGet(STORE_KEY)) ?? 'null')); } catch { cloud = null; }
  if (!cloud?.size) return;
  const done = ascentDone();
  for (const id of cloud) done.add(id);
  save(done);
}
