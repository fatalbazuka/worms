/**
 * Журнал запусков: почему игра иногда не открывается.
 *
 * Страница (index.html) засекает этапы загрузки и шлёт отчёт на
 * POST /api/boot. Входа не требует: самые интересные случаи как раз те,
 * где до входа дело не дошло. Отчёт бывает такой:
 *   ok        — дошли до меню; в stages — когда пройден каждый этап;
 *   stuck     — через 15 с меню ещё нет (запуск может и доехать позже —
 *               тогда придёт и ok с тем же boot);
 *   error     — упал скрипт или не загрузился файл;
 *   closed    — закрыли, не дождавшись меню;
 *   lost      — прошлый запуск оборвался без отчёта (iOS закрыл WebView,
 *               не дав отправить); досылается при следующем открытии.
 *
 * Этапы по порядку: html → tg_sdk → phaser → modules → tg_ready → save →
 * clouds → game → boot_scene → menu (menu — первый экран, меню или бой).
 * В stage — последний пройденный, значит, застряли на следующем:
 * после html — не грузится telegram.org; после tg_sdk — Phaser; после
 * phaser — не доехал один из файлов src/ (Telegram держит заглушку, ready()
 * ещё не вызван); после tg_ready и дальше — заглушки уже нет, висит сама игра.
 *
 * Каждый отчёт ещё и одной строкой в журнал процесса:
 *   journalctl -u worms-api | grep '\[boot\]'
 * Сводка — команда бота /boot (только админу). Записи старше 14 дней
 * удаляются сами.
 */

export const STAGES = ['html', 'tg_sdk', 'phaser', 'modules', 'tg_ready', 'save', 'clouds', 'game', 'boot_scene', 'menu'];
const OUTCOMES = new Set(['ok', 'stuck', 'error', 'closed', 'lost']);
const KEEP_MS = 14 * 24 * 3600_000;
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

export function createBootLog({ db, now = () => Date.now(), log = console }) {
  const q = {
    add: db.prepare(`insert into boot_log (boot, created_at, outcome, stage, ms, tg_id, platform, tg_version,
                     net, ua, error, stages) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    prune: db.prepare('delete from boot_log where created_at < ?'),
    since: db.prepare('select * from boot_log where created_at >= ? order by created_at'),
  };
  let lastPrune = 0;

  /** Принять отчёт страницы. Мусор молча отбрасываем — это диагностика. */
  function record(body, ip = '') {
    const outcome = String(body?.outcome ?? '');
    if (!OUTCOMES.has(outcome)) return false;
    const stages = {};
    for (const s of STAGES) { const v = num(body.stages?.[s]); if (v != null && v >= 0) stages[s] = v; }
    const row = {
      boot: str(body.boot, 40) ?? '?',
      outcome,
      stage: STAGES.includes(body.stage) ? body.stage : null,
      ms: num(body.ms),
      tg_id: num(body.tg_id),
      platform: str(body.platform, 20),
      tg_version: str(body.tg_version, 10),
      net: str(body.net, 20),
      ua: str(body.ua, 300),
      error: str(body.error, 1000),
    };
    const t = now();
    q.add.run(row.boot, t, row.outcome, row.stage, row.ms, row.tg_id, row.platform, row.tg_version,
      row.net, row.ua, row.error, JSON.stringify(stages));
    // Одна строка в журнал: ok — коротко, остальное — со всеми подробностями
    const head = `[boot] ${outcome} ${row.ms ?? '?'}мс этап=${row.stage ?? '-'} tg=${row.tg_id ?? '-'} ${row.platform ?? ''} v${row.tg_version ?? '-'} сеть=${row.net ?? '-'}`;
    if (outcome === 'ok') log.log?.(head);
    else log.warn?.(`${head} ip=${ip} этапы=${JSON.stringify(stages)}${row.error ? ` ошибка=${row.error}` : ''} ua=${row.ua ?? '-'}`);
    if (t - lastPrune > 3600_000) { lastPrune = t; q.prune.run(t - KEEP_MS); }
    return true;
  }

  /** Сводка для админа за последние hours часов. */
  function report(hours = 24) {
    const rows = q.since.all(now() - hours * 3600_000);
    if (!rows.length) return `Запусков за ${hours} ч не записано.`;
    // Запуск — это boot: stuck и ok одного запуска считаем один раз
    const byBoot = new Map();
    for (const r of rows) {
      const list = byBoot.get(r.boot) ?? [];
      list.push(r);
      byBoot.set(r.boot, list);
    }
    let ok = 0, slowOk = 0;
    const failed = [];
    const times = [];
    for (const list of byBoot.values()) {
      const done = list.find((r) => r.outcome === 'ok');
      if (done) {
        ok++;
        if (done.ms != null) times.push(done.ms);
        if (list.some((r) => r.outcome === 'stuck')) slowOk++;
      } else {
        // Худший итог запуска: error важнее closed/lost, те — важнее stuck
        const rank = { error: 0, closed: 1, lost: 2, stuck: 3 };
        failed.push(list.sort((a, b) => rank[a.outcome] - rank[b.outcome])[0]);
      }
    }
    times.sort((a, b) => a - b);
    const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))] : 0);
    const sec = (ms) => `${(ms / 1000).toFixed(1)} с`;
    const total = byBoot.size;
    const lines = [
      `🚀 Запуски за ${hours} ч: ${total}`,
      `открылись: ${ok} (${Math.round((ok / total) * 100)}%), из них дольше 15 с: ${slowOk}`,
      `не открылись: ${failed.length}`,
    ];
    if (times.length) lines.push(`до меню: медиана ${sec(pct(0.5))}, 90% — ${sec(pct(0.9))}, худший ${sec(times.at(-1))}`);
    if (failed.length) {
      const where = {};
      for (const r of failed) { const k = `${r.outcome} после «${r.stage ?? '?'}»`; where[k] = (where[k] ?? 0) + 1; }
      lines.push('', 'Где застряли:');
      for (const [k, n] of Object.entries(where).sort((a, b) => b[1] - a[1])) lines.push(`  ${k}: ${n}`);
      const plat = {};
      for (const r of failed) { const k = r.platform ?? '?'; plat[k] = (plat[k] ?? 0) + 1; }
      lines.push(`Платформы: ${Object.entries(plat).map(([k, n]) => `${k} ${n}`).join(', ')}`);
      const errs = failed.filter((r) => r.error).slice(-5);
      if (errs.length) {
        lines.push('', 'Последние ошибки:');
        for (const r of errs) lines.push(`  • ${r.platform ?? '?'} tg=${r.tg_id ?? '-'}: ${r.error.slice(0, 200)}`);
      }
    }
    // Медленнее всего проходимый этап у успешных: куда уходит время
    const slow = {};
    for (const list of byBoot.values()) {
      const done = list.find((r) => r.outcome === 'ok');
      if (!done) continue;
      let prev = 0;
      const st = JSON.parse(done.stages || '{}');
      for (const s of STAGES) {
        if (st[s] == null) continue;
        (slow[s] ??= []).push(st[s] - prev);
        prev = st[s];
      }
    }
    const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const parts = STAGES.filter((s) => slow[s]?.length).map((s) => `${s} ${med(slow[s])}`);
    if (parts.length) lines.push('', `Медиана этапов, мс: ${parts.join(' → ')}`);
    return lines.join('\n');
  }

  return { record, report };
}
