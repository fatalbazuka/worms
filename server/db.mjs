/**
 * База — один файл SQLite (встроенный в Node модуль node:sqlite, без
 * зависимостей). Для игры на сотни и тысячи игроков этого с запасом:
 * запись — пара строк на бой, чтение — одна выборка таблицы лидеров.
 *
 * Схема версионируется через PRAGMA user_version: новая версия схемы —
 * новый шаг в MIGRATIONS, старые шаги не трогаем.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  // 1 — игроки, входы, бои
  `
  create table player (
    id         text primary key,            -- u<hex> — по нику, tg<id> — из Telegram
    name       text not null,
    name_key   text unique,                  -- ник в нижнем регистре; у Telegram — null
    pass_hash  text,                         -- scrypt; у Telegram — null
    tg_id      integer unique,
    rating     integer not null default 1000,
    wins       integer not null default 0,
    losses     integer not null default 0,
    created_at integer not null,
    seen_at    integer not null
  );
  create index player_rating on player (rating desc, wins desc);

  create table session (
    token_hash text primary key,             -- sha256 токена; сам токен только у игрока
    player_id  text not null references player (id) on delete cascade,
    created_at integer not null,
    seen_at    integer not null
  );
  create index session_player on session (player_id);

  -- Бой засчитывается, когда обе стороны прислали согласные итоги
  create table match (
    id         integer primary key,
    room       text not null,
    seed       integer not null,
    p1         text not null references player (id),
    p2         text not null references player (id),
    p1_claim   text not null check (p1_claim in ('win', 'loss')),
    p2_claim   text check (p2_claim in ('win', 'loss')),
    status     text not null default 'pending' check (status in ('pending', 'confirmed', 'disputed')),
    delta      integer,
    created_at integer not null,
    settled_at integer,
    unique (room, seed)
  );
  `,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 3000;');
  const version = db.prepare('pragma user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('begin');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
  }
  return db;
}

/** Выполнить fn в транзакции: всё или ничего. */
export function tx(db, fn) {
  db.exec('begin immediate');
  try {
    const out = fn();
    db.exec('commit');
    return out;
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}
