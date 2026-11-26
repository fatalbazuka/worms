import { captureState, applyState, applyCommand, applyMove, mixAmmo } from './protocol.js';
import { towerMatch } from '../core/match.js';
import { STATE } from '../core/TurnManager.js';
import { CFG } from '../config.js';
import { fetchDuel, sendDuelTurn, ApiError } from './server.js';

/**
 * Дуэль по переписке на стороне игры (сервер — server/duels.mjs).
 *
 * Сессия притворяется сетевой (те же поля, что у NetSession), поэтому вся
 * сетевая логика сцены работает как есть: в чужой ход ходить нельзя,
 * очередь двигает тот, кто ходил, чужой выстрел показывается приказом, а
 * итог берётся из снимка.
 *
 * Открыли дуэль — партия собирается с нуля:
 *   1. сцена строится с зерна дуэли — карта, бойцы, первый ход у всех одни;
 *   2. ходы из истории накатываются мгновенно — снимок за снимком, пропуск
 *      — просто передача очереди (как «время вышло» без единого действия);
 *   3. последний ход соперника показывается по приказам в обычном темпе —
 *      «повтор хода соперника», — и в конце приходит его снимок;
 *   4. дальше ходит игрок: всё, что он делает (шаги, трос, оружие, прицел,
 *      выстрел), пишется со временем от начала хода — это те же сообщения,
 *      что онлайн шлёт сопернику, — а когда ход затих, на сервер уходят
 *      приказы и снимок итога.
 *
 * Почему не одни приказы: физика идёт по кадровой дельте, и на другом
 * телефоне тот же выстрел ляжет чуть иначе (так же и в онлайне,
 * net/protocol.js). Снимок — истина, приказы — картинка.
 *
 * Свёртка (turnHash) — после каждого хода: у ходившего — по живой партии,
 * у восстановившего — по собранной из истории. Не совпало — пишем в
 * консоль и на сервер (prevHash со следующим ходом) и играем дальше по
 * истории сервера: она одна на двоих, и земля каждый раз собирается из неё
 * заново, так что расхождение не копится от хода к ходу.
 */

/** Описание партии для сцены: башня, как в онлайне, своё зерно. */
/**
 * Дуэль — та же башня, но ход длиннее: никто не ждёт за экраном, а
 * открывают её между делом — осмотреться, пройти, прицелиться.
 */
export const DUEL_TURN_TIME = 60;

export function duelMatch(duel) {
  const m = towerMatch(null);
  // Арсенал боя — в дуэлях по новым правилам (сервер: duel.rules >= 2):
  // начатая раньше доигрывается без него, её патроны уже в истории ходов
  return {
    ...m, mode: 'duel', seed: duel.seed, duelId: duel.id,
    rules: { ...m.rules, turnTime: DUEL_TURN_TIME, loadout: (duel.rules ?? 1) >= 2 },
  };
}

/** Самые длинные паузы в повторе чужого хода: думал он долго, смотреть — нет. */
const MAX_GAP = 1200;
/** Дорога до выстрела в повторе — не дольше этого, мс. */
const SHOW_MAX = 8000;
/** Шагов в записи хода не больше — иначе ход не влезет в запрос. */
const MAX_MOVES = 160;
const POLL_MS = 10_000;

// ------------------------------------------------------------- свёртка

/**
 * Свёртка итога хода: очередь, ветер, бойцы (координаты и здоровье по
 * целым), патроны, ящики, мины, батуты и земля. Земля — не только верхняя
 * кромка (terrain.hash), но и этажи: по каждому восьмому столбцу — где
 * твердь сменяется пустотой, первые восемь раз сверху.
 */
export function turnHash(scene) {
  const s = captureState(scene);
  let h = 2166136261;
  const mix = (n) => { h ^= n | 0; h = Math.imul(h, 16777619); };
  mix(s.turn); mix(s.team); mix(s.worm); mix(s.wind); mix(s.over ? 1 : 0);
  for (const w of s.worms) { mix(w.x); mix(w.y); mix(w.hp); mix(w.alive ? 1 : 0); }
  for (const row of s.ammo) mixAmmo(mix, row);
  for (const c of s.crates) { mix(c.x); mix(c.y); mix(c.weapon ?? -1); }
  for (const m of s.mines) { mix(m.x); mix(m.y); mix(m.armed ? 1 : 0); }
  for (const sp of s.springs) { mix(sp.x); mix(sp.y); mix(sp.uses ?? -1); }
  const t = scene.terrain;
  for (let x = 4; x < t.width; x += 8) {
    let was = 0, flips = 0;
    for (let y = 0; y < t.height && flips < 8; y++) {
      const v = t.solid[y * t.width + x];
      if (v !== was) { mix(y); was = v; flips++; }
    }
  }
  return (h >>> 0).toString(16);
}

// ------------------------------------------------------- память устройства

const KEY = 'worms.duels.v1';

function readStore() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return v && typeof v === 'object' ? { rewarded: [], stats: {}, pending: {}, ...v } : { rewarded: [], stats: {}, pending: {} };
  } catch { return { rewarded: [], stats: {}, pending: {} }; }
}

function writeStore(st) {
  st.rewarded = st.rewarded.slice(-100);
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* инкогнито */ }
}

/** Ход, который не дошёл до сервера: отправим при следующем открытии. */
export function pendingTurn(id) { return readStore().pending[id] ?? null; }

function setPending(id, payload) {
  const st = readStore();
  if (payload) st.pending[id] = payload; else delete st.pending[id];
  writeStore(st);
}

/**
 * Сервер ход рассмотрел и отказал — слать его снова незачем. Сюда не
 * входят 401 (сессия истекла — после входа уйдёт), 408 и 429 (подождать):
 * раньше на них ход выбрасывался, как будто его отвергли.
 */
function refused(e) {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
}

/** Дослать ходы, которые не дошли (оборвалась сеть, закрыли игру). */
export async function flushPendingTurns() {
  const st = readStore();
  for (const [id, payload] of Object.entries(st.pending)) {
    try {
      await sendDuelTurn(id, payload);
      setPending(id, null);
    } catch (e) {
      // Сервер ход знает и не примет (не тот ход, дуэль окончена) — забываем
      if (refused(e)) setPending(id, null);
    }
  }
}

// --------------------------------------------------------------- сессия

export class DuelSession {
  constructor(duel) {
    this.duel = duel;
    this.isDuel = true;
    this.myTeam = duel.me;
    const o = duel.opponent;
    this.opponent = { id: o?.id ?? null, name: o?.name ?? 'Соперник', rating: 1000, skin: o?.skin ?? null, cos: null };
    this.paired = true;
    this.synced = true;
    this.sceneReady = true;
    this.ready = false;        // история ещё не восстановлена — ходить нельзя
    this.phase = 'replay';     // replay | play | sent | wait | over
    this.rec = null;           // запись своего хода
    this.started = false;      // игрок начал ход — до этого часы хода стоят
    this.showing = false;      // идёт показ хода — его можно пропустить
    this.skip = false;
    this._skipped = new Promise((resolve) => { this._skipNow = resolve; });
    this.prevHash = null;      // свёртка после последнего восстановленного хода
    this.prevTurn = null;      // и какой это был ход
    this.checks = [];          // [{n, mine, theirs}] — для тестов и отладки
    this.onPhase = null;       // сцена подписывается: показать «ход отправлен»
    // «Пересмотреть ход»: последний ход показывается заново, даже если он свой
    this.forceShow = Boolean(duel.replayLast);
  }

  /** Есть что пересмотреть, и это не сотрёт начатый ход. */
  get canRewatch() {
    if (!(this.duel.turns ?? []).length) return false;
    // Свой ход: пересмотреть можно, пока к нему не притронулся (часы ещё
    // стоят). Начал ходить — кнопки нет: она внизу, ровно там, куда тянут
    // рычаг прицела, и отпускание над ней сбрасывало ход в повтор соперника
    if (this.phase === 'play') return !this.started;
    return this.phase === 'wait' || this.phase === 'sent' || this.phase === 'over';
  }

  get connected() { return true; }
  get peerLost() { return false; }
  get peerSilence() { return 0; }
  get myTurn() { return this.scene?.turn.currentTeam === this.myTeam; }

  requestSync() { return false; }
  sendEmote() {}
  wantRematch() {}
  forget() {}
  destroy() { this.dead = true; }

  /** Сцена готова: восстанавливаем партию. */
  attach(scene) {
    this.scene = scene;
    this._loadStats();
    this._wait(250).then(() => this.replay());
  }

  /**
   * Пауза по настоящим часам, а не по часам сцены: на слабом телефоне
   * Phaser под нагрузкой отдаёт ровные 16 мс на кадр, и секунда повтора
   * растянулась бы на минуту. Сессию закрыли — ожидание просто не кончится.
   */
  _wait(ms) {
    return new Promise((resolve) => {
      if (this.dead) return;
      setTimeout(() => { if (!this.dead) resolve(); }, ms);
    });
  }

  async _until(fn, timeout) {
    const t0 = performance.now();
    while (!fn() && !this.skip && performance.now() - t0 < timeout) await this._wait(100);
  }

  /** Пауза внутри повтора: «Пропустить» обрывает её сразу. */
  _pause(ms) {
    if (this.skip) return Promise.resolve();
    return Promise.race([this._wait(ms), this._skipped]);
  }

  /** «Пропустить повтор»: остаток хода — сразу итогом, без показа. */
  skipShow() {
    if (!this.showing || this.skip) return;
    this.skip = true;
    this._skipNow?.();
  }

  _setPhase(p) {
    this.phase = p;
    this.onPhase?.(p);
  }

  // ---------------------------------------------------------- восстановление

  async replay() {
    const s = this.scene;
    const turns = this.duel.turns ?? [];
    const last = turns.at(-1);
    // Последний ход соперника — показом; всё, что до него, — мгновенно
    const show = Boolean(last && (last.team !== this.myTeam || this.forceShow));
    s.fastForward = true;
    for (const t of show ? turns.slice(0, -1) : turns) this._applyInstant(t);
    s.fastForward = false;
    if (show && s.turn.state !== STATE.OVER) await this._show(last);
    else if (show) this._applyInstant(last);
    if (this.dead) return;
    this._settle();
  }

  /** Ход из истории — сразу итогом: снимок или передача очереди. */
  _applyInstant(t) {
    const s = this.scene;
    if (t.kind === 'skip') { this._pass(); return; }
    if (!t.state) return;
    s.explosionHistory.push(...(t.state.explosions ?? []));
    applyState(s, t.state);
    // Заморозка снежком в снимок онлайна не входит, а пропуск хода от неё зависит
    (t.state.frozen ?? []).forEach((f, i) => { if (s.worms[i]) s.worms[i].frozen = Boolean(f); });
    if (t.state.over && s.turn.state !== STATE.OVER) {
      const winner = s.checkVictory();
      s.turn._gameOver(winner ?? this.duel.winner ?? -1);
    }
    this._check(t);
  }

  /** Пропуск: очередь дальше, как будто время хода вышло без единого действия. */
  _pass() {
    const s = this.scene;
    if (s.turn.state === STATE.OVER) return;
    s.turn.next();
    s.explosionLog = [];
  }

  _check(t) {
    if (!t.hash) return;
    const mine = turnHash(this.scene);
    this.prevHash = mine;
    this.prevTurn = t.n;
    this.checks.push({ n: t.n, mine, theirs: t.hash });
    if (mine !== t.hash) {
      console.warn('[duel] состояние разошлось', `ход ${t.n}`, mine, '!=', t.hash);
      this.scene.onDuelDiverge?.(t.n);
    }
  }

  /** Повтор хода соперника: его шаги, трос, прицел и выстрел — в обычном темпе. */
  async _show(t) {
    const s = this.scene;
    const own = t.team === this.myTeam;
    s.fx.banner(t.kind === 'skip' ? `${own ? 'Ты не успел' : `${this.opponent.name} не успел`} — ход пропущен`
      : own ? 'Повтор твоего хода' : 'Повтор хода соперника', '#ffd166', 1800);
    s.followTarget = s.turn.activeWorm;
    this.showing = true;
    await this._pause(t.kind === 'skip' ? 1400 : 700);
    if (t.kind === 'skip') { this.showing = false; this._pass(); return; }
    const cmds = (t.cmds ?? []).slice().sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    let at = cmds[0]?.at ?? 0;
    let shot = false;
    // Соперник мог ходить минуту — смотреть это минуту незачем: дорога до
    // выстрела сжимается до SHOW_MAX, сам выстрел идёт в обычном темпе
    const gaps = cmds.map((c, i) => (i ? Math.max(0, Math.min(MAX_GAP, (c.at ?? 0) - (cmds[i - 1].at ?? 0))) : 0));
    const firstShot = cmds.findIndex((c) => c.k === 'shot');
    const walk = gaps.slice(0, firstShot < 0 ? gaps.length : firstShot + 1).reduce((a, b) => a + b, 0);
    const speed = walk > SHOW_MAX ? SHOW_MAX / walk : 1;
    let last = null;     // последний показанный шаг: от него ведём к следующему
    for (const [i, c] of cmds.entries()) {
      if (this.dead) return;
      if (this.skip) break;
      const gap = gaps[i] * (firstShot < 0 || i <= firstShot ? speed : 1);
      at = c.at ?? at;
      if (c.k === 'move' && last && gap > 40 && smoothable(last, c.m)) {
        // Шаги записаны раз в 150 мс: показывать их как есть — боец прыгал
        // рывками. Ведём его между записями кадр за кадром (~30 в секунду)
        // По настоящим часам: на медленном телефоне кадров меньше, но
        // длительность та же — повтор не растягивается
        const t0 = performance.now();
        for (;;) {
          await this._pause(16);
          if (this.skip || this.dead) break;
          const k = (performance.now() - t0) / gap;
          if (k >= 1) break;
          applyMove(s, lerpMove(last, c.m, k));
        }
      } else if (gap > 16) await this._pause(gap);
      if (this.skip) break;
      if (c.k === 'move') { applyMove(s, c.m); last = c.m; }
      else if (c.k === 'shot') shot = applyCommand(s, c.cmd) || shot;
      else if (c.k === 'split') s.remoteSplit?.({ turn: c.turn, t: c.t });
    }
    // Дождаться, пока у нас всё долетит и уляжется, — не дольше 15 секунд
    if (shot) {
      await this._until(() => s.turn.state === STATE.RESOLVE && s.projectiles.length === 0
        && s.turn.resolveTimer >= CFG.RESOLVE_SETTLE && s.worms.every((w) => w.settled), 15000);
    }
    if (!this.skip) await this._wait(400);
    this.showing = false;
    this._applyInstant(t);
  }

  /** История восстановлена: кому что делать дальше. */
  _settle() {
    const s = this.scene;
    const d = this.duel;
    if (d.status === 'finished' || d.status === 'cancelled' || s.turn.state === STATE.OVER) {
      this._setPhase('over');
      if (s.turn.state !== STATE.OVER) {
        // Сдался или пропустил три хода — боем это не видно, итог от сервера
        if (d.reason === 'resign') s.fx.banner(d.winner === this.myTeam ? 'Соперник сдался' : 'Ты сдался', '#ffd166', 2600);
        if (d.reason === 'timeout') s.fx.banner('Три хода пропущено подряд', '#ffd166', 2600);
        s.turn._gameOver(d.winner ?? -1);
      }
      return;
    }
    if (d.myTurn) {
      if (s.turn.turnNumber !== d.turn || s.turn.currentTeam !== this.myTeam) {
        console.warn('[duel] очередь не сошлась с сервером', s.turn.turnNumber, d.turn, s.turn.currentTeam);
        s.turn.turnNumber = d.turn;
      }
      this.rec = { n: d.turn, t0: performance.now(), cmds: [], lastMove: 0 };
      // Часы хода — полные и стоят, пока игрок не начал (begin): дуэль
      // открывают между делом, и ход не должен уходить, пока смотришь на поле
      s.turn.timeLeft = s.turnTime;
      this.started = false;
      this.ready = true;
      this._setPhase('play');
      // Начало своего хода: заморозка, подсказка «твой ход», вибрация
      if ((d.turns ?? []).length) s.onTurnBegin?.();
      return;
    }
    this._setPhase('wait');
    this._poll();
  }

  // ------------------------------------------------------------- свой ход

  _at() { return Math.round(performance.now() - this.rec.t0); }

  /** Игрок начал свой ход (первое касание, шаг, клавиша) — часы пошли. */
  begin() {
    if (this.phase !== 'play' || this.started) return;
    this.started = true;
    if (this.rec) this.rec.t0 = performance.now();
  }

  sendMove(m) {
    if (this.phase !== 'play' || !this.rec || !m) return;
    const r = this.rec;
    const t = this._at();
    const prev = r.cmds.findLast?.((c) => c.k === 'move')?.m;
    // Раз в 100 мс (показ доводит между ними плавно), но смена троса,
    // оружия или повиса — сразу
    const sharp = prev && (String(prev.zip) !== String(m.zip) || prev.hang !== m.hang || prev.weapon !== m.weapon);
    if (t - r.lastMove < 100 && !sharp) return;
    r.lastMove = t;
    r.cmds.push({ k: 'move', at: t, m });
  }

  sendShot(cmd) {
    if (this.phase === 'play' && this.rec) this.rec.cmds.push({ k: 'shot', at: this._at(), cmd });
  }

  /**
   * Взрыв своего хода — в историю: где, кого и на сколько задел. В показе
   * хода не участвует (там приказы и снимок), нужен для разбора партии:
   * /duellog у бота покажет, попал выстрел или прошёл мимо.
   */
  noteBoom(b) {
    if (this.phase !== 'play' || !this.rec) return;
    if (this.rec.cmds.filter((c) => c.k === 'boom').length >= 24) return;
    this.rec.cmds.push({ k: 'boom', at: this._at(), ...b });
  }

  sendSplit(m) {
    if (this.phase === 'play' && this.rec) this.rec.cmds.push({ k: 'split', at: this._at(), turn: m.turn, t: m.t });
  }

  /** Ход отыгран и очередь передана — на сервер. */
  sendState(actedTeam) {
    if (this.phase !== 'play' || actedTeam !== this.myTeam || !this.rec) return;
    const s = this.scene;
    const state = captureState(s);
    state.frozen = s.worms.map((w) => (w.frozen ? 1 : 0));
    const over = s.turn.state === STATE.OVER;
    const payload = {
      turn: this.rec.n, cmds: thin(this.rec.cmds), state, hash: turnHash(s), prevHash: this.prevHash, prevTurn: this.prevTurn,
      over, ...(over ? { winner: s.checkVictory() ?? -1 } : {}),
    };
    this.prevHash = payload.hash;
    this.prevTurn = payload.turn;
    this.ready = false;
    this.rec = null;
    this._saveStats();
    setPending(this.duel.id, payload);
    this._setPhase(over ? 'over' : 'sent');
    this._upload(payload);
  }

  async _upload(payload, tries = 0) {
    try {
      const r = await sendDuelTurn(this.duel.id, payload);
      setPending(this.duel.id, null);
      this.duel = { ...this.duel, ...r.duel, turns: [...(this.duel.turns ?? []), { n: payload.turn, team: this.myTeam, kind: 'move', cmds: payload.cmds, state: payload.state, hash: payload.hash }] };
      this.uploaded = true;
      this.scene?.onDuelSent?.(true);
      if (!payload.over) this._poll();
    } catch (e) {
      if (refused(e)) {
        setPending(this.duel.id, null);
        this.scene?.onDuelSent?.(false, e.message);
        return;
      }
      // Сеть: пробуем ещё, ход лежит на устройстве и уйдёт при следующем открытии
      if (tries < 5 && !this.dead) {
        await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
        return this._upload(payload, tries + 1);
      }
      this.scene?.onDuelSent?.(false, 'нет связи — ход отправится, когда откроешь игру снова');
    }
    return undefined;
  }

  /**
   * Ждём соперника, глядя в дуэль: раз в десять секунд спрашиваем сервер.
   * Сходил — сцена собирается заново и показывает его ход. Пока мы
   * спрашиваем, сервер знает, что мы смотрим, и бот нам не пишет.
   */
  async _poll() {
    if (this.polling) return;
    this.polling = true;
    while (!this.dead) {
      await this._wait(POLL_MS);
      if (this.dead) break;
      let fresh = null;
      try { fresh = await fetchDuel(this.duel.id); } catch { continue; }
      if (this.dead || !fresh) break;
      if (fresh.turn !== this.duel.turn || fresh.status !== this.duel.status) {
        this.scene.onDuelUpdate?.(fresh);
        break;
      }
    }
    this.polling = false;
  }

  // ------------------------------------------------- награды и счётчики боя

  /** Монеты, опыт и задания за дуэль — один раз на устройстве. @returns {boolean} можно ли дать */
  claimReward() {
    const st = readStore();
    if (st.rewarded.includes(this.duel.id)) return false;
    st.rewarded.push(this.duel.id);
    delete st.stats[this.duel.id];
    writeStore(st);
    return true;
  }

  /** Попадания и урон для заданий копятся через все свои ходы этой дуэли. */
  _loadStats() {
    const saved = readStore().stats[this.duel.id];
    if (saved && this.scene?.battleStats) Object.assign(this.scene.battleStats, saved);
  }

  _saveStats() {
    const st = readStore();
    st.stats[this.duel.id] = { ...this.scene.battleStats };
    writeStore(st);
  }
}

/**
 * Можно ли вести бойца плавно между двумя записями: тот же боец и ход, оба
 * на земле или оба висят на одном и том же (полёт по тросу доводит сам
 * applyMove — его не трогаем).
 */
function smoothable(a, b) {
  return a.worm === b.worm && a.turn === b.turn && !a.zip && !b.zip && (a.hang ?? null) === (b.hang ?? null)
    && Math.hypot(b.x - a.x, b.y - a.y) < 160;
}

/** Промежуточный шаг между записями a и b: позиция, прицел и заряд — по прямой. */
function lerpMove(a, b, k) {
  const mix = (x, y) => x + (y - x) * k;
  return {
    ...b,
    x: Math.round(mix(a.x, b.x)), y: Math.round(mix(a.y, b.y)),
    aim: mix(a.aim ?? 0, b.aim ?? 0), charge: mix(a.charge ?? 0, b.charge ?? 0),
    timeLeft: Math.round(mix(a.timeLeft ?? 0, b.timeLeft ?? 0)),
    weapon: k < 1 ? a.weapon : b.weapon,
  };
}

/** Шагов слишком много — оставляем каждый k-й, выстрелы и деления ракеты — все. */
function thin(cmds) {
  const moves = cmds.filter((c) => c.k === 'move');
  if (moves.length <= MAX_MOVES) return cmds;
  const k = Math.ceil(moves.length / MAX_MOVES);
  const keep = new Set(moves.filter((_, i) => i % k === 0 || i === moves.length - 1));
  return cmds.filter((c) => c.k !== 'move' || keep.has(c));
}
