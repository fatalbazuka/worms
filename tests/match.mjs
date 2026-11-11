/**
 * Подбор соперника — проверки без браузера.
 *
 * Модуль подбора нарочно сделан чистой функцией, чтобы его можно было
 * гонять прямо в node: главное свойство здесь — симметричность. Если два
 * клиента из одинаковых данных получают разные пары, лобби разъезжается, и
 * поймать это в браузерном тесте гораздо дороже, чем здесь.
 */

import { findMatch, band, BAND_OPEN_AFTER } from '../src/net/matchmaker.js';
import { isCasualRoom, randomRoom, queueOf } from '../src/net/rooms.js';
import { isCasualRoom as serverCasual } from '../server/lib/rooms.js';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const p = (id, rating, waited = 0) => ({ id, rating, waited });

// --- коридор ---
check('коридор в начале узкий', band(0) === 120, String(band(0)));
check('коридор растёт со временем', band(10) > band(0), `${band(0)} → ${band(10)}`);
check('после ожидания коридор снимается', band(BAND_OPEN_AFTER) === Infinity);

// --- пара из двух ---
{
  const a = p('a', 1000, 0), b = p('b', 1040, 0);
  const ma = findMatch(a, [b]);
  const mb = findMatch(b, [a]);
  check('двое близких по рейтингу сходятся', ma?.peer.id === 'b' && mb?.peer.id === 'a');
}

// --- слишком разные не сходятся сразу ---
{
  const a = p('a', 1000, 0), b = p('b', 1500, 0);
  check('далёкие по рейтингу сразу не сходятся',
    findMatch(a, [b]) === null && findMatch(b, [a]) === null);
}

// --- но сходятся, когда коридор раскрылся ---
{
  const a = p('a', 1000, BAND_OPEN_AFTER), b = p('b', 1500, BAND_OPEN_AFTER);
  check('после долгого ожидания сходятся кто угодно',
    findMatch(a, [b])?.peer.id === 'b' && findMatch(b, [a])?.peer.id === 'a');
}

// --- коридор считается по минимуму ожиданий, значит симметричен ---
{
  const a = p('a', 1000, 30), b = p('b', 1500, 0);
  check('свежий соперник не втягивается в раскрытый коридор',
    findMatch(a, [b]) === null && findMatch(b, [a]) === null);
}

// --- симметрия на случайных наборах ---
{
  let bad = null;
  let rnd = 12345;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let round = 0; round < 400 && !bad; round++) {
    const n = 2 + Math.floor(next() * 7);
    const pool = [];
    for (let i = 0; i < n; i++) {
      pool.push(p(`p${i}${round}`, 800 + Math.round(next() * 800), Math.floor(next() * 40)));
    }
    for (const me of pool) {
      const mine = findMatch(me, pool.filter((x) => x !== me));
      if (!mine) continue;
      const peer = mine.peer;
      const theirs = findMatch(peer, pool.filter((x) => x !== peer));
      if (theirs?.peer.id !== me.id) {
        bad = `${me.id}→${peer.id}, но ${peer.id}→${theirs?.peer.id ?? 'никого'}`;
      }
    }
  }
  check('подбор взаимный на случайных лобби', bad === null, bad ?? '400 раскладов');
}

// --- нечётное лобби: кто-то остаётся ждать, но не зависает пара ---
{
  const pool = [p('a', 1000, 0), p('b', 1010, 0), p('c', 1020, 0)];
  const got = pool.map((me) => findMatch(me, pool.filter((x) => x !== me))?.peer.id ?? null);
  const paired = got.filter(Boolean).length;
  check('в лобби из троих сходится ровно одна пара', paired === 2, JSON.stringify(got));
}

// --- одиночка не матчится сам с собой ---
check('один в лобби никого не находит', findMatch(p('a', 1000, 99), []) === null);

// --- режим боя по коду комнаты: клиент и сервер согласны ---
{
  const rated = Array.from({ length: 2000 }, () => randomRoom(false));
  const casual = Array.from({ length: 200 }, () => randomRoom(true));
  check('рейтинговый код никогда не начинается с Z', rated.every((r) => !isCasualRoom(r) && /^[A-Z2-9]{6}$/.test(r)));
  check('код без рейтинга — всегда на Z', casual.every((r) => isCasualRoom(r) && queueOf(r) === 'casual'));
  const codes = ['ZAB123', 'zab123', 'MAB123', 'ABC123', '', null];
  check('сервер понимает режим так же, как клиент',
    codes.every((c) => isCasualRoom(c) === serverCasual(c)));
}

// --- без рейтинга: коридор открыт сразу, разница в 900 не мешает ---
{
  const a = p('a', 1900, BAND_OPEN_AFTER);
  const b = p('b', 1000, BAND_OPEN_AFTER);
  check('с открытым коридором сводит любых', findMatch(a, [b])?.peer.id === 'b' && findMatch(b, [a])?.peer.id === 'a');
}

console.log(failures.length
  ? `\nне прошло: ${failures.length}`
  : '\nпроверки подбора пройдены');
process.exit(failures.length ? 1 : 0);
