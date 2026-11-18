import { captureState, applyState, applyCommand, applyMove, stateHash } from './protocol.js';
import { randomId } from './transport.js';
import { player } from '../platform/player.js';
import { equippedSkin } from '../platform/skins.js';
import { CFG } from '../config.js';

/**
 * Сетевая партия на двоих.
 *
 * Кто есть кто, решается без сервера: оба шлют приветствие со своим
 * идентификатором и своим зерном, и меньший идентификатор становится
 * первой командой — его зерно и берётся. Схема симметричная, арбитр не
 * нужен, и она одинаково работает и между вкладками, и через Supabase.
 *
 * Дальше ход принадлежит тому, чья команда сейчас ходит:
 *   • он играет как обычно, его приказ и итоговый снимок уходят второму;
 *   • второй в это время не может вводить ничего, показывает чужой выстрел
 *     по приказу и в конце приводит состояние к снимку.
 *
 * Переподключение. На телефоне связь рвётся постоянно: звонок, свернули
 * Telegram, погас экран, а Mini App при этом часто перезапускается с нуля.
 * Чтобы партия это пережила:
 *   • идентификатор сессии не случайный на каждый запуск, а хранится по
 *     комнате: вернувшийся приходит под тем же именем, и соперник узнаёт
 *     его, а не принимает за третьего;
 *   • состояние восстанавливается снимком: вернувшийся просит sync, и
 *     соперник отдаёт всё — с полной историей воронок с начала партии,
 *     потому что земля у вернувшегося девственная;
 *   • раз в NET_PING секунд идёт пинг; кого не слышно NET_LOST секунд —
 *     «не в сети», и его ход ждут, а не играют за него. Через NET_GONE
 *     секунд молчания партия засчитывается оставшемуся.
 */
export class NetSession {
  constructor(scene, transport, room) {
    this.scene = scene;
    this.transport = transport;
    this.room = room;

    this.id = sessionIdFor(room);
    this.peerId = null;
    // Имя и рейтинг соперника нужны сразу: их видно в бою и по ним же
    // считается изменение рейтинга в конце
    this.me = player();
    this.opponent = null;
    this.myTeam = null;        // null = ещё не спарились
    // Зерно прошлой встречи в этой комнате: если оба перезапустились,
    // сойдёмся хотя бы на той же карте, а не на двух разных
    this.seed = storedSeed(room) ?? scene.seed;
    this.iWantRematch = false;
    this.peerWantsRematch = false;
    this.paired = false;
    // Сцена собрана под текущую партию. После спаривания она
    // пересобирается не сразу, а следующим кадром, и отдавать снимок со
    // старой (ещё локальной) сцены нельзя — соперник принял бы чужую карту
    this.sceneReady = true;
    // Получили полное состояние после (пере)спаривания. Пока нет — просим
    this.synced = false;
    this.lastTurn = 0;         // отсекает опоздавшие приказы
    this.lastPeerSeen = 0;
    this.lastSyncAsk = 0;
    this.onStatus = null;      // сцена подписывается, чтобы показать статус
    this._resume = () => this.resume();
  }

  get connected() { return this.paired; }
  get myTurn() { return this.myTeam !== null && this.scene.turn.currentTeam === this.myTeam; }

  /** Соперник молчит дольше NET_LOST секунд. До первой встречи — нет. */
  get peerLost() {
    return this.paired && Date.now() - this.lastPeerSeen > CFG.NET_LOST * 1000;
  }

  /** Сколько секунд соперник не в сети. */
  get peerSilence() {
    return this.paired ? (Date.now() - this.lastPeerSeen) / 1000 : 0;
  }

  async start() {
    await this.transport.connect(this.room, (msg) => this._onMessage(msg));
    this._hello();
    // Второй игрок мог подключиться раньше и уже отправить своё приветствие
    this.helloTimer = setInterval(() => { if (!this.paired) this._hello(); }, 1200);
    this.pingTimer = setInterval(() => { if (this.paired) this._ping(); }, CFG.NET_PING * 1000);
    this.syncTimer = setInterval(() => {
      if (this.paired && !this.synced && this.sceneReady) this.requestSync();
    }, 3000);
    // Вернулись из фона или сеть появилась снова — догоняем
    globalThis.addEventListener?.('visibilitychange', this._resume);
    globalThis.addEventListener?.('pageshow', this._resume);
    globalThis.addEventListener?.('online', this._resume);
    this._status('ждём второго игрока…');
  }

  _hello() {
    this.transport.send({
      type: 'hello', id: this.id, seed: this.seed,
      name: this.me.name, rating: this.me.rating,
      skin: equippedSkin().id,   // в чём я выхожу — чтобы соперник видел меня таким же
      pid: this.me.id,   // кто это по паспорту (tg<id>) — для отчёта серверу
      // Уже в партии: новичок обязан взять моё зерно и другую команду,
      // а не считать их из порядка идентификаторов
      paired: this.paired, team: this.myTeam,
    });
  }

  /**
   * Пинг несёт номер хода: если соперник ушёл вперёд, значит его снимок до
   * нас не дошёл, и надо просить состояние. Просить «по таймеру», как было
   * раньше, нельзя: пока соперник думает дольше двадцати секунд, каждый
   * ответ убивал бы снаряд показа, и его выстрел был бы не виден.
   */
  _ping() {
    const t = this.scene.turn;
    this.transport.send({
      type: 'ping', turn: t?.turnNumber ?? 0, over: t?.state === 'over',
    });
  }

  _onPing(msg) {
    if (!this.sceneReady || !this.synced) return;
    const t = this.scene.turn;
    const behind = msg.turn > t.turnNumber || (msg.over && t.state !== 'over');
    if (behind) this.requestSync();
  }

  _status(text) {
    this.onStatus?.(text, this.paired);
  }

  _onMessage(msg) {
    // Своё собственное имя в чужом приветствии — две вкладки одного
    // браузера взяли один сохранённый идентификатор. Берём новый.
    if (msg.type === 'hello' && msg.id === this.id) {
      this.id = sessionIdFor(this.room, /* fresh */ true);
      this._hello();
      return undefined;
    }
    this.lastPeerSeen = Date.now();
    switch (msg.type) {
      case 'hello': return this._onHello(msg);
      case 'ping': return this._onPing(msg);
      case 'sync': return this._onSync();
      case 'move': return this._onMove(msg);
      case 'shot': return this._onShot(msg);
      case 'state': return this._onState(msg);
      case 'rematch': return this._onRematch();
      case 'emote': return this.sceneReady ? this.scene.showEmote?.(this.myTeam === 0 ? 1 : 0, msg.emote) : undefined;
      default: return undefined;
    }
  }

  _onHello(msg) {
    if (this.paired) {
      // Соперник вернулся (перезапуск, свернули и развернули): отвечаем,
      // чтобы он спарился заново; состояние он попросит сам, когда его
      // сцена пересоберётся — слать сейчас бесполезно
      const back = msg.id === this.peerId;
      if (!back) {
        // Соперник потерял сохранённый идентификатор и пришёл под новым.
        // Комната приватная, третьему тут взяться неоткуда
        this.peerId = msg.id;
      }
      this.opponent = { id: msg.pid ?? this.opponent?.id ?? null,
        name: msg.name ?? this.opponent?.name ?? 'Соперник',
        rating: msg.rating ?? this.opponent?.rating ?? 1000,
        skin: msg.skin ?? this.opponent?.skin ?? null };
      this._hello();
      this._status('соперник вернулся');
      return;
    }

    this.peerId = msg.id;
    this.opponent = {
      id: msg.pid ?? null, name: msg.name ?? 'Соперник', rating: msg.rating ?? 1000, skin: msg.skin ?? null,
    };

    let seed;
    if (msg.paired && msg.team !== null && msg.team !== undefined) {
      // Партия уже идёт у него — мы возвращаемся или заменяем выбывшего:
      // команда — свободная, зерно — его
      this.myTeam = msg.team === 0 ? 1 : 0;
      seed = msg.seed;
    } else {
      // Меньший идентификатор — первая команда, и его зерно общее.
      const iAmFirst = this.id < msg.id;
      this.myTeam = iAmFirst ? 0 : 1;
      seed = iAmFirst ? this.seed : msg.seed;
    }

    // Отвечаем, чтобы тот, кто пришёл первым, тоже узнал о нас
    this.paired = true;
    this.synced = false;
    this.sceneReady = false;   // сцена пересоберётся под общее зерно
    this._hello();
    clearInterval(this.helloTimer);
    this._status(`соперник: ${this.opponent.name} (${this.opponent.rating})`);
    this.seed = seed;
    rememberSeed(this.room, seed);
    this.scene.startNetMatch(seed, this.myTeam);
  }

  /**
   * Попросить у соперника полное состояние. Зовётся после перезапуска
   * сцены и после возвращения из фона; не чаще раза в три секунды, чтобы
   * подвисшая связь не превращалась в шторм запросов.
   */
  requestSync(force = false) {
    if (!this.paired) return false;
    const now = Date.now();
    if (now - this.lastSyncAsk < 3000) return false;
    this.lastSyncAsk = now;
    // Принудительный: следующий полный снимок применить, даже если по
    // номеру хода мы не отстали, — земля или позиции разошлись
    if (force) this.forceFull = true;
    this.transport.send({ type: 'sync' });
    return true;
  }

  _onSync() {
    if (!this.paired || !this.sceneReady) return;
    const state = captureState(this.scene);
    // Полная история воронок: у вернувшегося земля чистая, ему нужны
    // все взрывы с начала партии, а не только за этот ход
    state.explosions = this.scene.explosionHistory.slice();
    state.full = true;
    this.transport.send({ type: 'state', state, hash: stateHash(state) });
  }

  /**
   * Своё эхо отсекает транспорт, так что сюда приходит только чужое —
   * фильтровать по «чей сейчас ход» нельзя: к моменту доставки очередь
   * могла уже смениться, и мы выбросили бы нужное сообщение.
   */
  _onShot(msg) {
    if (!this.sceneReady) return;
    if (msg.cmd.turn < this.lastTurn) return;    // опоздавший приказ
    this.lastTurn = msg.cmd.turn;
    applyCommand(this.scene, msg.cmd);
  }

  _onState(msg) {
    // Полный снимок приходит на sync — и мог прийти в ответ на чужой
    // запрос. Он безвреден: воронки применяются повторно без следа,
    // остальное и так совпадает.
    if (!this.sceneReady) return;   // старая сцена, вот-вот пересоберётся
    // Когда мы уже в курсе, переприменять полный снимок нельзя: посреди
    // своего хода он сбросил бы прицел и таймер и убил бы наш снаряд.
    // Берём его, только если отстали.
    if (msg.state.full && this.synced && !this.forceFull) {
      const t = this.scene.turn;
      const behind = msg.state.turn > t.turnNumber || (msg.state.over && t.state !== 'over');
      if (!behind) return;
    }
    this.forceFull = false;
    if (msg.state.full) {
      this.scene.explosionHistory = msg.state.explosions.slice();
      this.synced = true;
    } else {
      // Свои взрывы зритель во время показа не пишет — берём из снимка,
      // иначе не смогли бы отдать историю вернувшемуся сопернику
      this.scene.explosionHistory.push(...(msg.state.explosions ?? []));
    }
    applyState(this.scene, msg.state);
    this.lastTurn = msg.state.turn;
    if (msg.state.over) {
      // Партия у соперника уже кончилась (например, нас сочли ушедшими):
      // добиваем и у себя, чтобы не висеть в чужом ходу
      const winner = this.scene.checkVictory();
      if (winner !== null && this.scene.turn.state !== 'over') this.scene.turn._gameOver(winner);
    }
    const mine = stateHash(captureState(this.scene));
    if (mine !== msg.hash) {
      // Снимок уже применён, партия не сломается, но знать полезно:
      // расхождение здесь означает ошибку в самом протоколе.
      console.warn('[net] состояние разошлось', mine, '!=', msg.hash);
      this.onDiverge?.(mine, msg.hash);
      // Лечим полной историей воронок — раз за ход и только не в свой ход,
      // чтобы полный снимок не сбил нам прицел
      const turnNo = this.scene.turn.turnNumber;
      if (!msg.state.full && !this.myTurn && this.healedTurn !== turnNo) {
        this.healedTurn = turnNo;
        this.requestSync(true);
      }
    }
  }

  /**
   * Вернулись из фона: сокет мог умереть, сообщения — потеряться.
   * Транспорт переподключаем, у соперника просим состояние.
   */
  resume() {
    if (globalThis.document?.hidden) return;
    this.transport.reconnect?.();
    if (this.paired) {
      this.lastSyncAsk = 0;
      // Дать сокету секунду на переподключение, иначе запрос уйдёт в никуда
      setTimeout(() => this.requestSync(), 800);
      setTimeout(() => this.requestSync(), 4000);
    } else {
      this._hello();
    }
  }

  /**
   * Реванш. Оба должны нажать: пока согласен только один, партия не
   * перезапускается — иначе второго выкинуло бы из экрана результата.
   *
   * Новое зерно не согласовывается: оно выводится из старого одной и той
   * же формулой у обеих сторон, значит совпадёт само.
   */
  wantRematch() {
    if (!this.paired) return;
    this.iWantRematch = true;
    this.transport.send({ type: 'rematch' });
    this._maybeRematch();
  }

  _onRematch() {
    this.peerWantsRematch = true;
    this.scene.onPeerRematch?.();
    this._maybeRematch();
  }

  _maybeRematch() {
    if (!this.iWantRematch || !this.peerWantsRematch) return;
    this.iWantRematch = false;
    this.peerWantsRematch = false;
    this.lastTurn = 0;
    this.seed = nextSeed(this.seed);
    rememberSeed(this.room, this.seed);
    this.sceneReady = false;
    this.synced = false;
    this.scene.startNetMatch(this.seed, this.myTeam);
  }

  _onMove(msg) {
    if (!this.sceneReady) return;
    applyMove(this.scene, msg.m);
  }

  /** Живой ход: позиция, прицел, заряд — раз в сто миллисекунд, если менялось. */
  /** Эмоция — сопернику: только id, остальное он знает сам. */
  sendEmote(id) {
    if (this.paired) this.transport.send({ type: 'emote', emote: String(id).slice(0, 12) });
  }

  sendMove(m) {
    if (!this.paired || !m) return;
    this.transport.send({ type: 'move', m });
  }

  /** Вызывается сценой при выстреле локального игрока. */
  sendShot(cmd) {
    if (!this.paired) return;
    this.transport.send({ type: 'shot', cmd });
  }

  /**
   * Вызывается сценой, когда ход отыгран и очередь уже передана.
   * Шлёт только тот, чей ход это был: второй в это время ждал.
   */
  sendState(actedTeam) {
    if (!this.paired || actedTeam !== this.myTeam) return;
    const state = captureState(this.scene);
    this.lastTurn = state.turn;
    this.transport.send({ type: 'state', state, hash: stateHash(state) });
  }

  /** Партия кончилась или брошена: в неё больше не возвращаемся. */
  forget() {
    forgetSession(this.room);
  }

  destroy() {
    clearInterval(this.helloTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.syncTimer);
    globalThis.removeEventListener?.('visibilitychange', this._resume);
    globalThis.removeEventListener?.('pageshow', this._resume);
    globalThis.removeEventListener?.('online', this._resume);
    this.transport.close();
  }
}

/**
 * Зерно следующего боя. Линейный конгруэнтный шаг от общего зерна: обе
 * стороны получают одно и то же, ни о чём не договариваясь.
 */
export function nextSeed(seed) {
  return (Math.imul(seed >>> 0, 1103515245) + 12345) >>> 0;
}

// ------------------------------------------------------------ сессия

const KEY = 'worms.session.v1';
/** Дольше этого партия точно не живёт — запись устарела. */
const SESSION_TTL = 2 * 3600 * 1000;

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    if (Date.now() - (raw.t ?? 0) > SESSION_TTL) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeSession(rec) {
  try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch { /* инкогнито */ }
}

/**
 * Идентификатор сессии для комнаты: тот же, что в прошлый раз, если мы
 * в неё возвращаемся. Так соперник узнаёт вернувшегося.
 */
export function sessionIdFor(room, fresh = false) {
  const rec = readSession();
  if (!fresh && rec && rec.room === room && rec.id) {
    writeSession({ ...rec, t: Date.now() });
    return rec.id;
  }
  const id = randomId();
  writeSession({ room, id, t: Date.now() });
  return id;
}

function storedSeed(room) {
  const rec = readSession();
  return rec && rec.room === room && Number.isFinite(rec.seed) ? rec.seed : null;
}

function rememberSeed(room, seed) {
  const rec = readSession();
  if (!rec || rec.room !== room) return;
  writeSession({ ...rec, seed, t: Date.now() });
}

/** Комната, в которой мы недавно играли и ещё не доиграли, — или null. */
export function pendingSession() {
  const rec = readSession();
  return rec?.room ? { room: rec.room, at: rec.t } : null;
}

export function forgetSession(room) {
  const rec = readSession();
  if (!rec || (room && rec.room !== room)) return;
  try { localStorage.removeItem(KEY); } catch { /* — */ }
}
