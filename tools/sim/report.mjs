#!/usr/bin/env node
/**
 * Сводка прогона симуляции в таблицы: docs/sim-report.md.
 *
 *   node tools/sim/report.mjs [tools/sim/report.json] [--before tools/sim/report-before.json] [--perf tools/sim/perf.json]
 *
 * Ничего не придумывает — только считает по report.json (tools/sim/run.mjs)
 * и perf.json (tools/sim/perf.mjs). Разделы с выводами и починками пишутся
 * руками в docs/sim-report.md ниже маркера <!-- auto:end -->, и пересборка
 * их не трогает.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SRC = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) ?? 'tools/sim/report.json';
const BEFORE = opt('before', null);
const PERF = opt('perf', 'tools/sim/perf.json');
const OUT = opt('out', 'docs/sim-report.md');

const rep = JSON.parse(readFileSync(SRC, 'utf8'));
const before = BEFORE && existsSync(BEFORE) ? JSON.parse(readFileSync(BEFORE, 'utf8')) : null;
const R = rep.results;

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

const lines = [];
const P = (s = '') => lines.push(s);

P('# Симуляция «бот против бота» и замеры на слабом телефоне');
P();
P(`Источник: \`${SRC}\` (${rep.at}), ${rep.battles} боёв, ${rep.fps} к/с виртуального времени, ${rep.workers} страницы параллельно, ${rep.realMinutes} мин настоящего времени.`);
P('Пересобрать: `node tools/sim/run.mjs && node tools/sim/report.mjs`. Повтор одного боя: `node tools/sim/run.mjs --repro <id>`.');
P();

// --- общая сводка ---
const status = {};
for (const r of R) status[r.status] = (status[r.status] ?? 0) + 1;
const anomalies = {};
for (const r of R) for (const a of r.anomalies ?? []) anomalies[a.kind] = (anomalies[a.kind] ?? 0) + 1;
const withErr = R.filter((r) => r.errors?.length);
P('## Итог');
P();
P(table(['что', 'сколько'], [
  ['боёв всего', R.length],
  ...Object.entries(status).map(([k, v]) => [`статус ${k}`, v]),
  ['боёв с ошибками JS/консоли', withErr.length],
  ...Object.entries(anomalies).map(([k, v]) => [`аномалия ${k}`, v]),
  ['ходов «бот не выстрелил за таймер»', R.reduce((a, r) => a + (r.timeouts ?? 0), 0)],
  ['ходов-пропусков бота (нечем/некуда)', R.reduce((a, r) => a + (r.passes ?? 0), 0)],
]));
if (before) {
  const bStatus = {}; const bAn = {};
  for (const r of before.results) { bStatus[r.status] = (bStatus[r.status] ?? 0) + 1; for (const a of r.anomalies ?? []) bAn[a.kind] = (bAn[a.kind] ?? 0) + 1; }
  const keys = [...new Set([...Object.keys(bAn), ...Object.keys(anomalies)])];
  P();
  P('До и после починок (тот же набор боёв):');
  P();
  P(table(['что', 'до', 'после'], [
    ['боёв', before.results.length, R.length],
    ...[...new Set([...Object.keys(bStatus), ...Object.keys(status)])].map((k) => [`статус ${k}`, bStatus[k] ?? 0, status[k] ?? 0]),
    ['боёв с ошибками', before.results.filter((r) => r.errors?.length).length, withErr.length],
    ...keys.map((k) => [`аномалия ${k}`, bAn[k] ?? 0, anomalies[k] ?? 0]),
    ['ходов «бот не выстрелил за таймер»', before.results.reduce((a, r) => a + (r.timeouts ?? 0), 0), R.reduce((a, r) => a + (r.timeouts ?? 0), 0)],
  ]));
}
P();

// --- по видам боёв ---
P('## Бои по видам');
P();
const kinds = [...new Set(R.map((r) => r.kind))];
P(table(['вид', 'боёв', 'доиграно', 'ходов (медиана / макс)', 'время боя, с игры (медиана / макс)', 'аномалий'], kinds.map((k) => {
  const xs = R.filter((r) => r.kind === k);
  const turns = xs.map((r) => r.turns ?? 0), time = xs.map((r) => r.gameTime ?? 0);
  return [k, xs.length, xs.filter((r) => r.status === 'ok').length, `${q(turns, 0.5)} / ${Math.max(...turns)}`,
    `${q(time, 0.5)} / ${Math.max(...time)}`, xs.reduce((a, r) => a + (r.anomalies?.length ?? 0), 0)];
})));
P();

// --- победы по уровням (башня + классика, где за обе стороны обычные уровни) ---
P('## Победы по уровням ботов');
P();
P('Бои на башне и классических картах. Строка — уровень стороны, которая ходит первой (команда 0), столбец — соперник; в клетке — доля побед первой стороны и число боёв. Ничья считается не победой.');
P();
const LV = ['rookie', 'fighter', 'sniper', 'sim_all'];
if (before) P('С прогоном «до» в клетке через стрелку: было → стало.');
if (before) P();
for (const kind of ['tower', 'classic']) {
  const xs = R.filter((r) => r.kind === kind && r.status === 'ok');
  if (!xs.length) continue;
  const bs = before ? before.results.filter((r) => r.kind === kind && r.status === 'ok') : [];
  P(`**${kind}**`);
  P();
  const cols = LV.filter((l) => xs.some((r) => r.level1 === l));
  const cell = (rs, l0, l1) => {
    const c = rs.filter((r) => r.level0 === l0 && r.level1 === l1);
    return c.length ? `${pct(c.filter((r) => r.winner === 0).length, c.length)}` : null;
  };
  P(table(['первые ↓ / соперник →', ...cols], LV.filter((l) => xs.some((r) => r.level0 === l)).map((l0) => [l0, ...cols.map((l1) => {
    const now = cell(xs, l0, l1);
    if (!now) return '—';
    const n = xs.filter((r) => r.level0 === l0 && r.level1 === l1).length;
    const was = before ? cell(bs, l0, l1) : null;
    return was ? `${was} → ${now} (${n})` : `${now} (${n})`;
  })])));
  P();
}
// по видам башни
const tw = R.filter((r) => r.kind === 'tower' && r.status === 'ok');
if (tw.length) {
  P('По видам башни (все пары уровней вместе):');
  P();
  P(table(['вид', 'боёв', 'победа первых', 'ходов, медиана', 'смертей в воде/лаве', 'урон падением, в среднем'],
    [...new Set(tw.map((r) => r.variant))].map((v) => {
      const xs = tw.filter((r) => r.variant === v);
      return [v, xs.length, pct(xs.filter((r) => r.winner === 0).length, xs.length), q(xs.map((r) => r.turns), 0.5),
        xs.reduce((a, r) => a + (r.deaths?.['утонул'] ?? 0), 0), Math.round(xs.reduce((a, r) => a + (r.fallDamage ?? 0), 0) / xs.length)];
    })));
  P();
}
// Подъём и испытания: победа «игрока»
for (const kind of ['ascent', 'challenge', 'campaign']) {
  const xs = R.filter((r) => r.kind === kind);
  if (!xs.length) continue;
  const bx = before ? before.results.filter((r) => r.kind === kind) : [];
  P(`**${kind}**: бот за игрока выиграл ${xs.filter((r) => r.winner === 0).length} из ${xs.length}${bx.length ? ` (до — ${bx.filter((r) => r.winner === 0).length} из ${bx.length})` : ''}; не доиграно ${xs.filter((r) => r.status !== 'ok').length}.`);
  P();
  const lost = xs.filter((r) => r.winner !== 0);
  if (lost.length) {
    P(table(['бой', 'статус', 'итог', 'ходов', 'с игры'], lost.map((r) => [r.id, r.status, r.winner === null ? 'не кончился' : r.winner === -1 ? 'ничья' : `победа ${r.winner}`, r.turns, r.gameTime])));
    P();
  }
}

// --- оружие ---
P('## Оружие');
P();
P('Выстрел — каждый вызов onFired; «попал» — ход, где этот ствол снял здоровье у чужих; урон — снятое здоровье (не больше, чем было). «env» — урон до выстрела (аффиксы, монстры в начале хода), «monsters» — ход монстров и события места после выстрела.');
P();
const weaponStats = (rs) => {
  const W = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.weapons ?? {})) {
    const w = (W[k] ??= { shots: 0, hitTurns: 0, foeDamage: 0, selfDamage: 0, kills: 0 });
    for (const f of Object.keys(w)) w[f] += v[f] ?? 0;
  }
  return W;
};
const W = weaponStats(R);
const BW = before ? weaponStats(before.results) : null;
const shotsOf = (ws) => Object.values(ws).reduce((a, w) => a + w.shots, 0);
const allShots = shotsOf(W), bShots = BW ? shotsOf(BW) : 0;
const keys = [...new Set([...Object.keys(W), ...Object.keys(BW ?? {})])].sort((a, b) => (W[b]?.shots ?? 0) - (W[a]?.shots ?? 0) || (BW?.[b]?.shots ?? 0) - (BW?.[a]?.shots ?? 0));
P(table(['ствол', ...(BW ? ['до: выстрелов (доля)'] : []), 'выстрелов (доля)', 'ходов с попаданием', 'урон чужим', 'урон своим', 'на выстрел', 'добиваний'],
  keys.map((k) => {
    const w = W[k] ?? { shots: 0, hitTurns: 0, foeDamage: 0, selfDamage: 0, kills: 0 };
    const b = BW?.[k];
    return [k, ...(BW ? [b?.shots ? `${b.shots} (${pct(b.shots, bShots)})` : '—'] : []),
      w.shots ? `${w.shots} (${pct(w.shots, allShots)})` : '—',
      w.shots ? `${w.hitTurns} (${pct(w.hitTurns, w.shots)})` : w.hitTurns,
      w.foeDamage, w.selfDamage, w.shots ? (w.foeDamage / w.shots).toFixed(1) : '—', w.kills];
  })));
P();
// Чем стреляет каждый уровень (поле usage пишет agent.js с этой версии)
const usageOf = (rs) => {
  const U = {};
  for (const r of rs) for (const [lv, m] of Object.entries(r.usage ?? {})) for (const [k, n] of Object.entries(m)) (U[lv] ??= {})[k] = (U[lv][k] ?? 0) + n;
  return U;
};
const share = (m) => {
  if (!m) return '—';
  const t = Object.values(m).reduce((a, b) => a + b, 0);
  return Object.entries(m).sort((a, b) => b[1] - a[1]).filter(([, n]) => n / t >= 0.01).map(([k, n]) => `${k} ${pct(n, t)}`).join(', ');
};
const U = usageOf(R), BU = before ? usageOf(before.results) : {};
if (Object.keys(U).length) {
  P('Чем стреляет каждый уровень бота (доли выстрелов, от 1%):');
  P();
  P(table(['уровень', ...(before ? ['до'] : []), 'после'], LV.filter((l) => U[l] || BU[l]).map((l) => [l, ...(before ? [share(BU[l])] : []), share(U[l])])));
  P();
}
const deaths = {};
for (const r of R) for (const [k, v] of Object.entries(r.deaths ?? {})) deaths[k] = (deaths[k] ?? 0) + v;
P(`Причины гибели: ${Object.entries(deaths).map(([k, v]) => `${k} ${v}`).join(', ')}. Урон падением всего: ${R.reduce((a, r) => a + (r.fallDamage ?? 0), 0)}.`);
P();

// --- бот: время на решение ---
const dmBy = {};
for (const r of R) {
  // Старый формат — общий список на бой; новый — по уровням
  if (Array.isArray(r.decideMs)) (dmBy.all ??= []).push(...r.decideMs);
  else for (const [l, xs] of Object.entries(r.decideMs ?? {})) (dmBy[l] ??= []).push(...xs);
}
if (Object.keys(dmBy).length) {
  P('## Бот: время на решение хода');
  P();
  P('Настоящее время одного вызова Bot.decide (перебор траекторий) без замедления процессора, на общей нагруженной машине. Пока он считает, кадр стоит.');
  P();
  P(table(['уровень', 'решений', 'медиана, мс', 'p95, мс', 'p99, мс', 'максимум, мс'], Object.entries(dmBy).map(([l, xs]) => [l, xs.length, q(xs, 0.5), q(xs, 0.95), q(xs, 0.99), Math.max(...xs)])));
  P();
}

// --- аномалии с зёрнами ---
const list = R.filter((r) => r.anomalies?.length || r.errors?.length || r.status !== 'ok');
P('## Аномалии и ошибки (с воспроизведением)');
P();
if (!list.length) P('Нет.');
else {
  P(table(['бой (id для --repro)', 'зерно', 'статус', 'что', 'подробности'], list.slice(0, 80).map((r) => [
    `\`${r.id}\``, r.info?.seed ?? r.seed ?? '', r.status,
    [...new Set([...(r.anomalies ?? []).map((a) => a.kind), ...(r.errors?.length ? ['jsError'] : [])])].join(', '),
    String((r.errors?.[0] ?? JSON.stringify(r.anomalies?.[0] ?? r.error ?? '')).slice(0, 220)).replace(/\|/g, '/'),
  ])));
}
P();

// --- память ---
P('## Память между боями');
P();
P('Куча JS после сборки мусора (CDP HeapProfiler.collectGarbage → Runtime.getHeapUsage) в одной и той же странице по мере боёв, плюс счётчики объектов.');
P();
const byW = {};
for (const m of rep.memory) (byW[m.worker] ??= []).push(m);
P(table(['страница', 'после боёв', 'куча, МБ', 'текстур', 'DOM-узлов', 'слушателей game.events', 'объектов в меню'],
  Object.entries(byW).flatMap(([w, ms]) => ms.map((m) => [w, m.n, m.heapMB, m.counts?.textures, m.counts?.domNodes, m.counts?.gameListeners, m.counts?.menuChildren]))));
P();

// --- производительность ---
if (existsSync(PERF)) {
  const perf = JSON.parse(readFileSync(PERF, 'utf8'));
  const labels = Object.keys(perf);
  P('## Слабый телефон: FPS по экранам');
  P();
  P(`CDP Emulation.setCPUThrottlingRate ×${perf[labels[0]].rate}, окно ${perf[labels[0]].viewport}, headless Chromium (программный WebGL). Медиана и 95-й перцентиль времени кадра (95-й перцентиль кадра = 5-й перцентиль FPS). Прогонов на замер: ${labels.map((l) => `${l} — ${perf[l].runs}`).join(', ')}.`);
  P();
  const screens = Object.keys(perf[labels[0]].screens);
  P(table(['экран', ...labels.flatMap((l) => [`${l}: медиана, мс (к/с)`, `${l}: p95, мс (к/с)`, `${l}: худший, мс`])], [
    ['до меню от загрузки', ...labels.flatMap((l) => [`${perf[l].toMenuMs} мс`, '', ''])],
    ...screens.map((s) => [s, ...labels.flatMap((l) => {
      const x = perf[l].screens[s];
      return x ? [`${x.medianMs} (${x.fps})`, `${x.p95Ms} (${x.fps5})`, x.maxMs ?? '—'] : ['—', '—', '—'];
    })]),
  ]));
  P();
}

P('<!-- auto:end -->');
const auto = lines.join('\n');
let manual = '';
if (existsSync(OUT)) {
  const old = readFileSync(OUT, 'utf8');
  const i = old.indexOf('<!-- auto:end -->');
  if (i >= 0) manual = old.slice(i + '<!-- auto:end -->'.length);
}
writeFileSync(OUT, auto + manual);
console.log(`→ ${OUT}`);
