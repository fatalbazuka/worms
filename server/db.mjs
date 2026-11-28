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
  // 9: промокоды — код даёт коробки/монеты/скин, один раз на игрока
  `
  create table promo (
    code        text primary key,               -- нижний регистр
    boxes       integer not null default 0,
    coins       integer not null default 0,
    skin        text,
    max_uses    integer,                        -- null — без лимита
    uses        integer not null default 0,
    expires_at  integer,                        -- null — бессрочный
    created_at  integer not null,
    disabled_at integer
  );
  create table promo_use (
    code       text not null references promo (code) on delete cascade,
    player_id  text not null references player (id) on delete cascade,
    created_at integer not null,
    primary key (code, player_id)
  );
  insert into promo (code, boxes, created_at) values ('skipper77', 3, cast(strftime('%s','now') as integer) * 1000);
  `,
  // 10: друзья — кого позвал, кто позвал тебя, с кем сыграл бой на рейтинг.
  // Своей таблицы дружбы нет: друзья выводятся из player.referred_by и
  // match, здесь только индексы под это и журнал сообщений боту о друзьях
  // (обогнал, вызов на бой) — чтобы не писать одному и тому же чаще правил
  `
  create index if not exists player_referred on player (referred_by) where referred_by is not null;
  create index if not exists match_p1 on match (p1, status);
  create index if not exists match_p2 on match (p2, status);
  create table if not exists friend_ping (
    id         integer primary key,
    kind       text not null,                   -- overtake | duel
    from_id    text not null references player (id) on delete cascade,
    to_id      text not null references player (id) on delete cascade,
    day        text not null,                   -- YYYY-MM-DD в поясе бота
    created_at integer not null
  );
  create index if not exists friend_ping_to on friend_ping (to_id, day, kind);
  create index if not exists friend_ping_from on friend_ping (from_id, day, kind);
  `,
  // 11: дуэли по переписке — партия на двоих, где каждый ходит, когда
  // удобно (server/duels.mjs). Ход n партии делает p1 при нечётном n и p2
  // при чётном: команды в бою чередуются строго. duel_turn — история
  // ходов: приказы для показа и снимок итога — по ним клиент
  // восстанавливает партию с нуля. Только новые таблицы — старое не трогаем
  `
  create table if not exists duel (
    id            integer primary key,
    p1            text not null references player (id),   -- создатель, ходит первым (команда 0)
    p2            text references player (id),            -- null — ждём, кто примет ссылку
    code          text unique,                             -- код ссылки-приглашения
    seed          integer not null,
    turn          integer not null default 1,              -- номер хода, который ждём
    deadline      integer,                                 -- до когда ходить, мс; null — ход не идёт
    skips1        integer not null default 0,              -- пропусков подряд у p1
    skips2        integer not null default 0,
    seen1         integer,                                 -- когда p1 последний раз смотрел дуэль
    seen2         integer,
    reminded_turn integer,                                 -- за какой ход уже напомнили
    status        text not null default 'active' check (status in ('open', 'active', 'finished', 'cancelled')),
    winner        text references player (id),             -- null при ничьей
    reason        text,                                    -- kill | draw | resign | timeout
    created_at    integer not null,
    updated_at    integer not null,
    finished_at   integer
  );
  create index if not exists duel_p1 on duel (p1, status);
  create index if not exists duel_p2 on duel (p2, status);
  create index if not exists duel_deadline on duel (status, deadline);
  create table if not exists duel_turn (
    duel_id    integer not null references duel (id) on delete cascade,
    n          integer not null,                           -- номер хода в партии
    player_id  text not null references player (id),
    kind       text not null default 'move' check (kind in ('move', 'skip')),
    cmds       text,                                       -- JSON: что делал игрок (ходьба, трос, оружие, выстрел)
    state      text,                                       -- JSON: снимок итога хода — истина
    hash       text,                                       -- свёртка итога у ходившего
    seen_hash  text,                                       -- что вышло у следующего, восстановившего ход
    created_at integer not null,
    primary key (duel_id, n)
  );
  `,
  // 12: кто позвал в комнату вызова (карточка в чат, @бот, вызов друга).
  // Друг открыл ссылку, когда позвавшего уже нет в игре, — бот пишет
  // позвавшему «заходи» (server/bot.mjs knockRoom). Старые строки чистятся
  `
  create table if not exists room_owner (
    room       text primary key,
    tg_id      integer not null,
    name       text not null,
    created_at integer not null,
    knocked_at integer
  );
  create index if not exists room_owner_created on room_owner (created_at);
  `,
  // 13: за какой ход дуэли игроку уже написали «твой ход» (или он сам его
  // увидел). Если писать не стали — «он же смотрит дуэль» — а он тут же
  // закрыл игру, сообщение досылается по часам (server/duels.mjs tick)
  `
  alter table duel add column notified_turn integer;
  update duel set notified_turn = turn;
  `,
  // 14: по каким правилам идёт дуэль. 1 — как было; 2 — с «арсеналом боя»
  // (пять оружий сверх базовых у обеих сторон). Начатые раньше дуэли
  // доигрываются по своим правилам: их патроны уже записаны в ходах
  `
  alter table duel add column rules integer not null default 1;
  `,
  // 15: код игрока — пять знаков, чтобы вызвать на дуэль без общего чата
  // (назвал голосом, переписал с экрана). Выдаётся при первом показе профиля.
  // И сдвиг рейтинга за дуэль по переписке: дуэли теперь на рейтинг
  `
  alter table player add column code text;
  create unique index if not exists player_code on player (code);
  alter table duel add column delta integer;
  `,
  // 16: журнал запусков страницы — почему игра иногда не открывается
  // (server/bootlog.mjs). Без ссылки на игрока: до входа дело может не дойти
  `
  create table if not exists boot_log (
    id         integer primary key,
    boot       text not null,            -- id запуска со страницы
    created_at integer not null,
    outcome    text not null,            -- ok | stuck | error | closed | lost
    stage      text,                     -- последний пройденный этап
    ms         integer,                  -- с начала загрузки страницы
    tg_id      integer,
    platform   text,
    tg_version text,
    net        text,
    ua         text,
    error      text,
    stages     text                      -- JSON: этап → мс
  );
  create index if not exists boot_log_time on boot_log (created_at);
  `,
  // 17: игроки-боты (server/simbots.mjs): уровень, сколько сыграл за день;
  // в дуэли — когда «сходит» бот; кого и когда боты вызывали; настройки
  `
  alter table player add column sim text;                  -- weak | mid | strong; у людей null
  alter table player add column sim_day text;
  alter table player add column sim_games integer not null default 0;
  alter table duel add column bot_due integer;
  alter table duel add column bot_pinged integer;         -- за какой ход человеку уже написали
  create table if not exists sim_challenge (
    player_id  text primary key references player (id) on delete cascade,
    at         integer not null
  );
  create table if not exists setting (
    key        text primary key,
    value      text not null
  );
  `,
  // 18: сезоны рейтинга (server/seasons.mjs): партий на рейтинг за сезон,
  // сами сезоны и итоги игроков с наградой
  `
  alter table player add column season_games integer not null default 0;
  create table if not exists season (
    id          integer primary key,
    starts_at   integer not null,
    ends_at     integer not null,
    finished_at integer
  );
  create table if not exists season_result (
    season_id  integer not null references season (id),
    player_id  text not null references player (id) on delete cascade,
    rank       integer not null,
    rating     integer not null,
    league     text not null,
    boxes      integer not null default 0,
    coins      integer not null default 0,
    title      text,
    primary key (season_id, player_id)
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
