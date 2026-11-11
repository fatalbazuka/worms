#!/usr/bin/env node
/**
 * Восстановить базу из копии. Сервер (контейнер api) должен быть
 * остановлен:
 *
 *   docker compose stop api
 *   docker compose run --rm --no-deps -v "$PWD/backups:/restore:ro" api \
 *     node server/restore.mjs /restore/worms-<время>.db
 *   docker compose start api
 *
 * Копия сначала проверяется (integrity_check и наличие таблиц игры), и
 * только потом встаёт на место. Журнал WAL от старой базы убирается —
 * иначе SQLite попытался бы применить его к новой. Текущая база не
 * пропадает: она переименовывается в worms.db.before-restore-<время>.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';

const src = process.argv[2];
const dbPath = process.env.DB_PATH || './data/worms.db';
if (!src || !existsSync(src)) {
  console.error('укажи файл копии: node server/restore.mjs <путь к worms-….db>');
  process.exit(1);
}

const check = new DatabaseSync(src, { readOnly: true });
const ok = check.prepare('pragma integrity_check').get().integrity_check === 'ok';
const tables = check.prepare("select name from sqlite_master where type = 'table'").all().map((t) => t.name);
const players = tables.includes('player') ? check.prepare('select count(*) as n from player').get().n : -1;
check.close();
if (!ok || players < 0) {
  console.error(`это не копия базы игры или она повреждена (integrity ${ok ? 'ok' : 'FAIL'}, таблицы: ${tables.join(', ')})`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const tmp = `${dbPath}.restore-tmp`;
copyFileSync(src, tmp);
if (existsSync(dbPath)) renameSync(dbPath, `${dbPath}.before-restore-${stamp}`);
for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(side)) unlinkSync(side);
renameSync(tmp, dbPath);
console.log(`восстановлено из ${src}: игроков ${players}. Старая база — ${dbPath}.before-restore-${stamp}`);
