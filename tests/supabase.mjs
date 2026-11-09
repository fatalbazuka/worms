/**
 * Проверка подключения к Supabase — всё, что можно проверить, не зная,
 * есть ли у машины интернет.
 *
 *   node tests/supabase.mjs http://127.0.0.1:5187
 *
 * Сам обмен сообщениями проверяется в tests/net.mjs: там транспорт
 * подменён, потому что протокол от транспорта не зависит. Здесь — что
 * клиент грузится локально, что ключи публичные, что канал называется как
 * надо и что недоступный Realtime не ломает игру.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:5173';
const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// --- статически: в репозитории не должно быть закрытого ключа ---
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'assets') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html|json|md)$/.test(name)) out.push(p);
  }
  return out;
}
// Ищем именно ключ, а не слово: «service_role» встречается в тексте и в
// самой библиотеке, и ловить надо не упоминание, а подписанный токен.
function secretKeys(text) {
  const bad = [];
  if (/\bsb_secret_[\w-]{10,}/.test(text)) bad.push('sb_secret_');
  for (const m of text.matchAll(/eyJ[\w-]{10,}\.(eyJ[\w-]{10,})\./g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1], 'base64').toString());
      if (payload.role && payload.role !== 'anon') bad.push(`jwt role=${payload.role}`);
    } catch { /* не токен — не наша забота */ }
  }
  return bad;
}
const files = walk(process.cwd());
const leaked = files.flatMap((f) => secretKeys(readFileSync(f, 'utf8')).map((b) => `${f}: ${b}`));
check('закрытого ключа в репозитории нет', leaked.length === 0, leaked.join(', '));

const cfgSrc = readFileSync('src/net/supabase.js', 'utf8');
check('ключ в конфиге публичный',
  /sb_publishable_/.test(cfgSrc) && /"?role"?:"anon"/.test(
    Buffer.from((cfgSrc.match(/eyJ[\w-]+\.(eyJ[\w-]+)\./) ?? [, ''])[1] || '', 'base64').toString(),
  ), 'publishable + legacy anon');

// --- в браузере ---
const browser = await chromium.launch(
  launchOptions(),
);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const external = [];
const attempts = [];
page.on('request', (r) => {
  const url = r.url();
  const host = url.split('/')[2] ?? '';
  // Внешние адреса вообще тут есть — у Phaser своя цепочка CDN. Ловим
  // только загрузку клиента Supabase со стороны.
  if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')
    && /supabase|esm\.sh/.test(url)) external.push(url);
});
page.on('console', (m) => {
  const t = m.text();
  const k = t.includes('websocket?apikey=') && t.match(/apikey=([^&]+)/);
  if (k) attempts.push(k[1].slice(0, 16));
});
// Сами открытия сокета: их видно, даже когда сеть не пускает и соединение
// молча висит, — по консоли тогда не понять, пытался ли клиент вообще
const sockets = [];
page.on('websocket', (ws) => sockets.push(ws.url()));

await page.goto(`${BASE}/?biome=forest&room=WIRING`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__WORMS__?.scene.getScene('Game')?.turn?.activeWorm && !window.__WORMS__.scene.getScene('Game').landing(),
  null, { timeout: 40000 });
await page.waitForTimeout(9000);
const early = attempts.length;
const earlySockets = sockets.length;
await page.waitForTimeout(9000);

check('клиент supabase-js загружен',
  await page.evaluate(() => !!globalThis.supabase?.createClient));
check('клиент взят локально, а не с CDN', external.length === 0,
  external.slice(0, 2).join(', ') || 'внешних загрузок клиента нет');
const projectHost = (cfgSrc.match(/url:\s*'https:\/\/([^']+)'/) ?? [])[1] ?? '';
const realtime = sockets.filter((u) => u.includes('/realtime/v1/websocket'));
check('адрес проекта подставлен в сокет',
  realtime.length > 0 && realtime.every((u) => u.includes(projectHost) && /apikey=/.test(u)),
  realtime[0]?.replace(/apikey=[^&]+/, 'apikey=…') ?? `сокетов к Realtime нет (всего ${sockets.length})`);
check('после отказа нет шторма переподключений',
  attempts.length === early && realtime.length <= Math.max(earlySockets, 1) + 2,
  `ошибок ${early} → ${attempts.length}, сокетов ${earlySockets} → ${sockets.length}`);

const state = await page.evaluate(() => {
  const s = window.__WORMS__.scene.getScene('Game');
  return { canAct: s.canPlayerAct(), connected: !!s.net?.connected, status: s.netStatusText,
    state: s.turn.state };
});
check('игра играбельна при любом исходе подключения',
  state.canAct || state.connected, JSON.stringify(state));

const chan = await page.evaluate(async () => {
  const { supabaseConfig, loadCreateClient } = await import('/src/net/supabase.js');
  const cfg = supabaseConfig();
  const createClient = await loadCreateClient(cfg.lib);
  const client = createClient(cfg.url, cfg.anonKey);
  const topic = client.channel('worms:ABC123').topic;
  client.removeAllChannels();
  client.realtime.disconnect();
  return { topic, url: cfg.url, keys: [cfg.anonKey.slice(0, 16), cfg.legacyKey.slice(0, 6)] };
});
check('канал комнаты назван как надо', chan.topic === 'realtime:worms:ABC123', chan.topic);
check('адрес проекта задан', /^https:\/\/[a-z]+\.supabase\.co$/.test(chan.url), chan.url);
check('запасной ключ на месте', chan.keys[1].startsWith('eyJ'), chan.keys.join(' / '));

await browser.close();
console.log(failures.length
  ? `\nПРОВАЛЕНО: ${failures.length} — ${failures.join(', ')}`
  : '\nпроверки Supabase пройдены');
process.exit(failures.length ? 1 : 0);
