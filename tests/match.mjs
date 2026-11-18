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

// --- скины и коробки: правила без браузера ---
{
  const { SKINS, emptyState, normalize, rewardMissions, claimBoxes, openBox, equip } = await import('../src/core/skins.js');
  const missions = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const rewards = rewardMissions(missions);
  check('коробок за кампанию ровно столько, сколько скинов можно получить',
    rewards.length === SKINS.length - 1 && rewards[0] === 'm0' && rewards.at(-1) === 'm11',
    rewards.join(','));

  let st = emptyState();
  let r = claimBoxes(st, ['m0', 'm1'], missions);
  check('за первую миссию — коробка, за вторую — нет', r.gained === 1 && r.state.boxes === 1);
  const again = claimBoxes(r.state, ['m0', 'm1'], missions);
  check('дважды за одну миссию коробку не дают', again.gained === 0 && again.state.boxes === 1);

  // Вся кампания пройдена: открываем всё подряд — повторов нет, собраны все
  st = claimBoxes(emptyState(), missions, missions).state;
  const got = [];
  for (let i = 0; i < 20; i++) {
    const o = openBox(st, () => 0.999);
    st = o.state;
    if (o.skin) got.push(o.skin);
  }
  check('коробки не дают повторов и собирают все скины',
    new Set(got).size === got.length && st.owned.length === SKINS.length && st.boxes === 0,
    `${got.join(',')} · коробок осталось ${st.boxes}`);
  check('пустую коробку открыть нельзя', openBox(emptyState()).skin === null);
  const fullSt = { ...st, boxes: 2 };
  const none = openBox(fullSt);
  check('когда собрано всё, коробка не тратится', none.full && none.state.boxes === 2);
  check('надеть можно только свой скин',
    equip(emptyState(), 'devil').equipped === 'classic' && equip(st, 'devil').equipped === 'devil');
  const bad = normalize({ owned: ['devil', 'нет такого'], equipped: 'clown', boxes: -5, claimed: 'x' });
  check('мусор из хранилища приводится к правильному состоянию',
    bad.owned.join() === 'classic,devil' && bad.equipped === 'classic' && bad.boxes === 0 && bad.claimed.length === 0);
}

// --- задания, монеты и серия дней ---
{
  const D = await import('../src/core/daily.js');
  const days = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-01-01', '2027-02-28'];
  const sets = days.map((d) => D.tasksFor(d));
  check('в день три задания, все с разными счётчиками',
    sets.every((ids) => ids.length === 3 && new Set(ids.map((id) => D.TASK_BY_ID[id].stat)).size === 3),
    sets.map((x) => x.join('+')).join(' | '));
  check('задания дня одни и те же при повторном расчёте', D.tasksFor('2026-11-18').join() === sets[0].join());
  check('в разные дни задания разные', new Set(sets.map((x) => x.join())).size > 1);
  check('вчера считается через границу месяца и года',
    D.prevDay('2026-12-01') === '2026-11-30' && D.prevDay('2027-01-01') === '2026-12-31');

  // Бой двигает задания и приносит монеты; выполненное забирается один раз
  const day = '2026-11-18';
  let st = D.rollDay(D.emptyState(), day);
  const big = Object.fromEntries(D.STATS.map((k) => [k, 999]));
  let r = D.addBattle(st, day, big, true);
  check('бой с большими счётчиками выполняет все три задания',
    r.done.length === 3 && r.coins === D.BATTLE_COINS.win, `${r.done.join(',')} · +${r.coins}`);
  st = r.state;
  const id = st.tasks[0].id;
  const c1 = D.claimTask(st, day, id);
  const c2 = D.claimTask(c1.state, day, id);
  check('награду за задание дают один раз', c1.coins === D.TASK_BY_ID[id].coins && c2.coins === 0);
  r = D.addBattle(c1.state, day, big, true);
  check('уже выполненное задание второй раз не «выполняется»', r.done.length === 0);

  // Монеты за бои — только за первые BATTLE_COIN_LIMIT в сутки
  let s2 = D.rollDay(D.emptyState(), day);
  let got = 0;
  for (let i = 0; i < D.BATTLE_COIN_LIMIT + 5; i++) {
    const x = D.addBattle(s2, day, {}, false); s2 = x.state; got += x.coins;
  }
  check('монеты за бои ограничены в сутки', got === D.BATTLE_COIN_LIMIT * D.BATTLE_COINS.loss, String(got));
  const next = D.addBattle(s2, '2026-11-19', {}, false);
  check('новый день — новые задания и снова монеты за бои',
    next.coins === D.BATTLE_COINS.loss && next.state.day === '2026-11-19'
      && next.state.tasks.every((t) => t.progress === 0 && !t.claimed));

  // Серия: подряд растёт, пропуск — с начала, на 7-й день коробка
  let ss = D.emptyState();
  const streakDays = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
  let boxes = 0, total = 0;
  for (const d of streakDays) { const x = D.claimStreak(ss, d); ss = x.state; total += x.coins; if (x.box) boxes++; }
  check('семь дней подряд — серия 7 и одна коробка',
    ss.streak === 7 && boxes === 1 && total === D.STREAK_COINS.reduce((a, b) => a + b, 0), `${ss.streak}, коробок ${boxes}`);
  check('дважды за день бонус не дают', D.claimStreak(ss, '2026-11-07').coins === 0);
  // Без заморозок в запасе (бесплатная за эту неделю уже выдана)
  const gap = D.claimStreak({ ...ss, freezes: 0, freezeWeek: D.weekKey('2026-11-09') }, '2026-11-09');
  check('пропустил день без заморозки — серия с начала', gap.streak === 1 && gap.coins === D.STREAK_COINS[0]);

  // Коробка за монеты
  check('без монет коробку не купить', !D.payForBox({ ...D.emptyState(), coins: D.BOX_PRICE - 1 }).ok);
  const paid = D.payForBox({ ...D.emptyState(), coins: D.BOX_PRICE + 5 });
  check('коробка стоит BOX_PRICE монет', paid.ok && paid.state.coins === 5);
  const junk = D.normalize({ coins: -50, tasks: [{ id: 'нет' }, { id: 'win1', progress: 'x' }], streak: 'a' });
  check('мусор из хранилища приводится к правильному состоянию',
    junk.coins === 0 && junk.tasks.length === 1 && junk.tasks[0].progress === 0 && junk.streak === 0);
}

// --- облачная копия и покупки с сервера ---
{
  const K = await import('../src/core/skins.js');
  const D = await import('../src/core/daily.js');
  const { SKIN_IDS, SKIN_STARS } = await import('../server/shop.mjs');
  check('сервер и игра знают одни и те же скины и цену скина',
    SKIN_IDS.join() === K.SKINS.filter((x) => x.id !== K.DEFAULT_SKIN).map((x) => x.id).join()
      && K.SKIN_STARS === SKIN_STARS, SKIN_IDS.join());

  const phone = { owned: ['classic', 'ice'], equipped: 'ice', boxes: 1, claimed: ['m0'], paidSeen: 0 };
  const cloud = { owned: ['classic', 'devil'], equipped: 'devil', boxes: 3, claimed: ['m2'], paidSeen: 5 };
  const m = K.mergeSkins(phone, cloud);
  check('копии скинов сводятся: собранное объединяется, счётчики — больший',
    m.owned.join() === 'classic,ice,devil' && m.equipped === 'ice' && m.boxes === 3
      && m.claimed.join() === 'm0,m2' && m.paidSeen === 5, JSON.stringify(m));

  let st = K.emptyState();
  let r = K.applyOwned(st, { boxes: 5, skins: ['devil'] });
  check('купленные коробки и скин ложатся в профиль', r.boxes === 5 && r.state.boxes === 5
    && r.state.owned.includes('devil') && r.state.paidSeen === 5);
  const again = K.applyOwned(r.state, { boxes: 5, skins: ['devil'] });
  check('повторная проверка покупок ничего не добавляет', again.boxes === 0 && again.state.boxes === 5);
  const more = K.applyOwned(r.state, { boxes: 6, skins: ['devil'] });
  check('новая покупка добавляет только разницу', more.boxes === 1 && more.state.boxes === 6);
  const refunded = K.applyOwned(more.state, { boxes: 1, skins: [] });
  check('после возврата звёзд открытое не отбирается', refunded.state.boxes === 6 && refunded.state.owned.includes('devil'));

  const a1 = { coins: 120, day: '2026-11-18', tasks: [{ id: 'win1', progress: 0, claimed: false }, { id: 'play3', progress: 2, claimed: false }], battlesToday: 2, streak: 3, streakDay: '2026-11-18' };
  const b1 = { coins: 80, day: '2026-11-18', tasks: [{ id: 'win1', progress: 1, claimed: true }, { id: 'play3', progress: 1, claimed: false }], battlesToday: 4, streak: 2, streakDay: '2026-11-17' };
  const md = D.mergeDaily(a1, b1);
  check('копии кошелька и заданий сводятся без потерь',
    md.coins === 120 && md.tasks[0].progress === 1 && md.tasks[0].claimed && md.tasks[1].progress === 2
      && md.battlesToday === 4 && md.streak === 3, JSON.stringify(md));
  const old = { ...b1, day: '2026-11-17' };
  check('задания вчерашней копии не мешают сегодняшним', D.mergeDaily(a1, old).tasks[0].progress === 0);
}

// --- испытания: звёзды ---
{
  const C = await import('../src/campaign/challenges.js');
  const c = C.CHALLENGE_BY_ID.first;
  check('звёзды: поражение 0, долго 1, быстро с потерями 2, быстро без потерь 3',
    C.starsFor(c, { won: false, myTurns: 1, hpLost: 0 }) === 0
      && C.starsFor(c, { won: true, myTurns: c.stars.turns + 1, hpLost: 0 }) === 1
      && C.starsFor(c, { won: true, myTurns: 1, hpLost: 10 }) === 2
      && C.starsFor(c, { won: true, myTurns: 1, hpLost: 0 }) === 3);
  let r = C.recordStars({}, 'first', 2);
  const r2 = C.recordStars(r.best, 'first', 3);
  const r3 = C.recordStars(r2.best, 'first', 1);
  check('монеты только за новые звёзды', r.coins === 2 * C.STAR_COINS && r2.coins === C.STAR_COINS
    && r3.coins === 0 && r3.best.first === 3);
  check('следующее испытание открывается после звезды в предыдущем',
    C.challengeOpen(0, {}) && !C.challengeOpen(1, {}) && C.challengeOpen(1, { first: 1 }));
}

// --- заморозка серии и украшения ---
{
  const D = await import('../src/core/daily.js');
  const K = await import('../src/core/cosmetics.js');
  // Пропустил один день: с заморозкой серия растёт, без — с начала
  let st = { ...D.emptyState(), streak: 4, streakDay: '2026-11-16', freezes: 1, freezeWeek: D.weekKey('2026-11-18') };
  let r = D.claimStreak(st, '2026-11-18');
  check('заморозка: пропуск одного дня не сжигает серию, заморозка тратится',
    r.streak === 5 && r.frozen && r.state.freezes === 0, JSON.stringify({ s: r.streak, f: r.state.freezes }));
  r = D.claimStreak({ ...st, freezes: 0 }, '2026-11-18');
  check('без заморозки пропуск — серия с начала', r.streak === 1 && !r.frozen);
  r = D.claimStreak({ ...st, streakDay: '2026-11-15' }, '2026-11-18');
  check('два пропущенных дня заморозка не спасает', r.streak === 1 && r.state.freezes === 1);
  // Новая неделя — бесплатная заморозка, но не больше FREEZE_MAX
  r = D.claimStreak({ ...D.emptyState(), streak: 2, streakDay: '2026-11-22', freezes: 0, freezeWeek: '2026-11-16' }, '2026-11-23');
  const capped = D.claimStreak({ ...D.emptyState(), freezes: D.FREEZE_MAX, freezeWeek: '2026-11-16' }, '2026-11-23');
  check('новая неделя — бесплатная заморозка, запас не больше максимума',
    r.state.freezes === 1 && r.state.freezeWeek === '2026-11-23' && capped.state.freezes === D.FREEZE_MAX);
  const bought = D.buyFreeze({ ...D.emptyState(), coins: D.FREEZE_PRICE, freezes: 0 });
  const poor = D.buyFreeze({ ...D.emptyState(), coins: D.FREEZE_PRICE - 1 });
  check('заморозку можно купить за монеты', bought.ok && bought.state.coins === 0 && bought.state.freezes === 1 && !poor.ok);
  // Украшения: купить — списать и надеть; дважды не продаётся; мусор из сети чистится
  const c0 = K.emptyCos();
  const b = K.buyCos(c0, 'rope', 'gold', 500);
  const again = K.buyCos(b.state, 'rope', 'gold', 500);
  const cheap = K.buyCos(c0, 'grave', 'crown', 10);
  check('украшение: покупка надевает, повтор и бедность — отказ',
    b.ok && b.price === 200 && b.state.equipped.rope === 'gold' && !again.ok && !cheap.ok);
  const merged = K.mergeCos({ owned: { rope: ['gold'] }, equipped: { rope: 'gold' } }, { owned: { trail: ['fire'] } });
  const net = K.cleanEquipped({ rope: 'hacked', trail: 'fire', grave: 42 });
  check('украшения: облако объединяет купленное, чужое из сети чистится',
    merged.owned.rope.includes('gold') && merged.owned.trail.includes('fire') && merged.equipped.rope === 'gold'
      && net.rope === 'classic' && net.trail === 'fire' && net.grave === 'ghost');
}

// --- редкость скинов: редкие выпадают реже, «только за звёзды» — не выпадают ---
{
  const K = await import('../src/core/skins.js');
  const counts = {};
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 3000; i++) {
    const r = K.openBox({ ...K.emptyState(), boxes: 1 }, rnd);
    const rar = K.SKIN_BY_ID[r.skin].rarity;
    counts[rar] = (counts[rar] ?? 0) + 1;
  }
  const perSkin = (rar) => counts[rar] / K.BOX_SKINS.filter((s) => s.rarity === rar && s.id !== K.DEFAULT_SKIN).length;
  check('коробка: обычный скин выпадает чаще редкого, редкий — чаще эпического',
    perSkin('common') > perSkin('rare') * 1.4 && perSkin('rare') > perSkin('epic') * 1.8, JSON.stringify(counts));
  check('у каждого скина есть редкость', K.SKINS.every((s) => K.RARITY[s.rarity]));
}

console.log(failures.length
  ? `\nне прошло: ${failures.length}`
  : '\nпроверки подбора пройдены');
process.exit(failures.length ? 1 : 0);
