/**
 * Агент симуляции внутри страницы игры (грузится из tools/sim/run.mjs).
 *
 * Время виртуальное: цикл Phaser усыплён, performance.now подменён, кадры
 * шагаем сами (game.headlessStep, раз в RENDER_EVERY кадров — с отрисовкой,
 * чтобы ошибки рендера тоже ловились). Партия идёт с той же физикой и тем
 * же ботом, что у игрока, только без ожидания реальных секунд.
 *
 * За командой человека тоже играет бот (Bot.js) — подставляется в
 * scene.bots после create. Описание партии при этом остаётся «человек
 * против бота», и сцена ведёт себя ровно как у игрока: ход человека первый,
 * его патроны, его победа.
 *
 * Ничего в игре не правится — только обёртки над методами на время боя.
 */

const realNow = performance.now.bind(performance);
let virt = realNow();
performance.now = () => virt;

const g = window.__WORMS__;
g.loop.sleep();

const [{ Bot, BOT_LEVELS }, { Worm }, { WEAPONS }, { CFG }, M, { STATE }] = await Promise.all([
  import('/src/ai/Bot.js'),
  import('/src/entities/Worm.js'),
  import('/src/weapons/index.js'),
  import('/src/config.js'),
  import('/src/core/match.js'),
  import('/src/core/TurnManager.js'),
]);

// Тестовый уровень: точность «Снайпера», но в ход идут все стволы с полётом —
// иначе боты гоняли бы только базуку, гранату, кассетную и крота
BOT_LEVELS.sim_all = {
  ...BOT_LEVELS.sniper, id: 'sim_all', name: 'Все стволы',
  weapons: ['bazooka', 'grenade', 'cluster', 'mole', 'banana', 'holy', 'mortar', 'shotgun',
    'weight', 'sticky', 'boomerang', 'homing', 'airstrike', 'bat'],
};

// Сколько кадров на один отрисованный (0 — не рисовать вовсе)
let RENDER_EVERY = window.__simRenderEvery ?? 8;

/**
 * Бот за сторону человека. Человек бьёт и монстров: в бою с боссом врагов-
 * бойцов нет вовсе, и обычный Bot пропускал бы каждый ход. Поэтому к целям
 * добавляются монстры — в бою с боссом все, иначе только подползшие близко.
 */
class SimBot extends Bot {
  bestShot(worm, maxTargets = 2) {
    const real = super.bestShot(worm, maxTargets);
    const s = this.scene;
    const boss = !!s.match.boss;
    const mons = (s.monsters ?? []).filter((m) => m.alive
      && (boss || Math.hypot(m.x - worm.x, m.y - worm.y) < 260))
      .map((m) => ({ x: m.x, y: m.y, centerY: m.centerY, health: Math.min(m.hp, 100), alive: true, team: -1, boss: !!m.def.boss }))
      .sort((a, b) => (b.boss - a.boss) || this.targetScore(worm, a) - this.targetScore(worm, b))
      .slice(0, 2);
    let best = null;
    for (const t of mons) {
      for (const wi of this.weaponChoices()) {
        const shot = this.solve(worm, t, wi);
        if (shot && (!best || shot.score < best.score)) best = shot;
      }
    }
    if (!best) return real;
    if (!real || boss || best.score < real.score * 0.5) return best;
    return real;
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cur = null;          // текущий бой

function game() {
  const s = g.scene.getScene('Game');
  return s && g.scene.isActive('Game') && s.turn ? s : null;
}

// --- урон и смерти: по причине и по стволу, которым стреляли в этот ход ---
const origDamage = Worm.prototype.damage;
Worm.prototype.damage = function (amount, cause = '') {
  const before = this.health;
  const wasAlive = this.alive;
  origDamage.call(this, amount, cause);
  if (!cur || !wasAlive) return;
  const lost = before - this.health;
  if (lost <= 0) return;
  const t = cur.turn;
  const s = game();
  if (cause === 'падение') { cur.fallDamage += lost; return; }
  // Монстры и события места ходят после выстрела — их урон не на ствол
  const key = cur.monsterPhase ? 'monsters' : (t?.weapon && t.fired ? t.weapon : 'env');
  const own = s && t && this.team === t.team;
  const w = (cur.weapons[key] ??= { shots: 0, hitTurns: 0, foeDamage: 0, selfDamage: 0, kills: 0 });
  if (own) w.selfDamage += lost; else w.foeDamage += lost;
  if (t && !own) t.foeDamage += lost;
  if (t && own) t.selfDamage = (t.selfDamage ?? 0) + lost;
  if (!this.alive && !own) w.kills++;
};
const origKill = Worm.prototype.kill;
Worm.prototype.kill = function (cause = '') {
  if (cur && this.alive) {
    cur.deaths[cause || '?'] = (cur.deaths[cause || '?'] ?? 0) + 1;
  }
  return origKill.call(this, cause);
};

// --- время бота на решение: настоящее, не виртуальное ---
const origDecide = Bot.prototype.decide;
Bot.prototype.decide = function (...a) {
  const t0 = realNow();
  const r = origDecide.apply(this, a);
  if (cur) cur.decideMs.push(Math.round((realNow() - t0) * 10) / 10);
  return r;
};

function anomaly(kind, detail = {}) {
  if (!cur) return;
  if (cur.anomalies.length > 40) return;
  const s = game();
  cur.anomalies.push({
    kind, turn: s?.turn.turnNumber ?? null, t: Math.round(cur.gameTime * 10) / 10, ...detail,
  });
}

const wormInfo = (w) => ({
  i: w.scene.worms.indexOf(w), team: w.team, x: Math.round(w.x), y: Math.round(w.y),
  vx: Math.round(w.vx), vy: Math.round(w.vy), grounded: w.grounded, zip: !!w.zip, hang: w.hang ?? null,
  hp: w.health,
});
const projInfo = (p) => ({
  w: p.weapon?.id, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy),
  age: Math.round((p.age ?? 0) * 10) / 10, resting: !!p.resting, digging: !!p.digging,
});

function finishTurn() {
  if (cur) cur.monsterPhase = false;
  const t = cur?.turn;
  if (!t) return;
  if (t.fired && t.weapon && t.foeDamage > 0) cur.weapons[t.weapon].hitTurns++;
  cur.turns.push({ n: t.n, team: t.team, weapon: t.weapon, shots: t.shots, dmg: t.foeDamage, self: t.selfDamage ?? 0, end: t.end, booms: t.booms, from: t.from, aim: t.aim });
  cur.turn = null;
}

/** Обёртки на экземпляр сцены: ход, выстрел, конец хода, итог. */
function instrument(s, cfg) {
  // Бот за «человека»: та же сцена, только кнопки жмёт Bot
  s.bots[0] = new SimBot(s, cfg.level0);
  if (cfg.level0 === 'sim_all' || cfg.level1 === 'sim_all') {
    for (const team of [0, 1]) {
      if ((team === 0 ? cfg.level0 : cfg.level1) !== 'sim_all') continue;
      WEAPONS.forEach((w, i) => {
        if (BOT_LEVELS.sim_all.weapons.includes(w.id) && s.turn.ammo[team][i] !== null) {
          s.turn.ammo[team][i] = Math.max(s.turn.ammo[team][i], 2);
        }
      });
    }
  }
  const tm = s.turn;
  // Сцена в Phaser одна на все запуски: обёртки на экземпляре пережили бы
  // бой и легли бы друг на друга (со старым TurnManager внутри). Поэтому
  // каждый раз заворачиваем исходные методы класса
  const proto = Object.getPrototypeOf(s);
  const begin = proto.onTurnBegin.bind(s);
  s.onTurnBegin = () => {
    finishTurn();
    cur.turn = { n: tm.turnNumber, team: tm.currentTeam, weapon: null, fired: false, shots: 0, foeDamage: 0, end: null };
    return begin();
  };
  // Первый ход уже начался в create — заводим его вручную
  cur.turn = { n: tm.turnNumber, team: tm.currentTeam, weapon: null, fired: false, shots: 0, foeDamage: 0, end: null };
  const runMonsters = proto.runMonsters.bind(s);
  s.runMonsters = () => { cur.monsterPhase = true; return runMonsters(); };
  const fired = tm.onFired.bind(tm);
  tm.onFired = () => {
    const t = cur.turn;
    const id = tm.weapon.id;
    if (t) {
      t.fired = true; t.weapon = id; t.shots++;
      const w = tm.activeWorm;
      if (w && !t.from) t.from = { x: Math.round(w.x), y: Math.round(w.y), hang: w.hang ?? null };
      if (!t.aim) t.aim = { angle: +s.aimAngle.toFixed(2), facing: w?.facing };
    }
    (cur.weapons[id] ??= { shots: 0, hitTurns: 0, foeDamage: 0, selfDamage: 0, kills: 0 }).shots++;
    return fired();
  };
  const end = tm.endTurn.bind(tm);
  tm.endTurn = () => {
    const t = cur.turn;
    if (tm.state === STATE.AIM && t && !t.end) {
      if (tm.timeLeft <= 0) {
        t.end = tm.retreating ? 'retreat' : (t.fired ? 'timeout-after-shot' : 'timeout');
        // Бот не выстрелил за всё время хода — это и есть «ход вышел за таймер»
        if (t.end === 'timeout') {
          const bot = s.botFor(tm.currentTeam);
          anomaly('turnTimeout', { team: tm.currentTeam, phase: bot?.phase ?? null, worm: tm.activeWorm ? wormInfo(tm.activeWorm) : null,
            landing: s.landing?.() ?? null });
        }
      } else {
        const bot = s.botFor(tm.currentTeam);
        t.end = bot?.phase === 'give-up' || bot?.phase === 'done' ? 'pass' : 'ended';
        if (t.end === 'pass' && !t.fired) cur.passes++;
      }
    }
    return end();
  };
  const explode = proto.explode.bind(s);
  s.explode = (x, y, c, o) => {
    const t = cur.turn;
    if (t && !cur.monsterPhase) (t.booms ??= []).length < 4 && t.booms.push({ x: Math.round(x), y: Math.round(y), r: c.radius });
    return explode(x, y, c, o);
  };
  const over = proto.onGameOver.bind(s);
  s.onGameOver = (winner) => {
    if (cur && cur.winner === undefined) {
      finishTurn();
      cur.winner = winner;
      cur.turnCount = tm.turnNumber;
      cur.endTime = cur.gameTime;
    }
    return over(winner);
  };
}

/** Проверки на кадр: зависшие фазы хода, бойцы в земле и за краем, вечные снаряды. */
function monitor(s, dt) {
  const tm = s.turn;
  const m = cur.mon;
  // Фаза хода
  const key = `${tm.turnNumber}:${tm.state}`;
  if (key !== m.stateKey) {
    if (m.prevState === STATE.FLYING && m.flyMax >= CFG.FLY_TIMEOUT) {
      anomaly('flyTimeout', { projectiles: m.flySnap });
    }
    if (m.prevState === STATE.RESOLVE && m.resolveSnap) {
      anomaly('resolveTimeout', m.resolveSnap);
    }
    m.stateKey = key; m.prevState = tm.state; m.stateTime = 0; m.flyMax = 0; m.flySnap = null; m.resolveSnap = null;
  }
  m.stateTime += dt;
  if (tm.state === STATE.FLYING) {
    m.flyMax = Math.max(m.flyMax, tm.flyTimer);
    if (tm.flyTimer > CFG.FLY_TIMEOUT - 0.3 && !m.flySnap) m.flySnap = s.projectiles.slice(0, 6).map(projInfo);
  }
  if (tm.state === STATE.RESOLVE && tm.resolveTimer > CFG.RESOLVE_TIMEOUT - 0.1 && !m.resolveSnap) {
    m.resolveSnap = {
      projectiles: s.projectiles.slice(0, 6).map(projInfo),
      unsettled: s.worms.filter((w) => !w.settled).map(wormInfo),
      barrels: s.barrelsPending ?? 0,
      monstersBusy: !!s.monstersBusy?.(),
      monsters: (s.monsters ?? []).filter((x) => x.alive).map((x) => ({ kind: x.def?.id ?? x.kind, x: Math.round(x.x), y: Math.round(x.y), busy: !!x.busy })),
    };
  }
  if (tm.state !== STATE.OVER && m.stateTime > 90 && !m.stuckReported) {
    m.stuckReported = true;
    anomaly('stuckState', { state: tm.state, landing: s.landing?.() ?? null, timeLeft: tm.timeLeft,
      worms: s.worms.filter((w) => w.alive).map(wormInfo), projectiles: s.projectiles.slice(0, 6).map(projInfo) });
    cur.stuck = true;
  }

  // Бойцы
  const W = s.terrain.width, H = s.terrain.height;
  for (const w of s.worms) {
    if (!w.alive) continue;
    const st = (m.worm[s.worms.indexOf(w)] ??= { inside: 0, out: 0, rep: {} });
    if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) {
      if (!st.rep.nan) { st.rep.nan = 1; anomaly('wormNaN', { worm: wormInfo(w) }); }
      continue;
    }
    const inside = !w.zip && !w.bodyClear(w.x, w.y);
    st.inside = inside ? st.inside + dt : 0;
    if (st.inside > 1 && !st.rep.inside) { st.rep.inside = 1; anomaly('wormInTerrain', { worm: wormInfo(w) }); }
    // За краем мира боец может быть, пока падает в воду (секунда-две);
    // дольше четырёх секунд — значит, висит там, где его не достать
    const out = w.x < -10 || w.x > W + 10 || w.y > CFG.DROWN_Y + 4 || w.y < -400;
    st.out = out ? st.out + dt : 0;
    if (st.out > 4 && !st.rep.out) { st.rep.out = 1; anomaly('wormOutOfBounds', { worm: wormInfo(w), W, H, drownY: CFG.DROWN_Y }); }
  }

  // Снаряды: сколько живут (age считает сам снаряд)
  for (const p of s.projectiles) {
    if (!p.alive || p.__simRep) continue;
    if ((p.age ?? 0) > 20) { p.__simRep = 1; anomaly('longProjectile', projInfo(p)); }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { p.__simRep = 1; anomaly('projectileNaN', projInfo(p)); }
  }
  cur.maxProjectiles = Math.max(cur.maxProjectiles, s.projectiles.length);
}

function stepFrame(dt, render) {
  virt += dt;
  if (render) g.step(virt, dt);
  else g.headlessStep(virt, dt);
}

function buildMatch(cfg) {
  let m;
  if (cfg.kind === 'tower') m = M.towerMatch(cfg.level1);
  else if (cfg.kind === 'classic') m = M.quickMatch(cfg.level1, { shape: cfg.shape, worms: cfg.worms ?? 2 });
  else if (cfg.kind === 'ascent') m = M.ascentMatch(cfg.id);
  else if (cfg.kind === 'challenge') m = M.challengeMatch(cfg.id);
  else if (cfg.kind === 'campaign') m = M.campaignMatch(cfg.id);
  else if (cfg.kind === 'daily') m = M.dailyMatch(cfg.day);
  if (cfg.variant) m.variant = cfg.variant;
  if (cfg.seed != null && m.seed == null) m.seed = cfg.seed;
  return m;
}

window.__sim = {
  /** Перейти в меню, если открыт бой, и прокрутить пару кадров. */
  async toMenu() {
    const s = g.scene.getScene('Game');
    if (g.scene.isActive('Game')) s.toMenu();
    for (let i = 0; i < 30; i++) stepFrame(1000 / 60, i % 8 === 0);
    return g.scene.isActive('Menu');
  },

  start(cfg) {
    Math.random = mulberry(cfg.rand ?? cfg.seed ?? 1);
    const match = buildMatch(cfg);
    const menu = g.scene.getScene('Menu');
    cur = {
      id: cfg.id, gameTime: 0, frames: 0, turns: [], turn: null, weapons: {}, anomalies: [],
      deaths: {}, fallDamage: 0, passes: 0, decideMs: [], maxProjectiles: 0, winner: undefined,
      mon: { worm: {}, stateKey: '', stateTime: 0, flyMax: 0 }, stuck: false, cfg,
    };
    menu.start(match);
    // create отрабатывает на следующем шаге
    for (let i = 0; i < 3 && !game(); i++) stepFrame(1000 / 60, true);
    const s = game();
    if (!s) return { ok: false, error: 'сцена боя не поднялась' };
    instrument(s, cfg);
    return {
      ok: true, seed: s.seed, shape: s.shape.id, variant: s.variant?.id ?? null, biome: s.terrain.biome?.id,
      worms: s.worms.length, monsters: s.monsters.length, affixes: s.affixes?.ids ?? s.match.affixes ?? null,
    };
  },

  /** Прокрутить до maxFrames кадров или до конца боя. */
  run(maxFrames, { fps = 60, maxGameTime = 2400, maxTurns = 200 } = {}) {
    const dt = 1000 / fps;
    const t0 = realNow();
    for (let i = 0; i < maxFrames; i++) {
      const s = game();
      if (!s) break;
      if (cur.winner !== undefined) {
        // Экран итога: ещё секунда, чтобы он отрисовался
        if (cur.gameTime - cur.endTime > 1.5) break;
      } else if (cur.stuck || cur.gameTime > maxGameTime || s.turn.turnNumber > maxTurns) break;
      stepFrame(dt, RENDER_EVERY > 0 && cur.frames % RENDER_EVERY === 0);
      cur.frames++;
      cur.gameTime += dt / 1000;
      if (cur.winner === undefined) monitor(s, dt / 1000);
    }
    const s = game();
    return {
      done: cur.winner !== undefined && cur.gameTime - cur.endTime > 1.5,
      over: cur.winner !== undefined,
      stuck: cur.stuck,
      limit: cur.winner === undefined && !!s && (cur.gameTime > maxGameTime || s.turn.turnNumber > maxTurns),
      lost: !s,
      gameTime: cur.gameTime, turn: s?.turn.turnNumber ?? null, realMs: realNow() - t0,
    };
  },

  result() {
    const s = game();
    finishTurn();
    const r = {
      id: cur.id, winner: cur.winner ?? null, turns: cur.turnCount ?? s?.turn.turnNumber ?? null,
      gameTime: Math.round((cur.endTime ?? cur.gameTime) * 10) / 10, frames: cur.frames,
      weapons: cur.weapons, anomalies: cur.anomalies, deaths: cur.deaths, fallDamage: cur.fallDamage,
      passes: cur.passes, maxProjectiles: cur.maxProjectiles,
      decideMs: cur.decideMs,
      selfTurns: cur.turns.filter((t) => t.self > 0),
      timeouts: cur.turns.filter((t) => t.end === 'timeout').length,
      survivors: s ? s.worms.filter((w) => w.alive).map((w) => `${w.team}:${w.health}`) : [],
    };
    return r;
  },

  /** Сколько чего висит в игре — для проверки утечек между боями. */
  counts() {
    let listeners = 0;
    for (const n of g.events.eventNames()) listeners += g.events.listenerCount(n);
    const menu = g.scene.getScene('Menu');
    return {
      textures: g.textures.getTextureKeys().length,
      domNodes: document.getElementsByTagName('*').length,
      gameListeners: listeners,
      menuChildren: menu?.children?.length ?? null,
      menuTweens: menu?.tweens?.getTweens?.().length ?? null,
      canvases: document.getElementsByTagName('canvas').length,
      cacheAudio: g.cache.audio?.entries?.size ?? null,
    };
  },
};
