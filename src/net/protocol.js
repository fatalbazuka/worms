import { CFG } from '../config.js';
import { Crate } from '../entities/Crate.js';
import { Mine } from '../entities/Mine.js';
import { Spring } from '../entities/Spring.js';
import { WEAPONS_BY_ID } from '../weapons/index.js';

/**
 * Формат обмена для сетевой игры.
 *
 * За ход передаётся две вещи, и обе нужны:
 *
 *   ПРИКАЗ (command) — что сделал игрок: кто стрелял, откуда, чем и куда.
 *   По нему второй клиент проигрывает выстрел с анимацией, иначе снаряд
 *   просто телепортировался бы в результат.
 *
 *   СНИМОК (state) — чем ход кончился: позиции и здоровье бойцов, воронки,
 *   патроны, ящики, ветер. Это истина.
 *
 * Одним приказом обойтись нельзя: физика идёт по кадровой дельте, и на
 * разных устройствах траектории неизбежно разойдутся. Одним снимком —
 * можно, но тогда чужой ход выглядел бы как мгновенная телепортация.
 * Поэтому: показываем по приказу, состояние берём из снимка.
 */

/** Приказ на выстрел: всё, что нужно, чтобы повторить его визуально. */
export function captureCommand(scene, vx, vy) {
  const w = scene.turn.activeWorm;
  return {
    type: 'shot',
    turn: scene.turn.turnNumber,
    worm: scene.worms.indexOf(w),
    x: Math.round(w.x),
    y: Math.round(w.y),
    facing: w.facing,
    hang: w.hang ?? null,
    weapon: scene.turn.weaponIndex,
    vx: Math.round(vx),
    vy: Math.round(vy),
  };
}

/**
 * Показать чужой выстрел: без урона и разрушений, только картинка.
 *
 * Состояние хода здесь навязывается приказом, а не сверяется с ним: часы
 * двух клиентов расходятся, и если наш таймер успел оборвать ход, чужой
 * выстрел всё равно обязан проиграться.
 */
export function applyCommand(scene, cmd) {
  const w = scene.worms[cmd.worm];
  if (!w || !w.alive) return false;

  w.x = cmd.x;
  w.y = cmd.y;
  w.facing = cmd.facing;
  // Стрелял вися или сразу после рывка — у зрителя так же: иначе его копия
  // ещё летела по тросу, пока показывался выстрел
  w.zip = null; w.vx = 0; w.vy = 0;
  if ('hang' in cmd) w.hang = cmd.hang;
  w.grounded = !w.hang && w.supported(w.x, w.y);
  scene.turn.state = 'aim';
  scene.turn.currentTeam = w.team;
  scene.turn.activeWorm = w;
  scene.turn.weaponIndex = cmd.weapon;
  scene.hud.setWeaponIndex(cmd.weapon);

  scene.remoteAim = false;
  scene.remoteCharge = 0;
  scene.replaying = true;
  scene.fireActiveWorm(cmd.vx, cmd.vy);
  return true;
}

/**
 * Живой ход: где сейчас боец соперника, куда он целится и сколько набрал.
 *
 * Без этого зритель видел бы соперника застывшим до самого выстрела, а
 * потом сразу результат — «ходы отображаются, когда кончаются». Здесь
 * ничего авторитетного нет: позиция и прицел только рисуются, итог хода
 * всё равно принесёт снимок. Поэтому применяем, лишь пока у нас тот же ход
 * и мы действительно ждём соперника: опоздавшее движение из прошлого хода
 * или движение во время показа выстрела дёрнуло бы бойца не туда.
 */
export function captureMove(scene) {
  const w = scene.turn.activeWorm;
  if (!w) return null;
  return {
    turn: scene.turn.turnNumber,
    worm: scene.worms.indexOf(w),
    x: Math.round(w.x),
    y: Math.round(w.y),
    facing: w.facing,
    hang: w.hang ?? null,
    // Летит по тросу: куда. Зритель доводит рывок сам и видит трос, а не
    // бойца, скачущего по воздуху раз в десятую секунды
    zip: w.zip ? [Math.round(w.zip.ax), Math.round(w.zip.ay)] : null,
    aim: Math.round(scene.aimAngle * 1000) / 1000,
    charge: scene.charging ? Math.round(scene.charge * 100) / 100 : 0,
    weapon: scene.turn.weaponIndex,
    timeLeft: Math.round(scene.turn.timeLeft),
  };
}

export function applyMove(scene, m) {
  const t = scene.turn;
  if (!m || m.turn !== t.turnNumber || t.state !== 'aim') return false;
  const w = scene.worms[m.worm];
  if (!w || !w.alive || t.currentTeam !== w.team) return false;
  if (!scene.awaitingPeer?.()) return false;

  if (w.x !== m.x || w.y !== m.y) w.remoteWalkUntil = scene.time.now + 180;
  w.x = m.x;
  w.y = m.y;
  w.facing = m.facing;
  w.vx = 0;
  w.vy = 0;
  // Координаты чужие, земля своя: если они хоть на пиксель разошлись,
  // боец окажется в склоне. Поднимаем ноги до ближайшей свободной точки
  // над местной поверхностью — картинке важнее не провалиться, чем
  // совпасть с соперником до пикселя
  if (!w.bodyClear(w.x, w.y)) {
    for (let dy = 1; dy <= 48; dy++) {
      if (w.bodyClear(w.x, w.y - dy)) { w.y -= dy; break; }
    }
  }
  w.grounded = w.supported(w.x, w.y);
  // Висит на стене или потолке — у нас тоже, иначе боец падал бы у зрителя
  if (m.zip) {
    w.hang = null;
    w.grounded = false;
    if (!w.zip || w.zip.ax !== m.zip[0] || w.zip.ay !== m.zip[1]) {
      w.zip = { ax: m.zip[0], ay: m.zip[1], budget: 3000 };
    }
  } else {
    w.zip = null;
    w.hang = m.hang ?? null;
  }
  // Приземлился у соперника — складываем парашют и у нас: иначе боец
  // «на земле» с раскрытым куполом висел бы так вечно, а с ним и ход
  if (w.grounded && w.parachuting) w.foldChute();

  scene.aimAngle = m.aim;
  scene.remoteAim = true;
  scene.remoteCharge = m.charge ?? 0;
  if (m.weapon !== undefined && m.weapon !== t.weaponIndex) {
    t.weaponIndex = m.weapon;
    scene.hud.setWeaponIndex(m.weapon);
  }
  // Часы хода — его, а не наши: у зрителя таймер иначе застывал бы на нуле
  if (Number.isFinite(m.timeLeft)) t.timeLeft = m.timeLeft;
  return true;
}

/** Снимок партии: итог хода и то, кому ходить дальше. */
export function captureState(scene) {
  return {
    turn: scene.turn.turnNumber,
    team: scene.turn.currentTeam,
    worm: scene.worms.indexOf(scene.turn.activeWorm),
    cursors: scene.turn.teamCursor.slice(),
    over: scene.turn.state === 'over',
    weapon: scene.turn.weaponIndex,
    wind: Math.round(scene.wind),
    explosions: scene.explosionLog.slice(),
    terrain: scene.terrain.hash(),
    worms: scene.worms.map((w) => ({
      x: Math.round(w.x),
      y: Math.round(w.y),
      hp: w.health,
      alive: w.alive,
      facing: w.facing,
      hang: w.hang ?? null,
    })),
    ammo: scene.turn.ammo.map((row) => row.slice()),
    crates: scene.crates
      .filter((c) => c.alive)
      .map((c) => ({
        x: Math.round(c.x), y: Math.round(c.y), kind: c.kind, landed: c.landed,
        weapon: c.weaponIndex ?? null, rarity: c.rarity ?? null,
      })),
    // Мины переживают ход, поэтому едут в снимке наравне с ящиками
    mines: (scene.mines ?? [])
      .filter((m) => m.alive)
      .map((m) => ({
        x: Math.round(m.x), y: Math.round(m.y),
        weapon: m.weapon.id, armed: m.armed, owner: scene.worms.indexOf(m.owner), magnetic: Boolean(m.magnetic),
      })),
    springs: (scene.springs ?? [])
      .filter((sp) => sp.alive)
      .map((sp) => ({
        x: Math.round(sp.x), y: Math.round(sp.y), uses: sp.uses,
        launch: sp.launch ? { vx: Math.round(sp.launch.vx), vy: Math.round(sp.launch.vy) } : null,
      })),
  };
}

/**
 * Привести партию к снимку. Взрывы применяются к земле здесь: во время
 * показа чужого хода они только рисовались.
 */
export function applyState(scene, state) {
  // Снаряд показа мог не долететь — например, вкладку свернули и кадры
  // перестали идти. Долетев потом, он взорвался бы уже по-настоящему.
  for (const p of scene.projectiles) p.destroy();
  scene.projectiles.length = 0;

  for (const e of state.explosions ?? []) {
    scene.terrain.destroyCircle(e.x, e.y, e.r);
    scene.props?.hit(e.x, e.y, e.r * 1.8, false);
  }

  state.worms.forEach((s, i) => {
    const w = scene.worms[i];
    if (!w) return;
    // Координаты ставим и мёртвому: от места гибели остаётся воронка,
    // и она обязана совпасть с воронкой у соперника.
    w.x = s.x;
    w.y = s.y;
    w.facing = s.facing;
    w.vx = 0;
    w.vy = 0;
    if (!s.alive) {
      if (w.alive) w.kill('сеть');
      return;
    }
    // Показ чужого хода урона не считает (взрыв только рисуется), а итог
    // приходит снимком — молча. Со стороны выглядело, будто попадание не
    // нанесло урона. Показываем его так же, как при своём выстреле: цифрой
    // и вспышкой. Не при мгновенной сборке партии из истории (fastForward)
    const lost = w.health - s.hp;
    // и не при досинхронизации живой партии (там показа выстрела не было)
    if (lost > 0 && w.alive && !scene.fastForward && (scene.replaying || scene.net?.isDuel) && scene.fx?.damageNumber) {
      scene.fx.damageNumber(s.x, s.y - CFG.WORM_H / 2 - 10, lost);
      w.hurtPose = 'worm_hurt';
      w.hurtUntil = scene.time.now + 1300;
      w.flashUntil = scene.time.now + 110;
      w.squash = 0.8;
    }
    w.health = s.hp;
    w.grounded = w.supported(w.x, w.y);
    w.zip = null;
    w.hang = s.hang ?? null;
    // У соперника десант уже приземлился, а у нас парашют ещё раскрыт
    if (w.grounded && w.parachuting) w.foldChute();
  });

  scene.turn.ammo = state.ammo.map((row) => row.slice());
  scene.setWind(state.wind);

  // Ящики пересоздаём: они появляются и исчезают по ходу партии
  for (const c of scene.crates) c.destroy();
  scene.crates = (state.crates ?? []).map((c) => {
    const crate = new Crate(scene, c.x, c.kind, c.weapon ?? null, c.rarity ?? null);
    crate.y = c.y;
    if (c.landed) crate._land();
    return crate;
  });

  // Мины пересобираем так же, как ящики: их состав меняется по ходу партии
  for (const m of scene.mines ?? []) m.destroy();
  scene.mines = (state.mines ?? []).map((m) => {
    const mine = new Mine(scene, m.x, m.y,
      WEAPONS_BY_ID[m.weapon] ?? WEAPONS_BY_ID.mine, scene.worms[m.owner] ?? null, { magnetic: Boolean(m.magnetic) });
    if (m.armed) { mine.armed = true; mine.armTimer = 0; }
    return mine;
  });

  // Батуты — так же: ставят и ломают по ходу партии
  for (const sp of scene.springs ?? []) sp.destroy();
  scene.springs = (state.springs ?? []).map((sp) => {
    const spring = new Spring(scene, sp.x, sp.y, null, sp.launch ?? null);
    if (Number.isFinite(sp.uses)) spring.uses = sp.uses;
    return spring;
  });

  scene.replaying = false;
  scene.explosionLog = [];

  // Очередь принимаем как есть. Если ходивший объявил конец партии,
  // очередь навязывать нечему — победу клиент увидит сам по трупам.
  if (!state.over && state.worm >= 0) {
    scene.turn.forceTurn({
      turn: state.turn, team: state.team, worm: state.worm,
      weapon: state.weapon, cursors: state.cursors,
    });
  }
}

/**
 * Короткая свёртка состояния — чтобы замечать расхождение раньше, чем оно
 * станет заметным игроку.
 */
export function stateHash(state) {
  let h = 2166136261;
  const mix = (n) => {
    h ^= n | 0;
    h = Math.imul(h, 16777619);
  };
  mix(state.turn);
  mix(state.team);
  mix(state.worm);
  mix(state.wind);
  for (const w of state.worms) { mix(w.x); mix(w.y); mix(w.hp); mix(w.alive ? 1 : 0); }
  for (const row of state.ammo) for (const n of row) mix(n === null ? -1 : n);
  // Журнал взрывов в свёртку не идёт: у принявшего он уже пуст. Сверяется
  // результат — то, во что земля превратилась.
  for (const ch of state.terrain ?? '') mix(ch.charCodeAt(0));
  return (h >>> 0).toString(16);
}

/** Параметры партии, которые обязаны совпасть у обоих игроков. */
export function matchConfig(scene) {
  return {
    seed: scene.seed,
    biome: scene.terrain.biome.id,
    worldW: CFG.WORLD_W,
    worldH: CFG.WORLD_H,
  };
}
