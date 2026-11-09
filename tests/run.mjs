/**
 * Поднимает статику на свободном порту, гоняет smoke.mjs, гасит сервер.
 * Отдельный файл, чтобы `npm test` работал одной командой.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
// Порт просим у системы (0 = любой свободный). С фиксированным номером
// второй прогон падал на «адрес занят», стоило предыдущему зависнуть или
// пережить своё убийство.
const PORT = Number(process.env.PORT) || 0;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const path = join(ROOT, normalize(rel === '/' ? '/index.html' : rel));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const port = server.address().port;
console.log(`статика на http://127.0.0.1:${port}\n`);

// Наборов два: обычная игра и сетевая партия из двух вкладок.
// Можно взять один: node tests/run.mjs net
const only = process.argv[2];
// match идёт первым: он без браузера, считает секунды и ловит расхождения
// в подборе раньше, чем на них уйдёт полчаса браузерных прогонов.
const suites = ['match', 'server', 'weapons', 'smoke', 'desktop', 'single', 'net', 'lobby', 'supabase', 'telegram']
  .filter((s) => !only || s === only);

let code = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const c = await new Promise((resolve) => {
    const child = spawn(process.execPath, [`tests/${suite}.mjs`, `http://127.0.0.1:${port}`],
      { stdio: 'inherit' });
    child.on('exit', (n) => resolve(n ?? 1));
  });
  if (c) code = c;
}
server.close();
process.exit(code);
