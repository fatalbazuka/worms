import { CFG, DEPTH } from '../config.js';
import { has, fitScale } from '../core/assets.js';
import { Projectile } from './Projectile.js';
import { Weapon } from '../weapons/Weapon.js';

/**
 * Монстры кампании «Подъём»: слизень, кактус-мина и босс-великан.
 *
 * Монстр — не боец и не команда. Он ни за кого не играет, в очереди ходов
 * не стоит и победу не решает (кроме босса: его убить — и есть победа).
 * Ходят монстры между ходами бойцов: когда ход отыгран и всё затихло,
 * сцена зовёт act() у каждого (TurnManager, «ход монстров»), ждёт, пока
 * они закончат, и только потом передаёт очередь.
 *
 *   слизень — ползёт к ближайшему бойцу по полу (на стену не лезет) и,
 *             доползя, лопается: небольшой взрыв. Хватает одного попадания;
 *   кактус  — стоит. Кто в него врежется — колется и отлетает. Подорвали —
 *             взрывается сам, задевая соседей;
 *   босс    — большой злой смайлик на вершине: каждый ход швыряет камень в
 *             ближайшего бойца, каждый третий — зовёт двух слизней.
 *
 * Всё решается положением и детерминированной физикой, без случайности:
 * сеть монстрам не нужна (кампания одиночная), но повтор боя одинаков.
 * Урон от взрывов монстрам считает сцена (explode → hurtMonsters).
 */

const KINDS = {
  slime: { hp: 30, w: 30, h: 22, image: 'mon_slime', size: 38, name: 'Слизень' },
  cactus: { hp: 40, w: 30, h: 46, image: 'emoji_cactus', size: 60, name: 'Кактус' },
  boss: { hp: 400, w: 96, h: 100, image: 'emoji_ogre', size: 132, name: 'Великан' },
};

const SLIME_STEP = 95;          // сколько проползает за ход монстров, px
const SLIME_SPEED = 90;         // px/с
const SLIME_BURST = { radius: 20, damageRadius: 54, damage: 28, knockback: 260, shake: 0.004 };
const CACTUS_BURST = { radius: 30, damageRadius: 70, damage: 34, knockback: 320, shake: 0.007 };
const CACTUS_PRICK = 10;

/** Камень босса: тяжёлый, ветер его почти не сносит. Не в арсенале игрока. */
export const ROCK = new Weapon({
  id: 'rock', name: 'Камень', color: 0x8a7a66,
  projectile: { radius: 9, windScale: 0.15, gravityScale: 1 },
  explosion: { radius: 38, damageRadius: 76, damage: 34, knockback: 330, shake: 0.008 },
});

export class Monster {
  constructor(scene, kind, x, y, hp = null) {
    this.scene = scene;
    this.terrain = scene.terrain;
    this.kind = kind;
    const k = KINDS[kind];
    this.def = k;
    this.x = x;
    this.y = y;             // ноги
    this.vx = 0; this.vy = 0;
    this.hp = hp ?? k.hp;
    this.maxHp = this.hp;
    this.alive = true;
    this.facing = -1;
    this.busy = false;      // ещё делает свой ход
    this.walkLeft = 0;
    this.acts = 0;
    this.cool = new Map();

    if (has(scene, k.image)) {
      const sheet = scene.textures.get(k.image).frameTotal > 2;
      this.view = sheet
        ? scene.add.sprite(x, y, k.image, 0).setOrigin(0.5, 0.92)
        : scene.add.image(x, y, k.image).setOrigin(0.5, 1);
      this.view.setScale(sheet ? k.size / 100 : fitScale(scene, k.image, k.size));
      if (sheet && scene.anims.exists(`${k.image}_idle`)) this.view.play(`${k.image}_idle`);
    } else {
      this.view = scene.add.ellipse(x, y - k.h / 2, k.w, k.h, kind === 'cactus' ? 0x4caf50 : 0x8bd34a);
    }
    this.baseScale = this.view.scaleX;
    scene.rig.world(this.view.setDepth(DEPTH.WORM));

    // Полоска здоровья у тех, кого надо добивать в несколько попаданий
    if (k.hp >= 40) {
      this.barBg = scene.rig.world(scene.add.rectangle(x, y - k.h - 6, 52, 6, 0x101420, 0.85)
        .setDepth(DEPTH.WORM + 1));
      this.bar = scene.rig.world(scene.add.rectangle(x - 25, y - k.h - 6, 50, 4, 0xff6b6b)
        .setOrigin(0, 0.5).setDepth(DEPTH.WORM + 2));
    }
  }

  get top() { return this.y - this.def.h; }
  get centerY() { return this.y - this.def.h / 2; }
  get name() { return this.def.name; }

  containsPoint(px, py) {
    const hw = this.def.w / 2;
    return px >= this.x - hw && px <= this.x + hw && py >= this.top && py <= this.y;
  }

  /** Ход монстра. Возвращает, начал ли он что-то делать. */
  act() {
    if (!this.alive) return false;
    this.acts += 1;
    if (this.kind === 'slime') {
      const t = this._nearest();
      if (!t) return false;
      this.facing = t.x >= this.x ? 1 : -1;
      this.walkLeft = SLIME_STEP;
      this.busy = true;
      return true;
    }
    if (this.kind === 'boss') return this._bossAct();
    return false;
  }

  _nearest() {
    let best = null, bd = Infinity;
    for (const w of this.scene.worms) {
      if (!w.alive) continue;
      const d = Math.hypot(w.x - this.x, w.centerY - this.centerY);
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }

  _bossAct() {
    const t = this._nearest();
    if (!t) return false;
    // Каждый третий ход — подмога: по слизню с каждой стороны
    if (this.acts % 3 === 0) {
      for (const dx of [-70, 70]) {
        const x = Math.max(40, Math.min(this.terrain.width - 40, this.x + dx));
        this.scene.addMonster('slime', x, this.y - 30);
      }
      this.scene.fx.banner('Великан зовёт слизней!', '#b4f08a', 1400);
    }
    // Камень навесом: угол 55°, скорость — чтобы долететь до цели без учёта
    // земли и ветра. Мажет ровно настолько, насколько мешают этажи
    const dx = t.x - this.x - Math.sign(t.x - this.x) * (this.def.w / 2 + 14);
    const dy = t.centerY - (this.top - 14);
    const ang = (55 * Math.PI) / 180;
    const g = CFG.GRAVITY;
    const cos = Math.cos(ang), tan = Math.tan(ang);
    const dist = Math.max(20, Math.abs(dx));
    const denom = 2 * cos * cos * (dist * tan + dy);
    const v = denom > 0 ? Math.min(1100, Math.sqrt((g * dist * dist) / denom)) : 700;
    const dir = dx >= 0 ? 1 : -1;
    this.facing = dir;
    // Камень вылетает из-за плеча, снаружи самого Великана
    const p = new Projectile(this.scene, this.x + dir * (this.def.w / 2 + 14), this.top - 14,
      dir * v * cos, -v * Math.sin(ang), ROCK, null);
    this.scene.projectiles.push(p);
    this.view.setScale(this.baseScale * 1.08);
    this.scene.tweens.add({ targets: this.view, scale: this.baseScale, duration: 260 });
    this.scene.fx.sound('shot');
    return true;
  }

  damage(amount) {
    if (!this.alive || amount <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this.scene.fx.damageNumber(this.x, this.centerY - 10, amount);
    this.view.setTintFill?.(0xffffff);
    this.scene.time.delayedCall(90, () => { if (this.alive) this.view.clearTint?.(); });
    if (this.hp <= 0) this.die();
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    this.busy = false;
    const { x } = this;
    const y = this.centerY;
    this.destroyView();
    if (this.kind === 'cactus') this.scene.explode(x, y, CACTUS_BURST, null);
    else if (this.kind === 'slime') this.scene.fx.splash?.(x, this.y);
    else if (this.kind === 'boss') {
      this.scene.fx.banner('Великан повержен!', '#ffe27a', 2000);
      this.scene.explode(x, y, { radius: 50, damageRadius: 0, damage: 0, knockback: 0, shake: 0.014 }, null);
    }
    this.scene.onMonsterDied?.(this);
  }

  /** Шаг физики: падение, ползание слизня, уколы кактуса. */
  update(dt) {
    if (!this.alive) return;
    const supported = this.terrain.solidInRow(this.x - 6, this.x + 6, this.y + 1);
    if (!supported || this.vy < 0) {
      this.vy = Math.min(this.vy + CFG.GRAVITY * dt, 900);
      const ny = this.y + this.vy * dt;
      const ray = this.terrain.raycast(this.x, this.y, this.x, ny);
      if (ray.hit && this.vy > 0) { this.y = ray.freeY; this.vy = 0; } else this.y = ny;
      if (this.y > CFG.DROWN_Y) {
        this.scene.fx.splash?.(this.x, CFG.WATER_Y);
        this.die();
        return;
      }
    } else if (this.kind === 'slime' && this.walkLeft > 0) {
      this._crawl(dt);
    } else if (this.busy && this.kind === 'slime') {
      this.busy = false;
    }

    if (this.kind === 'slime') this._checkBurst();
    if (this.kind === 'cactus') this._prick(dt);
    this._sync();
  }

  _crawl(dt) {
    const step = Math.min(this.walkLeft, SLIME_SPEED * dt);
    this.walkLeft -= step;
    const nx = this.x + this.facing * step;
    // Ступеньку до 8 px берёт, в стену упирается — ход окончен
    let ny = null;
    for (let up = 0; up <= 8; up++) {
      if (!this.terrain.solidAt(nx, this.y - up) && !this.terrain.solidAt(nx, this.y - this.def.h + 4 - up)) {
        ny = this.y - up; break;
      }
    }
    if (ny === null) { this.walkLeft = 0; return; }
    this.x = nx; this.y = ny;
    // Чуть пружинит на ходу
    this.view.scaleY = this.baseScale * (0.9 + 0.1 * Math.abs(Math.sin(this.x / 9)));
    if (this.walkLeft <= 0) this.busy = false;
  }

  _checkBurst() {
    for (const w of this.scene.worms) {
      if (!w.alive) continue;
      if (Math.abs(w.x - this.x) < 26 && Math.abs(w.y - this.y) < 26) {
        const { x } = this;
        const y = this.centerY;
        this.alive = false;
        this.busy = false;
        this.destroyView();
        this.scene.explode(x, y, SLIME_BURST, null);
        this.scene.onMonsterDied?.(this);
        return;
      }
    }
  }

  _prick(dt) {
    for (const [w, t] of this.cool) {
      if (t - dt <= 0) this.cool.delete(w); else this.cool.set(w, t - dt);
    }
    for (const w of this.scene.worms) {
      if (!w.alive || this.cool.has(w)) continue;
      if (Math.abs(w.x - this.x) < (this.def.w / 2 + 10) && w.y > this.top && w.y - CFG.WORM_H < this.y) {
        this.cool.set(w, 1.2);
        const dir = w.x >= this.x ? 1 : -1;
        w.damage(CACTUS_PRICK, 'кактус');
        w.applyImpulse(dir * 260, -220);
        this.scene.fx.pickup?.(this.x, this.top - 10, 'ай!', '#ff9a9a');
      }
    }
  }

  _sync() {
    if (!this.view?.active) return;
    this.view.setPosition(Math.round(this.x), Math.round(this.y));
    if (this.view.setFlipX) this.view.setFlipX(this.facing > 0);
    if (this.bar) {
      this.barBg.setPosition(this.x, this.top - 10);
      this.bar.setPosition(this.x - 25, this.top - 10);
      this.bar.width = 50 * (this.hp / this.maxHp);
    }
  }

  destroyView() {
    this.view?.destroy();
    this.barBg?.destroy();
    this.bar?.destroy();
  }
}
