import { CFG, DEPTH, TEAM_COLORS, TEAM_NAMES, canvasSize, applyWorld } from '../config.js';
import { makeRng, subRng } from '../core/rng.js';
import { BIOMES, pickBiome } from '../core/biomes.js';
import { pickShape, shapeRng, towerVariant } from '../core/shapes.js';
import { Terrain } from '../core/Terrain.js';
import { TurnManager, STATE } from '../core/TurnManager.js';
import { has, meta } from '../core/assets.js';
import { Worm } from '../entities/Worm.js';
import { Crate } from '../entities/Crate.js';
import { Mine } from '../entities/Mine.js';
import { Spring } from '../entities/Spring.js';
import { Props } from '../entities/Props.js';
import { Monster, isBoss } from '../entities/Monster.js';
import { Ambience } from '../ui/Ambience.js';
import { Affixes, DEFAULT_AFFIXES } from '../entities/Affixes.js';
import { Hud, TOP_H } from '../ui/Hud.js';
import { Fx } from '../ui/Fx.js';
import { AimController } from '../ui/AimController.js';
import { font, UI, ensureButton } from '../ui/theme.js';
import { WEAPONS } from '../weapons/index.js';
import { captureCommand, captureMove } from '../net/protocol.js';
import { NetSession } from '../net/session.js';
import { knock } from '../net/lobby.js';
import { randomRoom, copyText } from '../net/transport.js';
import { isCasualRoom, isTournamentRoom } from '../net/rooms.js';
import { makeTransport } from '../net/connect.js';
import {
  startRoom, forgetStartRoom, shareRoom, haptic, inviteLink, setBattle,
  refLink, shareLink,
} from '../platform/telegram.js';
import { HOTSEAT, towerMatch, challengeMatch, ascentMatch } from '../core/match.js';
import { ASCENT } from '../campaign/ascent.js';
import { markAscentDone } from '../platform/ascent.js';
import { markWon } from '../platform/onboard.js';
import { Bot } from '../ai/Bot.js';
import { markDone, MISSION_BY_ID, loadProgress } from '../campaign/missions.js';
import { ASCENT_BY_ID } from '../campaign/ascent.js';
import { checkObjective, snapshot, objectiveText } from '../campaign/objectives.js';
import { player, eloDelta, recordResult } from '../platform/player.js';
import { reportResult, serverAvailable, track, trackStep, submitDailyTower } from '../net/server.js';
import { leagueOf, nextLeague, toNextLeague } from '../platform/league.js';
import { OffscreenMarkers } from '../ui/OffscreenMarkers.js';
import { SKIN_BY_ID, rivalSkin } from '../core/skins.js';
import { equippedSkin, syncCampaignBoxes } from '../platform/skins.js';
import { myCosmetics } from '../platform/cosmetics.js';
import { DEFAULTS as DEFAULT_COS } from '../core/cosmetics.js';
import { recordBattle } from '../platform/daily.js';
import { TASK_BY_ID, FIRST_CLEAR_COINS } from '../core/daily.js';
import { EMOTE_BY_ID, EMOTE_COOLDOWN } from '../core/emotes.js';
import { CHALLENGES, CHALLENGE_BY_ID, starsFor } from '../campaign/challenges.js';
import { saveChallenge } from '../platform/challenges.js';
import { grantCoins } from '../platform/daily.js';
import { CameraRig } from '../ui/CameraRig.js';
import { Coach } from '../ui/Coach.js';
import { voice } from '../audio/Voice.js';
import { askText, closeOverlay } from '../ui/Overlay.js';
import { isDesktop, aimScheme } from '../platform/device.js';


// Тяжесть и длина троса без правил партии: космос их меняет на один бой
const BASE_GRAVITY = CFG.GRAVITY;
const BASE_HOOK_RANGE = CFG.HOOK_RANGE;

export default class GameScene extends Phaser.Scene {
  constructor() { super('Game'); }

  create() {
    // Что за партия — решает меню. Прямой заход по адресу описания не даёт,
    // и тогда игра ведёт себя как раньше: обычный хотсит на одном устройстве.
    this.match = this.registry.get('match') ?? HOTSEAT;
    this.overButtons = null;
    this.myTurns = 0;            // своих ходов — для звёзд испытаний
    // Счётчики боя для ежедневных заданий: только за свою команду
    this.battleStats = { hits: 0, damage: 0, kills: 0, hooks: 0, crates: 0, grenadeHits: 0 };
    this.rules = this.match.rules ?? {};
    this.turnTime = this.rules.turnTime ?? CFG.TURN_TIME;

    // Зерно задаётся снаружи (сеть, ?seed= в адресе) либо разыгрывается.
    // От него полностью зависят карта, расстановка и всё, что случайно.
    this.seed = this._chooseSeed();
    this.rng = makeRng(this.seed);
    this.turnRng = subRng(this.seed, 0);
    // Форма карты: из миссии или меню, иначе случайная от зерна (в сети у
    // обоих одна). Кампания без поля shape — всегда остров, как и была.
    // Выбирается первой: от формы зависят размеры мира, а от них — всё.
    this.shape = pickShape(this.seed,
      this.match.shape ?? (this.match.mode === 'campaign' ? 'island' : null));
    applyWorld(this.shape.world);
    // Вид башни (ледяная, лавовая, ветреная) — от зерна, у обоих в сети один.
    // Его правило ложится поверх правил партии; миссия может задать свой
    this.variant = this.shape.id === 'tower'
      ? towerVariant(this.seed, this.match.variant ?? new URLSearchParams(location.search).get('variant'))
      : null;
    if (this.variant) {
      const v = this.variant.rules;
      this.rules = { ...this.rules, ...v, flood: 'flood' in v ? v.flood : this.rules.flood };
    }
    // Тяжесть и длина троса — от правил (космос); иначе как всегда.
    // CFG общий на всю игру, поэтому выставляем каждый раз заново
    CFG.GRAVITY = BASE_GRAVITY * (Number(this.rules.gravity) || 1);
    CFG.HOOK_RANGE = BASE_HOOK_RANGE * (Number(this.rules.hookRange) || 1);
    // Крюк-трос: сколько раз за ход. Ноль — крюка в партии нет. Вместе с
    // ним приходит и новая схема под палец: рогатка, тап, любая ориентация
    this.hookPerTurn = Math.max(0, Number(this.rules.hook) || 0);
    this.hooksLeft = this.hookPerTurn;
    this.sling = this.hookPerTurn > 0;
    // Схема прицела на башне — выбор игрока: рогатка (по умолчанию) или
    // прежние кнопки угла и «Огонь». Раскладка экрана от неё не зависит
    this.slingAim = this.sling && aimScheme() === 'sling';
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
    this.springs = [];
    this.monsters = [];
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
    this._applyBaseZoom();

    const biome = this._chooseBiome();

    this._buildSky(biome);
    this._buildTerrain(biome);
    this._buildWater(biome);

    this.fx = new Fx(this);
    this.hud = new Hud(this);
    this.turn = new TurnManager(this);
    this.aim = new AimController(this);
    this.offscreen = new OffscreenMarkers(this);
    // Новичок: пошаговая тренировка поверх «Первого выстрела»
    this.coach = this.match.tutorial && this.slingAim && !isDesktop() ? new Coach(this) : null;

    this._spawnWorms();
    this._spawnMonsters();
    // Эмодзи на башне: фон и ломкие предметы на этажах — от зерна, у всех одни
    if (this.terrain.tops) {
      this.props = new Props(this, this.seed, this.variant?.id ?? 'classic', { painted: !!this.bgImage })
        .build([...this.worms, ...this.monsters].map((w) => ({ x: w.x, y: w.y })));
      // Атмосфера вида башни: дальний фон, частицы, события между ходами
      this.ambience = new Ambience(this, this.variant?.id ?? 'classic', this.seed, { painted: !!this.bgImage });
      // Аффиксы: свои у уровня, иначе — по виду башни. Только без сети
      const ids = this.match.affixes ?? DEFAULT_AFFIXES[this.variant?.id] ?? [];
      this.affixes = new Affixes(this, ids, this.seed);
      this.affixes.announce();
    }
    this._setupKeyboard();
    this._setupBots();
    this._applyAmmoRules();

    this.rig.bgCam.setBackgroundColor(biome.fallback.sky[1]);
    // Первым ходит человек: отдавать первый ход боту в миссии — почти то же,
    // что начать её с потери бойца.
    this.turn.begin(this._firstTeam());

    this._setupNet();
    if (this.variant?.intro) {
      this.time.delayedCall(this.match.fallback ? 3200 : 500,
        () => this.fx.banner(this.variant.intro, '#ffd166', 2600, null));
    }
    if (this.match.fallback) {
      this.time.delayedCall(400, () => this.fx.banner('Соперник не нашёлся — бой с ботом, без рейтинга', '#ffd166', 2600, null));
    }
    // Экран может поменять размер прямо посреди партии: повернули телефон,
    // уехала панель браузера. Логический размер тогда пересчитывается, и
    // интерфейс надо разложить заново.
    this.game.events.on('worms-resize', this.relayout, this);
    this.events.once('shutdown', this._shutdown, this);

    // Обычный бой ландшафтный: в портрете страница показывает «поверни
    // телефон», а Telegram держит ландшафт. Арена с крюком играется как
    // угодно — ни просьбы, ни фиксации. Меню всего этого не касается.
    if (!this.sling) {
      globalThis.document?.body.classList.add('in-battle');
      setBattle(true);
    }
    // На ПК над полем — перекрестие: сразу видно, что курсор и есть прицел
    if (isDesktop()) this.input.setDefaultCursor('crosshair');
  }

  /** Пересобрать всё, что считалось от размера экрана. */
  relayout() {
    this.rig.resize();
    this._applyBaseZoom();
    const [cw, ch] = canvasSize();
    this.skyImage?.setDisplaySize(cw, Math.max(this.skyHeight ?? 0, ch));
    this._fitBg();
    this._buildBarBacking();

    // HUD проще собрать заново, чем двигать полсотни объектов поштучно
    const help = this.hud.helpVisible;
    this.hud.destroy();
    this.hud = new Hud(this);
    this.hud.setHelp(help);
    this.hud.setWeaponIndex(this.turn.weaponIndex);
    if (this.room) this._netStatus();
  }

  /**
   * Обычный масштаб партии. На широкой карте это 1. Башня уже экрана в
   * ландшафте и шире — в портрете: там отдаляемся ровно настолько, чтобы
   * она влезла по ширине, и тогда в вертикальном телефоне видна вся арена.
   */
  _applyBaseZoom() {
    const rig = this.rig;
    rig.baseZoom = this.shape.world
      ? Phaser.Math.Clamp(rig.W / CFG.WORLD_W, 0.6, 1)
      : 1;
    rig.setZoom(rig.baseZoom);
    if (this.turn?.activeWorm) rig.focus(this.turn.activeWorm);
  }

  /**
   * Лист бойца для команды. Свои бойцы — в надетом скине; соперник по
   * сети — в своём (он присылает его при знакомстве); бот и сосед по
   * телефону — в каком-нибудь другом, одном на всю партию.
   */
  skinFor(team) {
    const mine = equippedSkin();
    // myTeam переживает перезапуск сцены, поэтому верим ему только в сети
    const net = this.registry.get('net');
    const myTeam = (net && this.myTeam != null)
      ? this.myTeam
      : Math.max(0, this.match.teams.findIndex((t) => t.control !== 'bot'));
    if (team === myTeam) return mine.sheet;
    const theirs = this.registry.get('net')?.opponent?.skin;
    const id = SKIN_BY_ID[theirs] ? theirs : rivalSkin(this.seed, team, mine.id);
    return SKIN_BY_ID[id].sheet;
  }

  /** Украшения команды: свои — надетые, соперник по сети — присланные, остальные — обычные. */
  cosmeticsFor(team) {
    const net = this.registry.get('net');
    const myTeam = (net && this.myTeam != null)
      ? this.myTeam
      : Math.max(0, this.match.teams.findIndex((t) => t.control !== 'bot'));
    if (team === myTeam && this.match.teams[team]?.control !== 'bot') return myCosmetics();
    return net?.opponent?.cos ?? DEFAULT_COS;
  }

  // ------------------------------------------------------------ эмоции

  /**
   * Эмоция команды team: боец корчит рожу, над ним пузырь с фразой. Кто
   * говорит — тот, кто сейчас ходит, если это эта команда; иначе первый
   * живой. Своя эмоция по сети уходит и сопернику.
   */
  showEmote(team, id, { send = false } = {}) {
    const e = EMOTE_BY_ID[id];
    if (!e || this.turn?.state === 'over' && !this.gameOverUi) return false;
    const now = performance.now();
    this._emoteAt ??= {};
    if (now - (this._emoteAt[team] ?? 0) < EMOTE_COOLDOWN) return false;
    this._emoteAt[team] = now;
    const active = this.turn?.activeWorm;
    const w = active?.alive && active.team === team ? active : this.worms.find((x) => x.alive && x.team === team);
    if (!w) return false;
    if (send) this.net?.sendEmote(id);
    w.mood = e.pose;
    this.time.delayedCall(1600, () => { if (w.mood === e.pose) w.mood = null; });
    w.squash = -0.8;
    // Эмоция говорит голосом; если голос занят или не загрузился — щелчок
    if (!voice.say(id, { team })) this.fx.sound('select');

    const t = this.add.text(w.x, w.y - CFG.WORM_H - 64, e.text, font(20, 800, '#1a1408'))
      .setOrigin(0.5, 1).setPadding(12, 6, 12, 6).setBackgroundColor('#ffffff')
      .setDepth(DEPTH.FX + 2).setScale(0.3);
    this.rig.world(t);
    this.tweens.add({ targets: t, scale: 1, duration: 220, ease: 'Back.easeOut' });
    this.tweens.add({
      targets: t, alpha: 0, y: t.y - 18, delay: 1500, duration: 350, onComplete: () => t.destroy(),
    });
    // Пузырь едет за бойцом, пока тот двигается
    const follow = () => { if (t.active && w.alive) t.setPosition(w.x, w.y - CFG.WORM_H - 64 - (t.alpha < 1 ? 18 * (1 - t.alpha) : 0)); };
    this.events.on('update', follow);
    t.once('destroy', () => this.events.off('update', follow));
    return true;
  }

  /**
   * Бот тоже корчит рожи: попал по игроку — смеётся, получил — злится или
   * плачет. Не каждый раз, чтобы не надоедало. Только в бою с ботом.
   */
  _botReact(playerHurt) {
    const botTeam = this.match.teams.findIndex((t) => t.control === 'bot');
    if (botTeam < 0 || this.net || Math.random() > 0.4) return;
    const botAttacked = this.turn.currentTeam === botTeam;
    let id = null;
    if (botAttacked && playerHurt) id = 'laugh';
    else if (!botAttacked && !playerHurt) id = Math.random() < 0.5 ? 'angry' : 'cry';
    if (id) this.time.delayedCall(700, () => this.showEmote(botTeam, id));
  }

  // ------------------------------------------------------------ задания

  /** Сейчас ходит моя команда — то, что случится, засчитывается мне. */
  _myStrike() {
    return !this.replaying && !this.isBotTurn() && this.turn?.currentTeam === this.myTeamIndex;
  }

  /** Попадание по чужому бойцу в свой ход. */
  _countHit(worm, dmg) {
    if (!this._myStrike() || worm.team === this.myTeamIndex) return;
    this.battleStats.hits++;
    this.battleStats.damage += dmg;
    if (this.turn.weapon?.id === 'grenade') this.battleStats.grenadeHits++;
  }

  /**
   * Итог боя — в задания и кошелёк. Вдвоём на одном телефоне не считаем:
   * там обе стороны свои, и задания выполнялись бы игрой с самим собой.
   * @returns {{coins:number, done:string[]}|null}
   */
  _recordDaily(won) {
    const solo = this.bots?.some(Boolean) || this.net?.connected;
    if (!solo) return null;
    return recordBattle({
      ...this.battleStats, battles: 1, wins: won ? 1 : 0, online: this.net?.connected ? 1 : 0,
    }, won);
  }

  // ------------------------------------------------------------------ крюк

  /**
   * Куда зацепится трос, если пустить его от бойца в сторону точки (px, py):
   * первая твердь на луче в пределах длины троса.
   * @returns {{x:number, y:number}|null}
   */
  hookAnchor(worm, px, py) {
    const ox = worm.x, oy = worm.centerY;
    const d = Math.hypot(px - ox, py - oy);
    if (d < 6) return null;
    const dx = (px - ox) / d, dy = (py - oy) / d;
    const ray = this.terrain.raycast(ox, oy, ox + dx * CFG.HOOK_RANGE, oy + dy * CFG.HOOK_RANGE);
    if (!ray.hit) return null;
    if (Math.hypot(ray.x - ox, ray.y - oy) < CFG.HOOK_MIN) return null;
    return { x: ray.x, y: ray.y };
  }

  /** Можно ли сейчас пустить крюк (свой ход, крюки остались, не в полёте). */
  canHook() {
    const w = this.turn.activeWorm;
    return this.hooksLeft > 0 && this.canAct() && !!w && w.alive && !w.zip && !this.charging;
  }

  /**
   * Пустить крюк в сторону точки. Промах (не за что зацепиться) крюк не
   * тратит: наказывать за тап в небо незачем.
   */
  tryHook(px, py) {
    if (!this.canHook()) {
      // Молчать нельзя: игрок тапает в стену и не понимает, почему ничего
      if (this.hookPerTurn > 0 && this.hooksLeft <= 0 && this.canPlayerAct()) {
        this.fx.banner('тросы на этот ход кончились', '#ffd166', 900);
      }
      return false;
    }
    const w = this.turn.activeWorm;
    const a = this.hookAnchor(w, px, py);
    if (!a) {
      this.fx.banner('не достаёт', '#ffd166', 700);
      return false;
    }
    this.hooksLeft--;
    if (this._myStrike()) this.battleStats.hooks++;
    if (!this.isBotTurn()) this._countHookUse();
    w.startZip(a.x, a.y);
    w.setActiveMarker(false);
    this.fx.sound('rope');
    if (!this.isBotTurn()) haptic('shot');
    this.setCameraManual(false);
    return true;
  }

  /**
   * Подсказка про трос: пока игрок не пустил его три раза (за все партии),
   * точки, куда можно зацепиться, светятся, а под панелью висит строка.
   * Потом подсказка уходит сама — опытному она только мешает.
   */
  /**
   * Подсказка про рогатку: пока игрок не выстрелил дважды, у бойца ходит
   * «палец» и показывает жест. Сначала учим стрелять, потом — тросу:
   * две подсказки разом на первом ходу только путают.
   */
  get slingHint() {
    if (this.coach) return this.coach.wantsSlingHint;
    if (!this.slingAim) return false;
    if (this._slingUses == null) {
      try { this._slingUses = Number(localStorage.getItem('worms.slingUses')) || 0; } catch { this._slingUses = 0; }
    }
    return this._slingUses < 2;
  }

  get hookHint() {
    if (this.coach) return this.coach.wantsHookHint;
    if (!this.sling || this.slingHint) return false;
    if (this._hookUses == null) {
      try { this._hookUses = Number(localStorage.getItem('worms.hookUses')) || 0; } catch { this._hookUses = 0; }
    }
    return this._hookUses < 3;
  }

  _countHookUse() {
    trackStep('first_hook', { once: true });
    this._hookUses = (this._hookUses ?? 0) + 1;
    try { localStorage.setItem('worms.hookUses', String(this._hookUses)); } catch { /* инкогнито */ }
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
    // Замёрзший боец ход пропускает — и оттаивает
    const fw = this.turn.activeWorm;
    if (fw?.frozen) {
      fw.frozen = false;
      fw.skipping = true;
      this.fx.banner('Заморожен — ход пропущен', '#9fd8ff', 1300);
      const turn = this.turn.turnNumber;
      this.time.delayedCall(1100, () => {
        fw.skipping = false;
        if (this.turn.turnNumber === turn && this.turn.state === STATE.AIM) this.turn.endTurn();
      });
    }
    if (this.turn.currentTeam === this.myTeamIndex) this.myTurns++;
    // Тот, чей ход, подпрыгивает на месте: глаз сразу находит своего
    const active = this.turn.activeWorm;
    if (active) active.squash = -0.9;
    // Твой ход — короткий сигнал в руку: телефон можно не держать перед глазами
    if (this.isLocalTeam(this.turn.currentTeam) && !this.botFor(this.turn.currentTeam)) haptic('turn');
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
      // rules.only: у игрока остаётся только это оружие (испытание «Только граната»)
      if (t.control !== 'bot' && Array.isArray(this.rules.only)) {
        WEAPONS.forEach((w, i) => { if (!this.rules.only.includes(w.id)) this.turn.ammo[team][i] = 0; });
      }
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
    if (this.room) parts.push(`комната ${this.room}${isCasualRoom(this.room) ? ' · без рейтинга' : ''}`);
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
    askText({
      title: 'Игра вдвоём', label: 'Код комнаты друга', placeholder: 'пусто — создать свою',
      maxLength: 10, upper: true, okText: 'Дальше',
      validate: (v) => (!v || /^[A-Z0-9]{4,10}$/.test(v) ? null : 'код — от 4 до 10 букв и цифр'),
    }).then((answer) => {
      if (answer === null) return;
      const room = answer || randomRoom();
      copyText(this.inviteLink(room));
      // Перезаход: сессия поднимается на старте сцены. Адрес всегда сайта:
      // t.me-ссылка внутри игры никуда не ведёт
      const url = new URL(location.href);
      url.searchParams.set('room', room);
      location.href = url.toString();
    });
    return null;
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
    const own = BIOMES.find((b) => b.id === forced) ?? BIOMES.find((b) => b.id === this.variant?.biome);
    if (own) return own;
    // Случайная — из списка вида башни; ГПСЧ расходуется как раньше
    const picked = pickBiome(this.rng);
    const list = this.variant?.biomes;
    if (!list?.length) return picked;
    return BIOMES.find((b) => b.id === list[BIOMES.indexOf(picked) % list.length]) ?? picked;
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

    // Нарисованный фон места: под ним небо, задник темы уже не нужен
    const bgKey = this.variant ? `bg_${this.variant.id}` : null;
    this.bgImage = null;
    if (bgKey && has(this, bgKey)) {
      this.bgImage = this.rig.bg(this.add.image(0, 0, bgKey).setOrigin(0.5, 0)
        .setScrollFactor(0).setDepth(DEPTH.SKY + 0.5));
      this._fitBg();
    } else {
      this._buildParallax(biome);
    }
    this._buildBarBacking();
  }

  /**
   * Фон места — во весь экран и чуть выше него: пока камера идёт по башне
   * сверху вниз, фон медленно едет от неба к силуэтам у его низа.
   */
  _fitBg() {
    const img = this.bgImage;
    if (!img) return;
    const [cw, ch] = canvasSize();
    const src = img.texture.getSourceImage();
    const k = Math.max(cw / src.width, (ch * 1.3) / src.height);
    img.setScale(k).setX(cw / 2);
    this._bgTravel = src.height * k - ch;
    this._scrollBg();
  }

  _scrollBg() {
    if (!this.bgImage) return;
    const r = this.rig;
    const span = Math.max(1, CFG.WATER_Y - r.visibleH);
    const p = Math.min(1, Math.max(0, r.viewTop / span));
    this.bgImage.y = -this._bgTravel * p;
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
    if (!f.left && !f.right && !f.top) return;
    const [cw] = canvasSize();
    this.barBacking = this.rig.bg(this.add.rectangle(0, 0, cw, f.top + TOP_H, 0x10131a, 0.9)
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
    // Форма башни — от места: карнизы, вулкан, астероиды (shapes.js)
    this.terrain.layout = this.variant?.layout ?? null;
    // Стены по краям — у некоторых мест; у остальных за краем обрыв в воду
    this.terrain.walls = Boolean(this.variant?.walls);
    // Детали в теле земли — по месту (terrainDetails.js); на обычных картах нет
    if (this.variant) { this.terrain.look = this.variant.id; this.terrain.decorSeed = this.seed; }
    this.terrain.generate(this.shape, shapeRng(this.seed));

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
    // Шире мира: на узкой башне в горизонтальном экране по бокам от неё
    // иначе была бы пустота вместо моря
    const wide = CFG.WORLD_W + 4000;
    // Лава — гуще и ярче воды, с огненной кромкой
    const lava = this.rules.liquid === 'lava';
    // Пустота космоса: тёмная, с фиолетовой кромкой — упал туда, и всё
    const space = this.rules.liquid === 'void';
    this.waterBody = this.rig.world(this.add.rectangle(-2000, CFG.WATER_Y, wide, deep + 2000,
      lava ? 0xd2400f : space ? 0x07041a : biome.water, lava ? 0.93 : space ? 0.97 : biome.waterAlpha)
      .setOrigin(0, 0).setDepth(DEPTH.WATER));
    this.waterLine = this.rig.world(this.add.rectangle(-2000, CFG.WATER_Y, wide, lava || space ? 6 : 3,
      lava ? 0xffc23a : space ? 0x9a6bff : 0xffffff, lava || space ? 0.9 : 0.25)
      .setOrigin(0, 0).setDepth(DEPTH.WATER));
    if (space) this._buildStars();
    this.waterBase = CFG.WATER_Y;
    this.floodLevel = 0;
  }

  /** Космос: небо темнее и в звёздах — от зерна, у всех одинаково. */
  _buildStars() {
    this.skyImage?.setTint(0x3a2a6a);
    const [cw, ch] = canvasSize();
    const r = subRng(this.seed >>> 0, 0x57a2);
    const g = this.rig.bg(this.add.graphics().setScrollFactor(0).setDepth(DEPTH.SKY + 1));
    for (let i = 0; i < 140; i++) {
      g.fillStyle(0xffffff, 0.35 + r() * 0.6).fillCircle(r() * cw, r() * ch, r() < 0.15 ? 2 : 1);
    }
  }

  /**
   * Потоп: с хода rules.flood.after вода каждый ход поднимается на step.
   * Без него бой на башне мог тянуться, пока двое прячутся по этажам;
   * с ним партия сама сжимается к верху и кончается за несколько минут.
   * Уровень — функция от номера хода, поэтому в сети он у обоих один.
   */
  applyFlood() {
    const f = this.rules.flood;
    if (!f || !this.waterBody) return;
    const turn = this.turn?.turnNumber ?? 0;
    const level = Math.max(0, turn - f.after) * f.step;
    const lava = this.rules.liquid === 'lava';
    if (turn === f.after) {
      this.fx.banner(lava ? 'Со следующего хода лава пойдёт вверх' : 'Со следующего хода вода пойдёт вверх',
        lava ? '#ffb37a' : '#9fd8ff', 1800);
    }
    if (level === this.floodLevel) return;
    this.floodLevel = level;
    CFG.WATER_Y = this.waterBase - level;
    CFG.DROWN_Y = CFG.WATER_Y + 15;
    this.tweens.add({ targets: [this.waterBody, this.waterLine], y: CFG.WATER_Y, duration: 900, ease: 'Sine.easeInOut' });
    this.fx.banner(lava ? 'Лава поднимается!' : 'Вода поднимается!', lava ? '#ffb37a' : '#9fd8ff', 1300, 'splash');
    this.rig.shake(260, 0.004);
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

    // Многоэтажная карта: бойцы сразу стоят на своих этажах. Десант сверху
    // посадил бы всех на крышу
    if (this.terrain.tops) {
      const spots = this._findFloorSpots(order.length);
      order.forEach(({ team, idx }, i) => {
        const p = spots[i] ?? { x: CFG.WORLD_W / 2, y: 100 };
        const worm = new Worm(this, p.x, p.y, team, idx);
        worm.snapToGround();
        worm.fallStartY = worm.y;
        this.worms.push(worm);
      });
      return;
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

  /** Точки старта на этажах: случайные, но подальше друг от друга. */
  _findFloorSpots(count) {
    const all = this.terrain.standSpots();
    for (let i = all.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [all[i], all[j]] = [all[j], all[i]];
    }
    for (let minDist = 420; minDist >= 60; minDist -= 40) {
      const picked = [];
      for (const p of all) {
        if (picked.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= minDist)) picked.push(p);
        if (picked.length === count) return picked;
      }
    }
    return all.slice(0, count);
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
    let dt = Math.min(delta / 1000, CFG.MAX_DT);
    // Замедление на добивании: мир на полсекунды вязнет, интерфейс и часы
    // хода идут как шли
    // Стоп-кадр попадания — короче и сильнее замедления
    if (this._stop && performance.now() < this._stop) dt *= 0.04;
    else if (this._slow && performance.now() < this._slow.until) dt *= this._slow.k;

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
    this.props?.update(dt);
    this._scrollBg();
    if (this.coach) {
      this.coach.update();
      if (this.coach.finished) this.coach = null;
    }
    this.ambience?.update(dt);
    for (const m of this.monsters) m.update(dt);
    if (this.monsters.some((m) => !m.alive)) this.monsters = this.monsters.filter((m) => m.alive);
    for (const sp of this.springs) sp.update(dt);
    if (this.springs.some((sp) => !sp.alive)) {
      this.springs = this.springs.filter((sp) => sp.alive);
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
    this.fx.updateWind(realDt);
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
   * рейтинга. Только для вошедших в аккаунт: анонима сервер не знает.
   */
  _reportToServer(won, ratingText, leagueText, tourney = false) {
    if (!this.net?.opponent?.id) return;
    if (tourney) {
      ratingText.setText('турнирный матч · отправляю итог…');
      reportResult({ room: this.room, seed: this.seed, opponent: this.net.opponent.id, won }).then((res) => {
        if (!ratingText.active) return;
        const text = {
          done: won ? 'турнирный матч · победа засчитана, ты проходишь дальше' : 'турнирный матч · итог засчитан',
          waiting: 'турнирный матч · ждём отчёт соперника',
          disputed: 'турнирный матч · итоги разошлись — решит админ',
        }[res?.match] ?? (res?.error ? `турнирный матч · ${res.error}` : 'турнирный матч · сервер недоступен');
        ratingText.setText(text);
      });
      return;
    }
    if (!serverAvailable()) {
      ratingText.setText(`${ratingText.text} · без аккаунта бой не в рейтинге`);
      return;
    }
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
          ratingText.setText(`${base} · без рейтинга: у соперника нет аккаунта`);
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
      // Стик: чем дальше палец, тем быстрее; клавиши и кнопки — всегда полный шаг
      w.walk(left ? -1 : 1, dt * (this.moveInput.walkScale ?? 1));
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

  /**
   * Куда боец сейчас держит оружие. Рогатку тянут — по её направлению;
   * целятся кнопками, мышью или ходит бот — по прицелу; иначе просто
   * перед собой, в сторону, куда смотрит.
   */
  heldDirection() {
    const w = this.turn.activeWorm;
    const face = { x: w ? w.facing : 1, y: 0 };
    if (!this.slingAim) return this.aimDirection();
    if (this.aim?.mode === 'aim') {
      const shot = this.aim.computeShot();
      if (!shot) return face;
      const d = Math.hypot(shot.vx, shot.vy) || 1;
      return { x: shot.vx / d, y: shot.vy / d };
    }
    if (this.charging || this.isBotTurn() || isDesktop() || this.remoteAim) return this.aimDirection();
    return face;
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
    this.hooksLeft = this.hookPerTurn;
    this.applyFlood();
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
    if (worm.team === this.myTeamIndex) this.battleStats.crates++;
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
    if (this.turn.activeWorm?.skipping) return false;  // замёрз — ход пропускает
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
    // превращалась бы в бесплатную добавку к обычному выстрелу. И на лету
    // по тросу тоже: сначала долети.
    if (!allowed || this.turn.retreating || !w || !w.alive || (w.zip && !this.replaying)) return;

    // Выстрел с уроном — потом посмотрим, попал ли (дразнилка на промах)
    if (!this.replaying && (this.turn.weapon?.explosion?.damage ?? 0) > 0) this._turnShot = { team: this.turn.currentTeam, hits: 0 };
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
    // Иногда стрелок подаёт голос — каждый раз приелось бы за пять ходов.
    // Только украшение: случайность здесь на ход боя не влияет.
    if (Math.random() < 0.3) voice.say('shot', { team: w.team });
    if (!this.replaying && !this.isBotTurn()) {
      haptic('shot');
      trackStep('first_shot', { once: true });
      if (this.slingAim) {
        this._slingUses = (this._slingUses ?? 0) + 1;
        try { localStorage.setItem('worms.slingUses', String(this._slingUses)); } catch { /* инкогнито */ }
      }
    }
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
      this.props?.hit(x, y, cfg.damageRadius * 0.9, false);
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

    // Снежок йети: кого задело — замерзает и пропускает свой следующий ход
    if (cfg.freeze) {
      for (const w of this.worms) {
        if (w.alive && Math.hypot(w.x - x, w.centerY - y) <= cfg.damageRadius) w.frozen = true;
      }
    }

    // Монстрам достаётся так же, как бойцам; Великана не отбрасывает
    for (const m of [...this.monsters]) {
      if (!m.alive) continue;
      const d = Math.max(0, Math.hypot(m.x - x, m.centerY - y) - m.def.w / 4);
      if (d > cfg.damageRadius) continue;
      const dmg = Math.round(cfg.damage * (1 - d / cfg.damageRadius));
      if (!m.def.boss && cfg.knockback > 0) m.vy = -Math.min(320, cfg.knockback * 0.6);
      m.damage(dmg);
    }

    // Эмодзи-предметы на этажах ломаются, бочки взрываются следом
    this.props?.hit(x, y, cfg.damageRadius * 0.9, true);

    // Батут взрыв ломает
    for (const sp of this.springs) {
      if (sp.alive && Math.hypot(sp.x - x, sp.y - 8 - y) <= cfg.damageRadius * 0.8) sp.destroy();
    }

    // Мина рядом со взрывом детонирует — так получаются цепочки.
    // Подрываем через таймер, а не тут же: рекурсия из explode в explode
    // на длинной цепочке ушла бы в стек.
    for (const m of this.mines) {
      if (!m.alive || Math.hypot(m.x - x, m.y - y) > cfg.damageRadius) continue;
      m.fuse = 0.12;
      m.armed = true;
    }

    let felt = 0;
    let ouch = null, ouchDmg = 0;
    const shooter = owner?.team ?? this.turn.currentTeam;
    let foesHit = 0;
    for (const w of this.worms) {
      if (!w.alive) continue;
      const wx = w.x, wy = w.centerY;
      const d = Math.hypot(wx - x, wy - y);
      // Мимо, но рядом — подпрыгнул от испуга
      if (d > cfg.damageRadius && d < cfg.damageRadius + 130) w.startle();
      if (d > cfg.damageRadius) continue;

      const f = 1 - d / cfg.damageRadius;      // линейный спад от центра
      const dmg = Math.round(cfg.damage * f);

      let nx, ny;
      if (d < 1) { nx = 0; ny = -1; } else { nx = (wx - x) / d; ny = (wy - y) / d; }
      w.applyImpulse(nx * cfg.knockback * f, ny * cfg.knockback * f - 70 * f);

      w.damage(dmg, 'взрыв');
      if (dmg > 0) felt = Math.max(felt, this.isLocalTeam(w.team) ? 2 : 1);
      if (dmg > 0) this._countHit(w, dmg);
      if (dmg > 0 && w.team !== shooter) {
        foesHit++;
        if (this._turnShot) this._turnShot.hits++;
      }
      if (dmg > ouchDmg) { ouch = w; ouchDmg = dmg; }
    }
    this._impact(x, y, ouchDmg, foesHit);
    // Сильно досталось — боец вскрикивает. Царапины молча, иначе «ой» на каждый чих
    if (ouch && ouchDmg >= 25 && !this.gameOverUi) voice.say('hurt', { team: ouch.team });
    // Отдача в руку: задели своего — сильно, чужого — коротко
    if (felt === 2) haptic('hurt');
    else if (felt === 1) haptic('hit');
    if (felt) this._botReact(felt === 2);
  }

  /**
   * Попадание должно чувствоваться: мир на миг замирает (стоп-кадр), по
   * силе удара — выкрик. Двоих-троих разом — «Дуплет!»/«Тройной!».
   */
  _impact(x, y, dmg, foesHit) {
    if (dmg >= 15) {
      this._stop = performance.now() + (dmg >= 45 ? 120 : 70);
      this.rig.punch(dmg >= 45 ? 0.05 : 0.03, 170);
    }
    if (foesHit >= 3) this.fx.callout(x, y - 50, 'Тройной!', '#ff8ad4', 40);
    else if (foesHit === 2) this.fx.callout(x, y - 50, 'Дуплет!', '#8ad4ff', 38);
    else if (dmg >= 45) this.fx.callout(x, y - 50, 'Бабах!', '#ffd166', 36);
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

  addSpring(x, y, owner, launch = null) {
    this.springs.push(new Spring(this, x, y, owner, launch));
  }

  // ------------------------------------------------------------ монстры

  /** Множитель тяжести поверх правил партии (аффикс «скачок гравитации»). */
  setGravityMul(k) {
    CFG.GRAVITY = BASE_GRAVITY * (Number(this.rules.gravity) || 1) * k;
  }

  addMonster(kind, x, y, hp = null) {
    const m = new Monster(this, kind, x, y, hp);
    this.monsters.push(m);
    return m;
  }

  /**
   * Монстры из описания партии (кампания «Подъём»): match.monsters —
   * сколько каких, match.boss — Великан на вершине. Места — от зерна,
   * подальше от бойцов и друг от друга.
   */
  _spawnMonsters() {
    const want = this.match.monsters ?? {};
    if (!this.terrain.tops || (!this.match.boss && !Object.keys(want).length)) return;
    const rng = subRng(this.seed >>> 0, 0xb055);
    const spots = this.terrain.standSpots(10, 40);
    for (let i = spots.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const taken = this.worms.map((w) => ({ x: w.x, y: w.y, r: 150 }));
    // k — насколько строго держать дистанцию; на тесных башнях (вулкан)
    // её постепенно ослабляем, чтобы все монстры нашли место
    let k = 1;
    const free = (p, r) => taken.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= Math.max(r, q.r) * k);
    if (this.match.boss) {
      // Великан — на самом верхнем месте, где хватает простора над головой
      const roomy = spots.filter((p) => !this.terrain.solidInRect(p.x - 46, p.y - 104, p.x + 46, p.y - 6)
        && free(p, 260));
      const top = (roomy.length ? roomy : spots).reduce((a, b) => (b.y < a.y ? b : a));
      // boss: true — тролль; иначе имя босса главы (yeti, golem, slimeking)
      this.addMonster(isBoss(this.match.boss) ? this.match.boss : 'boss', top.x, top.y, this.match.bossHp ?? null);
      taken.push({ x: top.x, y: top.y, r: 160 });
    }
    for (const [kind, n] of Object.entries(want)) {
      let placed = 0;
      for (k = 1; k >= 0.4 && placed < n; k -= 0.2) {
        for (const p of spots) {
          if (placed >= n) break;
          if (!free(p, 90)) continue;
          this.addMonster(kind, p.x, p.y);
          taken.push({ x: p.x, y: p.y, r: 90 });
          placed++;
        }
      }
    }
  }

  /**
   * Ход монстров (зовёт TurnManager, когда ход бойца затих). Слизни
   * ползут, Великан кидает камень. @returns {boolean} есть ли чего ждать
   */
  runMonsters() {
    if (this.net) return false;
    let any = false;
    for (const m of [...this.monsters]) if (m.alive && m.act()) any = true;
    // Событие места: метель, извержение, метеориты (ui/Ambience.js)
    if (this.affixes?.run(this.turn.turnNumber)) any = true;
    return any;
  }

  monstersBusy() {
    if (this.affixes?.busy) return true;
    return this.monsters.some((m) => m.alive && m.busy);
  }

  onMonsterDied(m) {
    if (m.def.boss) haptic('win');
  }

  /** Ход отыгран и очередь передана — отдаём второму игроку итог. */
  onTurnResolved(actedTeam) {
    // Соперник стрелял и никого не задел — над ним смеются
    const shot = this._turnShot;
    this._turnShot = null;
    if (shot && shot.team === actedTeam && shot.hits === 0 && !this.gameOverUi) {
      const mockers = this.worms.filter((w) => w.alive && w.team !== actedTeam);
      for (const w of mockers) w.taunt();
      if (mockers.length) voice.say('laugh', { team: mockers[0].team });
    }
    this.net?.sendState(actedTeam);
    this.explosionLog = [];
  }

  onWormDied(worm) {
    // Добивание — главное событие хода: мир замирает на полсекунды. Решающее
    // (команда выбита) — дольше, с наездом камеры и выкриком
    const decisive = this.checkVictory() !== null;
    if (!this.replaying) this._slow = decisive ? { until: performance.now() + 1500, k: 0.2 } : { until: performance.now() + 520, k: 0.28 };
    if (decisive) {
      this.rig.punch(0.14, 900);
      this.fx.callout(worm.x, worm.centerY - 70, 'Решающий!', '#ffd166', 44);
    }
    if (this._myStrike() && worm.team !== this.myTeamIndex) this.battleStats.kills++;
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
    // Бой с Великаном: повалил — победа, выбили своих — поражение
    if (this.match.boss) {
      const mine = this.myTeamIndex;
      if (!this.teamAlive(mine)) return mine === 0 ? 1 : 0;
      return this.monsters.some((m) => m.def.boss && m.alive) ? null : mine;
    }
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
  /** Вибрация — через сцену, чтобы модулям без импорта Telegram было чем звать. */
  haptic(kind) { haptic(kind); }

  /** Своя ли команда для этого устройства: в сети — моя, иначе — не бот. */
  isLocalTeam(team) {
    if (this.net?.connected && this.net.myTeam !== null) return team === this.net.myTeam;
    return this.match.teams[team]?.control !== 'bot';
  }

  get myTeamIndex() {
    if (this.net?.connected && this.net.myTeam !== null) return this.net.myTeam;
    return this.match.teams.findIndex((t) => t.control !== 'bot');
  }

  onGameOver(winner) {
    if (this.gameOverUi) return;
    // Выжившие радуются или плачут — у кого есть чем
    for (const w of this.worms) if (w.alive) w.mood = w.team === winner ? 'worm_win' : 'worm_cry';

    // Где есть бот или сеть, «победа красных» ничего не говорит: важно,
    // выиграл ли ты. В хотсите наоборот — команды равноправны.
    const solo = this.bots?.some(Boolean) || this.net?.connected;
    const mine = this.myTeamIndex;
    let text;
    if (winner < 0) text = 'Ничья';
    else if (solo) text = winner === mine ? 'Победа!' : 'Поражение';
    else text = `Победа: ${TEAM_NAMES[winner]}!`;
    const color = winner >= 0 ? TEAM_COLORS[winner] : 0xffffff;

    let box = 0;
    // Первое прохождение — монеты сверх обычных за бой
    let firstCoins = 0;
    if (this.match.mode === 'campaign' && winner === mine) {
      if (!loadProgress().has(this.match.missionId)) firstCoins = FIRST_CLEAR_COINS.mission;
      markDone(this.match.missionId);
      // За первую, каждую вторую и последнюю миссию — коробка со скином
      box = syncCampaignBoxes();
    }
    if (this.match.mode === 'ascent' && winner === mine) {
      if (markAscentDone(this.match.ascentId)) {
        firstCoins = ASCENT_BY_ID[this.match.ascentId]?.boss ? FIRST_CLEAR_COINS.boss : FIRST_CLEAR_COINS.ascent;
      }
      box = syncCampaignBoxes();
    }
    grantCoins(firstCoins);
    // Партия доиграна: запись сессии больше не нужна
    this.net?.forget();
    this.fx.sound(winner === mine ? 'victory' : 'defeat');
    // Первая настоящая победа (не испытание): дальше «Играть» — с «Бойцом»
    if (solo && winner >= 0 && winner === mine && this.match.mode !== 'challenge') {
      markWon();
      trackStep('first_win', { once: true });
    }
    // Итог — голосом, поверх всего: в хотсите кричит победитель, иначе — ты
    if (winner >= 0 && !solo) voice.say('win', { team: winner, force: true });
    else if (winner >= 0) voice.say(winner === mine ? 'win' : 'lose', { team: mine, force: true });
    if (winner >= 0 && (winner === mine || !solo)) this.fx.confetti();
    haptic(winner === mine ? 'win' : 'lose');
    // Иконку на экран Домой сами не предлагаем: только кнопкой в меню и
    // в профиле, когда игрок захотел

    // Рейтинг двигается только в сетевом бою: против бота и в хотсите
    // очков не бывает, иначе их можно было бы «нафармить» о самого себя.
    let ratingLine = '';
    let leagueLine = '';
    // Бой без рейтинга: рейтинг не трогаем ни здесь, ни на сервере
    const casual = isCasualRoom(this.room);
    const tourney = isTournamentRoom(this.room);
    if (this.net?.connected && winner >= 0 && casual) {
      ratingLine = 'бой без рейтинга';
    } else if (this.net?.connected && winner >= 0 && tourney) {
      ratingLine = 'турнирный матч';
    } else if (this.net?.connected && winner >= 0 && this.net.opponent) {
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
      if (!casual) this._reportToServer(winner === mine, ratingText, leagueText, tourney);
    }
    const sub = this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 + (ratingLine ? 68 : 32),
      // На ПК — «клик»: «тап» там читается как опечатка
      `${isDesktop() ? 'клик' : 'тап'}${backToMenu ? ' — в меню' : ' или R — новая карта'}`,
      font(18, 700, UI.textDim))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11);
    this.rig.ui(sub);

    this.gameOverUi = [shade, title, sub];

    // Испытание: звёзды и монеты за новые звёзды — строкой над заголовком
    if (this.match.mode === 'challenge') this._challengeResult(winner >= 0 && winner === mine);
    // Башня дня: итог — в таблицу дня, за первую победу дня монеты
    if (this.match.mode === 'daily') this._dailyResult(winner >= 0 && winner === mine);

    // Бой — в статистику: режим, итог, сколько ходов
    track('battle', {
      mode: this.match.fallback ? 'fallback' : this.net?.connected ? 'online'
        : ['campaign', 'challenge'].includes(this.match.mode) ? this.match.mode : solo ? 'quick' : 'hotseat',
      won: winner >= 0 && winner === mine, turns: this.turn.turnNumber,
    });

    // Монеты за бой и выполненные этим боем задания — над заголовком
    const daily = this._recordDaily(winner >= 0 && winner === mine);
    const earned = (daily?.coins ?? 0) + firstCoins;
    if (earned || daily?.done.length) {
      const parts = [];
      if (earned) parts.push(`+${earned} монет${firstCoins ? ' (первое прохождение)' : ''}`);
      if (daily?.done.length) {
        parts.push(daily.done.length === 1
          ? `задание выполнено: ${TASK_BY_ID[daily.done[0]].text.toLowerCase()}`
          : `выполнено заданий: ${daily.done.length}`);
      }
      const line = this.rig.ui(this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 - 96, parts.join(' · '),
        font(22, 800, '#ffe27a')).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11)
        .setStroke('#10131a', 5).setScale(0.4));
      this.tweens.add({ targets: line, scale: 1, duration: 380, delay: 250, ease: 'Back.easeOut' });
      this.gameOverUi.push(line);
    }

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

    // Две кнопки вместо «тап куда угодно»: случайное касание после взрыва
    // раньше тут же уносило с экрана итога
    title.setScale(0.3);
    this.tweens.add({ targets: title, scale: 1, duration: 420, ease: 'Back.easeOut' });
    sub.setText(box
      ? 'Получена коробка со скином! Открой её в меню'
      : `бой занял ходов: ${this.turn.turnNumber}`);
    if (box) sub.setColor(UI.accent);
    this.time.delayedCall(500, () => {
      if (!this.gameOverUi) return;
      const next = this._nextAction(winner >= 0 && winner === mine);
      this.gameOverUi.push(next
        ? this._overButton(-140, next.label, () => this._startNext(next.match), 'next')
        : this._overButton(-140, 'Ещё раз', () => this.scene.restart(), 'again'));
      this.gameOverUi.push(this._overButton(140, 'В меню', () => this.toMenu(), 'menu'));
      // Позвать друга — прямо отсюда: после боя хочется, а до вкладки
      // «Задания» никто не доходит. По ссылке — обоим по коробке
      const link = refLink();
      if (link && this.match.mode !== 'hotseat' && solo) {
        const won = winner >= 0 && winner === mine;
        this.gameOverUi.push(this._overButton(0, 'Позвать друга', () => {
          trackStep('invite');
          shareLink(link, won
            ? 'Только что победил в «Башне» 💥 Залетай — по этой ссылке нам обоим по коробке со скином!'
            : 'Залетай в бой на башне! По этой ссылке нам обоим дадут коробку со скином 🎁');
        }, 'invite', 92));
      }
    });
  }

  /**
   * Куда вести после боя, кроме «ещё раз»: из обучения — в первый
   * настоящий бой с «Новичком», из пройденного испытания — в следующее.
   */
  _nextAction(won) {
    if (!won) return null;
    if (this.match.tutorial) return { label: 'В бой!', match: towerMatch('rookie') };
    if (this.match.mode === 'challenge') {
      const i = CHALLENGES.findIndex((c) => c.id === this.match.challengeId);
      const c = CHALLENGES[i + 1];
      if (c) return { label: 'Дальше', match: challengeMatch(c.id) };
    }
    if (this.match.mode === 'ascent') {
      const i = ASCENT.findIndex((m) => m.id === this.match.ascentId);
      const m = ASCENT[i + 1];
      if (m) return { label: 'Дальше', match: ascentMatch(m.id) };
    }
    return null;
  }

  _startNext(match) {
    this.net?.forget();
    this.registry.set('match', match);
    this.registry.set('seed', match.seed ?? null);
    this.registry.set('forceBiome', match.biome ?? null);
    this.scene.restart();
  }

  /** Башня дня: монеты за первую победу дня и место в таблице. */
  _dailyResult(won) {
    const day = this.match.day;
    const hp = this.worms.filter((w) => w.team === this.myTeamIndex && w.alive).reduce((a, w) => a + w.health, 0);
    let st = {};
    try { st = JSON.parse(localStorage.getItem('worms.dailyTower.v1') ?? '{}') || {}; } catch { st = {}; }
    let coins = 0;
    if (won && st.rewarded !== day) {
      coins = 60;
      grantCoins(coins);
      st.rewarded = day;
      try { localStorage.setItem('worms.dailyTower.v1', JSON.stringify(st)); } catch { /* инкогнито */ }
    }
    const head = won ? `Башня дня: ${this.myTurns} ${this.myTurns < 5 ? 'хода' : 'ходов'}` : 'Башня дня: не взята';
    const t = this.rig.ui(this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 + 62,
      `${head}${coins ? ` · +${coins} монет` : ''} · отправляю…`, font(18, 800, UI.accent))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11)
      .setWordWrapWidth(CFG.VIEW_W - 40).setAlign('center'));
    this.gameOverUi?.push(t);
    submitDailyTower({ day, won, turns: this.myTurns, hp }).then((res) => {
      if (!t.active) return;
      if (!res?.me) { t.setText(`${head}${coins ? ` · +${coins} монет` : ''} · без сервера не в таблице`); return; }
      const best = res.accepted ? 'лучшая попытка' : 'прежняя попытка лучше';
      t.setText(`${head}${coins ? ` · +${coins} монет` : ''} · место ${res.me.place} из ${res.players} · ${best}`);
    });
  }

  /** Звёзды испытания на экране итога. */
  _challengeResult(won) {
    const c = CHALLENGE_BY_ID[this.match.challengeId];
    if (!c) return;
    const mine = this.worms.filter((w) => w.team === this.myTeamIndex);
    const hpLost = mine.reduce((a, w) => a + (CFG.MAX_HEALTH - (w.alive ? w.health : 0)), 0);
    const stars = starsFor(c, { won, myTurns: this.myTurns, hpLost });
    const res = saveChallenge(c.id, stars);
    if (c.id === 'first' && stars > 0) trackStep('tutorial_done', { once: true });
    if (res.coins) grantCoins(res.coins);
    // Выше строки монет за бой (она на -96), чтобы не наезжали
    const y = CFG.VIEW_H / 2 - 210;
    for (let i = 0; i < 3; i++) {
      const on = i < stars;
      const t = this.rig.ui(this.add.text(CFG.VIEW_W / 2 + (i - 1) * 74, y, '★',
        font(64, 800, on ? '#ffd23f' : '#3a4052')).setOrigin(0.5).setScrollFactor(0)
        .setDepth(DEPTH.HUD + 11).setStroke('#10131a', 6).setScale(on ? 0.2 : 1));
      if (on) this.tweens.add({ targets: t, scale: 1, duration: 320, delay: 300 + i * 260, ease: 'Back.easeOut' });
      this.gameOverUi?.push(t);
    }
    const hint = won
      ? (stars < 3 ? (stars < 2 ? `★★ — победи за ${c.stars.turns} ${c.stars.turns < 5 ? 'хода' : 'ходов'}` : '★★★ — ещё и без потерь здоровья') : 'идеально!')
      : 'попробуй ещё раз';
    const line = res.coins ? `${hint} · +${res.coins} монет за новые звёзды` : hint;
    const t = this.rig.ui(this.add.text(CFG.VIEW_W / 2, y + 52, line, font(19, 800, '#ffe27a'))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11).setStroke('#10131a', 5)
      .setWordWrapWidth(CFG.VIEW_W - 40).setAlign('center'));
    this.gameOverUi?.push(t);
  }

  /** Кнопка на затемнении итога. */
  _overButton(dx, label, onTap, key = null, dy = 0) {
    const w = 250, h = 76;
    const x = CFG.VIEW_W / 2 + dx, y = CFG.VIEW_H / 2 + 118 + dy;
    // Центры кнопок наружу — тестам, чтобы не считать раскладку у себя
    if (key) (this.overButtons ??= {})[key] = { x, y };
    // Главная кнопка — красная, вторая — спокойная: у каждой своя текстура
    const variant = dx < 0 ? 'primary' : 'normal';
    ensureButton(this, `ui-over-${w}x${h}-${variant}`, w, h, variant);
    const img = this.rig.ui(this.add.image(x, y, `ui-over-${w}x${h}-${variant}`)
      .setScrollFactor(0).setDepth(DEPTH.HUD + 12));
    img.setInteractive({ useHandCursor: true });
    img.on('pointerup', onTap);
    const text = this.rig.ui(this.add.text(x, y, label, font(26, 800))
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
    forgetStartRoom();
    // Из испытания — обратно к списку испытаний
    if (this.match.mode === 'challenge' && !this.match.tutorial) this.registry.set('returnTo', 'challenges');
    if (this.match.mode === 'ascent') this.registry.set('returnTo', 'ascent');
    if (this.match.mode === 'daily') this.registry.set('returnTo', 'daily');
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
    closeOverlay();
    this.input?.setDefaultCursor?.('default');
    this.mouseFire = false;
    this.mines = [];
    this.springs = [];
    this.monsters = [];
    this.props = null;
    this.ambience = null;
    this.affixes = null;
    this.aim?.destroy();
    this.crates = [];
    this.rig?.destroy();
    this.offscreen?.destroy();
    this.projectiles = [];
    this.worms = [];
  }
}
