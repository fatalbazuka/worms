import { CFG, DEPTH } from '../config.js';
import { font } from './theme.js';
import { tr } from '../i18n/index.js';

/**
 * След прошлого выстрела и числа прицела — подсказка, а не новое управление.
 *
 * Слепые игроки промахивались и не понимали, как поправить выстрел: дуга
 * исчезала вместе со снарядом. Теперь после своего выстрела остаётся
 * бледный пунктир настоящего полёта и «×» там, где он кончился, — виден в
 * следующий ход того же бойца. Рядом с бойцом, пока целишься, — угол и
 * сила числами, а сбоку прошлые: «прошлый: 37° · 72%». Только у своего
 * игрока на этом устройстве: ни боту, ни сопернику по сети это не нужно.
 */

/** Дальше этого боец ушёл — старая дуга про другое место, убираем. */
const MOVED_FAR = 140;
/** Точек следа не больше: долгий полёт попрыгунчика не раздувает память. */
const MAX_POINTS = 400;

/** Угол в градусах над горизонтом (вниз — минус) и сила в процентах. */
export function aimNumbers(vx, vy) {
  const speed = Math.hypot(vx, vy);
  return {
    deg: Math.round((Math.atan2(-vy, Math.abs(vx)) * 180) / Math.PI),
    pct: Math.round(Math.min(1, speed / CFG.AIM_MAX_POWER) * 100),
  };
}

/** Род оружия: сменил базуку на гранату — та же дуга, сменил на биту — уже нет. */
const kindOf = (weapon) => weapon?.category ?? 'взрывное';

export class ShotTrace {
  constructor(scene) {
    this.scene = scene;
    this.last = null;       // { worm, x0, y0, kind, deg, pct, points, land }
    this.live = null;       // снаряд, за которым пишем след
    this.gfx = scene.rig.world(scene.add.graphics().setDepth(DEPTH.AIM - 1));
    this.label = scene.rig.world(scene.add.text(0, 0, '', font(15, 800, '#e8f0ff'))
      .setOrigin(0.5, 0).setDepth(DEPTH.AIM + 1).setVisible(false));
    this.label.setStroke('#10131a', 4);
  }

  /** Свой выстрел ушёл: начинаем писать след первого снаряда. */
  onFire(worm, vx, vy, shots, weapon) {
    const p = shots?.[0];
    // Авиаудар и телепорт летят не из ствола — их «дугу» показывать незачем
    if (!p || weapon?.targeted) { this.last = null; this.live = null; return; }
    const n = aimNumbers(vx, vy);
    this.live = p;
    this.last = {
      worm, x0: worm.x, y0: worm.y, kind: kindOf(weapon), deg: n.deg, pct: n.pct,
      points: [{ x: p.x, y: p.y }], land: null,
    };
  }

  /** Сейчас целится свой игрок на этом устройстве (не бот, не соперник по сети). */
  _myAim() {
    const s = this.scene;
    return s.turn.state === 'aim' && !s.replaying && !s.isBotTurn() && s.canPlayerAct();
  }

  /** Текущие угол и сила прицела, если их уже задали. */
  _current() {
    const s = this.scene;
    if (s.aim?.mode === 'aim') {
      const shot = s.aim.computeShot();
      return shot ? aimNumbers(shot.vx, shot.vy) : null;
    }
    // Кнопки и ПК: угол есть всегда, сила — пока держат «Огонь»
    if (!s.slingAim || s.charging || s.aim?.desktop) {
      const deg = Math.round((s.aimAngle * 180) / Math.PI);
      return { deg, pct: s.charging ? Math.round(s.charge * 100) : null };
    }
    return null;
  }

  update() {
    const s = this.scene;
    const p = this.live;
    if (p) {
      const pts = this.last.points;
      if (p.alive) {
        const q = pts[pts.length - 1];
        if (Math.hypot(p.x - q.x, p.y - q.y) > 6 && pts.length < MAX_POINTS) pts.push({ x: p.x, y: p.y });
      } else {
        this.last.land = { x: p.x, y: p.y };
        pts.push({ x: p.x, y: p.y });
        this.live = null;
      }
    }
    this.gfx.clear();
    const w = s.turn.activeWorm;
    if (!w || !this._myAim()) { this.label.setVisible(false); return; }
    const last = this.last;
    // Боец ушёл далеко или взял оружие другого рода — прошлый след про другое
    if (last && last.worm === w && !this.live
      && (Math.hypot(w.x - last.x0, w.y - last.y0) > MOVED_FAR || kindOf(s.turn.weapon) !== last.kind)) {
      this.last = null;
    }
    const mine = this.last && this.last.worm === w && !this.live ? this.last : null;
    if (mine) this._drawTrace(mine);
    this._drawNumbers(w, mine);
  }

  _drawTrace(t) {
    const g = this.gfx;
    const zoom = this.scene.rig.zoom || 1;
    // Пунктир: точка каждые ~16 px пути, одинаковая на любом приближении
    g.fillStyle(0xffffff, 0.42);
    let acc = 0;
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1], b = t.points[i];
      acc += Math.hypot(b.x - a.x, b.y - a.y);
      if (acc >= 16) { acc = 0; g.fillCircle(b.x, b.y, 2.4 / zoom); }
    }
    if (t.land) {
      const r = 9 / zoom;
      g.lineStyle(3 / zoom, 0xff8a8a, 0.75);
      g.lineBetween(t.land.x - r, t.land.y - r, t.land.x + r, t.land.y + r);
      g.lineBetween(t.land.x + r, t.land.y - r, t.land.x - r, t.land.y + r);
    }
  }

  /** «37° · 72%» под бойцом, сбоку — прошлый выстрел. */
  _drawNumbers(w, last) {
    const cur = this._current();
    const parts = [];
    if (cur) parts.push(cur.pct == null ? `${cur.deg}°` : `${cur.deg}° · ${cur.pct}%`);
    // Целиком строка в словарь не ляжет (числа с « · »): переводим одно слово
    if (last) parts.push(`${tr('прошлый')}: ${last.deg}° · ${last.pct}%`);
    if (!parts.length) { this.label.setVisible(false); return; }
    const zoom = this.scene.rig.zoom || 1;
    this.label.setText(parts.join('   '))
      .setPosition(w.x, w.y + 8 / zoom)
      .setScale(1 / zoom)
      .setVisible(true);
  }

  destroy() {
    this.gfx.destroy();
    this.label.destroy();
  }
}
