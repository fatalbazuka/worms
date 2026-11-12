import { CFG, TEAM_COLORS, TEAM_NAMES } from '../config.js';
import { WEAPONS } from '../weapons/index.js';

export const STATE = {
  AIM: 'aim',         // игрок ходит и целится
  FLYING: 'flying',   // снаряд в воздухе
  RESOLVE: 'resolve', // ждём, пока всё успокоится
  OVER: 'over',       // игра окончена
};

/** Очередь ходов: 2 команды по 2 бойца, таймер 30 сек, ветер на каждый ход. */
export class TurnManager {
  constructor(scene) {
    this.scene = scene;
    this.state = STATE.RESOLVE;
    this.currentTeam = 0;
    this.activeWorm = null;
    this.timeLeft = this.scene.turnTime ?? CFG.TURN_TIME;
    this.resolveTimer = 0;
    this.flyTimer = 0;
    this.holdTimer = 0;     // сколько ждём ход соперника
    this.weaponIndex = 0;
    this.shotsLeft = 1;     // сколько выстрелов осталось этим ходом
    this.retreating = false;   // заряд поставлен, осталось уйти
    this.teamCursor = new Array(CFG.TEAMS).fill(0);
    this.turnNumber = 0;
    // Патроны общие на команду, как в оригинале
    this.ammo = Array.from({ length: CFG.TEAMS }, () =>
      WEAPONS.map((w) => w.startAmmo));
  }

  /** Сколько осталось у текущей команды. Infinity — безлимитное оружие. */
  ammoOf(index, team = this.currentTeam) {
    const n = this.ammo[team][index];
    return n === null ? Infinity : n;
  }

  addAmmo(index, count, team = this.currentTeam) {
    if (this.ammo[team][index] === null) return;
    this.ammo[team][index] += count;
  }

  /** Индекс случайного оружия с конечным запасом — для ящика. */
  randomCrateWeapon(rng) {
    const limited = WEAPONS.map((w, i) => (w.startAmmo === null ? -1 : i))
      .filter((i) => i >= 0);
    return limited[rng.int(0, limited.length - 1)];
  }

  get weapon() { return WEAPONS[this.weaponIndex]; }

  setWeaponIndex(i) {
    if (i < 0 || i >= WEAPONS.length) return;
    if (this.ammoOf(i) <= 0) return;      // пустое оружие не выбирается
    this.weaponIndex = i;
    this.shotsLeft = WEAPONS[i].shots;
    this.scene.fx?.sound('select');
    if (!this.scene.isBotTurn?.()) this.scene.haptic?.('select');
    this.scene.hud.setWeaponIndex(i);
  }

  /** Списать выстрел и, если запас кончился, вернуться к базуке. */
  spendAmmo() {
    const i = this.weaponIndex;
    if (this.ammo[this.currentTeam][i] === null) return;
    this.ammo[this.currentTeam][i] = Math.max(0, this.ammo[this.currentTeam][i] - 1);
  }

  /** Первый ход. */
  begin(startTeam = 0) {
    this.currentTeam = startTeam;
    this.setWeaponIndex(0);
    this._activate(startTeam, /* advanceTeam */ false);
  }

  /** Передать ход следующей команде. */
  next() {
    const winner = this.scene.checkVictory();
    if (winner !== null) { this._gameOver(winner); return; }
    this._activate(this.currentTeam, /* advanceTeam */ true);
  }

  _activate(fromTeam, advanceTeam) {
    let team = fromTeam;
    if (advanceTeam) {
      for (let i = 1; i <= CFG.TEAMS; i++) {
        const t = (fromTeam + i) % CFG.TEAMS;
        if (this.scene.teamAlive(t)) { team = t; break; }
      }
    }
    const worm = this._pickWorm(team);
    if (!worm) {
      const winner = this.scene.checkVictory();
      this._gameOver(winner);
      return;
    }

    this.currentTeam = team;
    this.activeWorm = worm;
    this.turnNumber++;
    this.timeLeft = this.scene.turnTime ?? CFG.TURN_TIME;
    this.state = STATE.AIM;
    this.retreating = false;

    // Оружие могло кончиться у этой команды — откатываемся на доступное
    if (this.ammoOf(this.weaponIndex) <= 0) {
      const ok = WEAPONS.findIndex((w, i) => this.ammoOf(i) > 0);
      this.weaponIndex = ok >= 0 ? ok : 0;
    }
    this.shotsLeft = this.weapon.shots;
    this.scene.hud.setWeaponIndex(this.weaponIndex);

    // Случайность хода — функция от (зерно, номер хода), а не общий поток:
    // лишний вызов генератора у одного из игроков разъехал бы всю партию.
    this.scene.beginTurnRandom(this.turnNumber);
    this.scene.maybeDropCrate();
    // Ветер разыгрывает сцена: у миссии он может быть свой или вовсе нулевой
    this.scene.rollWind();
    this.scene.resetAim();
    this.scene.onTurnBegin?.();

    for (const w of this.scene.worms) w.setActiveMarker(w === worm);
    this.scene.followTarget = worm;
    this.scene.frameTurn(worm);
    this.scene.fx.sound('turnStart');
    this.scene.fx.banner(
      `${TEAM_NAMES[team]} — ход ${this.turnNumber}`,
      hex(TEAM_COLORS[team]), 1200,
    );
  }

  /**
   * Навязать ход снаружи — так очередь передаётся в сетевой партии.
   *
   * Очередь считает не каждый клиент сам по себе: на смертях и досрочных
   * концах хода два счёта неизбежно разъезжаются, а от номера хода зависит
   * и ветер, и ящики. Поэтому ходивший передаёт очередь, а второй её просто
   * принимает.
   */
  forceTurn(info) {
    const worm = this.scene.worms[info.worm];
    if (!worm || !worm.alive) return false;

    this.currentTeam = info.team;
    this.activeWorm = worm;
    this.turnNumber = info.turn;
    this.teamCursor = info.cursors ? info.cursors.slice() : this.teamCursor;
    this.timeLeft = this.scene.turnTime ?? CFG.TURN_TIME;
    this.holdTimer = 0;
    this.state = STATE.AIM;
    this.retreating = false;

    this.weaponIndex = info.weapon ?? this.weaponIndex;
    this.shotsLeft = this.weapon.shots;
    this.scene.hud.setWeaponIndex(this.weaponIndex);

    // Ящики и ветер приходят снимком, поэтому здесь только поток случайности
    this.scene.beginTurnRandom(this.turnNumber);
    this.scene.resetAim();

    for (const w of this.scene.worms) w.setActiveMarker(w === worm);
    this.scene.followTarget = worm;
    this.scene.frameTurn(worm);
    this.scene.fx.banner(
      `${TEAM_NAMES[info.team]} — ход ${this.turnNumber}`,
      hex(TEAM_COLORS[info.team]), 1200,
    );
    return true;
  }

  /**
   * Ждём ли сейчас соперника. Ждём — значит очередь не двигаем сами.
   * Сколько ждать и что делать, если он пропал, решает сцена: там есть
   * сеть, а здесь только часы.
   */
  _holding(dt) {
    if (!this.scene.awaitingPeer?.()) { this.holdTimer = 0; return false; }
    this.holdTimer = (this.holdTimer ?? 0) + dt;
    return this.scene.holdForPeer?.(this.holdTimer) ?? true;
  }

  /** Следующий живой боец команды по кругу. */
  _pickWorm(team) {
    const list = this.scene.worms.filter((w) => w.team === team);
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      const idx = (this.teamCursor[team] + i) % list.length;
      if (list[idx].alive) {
        this.teamCursor[team] = (idx + 1) % list.length;
        return list[idx];
      }
    }
    return null;
  }

  /**
   * Вызывается сценой сразу после выстрела: ход уже не вернуть.
   *
   * У дробовика два выстрела за ход. Патрон списывается один раз, за
   * первый: иначе не выстрелив второй раз (кончилось время), игрок терял
   * бы боезапас впустую. Задержаться в прицеливании можно только с
   * мгновенным оружием — снаряда в воздухе нет, ждать нечего.
   */
  onFired() {
    const weapon = this.weapon;
    const first = this.shotsLeft === weapon.shots;
    if (first) this.spendAmmo();
    this.shotsLeft = Math.max(0, this.shotsLeft - 1);
    this.scene.cancelCharge();

    // Заряд под ногами: даём уйти. Ход не кончается, но и стрелять больше
    // нельзя — остаются только ноги. Без этого окна мина взводилась под
    // тем, кто её поставил, и убивала своего.
    if (weapon.retreat > 0) {
      this.retreating = true;
      this.timeLeft = weapon.retreat;
      this.scene.fx.banner('Уходи!', '#ff8a8a', 1200);
      return;
    }

    if (this.shotsLeft > 0 && weapon.instant) {
      // Второй выстрел того же хода: даём на него хотя бы несколько секунд
      this.timeLeft = Math.max(this.timeLeft, 6);
      this.scene.fx.banner(`ещё выстрел: ${this.shotsLeft}`, '#ffd166', 900);
      return;
    }

    this.state = STATE.FLYING;
    this.flyTimer = 0;
    this.activeWorm?.setActiveMarker(false);
  }

  /** Досрочно завершить ход (таймер, смерть активного бойца). */
  endTurn() {
    if (this.state === STATE.OVER) return;
    this.retreating = false;
    this.state = STATE.RESOLVE;
    this.resolveTimer = 0;
    this.activeWorm?.setActiveMarker(false);
    this.scene.aim.cancel();
  }

  _gameOver(winner) {
    this.state = STATE.OVER;
    this.activeWorm = null;
    for (const w of this.scene.worms) w.setActiveMarker(false);
    this.scene.onGameOver(winner);
  }

  update(dt) {
    const scene = this.scene;

    switch (this.state) {
      case STATE.AIM: {
        if (scene.landing?.()) break;   // десант ещё спускается
        const was = Math.ceil(this.timeLeft);
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        // Последние пять секунд тикаем — по разу на секунду
        const now = Math.ceil(this.timeLeft);
        if (now !== was && now <= 5 && now > 0) scene.fx?.sound('tick');
        // Чужой ход кончает сам соперник: наши часы могут отстать от его на
        // доли секунды, и обрывать ход по ним — значит сбить чужой выстрел.
        if (this._holding(dt)) break;
        if (!this.activeWorm || !this.activeWorm.alive) { this.endTurn(); break; }
        if (this.timeLeft <= 0) {
          scene.fx.banner(this.retreating ? 'Поздно' : 'Время вышло', '#ffd166', 1000);
          this.endTurn();
        }
        break;
      }

      case STATE.FLYING: {
        this.flyTimer += dt;
        // Снаряды сами себя ограничивают по времени жизни, но если что-то
        // всё же застряло — ход всё равно должен сдвинуться.
        if (this.flyTimer >= CFG.FLY_TIMEOUT) {
          for (const p of scene.projectiles) p.destroy();
          scene.projectiles.length = 0;
        }
        if (scene.projectiles.length === 0) {
          this.state = STATE.RESOLVE;
          this.resolveTimer = 0;
        }
        break;
      }

      case STATE.RESOLVE: {
        this.resolveTimer += dt;
        const quiet = scene.projectiles.length === 0 && scene.worms.every((w) => w.settled);
        if ((quiet && this.resolveTimer >= CFG.RESOLVE_SETTLE)
          || this.resolveTimer >= CFG.RESOLVE_TIMEOUT) {
          if (this._holding(dt)) break;   // очередь передаст тот, кто ходил
          const acted = this.currentTeam;
          this.next();
          // Снимок уходит уже после передачи очереди: в нём и итог хода,
          // и то, кому ходить дальше — второй клиент это просто принимает.
          scene.onTurnResolved?.(acted);
        }
        break;
      }

      default:
        break;
    }
  }
}

function hex(n) {
  return `#${n.toString(16).padStart(6, '0')}`;
}
