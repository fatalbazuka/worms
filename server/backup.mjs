#!/usr/bin/env node
/**
 * Копия базы на ходу, без остановки сервера:
 *
 *   docker compose exec api node server/backup.mjs
 *   # → /data/backups/worms-2026-11-09T12-00-00.db (в томе worms_data)
 *
 * VACUUM INTO пишет целостный снимок даже под нагрузкой — в отличие от
 * простого копирования файла, которое при включённом WAL может поймать
 * базу на полпути. Хранит последние KEEP копий (по умолчанию 14).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dbPath = process.env.DB_PATH || './data/worms.db';
const dir = process.env.BACKUP_DIR || join(dirname(dbPath), 'backups');
const keep = Number(process.env.KEEP) || 14;

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(dir, `worms-${stamp}.db`);

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`vacuum into '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`копия: ${out}`);

const old = readdirSync(dir).filter((f) => /^worms-.*\.db$/.test(f)).sort().slice(0, -keep);
for (const f of old) rmSync(join(dir, f));
if (old.length) console.log(`удалены старые: ${old.length}`);
