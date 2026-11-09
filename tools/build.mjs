#!/usr/bin/env node
/**
 * Сборка для развёртывания без Docker: складывает в dist/ ровно то, что
 * нужно браузеру, и пишет env.js из переменных окружения. Сборщика кода
 * нет и не нужно — dist/ можно отдавать любым статическим сервером:
 *
 *   TELEGRAM_BOT=имя_бота npm run build
 *   rsync -a --delete dist/ user@server:/var/www/worms/
 *
 * Переменные те же, что у контейнера: SUPABASE_URL, SUPABASE_ANON_KEY,
 * SUPABASE_LEGACY_KEY, TELEGRAM_BOT, TELEGRAM_APP, WORMS_UI.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, process.env.OUT_DIR || 'dist');

const FILES = ['index.html', 'manifest.webmanifest'];
const DIRS = ['src', 'vendor', 'assets'];
// Исходные рипы спрайтов (17 МБ) нужны только сборщику ассетов
const SKIP = [join('assets', 'raw'), join('assets', 'README.md')];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of FILES) cpSync(join(root, f), join(out, f));
for (const d of DIRS) {
  cpSync(join(root, d), join(out, d), {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src);
      return !SKIP.some((s) => rel === s || rel.startsWith(s + sep));
    },
  });
}

const env = process.env;
const str = (v) => JSON.stringify(String(v));
const pick = (pairs) => pairs
  .filter(([, v]) => v)
  .map(([k, v]) => `  ${k}: ${str(v)},`)
  .join('\n');

const net = pick([['url', env.SUPABASE_URL], ['anonKey', env.SUPABASE_ANON_KEY],
  ['legacyKey', env.SUPABASE_LEGACY_KEY]]);
const tg = pick([['bot', env.TELEGRAM_BOT], ['app', env.TELEGRAM_APP]]);
const ui = ['desktop', 'touch'].includes(env.WORMS_UI)
  ? `window.WORMS_UI = window.WORMS_UI || ${str(env.WORMS_UI)};\n` : '';

writeFileSync(join(out, 'env.js'), [
  `// Сгенерировано npm run build (${new Date().toISOString()}).`,
  'window.WORMS_NET = Object.assign({', net, '}, window.WORMS_NET || {});',
  'window.WORMS_TG = Object.assign({', tg, '}, window.WORMS_TG || {});',
  '',
].filter((l) => l !== '').join('\n') + '\n' + ui);

if (!existsSync(join(out, 'vendor', 'phaser.min.js'))) {
  console.error('нет vendor/phaser.min.js — игра не запустится без CDN');
  process.exit(1);
}
console.log(`готово: ${relative(root, out) || '.'}/`);
