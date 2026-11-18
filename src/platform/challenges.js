/**
 * Звёзды испытаний игрока: на устройстве и копией в облаке Telegram.
 * Правила — в campaign/challenges.js.
 */
import { CHALLENGE_BY_ID, recordStars } from '../campaign/challenges.js';
import { inTelegram, cloudGet, cloudSet } from './telegram.js';

const STORE_KEY = 'worms.challenges.v1';

function clean(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [id, n] of Object.entries(raw)) {
      if (CHALLENGE_BY_ID[id]) out[id] = Math.max(0, Math.min(3, Math.floor(Number(n) || 0)));
    }
  }
  return out;
}

function load() {
  try { return clean(JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null')); } catch { return {}; }
}

function save(best) {
  const raw = JSON.stringify(best);
  try { localStorage.setItem(STORE_KEY, raw); } catch { /* инкогнито */ }
  if (inTelegram()) cloudSet(STORE_KEY, raw);
  return best;
}

export function challengeStars() { return load(); }

/** Итог испытания. @returns {{gained:number, coins:number}} */
export function saveChallenge(id, stars) {
  const res = recordStars(load(), id, stars);
  if (res.gained) save(res.best);
  return { gained: res.gained, coins: res.coins };
}

/** Облачная копия: лучшее из двух. */
export async function syncChallengesCloud() {
  if (!inTelegram()) return;
  let cloud = null;
  try { cloud = clean(JSON.parse((await cloudGet(STORE_KEY)) ?? 'null')); } catch { cloud = null; }
  if (!cloud) return;
  const best = load();
  for (const [id, n] of Object.entries(cloud)) best[id] = Math.max(best[id] ?? 0, n);
  save(best);
}
