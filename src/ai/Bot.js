import { CFG } from '../config.js';
import { WEAPONS } from '../weapons/index.js';
import {
  InstantWeapon, BatWeapon, PlacedWeapon, MineWeapon, AirstrikeWeapon, TeleportWeapon, ClusterWeapon,
} from '../weapons/Weapon.js';
import { simulateFlight, muzzle } from './ballistics.js';

/**
 * Бот.
 *
 * Ход бота выглядит как ход человека: он поворачивается к цели, поднимает
 * ствол, набирает силу и стреляет — теми же методами сцены, что и игрок.
 * Отдельного «читерского» пути в игру у него нет: он не двигает снаряд
 * руками и не знает, где окажется взрыв, — только считает.
 *
 * Как выбирается выстрел:
 *   1. цель — живой чужой боец, ближние и раненые ценнее;
 *   2. по сетке углов и сил гоняется настоящая траектория (ballistics.js),
 *      каждая оценивается по тому, куда снаряд реально прилетел;
 *   3. лучший вариант уточняется мелким шагом вокруг найденного;
 *   4. к нему добавляется промах по уровню сложности — иначе снайпер
 *      попадал бы всегда, и играть было бы не с кем.
 *
 * Уровни различаются не «читом», а точностью и терпением: слабый бот
 * перебирает грубее, ошибается сильнее и знает меньше стволов.
 *
 * Ствол. Выстрел оценивается не расстоянием до цели, а ожидаемым уроном:
 * сколько снимет у чужих (с добиванием), сколько у своих, во что обойдётся
 * патрон. Базука бесконечна и бесплатна, остальное — по редкости, поэтому
 * редкий ствол идёт в ход, только если он заметно лучше: граната и
 * кассета — за бугор и в яму, дробовик и бита — вплотную, самонаводка и
 * бумеранг — за угол, авиаудар — по открытому сверху, мина и динамит — к
 * кучке врагов. Каждый ствол просчитывается своей физикой (simulateFlight).
 * Слабые уровни видят не все стволы и выбирают с шумом: новичок знает
 * только базуку и гранату и о гранате вспоминает от случая к случаю —
 * дробовик бьёт лучом без всякой баллистики, и с ним «Пристрелка» стала бы
 * заметно злее.
 *
 * Позиция. Если с места хорошего выстрела нет (цель за холмом, ствол
 * упирается в склон), боец и снайпер прикидывают пару точек в шаге-двух
 * по обе стороны — ровно тех, куда можно дойти ногами, не падая с обрыва
 * и не заходя в воду, — и, если оттуда выстрел заметно лучше, сначала
 * идут туда, а потом заново целятся уже с нового места. Новичок стоит.
 *
 * Крюк. Там, где он есть, к точкам «дойти ногами» добавляются точки «куда
 * подтянет трос»: бот пускает лучи по кругу, для каждого зацепа считает,
 * где окажется после рывка (тем же шагом, каким летит боец), и оценивает
 * выстрел оттуда. Трос тратится, только если с новой точки заметно лучше.
 * Не достать ниоткуда, а телепорт есть — бот переносится туда, откуда
 * следующим ходом будет хороший выстрел.
 */

export const BOT_LEVELS = {
  // Мишень для испытаний: стоит и пропускает ход
  dummy: {
    id: 'dummy', name: 'Мишень', passive: true,
    angleErr: 0, powerErr: 0, coarse: 0, refine: 0, weapons: [], selfRisk: 0, moves: false,
  },
  // sense — с какой вероятностью за ход вспоминает про каждый не-базучный
  // ствол; pickNoise — шум в оценке ствола: выбирает не всегда лучший
  rookie: {
    id: 'rookie', name: 'Новичок',
    angleErr: 0.10, powerErr: 0.13, coarse: 7, refine: 0,
    weapons: ['bazooka', 'grenade'], selfRisk: 90, moves: false,
    sense: 0.3, pickNoise: 24,
  },
  fighter: {
    id: 'fighter', name: 'Боец',
    angleErr: 0.045, powerErr: 0.06, coarse: 11, refine: 1,
    weapons: ['bazooka', 'grenade', 'cluster', 'shotgun', 'bat', 'banana', 'sticky', 'mortar',
      'mine', 'dynamite', 'homing', 'boomerang', 'airstrike', 'weight', 'teleport'],
    selfRisk: 70, moves: true, sense: 0.75, pickNoise: 9,
  },
  sniper: {
    id: 'sniper', name: 'Снайпер',
    angleErr: 0.015, powerErr: 0.02, coarse: 15, refine: 2,
    weapons: ['bazooka', 'grenade', 'cluster', 'mole', 'shotgun', 'bat', 'banana', 'holy', 'sticky',
      'mortar', 'mine', 'dynamite', 'homing', 'boomerang', 'airstrike', 'weight', 'teleport'],
    selfRisk: 55, moves: true, sense: 1, pickNoise: 0,
  },
};

/** Во что боту обходится патрон: бесконечная базука — даром, остальное по редкости. */
const AMMO_COST = { common: 4, rare: 8, epic: 12, legendary: 18 };
/** Чем прикидывать выстрел с чужой точки (ходьба, трос, телепорт): дешёвое в расчёте. */
const MOVE_WEAPONS = ['bazooka'];

/** Как бот обращается с этим стволом; null — никак. */
function kindOf(w) {
  if (w instanceof BatWeapon) return 'bat';
  if (w instanceof InstantWeapon) return 'beam';
  if (w instanceof AirstrikeWeapon) return 'air';
  if (w instanceof TeleportWeapon) return 'teleport';
  if (w instanceof PlacedWeapon) return 'placed';
  if (w instanceof MineWeapon) return w.projectile.deploy === 'mine' ? 'mine' : null;
  if (w.retreat > 0) return null;          // батут — не для бота
  return 'ballistic';
}

export class Bot {
  constructor(scene, level = 'fighter') {
    this.scene = scene;
    this.level = BOT_LEVELS[level] ?? BOT_LEVELS.fighter;
    this.reset();
  }

  reset() {
    this.plan = null;
    this.phase = 'idle';
    this.timer = 0;
    this.noHook = false;
    this.noWalk = false;
    this._mind = null;
  }

  /**
   * Ход бота по шагам, чтобы он не «телепортировал» выстрел: сначала пауза
   * на раздумье, потом видимый доворот прицела, потом сам выстрел.
   *
   * dt — системные часы (пауза, доворот, заряд), walkDt — игровые: ноги
   * идут той же физикой, что у игрока, и на медленном телефоне не бегут.
   */
  update(dt, walkDt = dt) {
    const scene = this.scene;
    const worm = scene.turn.activeWorm;
    if (!worm || !worm.alive) return;

    this.timer += dt;

    switch (this.phase) {
      case 'idle':
        this.phase = 'think';
        this.timer = 0;
        break;

      case 'think':
        if (this.timer < CFG.BOT_THINK) break;
        if (this.level.passive) { this.phase = 'give-up'; this.timer = 0; break; }
        this.plan = this.decide(worm, { allowMove: this.level.moves });
        if (!this.plan) { this.phase = 'give-up'; this.timer = 0; break; }
        if (this.plan.hookTo) {
          // Пускаем трос тем же вызовом, что и игрок тапом; не зацепился —
          // стреляем с места, как умеем
          const ok = scene.tryHook(this.plan.hookTo.x, this.plan.hookTo.y);
          this.phase = ok ? 'zip' : 'think';
          this.timer = ok ? 0 : CFG.BOT_THINK;
          if (!ok) this.noHook = true;
          break;
        }
        if (this.plan.moveTo != null) {
          this.phase = 'walk';
          this.timer = 0;
          this.lastX = worm.x;
          this.stuck = 0;
          break;
        }
        this._toAim(worm);
        break;

      case 'walk': {
        // Идём ногами, как игрок: теми же шагами по склону. Дошли, упёрлись
        // или идём слишком долго — целимся заново уже с того места, где стоим
        const dx = this.plan.moveTo - worm.x;
        const moved = Math.abs(worm.x - this.lastX);
        this.lastX = worm.x;
        this.stuck = moved < 0.2 ? this.stuck + dt : 0;
        if (Math.abs(dx) <= 3 || this.stuck > 0.5 || this.timer > 3.5 || !worm.grounded) {
          if (!worm.grounded && this.timer < 4.5) break;     // докатимся — тогда целимся
          this.plan = this.decide(worm, { allowMove: false });
          if (!this.plan) { this.phase = 'give-up'; this.timer = 0; break; }
          this._toAim(worm);
          break;
        }
        worm.walk(dx > 0 ? 1 : -1, walkDt);
        break;
      }

      case 'zip':
        // Летим по тросу; долетели — короткая пауза и целимся с нового места
        if (worm.zip || this.timer < 0.35) break;
        // Крюки ещё есть — можно подтянуться и второй раз, ногами уже не идём
        this.noWalk = true;
        this.plan = this.decide(worm, { allowMove: scene.hooksLeft > 0 });
        if (!this.plan) { this.phase = 'give-up'; this.timer = 0; break; }
        if (this.plan.hookTo) {
          const ok = scene.tryHook(this.plan.hookTo.x, this.plan.hookTo.y);
          if (ok) { this.timer = 0; break; }
          this.plan = this.decide(worm, { allowMove: false });
          if (!this.plan) { this.phase = 'give-up'; this.timer = 0; break; }
        }
        this._toAim(worm);
        break;

      case 'aim': {
        // Доводим ствол с той же скоростью, с какой это делает игрок
        const diff = this.plan.angle - scene.aimAngle;
        const step = CFG.AIM_ANGLE_RATE * dt;
        if (Math.abs(diff) <= step) {
          scene.aimAngle = this.plan.angle;
          this.phase = 'charge';
          this.timer = 0;
        } else {
          scene.aimAngle += Math.sign(diff) * step;
        }
        break;
      }

      case 'charge':
        // Заряд копится видимо, как у игрока на удержании кнопки
        if (!scene.charging) scene.beginCharge();
        if (scene.charge >= this.plan.power) {
          scene.releaseCharge();
          // Сплит-ракета: «тап» в нужный момент полёта — тем же полем,
          // каким делит ракету соперник по сети
          if (this.plan.splitAt != null) {
            const p = scene.projectiles.find((x) => x.alive && x.weapon.projectile.split && x.owner === worm);
            if (p) p.splitAt = this.plan.splitAt;
          }
          this.phase = 'done';
          this.timer = 0;
        }
        break;

      case 'give-up':
        // Стрелять некуда — не зависаем, отдаём ход
        if (this.timer > 0.6) { scene.turn.endTurn(); this.phase = 'done'; }
        break;

      case 'done':
        this._afterShot(worm, walkDt);
        break;

      default:
        break;
    }
  }

  _toAim(worm) {
    worm.facing = this.plan.facing;
    // Ствол уже в руках — не перевыбираем: выбор заново взводит выстрелы
    // хода, и второй выстрел дробовика превращался бы в третий
    if (this.scene.turn.weaponIndex !== this.plan.weapon) this.scene.turn.setWeaponIndex(this.plan.weapon);
    this.phase = 'aim';
    this.timer = 0;
  }

  /**
   * Ход после выстрела ещё не кончился: от динамита надо уйти, у
   * дробовика остался второй выстрел.
   */
  _afterShot(worm, walkDt) {
    const turn = this.scene.turn;
    if (turn.state !== 'aim' || !this.plan) return;
    if (turn.retreating) {
      const to = this.plan.retreatTo;
      if (to != null && Math.abs(to - worm.x) > 3 && worm.grounded) worm.walk(to > worm.x ? 1 : -1, walkDt);
      return;
    }
    if (turn.shotsLeft > 0 && turn.weapon.instant && this.timer > 0.45) {
      const shot = this.secondShot(worm);
      if (!shot) { turn.endTurn(); return; }
      this.plan = this.withError(shot);
      this._toAim(worm);
    }
  }

  /** Второй выстрел дробовика: по тому, кто ближе и ещё жив. */
  secondShot(worm) {
    const wi = this.scene.turn.weaponIndex;
    let best = null;
    for (const t of this.foes(worm).slice(0, 2)) {
      const shot = this.solve(worm, t, wi);
      if (shot && shot.score < 60 && (!best || shot.score < best.score)) best = shot;
    }
    return best;
  }

  /**
   * @returns {{angle:number, power:number, facing:number, weapon:number,
   *            moveTo?:number, hookTo?:object, retreatTo?:number, splitAt?:number}|null}
   */
  decide(worm, { allowMove = false } = {}) {
    // Вода подходит к ногам — сперва наверх, стрелять потом
    const flood = this.scene.rules?.flood;
    const drowning = !!flood && worm.y > CFG.WATER_Y - flood.step * 2 - 40;
    if (drowning && !this.noHook && this.scene.hooksLeft > 0 && this.scene.canHook?.()) {
      // Из-под плиты прямо вверх не уйти — лучи пускаем по всему кругу
      let up = null;
      for (const h of this.hookSpots(worm, true)) {
        if (h.end.y < worm.y - 30 && (!up || h.end.y < up.end.y)) up = h;
      }
      if (up) return { hookTo: up.anchor };
    }
    const here = this.bestShot(worm);
    if (!allowMove || (here && here.score < 30)) return this.withError(here);

    // С места плохо: прикидываем пару точек рядом, куда можно дойти ногами.
    // С чужой точки считаем только дешёвые стволы: дошли — прицелимся
    // заново уже всем, что есть
    const quick = { weapons: MOVE_WEAPONS };
    let move = null;
    const x0 = worm.x, y0 = worm.y;
    for (const x of this.noWalk ? [] : this.walkableSpots(worm)) {
      worm.x = x.x; worm.y = x.y;
      const shot = this.bestShot(worm, 1, quick);
      if (shot && (!move || shot.score < move.shot.score)) move = { x: x.x, shot };
    }
    // И точки, куда подтянет трос
    let hook = null;
    let closer = null;      // точка, откуда до цели просто ближе
    if (!this.noHook && this.scene.hooksLeft > 0 && this.scene.canHook?.()) {
      const target = this.foes(worm)[0];
      const far = (x, y) => (target ? Math.hypot(target.x - x, target.y - y) : 0);
      for (const h of this.hookSpots(worm)) {
        worm.x = h.end.x; worm.y = h.end.y;
        const shot = this.bestShot(worm, 1, quick);
        if (shot && (!hook || shot.score < hook.shot.score)) hook = { at: h.anchor, shot };
        const d = far(h.end.x, h.end.y);
        if (!closer || d < closer.d) closer = { at: h.anchor, d };
      }
      if (closer && closer.d > far(x0, y0) - 90) closer = null;
    }
    worm.x = x0; worm.y = y0;
    // Идти стоит, только если оттуда заметно лучше: суета ради пары
    // пикселей выглядит глупо и тратит время хода. Трос — тем более
    const better = (c) => c && (!here || c.shot.score < here.score * 0.6 - 10);
    if (better(hook) && (!better(move) || hook.shot.score < move.shot.score - 15)) {
      return { ...this.withError(hook.shot), hookTo: hook.at };
    }
    if (better(move)) return { ...this.withError(move.shot), moveTo: move.x };
    // Достать не выходит ниоткуда (цель тремя этажами выше): тогда просто
    // подбираемся ближе, а стрелять будем уже оттуда. Иначе бот до конца
    // партии палил бы в потолок
    if (closer && (!here || here.score > 150)) return { hookTo: closer.at };
    // Ни ногами, ни тросом — телепорт туда, откуда следующим ходом попадём
    if (!here || here.score > 110 || drowning) {
      const tp = this.teleportShot(worm, here, drowning);
      if (tp) return this.withError(tp);
    }
    return this.withError(here);
  }

  /**
   * Куда можно подтянуться: лучи по кругу, сначала вверх. Близкие друг к
   * другу конечные точки сливаются — считать выстрел дважды с одного места
   * незачем. Не больше восьми: каждая точка — это полный перебор выстрелов.
   */
  hookSpots(worm, wide = false) {
    const scene = this.scene;
    const out = [];
    for (let k = 0; k < (wide ? 32 : 20) && out.length < (wide ? 12 : 8); k++) {
      // -90° (вверх), затем веером в обе стороны до горизонта и чуть ниже
      const off = Math.ceil(k / 2) * (Math.PI / 16) * (k % 2 ? 1 : -1);
      const a = -Math.PI / 2 + off;
      const anchor = scene.hookAnchor(worm,
        worm.x + Math.cos(a) * 200, worm.centerY + Math.sin(a) * 200);
      if (!anchor) continue;
      const end = worm.zipEnd(anchor.x, anchor.y);
      if (!end.grounded && !end.hang) continue;                 // сорвётся
      if (end.y > CFG.DROWN_Y - 30) continue;
      if (Math.hypot(end.x - worm.x, end.y - worm.y) < 60) continue;
      if (out.some((o) => Math.hypot(o.end.x - end.x, o.end.y - end.y) < 50)) continue;
      out.push({ anchor, end });
    }
    return out;
  }

  /**
   * Точки по обе стороны, куда реально дойти: идём по профилю так же, как
   * ходит боец (подъём не круче шага, без обрывов и воды). marks — на
   * каком расстоянии ставить точки.
   */
  walkableSpots(worm, reach = 120, marks = [45, 90, 120]) {
    const out = [];
    for (const dir of [-1, 1]) {
      let x = worm.x, y = worm.y;
      for (let d = 3; d <= reach; d += 3) {
        const nx = worm.x + dir * d;
        if (nx < 30 || nx > this.scene.terrain.width - 30) break;
        const ny = worm.footYAt(nx, y);
        if (ny === null || !worm.bodyClear(nx, ny) || ny > CFG.DROWN_Y - 30) break;
        x = nx; y = ny;
        if (marks.includes(d)) out.push({ x, y });
      }
    }
    return out;
  }

  /** Живые враги, ближние и раненые первыми. */
  foes(worm) {
    return this.scene.worms
      .filter((w) => w.alive && w.team !== worm.team)
      .sort((a, b) => this.targetScore(worm, a) - this.targetScore(worm, b));
  }

  /**
   * Лучший выстрел из текущей позиции бойца — без промаха.
   * opts.weapons — ограничить список стволов (прикидка с чужой точки).
   */
  bestShot(worm, maxTargets = 2, opts = {}) {
    const targets = this.foes(worm);
    if (!targets.length) return null;

    let best = null;
    for (const [i, target] of targets.slice(0, maxTargets).entries()) {
      // По второй цели — только базукой и гранатой, если по первой уже есть
      // приличный выстрел: полный перебор стволов дважды — это лишний
      // кадр раздумий на слабом телефоне
      const o = i > 0 && best && best.score < 40 && !opts.weapons ? { ...opts, weapons: ['bazooka', 'grenade'] } : opts;
      const shot = this.bestAgainst(worm, target, o);
      if (shot && (!best || shot.score < best.score)) best = shot;
      // Хорошее попадание искать дальше незачем
      if (best && best.score < 12) break;
    }
    return best;
  }

  /** Лучший ствол против одной цели: сначала базука, потом то, что к месту. */
  bestAgainst(worm, target, opts = {}) {
    const mind = this.mind();
    const ctx = this.situation(worm, target);
    let best = null;
    for (const wi of this.weaponChoices(opts.weapons)) {
      if (best && !this.worthTrying(wi, ctx, best.score)) continue;
      const shot = this.solve(worm, target, wi);
      if (!shot) continue;
      // Слабый бот путается в стволах: оценка с шумом, свой на каждый ствол,
      // — иногда хватается не за лучший
      if (this.level.pickNoise) shot.score += (mind.noise(wi) - 0.5) * this.level.pickNoise;
      if (!best || shot.score < best.score) best = shot;
    }
    return best;
  }

  /**
   * Что известно о цели до перебора: далеко ли, видно ли её по прямой,
   * открыта ли сверху, есть ли враги рядом с ней. По этому решается, какие
   * стволы вообще стоит считать.
   */
  situation(worm, target) {
    const t = this.scene.terrain;
    const dist = Math.hypot(target.x - worm.x, target.centerY - worm.centerY);
    const los = !t.raycast(worm.x, worm.centerY - 4, target.x, target.centerY).hit;
    const top = t.surfaceYAt(Math.round(target.x), 0);
    const openSky = top === null || top >= target.y - 8;
    let crowd = 0;
    for (const w of this.scene.worms) {
      if (w.alive && w !== target && w.team !== worm.team && Math.hypot(w.x - target.x, w.y - target.y) < 140) crowd++;
    }
    return { dist, los, openSky, crowd };
  }

  /**
   * Стоит ли считать этот ствол, когда уже есть выстрел с оценкой score.
   * Чистое попадание базукой перебить можно только тем, что бьёт сильнее
   * или сразу по нескольким, — остальное не считаем: это время хода на
   * слабом телефоне.
   */
  worthTrying(wi, ctx, score) {
    const w = WEAPONS[wi];
    const clean = score < 14;
    switch (kindOf(w)) {
      case 'beam': return ctx.los && ctx.dist < 260;
      case 'bat': return ctx.dist < 70;
      case 'placed': return ctx.dist < 110;
      case 'air': return ctx.openSky && (!clean || ctx.crowd > 0);
      case 'mine': return !clean && (ctx.crowd > 0 || !ctx.los);
      case 'teleport': return false;
      default:
        if (w.projectile.homing || w.projectile.boomerang) {
          return !clean && (!ctx.los || Math.abs(this.scene.wind) > 150 || ctx.dist > 600);
        }
        return !clean || (ctx.crowd > 0 && (w instanceof ClusterWeapon || w.explosion.damage >= 60));
    }
  }

  /** Промах по уровню поверх идеального решения. */
  withError(best) {
    if (!best) return null;
    // Промах по уровню. Врать в оценке нельзя — врём в исполнении, ровно
    // как человек, у которого дрогнула рука.
    const rng = this.scene.turnRng;
    const angle = best.angle + (rng() * 2 - 1) * this.level.angleErr;
    const power = Math.min(1, Math.max(CFG.CHARGE_MIN + 0.05,
      best.power * (1 + (rng() * 2 - 1) * this.level.powerErr)));
    const out = { angle, power, facing: best.facing, weapon: best.weapon };
    if (best.retreatTo != null) out.retreatTo = best.retreatTo;
    if (best.splitAt != null) out.splitAt = best.splitAt;
    return out;
  }

  /** Меньше — привлекательнее: ближние и раненые. */
  targetScore(worm, target) {
    const d = Math.hypot(target.x - worm.x, target.y - worm.y);
    return d + target.health * 4;
  }

  /**
   * Доступное оружие этого уровня с патронами, базука первой. Не-базучные
   * стволы слабый уровень «вспоминает» не каждый ход (level.sense), и
   * решение держится весь ход — иначе бот передумывал бы на каждом
   * пересчёте. only — ограничить список.
   */
  weaponChoices(only = null) {
    const mind = this.mind();
    const out = [];
    for (let i = 0; i < WEAPONS.length; i++) {
      const w = WEAPONS[i];
      if (!this.level.weapons.includes(w.id)) continue;
      if (only && !only.includes(w.id)) continue;
      if (this.scene.turn.ammoOf(i) <= 0) continue;
      if (!kindOf(w)) continue;
      if (w.startAmmo !== null && !mind.remembers(i)) continue;
      out.push(i);
    }
    // Базука — первой: по её выстрелу решается, стоит ли считать остальное
    out.sort((a, b) => (WEAPONS[a].startAmmo === null ? 0 : 1) - (WEAPONS[b].startAmmo === null ? 0 : 1));
    return out;
  }

  /** Случайности решения на этот ход: что вспомнил и как путается. */
  mind() {
    const turn = this.scene.turn?.turnNumber ?? 0;
    if (this._mind?.turn === turn) return this._mind;
    const rng = () => (this.scene.turnRng ? this.scene.turnRng() : Math.random());
    const sense = this.level.sense ?? 1;
    const seen = new Map();
    const noise = new Map();
    this._mind = {
      turn,
      remembers: (i) => {
        if (!seen.has(i)) seen.set(i, sense >= 1 || rng() < sense);
        return seen.get(i);
      },
      noise: (i) => {
        if (!noise.has(i)) noise.set(i, rng());
        return noise.get(i);
      },
    };
    return this._mind;
  }

  /**
   * Сколько стоит потратить патрон этого ствола: по редкости, и тем
   * дешевле, чем больше их осталось, — последнюю гранату бот бережёт, а
   * три подряд в сундуке не держит.
   */
  ammoCost(weapon) {
    if (weapon.startAmmo === null) return 0;
    const left = this.scene.turn.ammoOf(WEAPONS.indexOf(weapon));
    return (AMMO_COST[weapon.rarity] ?? 6) / Math.max(1, Math.min(3, left));
  }

  /**
   * Лучший выстрел этим стволом по цели (без промаха).
   * @returns {{angle, power, facing, weapon, score, retreatTo?, splitAt?}|null}
   */
  solve(worm, target, weaponIndex) {
    switch (kindOf(WEAPONS[weaponIndex])) {
      case 'beam': return this.solveBeam(worm, target, weaponIndex);
      case 'bat': return this.solveBat(worm, target, weaponIndex);
      case 'air': return this.solveAir(worm, target, weaponIndex);
      case 'placed': return this.solvePlaced(worm, target, weaponIndex);
      case 'ballistic': case 'mine': return this.solveFlight(worm, target, weaponIndex);
      default: return null;
    }
  }

  /**
   * Перебор углов и сил с уточнением вокруг лучшего — настоящей физикой
   * ствола. Считается на одном ходу один раз, не в каждом кадре.
   */
  solveFlight(worm, target, weaponIndex) {
    const weapon = WEAPONS[weaponIndex];
    const facing = target.x >= worm.x ? 1 : -1;
    const lo = -CFG.AIM_ANGLE_LIMIT, hi = CFG.AIM_ANGLE_LIMIT;
    const cost = this.ammoCost(weapon);

    let best = null;
    const plain = !weapon.projectile.bounciness && !weapon.projectile.fuse;
    const top = [];      // лучшие кандидаты — для проверки на дрожь руки
    const fly = (angle, power, splitAt = null) => {
      const dx = Math.cos(angle) * facing;
      const dy = -Math.sin(angle);
      const m = muzzle(this.scene, worm, dx, dy);
      const speed = power * CFG.AIM_MAX_POWER;
      return simulateFlight(this.scene, m.x, m.y, dx * speed, dy * speed, weapon, worm,
        splitAt != null ? { splitAt } : undefined);
    };
    const tryShot = (angle, power) => {
      const res = fly(angle, power);
      const score = this.scoreShot(res, target, worm, weapon) + cost;
      const shot = { angle, power, facing, weapon: weaponIndex, score, time: res.time };
      if (!best || score < best.score) best = shot;
      top.push(shot);
      if (top.length > 6) { top.sort((a, b) => a.score - b.score); top.length = 3; }
    };

    // Отскоки и фитиль считать дороже прямого полёта, а точнее от мелкой
    // сетки они не становятся: исход всё равно решает рельеф. Сетка реже
    const n = plain ? this.level.coarse : Math.max(7, this.level.coarse - 4);
    const refine = plain ? this.level.refine : Math.min(1, this.level.refine);
    for (let i = 0; i < n; i++) {
      const angle = lo + ((hi - lo) * i) / (n - 1);
      for (let p = 0.35; p <= 1.001; p += 0.1625) tryShot(angle, p);
    }
    if (!best) return null;

    let stepA = (hi - lo) / (n - 1) / 2;
    let stepP = 0.08;
    for (let r = 0; r < refine; r++) {
      const { angle, power } = best;
      for (const da of [-stepA, 0, stepA]) {
        for (const dp of [-stepP, 0, stepP]) {
          const a = Math.min(hi, Math.max(lo, angle + da));
          const p = Math.min(1, Math.max(0.2, power + dp));
          tryShot(a, p);
        }
      }
      stepA /= 2; stepP /= 2;
    }
    // Идеальный бросок мало что значит, если чуть дрогнувшая рука уводит
    // гранату в другую сторону бугра, а ракету — в край уступа. Лучшие
    // кандидаты переоцениваем как среднее по броскам с промахом этого
    // уровня — берём тот, что надёжен, а не тот, что красив. Так и стволы
    // сравниваются честно: у прыгучих разброс исхода больше
    if (top.length) {
      top.sort((a, b) => a.score - b.score);
      const da = Math.max(0.012, this.level.angleErr * 0.7);
      const dp = Math.max(0.015, this.level.powerErr * 0.7);
      let robust = null;
      for (const c of top.slice(0, 3)) {
        let sum = c.score;
        for (const [ja, jp] of [[da, 0], [-da, 0], [0, dp], [0, -dp]]) {
          const a = Math.min(hi, Math.max(lo, c.angle + ja));
          const p = Math.min(1, Math.max(0.2, c.power * (1 + jp)));
          sum += this.scoreShot(fly(a, p), target, worm, weapon) + cost;
        }
        const score = sum / 5;
        if (!robust || score < robust.score) robust = { ...c, score };
      }
      best = robust;
    }
    // Сплит-ракета: пробуем разделить её незадолго до удара — веер из трёх
    // накрывает того, кто прячется за бугром
    if (weapon.projectile.split && best.time > 0.5) {
      const base = best;
      for (const before of [0.22, 0.38]) {
        const at = base.time - before;
        const score = this.scoreShot(fly(base.angle, base.power, at), target, worm, weapon) + cost;
        if (score < best.score) best = { ...base, score, splitAt: at };
      }
    }
    return best;
  }

  /**
   * Дробовик: луч, ветра и дуги нет. Целимся в корпус, в голову и в ноги —
   * что не перекрыто землёй. Два выстрела за ход: второй чаще всего тоже
   * в цель, но толчок от первого может её сдвинуть.
   */
  solveBeam(worm, target, weaponIndex) {
    const weapon = WEAPONS[weaponIndex];
    const facing = target.x >= worm.x ? 1 : -1;
    const turn = this.scene.turn;
    const shots = turn.weaponIndex === weaponIndex && turn.shotsLeft < weapon.shots ? turn.shotsLeft : weapon.shots;
    let best = null;
    for (const oy of [0, -9, 9]) {
      const ty = target.centerY + oy;
      const ang = Math.atan2(-(ty - worm.centerY), Math.abs(target.x - worm.x));
      if (Math.abs(ang) > CFG.AIM_ANGLE_LIMIT) continue;
      const dx = Math.cos(ang) * facing, dy = -Math.sin(ang);
      const m = muzzle(this.scene, worm, dx, dy);
      const hit = this.beamHit(m.x, m.y, dx, dy, weapon.range, worm);
      const res = { kind: hit.out ? 'out' : hit.worm ? 'worm' : 'terrain', x: hit.x, y: hit.y, worm: hit.worm };
      const one = this.scoreShot(res, target, worm, weapon);
      // Второй выстрел: ожидаемо ещё ~70% урона первого
      const score = one - (shots > 1 ? Math.max(0, 50 - one) * 0.7 : 0) + this.ammoCost(weapon);
      if (!best || score < best.score) best = { angle: ang, power: 0.35, facing, weapon: weaponIndex, score };
    }
    return best;
  }

  /** Куда упрётся луч дробовика — тем же шагом, что InstantWeapon.fire. */
  beamHit(x, y, dx, dy, range, owner) {
    const s = this.scene;
    let hx = x, hy = y;
    for (let d = 0; d <= range; d += 2) {
      hx = x + dx * d; hy = y + dy * d;
      if (hx < 0 || hx > s.terrain.width || hy > s.terrain.height) return { x: hx, y: hy, worm: null, out: true };
      for (const w of s.worms) if (w.alive && w !== owner && w.containsPoint(hx, hy)) return { x: hx, y: hy, worm: w };
      if (s.terrain.solidAt(hx, hy)) return { x: hx, y: hy, worm: null };
    }
    return { x: hx, y: hy, worm: null, out: true };
  }

  /**
   * Бита: бьёт всех в секторе перед собой, урон мелкий — весь смысл в
   * толчке. Прикидываем, куда улетит цель: в воду или за край — это
   * добивание, с обрыва — урон от падения.
   */
  solveBat(worm, target, weaponIndex) {
    const weapon = WEAPONS[weaponIndex];
    const facing = target.x >= worm.x ? 1 : -1;
    const gapX = (target.x - worm.x) * facing;
    if (gapX < -6 || gapX > weapon.range || Math.abs(target.centerY - worm.centerY) > weapon.range * 0.8) return null;
    const hp = target.health ?? 100;
    // Своих рядом бита тоже задевает
    let self = 0;
    for (const w of this.scene.worms) {
      if (!w.alive || w === worm || w.team !== worm.team) continue;
      const gx = (w.x - worm.x) * facing;
      if (gx >= -6 && gx <= weapon.range && Math.abs(w.centerY - worm.centerY) <= weapon.range * 0.8) self += this.level.selfRisk * 4;
    }
    let best = null;
    for (const ang of [0.05, 0.35, 0.7]) {
      const kx = Math.cos(ang) * facing * weapon.explosion.knockback;
      const ky = -Math.abs(weapon.explosion.knockback) * 0.55;
      // Цель летит точкой из своего центра; себя же она не задевает
      const fly = simulateFlight(this.scene, target.x, target.centerY, kx, ky,
        { projectile: { gravityScale: 1, windScale: 0 } }, target);
      let value = weapon.explosion.damage;
      const drop = fly.y - target.centerY;
      if (fly.kind === 'water' || fly.kind === 'out' || fly.y > CFG.DROWN_Y) value = hp + 20;
      else if (drop > CFG.FALL_SAFE) value += Math.min(CFG.FALL_DMG_MAX, (drop - CFG.FALL_SAFE) * CFG.FALL_DMG_PER_PX);
      if (value >= hp) value = hp + 20;
      const score = 50 - value + self + this.ammoCost(weapon);
      if (!best || score < best.score) best = { angle: ang, power: 0.35, facing, weapon: weaponIndex, score };
    }
    return best;
  }

  /**
   * Авиаудар: сторона — куда смотрит ствол, дальность — сила. Ракеты
   * считаем по одной, из тех же точек, что AirstrikeWeapon.fire.
   */
  solveAir(worm, target, weaponIndex) {
    const weapon = WEAPONS[weaponIndex];
    // Башня: удар — в точку прицела; ракеты приходят на этаж под ней
    if (weapon.tall(this.scene)) {
      const reach = weapon.reachOf(this.scene);
      let hit = null;
      for (const off of [-24, 0, 24]) {
        const dx = target.x + off - worm.x, dy = target.centerY - worm.centerY;
        const power = Math.hypot(dx, dy) / reach;
        if (power < CFG.CHARGE_MIN + 0.06 || power > 1) continue;
        const facing = dx >= 0 ? 1 : -1;
        const angle = Math.atan2(-dy, Math.abs(dx));
        const speed = power * CFG.AIM_MAX_POWER;
        const plan = weapon.plan(this.scene, worm, Math.cos(angle) * facing * speed, -Math.sin(angle) * speed);
        const impacts = plan.missiles.map((m) => ({ kind: 'terrain', x: m.landX, y: plan.t.y }));
        const score = this.scoreImpacts(impacts, target, worm, weapon.missileWeapon.explosion) + this.ammoCost(weapon);
        if (!hit || score < hit.score) hit = { angle, power, facing, weapon: weaponIndex, score };
      }
      return hit;
    }
    const side = target.x >= worm.x ? 1 : -1;
    const W = this.scene.terrain.width;
    let best = null;
    for (const off of [-36, -12, 12, 36]) {
      const power = (Math.abs(target.x - worm.x) + off * side) / weapon.reach;
      if (power < CFG.CHARGE_MIN + 0.06 || power > 1) continue;
      const tx = Math.max(40, Math.min(W - 40, worm.x + side * power * weapon.reach));
      const half = (weapon.missiles - 1) / 2;
      const impacts = [];
      for (let i = 0; i < weapon.missiles; i++) {
        const mx = tx + (i - half) * weapon.spacing - side * 40;
        impacts.push(simulateFlight(this.scene, mx, -40 - i * 26, side * 60, 420, weapon.missileWeapon, worm));
      }
      const score = this.scoreImpacts(impacts, target, worm, weapon.missileWeapon.explosion) + this.ammoCost(weapon);
      if (!best || score < best.score) best = { angle: Math.PI / 4, power, facing: side, weapon: weaponIndex, score };
    }
    return best;
  }

  /**
   * Динамит под ноги: враг рядом, и есть куда уйти ногами дальше радиуса
   * взрыва, — иначе это самоподрыв.
   */
  solvePlaced(worm, target, weaponIndex) {
    const weapon = WEAPONS[weaponIndex];
    const R = weapon.explosion.damageRadius;
    let away = null;
    for (const spot of this.walkableSpots(worm, 240, [150, 180, 210, 240])) {
      if (Math.abs(spot.x - worm.x) < R + 15) continue;
      const fromFoe = Math.abs(spot.x - target.x);
      if (!away || fromFoe > away.fromFoe) away = { x: spot.x, fromFoe };
    }
    if (!away) return null;
    const score = this.scoreImpacts([{ kind: 'terrain', x: worm.x, y: worm.y - 6 }], target, null, weapon.explosion, worm)
      + this.ammoCost(weapon);
    return { angle: 0, power: 0.35, facing: away.x > worm.x ? 1 : -1, weapon: weaponIndex, score, retreatTo: away.x };
  }

  /**
   * Телепорт: ход кончается переносом, так что выбираем точку, откуда
   * следующим ходом будет хороший выстрел и где не стоишь у врага под
   * носом (а если поднимается вода — повыше).
   */
  teleportShot(worm, here, drowning) {
    const wi = WEAPONS.findIndex((w) => w instanceof TeleportWeapon);
    if (wi < 0 || !this.level.weapons.includes(WEAPONS[wi].id) || this.scene.turn.ammoOf(wi) <= 0) return null;
    const weapon = WEAPONS[wi];
    const foes = this.foes(worm);
    if (!foes.length) return null;
    const x0 = worm.x, y0 = worm.y;
    let best = null;
    for (const facing of [-1, 1]) {
      for (const angle of [0.2, 0.6, 1.0]) {
        for (const power of [0.3, 0.55, 0.8]) {
          const speed = power * CFG.AIM_MAX_POWER;
          const t = weapon.targetPoint(this.scene, worm, Math.cos(angle) * facing * speed, -Math.sin(angle) * speed);
          if (t.water || t.y > CFG.DROWN_Y - 40 || (drowning && t.y > worm.y - 60)) continue;
          // Точка, где телепорт не нашёл места (в толще земли), — не годится
          if (!worm.bodyClear(t.x, t.y) || !worm.supported(t.x, t.y)) continue;
          const near = Math.min(...foes.map((f) => Math.hypot(f.x - t.x, f.y - t.y)));
          if (near < 140) continue;
          worm.x = t.x; worm.y = t.y;
          const shot = this.bestShot(worm, 1, { weapons: ['bazooka'] });
          worm.x = x0; worm.y = y0;
          if (!shot) continue;
          const score = shot.score + 25 + this.ammoCost(weapon);
          if (!best || score < best.score) best = { angle, power, facing, weapon: wi, score };
        }
      }
    }
    // Переносимся, только если оттуда правда лучше, чем стрелять отсюда
    if (!best || (here && !drowning && best.score > here.score - 30)) return null;
    return best;
  }

  /**
   * Оценка результата полёта: меньше — лучше. Около 50 — промах рядом,
   * около нуля — прямое попадание базукой, ниже нуля — сильнее базуки или
   * сразу по нескольким. На близких попаданиях шкала та же, что у прежней
   * «дистанции до цели»: пороги в decide рассчитаны на неё.
   */
  scoreShot(res, target, self, weapon) {
    if (res.kind === 'out') return 5000;
    if (res.kind === 'worm' && res.worm.team === self.team) return 4000;
    if (res.kind === 'split') return this.scoreImpacts(res.parts, target, self, weapon.projectile.split.explosion);
    if (res.kind === 'boomerang') return this.scoreBoomerang(res, target, self, weapon);
    if (res.kind === 'mine') return this.scoreMine(res, target, self, weapon);
    let score = this.scoreImpacts([res], target, self, weapon.explosion);
    // Кассета: бомблеты сыплются веером вокруг точки разрыва
    if (weapon instanceof ClusterWeapon) {
      const b = weapon.bombletWeapon.explosion;
      for (const w of this.foesWith(self, target)) {
        const d = Math.hypot(res.x - w.x, res.y - w.centerY);
        score -= Math.min(w.health ?? 100, weapon.clusterCount * b.damage * 0.3) * Math.max(0, 1 - d / 120);
      }
      for (const w of this.scene.worms) {
        if (!w.alive || w.team !== self.team) continue;
        const d = Math.hypot(res.x - w.x, res.y - w.centerY);
        if (d < 120) score += (1 - d / 120) * this.level.selfRisk * 4;
      }
    }
    return score;
  }

  /** Враги плюс сама цель, если она не боец (монстр в бою с боссом). */
  foesWith(self, target) {
    const out = this.scene.worms.filter((w) => w.alive && (!self || w.team !== self.team));
    if (target && !out.includes(target)) out.push(target);
    return out;
  }

  /**
   * Сумма по взрывам: ожидаемый урон чужим (не больше их здоровья, с
   * премией за добивание) против урона своим. Ничего не задели — оценка
   * растёт с расстоянием до цели, чтобы перебору было куда сходиться.
   * placer — кто кладёт заряд под ноги: он уходит, его не считаем.
   */
  scoreImpacts(impacts, target, self, ex, placer = null) {
    const me = self ?? placer;
    const foes = this.foesWith(me, target);
    const got = new Map();
    let miss = Infinity;
    let any = false;
    for (const r of impacts) {
      if (!r || r.kind === 'out') continue;
      any = true;
      for (const w of foes) {
        const direct = r.kind === 'worm' && r.worm === w;
        const d = direct ? 0 : Math.hypot(r.x - w.x, r.y - w.centerY);
        if (w === target) miss = Math.min(miss, d + (r.kind === 'water' ? 300 : 0));
        if (d >= ex.damageRadius) continue;
        got.set(w, (got.get(w) ?? 0) + ex.damage * (1 - d / ex.damageRadius));
      }
    }
    if (!any) return 5000;
    let gain = 0;
    for (const [w, dmg] of got) {
      const hp = Math.max(1, w.health ?? 100);
      gain += Math.min(dmg, hp) + (dmg >= hp ? 20 : 0);
    }
    let score = 50 - gain;
    if (!gain) score += Math.max(0, miss - ex.damageRadius);
    // Самоподрыв: попадание рядом со своими хуже промаха
    const R = ex.damageRadius;
    const k = this.level.selfRisk * 10 * Math.max(0.5, ex.damage / 45);
    for (const w of this.scene.worms) {
      if (!w.alive || !me || w.team !== me.team || w === placer) continue;
      for (const r of impacts) {
        if (!r || r.kind === 'out') continue;
        const d = Math.hypot(r.x - w.x, r.y - w.centerY);
        if (d < R) score += (1 - d / R) * k;
      }
    }
    return score;
  }

  /**
   * Бумеранг: урон каждому, кого задел на пути туда и обратно. Обратный
   * удар — в треть цены: первый удар отбрасывает цель, и на обратном пути
   * бумеранг чаще всего проходит мимо.
   */
  scoreBoomerang(res, target, self, weapon) {
    const dmg = weapon.projectile.hitDamage || 25;
    const got = new Map();
    const struck = new Set();
    let selfPen = 0;
    for (const h of res.hits) {
      if (h.worm.team === self.team) { selfPen += this.level.selfRisk * 4; continue; }
      const d = struck.has(h.worm) ? dmg / 3 : dmg;
      struck.add(h.worm);
      got.set(h.worm, (got.get(h.worm) ?? 0) + d);
    }
    let gain = 0;
    for (const [w, d] of got) gain += Math.min(d, w.health) + (d >= w.health ? 20 : 0);
    return 50 - gain + selfPen + (gain ? 0 : 60);
  }

  /**
   * Магнитная мина: легла — взводится и ползёт к врагу, если тот ближе
   * 190 px. Урон отложенный и не наверняка, поэтому ценится в полцены.
   */
  scoreMine(res, target, self, weapon) {
    const ex = weapon.explosion;
    let gain = 0;
    let miss = Infinity;
    for (const w of this.foesWith(self, target)) {
      const dx = Math.abs(w.x - res.x), dy = Math.abs(w.y - res.y);
      if (w === target) miss = Math.min(miss, Math.hypot(dx, dy));
      if (dy > 40 || dx > 180) continue;
      gain += Math.min(w.health ?? 100, ex.damage) * 0.6 * (1 - dx / 260);
    }
    let score = 50 - gain;
    if (!gain) score += Math.max(0, miss - 60);
    for (const w of this.scene.worms) {
      if (!w.alive || w.team !== self.team) continue;
      const d = Math.hypot(res.x - w.x, res.y - w.y);
      if (d < 200) score += (1 - d / 200) * this.level.selfRisk * 6;
    }
    return score;
  }
}
