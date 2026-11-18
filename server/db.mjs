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
  // 2 — только Telegram: аватар, серии, титулы; турниры; платежи звёздами
  `
  alter table player add column photo text;
  alter table player add column streak integer not null default 0;
  alter table player add column best_streak integer not null default 0;
  alter table player add column tourney_wins integer not null default 0;
  alter table player add column titles text not null default '[]';

  create table tournament (
    id          integer primary key,
    name        text not null,
    size        integer not null,                 -- мест: 4, 8, 16
    fee         integer not null default 0,       -- взнос в звёздах, 0 — бесплатно
    status      text not null default 'open'
                check (status in ('open', 'running', 'finished', 'cancelled')),
    starts_at   integer,                          -- автостарт, мс; null — вручную
    created_at  integer not null,
    started_at  integer,
    finished_at integer,
    winner      text references player (id)
  );

  create table tournament_player (
    tid        integer not null references tournament (id),
    player_id  text not null references player (id),
    joined_at  integer not null,
    charge_id  text,                              -- оплата взноса, если был
    primary key (tid, player_id)
  );

  -- Матч сетки. Слот k раунда r питается победителями слотов 2k и 2k+1
  -- раунда r-1. Пустой p2 — проход без игры.
  create table tournament_match (
    id          integer primary key,
    tid         integer not null references tournament (id),
    round       integer not null,
    slot        integer not null,
    p1          text references player (id),
    p2          text references player (id),
    room        text not null unique,
    p1_claim    text check (p1_claim in ('win', 'loss')),
    p2_claim    text check (p2_claim in ('win', 'loss')),
    winner      text references player (id),
    status      text not null default 'pending' check (status in ('pending', 'done', 'disputed')),
    deadline    integer,
    settled_at  integer,
    unique (tid, round, slot)
  );

  create table payment (
    charge_id   text primary key,                 -- telegram_payment_charge_id
    player_id   text not null references player (id),
    tg_id       integer not null,
    amount      integer not null,
    purpose     text not null,                    -- donate | tournament
    ref         text,
    created_at  integer not null,
    refunded_at integer
  );
  `,
  // 3 — статистика (события игроков) и напоминания о серии дней
  `
  create table event (
    id         integer primary key,
    player_id  text not null references player (id) on delete cascade,
    day        text not null,                     -- YYYY-MM-DD в поясе бота
    name       text not null,                     -- open | battle
    props      text,                              -- JSON
    created_at integer not null
  );
  create index event_day on event (day, name);
  create index event_player on event (player_id, day);

  alter table player add column remind integer not null default 1;   -- 0 — отписался (/mute)
  alter table player add column last_streak integer not null default 0;
  alter table player add column reminded_day text;
  `,
  // 4 — подарки (коробка за приглашённого друга) и кто кого пригласил
  `
  create table bonus (
    id         integer primary key,
    player_id  text not null references player (id) on delete cascade,
    boxes      integer not null,
    reason     text not null,                     -- ref-host | ref-guest
    ref        text,
    created_at integer not null
  );
  create index bonus_player on bonus (player_id);
  alter table player add column referred_by text;
  `,
  // 5: когда игрок впервые открыл саму игру (а не только /start в чате с
  // ботом). Новичок для подарка за друга — тот, кто игру ещё не открывал.
  // Кто уже что-то делал в игре, тот её открывал
  `
  alter table player add column app_at integer;
  update player set app_at = created_at
    where exists (select 1 from event e where e.player_id = player.id)
       or wins + losses > 0;
  `,
  // 6: «Башня дня» — лучшая попытка игрока за день
  `
  create table daily_tower (
    day        text not null,
    player_id  text not null references player (id) on delete cascade,
    won        integer not null,
    turns      integer not null,
    hp         integer not null,
    tries      integer not null default 1,
    created_at integer not null,
    primary key (day, player_id)
  );
  `,
  // 7: прогресс игры на сервере (скины, монеты, задания, кампания,
  // украшения) — чтобы с сайта по логину был тот же аккаунт, что в Telegram
  `
  create table save_kv (
    player_id  text not null references player (id) on delete cascade,
    key        text not null,
    value      text not null,
    updated_at integer not null,
    primary key (player_id, key)
  );
  `,
  // 8: админка — подарки монетами и скином (в bonus), бан, журнал рассылок
  `
  alter table bonus add column coins integer not null default 0;
  alter table bonus add column skin text;
  alter table player add column banned_at integer;
  create table broadcast (
    id         integer primary key,
    text       text not null,
    total      integer not null default 0,
    sent       integer not null default 0,
    failed     integer not null default 0,
    created_at integer not null,
    done_at    integer
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
