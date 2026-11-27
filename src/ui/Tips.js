import { CFG, DEPTH } from '../config.js';
import { font } from './theme.js';
import { haptic } from '../platform/telegram.js';

/**
 * Подсказки «один раз»: жёлтая карточка под верхней панелью боя.
 *
 * Каждая подсказка показывается игроку один раз на устройстве (id в
 * localStorage). Несколько сразу — по очереди. Карточка уходит по тапу
 * («Понятно») или сама через несколько секунд. Касание карточки не
 * стреляет и не двигает камеру: она в списке зон интерфейса HUD.
 *
 * Где какие: первая дуэль (повтор, свой ход, ход отправлен, итог) и новые
 * правила боя (трос и шаги, взвод ракеты, «Окопаться») — GameScene.
 */
const KEY = 'worms.tips.v1';
const SHOW_MS = 7000;

function seenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]')); } catch { return new Set(); }
}

function markSeen(id) {
  const s = seenSet();
  s.add(id);
  try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* инкогнито */ }
}

/** Отметить подсказки показанными (тренировка уже научила). */
export function markTipsSeen(ids) {
  for (const id of ids) markSeen(id);
}

/** Видел ли игрок подсказку (для проверок снаружи). */
export function tipSeen(id) { return seenSet().has(id); }

export class Tips {
  constructor(scene) {
    this.scene = scene;
    this.queue = [];
    this.cur = null;
    this.asked = new Set();
  }

  /** Показать один раз: уже видел или уже в очереди — ничего. */
  show(id, text) {
    if (this.asked.has(id) || tipSeen(id)) return;
    this.asked.add(id);
    this.queue.push({ id, text });
    if (!this.cur) this._next();
  }

  get busy() { return Boolean(this.cur) || this.queue.length > 0; }

  _next() {
    this._clear();
    const t = this.queue.shift();
    if (!t) return;
    const s = this.scene;
    markSeen(t.id);
    const W = CFG.VIEW_W;
    const hud = s.hud;
    const top = (hud?.strip ? hud.strip.y + hud.strip.r + 14 : 120);
    const w = Math.min(W - 40, 640), x = (W - w) / 2;
    const fix = (o, d) => s.rig.ui(o.setScrollFactor(0).setDepth(d));
    const body = fix(s.add.text(x + 20, top + 16, t.text, font(22, 800, '#1a1408'))
      .setWordWrapWidth(w - 150), DEPTH.HUD + 13);
    const h = Math.max(70, body.height + 32);
    const g = fix(s.add.graphics(), DEPTH.HUD + 12);
    g.fillStyle(0xffe27a, 0.97).fillRoundedRect(x, top, w, h, 16);
    g.lineStyle(3, 0x1a1408, 0.9).strokeRoundedRect(x, top, w, h, 16);
    const ok = fix(s.add.text(x + w - 18, top + h / 2, 'Понятно', font(20, 900, '#3a7a1e')).setOrigin(1, 0.5), DEPTH.HUD + 13);
    const zone = fix(s.add.zone(x, top, w, h).setOrigin(0, 0).setInteractive({ useHandCursor: true }), DEPTH.HUD + 14);
    zone.on('pointerdown', () => { haptic('tap'); this._next(); });
    const rect = { x, y: top, w, h };
    hud?.uiRects?.push(rect);
    const parts = [g, body, ok, zone];
    for (const o of parts) o.setAlpha(0);
    s.tweens.add({ targets: parts, alpha: 1, duration: 180 });
    s.fx?.sound?.('select');
    const timer = s.time.delayedCall(SHOW_MS + t.text.length * 25, () => { if (this.cur?.timer === timer) this._next(); });
    this.cur = { parts, rect, timer };
  }

  _clear() {
    if (!this.cur) return;
    const { parts, rect, timer } = this.cur;
    timer?.remove?.();
    for (const o of parts) o.destroy();
    const r = this.scene.hud?.uiRects;
    if (r) { const i = r.indexOf(rect); if (i >= 0) r.splice(i, 1); }
    this.cur = null;
  }

  destroy() {
    this.queue = [];
    this._clear();
  }
}
