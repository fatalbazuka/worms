import { CFG, DEPTH, TEAM_COLORS, TEAM_NAMES, canvasSize } from '../config.js';
import { makeRng, subRng } from '../core/rng.js';
import { BIOMES, pickBiome } from '../core/biomes.js';
import { Terrain } from '../core/Terrain.js';
import { TurnManager, STATE } from '../core/TurnManager.js';
import { has, meta } from '../core/assets.js';
import { Worm } from '../entities/Worm.js';
import { Crate } from '../entities/Crate.js';
import { Mine } from '../entities/Mine.js';
import { Hud, TOP_H } from '../ui/Hud.js';
import { Fx } from '../ui/Fx.js';
import { AimController } from '../ui/AimController.js';
import { font, UI, ensureButton } from '../ui/theme.js';
import { WEAPONS } from '../weapons/index.js';
import { captureCommand, captureMove } from '../net/protocol.js';
import { NetSession } from '../net/session.js';
import { knock } from '../net/lobby.js';
import { randomRoom, copyText } from '../net/transport.js';
import { makeTransport } from '../net/connect.js';
import { startRoom, shareRoom, haptic, inviteLink, offerHomeScreenOnce, setBattle } from '../platform/telegram.js';
import { HOTSEAT } from '../core/match.js';
import { Bot } from '../ai/Bot.js';
import { markDone, MISSION_BY_ID } from '../campaign/missions.js';
import { checkObjective, snapshot, objectiveText } from '../campaign/objectives.js';
import { player, eloDelta, recordResult } from '../platform/player.js';
import { reportResult, serverAvailable } from '../net/server.js';
import { leagueOf, nextLeague, toNextLeague } from '../platform/league.js';
import { OffscreenMarkers } from '../ui/OffscreenMarkers.js';
import { CameraRig } from '../ui/CameraRig.js';
import { isDesktop } from '../platform/device.js';

export default class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }

  create() {
    // Что за партия — решает меню. Прямой заход по адресу описания не даёт,
    // и тогда игра ведёт себя как раньше: обычный хотсит на одном устройстве.
    this.match = this.registry.get('match') ?? HOTSEAT;
    this.rules = this.match.rules ?? {};
    this.turnTime = this.rules.turnTime ?? CFG.TURN_TIME;

    // Зерно задаётся снаружи (сеть, ?seed= в адресе) либо разыгрывается.
    // От него полностью зависят карта, расстановка и всё, что случайно.
    this.seed = this._chooseSeed();
    this.rng = makeRng(this.seed);
    this.turnRng = subRng(this.seed, 0);
    this.explosionLog = [];
    // Все воронки с начала партии — для соперника, вернувшегося после
    // обрыва: у него земля чистая, журнал одного хода ему не поможет
    this.explosionHistory = [];
    this.wind = 0;
    this.replaying = false;   // показываем чужой ход: без урона и разрушений
    this.worms = [];
    this.projectiles = [];
    this.crates = [];
    this.mines = [];
    this.followTarget = null;
    this.moveInput = {
      left: false, right: false, jumpQueued: false,
      aimUp: false, aimDown: false, fire: false,
    };

    // Прицеливание кнопками: угол хранится в «математической» системе
    // (0 — горизонт, +π/2 — вверх) и разворачивается по facing бойца.
    this.aimAngle = CFG.AIM_ANGLE_START;
    this.charging = false;
    this.charge = 0;
    // Прицел и заряд соперника в его ход — только картинка
    this.remoteAim = false;
    this.remoteCharge = 0;
    this._moveClock = 0;
    this._lastMove = '';
    this._lastNow = 0;   // отметка системных часов для realDt
    this.gameOverUi = null;

    // Риг камер создаётся первым: каждый последующий объект сразу
    // приписывается к своей камере.
    this.rig = new CameraRig(this);

    const biome = this._chooseBiome();

    this._buildSky(biome);
    this._buildTerrain(biome);
    this._buildWater(biome);

    this.fx = new Fx(this);
    this.hud = new Hud(this);
    this.turn = new TurnManager(this);
    this.aim = new AimController(this);
    this.offscreen = new OffscreenMarkers(this);

    this._spawnWorms();
    this._setupKeyboard();
    this._setupBots();
    this._applyAmmoRules();

    this.rig.bgCam.setBackgroundColor(biome.fallback.sky[1]);
    // Первым ходит человек: отдавать первый ход боту в миссии — почти то же,
    // что начать её с потери бойца.
    this.turn.begin(this._firstTeam());

    this._setupNet();
    // Экран может поменять размер прямо посреди партии: повернули телефон,
    // уехала панель браузера. Логический размер тогда пересчитывается, и
    // интерфейс надо разложить заново.
    this.game.events.on('worms-resize', this.relayout, this);
    this.events.once('shutdown', this._shutdown, this);

    // Бой ландшафтный: в портрете страница показывает «поверни телефон»,
    // а Telegram держит ландшафт. Меню всего этого не касается.
    globalThis.document?.body.classList.add('in-battle');
    setBattle(true);
    // На ПК над полем — перекрестие: сразу видно, что курсор и есть прицел
    if (isDesktop()) this.input.setDefaultCursor('crosshair');
  }

  /** Пересобрать всё, что считалось от размера экрана. */
  relayout() {
    this.rig.resize();
    const [cw, ch] = canvasSize();
    this.skyImage?.setDisplaySize(cw, Math.max(this.skyHeight ?? 0, ch));
    this._buildBarBacking();

    // HUD проще собрать заново, чем двигать полсотни объектов поштучно
    const help = this.hud.helpVisible;
    this.hud.destroy();
    this.hud = new Hud(this);
    this.hud.setHelp(help);
    this.hud.setWeaponIndex(this.turn.weaponIndex);
    if (this.room) this._netStatus();
  }

  // ------------------------------------------------------------------ боты

  _setupBots() {
    this.bots = this.match.teams.map(
      (t) => (t.control === 'bot' ? new Bot(this, t.level) : null),
    );
  }

  /** Первой ходит команда человека; если людей нет — просто первая. */
  _firstTeam() {
    const human = this.match.teams.findIndex((t) => t.control !== 'bot');
    return human >= 0 ? human : 0;
  }

  botFor(team) { return this.bots?.[team] ?? null; }

  isBotTurn() {
    return !!this.botFor(this.turn.currentTeam) && this.turn.state === STATE.AIM;
  }

  /** Начало хода: боту нужен чистый план, чужой ему не годится. */
  onTurnBegin() {
    for (const b of this.bots ?? []) b?.reset();
  }

  _applyAmmoRules() {
    const set = (team, table) => {
      if (!table) return;
      for (const [id, count] of Object.entries(table)) {
        const i = WEAPONS.findIndex((w) => w.id === id);
        if (i >= 0 && this.turn.ammo[team][i] !== null) this.turn.ammo[team][i] = count;
      }
    };
    this.match.teams.forEach((t, team) => {
      set(team, t.control === 'bot' ? this.rules.enemyAmmo : this.rules.ammo);
    });
  }

  /**
   * Ветер на ход. Обычно случайный, но миссия может задать свой диапазон
   * или прибить ветер намертво — на этом построена «Пристрелка».
   */
  rollWind() {
    if (Number.isFinite(this.rules.wind)) return this.setWind(this.rules.wind);
    const [lo, hi] = this.rules.windRange ?? [CFG.WIND_MIN, CFG.WIND_MAX];
    // Диапазон вида [190, 300] означает «сильно, в любую сторону»
    const v = this.turnRng.range(lo, hi);
    const sign = this.rules.windRange && lo > 0 ? (this.turnRng() < 0.5 ? -1 : 1) : 1;
    this.setWind(v * sign);
  }

  // ------------------------------------------------------------------ сеть

  /**
   * Онлайн включается только адресом: ?room=КОД. Без него игра как была —
   * локальный хотсит, никакой сети и никаких подключений.
   */
  _setupNet() {
    const room = startRoom();
    if (!room) return;
    this.room = room;

    // Сессия одна на всю вкладку: рестарт сцены её не рвёт
    this.net = this.registry.get('net');
    if (this.net) {
      this.net.scene = this;
      this.myTeam = this.net.myTeam;
      this.net.onStatus = (text) => this._netStatus(text);
      this.net.onDiverge = () => this.fx.banner('земля разошлась · синхронизирую', '#ffd166', 1600);
      this._netStatus(this.net.paired ? '' : 'ждём второго игрока…');
      // Сцена пересобрана с нуля (спарились, вернулись после обрыва):
      // партия у соперника могла уйти далеко — просим её целиком
      this.net.sceneReady = true;
      if (this.net.paired) this.net.requestSync();
      return;
    }

    this._netStatus('подключаемся…');
    makeTransport().then((transport) => {
      this.net = new NetSession(this, transport, room);
      this.net.onStatus = (text) => this._netStatus(text);
      this.net.onDiverge = () => this.fx.banner('земля разошлась · синхронизирую', '#ffd166', 1600);
      this.registry.set('net', this.net);
      // Пришли по ссылке, минуя лобби: хозяин может ждать на экране стола
      // и услышит только стук через лобби
      if (!this.registry.get('lobby')) knock(room);
      return this.net.start();
    }).catch((e) => {
      console.warn('[net] не удалось подключиться', e);
      this.fx.banner('сеть недоступна, играем локально', '#ff9a9a', 2600);
      this._netStatus('нет связи — локальная игра', '#ff9a9a');
      // Сессию гасим целиком: иначе клиент Realtime продолжит ломиться
      // в сокет до конца партии, которую мы уже играем локально
      this.net?.destroy();
      this.net = null;
      this.registry.set('net', null);
    });
  }

  _netStatus(text, color) {
    if (text != null) this.netStatusText = text;
    const parts = [];
    if (this.room) parts.push(`комната ${this.room}`);
    if (this.netStatusText) parts.push(this.netStatusText);
    this.hud.setNetStatus(parts.join(' · '), color);
  }

  /** Спарились: перезапускаем партию с общим зерном. */
  startNetMatch(seed, myTeam) {
    this.myTeam = myTeam;
    // Спарились — в лобби мы больше не стол и не ищущий
    this.registry.get('lobby')?.busy();
    this.registry.set('seed', seed);
    this.gameOverUi = null;
    // Перезапуск безусловный: к моменту встречи локальная партия уже могла
    // уйти вперёд, а начинать надо с одинакового состояния.
    this.scene.restart();
  }

  /** Ссылка-приглашение для второго игрока. */
  inviteLink(room = this.room) {
    return inviteLink(room || randomRoom());
  }

  /**
   * Кнопка «звенья»: в комнате — копирует ссылку, вне комнаты — спрашивает
   * код друга (пусто — создаём свою) и перезаходит уже в комнату.
   */
  shareInvite() {
    if (this.room) {
      const link = this.inviteLink();
      // В Telegram зовём родным выбором контакта, снаружи — буфером обмена
      if (shareRoom(this.room, link)) return link;
      copyText(link);
      this.fx.banner(`ссылка скопирована · комната ${this.room}`, '#ffd166', 2600);
      return link;
    }
    const answer = (globalThis.prompt?.('Код комнаты друга (пусто — создать свою):', '') ?? '')
      .trim().toUpperCase();
    const room = answer || randomRoom();
    const link = this.inviteLink(room);
    copyText(link);
    // Перезаход: сессия поднимается на старте сцены. Адрес всегда сайта:
    // t.me-ссылка внутри игры никуда не ведёт
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    location.href = url.toString();
    return link;
  }

  // ------------------------------------------------------------- построение

  _chooseSeed() {
    const forced = this.registry.get('seed')
      ?? new URLSearchParams(location.search).get('seed');
    const n = Number.parseInt(forced, 10);
    if (Number.isFinite(n)) return n >>> 0;
    return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  }

  /** Биом случайный; можно зафиксировать через ?biome=tundra — удобно для отладки. */
  _chooseBiome() {
    const forced = this.registry.get('forceBiome')
      ?? new URLSearchParams(location.search).get('biome');
    return BIOMES.find((b) => b.id === forced) ?? pickBiome(this.rng);
  }

  _buildSky(biome) {
    // Градиент неба из темы: узкая вертикальная полоска, растянутая по ширине.
    // По высоте НЕ ужимаем: градиент рассчитан на карту выше экрана, и его
    // нижняя (почти чёрная) часть должна остаться за кадром.
    // Небо — на весь канвас, включая рамку безопасной области
    const [cw, ch] = canvasSize();
    if (has(this, `${biome.id}_sky`)) {
      const skyH = meta(`terrain_${biome.id}`)?.skyH ?? ch;
      this.skyImage = this.rig.bg(this.add.image(0, 0, `${biome.id}_sky`)
        .setOrigin(0, 0)
        .setDisplaySize(cw, Math.max(skyH, ch))
        .setScrollFactor(0)
        .setDepth(DEPTH.SKY));
      this.skyHeight = Math.max(skyH, ch);
    } else {
      const key = 'sky-tex';
      if (this.textures.exists(key)) this.textures.remove(key);
      const tex = this.textures.createCanvas(key, 8, ch);
      const ctx = tex.getContext();
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, biome.fallback.sky[0]);
      g.addColorStop(1, biome.fallback.sky[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 8, ch);
      tex.refresh();
      this.skyImage = this.rig.bg(this.add.image(0, 0, key).setOrigin(0, 0)
        .setDisplaySize(cw, ch)
        .setScrollFactor(0).setDepth(DEPTH.SKY));
      this.skyHeight = ch;
    }

    this._buildParallax(biome);
    this._buildBarBacking();
  }

  /**
   * Фон верхней панели до самых краёв экрана. Сама панель живёт в камере
   * интерфейса и начинается от безопасной области; без этого по бокам
   * от неё, под «чёлкой», торчали бы клочки неба.
   */
  _buildBarBacking() {
    this.barBacking?.destroy();
    this.barBacking = null;
    const f = CFG.FRAME;
    if (!f.left && !f.right) return;
    const [cw] = canvasSize();
    this.barBacking = this.rig.bg(this.add.rectangle(0, 0, cw, TOP_H, 0x10131a, 0.9)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH.SKY + 1));
  }

  _buildParallax(biome) {
    const key = `${biome.id}_back`;
    if (!has(this, key)) return;

    const src = this.textures.get(key).getSourceImage();
    // Фон тайлится по горизонтали. Верхняя кромка у него силуэтная (с альфой)
    // и красиво переходит в небо, а нижняя обрезана «по живому» — поэтому
    // сажаем низ на линию воды, где её закрывает земля и водная плёнка.
    this.rig.world(this.add.tileSprite(0, CFG.WATER_Y - src.height, CFG.WORLD_W, src.height, key)
      .setOrigin(0, 0)
      .setScrollFactor(0.45, 1)
      .setDepth(DEPTH.PARALLAX));
  }

  _buildTerrain(biome) {
    this.terrain = new Terrain(CFG.WORLD_W, CFG.WORLD_H, biome, this.rng);
    this.terrain.setTextures({
      soil: has(this, `${biome.id}_soil`)
        ? this.textures.get(`${biome.id}_soil`).getSourceImage() : null,
      grass: has(this, `${biome.id}_grass`)
        ? this.textures.get(`${biome.id}_grass`).getSourceImage() : null,
    });
    this.terrain.generate();

    // По одной Phaser-текстуре на чанк: после взрыва в GPU уходит
    // только задетый кусок, а не вся карта целиком.
    this.terrainTextures = this.terrain.chunks.map((chunk, i) => {
      const key = `terrain-tex-${i}`;
      if (this.textures.exists(key)) this.textures.remove(key);
      const tex = this.textures.addCanvas(key, chunk.canvas);
      this.rig.world(this.add.image(chunk.x0, 0, key).setOrigin(0, 0).setDepth(DEPTH.TERRAIN));
      return tex;
    });
    this.terrain.dirtyChunks.clear();
  }

  _buildWater(biome) {
    // Вода уходит заметно ниже мира: при отдалении под землёй не должно
    // зиять ничего, там продолжается вода.
    const deep = CFG.WORLD_H - CFG.WATER_Y + 900;
    this.rig.world(this.add.rectangle(0, CFG.WATER_Y, CFG.WORLD_W, deep, biome.water, biome.waterAlpha)
      .setOrigin(0, 0).setDepth(DEPTH.WATER));
    this.rig.world(this.add.rectangle(0, CFG.WATER_Y, CFG.WORLD_W, 3, 0xffffff, 0.25)
      .setOrigin(0, 0).setDepth(DEPTH.WATER));
  }

  /**
   * Расстановка. Состав команд берётся из описания партии: в миссиях
   * стороны бывают неравными, и «по два бойца всем» тут не годится.
   * Команды чередуются слева направо, пока у кого-то не кончились бойцы.
   */
  _spawnWorms() {
    const sizes = this.match.teams.map((t) => t.worms ?? CFG.WORMS_PER_TEAM);
    const order = [];
    for (let i = 0; i < Math.max(...sizes); i++) {
      sizes.forEach((n, team) => { if (i < n) order.push({ team, idx: i }); });
    }

    const spots = this._findSpawnSpots(order.length);
    order.forEach(({ team, idx }, i) => {
      const x = spots[i] ?? this.rng.range(300, CFG.WORLD_W - 300);
      const top = this.terrain.surfaceYAt(x, 0) ?? CFG.GROUND_BASE - 100;
      // Десант: боец появляется над землёй и спускается на парашюте. Высота
      // из общего генератора — у обоих игроков в сети одинаковая
      const drop = this.rng.range(CFG.SPAWN_DROP_MIN, CFG.SPAWN_DROP_MAX);
      const worm = new Worm(this, x, top - 1 - drop, team, idx);
      worm.deployChute();
      this.worms.push(worm);
    });
  }

  /**
   * Точки старта: разнесены друг от друга, но все внутри окна шириной
   * CFG.SPAWN_SPAN — иначе противник может оказаться дальше максимальной
   * дальности выстрела, и ход будет нечем занять.
   */
  _findSpawnSpots(count) {
    const all = [];
    for (let x = 180; x < CFG.WORLD_W - 180; x += 6) {
      if (this.terrain.isSpawnable(x)) all.push(x);
    }
    if (!all.length) return [];

    // Случайное окно расселения внутри пригодной части острова
    const lo = all[0], hi = all[all.length - 1];
    const span = Math.min(CFG.SPAWN_SPAN, hi - lo);
    const start = lo + this.rng() * Math.max(0, (hi - lo) - span);
    let pool = all.filter((x) => x >= start && x <= start + span);
    if (pool.length < count) pool = all;

    // Перемешиваем и жадно набираем разнесённые точки
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (let minDist = CFG.SPAWN_MIN_DIST; minDist >= 40; minDist -= 40) {
      const picked = [];
      for (const x of shuffled) {
        if (picked.every((p) => Math.abs(p - x) >= minDist)) picked.push(x);
        if (picked.length === count) break;
      }
      if (picked.length === count) {
        picked.sort((a, b) => a - b); // команды чередуются слева направо
        return picked;
      }
    }
    return shuffled.slice(0, count).sort((a, b) => a - b);
  }

  _setupKeyboard() {
    const kb = this.input.keyboard;
    this.keys = kb.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      d: Phaser.Input.Keyboard.KeyCodes.D,
      up: Phaser.Input.Keyboard.KeyCodes.UP,
      down: Phaser.Input.Keyboard.KeyCodes.DOWN,
      w: Phaser.Input.Keyboard.KeyCodes.W,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      fire: Phaser.Input.Keyboard.KeyCodes.SPACE,   // держать = набор силы
      jump: Phaser.Input.Keyboard.KeyCodes.ENTER,
      restart: Phaser.Input.Keyboard.KeyCodes.R,
    });
    // Пробел и стрелки не должны скроллить страницу под игрой
    kb.addCapture([
      Phaser.Input.Keyboard.KeyCodes.SPACE, Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN, Phaser.Input.Keyboard.KeyCodes.LEFT,
      Phaser.Input.Keyboard.KeyCodes.RIGHT,
    ]);
    // Tab и F1 у браузера заняты (фокус, справка) — в бою они наши
    kb.addCapture([
      Phaser.Input.Keyboard.KeyCodes.TAB, Phaser.Input.Keyboard.KeyCodes.F1,
    ]);
    kb.on('keydown', (e) => this._hotkey(e));
  }

  /**
   * Горячие клавиши. Оружие меняется только в свой ход: раньше цифры
   * работали всегда, и в сетевой партии можно было «переключить» ствол
   * сопернику прямо посреди его хода.
   */
  _hotkey(e) {
    const hud = this.hud;
    const key = e.key;
    // Подсказка закрывается любой клавишей, сама клавиша при этом не теряется
    if (hud.helpVisible && key !== 'F1' && key !== 'h' && key !== 'H' && key !== 'р' && key !== 'Р') {
      hud.setHelp(false);
    }
    if (key === 'r' || key === 'R' || key === 'к' || key === 'К') {
      if (this.turn.state === STATE.OVER) this.scene.restart();
      return;
    }
    const code = e.code;
    if (code === 'F1' || code === 'KeyH') { hud.toggleHelp(); return; }
    if (code === 'KeyM') { hud.toggleSound(); return; }
    if (code === 'KeyF') { this.focusCamera(); return; }
    if (code === 'KeyV') { this.rig.toggleOverview(); return; }
    if (code === 'Escape') {
      if (hud.helpVisible) hud.setHelp(false);
      return;   // арсенал закрывается сам (Inventory)
    }

    const mine = this.canPlayerAct();
    if (code === 'Tab') { if (mine || hud.inventory?.isOpen) hud.inventory?.toggle(); return; }
    if (!mine) return;
    const digit = /^Digit(\d)$/.exec(code);
    if (digit) {
      const n = Number(digit[1]);
      this.turn.setWeaponIndex(n === 0 ? 9 : n - 1);
      return;
    }
    if (code === 'KeyQ' || code === 'KeyE') this._cycleWeapon(code === 'KeyE' ? 1 : -1);
  }

  /** Соседний ствол, у которого остались патроны. */
  _cycleWeapon(dir) {
    const n = WEAPONS.length;
    let i = this.turn.weaponIndex;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (this.turn.ammoOf(i) > 0) { this.turn.setWeaponIndex(i); return; }
    }
  }

  // ------------------------------------------------------------------ цикл

  update(time, delta) {
    // Физика идёт по dt самого Phaser, зажатому сверху: редкий тяжёлый кадр
    // не должен телепортировать тела сквозь землю, а замедление под нагрузкой
    // для физики безопаснее пропущенных столкновений.
    const dt = Math.min(delta / 1000, CFG.MAX_DT);

    // Таймер хода, набор силы и поворот прицела считаются по системным часам.
    // Дельта Phaser для этого не годится: он её сглаживает и под нагрузкой
    // отдаёт ровные 16.7 мс на кадр независимо от того, сколько времени
    // реально прошло, — тридцатисекундный ход растянулся бы на минуты.
    const now = performance.now();
    const realDt = this._lastNow ? Math.min((now - this._lastNow) / 1000, 0.25) : 0;
    this._lastNow = now;

    this._handleMovement(dt, realDt);
    // Бот решает и «держит кнопку» до набора силы — оба шага на системных
    // часах, иначе доворот ствола шёл бы в разы медленнее задуманного.
    if (this.isBotTurn()) this.botFor(this.turn.currentTeam).update(realDt);
    this._tickCharge(realDt);
    this._streamMove(realDt);

    for (const w of this.worms) w.update(dt);

    for (const c of this.crates) c.update(dt);
    for (const m of this.mines) m.update(dt);
    if (this.mines.some((m) => !m.alive)) {
      this.mines = this.mines.filter((m) => m.alive);
    }
    this._collectCrates();
    if (this.crates.some((c) => !c.alive)) {
      this.crates = this.crates.filter((c) => c.alive);
    }

    for (const p of this.projectiles) p.update(dt);
    if (this.projectiles.some((p) => !p.alive)) {
      this.projectiles = this.projectiles.filter((p) => p.alive);
    }

    if (this.terrain.dirtyChunks.size) {
      for (const i of this.terrain.dirtyChunks) this.terrainTextures[i].refresh();
      this.terrain.dirtyChunks.clear();
    }

    this._updateCamera(dt, realDt);
    this.aim.update();
    this.turn.update(realDt);
    this.hud.update();
    this.offscreen.update();
    this._updateNetStatus();
  }

  /** Строка «чей ход» в сетевой партии. Переписывается только при смене. */
  _updateNetStatus() {
    if (!this.net?.connected || this.turn.state === STATE.OVER) return;
    const mine = this.turn.currentTeam === this.net.myTeam;
    let text = mine ? 'ваш ход' : 'ход соперника';
    let color = mine ? '#8ef0a0' : '#ffd166';
    if (this.net.peerLost) {
      const left = Math.max(0, Math.ceil(CFG.NET_GONE - this.net.peerSilence));
      text = `соперник не в сети · ждём ${left} с`;
      color = '#ff9a9a';
    }
    if (text !== this.netStatusText) this._netStatus(text, color);
  }

  /**
   * Свой ход — сопернику вживую: где боец, куда целится, сколько набрал.
   * Раз в сто миллисекунд и только если что-то поменялось; иначе зритель
   * видел бы соперника застывшим до самого выстрела.
   */
  _streamMove(realDt) {
    const net = this.net;
    if (!net?.connected || this.turn.currentTeam !== net.myTeam) return;
    if (this.turn.state !== STATE.AIM || this.replaying) return;
    if (this.landing()) return;   // десант каждый сажает сам
    this._moveClock += realDt;
    if (this._moveClock < 0.1) return;
    this._moveClock = 0;
    const m = captureMove(this);
    if (!m) return;
    const key = JSON.stringify(m);
    if (key === this._lastMove) return;
    this._lastMove = key;
    net.sendMove(m);
  }

  /**
   * Ждать ли ход соперника дальше. Ждём всегда — за него не играем: раньше
   * через двадцать секунд клиент продолжал один, и партии расходились
   * навсегда. Потерянный снимок ловится по номеру хода в пинге, а не по
   * таймеру. Если соперника нет NET_GONE секунд — партия наша.
   */
  holdForPeer() {
    const net = this.net;
    if (!net?.connected) return false;
    if (net.peerLost && net.peerSilence >= CFG.NET_GONE) { this.onPeerGone(); return false; }
    return true;
  }

  /**
   * Итог — серверу. Локальный расчёт уже на экране как предварительный;
   * ответ сервера дописывает строку: засчитано, ждём соперника или бой без
   * рейтинга. Только в Telegram: анонима сервер подтвердить не может.
   */
  _reportToServer(won, ratingText, leagueText) {
    if (!serverAvailable() || !this.net?.opponent?.id) return;
    const me = player();
    const before = me.rating;
    ratingText.setText(`${ratingText.text} · отправляю…`);
    reportResult({ room: this.room, seed: this.seed, opponent: this.net.opponent.id, won })
      .then((res) => {
        if (!ratingText.active) return;
        const now = player();
        const base = `рейтинг ${now.rating}`;
        if (res?.status === 'confirmed') {
          const d = res.delta ?? now.rating - before;
          ratingText.setText(`${base} (${d >= 0 ? '+' : ''}${d}) · засчитано`);
        } else if (res?.status === 'pending') {
          ratingText.setText(`${base} · ждём отчёт соперника`);
        } else if (res?.status === 'unrated') {
          ratingText.setText(`${base} · без рейтинга: соперник не из Telegram`);
        } else if (res?.status === 'disputed') {
          ratingText.setText(`${base} · итоги разошлись, бой не засчитан`);
        } else {
          ratingText.setText(`${base} · сервер недоступен, засчитано локально`);
        }
        leagueText.setColor(leagueOf(now.rating).text);
      });
  }

  /** Соперник так и не вернулся: победа оставшемуся. */
  onPeerGone() {
    if (this.turn.state === STATE.OVER) return;
    this.fx.banner('соперник не вернулся', '#ff9a9a', 2600);
    this.turn._gameOver(this.net.myTeam);
  }

  _handleMovement(dt, realDt) {
    const w = this.turn.activeWorm;
    if (!this.canPlayerAct() || !w || !w.alive) {
      this.moveInput.jumpQueued = false;
      // Гасим только заряд игрока: у бота он набирается своим чередом,
      // и сброс тут оставил бы его держать кнопку вечно.
      if (this.charging && !this.isBotTurn()) this.cancelCharge();
      return;
    }
    const k = this.keys;
    const left = this.moveInput.left || k.left.isDown || k.a.isDown;
    const right = this.moveInput.right || k.right.isDown || k.d.isDown;

    if (left !== right) {
      w.walk(left ? -1 : 1, dt);
      this.rig.manual = false; // пошли — камера снова ведёт бойца
    }

    const jump = this.moveInput.jumpQueued || Phaser.Input.Keyboard.JustDown(k.jump);
    if (jump) w.jump();
    this.moveInput.jumpQueued = false;

    // Угол прицела
    const up = this.moveInput.aimUp || k.up.isDown || k.w.isDown;
    const down = this.moveInput.aimDown || k.down.isDown || k.s.isDown;
    if (up !== down) this.adjustAim((up ? 1 : -1) * CFG.AIM_ANGLE_RATE * realDt);

    // Сила: держим «Огонь» — шкала набирается, отпустили — выстрел.
    // Состояние читаем опросом, а не событиями: так тач-кнопка и пробел
    // не могут разъехаться по порядку событий.
    const pressed = this.moveInput.fire || k.fire.isDown || this.mouseFire;
    if (pressed && !this.charging) this.beginCharge();
    else if (!pressed && this.charging) this.releaseCharge();
  }

  /**
   * Набор силы вынесен из обработки ввода: шкалу копит и игрок, держащий
   * «Огонь», и бот, который её «держит» из своего кода.
   */
  _tickCharge(realDt) {
    if (!this.charging) return;
    if (!this.canAct()) { this.cancelCharge(); return; }
    const step = Math.min(realDt, CFG.CHARGE_MAX_DT);
    this.charge = Math.min(1, this.charge + step / CFG.CHARGE_TIME);
    if (this.charge >= 1) this.releaseCharge();
  }

  // ------------------------------------------------------- прицел и заряд

  adjustAim(delta) {
    this.aimAngle = Phaser.Math.Clamp(
      this.aimAngle + delta, -CFG.AIM_ANGLE_LIMIT, CFG.AIM_ANGLE_LIMIT,
    );
  }

  /** Единичный вектор выстрела с учётом того, куда смотрит боец. */
  aimDirection() {
    const w = this.turn.activeWorm;
    const face = w ? w.facing : 1;
    return { x: Math.cos(this.aimAngle) * face, y: -Math.sin(this.aimAngle) };
  }

  beginCharge() {
    if (!this.canAct()) return;      // заряд набирает и бот, той же кнопкой
    this.charging = true;
    this.charge = 0;
  }

  cancelCharge() {
    this.charging = false;
    this.charge = 0;
  }

  releaseCharge() {
    if (!this.charging) return;
    const power = this.charge;
    this.charging = false;
    this.charge = 0;
    // Слишком короткое нажатие — скорее всего задели случайно, ход не тратим
    if (power < CFG.CHARGE_MIN) return;
    const d = this.aimDirection();
    const speed = power * CFG.AIM_MAX_POWER;
    this.fireActiveWorm(d.x * speed, d.y * speed);
  }

  /** Сброс прицела в начале хода. */
  resetAim() {
    this.aimAngle = CFG.AIM_ANGLE_START;
    this.cancelCharge();
    this.mouseFire = false;
    this.remoteAim = false;
    this.remoteCharge = 0;
    this._lastMove = '';
  }

  _updateCamera(dt, realDt) {
    const flying = this.turn.state === STATE.FLYING && this.projectiles.length > 0;
    this.rig.update(dt, realDt, this._cameraTarget(), flying ? 'center' : 'deadzone');
  }

  /** За кем камера следит сейчас: за снарядом в полёте, иначе за бойцом. */
  _cameraTarget() {
    if (this.turn.state === STATE.FLYING && this.projectiles.length) {
      return this.projectiles[0];
    }
    if (this.turn.activeWorm) return this.turn.activeWorm;
    return this.followTarget;
  }

  /** Кнопка «к бойцу»: снимает ручной режим и мгновенно наводится на цель. */
  focusCamera() {
    this.rig.focus(this._cameraTarget());
  }

  /**
   * Кадрирование в начале хода: показываем бойца и, если влезает,
   * ближайшего противника — чтобы было видно, по кому стрелять.
   */
  frameTurn(worm) {
    const enemies = this.worms.filter((w) => w.alive && w.team !== worm.team);
    let center = worm.x;
    if (enemies.length) {
      const near = enemies.reduce((a, b) =>
        (Math.abs(b.x - worm.x) < Math.abs(a.x - worm.x) ? b : a));
      // Оба влезают в кадр — центрируем между ними, иначе держим бойца
      if (Math.abs(near.x - worm.x) < this.rig.visibleW - 260) {
        center = (worm.x + near.x) / 2;
      }
    }
    this.rig.frame(center, worm.centerY);
  }

  /** Сброс ящика в начале хода. */
  maybeDropCrate() {
    if (this.crates.length >= CFG.CRATE_MAX) return;
    if (this.turnRng() > (this.rules.crateChance ?? CFG.CRATE_CHANCE)) return;

    const spots = [];
    for (let x = 200; x < CFG.WORLD_W - 200; x += 24) {
      if (this.terrain.isSpawnable(x)) spots.push(x);
    }
    if (!spots.length) return;

    const kind = this.turnRng() < CFG.CRATE_HEALTH_CHANCE ? 'health' : 'weapon';
    this.crates.push(new Crate(this, this.turnRng.pick(spots), kind));
  }

  /** Боец, наступивший на ящик, забирает его. */
  _collectCrates() {
    for (const c of this.crates) {
      if (!c.alive) continue;
      for (const w of this.worms) {
        if (!w.alive || !c.overlapsWorm(w)) continue;
        this._takeCrate(c, w);
        break;
      }
    }
  }

  _takeCrate(crate, worm) {
    crate.destroy();
    if (crate.kind === 'health') {
      worm.heal(CFG.CRATE_HEALTH);
      this.fx.pickup(crate.x, crate.y, `+${CFG.CRATE_HEALTH} здоровья`, '#7de07d');
    } else {
      const i = this.turn.randomCrateWeapon(this.turnRng);
      const w = WEAPONS[i];
      this.turn.addAmmo(i, w.crateAmmo, worm.team);
      this.fx.pickup(crate.x, crate.y, `${w.name} +${w.crateAmmo}`, '#ffd166');
    }
  }

  // -------------------------------------------------------------- геймплей

  /**
   * Можно ли сейчас действовать вообще — этим пользуется и бот.
   * Ход чужой команды в сети сюда не попадает: там действует соперник.
   */
  canAct() {
    if (this.turn.state !== STATE.AIM) return false;
    if (this.replaying) return false;         // идёт показ чужого хода
    if (this.landing()) return false;          // десант ещё в воздухе
    // В сетевой партии ходит только тот, чья команда сейчас на очереди
    if (this.net?.connected && this.net.myTeam !== this.turn.currentTeam) return false;
    return true;
  }

  /** Кто-то ещё спускается на парашюте: ход не начинается и часы стоят. */
  landing() {
    return this.worms.some((w) => w.alive && w.parachuting);
  }

  /**
   * Можно ли действовать игроку. Отличается от canAct ровно одним: пока
   * ходит бот, кнопки и клавиши молчат — иначе игрок «помогал» бы ему
   * целиться, и ход уходил бы в никуда.
   */
  canPlayerAct() {
    return this.canAct() && !this.isBotTurn();
  }

  /**
   * Ждём ли мы сейчас хода соперника. Пока ждём, очередь не двигаем сами:
   * её передаёт тот, кто ходил. Победа — исключение, её видно обоим.
   */
  awaitingPeer() {
    if (!this.net?.connected) return false;
    if (this.turn.currentTeam === this.net.myTeam) return false;
    return this.checkVictory() === null;
  }

  setWind(v) { this.wind = v; }

  /**
   * Новый поток случайности на ход. Журнал взрывов здесь не трогаем: он
   * доживает до снимка, который уходит уже после передачи очереди.
   */
  beginTurnRandom(turnNumber) {
    this.turnRng = subRng(this.seed, turnNumber);
  }

  setCameraManual(on) { this.rig.manual = on; this.rig.idle = 0; }

  /** Выстрел активного бойца. Ход сразу переходит дальше. */
  fireActiveWorm(vx, vy) {
    const w = this.turn.activeWorm;
    // Показ чужого хода идёт мимо проверки прав: приказ уже состоялся
    // у соперника, наше дело — повторить его на экране.
    const allowed = this.replaying ? this.turn.state === STATE.AIM : this.canAct();
    // Во время отхода от собственного заряда стрелять нельзя: иначе мина
    // превращалась бы в бесплатную добавку к обычному выстрелу.
    if (!allowed || this.turn.retreating || !w || !w.alive) return;

    const len = Math.hypot(vx, vy) || 1;
    const nx = vx / len, ny = vy / len;

    // Точка вылета не должна оказаться внутри земли (например, при выстреле
    // вниз себе под ноги) — иначе снаряд «просочится» сквозь ландшафт.
    const ray = this.terrain.raycast(
      w.x, w.centerY,
      w.x + nx * CFG.MUZZLE_OFFSET, w.centerY + ny * CFG.MUZZLE_OFFSET,
    );
    const sx = ray.hit ? ray.freeX : ray.x;
    const sy = ray.hit ? ray.freeY : ray.y;

    w.facing = nx >= 0 ? 1 : -1;
    // Приказ уходит наружу до симуляции: сеть должна получить ровно то,
    // что игрок задал, а не то, что из этого вышло локально.
    if (!this.replaying) {
      const cmd = captureCommand(this, vx, vy);
      this.onShot?.(cmd);
      this.net?.sendShot(cmd);
    }
    this.fx.sound('shot');
    const shots = this.turn.weapon.fire(this, sx, sy, vx, vy, w);
    this.projectiles.push(...shots);
    this.turn.onFired();
    this.setCameraManual(false);
    this.followTarget = shots[0] ?? w;
  }

  /**
   * Взрыв: стираем круг из маски, раздаём урон по расстоянию от центра
   * и отбрасываем бойцов вектором от эпицентра.
   */
  explode(x, y, cfg, owner = null) {
    // Во время показа чужого хода взрыв только рисуется: землю и урон
    // принесёт авторитетный снимок состояния, иначе применится дважды.
    if (this.replaying) {
      this.fx.explosion(x, y, cfg.radius);
      this.rig.shake(220, cfg.shake ?? 0.006);
      return;
    }
    // Воронку режем ровно по целым: у соперника она восстанавливается из
    // журнала, а он целочисленный — на дробных координатах края круга
    // разъезжались бы на пиксель, и земля переставала совпадать.
    const ix = Math.round(x), iy = Math.round(y);
    this.explosionLog.push({ x: ix, y: iy, r: cfg.radius });
    this.explosionHistory.push({ x: ix, y: iy, r: cfg.radius });
    this.terrain.destroyCircle(ix, iy, cfg.radius);
    this.fx.explosion(x, y, cfg.radius);
    this.rig.shake(220, cfg.shake ?? 0.006);

    for (const c of this.crates) {
      if (c.alive && Math.hypot(c.x - x, c.y - c.h / 2 - y) <= cfg.damageRadius) c.destroy();
    }

    // Мина рядом со взрывом детонирует — так получаются цепочки.
    // Подрываем через таймер, а не тут же: рекурсия из explode в explode
    // на длинной цепочке ушла бы в стек.
    for (const m of this.mines) {
      if (!m.alive || Math.hypot(m.x - x, m.y - y) > cfg.damageRadius) continue;
      m.fuse = 0.12;
      m.armed = true;
    }

    for (const w of this.worms) {
      if (!w.alive) continue;
      const wx = w.x, wy = w.centerY;
      const d = Math.hypot(wx - x, wy - y);
      if (d > cfg.damageRadius) continue;

      const f = 1 - d / cfg.damageRadius;      // линейный спад от центра
      const dmg = Math.round(cfg.damage * f);

      let nx, ny;
      if (d < 1) { nx = 0; ny = -1; } else { nx = (wx - x) / d; ny = (wy - y) / d; }
      w.applyImpulse(nx * cfg.knockback * f, ny * cfg.knockback * f - 70 * f);

      w.damage(dmg, 'взрыв');
    }
  }

  /**
   * След мгновенного выстрела: у дробовика и биты снаряда нет, и без
   * линии игрок не понимает, куда вообще пришёлся удар.
   */
  drawBeam(x0, y0, x1, y1, color = 0xffe066) {
    const g = this.rig.world(this.add.graphics().setDepth(DEPTH.PROJECTILE));
    g.lineStyle(3, color, 0.9).lineBetween(x0, y0, x1, y1);
    g.lineStyle(9, color, 0.25).lineBetween(x0, y0, x1, y1);
    this.tweens.add({
      targets: g, alpha: 0, duration: 260, onComplete: () => g.destroy(),
    });
  }

  /** Поставить мину. Оружие само её не хранит — предмет живёт в сцене. */
  addMine(x, y, weapon, owner) {
    this.mines.push(new Mine(this, x, y, weapon, owner));
  }

  /** Ход отыгран и очередь передана — отдаём второму игроку итог. */
  onTurnResolved(actedTeam) {
    this.net?.sendState(actedTeam);
    this.explosionLog = [];
  }

  onWormDied(worm) {
    this.fx.explosion(worm.x, worm.centerY, 26);
    // Тоже по целым: у соперника гибель приходит снимком с целыми координатами
    this.terrain.destroyCircle(Math.round(worm.x), Math.round(worm.centerY), 22);
    this.rig.shake(160, 0.004);
    // Ход обрывается, если погиб тот, кто ходит, либо если команда выбита
    // целиком — иначе победа ждала бы истечения 30-секундного таймера.
    if (this.turn.state === STATE.AIM
      && (this.turn.activeWorm === worm || this.checkVictory() !== null)) {
      this.turn.endTurn();
    }
  }

  teamAlive(team) {
    return this.worms.some((w) => w.team === team && w.alive);
  }

  /**
   * Итог миссии по её задаче. У кампании победа не всегда «выбить всех»:
   * бывает «продержаться», «без потерь», «уложиться в N ходов».
   * @returns {'win'|'lose'|null}
   */
  missionOutcome() {
    if (this.match.mode !== 'campaign') return null;
    const mission = MISSION_BY_ID[this.match.missionId];
    if (!mission?.objective) return null;
    return checkObjective(mission.objective, snapshot({
      turn: this.turn.turnNumber,
      playerTeam: this.myTeamIndex,
      worms: this.worms,
      teams: this.match.teams,
    }));
  }

  /** null — играем дальше; иначе индекс победившей команды или -1 (ничья). */
  checkVictory() {
    // Задача миссии решает раньше обычного «кого выбили»
    const outcome = this.missionOutcome();
    if (outcome === 'win') return this.myTeamIndex;
    if (outcome === 'lose') return this.myTeamIndex === 0 ? 1 : 0;

    const alive = [];
    for (let t = 0; t < CFG.TEAMS; t++) if (this.teamAlive(t)) alive.push(t);
    if (alive.length === 1) return alive[0];
    if (alive.length === 0) return -1;
    return null;
  }

  /** Команда, за которую играет этот человек: своя в сети, иначе первая. */
  get myTeamIndex() {
    if (this.net?.connected && this.net.myTeam !== null) return this.net.myTeam;
    return this.match.teams.findIndex((t) => t.control !== 'bot');
  }

  onGameOver(winner) {
    if (this.gameOverUi) return;

    // Где есть бот или сеть, «победа красных» ничего не говорит: важно,
    // выиграл ли ты. В хотсите наоборот — команды равноправны.
    const solo = this.bots?.some(Boolean) || this.net?.connected;
    const mine = this.myTeamIndex;
    let text;
    if (winner < 0) text = 'Ничья';
    else if (solo) text = winner === mine ? 'Победа!' : 'Поражение';
    else text = `Победа: ${TEAM_NAMES[winner]}!`;
    const color = winner >= 0 ? TEAM_COLORS[winner] : 0xffffff;

    if (this.match.mode === 'campaign' && winner === mine) markDone(this.match.missionId);
    // Партия доиграна: запись сессии больше не нужна
    this.net?.forget();
    this.fx.sound(winner === mine ? 'victory' : 'defeat');
    haptic(winner === mine ? 'win' : 'lose');
    // Первая доигранная партия — момент предложить иконку на экран Домой.
    // Чуть позже итога, чтобы не перекрыть его; Telegram покажет своё окно.
    // Реальные часы, а не игровые: игровой шаг Phaser ограничен 17 мс за
    // кадр, и на слабом рендере полторы игровые секунды тянутся десятки
    // реальных. Иконка к кадрам отношения не имеет.
    setTimeout(() => offerHomeScreenOnce(), 1500);

    // Рейтинг двигается только в сетевом бою: против бота и в хотсите
    // очков не бывает, иначе их можно было бы «нафармить» о самого себя.
    let ratingLine = '';
    let leagueLine = '';
    if (this.net?.connected && winner >= 0 && this.net.opponent) {
      const me = player();
      const before = leagueOf(me.rating);
      const delta = eloDelta(me.rating, this.net.opponent.rating, winner === mine);
      const after = recordResult(winner === mine, delta);
      ratingLine = `рейтинг ${after.rating} (${delta >= 0 ? '+' : ''}${delta})`;

      // Смена лиги — главное событие боя, ради него и играют: её показываем
      // отдельной строкой, а не оставляем считать в уме по числу рейтинга.
      const now = leagueOf(after.rating);
      if (now.id !== before.id) {
        leagueLine = delta > 0
          ? `Новая лига: ${now.name}`
          : `Лига потеряна: теперь ${now.name}`;
      } else {
        const left = toNextLeague(after.rating);
        leagueLine = left === null
          ? `${now.name} — выше некуда`
          : `${now.name} · до «${nextLeague(after.rating).name}» ещё ${left}`;
      }
    }

    const shade = this.rig.ui(this.add.rectangle(0, 0, CFG.VIEW_W, CFG.VIEW_H, 0x070b14, 0.55)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 10));
    const title = this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 - 28, text,
      font(46, 800, `#${color.toString(16).padStart(6, '0')}`))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11);
    this.rig.ui(title);
    // В сети рестарт врозь развалил бы синхронность, поэтому там оба
    // возвращаются в лобби; в кампании — к списку миссий.
    const backToMenu = this.match.mode !== 'quick';
    if (ratingLine) {
      const ratingText = this.rig.ui(this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 + 12, ratingLine,
        font(20, 800, UI.accent)).setOrigin(0.5).setScrollFactor(0)
        .setDepth(DEPTH.HUD + 11));
      const leagueText = this.rig.ui(this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 + 38, leagueLine,
        font(14, 800, leagueOf(player().rating).text)).setOrigin(0.5).setScrollFactor(0)
        .setDepth(DEPTH.HUD + 11));
      this._reportToServer(winner === mine, ratingText, leagueText);
    }
    const sub = this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 + (ratingLine ? 68 : 32),
      backToMenu ? 'тап — в меню' : 'тап или R — новая карта',
      font(18, 700, UI.textDim))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11);
    this.rig.ui(sub);

    this.gameOverUi = [shade, title, sub];

    // В сетевом бою тапом никуда не уходим: там есть выбор — реванш или
    // меню, — и случайное касание не должно решать за игрока.
    if (this.net?.connected) {
      sub.setText('реванш начнётся, когда согласятся оба');
      this.gameOverUi.push(this._overButton(-120, 'Реванш', () => {
        this.net.wantRematch();
        sub.setText('ждём соперника…');
      }));
      this.gameOverUi.push(this._overButton(120, 'В меню', () => this.toMenu()));
      return;
    }

    this.time.delayedCall(600, () => {
      this.input.once('pointerdown', () => (backToMenu ? this.toMenu() : this.scene.restart()));
    });
  }

  /** Кнопка на затемнении итога. */
  _overButton(dx, label, onTap) {
    const w = 220, h = 58;
    const x = CFG.VIEW_W / 2 + dx, y = CFG.VIEW_H / 2 + 100;
    ensureButton(this, `ui-over-${w}x${h}`, w, h, dx < 0 ? 'primary' : 'normal');
    const img = this.rig.ui(this.add.image(x, y, `ui-over-${w}x${h}`)
      .setScrollFactor(0).setDepth(DEPTH.HUD + 12));
    img.setInteractive({ useHandCursor: true });
    img.on('pointerup', onTap);
    const text = this.rig.ui(this.add.text(x, y, label, font(20, 800))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 13));
    this.gameOverUi?.push(text);
    return img;
  }

  /** Соперник нажал реванш раньше нас — покажем это. */
  onPeerRematch() {
    this.fx.banner('соперник хочет реванш', '#8ef0a0', 2200);
  }

  /** Выход в меню: сетевую сессию рвём, иначе она переживёт партию. */
  toMenu() {
    // Вышли сами — возвращаться в эту партию не предложим
    this.net?.forget();
    this.net?.destroy();
    this.registry.set('net', null);
    this.registry.set('seed', null);
    if (new URLSearchParams(location.search).has('room')) {
      const url = new URL(location.href);
      url.searchParams.delete('room');
      history.replaceState(null, '', url);
    }
    this.scene.start('Menu');
  }

  _shutdown() {
    this.game.events.off('worms-resize', this.relayout, this);
    globalThis.document?.body.classList.remove('in-battle');
    setBattle(false);
    this.input?.setDefaultCursor?.('default');
    this.mouseFire = false;
    this.mines = [];
    this.aim?.destroy();
    this.crates = [];
    this.rig?.destroy();
    this.offscreen?.destroy();
    this.projectiles = [];
    this.worms = [];
  }
}
