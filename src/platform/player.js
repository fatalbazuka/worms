/**
 * Кто играет.
 *
 * В Telegram личность берётся из initData — имя и идентификатор уже есть,
 * ничего спрашивать не нужно. В обычном браузере игрок анонимный: ему
 * выдаётся случайный идентификатор и имя «Боец NNNN», которое он может
 * поменять; всё это лежит в localStorage.
 *
 * Вошёл в аккаунт (ник и пароль на своём сервере или автоматически из
 * Telegram) — идентификатор, ник и рейтинг приходят с сервера
 * (src/net/server.js), и бои идут в общую таблицу лидеров. Аноним играет
 * на локальном рейтинге этого устройства — честном ровно до того, пока
 * никто не захочет его подкрутить.
 */

import { inTelegram, cloudGet, cloudSet } from './telegram.js';

const KEY = 'worms.player.v1';

let cached = null;

/** Стартовый рейтинг: 1000 — привычная точка отсчёта для Эло. */
export const START_RATING = 1000;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(p) {
  const raw = JSON.stringify(p);
  try {
    localStorage.setItem(KEY, raw);
  } catch { /* инкогнито — играем без сохранения */ }
  // В облако — не дожидаясь: игре ответ не нужен, а хранилище может
  // и промолчать
  if (inTelegram()) cloudSet(KEY, raw);
}

/**
 * Подтянуть профиль из CloudStorage до первого обращения к player().
 *
 * Вызывается один раз при запуске, до создания игры. Облако главнее
 * локальной копии: локальная — это то, что наиграли на этом устройстве
 * до того, как профиль стал облачным, облачная — то, что у аккаунта.
 * Если в облаке пусто, локальная копия отправляется туда сама при
 * первом сохранении.
 */
export async function loadCloudProfile() {
  if (!inTelegram()) return null;
  const raw = await cloudGet(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return null;
    localStorage.setItem(KEY, raw);
    cached = null;
    return p;
  } catch {
    return null;
  }
}

function randomId() {
  return `g${Math.random().toString(36).slice(2, 10)}`;
}

/** Данные Telegram, если игра открыта внутри клиента. */
function telegramUser() {
  const tg = globalThis.Telegram?.WebApp;
  const u = tg?.initDataUnsafe?.user;
  if (!u?.id) return null;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
    || u.username || `Игрок ${u.id}`;
  return { id: `tg${u.id}`, name, photo: u.photo_url ?? null, telegram: true };
}


/**
 * Профиль игрока. Telegram главнее сохранённого: если человек зашёл под
 * своим аккаунтом, имя должно быть его, а не выдуманное когда-то в браузере.
 */
export function player() {
  if (cached) return cached;

  const stored = load() ?? {};
  const tg = telegramUser();

  cached = {
    id: tg?.id ?? stored.id ?? randomId(),
    name: tg?.name ?? stored.name ?? `Боец ${Math.floor(1000 + Math.random() * 9000)}`,
    photo: tg?.photo ?? null,
    telegram: Boolean(tg),
    rating: Number.isFinite(stored.rating) ? stored.rating : START_RATING,
    wins: stored.wins ?? 0,
    losses: stored.losses ?? 0,
    // Вошёл ли в аккаунт на своём сервере: тогда id и ник — оттуда
    account: Boolean(stored.account),
    rank: Number.isFinite(stored.rank) ? stored.rank : null,
  };
  // Вошёл в аккаунт — идентификатор и ник оттуда, даже внутри Telegram:
  // там можно завести аккаунт и по нику, если у сервера нет токена бота
  if (cached.account && stored.id) {
    cached.id = stored.id;
    cached.name = stored.name ?? cached.name;
    cached.telegram = Boolean(stored.telegram);
  }
  save(cached);
  return cached;
}

/**
 * Профиль с сервера: вошли в аккаунт, сервер подтвердил бой или прислал
 * свежие числа. Его данные главные; локальный Эло — только предварительный
 * показ, пока ответа нет.
 *
 * Объект профиля правится на месте, а не подменяется: лобби и сетевая
 * сессия держат ссылку на него, и после входа они должны сразу видеть
 * новый идентификатор и ник.
 */
export function adoptAccount(row) {
  if (!row || typeof row !== 'object') return player();
  const p = player();
  if (typeof row.id === 'string' && row.id) p.id = row.id;
  if (typeof row.name === 'string' && row.name) p.name = row.name;
  if (Number.isFinite(row.rating)) p.rating = row.rating;
  if (Number.isFinite(row.wins)) p.wins = row.wins;
  if (Number.isFinite(row.losses)) p.losses = row.losses;
  p.rank = Number.isFinite(row.rank) ? row.rank : null;
  p.account = true;
  if (typeof row.telegram === 'boolean') p.telegram = row.telegram;
  save(p);
  return p;
}

/**
 * Вышли из аккаунта: дальше играем анонимом с чистым профилем. Числа
 * аккаунта на устройстве не остаются — они живут на сервере.
 */
export function dropAccount() {
  const p = player();
  const tg = telegramUser();
  p.id = tg?.id ?? randomId();
  p.name = tg?.name ?? `Боец ${Math.floor(1000 + Math.random() * 9000)}`;
  p.rating = START_RATING;
  p.wins = 0;
  p.losses = 0;
  p.rank = null;
  p.account = false;
  p.telegram = Boolean(tg);
  save(p);
  return p;
}

export function setName(name) {
  const p = player();
  p.name = String(name).trim().slice(0, 20) || p.name;
  save(p);
  return p;
}

/** Записать итог боя. Возвращает изменение рейтинга. */
export function recordResult(won, delta) {
  const p = player();
  p.rating = Math.max(100, Math.round(p.rating + delta));
  if (won) p.wins += 1; else p.losses += 1;
  save(p);
  return p;
}

/**
 * Эло. K=24 — сдвиг заметный, но не швыряет рейтинг после одного боя.
 * Считают обе стороны у себя, независимо: формула симметричная, и при
 * одинаковых входных данных результат совпадает без всякой сверки.
 */
export function eloDelta(mine, theirs, won) {
  const expected = 1 / (1 + 10 ** ((theirs - mine) / 400));
  return Math.round(24 * ((won ? 1 : 0) - expected));
}

/** Звание по рейтингу — то, что видно в лобби рядом с именем. */
export function rankName(rating) {
  if (rating < 900) return 'новобранец';
  if (rating < 1100) return 'боец';
  if (rating < 1300) return 'ветеран';
  if (rating < 1500) return 'снайпер';
  return 'легенда';
}
