/**
 * Поднимает настоящий сервер игры (server/index.mjs: API аккаунтов и
 * статика) с временной базой, гоняет наборы тестов, гасит сервер.
 * Отдельный файл, чтобы `npm test` работал одной командой.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'worms-test-'));

// Порт просим у системы (0 = любой свободный). С фиксированным номером
// второй прогон падал на «адрес занят», стоило предыдущему зависнуть или
// пережить своё убийство.
const server = spawn(process.execPath,
  ['--disable-warning=ExperimentalWarning', 'server/index.mjs'], {
    env: {
      ...process.env,
      PORT: process.env.PORT || '0',
      HOST: '127.0.0.1',
      STATIC_DIR: ROOT,
      DB_PATH: join(tmp, 'worms.db'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const port = await new Promise((resolve, reject) => {
  let out = '';
  server.stdout.on('data', (c) => {
    out += c;
    const m = /порт (\d+)/.exec(out);
    if (m) resolve(Number(m[1]));
  });
  server.on('exit', (code) => reject(new Error(`сервер не запустился (код ${code})`)));
});
server.stdout.resume();
console.log(`игра и API на http://127.0.0.1:${port}\n`);

// Можно взять один набор: node tests/run.mjs net
const only = process.argv[2];
// match и серверные идут первыми: они без браузера, считают секунды и ловят
// расхождения раньше, чем на них уйдёт полчаса браузерных прогонов.
const suites = ['match', 'server', 'api', 'weapons', 'smoke', 'desktop', 'single', 'net', 'lobby',
  'supabase', 'telegram', 'tgapp'].filter((s) => !only || s === only);

let code = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const c = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      ['--disable-warning=ExperimentalWarning', `tests/${suite}.mjs`, `http://127.0.0.1:${port}`],
      { stdio: 'inherit' });
    child.on('exit', (n) => resolve(n ?? 1));
  });
  if (c) code = c;
}
server.kill();
rmSync(tmp, { recursive: true, force: true });
process.exit(code);
