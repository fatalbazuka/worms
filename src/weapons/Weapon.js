import { Projectile } from '../entities/Projectile.js';
import { CFG } from '../config.js';

/**
 * Базовый класс оружия.
 *
 * Оружие — это описание снаряда + описание взрыва + поведение при попадании.
 * Чтобы добавить новое: наследуемся (или просто создаём Weapon с другим
 * конфигом) и регистрируем в weapons/index.js.
 */
export class Weapon {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.icon = cfg.icon ?? '•';
    this.color = cfg.color ?? 0xffffff;
    this.spriteKey = cfg.spriteKey ?? null;
    this.iconKey = cfg.iconKey ?? null;
    // null = бесконечно (базука), число = стартовый запас на команду
    this.startAmmo = cfg.startAmmo ?? null;
    this.crateAmmo = cfg.crateAmmo ?? 2;   // сколько даёт ящик
    // Раздел в инвентаре: с четырьмя стволами хватало одного ряда,
    // с дюжиной нужны полки
    this.category = cfg.category ?? 'взрывное';
    // Сколько выстрелов даёт один ход. У дробовика два, ход после первого
    // не заканчивается.
    this.shots = cfg.shots ?? 1;
    // Мгновенное оружие: попадание считается лучом сразу, снаряда нет
    this.instant = cfg.instant ?? false;
    // Сколько секунд даётся на отход после применения. Нужно тому, что
    // кладётся под ноги: иначе ход кончается там же, где лежит заряд.
    this.retreat = cfg.retreat ?? 0;
    // Кадры спрайтшита — предрассчитанные повороты, а не анимация
    this.rotational = cfg.rotational ?? false;

    // Параметры полёта
    this.projectile = Object.assign({
      radius: 4,          // визуальный радиус
      gravityScale: 1,    // множитель к CFG.GRAVITY
      windScale: 1,       // множитель к ветру
      drag: 0,            // экспоненциальное сопротивление воздуха, 1/с
      bounciness: 0,      // 0 = взрывается от удара, >0 = отскакивает
      friction: 0.75,     // касательное трение при отскоке
      fuse: 0,            // сек до самоподрыва (0 = только от удара)
      digRadius: 0,       // >0 — бурит землю вместо взрыва при касании
      digTime: 0,         // сколько секунд бурит
      trail: true,
    }, cfg.projectile);

    // Параметры взрыва
    this.explosion = Object.assign({
      radius: 40,         // радиус воронки в земле
      damageRadius: 70,   // радиус поражения (обычно больше воронки)
      damage: 45,         // урон в эпицентре, дальше линейно спадает
      knockback: 300,     // импульс отбрасывания в эпицентре
      shake: 0.006,
    }, cfg.explosion);
  }

  /** Снаряды, вылетающие при выстреле. Обычно один. */
  fire(scene, x, y, vx, vy, owner) {
    return [new Projectile(scene, x, y, vx, vy, this, owner)];
  }

  /**
   * Реакция на касание земли / истечение фитиля.
   * По умолчанию — взрыв. Может вернуть массив новых снарядов.
   */
  onDetonate(scene, projectile, x, y) {
    scene.explode(x, y, this.explosion, projectile.owner);
    return null;
  }
}

/**
 * Мгновенное оружие: дробовик, бита.
 *
 * Снаряда нет вовсе — попадание считается лучом в тот же кадр. Луч идёт
 * шагами по 2 px и останавливается на первом, что встретит: чужом бойце
 * или земле. Своего стрелка пропускаем — ствол начинается внутри него.
 *
 * Возвращает пустой список снарядов, и это важно: сцена по нему поймёт,
 * что ждать нечего, и сразу перейдёт к разбору хода.
 */
export class InstantWeapon extends Weapon {
  constructor(cfg) {
    super({ ...cfg, instant: true });
    this.range = cfg.range ?? 600;
  }

  fire(scene, x, y, vx, vy, owner) {
    const len = Math.hypot(vx, vy) || 1;
    const dx = vx / len, dy = vy / len;

    let hx = x, hy = y;
    for (let d = 0; d <= this.range; d += 2) {
      hx = x + dx * d;
      hy = y + dy * d;
      if (hx < 0 || hx > scene.terrain.width || hy > scene.terrain.height) break;

      const worm = scene.worms.find(
        (w) => w.alive && w !== owner && w.containsPoint(hx, hy),
      );
      if (worm) break;
      if (scene.terrain.solidAt(hx, hy)) break;
    }

    scene.drawBeam(x, y, hx, hy, this.color);
    this.onBeamHit(scene, hx, hy, dx, dy, owner);
    return [];
  }

  /** Что происходит в точке попадания. По умолчанию — обычный взрыв. */
  onBeamHit(scene, x, y, dx, dy, owner) {
    scene.explode(x, y, this.explosion, owner);
  }
}

/**
 * Бита: земля цела, зато отправляет в полёт.
 *
 * Урон небольшой, весь смысл — в толчке: сбросить соседа в воду стоит
 * дешевле любого снаряда.
 */
export class BatWeapon extends InstantWeapon {
  /**
   * Бита бьёт не лучом, а размахом перед собой.
   *
   * Лучом она почти никогда не попадала: прицел в начале хода стоит на 45°,
   * и тонкая линия уходила соседу над головой. Игрок видел взмах и полное
   * отсутствие последствий. Поэтому цель ищется в секторе перед бойцом —
   * по дальности от него самого и по стороне, куда он повёрнут, — а угол
   * прицела задаёт только направление толчка.
   */
  fire(scene, x, y, vx, vy, owner) {
    const len = Math.hypot(vx, vy) || 1;
    const dx = vx / len, dy = vy / len;
    const side = dx >= 0 ? 1 : -1;
    const ox = owner ? owner.x : x;
    const oy = owner ? owner.centerY : y;

    scene.drawBeam(ox, oy, ox + side * this.range, oy - this.range * 0.3, this.color);

    let hit = 0;
    for (const w of scene.worms) {
      if (!w.alive || w === owner) continue;
      const gapX = (w.x - ox) * side;               // впереди, а не за спиной
      const gapY = Math.abs(w.centerY - oy);
      if (gapX < -6 || gapX > this.range) continue;
      if (gapY > this.range * 0.8) continue;
      // Бьём в сторону удара и вверх — иначе цель просто вжимается в землю
      w.applyImpulse(dx * this.explosion.knockback,
        -Math.abs(this.explosion.knockback) * 0.55);
      w.damage(this.explosion.damage, 'бита');
      hit++;
    }

    scene.fx.explosion(ox + side * 18, oy - 6, hit ? 16 : 8);
    scene.rig.shake(120, 0.003);
    return [];
  }
}

/**
 * Оружие, которое кладут под ноги, а не бросают: динамит, мина.
 *
 * Сила заряда для него не значит ничего — предмет появляется там, где
 * стоит боец, с нулевой скоростью. Точку вылета сцена всё равно посчитает,
 * но мы её игнорируем: иначе динамит улетал бы вперёд на длину ствола.
 */
export class PlacedWeapon extends Weapon {
  fire(scene, x, y, vx, vy, owner) {
    const px = owner ? owner.x : x;
    const py = owner ? owner.centerY : y;
    return [new Projectile(scene, px, py, 0, 0, this, owner)];
  }
}

/**
 * Мина: не снаряд, а предмет на карте.
 *
 * Возвращаем пустой список снарядов — ждать в этом ходу нечего, мина
 * сработает когда-нибудь потом. Сам предмет живёт в списке сцены, рядом
 * с ящиками: список снарядов чистится в конце хода, мина бы не пережила.
 */
export class MineWeapon extends Weapon {
  fire(scene, x, y, vx, vy, owner) {
    scene.addMine(owner ? owner.x : x, owner ? owner.y - 4 : y, this, owner);
    return [];
  }
}

/**
 * Кассетная бомба: взрывается и разбрасывает несколько бомблетов.
 * Пример того, как расширять поведение, не трогая физику.
 */
export class ClusterWeapon extends Weapon {
  constructor(cfg) {
    super(cfg);
    this.clusterCount = cfg.clusterCount ?? 5;
    this.clusterSpeed = cfg.clusterSpeed ?? 260;
    this.bombletWeapon = cfg.bombletWeapon;
  }

  onDetonate(scene, projectile, x, y) {
    scene.explode(x, y, this.explosion, projectile.owner);
    const out = [];
    const spread = Math.PI * 0.62;
    // Разброс бомблетов берём из ГПСЧ хода, а не из Math.random: иначе
    // у двух игроков по сети кассета разлетится по-разному.
    const rng = scene.turnRng;
    for (let i = 0; i < this.clusterCount; i++) {
      const t = this.clusterCount === 1 ? 0.5 : i / (this.clusterCount - 1);
      const a = -Math.PI / 2 - spread / 2 + spread * t;
      const s = this.clusterSpeed * (0.8 + rng() * 0.4);
      out.push(new Projectile(
        scene, x, y - 6,
        Math.cos(a) * s + projectile.vx * 0.15,
        Math.sin(a) * s,
        this.bombletWeapon, projectile.owner,
      ));
    }
    return out;
  }
}

// ------------------------------------------------------- оружие с целью

/**
 * Оружие, которое бьёт не туда, куда летит снаряд, а в точку на карте:
 * авиаудар, телепорт.
 *
 * Отдельного «щёлкни по карте» нет намеренно. Точка выводится из того же
 * выстрела (vx, vy), что и у всего остального оружия: направление — куда
 * смотрит ствол, дальность — сила заряда. Поэтому оно само работает на
 * всех схемах управления (кнопки, свайп, мышь), у бота и в сети — по сети
 * и так уходит ровно этот вектор.
 */
export class TargetedWeapon extends Weapon {
  constructor(cfg) {
    super(cfg);
    this.reach = cfg.reach ?? 1500;     // дальность при полной силе, px
    this.targeted = true;
  }

  /** Сила 0…1 из длины вектора выстрела. */
  powerOf(vx, vy, scene) {
    return Math.min(1, Math.hypot(vx, vy) / CFG.AIM_MAX_POWER);
  }

  /** Куда придётся удар: переопределяют наследники. */
  targetPoint(scene, owner, vx, vy) {
    const p = this.powerOf(vx, vy, scene);
    const side = vx >= 0 ? 1 : -1;
    const ox = owner?.x ?? 0;
    const x = Math.max(40, Math.min(scene.terrain.width - 40, ox + side * p * this.reach));
    return { x, y: scene.terrain.surfaceYAt(Math.round(x), 0) ?? scene.terrain.height };
  }
}

/**
 * Авиаудар: самолёт сбрасывает ракеты на точку впереди. Направление — в
 * какую сторону смотрит ствол, дальность — сила заряда; угол не важен.
 * Ракеты падают почти отвесно, поэтому за холмом от них не спрятаться —
 * в этом и смысл.
 */
export class AirstrikeWeapon extends TargetedWeapon {
  constructor(cfg) {
    super(cfg);
    this.missiles = cfg.missiles ?? 5;
    this.spacing = cfg.spacing ?? 26;
    this.missileWeapon = cfg.missileWeapon;
  }

  fire(scene, x, y, vx, vy, owner) {
    const t = this.targetPoint(scene, owner, vx, vy);
    const side = vx >= 0 ? 1 : -1;
    const out = [];
    const half = (this.missiles - 1) / 2;
    for (let i = 0; i < this.missiles; i++) {
      const k = i - half;
      // Ракеты идут лесенкой по высоте: падают не залпом, а одна за другой
      const mx = t.x + k * this.spacing - side * 40;
      const my = -40 - i * 26;
      out.push(new Projectile(scene, mx, my, side * 60, 420, this.missileWeapon, owner));
    }
    scene.fx?.banner?.('Авиаудар!', '#9fd2ff', 900);
    return out;
  }
}

/**
 * Телепорт: боец исчезает и появляется у точки прицела. Направление —
 * угол ствола, дальность — сила заряда. Встаёт он сразу на опору под этой
 * точкой: появиться в воздухе и разбиться о землю было бы наказанием за
 * то, что прицел смотрел вверх. Точка в земле — поднимаемся до свободного
 * места; под точкой вода — туда и уйдёт, это выбор игрока. Ход на этом
 * кончается.
 */
export class TeleportWeapon extends TargetedWeapon {
  targetPoint(scene, owner, vx, vy) {
    const p = this.powerOf(vx, vy, scene);
    const len = Math.hypot(vx, vy) || 1;
    const ox = owner?.x ?? 0;
    const oy = owner?.y ?? 0;
    const W = scene.terrain.width;
    let x = Math.round(Math.max(20, Math.min(W - 20, ox + (vx / len) * p * this.reach)));
    let y = Math.round(Math.max(40, Math.min(scene.terrain.height - 4, oy + (vy / len) * p * this.reach)));
    // Не в земле: шагаем вверх, пока туловище не окажется на свободе
    const clear = (cx, cy) => (owner ? owner.bodyClear(cx, cy) : !scene.terrain.solidAt(cx, cy));
    let lift = 0;
    while (!clear(x, y) && lift < 400) { y -= 2; lift += 2; }
    if (!clear(x, y)) y = 40;
    // Вниз до опоры: ноги на землю, а не в воздух
    const H = scene.terrain.height;
    const supported = (cx, cy) => (owner ? owner.supported(cx, cy) : scene.terrain.solidAt(cx, cy + 1));
    while (y < H - 2 && !supported(x, y) && clear(x, y + 1)) y++;
    return { x, y, water: y >= CFG.DROWN_Y };
  }

  fire(scene, x, y, vx, vy, owner) {
    if (!owner) return [];
    const t = this.targetPoint(scene, owner, vx, vy);
    scene.fx?.warp?.(owner.x, owner.centerY, false);
    owner.x = t.x;
    owner.y = t.y;
    owner.vx = 0;
    owner.vy = 0;
    owner.grounded = false;
    owner.fallStartY = t.y;      // встал на опору — падать неоткуда
    scene.fx?.warp?.(owner.x, owner.centerY, true);
    return [];
  }
}
