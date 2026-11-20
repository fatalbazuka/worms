/**
 * Прогресс игры на сервере: скины, монеты и задания, звёзды испытаний,
 * пройденная кампания, украшения, уровень игрока, достижения.
 *
 * Игра хранит их на устройстве и в облаке Telegram. Чтобы с сайта по логину
 * был тот же аккаунт, что в Telegram, она кладёт их и сюда — как есть,
 * строкой JSON по ключу. Сводит копии сама игра (merge* в core/*): сервер
 * ничего не разбирает, только хранит последнюю запись.
 */

/** Какие ключи можно хранить — те же, что в localStorage игры. */
export const SAVE_KEYS = new Set([
  'worms.skins.v1', 'worms.daily.v1', 'worms.challenges.v1', 'worms.ascent.v1', 'worms.cosmetics.v1',
  'worms.level.v1', 'worms.ach.v1', 'worms.dailytower.v1',
]);
const MAX_VALUE = 32 * 1024;

export function createSaves({ db, now = () => Date.now() }) {
  const q = {
    all: db.prepare('select key, value from save_kv where player_id = ?'),
    put: db.prepare(`insert into save_kv (player_id, key, value, updated_at) values (?, ?, ?, ?)
                     on conflict (player_id, key) do update set value = excluded.value, updated_at = excluded.updated_at`),
  };

  /** Всё сохранённое игрока: { ключ: строка }. */
  function all(playerId) {
    return Object.fromEntries(q.all.all(playerId).map((r) => [r.key, r.value]));
  }

  /** Записать. @returns {string|null} ошибка или null */
  function put(playerId, key, value) {
    if (!SAVE_KEYS.has(key)) return 'нет такого ключа';
    if (typeof value !== 'string' || value.length > MAX_VALUE) return 'слишком большое значение';
    try { JSON.parse(value); } catch { return 'не JSON'; }
    q.put.run(playerId, key, value, now());
    return null;
  }

  return { all, put };
}
