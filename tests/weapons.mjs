/**
 * Каждое оружие по отдельности: что оно делает с мишенью и с землёй.
 *
 * Проверять оружие через обычный ход дорого и ненадёжно: очередь уходит
 * другой команде, снаряд летит по настоящей карте и попадает то в холм, то
 * в воду. Здесь бой ставится вручную — стрелок и мишень на ровной площадке
 * на известном расстоянии, — а выстрел делается прямым вызовом оружия, мимо
 * очереди. Измеряется то, что игрок видит: сколько снял здоровья, сколько
 * выгрыз земли, насколько отбросил.
 *
 * Ожидания заданы по смыслу оружия, а не по текущим числам: базука обязана
 * рыть, бита — толкать и не рыть, мина — не подрываться под тем, кто её
 * поставил. Числа в реестре можно менять, набор от этого не покраснеет.
 */
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:5173';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) errors.push(`console: ${t}`);
});

await page.goto(`${URL}/?biome=forest&seed=777`, { waitUntil: 'domcontentloaded' });

const menuReady = () => page.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Menu')
    && Object.keys(window.__WORMS__.scene.getScene('Menu').buttons).length > 0,
  null, { timeout: 40000 },
);
await menuReady();

// Хотсит: боты не должны вмешиваться в измерение
await page.evaluate(async () => {
  const { HOTSEAT } = await import('/src/core/match.js');
  window.__WORMS__.scene.getScene('Menu').start(HOTSEAT);
});
await page.waitForFunction(
  () => window.__WORMS__?.scene.isActive('Game')
    && window.__WORMS__.scene.getScene('Game').turn?.activeWorm && !window.__WORMS__.scene.getScene('Game').landing(),
  null, { timeout: 40000 },
);
await page.waitForTimeout(800);

// Ветер сбивает настильный выстрел в упор — на стенде он только мешает
await page.evaluate(() => { window.__WORMS__.scene.getScene('Game').wind = 0; });

/**
 * Каждому оружию — своя нетронутая площадка.
 *
 * Перезапускать сцену под каждое оружие оказалось и долго, и ненадёжно.
 * Вместо этого стенд едет по карте: следующее оружие ищет ровное место
 * правее предыдущего, за пределами старых воронок. Здоровье обоих бойцов
 * перед каждым выстрелом возвращается к сотне, иначе мишень не доживает
 * до конца списка.
 */
let spot = 300;
const nextSpot = () => (spot += 420);

/**
 * Готовит стенд под один выстрел и делает его.
 *
 * Площадку ищем сами: ровный участок, где под обоими бойцами есть земля и
 * оба стоят выше воды. Стрелок и мишень разводятся на `gap`, целимся точно
 * в мишень — так измеряется само оружие, а не меткость.
 */
const shoot = (weaponId, gap, aimAtTarget, fromX) => page.evaluate(
  async ([id, dist, aimAt, startX]) => {
    const s = window.__WORMS__.scene.getScene('Game');
    const { WEAPONS_BY_ID } = await import('/src/weapons/index.js');
    const weapon = WEAPONS_BY_ID[id];

    // Ровная площадка: ищем x, где поверхность почти не меняется на 200 px
    // Идём от заданного места вправо и, если не нашли, по кругу с начала:
    // стендов больше, чем помещается на карте в один проход. Кратеры от
    // прошлых выстрелов сами отсеиваются проверкой на ровность.
    // Ровность меряем по всей площадке, а не по её краям: бугор посередине
    // упирал луч дробовика в землю в двадцати пикселях от стрелка, и
    // проверка ругалась на оружие вместо стенда.
    let base = null;
    const span = s.terrain.width - 400;
    for (let k = 0; k < span / 20 && !base; k++) {
      const x = 200 + ((startX - 200 + k * 20) % span);
      const a = s.terrain.surfaceYAt(x, 0);
      if (a === null || a >= 560) continue;
      // Требуем не идеальной плоскости — после первой же воронки такой на
      // карте не остаётся, — а двух вещей: мишень стоит примерно на той же
      // высоте, и между ними нет бугра выше площадки, в который упёрся бы
      // настильный выстрел. Понижения рельефа не мешают.
      let ok = true;
      for (let d = 10; d < dist && ok; d += 10) {
        const h = s.terrain.surfaceYAt(x + d, 0);
        if (h === null || h < a - 4) ok = false;              // бугор на пути
      }
      const end = s.terrain.surfaceYAt(x + dist, 0);
      if (end === null || Math.abs(end - a) > 8) ok = false;  // мишень не вровень
      if (ok) base = { x, y: a };
    }
    if (!base) return { error: 'ровной площадки не нашлось' };

    const shooter = s.turn.activeWorm;
    if (!shooter?.alive) return { error: 'стрелок не жив' };
    const target = s.worms.find((w) => w.alive && w.team !== shooter.team);
    if (!target) return { error: 'некому быть мишенью' };

    // Остальных убираем с площадки, чтобы не ловили осколки
    for (const w of s.worms) {
      if (w === shooter || w === target) continue;
      w.x = 60; w.y = 200; w.vx = 0; w.vy = 0;
    }

    shooter.x = base.x; shooter.y = base.y; shooter.vx = 0; shooter.vy = 0;
    shooter.grounded = true; shooter.health = 100;
    target.x = base.x + dist; target.y = s.terrain.surfaceYAt(base.x + dist, 0);
    target.vx = 0; target.vy = 0; target.grounded = true; target.health = 100;
    shooter.facing = 1;

    // Прицел: либо точно в мишень, либо навесом — как просит проверка
    const dx = target.x - shooter.x;
    const dy = target.centerY - shooter.centerY;
    const len = Math.hypot(dx, dy) || 1;
    // Быстро и настильно: на дистанции стенда снаряд не успевает провиснуть,
    // и попадание зависит от оружия, а не от того, угадали ли мы навес.
    const speed = 900;
    const dir = aimAt
      ? { x: dx / len, y: dy / len }
      : { x: Math.cos(-0.7), y: Math.sin(-0.7) };

    const before = {
      health: target.health,
      x: target.x,
      solid: s.terrain.solid.reduce((a, v) => a + v, 0),
      shooterHealth: shooter.health,
      mines: s.mines.length,
    };

    // Стреляем мимо очереди: очередь тут не проверяется, а её передача
    // сбросила бы стенд на следующего бойца.
    const shots = weapon.fire(s, shooter.x, shooter.centerY,
      dir.x * speed, dir.y * speed, shooter);
    s.projectiles.push(...shots);

    window.__probe = { before, shooter, target, weapon };
    return { ok: true, flying: shots.length, gap: Math.round(dist) };
  }, [weaponId, gap, aimAtTarget, fromX],
);

/** Ждём, пока снаряды отработают, и снимаем итог. */
async function settle(ms = 6000) {
  await page.waitForFunction(
    () => window.__WORMS__.scene.getScene('Game').projectiles.length === 0,
    null, { timeout: ms },
  ).catch(() => {});
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const s = window.__WORMS__.scene.getScene('Game');
    const { before, target, shooter } = window.__probe;
    // Где рвануло относительно мишени. Без этого «ноль урона» ничего не
    // объясняет: то ли оружие не бьёт, то ли снаряд улетел мимо.
    const last = s.explosionLog[s.explosionLog.length - 1] ?? null;
    return {
      boom: last ? `взрыв в ${Math.round(last.x - target.x)},`
        + `${Math.round(last.y - target.centerY)} от мишени r=${last.r}` : 'взрыва не было',
      damage: before.health - target.health,
      selfDamage: before.shooterHealth - shooter.health,
      crater: before.solid - s.terrain.solid.reduce((a, v) => a + v, 0),
      moved: Math.round(Math.abs(target.x - before.x)),
      mines: s.mines.length - before.mines,
      targetAlive: target.alive,
    };
  });
}

// ---------------------------------------------------------------- взрывное
// Оружие прямого выстрела: целимся в мишень и ждём и урона, и воронки.
for (const id of ['bazooka', 'grenade', 'cluster', 'mole', 'banana', 'holy', 'mortar']) {
  const start = await shoot(id, 90, true, nextSpot());
  if (start.error) { check(`${id}: стенд собрался`, false, start.error); continue; }
  const r = await settle();
  check(`${id}: наносит урон в упор`, r.damage > 0,
    `${r.damage} hp, воронка ${r.crater} px, отбросило на ${r.moved} px, ${r.boom}`);
  check(`${id}: рвёт землю`, r.crater > 100, `${r.crater} px`);
}

// ------------------------------------------------------------- стрелковое
{
  const start = await shoot('shotgun', 90, true, nextSpot());
  if (start.error) check('дробовик: стенд собрался', false, start.error);
  else {
    check('дробовик: попадание считается сразу', start.flying === 0,
      `снарядов в воздухе: ${start.flying}`);
    const r = await settle(1500);
    check('дробовик: наносит урон', r.damage > 0, `${r.damage} hp, ${r.boom}`);
  }
}

// ------------------------------------------------------------ ближний бой
// Бита бьёт в упор: мишень ставим вплотную, как это и бывает в бою.
{
  const start = await shoot('bat', 34, true, nextSpot());
  if (start.error) check('бита: стенд собрался', false, start.error);
  else {
    const r = await settle(1500);
    check('бита: отбрасывает соседа', r.moved > 20, `сдвинуло на ${r.moved} px`);
    check('бита: наносит урон', r.damage > 0, `${r.damage} hp`);
    check('бита: земля цела', r.crater === 0, `${r.crater} px`);
  }
}

// А теперь так, как бьют в настоящем бою: прицел в начале хода стоит на
// 45°, и никто его не опускает ради удара в упор. Раньше бита в этом
// случае промахивалась всегда — удар уходил соседу над головой.
{
  const start = await shoot('bat', 30, false, nextSpot());
  if (start.error) check('бита под углом: стенд собрался', false, start.error);
  else {
    const r = await settle(1500);
    check('бита достаёт соседа и при прицеле в 45°', r.damage > 0 && r.moved > 10,
      `${r.damage} hp, сдвинуло на ${r.moved} px`);
  }
}

// -------------------------------------------------------------- снаряжение
{
  const start = await shoot('dynamite', 40, true, nextSpot());
  if (start.error) check('динамит: стенд собрался', false, start.error);
  else {
    const r = await settle(7000);
    check('динамит: рвёт землю и задевает соседа', r.crater > 100 && r.damage > 0,
      `${r.damage} hp, воронка ${r.crater} px`);
  }
}

// Мина — единственное оружие, которое переживает ход. Главное к ней
// требование: поставивший должен успеть уйти. Проверяем оба случая —
// стрелок остаётся рядом и стрелок отходит.
{
  const start = await shoot('mine', 200, true, nextSpot());
  if (start.error) check('мина: стенд собрался', false, start.error);
  else {
    check('мина: ложится на карту, а не летит', start.flying === 0 && start.gap === 200);
    await page.waitForTimeout(400);
    const placed = await page.evaluate(
      () => window.__WORMS__.scene.getScene('Game').mines.length);
    check('мина: появилась в мире', placed > 0, `мин на карте: ${placed}`);

    // Ждём не по часам, а по состоянию мины: игровое время под нагрузкой
    // идёт втрое медленнее реального, и фиксированная пауза проверяла бы
    // не мину, а скорость машины.
    await page.waitForFunction(
      () => window.__WORMS__.scene.getScene('Game').mines[0]?.armed !== false,
      null, { timeout: 30000 },
    ).catch(() => {});
    // Взведённая мина, под которой стоит хозяин, должна молчать
    await page.waitForTimeout(1500);
    const own = await page.evaluate(() => {
      const s = window.__WORMS__.scene.getScene('Game');
      const { shooter, before } = window.__probe;
      return { selfDamage: before.shooterHealth - shooter.health, mines: s.mines.length };
    });
    check('мина: не подрывается под своим же хозяином', own.selfDamage === 0,
      `хозяин потерял ${own.selfDamage} hp, мин осталось ${own.mines}`);

    // А на чужого обязана сработать
    await page.evaluate(() => {
      const s = window.__WORMS__.scene.getScene('Game');
      const m = s.mines[0];
      const { target } = window.__probe;
      if (m) { target.x = m.x; target.y = m.y; target.vx = 0; target.vy = 0; }
    });
    // Опять по состоянию, а не по часам: фитиль тикает игровым временем
    await page.waitForFunction(() => {
      const s = window.__WORMS__.scene.getScene('Game');
      const { target } = window.__probe;
      return s.mines.length === 0 || target.health < 100 || !target.alive;
    }, null, { timeout: 30000 }).catch(() => {});
    const foe = await page.evaluate(() => {
      const s = window.__WORMS__.scene.getScene('Game');
      const { target } = window.__probe;
      const m = s.mines[0];
      return {
        health: target.health, mines: s.mines.length, alive: target.alive,
        state: m
          ? `взведена=${m.armed} фитиль=${m.fuse.toFixed(2)} хозяинушёл=${m.ownerLeft}`
            + ` до мишени=${Math.round(Math.hypot(target.x - m.x, target.centerY - m.y))}`
          : 'мины нет',
      };
    });
    check('мина: срабатывает на чужого', foe.health < 100 || !foe.alive,
      `у мишени ${foe.health} hp, мин ${foe.mines}, ${foe.state}`);
  }
}

// ------------------------------------------------------- оружие с целью
// Авиаудар и телепорт бьют не по траектории, а в точку: сторона — куда
// смотрит ствол, дальность — сила. Стенд тот же, но точку задаём силой.
{
  const start = await shoot('bat', 120, true, nextSpot());   // только расставить
  await settle(1500);
  if (start.error) check('авиаудар: стенд собрался', false, start.error);
  else {
    const fired = await page.evaluate(async () => {
      const s = window.__WORMS__.scene.getScene('Game');
      const { CFG } = await import('/src/config.js');
      const { WEAPONS_BY_ID } = await import('/src/weapons/index.js');
      const w = WEAPONS_BY_ID.airstrike;
      const { shooter, target } = window.__probe;
      target.health = 100; shooter.health = 100;
      window.__probe.before.health = 100;
      window.__probe.before.solid = s.terrain.solid.reduce((a, v) => a + v, 0);
      window.__probe.before.x = target.x;
      // Сила так, чтобы точка удара пришлась ровно на мишень. Угол ствола
      // авиаудару не важен — берём крутой, как в бою из-за холма.
      const p = (target.x - shooter.x) / w.reach;
      const vx = Math.cos(-1.2) * p * CFG.AIM_MAX_POWER;
      const vy = Math.sin(-1.2) * p * CFG.AIM_MAX_POWER;
      const point = w.targetPoint(s, shooter, vx, vy);
      const shots = w.fire(s, shooter.x, shooter.centerY, vx, vy, shooter);
      s.projectiles.push(...shots);
      return { missiles: shots.length, aimDx: Math.round(point.x - target.x), allAbove: shots.every((m) => m.y < 0) };
    });
    check('авиаудар: пять ракет сверху', fired.missiles === 5 && fired.allAbove, JSON.stringify(fired));
    const r = await settle(9000);
    check('авиаудар: накрывает мишень и рвёт землю', r.damage > 0 && r.crater > 100,
      `${r.damage} hp, воронка ${r.crater} px, ${r.boom}`);
    check('авиаудар: стрелка не задевает', r.selfDamage === 0, `${r.selfDamage} hp`);
  }
}

{
  const start = await shoot('bat', 120, true, nextSpot());   // только расставить
  await settle(1500);
  if (start.error) check('телепорт: стенд собрался', false, start.error);
  else {
    const tp = await page.evaluate(async () => {
      const s = window.__WORMS__.scene.getScene('Game');
      const { CFG } = await import('/src/config.js');
      const { WEAPONS_BY_ID } = await import('/src/weapons/index.js');
      const w = WEAPONS_BY_ID.teleport;
      const { shooter } = window.__probe;
      shooter.health = 100;
      const from = { x: shooter.x, y: shooter.y };
      // Вверх и вправо на полсилы: точка в воздухе, встать надо на землю
      const vx = Math.cos(-1.0) * 0.5 * CFG.AIM_MAX_POWER;
      const vy = Math.sin(-1.0) * 0.5 * CFG.AIM_MAX_POWER;
      const point = w.targetPoint(s, shooter, vx, vy);
      const shots = w.fire(s, shooter.x, shooter.centerY, vx, vy, shooter);
      return {
        shots: shots.length, from, to: { x: shooter.x, y: shooter.y }, point,
        onGround: shooter.supported(shooter.x, shooter.y), clear: shooter.bodyClear(shooter.x, shooter.y),
      };
    });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => {
      const { shooter } = window.__probe;
      return { health: shooter.health, x: Math.round(shooter.x), alive: shooter.alive };
    });
    check('телепорт: переносит бойца в точку прицела',
      tp.shots === 0 && Math.abs(tp.to.x - tp.point.x) < 1 && Math.abs(tp.to.x - tp.from.x) > 100,
      `${Math.round(tp.from.x)} → ${Math.round(tp.to.x)}`);
    check('телепорт: встаёт на землю, а не в землю и не в воздух', tp.onGround && tp.clear,
      `опора ${tp.onGround}, свободно ${tp.clear}`);
    check('телепорт: без урона от падения', after.alive && after.health === 100, `${after.health} hp`);
  }
}

check('нет ошибок в консоли', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failures.length
  ? `\nПРОВАЛЕНО: ${failures.length} — ${failures.join(', ')}`
  : '\nпроверки оружия пройдены');
process.exit(failures.length ? 1 : 0);
