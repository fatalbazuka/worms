import { CFG, DEPTH, TEAM_COLORS, TEAM_NAMES, canvasSize, applyWorld } from '../config.js';
import { makeRng, subRng } from '../core/rng.js';
import { BIOMES, pickBiome } from '../core/biomes.js';
import { pickShape, shapeRng, towerVariant } from '../core/shapes.js';
import { Terrain } from '../core/Terrain.js';
import { TurnManager, STATE } from '../core/TurnManager.js';
import { has, meta, weaponIcon, fitScale } from '../core/assets.js';
import { Worm } from '../entities/Worm.js';
import { Crate } from '../entities/Crate.js';
import { Mine } from '../entities/Mine.js';
import { Spring } from '../entities/Spring.js';
import { GasCloud } from '../entities/Gas.js';
import { Props } from '../entities/Props.js';
import { Monster, isBoss } from '../entities/Monster.js';
import { Ambience } from '../ui/Ambience.js';
import { Affixes, DEFAULT_AFFIXES } from '../entities/Affixes.js';
import { Hud, TOP_H } from '../ui/Hud.js';
import { Fx } from '../ui/Fx.js';
import { AimController } from '../ui/AimController.js';
import { ShotTrace } from '../ui/ShotTrace.js';
import { KoLog } from '../ui/KoLog.js';
import { koCause, koSummary } from '../core/knockouts.js';
import { battleLoadout, loadoutApplies, loadoutAmmo, LOADOUT_SIZE, PVP_LOADOUT_SIZE } from '../core/loadout.js';
import { currentGoal } from '../platform/nextgoal.js';
import { plural } from '../core/nextgoal.js';
import { font, UI, ensureButton } from '../ui/theme.js';
import { WEAPONS, WEAPON_RARITY } from '../weapons/index.js';
import { captureCommand, captureMove } from '../net/protocol.js';
import { NetSession } from '../net/session.js';
import { DuelSession } from '../net/duel.js';
import { knock } from '../net/lobby.js';
import { randomRoom, copyText } from '../net/transport.js';
import { isCasualRoom, isTournamentRoom } from '../net/rooms.js';
import { makeTransport } from '../net/connect.js';
import {
  startRoom, forgetStartRoom, shareRoom, haptic, inviteLink, setBattle,
  refLink, shareLink, telegramConfig,
} from '../platform/telegram.js';
import { canStory, snapshot as frameShot, fighterFrame, drawStory, shareStory } from '../platform/story.js';
import { ClipRecorder, canClip, saveClip, clipToStory } from '../platform/clip.js';
import { HOTSEAT, towerMatch, rookieMatch, challengeMatch, ascentMatch, fallbackMatch } from '../core/match.js';
import { ASCENT } from '../campaign/ascent.js';
import { markAscentDone, saveAscentStars, claimChapterBoxes } from '../platform/ascent.js';
import { markWon, claimTutorialBox } from '../platform/onboard.js';
import { Bot } from '../ai/Bot.js';
import { markDone, MISSION_BY_ID, loadProgress } from '../campaign/missions.js';
import { ASCENT_BY_ID, ascentStarsFor, ascentStarTurns } from '../campaign/ascent.js';
import { checkObjective, snapshot, objectiveText } from '../campaign/objectives.js';
import { player, eloDelta, recordResult } from '../platform/player.js';
import { reportResult, serverAvailable, track, trackStep, submitDailyTower, createDuel, knockRoom, syncMe, loggedIn } from '../net/server.js';
import { inviteToChess } from '../net/invite.js';
import { leagueOf, nextLeague, toNextLeague } from '../platform/league.js';
import { OffscreenMarkers } from '../ui/OffscreenMarkers.js';
import { SKIN_BY_ID, rivalSkin } from '../core/skins.js';
import { equippedSkin, syncCampaignBoxes, grantBoxes } from '../platform/skins.js';
import { myCosmetics } from '../platform/cosmetics.js';
import { DEFAULTS as DEFAULT_COS } from '../core/cosmetics.js';
import { recordBattle } from '../platform/daily.js';
import { TASK_BY_ID, FIRST_CLEAR_COINS } from '../core/daily.js';
import { EMOTE_BY_ID, EMOTE_COOLDOWN } from '../core/emotes.js';
import { CHALLENGES, CHALLENGE_BY_ID, starsFor } from '../campaign/challenges.js';
import { saveChallenge } from '../platform/challenges.js';
import { grantCoins } from '../platform/daily.js';
import { recordDailyTower } from '../platform/dailytower.js';
import { battleXp, COS_LABEL } from '../core/levels.js';
import { gainXp } from '../platform/levels.js';
import { item as cosItem } from '../core/cosmetics.js';
import { shotStats, battleEndStats, isLongShot } from '../core/achievements.js';
import { bumpAch, checkAchievements, onAchievement } from '../platform/achievements.js';
import { AchToasts } from '../ui/AchToast.js';
import { CameraRig } from '../ui/CameraRig.js';
import { Coach } from '../ui/Coach.js';
import { Tips } from '../ui/Tips.js';
import { voice } from '../audio/Voice.js';
import { music, battleTheme } from '../audio/Music.js';
import { askText, closeOverlay } from '../ui/Overlay.js';
import { isDesktop, aimScheme } from '../platform/device.js';


// Тяжесть и длина троса без правил партии: космос их меняет на один бой
const BASE_GRAVITY = CFG.GRAVITY;
const BASE_HOOK_RANGE = CFG.HOOK_RANGE;

export default class GameScene extends Phaser.Scene {
  /** Через сколько секунд ожидания соперника предложить выход. */
  static WAIT_HINT = 20;

  constructor() { super('Game'); }

  create() {
    // Что за партия — решает меню. Прямой заход по адресу описания не даёт,
    // и тогда игра ведёт себя как раньше: обычный хотсит на одном устройстве.
    this.match = this.registry.get('match') ?? HOTSEAT;
    // Команд обычно две; «Вечеринка» (partyMatch) — три-четыре. Число
    // ставится заново на каждую партию, чтобы одна не протекала в другую
    CFG.TEAMS = Math.max(2, Math.min(4, this.match.teams?.length ?? 2));
    this.overButtons = null;
    this.myTurns = 0;            // своих ходов — для звёзд испытаний
    // Счётчики боя для ежедневных заданий: только за свою команду
    this.battleStats = { hits: 0, damage: 0, kills: 0, hooks: 0, crates: 0, grenadeHits: 0 };
    // Достижения: открытые за бой (для экрана итога), трюк текущего своего
    // выстрела, досталось ли своим за бой и здоровье на старте
    this.achGot = [];
    this._trick = null;
    this._myHurt = false;
    this._hpAtStart = null;
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
    this.slingAim = this.sling && aimScheme() !== 'buttons';
    // Тактика (башня, онлайн, дуэли): трос один, шаги в запасе, ракета
    // вплотную не взводится, прямое попадание сильнее, отброс слабее,
    // отход после выстрела, «Окопаться», честный первый ход
    this.tactics = Boolean(this.rules.tactics);
    this.walkPerTurn = this.tactics && Number(this.rules.walk) > 0 ? Number(this.rules.walk) : null;
    this.walkLeft = this.walkPerTurn;
    // Рогатка с любого места: протяжка пальцем по полю — натяжение, а не камера
    this.aimAnywhere = this.slingAim && aimScheme() === 'anywhere';
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
    this.gas = [];
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
    // Музыка места: у льда, лавы и космоса своя, остальное — обычная боевая.
    // Переигровка того же места тему не обрывает
    music.play(battleTheme(this.variant?.id, biome.id));

    this._buildSky(biome);
    this._buildTerrain(biome);
    this._buildWater(biome);

    this.fx = new Fx(this);
    this.hud = new Hud(this);
    this.turn = new TurnManager(this);
    this.aim = new AimController(this);
    // След прошлого выстрела и журнал выбывших — чтобы бой был понятен
    this.shotTrace = new ShotTrace(this);
    this.koLog = new KoLog(this);
    this.kos = [];
    this.offscreen = new OffscreenMarkers(this);
    // Подсказки «один раз»: первая дуэль и новые правила боя
    this.tips = new Tips(this);
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
    this._applyLoadout();

    this.rig.bgCam.setBackgroundColor(biome.fallback.sky[1]);
    // Дуэль по переписке начнёт с перемотки истории: табличка первого хода
    // была бы о чужом, давно сыгранном ходе
    this.fastForward = this.match.mode === 'duel';
    // Первым ходит человек: отдавать первый ход боту в миссии — почти то же,
    // что начать её с потери бойца.
    this.turn.begin(this._firstTeam());
    // Честный первый ход: кто ходит не первым — начинает окопавшимся, щит
    // снимется в начале его хода. Первый выстрел партию не решает
    if (this.tactics && !this.match.tutorial) {
      for (const w of this.worms) if (w.team !== this.turn.currentTeam) w.guard = true;
    }

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
    // Открытое достижение — плашкой сверху, сбоку от главного; после боя —
    // ещё и списком на экране итога
    this.achToasts = new AchToasts(this, {
      adopt: (o) => this.rig.ui(o.setDepth(DEPTH.HUD + 20)),
      place: () => this._achToastPlace(),
    });
    const offAch = onAchievement((list) => {
      this.achGot.push(...list);
      if (!this.gameOverUi) this.achToasts.push(list);
    });
    this.events.once('shutdown', offAch);
    // Клип своего красивого выстрела — для шортсов и сторис
    this.clip = canClip() ? new ClipRecorder(this.game.canvas) : null;

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
    if (team === this._myTeamHint()) return mine.sheet;
    const theirs = this._peerHint()?.skin;
    const id = SKIN_BY_ID[theirs] ? theirs : rivalSkin(this.seed, team, mine.id);
    return SKIN_BY_ID[id].sheet;
  }

  /** Украшения команды: свои — надетые, соперник по сети — присланные, остальные — обычные. */
  cosmeticsFor(team) {
    if (team === this._myTeamHint() && this.match.teams[team]?.control !== 'bot') return myCosmetics();
    return this._peerHint()?.cos ?? DEFAULT_COS;
  }

  /**
   * Своя команда, пока сессии ещё нет (бойцы одеваются раньше неё). В сети
   * myTeam переживает перезапуск сцены, поэтому верим ему только там; в
   * дуэли по переписке команда известна из самой дуэли.
   */
  _myTeamHint() {
    const duel = this.match.mode === 'duel' ? this.registry.get('duel') : null;
    if (duel) return duel.me;
    const net = this.registry.get('net');
    return (net && this.myTeam != null)
      ? this.myTeam
      : Math.max(0, this.match.teams.findIndex((t) => t.control !== 'bot'));
  }

  /** Соперник-человек: по сети или по переписке (скин, украшения). */
  _peerHint() {
    const duel = this.match.mode === 'duel' ? this.registry.get('duel') : null;
    if (duel) return duel.opponent;
    return this.registry.get('net')?.opponent ?? null;
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

  // -------------------------------------------------------- достижения

  /**
   * Идут ли бои в достижения. Как и задания — только против бота или
   * человека: вдвоём на одном телефоне обе стороны свои. И не в обучении:
   * новичку там нужен один выстрел, а не плашки.
   */
  get _achSolo() {
    return Boolean((this.bots?.some(Boolean) || this.net?.connected) && !this.match.tutorial);
  }

  /** Где встать плашке достижения: под лентой оружия, сбоку от плашки хода. */
  _achToastPlace() {
    const W = CFG.VIEW_W, H = CFG.VIEW_H;
    const top = this.hud?.compact ? TOP_H + 98 : TOP_H + 16;
    // В портрете плашка «Твой ход» ниже, на трети экрана, — можно по центру;
    // в ландшафте она под лентой, поэтому — слева
    if (H > W) return { x: W / 2, y: top + 40, center: true };
    return { x: 16 + (CFG.CORNER || 0), y: top, center: false };
  }

  /** Идёт ли сейчас свой выстрел, из которого может выйти трюк. */
  _trickLive() {
    const t = this._trick;
    return Boolean(t) && !this.replaying && t.turn === this.turn.turnNumber
      && this.turn.currentTeam === this.myTeamIndex;
  }

  /** Свой выстрел: запомнить, как стрелял (на тросе, с батута, откуда). */
  _trickShot(w) {
    if (!this._achSolo || !this._myStrike() || !w) return;
    // Трюк — один выстрел: второй выстрел дробовика считается отдельно
    this._finishTrick();
    this._trick = {
      turn: this.turn.turnNumber, hit: new Set(), kills: 0, drowns: 0, far: false, back: false,
      weapon: this.turn.weapon?.id ?? null,
      // Авиаудар бьёт в выбранную точку — «через полкарты» им не считается
      targeted: Boolean(this.turn.weapon?.targeted),
      hang: Boolean(w.hang),
      // С батута — летит после пружины в этот же ход, ещё не приземлился
      sprung: !w.grounded && !w.hang && w.sprungTurn === this.turn.turnNumber,
      x: w.x, y: w.centerY,
    };
  }

  /** Бойцу досталось (Worm.damage): для трюков и «Ни царапины». */
  onWormHurt(w, amount, cause = '') {
    if (this.replaying || amount <= 0) return;
    this._noteHit(w, cause);
    if (w.team === this.myTeamIndex) this._myHurt = true;
    else if (this._trickLive()) {
      const t = this._trick;
      t.hit.add(w);
      if (!t.targeted && isLongShot(Math.hypot(w.x - t.x, w.centerY - t.y), CFG.WORLD_W, CFG.WORLD_H)) t.far = true;
    }
  }

  /** Ход отыгран или бой кончился: что вышло из своего выстрела — в трюки. */
  _finishTrick() {
    const t = this._trick;
    this._trick = null;
    if (!t) return;
    const add = shotStats({
      weapon: t.weapon, hang: t.hang, sprung: t.sprung, hits: t.hit.size,
      kills: t.kills, drowns: t.drowns, far: t.far, back: t.back,
    });
    if (Object.keys(add).length) bumpAch(add);
  }

  /**
   * Конец боя: победы, добитые, «Блиц», «На волоске», «Ни царапины» — и
   * заодно вехи по прогрессу (уровень, звёзды, главы уже записаны).
   */
  _achBattleEnd(winner) {
    this._finishTrick();
    if (!this._achSolo) { checkAchievements(); return; }
    const mine = this.worms.filter((w) => w.team === this.myTeamIndex);
    // В сети урон своим приходит снимком мимо Worm.damage — сверяем ещё и
    // здоровье с тем, что было на старте
    const hurt = this._myHurt || mine.some((w) => !w.alive || w.health < (this._hpAtStart?.get(w) ?? w.health));
    checkAchievements(battleEndStats({
      won: winner >= 0 && winner === this.myTeamIndex, mode: this.match.mode, myTurns: this.myTurns, hurt,
      mine: mine.map((w) => ({ alive: w.alive, health: w.health })), kills: this.battleStats.kills,
    }));
  }

  /**
   * Достижения за бой на экране итога: значок, название, награда. В
   * портрете — над итогом под лентой, в ландшафте — колонкой слева от
   * кнопок: в середине и так звёзды, монеты и заголовок.
   */
  _achResult() {
    const list = this.achGot;
    if (!list.length) return;
    this.time.delayedCall(350, () => this.fx.sound('achievement'));
    const W = CFG.VIEW_W, H = CFG.VIEW_H;
    const portrait = H > W;
    const cw = portrait ? Math.min(W - 80, 520) : Math.min(420, W / 2 - 300);
    if (cw < 260) return;
    const x0 = portrait ? (W - cw) / 2 : 24 + (CFG.CORNER || 0);
    let y = portrait ? TOP_H + 150 : H / 2 - 170;
    const ui = (o, d = 13) => {
      this.rig.ui(o.setScrollFactor(0).setDepth(DEPTH.HUD + d));
      this.gameOverUi?.push(o);
      return o;
    };
    ui(this.add.text(x0 + cw / 2, y, '🏅 Достижения за бой', font(22, 800, '#ffe27a'))
      .setOrigin(0.5, 0).setStroke('#10131a', 5));
    y += 40;
    const rh = 62, shown = list.slice(0, 4);
    shown.forEach((a, i) => {
      const parts = [];
      const g = ui(this.add.graphics());
      g.fillStyle(0x1c1440, 0.94).fillRoundedRect(x0, y, cw, rh - 8, 16);
      g.lineStyle(2, 0xffc247, 0.8).strokeRoundedRect(x0, y, cw, rh - 8, 16);
      parts.push(g);
      const key = `emoji_${a.icon}`;
      if (this.textures.exists(key)) parts.push(ui(this.add.image(x0 + 32, y + (rh - 8) / 2, key).setScale(38 / 128), 14));
      parts.push(ui(this.add.text(x0 + 60, y + 15, a.title, font(20, 800, UI.text)).setOrigin(0, 0.5), 14));
      const reward = [a.coins ? `+${a.coins} монет` : '', a.boxes ? 'коробка со скином' : ''].filter(Boolean).join(' · ');
      parts.push(ui(this.add.text(x0 + 60, y + 38, reward, font(15, 700, '#8ef0a0')).setOrigin(0, 0.5), 14));
      for (const o of parts) o.setAlpha(0);
      this.tweens.add({ targets: parts, alpha: 1, duration: 260, delay: 350 + i * 160 });
      y += rh;
    });
    if (list.length > shown.length) {
      ui(this.add.text(x0 + cw / 2, y, `и ещё ${list.length - shown.length} — в меню, «Достижения»`,
        font(16, 700, UI.textDim)).setOrigin(0.5, 0));
    }
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

  /**
   * Подпись у круга отмены («отпусти здесь — выстрела не будет»): первые
   * выстрелы рогаткой. Как отменить выстрел, сам никто не догадывался.
   */
  get cancelHint() {
    if (!this.slingAim) return false;
    if (this._slingUses == null) void this.slingHint;
    return (this._slingUses ?? 0) < 6;
  }

  get hookHint() {
    if (this.coach) return this.coach.wantsHookHint;
    if (!this.sling || this.slingHint) return false;
    // Только в первых двух своих ходах боя: дальше строка висела весь бой
    if (this.myTurns > 2) return false;
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
    // Здоровье на старте — для «Ни царапины»
    this._hpAtStart ??= new Map(this.worms.map((w) => [w, w.health]));
    // Тот, чей ход, подпрыгивает на месте: глаз сразу находит своего
    const active = this.turn.activeWorm;
    if (active) active.squash = -0.9;
    // Твой ход — короткий сигнал в руку: телефон можно не держать перед глазами
    if (this.isLocalTeam(this.turn.currentTeam) && !this.botFor(this.turn.currentTeam)) haptic('turn');
  }

  _applyAmmoRules() {
    // «Окопаться» — только в партиях с тактикой
    const gi = WEAPONS.findIndex((w) => w.id === 'guard');
    if (gi >= 0 && !this.tactics) this.turn.ammo.forEach((row) => { row[gi] = 0; });
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
   * «Арсенал боя»: обеим сторонам — те же оружия по зерну партии
   * (core/loadout.js): три в бою с ботом, пять — с человеком (онлайн и
   * дуэль). В сети у обоих зерно одно, а патроны сверяет снимок хода.
   */
  _applyLoadout() {
    this.loadout = [];
    this.loadoutIdx = [];
    if (!loadoutApplies(this.match)) return;
    // С человеком (онлайн, дуэль) арсенал шире — пять оружий
    // (и вдвоём на одном телефоне: бота в партии нет)
    const pvp = this.match.mode === 'online' || this.match.mode === 'duel'
      || !this.match.teams.some((t) => t.control === 'bot');
    this.loadout = battleLoadout(this.seed, WEAPONS, pvp ? PVP_LOADOUT_SIZE : LOADOUT_SIZE);
    this.loadoutIdx = this.loadout.map((id) => WEAPONS.findIndex((w) => w.id === id));
    for (const row of this.turn.ammo) {
      for (const i of this.loadoutIdx) if (row[i] !== null) row[i] += loadoutAmmo(WEAPONS[i]);
    }
    // В дуэли плашку показываем только в начале партии: открывают её десятки раз
    if (this.match.mode === 'duel' && (this.registry.get('duel')?.turns?.length ?? 0) >= 2) return;
    this.time.delayedCall(this.variant?.intro ? 3300 : 700, () => this._announceLoadout());
  }

  /** Плашка «Арсенал боя: …» с иконками — на пару секунд, бою не мешает. */
  _announceLoadout() {
    if (!this.loadout.length || this.gameOverUi || !this.sys.isActive()) return;
    const W = CFG.VIEW_W, H = CFG.VIEW_H;
    const y = Math.round(H * (H > W ? 0.4 : 0.44));
    const parts = [];
    const add = (o, d = 6) => { this.rig.ui(o.setScrollFactor(0).setDepth(DEPTH.HUD + d)); parts.push(o); return o; };
    const g = add(this.add.graphics(), 5);
    const title = add(this.add.text(0, y - 30, 'Арсенал боя — у обеих сторон', font(20, 800, '#ffe27a')).setOrigin(0.5));
    // Ряд: иконка и название каждого оружия
    const row = this.loadoutIdx.map((i) => {
      const wpn = WEAPONS[i];
      const key = weaponIcon(this, wpn);
      const icon = key ? add(this.add.image(0, y + 14, key).setScale(fitScale(this, key, 40))) : null;
      const n = this.turn.ammo[this.myTeamIndex >= 0 ? this.myTeamIndex : 0][i];
      const name = add(this.add.text(0, y + 14, `${wpn.name}${n > 1 ? ` ×${n}` : ''}`, font(20, 800, UI.text)).setOrigin(0, 0.5));
      return { icon, name, w: (icon ? 46 : 0) + name.width };
    });
    const gap = 26;
    // Пять оружий в одну строку на телефоне не влезают — по три в строке
    const per = H > W ? 3 : 5;
    const lines = [];
    for (let i = 0; i < row.length; i += per) lines.push(row.slice(i, i + per));
    const lineH = 46;
    let total = 0;
    lines.forEach((line, li) => {
      const lw = line.reduce((a, r) => a + r.w, 0) + gap * (line.length - 1);
      total = Math.max(total, lw);
      let x = W / 2 - lw / 2;
      const ly = y + 14 + li * lineH;
      for (const r of line) {
        if (r.icon) { r.icon.setPosition(x + 20, ly); x += 46; }
        r.name.setPosition(x, ly);
        x += r.name.width + gap;
      }
    });
    title.setX(W / 2);
    const bw = Math.max(total, title.width) + 48, bh = 104 + (lines.length - 1) * lineH;
    g.setPosition(W / 2, y);
    g.fillStyle(0x10131a, 0.88).fillRoundedRect(-bw / 2, -56, bw, bh, 20);
    g.lineStyle(3, 0xffd23f, 0.85).strokeRoundedRect(-bw / 2, -56, bw, bh, 20);
    // Не влезло (узкий портрет) — сжимаем всю плашку
    const k = Math.min(1, (W - 24) / bw);
    for (const o of parts) { o.setPosition(W / 2 + (o.x - W / 2) * k, y + (o.y - y) * k); if (o !== g) o.setScale(o.scaleX * k); }
    g.setScale(k);
    for (const o of parts) o.setAlpha(0);
    this.tweens.add({ targets: parts, alpha: 1, duration: 220 });
    this.tweens.add({
      targets: parts, alpha: 0, delay: 2300, duration: 400,
      onComplete: () => parts.forEach((o) => o.destroy()),
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
    // Сцена переживает рестарт: комната прошлой партии здесь не нужна
    this.room = null;
    this.netLocal = false;
    const duel = this.match.mode === 'duel' ? this.registry.get('duel') : null;
    if (duel) { this._setupDuel(duel); return; }
    const room = startRoom();
    if (!room) return;
    this.room = room;
    // До встречи с соперником партии нет: раньше здесь шёл обычный бой за
    // обе команды, и друг, открывший ссылку через несколько часов, играл
    // сам с собой. Теперь — пауза и плашка ожидания (_updateWaitPanel)
    this._waitSince = Date.now();
    this._knocked = false;
    this.knock = null;

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
      this.netLocal = true;
      // Сессию гасим целиком: иначе клиент Realtime продолжит ломиться
      // в сокет до конца партии, которую мы уже играем локально
      this.net?.destroy();
      this.net = null;
      this.registry.set('net', null);
    });
  }

  // ------------------------------------------------- дуэль по переписке

  /**
   * Дуэль по переписке (net/duel.js): сессия притворяется сетевой, и сцена
   * ведёт себя как в онлайне — только соперник не в сети, а в истории.
   */
  _setupDuel(duel) {
    this.net = new DuelSession(duel);
    this.myTeam = this.net.myTeam;
    this.net.attach(this);
    this._netStatus(`⚔️ ${this.net.opponent.name} · восстанавливаю ходы…`);
    // «Пересмотреть ход» — внизу посередине, между стиком и рычагом
    const x = CFG.VIEW_W / 2, y = CFG.VIEW_H - 34;
    this.rewatchBtn = this.rig.ui(this.add.text(x, y, '↺ Пересмотреть ход', font(20, 800, '#1a1408'))
      .setOrigin(0.5).setPadding(16, 8, 16, 8).setBackgroundColor('#ffd166')
      .setScrollFactor(0).setDepth(DEPTH.HUD + 14).setVisible(false));
    this._tapButton(this.rewatchBtn, () => this.rewatchDuel());
    // «Пропустить повтор» — там же, пока идёт показ хода соперника
    this.skipBtn = this.rig.ui(this.add.text(x, y, '▶▶ Пропустить повтор', font(20, 800, '#1a1408'))
      .setOrigin(0.5).setPadding(16, 8, 16, 8).setBackgroundColor('#ffd166')
      .setScrollFactor(0).setDepth(DEPTH.HUD + 14).setVisible(false));
    this._tapButton(this.skipBtn, () => { this.haptic?.('tap'); this.net?.skipShow?.(); });
    // Часы своего хода идут с первого действия игрока. Тап по самим кнопкам
    // повтора — не действие: иначе «Пересмотреть» гасла бы под пальцем
    const begin = (pointer, over) => {
      if (Array.isArray(over) && (over.includes(this.rewatchBtn) || over.includes(this.skipBtn))) return;
      this.net?.begin?.();
    };
    this.input.on('pointerdown', begin);
    this.input.keyboard?.on('keydown', begin);
    this.events.once('shutdown', () => {
      this.input.off('pointerdown', begin);
      this.input.keyboard?.off('keydown', begin);
    });
  }

  /**
   * Кнопка поверх поля, которая слушается только настоящего тапа: палец и
   * опустили, и подняли на ней. Раньше хватало отпускания: рычаг прицела
   * тянут вниз, отпускают над кнопкой — и вместо выстрела она нажималась.
   */
  _tapButton(obj, onTap) {
    obj.setInteractive({ useHandCursor: true });
    let downTime = null;
    obj.on('pointerdown', (pointer) => { downTime = pointer.downTime; });
    obj.on('pointerup', (pointer) => {
      const mine = downTime !== null && pointer.downTime === downTime;
      downTime = null;
      if (mine && pointer.getDistance() < 24) onTap();
    });
    return obj;
  }

  /**
   * Пересмотреть последний ход дуэли: партия собирается заново из истории,
   * и последний ход — чей бы он ни был — показывается в обычном темпе.
   * Начатый свой ход не теряется: кнопки нет, пока что-то сделано.
   */
  rewatchDuel() {
    if (!this.net?.isDuel || !this.net.canRewatch) return;
    this.haptic?.('tap');
    this.registry.set('duel', { ...this.net.duel, replayLast: true });
    this.scene.restart();
  }

  /**
   * Ждём второго игрока: сеть поднята, но никто ещё не пришёл. Партия на
   * паузе — ни ходить, ни тикать часам. Нет сети вовсе — играем локально.
   */
  get waitingPeer() {
    return Boolean(this.room) && !this.net?.isDuel && !this.netLocal && !this.net?.paired;
  }

  /**
   * Плашка «Ждём соперника». Первые секунды молчит (по быстрому бою встреча
   * — дело мгновения), потом говорит, что ждём, а через WAIT_HINT секунд
   * предлагает выход: друга, похоже, сейчас нет в игре.
   */
  _updateWaitPanel() {
    const waiting = this.waitingPeer && this.turn.state !== STATE.OVER;
    if (!waiting) {
      if (this.waitUi) { for (const o of this.waitUi) o.destroy(); this.waitUi = null; }
      return;
    }
    const sec = (Date.now() - this._waitSince) / 1000;
    if (sec < 1.5) return;
    // Позвавшего нет — пусть бот напишет ему «заходи» (один раз за заход)
    if (sec >= 6 && !this._knocked && /^ZW/.test(this.room)) {
      this._knocked = true;
      knockRoom(this.room).then((r) => {
        if (!r || !this.scene.isActive()) return;
        this.knock = r;
        this.waitStage = null;   // перерисовать плашку с новой строкой
      });
    }
    const stage = sec >= GameScene.WAIT_HINT ? 'long' : 'short';
    if (this.waitUi && this.waitStage === stage) return;
    for (const o of this.waitUi ?? []) o.destroy();
    this.waitStage = stage;
    const ui = [];
    const cx = CFG.VIEW_W / 2, cy = CFG.VIEW_H / 2;
    const tour = isTournamentRoom(this.room);
    ui.push(this.rig.ui(this.add.rectangle(0, 0, CFG.VIEW_W, CFG.VIEW_H, 0x070b14, 0.62)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 10).setInteractive()));
    const long = stage === 'long';
    const title = long ? 'Соперника пока нет' : 'Ждём соперника…';
    const knocked = this.knock?.sent || this.knock?.reason === 'limit';
    const sub = knocked
      ? `${this.knock.owner} получил сообщение в Telegram — как зайдёт, бой начнётся`
      : long
        ? (tour ? 'Он ещё не открыл бой. Можно подождать здесь или вернуться позже'
          : 'Похоже, его сейчас нет в игре. Позови ещё раз — или сыграй иначе')
        : 'Бой начнётся, как только он зайдёт';
    ui.push(this.rig.ui(this.add.text(cx, cy - 96, title, font(40, 800, '#ffd166'))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11)));
    ui.push(this.rig.ui(this.add.text(cx, cy - 46, sub, font(18, 700, UI.textDim))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11).setAlign('center')
      .setWordWrapWidth(Math.min(CFG.VIEW_W - 60, 640))));
    ui.push(this.rig.ui(this.add.text(cx, cy - 10, `комната ${this.room}`, font(16, 700, UI.textDim))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11)));
    if (!tour) ui.push(this._overButton(-140, 'Позвать', () => this.shareInvite(), 'wait-invite', -60));
    ui.push(this._overButton(tour ? 0 : 140, 'В меню', () => this.toMenu('root'), 'wait-menu', -60));
    if (long && !tour) {
      ui.push(this._overButton(-140, 'С ботом', () => this.leaveRoomForBot(), 'wait-bot', 24));
      ui.push(this._overButton(140, '⚔️ Дуэль', () => this.toMenu('duels'), 'wait-duel', 24));
    }
    this.waitUi = ui;
  }

  /** Друга нет — бой с ботом вместо комнаты, без рейтинга. */
  leaveRoomForBot() {
    this.net?.forget();
    this.net?.destroy();
    this.net = null;
    this.registry.set('net', null);
    this.registry.set('seed', null);
    this.registry.get('lobby')?.unhost?.();
    forgetStartRoom();
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    this.registry.set('match', fallbackMatch());
    this.scene.restart();
  }

  /** Свой ход ушёл на сервер (ok) или нет — показать, что дальше. */
  /** Строка итога дуэли: окончена и что с рейтингом. */
  _duelRatingText() {
    const d = this.net?.duel?.delta;
    if (d == null) return this.net?.duel?.status === 'finished' ? 'дуэль окончена · без рейтинга' : 'дуэль окончена · рейтинг посчитаю после отправки хода';
    return `дуэль окончена · рейтинг ${d > 0 ? `+${d}` : d}`;
  }

  onDuelSent(ok, error = '') {
    if (this.gameOverUi) {
      if (!ok) this.fx.banner(error || 'ход не отправлен', '#ff9a9a', 2600);
      else {
        if (this._duelSub?.active) this._duelSub.setText(this._duelRatingText());
        syncMe(true);
      }
      return;
    }
    if (ok) this.tips?.show('duel_sent', '📨 Ход отправлен! Бот напишет в Telegram, когда друг сходит. Дуэлей может идти несколько сразу');
    this._duelPanel(ok ? 'Ход отправлен' : 'Ход не отправлен',
      ok ? `${this.net.opponent.name} получит сообщение в Telegram · на ход у него 24 часа`
        : (error || 'попробуй позже'), ok ? '#8ef0a0' : '#ff9a9a');
  }

  /** Соперник сходил, пока мы смотрели дуэль: собираем партию заново и показываем его ход. */
  onDuelUpdate(duel) {
    this.registry.set('duel', duel);
    this.scene.restart();
  }

  onDuelDiverge() {
    this.fx.banner('ход восстановлен не точно · играем по истории сервера', '#ffd166', 1800);
  }

  /** Плашка посреди экрана с выходом: в список дуэлей или в меню. */
  _duelPanel(title, sub, color = '#ffd166') {
    for (const o of this.duelUi ?? []) o.destroy();
    const ui = [];
    ui.push(this.rig.ui(this.add.rectangle(0, 0, CFG.VIEW_W, CFG.VIEW_H, 0x070b14, 0.5)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(DEPTH.HUD + 10)));
    ui.push(this.rig.ui(this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 - 28, title, font(42, 800, color))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11)));
    ui.push(this.rig.ui(this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 + 22, sub, font(18, 700, UI.textDim))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11).setAlign('center')
      .setWordWrapWidth(Math.min(CFG.VIEW_W - 60, 640))));
    ui.push(this._overButton(-140, 'Мои дуэли', () => this.toMenu('duels'), 'duels'));
    ui.push(this._overButton(140, 'В меню', () => this.toMenu('root'), 'menu'));
    ui.push(this._overButton(0, '↺ Пересмотреть ход', () => this.rewatchDuel(), 'rewatch', 96));
    this.duelUi = ui;
    this.rewatchBtn?.setVisible(false);
  }

  /** Строка над полем в дуэли: с кем, чей ход и сколько у него времени. */
  _duelStatus() {
    const n = this.net;
    // Имя без предлога: «партия с Атаман» не склоняется
    const who = `⚔️ ${n.opponent.name}`;
    if (n.phase === 'replay') return [`${who} · повтор хода соперника`, '#ffd166'];
    if (n.phase === 'play') return [`${who} · твой ход${n.started ? '' : ' · часы пойдут, когда начнёшь'}`, '#8ef0a0'];
    if (n.phase === 'over') return [`${who} · дуэль окончена`, '#ffd166'];
    const left = n.duel.deadline ? Math.max(0, n.duel.deadline - Date.now()) : null;
    // Вверх: только что начатый ход — «24 ч», как в сообщении бота
    const h = left === null ? null : left < 3600_000 ? 0 : Math.ceil(left / 3600_000);
    return [`${who} · ход соперника${h === null ? '' : ` · у него ${h > 0 ? `${h} ч` : 'меньше часа'}`}`, '#ffd166'];
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
    if (turn === f.after && !this.fastForward) {
      this.fx.banner(lava ? 'Со следующего хода лава пойдёт вверх' : 'Со следующего хода вода пойдёт вверх',
        lava ? '#ffb37a' : '#9fd8ff', 1800);
    }
    if (level === this.floodLevel) return;
    this.floodLevel = level;
    CFG.WATER_Y = this.waterBase - level;
    CFG.DROWN_Y = CFG.WATER_Y + 15;
    // Дуэль перематывает историю: вода сразу на месте, без шума на каждый ход
    if (this.fastForward) {
      this.waterBody.y = CFG.WATER_Y;
      this.waterLine.y = CFG.WATER_Y;
      return;
    }
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
      // Тренировка — со старых мест: под них подобраны мишень, флажок и трос
      const spots = this.tactics && !this.match.tutorial ? this._findTeamSpots(order) : this._findFloorSpots(order.length);
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

  /**
   * Тактика: команды стартуют далеко друг от друга — за первый ход до
   * соперника не добраться. Свои — не вплотную. Перемешивание то же, что
   * в _findFloorSpots: зерно у обоих одно, точки совпадают.
   */
  _findTeamSpots(order) {
    const all = this.terrain.standSpots();
    for (let i = all.length - 1; i > 0; i--) {
      const j = this.rng.int(0, i);
      [all[i], all[j]] = [all[j], all[i]];
    }
    for (let far = 1100; far >= 250; far -= 50) {
      const picked = [];
      for (const { team } of order) {
        const p = all.find((q) => !picked.some((o) => o.p === q) && picked.every((o) => Math.hypot(o.p.x - q.x, o.p.y - q.y)
          >= (o.team === team ? 120 : far)));
        if (!p) break;
        picked.push({ p, team });
      }
      if (picked.length === order.length) return picked.map((o) => o.p);
    }
    return this._findFloorSpots(order.length);
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
    const physDt = Math.min(delta / 1000, CFG.MAX_DT);
    let dt = physDt;
    // Замедление на добивании: мир на полсекунды вязнет, интерфейс и часы
    // хода идут как шли
    // Стоп-кадр попадания — короче и сильнее замедления
    if (this._stop && performance.now() < this._stop) dt *= 0.04;
    else if (this._slow && performance.now() < this._slow.until) dt *= this._slow.k;

    // Набор силы и поворот прицела считаются по системным часам: дельта
    // Phaser для этого не годится, он её сглаживает и под нагрузкой отдаёт
    // ровные 16.7 мс на кадр независимо от того, сколько времени реально
    // прошло. Часы хода — по игровому времени, но с пределом (_turnClock),
    // страховки полёта и разбора хода — по игровому (TurnManager.update).
    const now = performance.now();
    const realDt = this._lastNow ? Math.min((now - this._lastNow) / 1000, 0.25) : 0;
    this._lastNow = now;

    this._handleMovement(dt, realDt);
    this._drawWalkBar();
    // Бот решает и «держит кнопку» до набора силы — оба шага на системных
    // часах, иначе доворот ствола шёл бы в разы медленнее задуманного.
    if (this.isBotTurn()) this.botFor(this.turn.currentTeam).update(realDt, dt);
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
      // Бой кончился — плашка обучения не должна просвечивать сквозь итог
      if (this.gameOverUi) { this.coach.destroy(); this.coach = null; }
      else {
        this.coach.update();
        if (this.coach.finished) this.coach = null;
      }
    }
    if (!this.coach) this._tipsTick();
    this.ambience?.update(dt);
    for (const m of this.monsters) m.update(dt);
    if (this.monsters.some((m) => !m.alive)) this.monsters = this.monsters.filter((m) => m.alive);
    for (const g of this.gas) g.update(dt);
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
    this.shotTrace?.update();
    this.turn.update(realDt, dt, this._turnClock(realDt, physDt));
    this.hud.update();
    this.offscreen.update();
    this._updateNetStatus();
  }

  /**
   * Сколько часов хода прошло за кадр.
   *
   * По сети и в дуэли — системные часы, как и были: ход кончает тот, кто
   * ходит, и растянуть его на своём медленном телефоне значило бы держать
   * соперника лишние минуты и получать фору в рейтинговой партии.
   *
   * Вне сети — игровое время без замедления на добивании (оно для красоты,
   * часы хода идут как шли): на слабом телефоне за ход можно пройти и
   * подтянуться столько же, сколько на быстром. Но не медленнее чем в
   * TURN_CLOCK_STRETCH раз против системных часов — иначе на совсем
   * задыхающемся устройстве ход тянулся бы минутами.
   */
  _turnClock(realDt, physDt) {
    if (this.waitingPeer) return 0;
    // Дуэль: пока история не восстановлена и идёт повтор — часы стоят.
    // Раньше 25 секунд хода съедались загрузкой и показом хода соперника,
    // и свой ход «пропадал», едва начавшись
    // И пока игрок не начал свой ход (первое касание или клавиша): можно
    // спокойно осмотреть поле после повтора
    // Отход после выстрела (тактика) идёт всегда — и в повторе чужого хода
    if (this.net?.isDuel && this.turn.retreating && this.turn.retreated) return realDt;
    if (this.net?.isDuel && (!this.net.ready || !this.net.started)) return 0;
    if (this.net || this.room) return realDt;
    return Math.min(realDt, Math.max(physDt, realDt / CFG.TURN_CLOCK_STRETCH));
  }

  /** Строка «чей ход» в сетевой партии. Переписывается только при смене. */
  _updateNetStatus() {
    this._updateWaitPanel();
    this.skipBtn?.setVisible(Boolean(this.net?.isDuel && this.net.showing && !this.net.skip));
    if (!this.net?.connected || this.turn.state === STATE.OVER) return;
    if (this.net.isDuel) {
      const [text, color] = this._duelStatus();
      if (text !== this.netStatusText) this._netStatus(text, color);
      this.rewatchBtn?.setVisible(this.net.canRewatch && !this.duelUi?.length);
      return;
    }
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

    // Прыжок помним 150 мс: нажал за миг до приземления — прыгнет, приземлившись
    if (this.moveInput.jumpQueued || Phaser.Input.Keyboard.JustDown(k.jump)) this._jumpAt = this.time.now;
    if (this._jumpAt && (w.grounded || w.hang) && this.time.now - this._jumpAt < 150) {
      // Прыжок тоже из запаса шагов: иначе кончились ноги — допрыгал бы
      if (this.walkLeft == null || this.walkLeft > 0) {
        w.jump();
        this.spendWalk(40);
      }
      this._jumpAt = 0;
    }
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
    this.walkLeft = this.walkPerTurn;
    // Первый ход партии — без троса: к сопернику не долететь с порога
    if (this.tactics && this.turn.turnNumber <= 1) this.hooksLeft = 0;
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
    const chance = this.rules.crateChance ?? CFG.CRATE_CHANCE;
    if (chance <= 0) return;
    const spots = [];
    const edge = Math.min(200, CFG.WORLD_W * 0.12);
    // Не на впечатанный декор: с кроны дерева или крыши камня ящик не взять.
    // Декор строится от зерна, поэтому точки совпадают у обоих в сети
    const props = this.props?.stamped ?? [];
    for (let x = edge; x < CFG.WORLD_W - edge; x += 24) {
      if (this.terrain.isSpawnable(x)
        && !props.some((q) => Math.abs(q.x - x) < q.size / 2 + CFG.CRATE_W / 2)) spots.push(x);
    }
    if (!spots.length) return;
    const drop = (kind) => {
      const pick = kind === 'weapon' ? this._crateWeapon() : null;
      const crate = new Crate(this, this.turnRng.pick(spots), kind, pick?.index ?? null, pick?.rarity ?? null);
      this.crates.push(crate);
      if (pick?.rarity === 'legendary') this.fx.banner('Легендарный ящик!', '#ffd166', 1600);
    };

    // Оружейный дождь: каждый шестой ход — три оружейных ящика разом
    if (this.turn.turnNumber > 0 && this.turn.turnNumber % 6 === 0) {
      this.fx.banner('Оружейный дождь!', '#8cc8ff', 1600);
      for (let i = 0; i < 3 && this.crates.length < CFG.CRATE_MAX + 3; i++) drop('weapon');
      return;
    }
    if (this.crates.length >= CFG.CRATE_MAX) return;
    if (this.turnRng() > chance) return;
    drop(this.turnRng() < CFG.CRATE_HEALTH_CHANCE ? 'health' : 'weapon');
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
      const i = crate.weaponIndex ?? this.turn.randomCrateWeapon(this.turnRng);
      const w = WEAPONS[i];
      this.turn.addAmmo(i, w.crateAmmo, worm.team);
      const rar = WEAPON_RARITY[w.rarity] ?? WEAPON_RARITY.common;
      this.fx.pickup(crate.x, crate.y, `${w.name} +${w.crateAmmo}`, rar.text);
      if (w.rarity === 'legendary' || w.rarity === 'epic') {
        this.fx.callout(crate.x, crate.y - 40, w.rarity === 'legendary' ? 'Легенда!' : 'Эпик!', rar.text, 34);
      }
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
    if (this.net?.isDuel && !this.net.ready) return false;   // дуэль: история ещё восстанавливается
    if (this.waitingPeer) return false;        // соперник ещё не пришёл
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
    // Дуэль: пока идёт повтор хода (в том числе своего — «Пересмотреть
    // ход»), очередь ведёт история, а не мы: иначе в повторе своего хода
    // не было видно ходьбы, а после выстрела он висел до тайм-аута
    if (this.net.isDuel && this.net.phase === 'replay') return this.checkVictory() === null;
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
    // Как стрелял — для трюков: с троса, с батута, откуда
    if (!this.replaying) this._trickShot(w);
    // Свой выстрел — пишем: вдруг выйдет красиво
    if (!this.replaying && !this.isBotTurn() && this.isLocalTeam(this.turn.currentTeam)) this.clip?.start();
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
      // Выстрел — это начало хода и для часов дуэли: иначе отход после
      // выстрела (тактика) ждал бы часов, которые ещё стоят
      this.net?.begin?.();
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
    // Тактика: откуда вылетел — ракета взводится не сразу (Projectile.detonate)
    if (this.tactics) for (const p of shots) p.launch = { x: sx, y: sy };
    this.projectiles.push(...shots);
    // След выстрела — только своему игроку на этом устройстве
    if (!this.replaying && !this.isBotTurn() && this.isLocalTeam(this.turn.currentTeam)) {
      this.shotTrace?.onFire(w, vx, vy, shots, this.turn.weapon);
    }
    this.turn.onFired();
    if (!this.replaying && !this.isBotTurn()) this.coach?.onShot();
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
      if (cfg.radius > 0) this.fx.explosion(x, y, cfg.radius); else this._pullFx(x, y, cfg.damageRadius);
      this.rig.shake(220, cfg.shake ?? 0.006);
      this.props?.hit(x, y, cfg.damageRadius * 0.9, false);
      return;
    }
    // Воронку режем ровно по целым: у соперника она восстанавливается из
    // журнала, а он целочисленный — на дробных координатах края круга
    // разъезжались бы на пиксель, и земля переставала совпадать.
    const ix = Math.round(x), iy = Math.round(y);
    // Магнит (pull) землю не трогает: воронки нет — только тяга к точке
    if (cfg.radius > 0) {
      this.explosionLog.push({ x: ix, y: iy, r: cfg.radius });
      this.explosionHistory.push({ x: ix, y: iy, r: cfg.radius });
      this.terrain.destroyCircle(ix, iy, cfg.radius);
      this.fx.explosion(x, y, cfg.radius);
    } else this._pullFx(x, y, cfg.damageRadius);
    this.rig.shake(220, cfg.shake ?? 0.006);

    for (const c of cfg.pull ? [] : this.crates) {
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
    if (!cfg.pull) this.props?.hit(x, y, cfg.damageRadius * 0.9, true);

    // Батут взрыв ломает
    for (const sp of cfg.pull ? [] : this.springs) {
      if (sp.alive && Math.hypot(sp.x - x, sp.y - 8 - y) <= cfg.damageRadius * 0.8) sp.destroy();
    }

    // Мина рядом со взрывом детонирует — так получаются цепочки.
    // Подрываем через таймер, а не тут же: рекурсия из explode в explode
    // на длинной цепочке ушла бы в стек.
    for (const m of cfg.pull ? [] : this.mines) {
      if (!m.alive || Math.hypot(m.x - x, m.y - y) > cfg.damageRadius) continue;
      m.fuse = 0.12;
      m.armed = true;
    }

    // Тактика: невзведённая ракета едва царапает, прямое попадание — сильнее
    // (blastMul ставит Projectile.detonate), отброс всех взрывов слабее
    const mul = this.blastMul ?? 1;
    const knock = (this.tactics ? 0.7 : 1) * Math.min(1, mul);
    // Кто задел — для причины выбывания: снаряд бойца или стихия (null)
    this._blastBy = owner ?? 'env';
    this._blastCfg = cfg;
    let felt = 0;
    let ouch = null, ouchDmg = 0;
    const shooter = owner?.team ?? this.turn.currentTeam;
    let foesHit = 0;
    // Для истории хода дуэли: кого и на сколько задел этот взрыв, а если
    // никого — как далеко был ближайший (разбор «попал, а урона нет»)
    const boomHits = [];
    let boomNear = Infinity;
    for (const w of this.worms) {
      if (!w.alive) continue;
      const wx = w.x, wy = w.centerY;
      const d = Math.hypot(wx - x, wy - y);
      if (w.team !== shooter) boomNear = Math.min(boomNear, d);
      // Мимо, но рядом — подпрыгнул от испуга
      if (d > cfg.damageRadius && d < cfg.damageRadius + 130) w.startle();
      if (d > cfg.damageRadius) continue;

      const f = 1 - d / cfg.damageRadius;      // линейный спад от центра
      const dmg = Math.round(cfg.damage * f * mul);

      let nx, ny;
      if (d < 1) { nx = 0; ny = -1; } else { nx = (wx - x) / d; ny = (wy - y) / d; }
      // Магнит тянет и с края круга заметно: иначе в 140 px от точки
      // боец едва шевелился
      const kf = (cfg.pull ? Math.max(0.45, f) : f) * (cfg.pull ? 1 : knock);
      w.applyImpulse(nx * cfg.knockback * kf, ny * cfg.knockback * kf - 70 * kf);

      w.damage(dmg, 'взрыв');
      if (dmg > 0) boomHits.push([this.worms.indexOf(w), dmg]);
      if (dmg > 0) felt = Math.max(felt, this.isLocalTeam(w.team) ? 2 : 1);
      if (dmg > 0) this._countHit(w, dmg);
      if (dmg > 0 && w.team !== shooter) {
        foesHit++;
        if (this._turnShot) this._turnShot.hits++;
      }
      if (dmg > ouchDmg) { ouch = w; ouchDmg = dmg; }
    }
    this._blastBy = undefined;
    this._blastCfg = undefined;
    this.net?.noteBoom?.({ x: ix, y: iy, r: cfg.damageRadius, hits: boomHits, near: Number.isFinite(boomNear) ? Math.round(boomNear) : null });
    this._impact(x, y, ouchDmg, foesHit);
    // Сильно досталось — боец вскрикивает. Царапины молча, иначе «ой» на каждый чих
    if (ouch && ouchDmg >= 25 && !this.gameOverUi) voice.say('hurt', { team: ouch.team });
    // Отдача в руку: задели своего — сильно, чужого — коротко
    if (felt === 2) haptic('hurt');
    else if (felt === 1) haptic('hit');
    if (felt) this._botReact(felt === 2);
  }

  /** Магнит: кольца сходятся к точке — видно, куда потянуло. */
  _pullFx(x, y, r) {
    for (let i = 0; i < 3; i++) {
      const ring = this.rig.world(this.add.circle(x, y, r, 0xff5a6e, 0).setStrokeStyle(4, 0xff8a9a, 0.9).setDepth(DEPTH.FX ?? 50));
      this.tweens.add({
        targets: ring, scale: 0.08, alpha: 0, delay: i * 120, duration: 420, ease: 'Cubic.easeIn',
        onComplete: () => ring.destroy(),
      });
    }
    this.fx.sound?.('thunk');
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
    if (dmg >= 45 || foesHit >= 2) this.time.delayedCall(120, () => this._grabHighlight(false));
    if (dmg >= 45 || foesHit >= 2) this.clip?.mark(foesHit >= 2 ? 3 : 2);
  }

  /** Запомнить кадр боя для сторис. Решающий удар важнее любого «Бабах!». */
  _grabHighlight(decisive) {
    if (!canStory() || (this._highlight && !decisive)) return;
    frameShot(this).then((img) => { if (img && (decisive || !this._highlight)) this._highlight = img; });
  }

  /** Клип: в сторис (если MP4 и Telegram умеет), иначе — сохранить. */
  async _clipMenu(sub) {
    const best = this.clip?.best;
    if (!best) return;
    sub?.setText('загружаю клип…');
    if (canStory()) {
      const r = await clipToStory(best);
      if (r === 'ok') { sub?.setText('клип в сторис — осталось опубликовать'); return; }
    }
    const r = await saveClip(best);
    sub?.setText(r.ok ? 'клип сохранён — выкладывай в TikTok, Reels или Shorts' : 'не вышло загрузить клип — попробуй ещё раз');
  }

  /** Карточка победы — в сторис Telegram, со ссылкой-рефералкой. */
  async _shareStory(sub) {
    const mine = this.worms.find((w) => w.team === this.myTeamIndex) ?? this.worms[0];
    const st = this.battleStats;
    const lines = [];
    if (this.match.mode === 'daily') lines.push(`Башня дня взята за ${this.myTurns} ${this.myTurns < 5 ? 'хода' : 'ходов'}`);
    if (this.match.mode === 'daily' && this._daily?.place) lines.push(`${this._daily.place}-е место из ${this._daily.players}`);
    else lines.push(`Урон за бой: ${st.damage}${st.kills ? ` · добито: ${st.kills}` : ''}`);
    lines.push(`Ходов: ${this.turn.turnNumber}`);
    const bot = telegramConfig().bot;
    const card = drawStory({
      shot: this._highlight ?? null,
      fighter: mine ? fighterFrame(this, mine.sheet, 13) : null,
      title: 'ПОБЕДА!',
      lines,
      cta: 'Сыграй со мной!',
      handle: bot ? `@${bot}` : '',
    });
    sub?.setText('готовлю сторис…');
    const r = await shareStory(card, { text: 'Победа в Smiles 💥 Сыграй со мной!', button: 'Играть' });
    if (r === 'upload') sub?.setText('не вышло загрузить картинку — попробуй ещё раз');
    else if (r === 'ok') sub?.setText('сторис готова — осталось опубликовать');
  }

  /**
   * След мгновенного выстрела: у дробовика и биты снаряда нет, и без
   * линии игрок не понимает, куда вообще пришёлся удар.
   */
  drawBeam(x0, y0, x1, y1, color = 0xffe066, duration = 260) {
    const g = this.rig.world(this.add.graphics().setDepth(DEPTH.PROJECTILE));
    g.lineStyle(3, color, 0.9).lineBetween(x0, y0, x1, y1);
    g.lineStyle(9, color, 0.25).lineBetween(x0, y0, x1, y1);
    this.tweens.add({
      targets: g, alpha: 0, duration, ease: 'Cubic.easeIn', onComplete: () => g.destroy(),
    });
  }

  /** Запас шагов полоской под своим бойцом: видно, сколько ещё пройдёт. */
  _drawWalkBar() {
    const w = this.turn.activeWorm;
    const show = this.walkPerTurn && w?.alive && this.canPlayerAct() && !this.isBotTurn()
      && this.isLocalTeam(this.turn.currentTeam) && !w.zip && !this.charging;
    if (!show) { this.walkGfx?.setVisible(false); return; }
    this.walkGfx ??= this.rig.world(this.add.graphics().setDepth(DEPTH.AIM));
    const g = this.walkGfx.setVisible(true);
    g.clear();
    const k = Math.max(0, Math.min(1, this.walkLeft / this.walkPerTurn));
    const bw = 40, bx = Math.round(w.x - bw / 2), by = Math.round(w.y + 6);
    g.fillStyle(0x10131a, 0.75).fillRoundedRect(bx - 2, by - 2, bw + 4, 9, 4);
    if (k > 0) g.fillStyle(k > 0.3 ? 0x8fe36b : 0xffb347, 1).fillRoundedRect(bx, by, Math.max(4, bw * k), 5, 2.5);
    else g.lineStyle(1.5, 0xff8a8a, 0.9).strokeRoundedRect(bx, by, bw, 5, 2.5);
  }

  /** Тактика: сколько ещё можно пройти этим бойцом в этом ходу; null — без счёта. */
  walkBudget(worm) {
    if (this.walkLeft == null || this.replaying || worm !== this.turn.activeWorm) return null;
    return this.walkLeft;
  }

  spendWalk(px) {
    if (this.walkLeft != null) this.walkLeft = Math.max(0, this.walkLeft - px);
  }

  /**
   * Подсказки «один раз» по ходу боя: первая дуэль — что за повтор, что
   * значит свой ход; новые правила — трос и шаги, взвод, «Окопаться».
   * Обучение (Coach) говорит своё — тогда здесь молчим.
   */
  _tipsTick() {
    const t = this.tips;
    if (!t || this.fastForward || this.gameOverUi || this.match.tutorial) return;
    const n = this.net;
    if (n?.isDuel) {
      if (n.showing) t.show('duel_replay', '👀 Это повтор хода соперника — смотри, куда он стрелял. Надоело — «Пропустить повтор» внизу');
      else if (n.phase === 'play' && this.canPlayerAct()) {
        t.show('duel_play', '⚔️ Твой ход! На него сутки — можно выйти и вернуться. Часы пойдут, когда начнёшь');
      }
    }
    const mine = this.canPlayerAct() && !this.isBotTurn() && this.isLocalTeam(this.turn.currentTeam) && !n?.showing;
    if (this.tactics && mine && !this.turn.retreating) {
      t.show('tac_move', '🪢 Трос — один за ход, шаги — полоска под бойцом. За ход к врагу не подбежать — стреляй издалека');
      t.show('tac_arm', '🎯 Ракета взводится не сразу: вплотную почти не ранит. Прямое попадание — +40% урона');
      t.show('tac_guard', '🛡 Не достаёшь врага — тапни 🛡 на ленте два раза: окопаешься, урон вдвое меньше до твоего хода');
    }
  }

  /** Тактика: выстрел долетел — три секунды на отход, шагов хватит на укрытие. */
  onRetreat() {
    if (!this.replaying && !this.isBotTurn() && this.isLocalTeam(this.turn.currentTeam)) {
      this.tips?.show('tac_retreat', '🏃 После выстрела — 3 секунды отойти в укрытие: стик или трос, если остался');
    }
    if (this.walkLeft != null) this.walkLeft = Math.max(this.walkLeft, 160);
    if (this.isLocalTeam(this.turn.currentTeam) && !this.replaying) this.fx.banner('Отход!', '#9fd2ff', 900);
  }

  /** «Окопаться»: вместо выстрела — защита до своего следующего хода. */
  digIn() {
    const i = WEAPONS.findIndex((w) => w.id === 'guard');
    const w = this.turn.activeWorm;
    if (i < 0 || !w || !this.canAct() || this.turn.ammoOf(i) <= 0) return false;
    if (this.turn.weaponIndex !== i) this.turn.setWeaponIndex(i);
    this.fireActiveWorm(w.facing * 10, -10);
    return true;
  }

  /** Начало хода команды: её бойцы вылезают из окопа. */
  clearGuard(team) {
    for (const w of this.worms) if (w.team === team) w.guard = false;
  }

  /** Облако ядовитого газа: живёт в сцене несколько ходов. */
  addGas(x, y, cfg, owner = null) {
    this.gas.push(new GasCloud(this, Math.round(x), Math.round(y), cfg, owner));
    this.fx?.sound?.('thunk');
  }

  /**
   * Конец хода: газ травит тех, кто в облаке. Только у того, кто ходил, —
   * при показе чужого хода итог приносит снимок.
   * @returns {boolean} задело ли кого-то (тогда ход ждёт, пока все встанут)
   */
  tickHazards() {
    if (this.replaying || !this.gas.length) return false;
    let hit = 0;
    for (const g of this.gas) hit += g.tick();
    this.gas = this.gas.filter((g) => g.alive);
    if (hit) this.fx.sound?.('hurt');
    return hit > 0;
  }

  /** Поставить мину. Оружие само её не хранит — предмет живёт в сцене. */
  addMine(x, y, weapon, owner, opts = {}) {
    this.mines.push(new Mine(this, x, y, weapon, owner, opts));
  }

  /**
   * Бумеранг задел бойца: урон и отброс по ходу полёта. При показе чужого
   * хода — только картинка: урон придёт снимком.
   */
  boomerangHit(w, dmg, vx, vy, owner, back = false) {
    this.fx.dust(w.x, w.centerY, 6);
    this.fx.sound('thunk');
    if (this.replaying) return;
    // Задел врага на обратном пути — трюк «Возвращается!»
    if (back && owner && w.team !== owner.team && this._trickLive()) this._trick.back = true;
    w.applyImpulse(Math.sign(vx || 1) * 170, -150);
    w.damage(dmg, 'бумеранг');
    this._countHit(w, dmg);
    if (owner && w.team !== owner.team) this._impact(w.x, w.centerY, dmg, 1);
  }

  /** Тап в полёте: своя сплит-ракета делится. @returns {boolean} поймали ли тап */
  trySplit() {
    if (this.replaying || this.isBotTurn() || !this.isLocalTeam(this.turn.currentTeam)) return false;
    const p = this.projectiles.find((x) => x.alive && (x.weapon.projectile.split || x.weapon.projectile.tapBoom)
      && x.owner === this.turn.activeWorm);
    if (!p) return false;
    const t = p.age;
    if (!p.split()) return false;
    haptic('shot');
    this.net?.sendSplit?.({ turn: this.turn.turnNumber, t });
    return true;
  }

  /** Соперник разделил ракету: делим нашу копию в тот же момент полёта. */
  remoteSplit(msg) {
    if (msg.turn !== this.turn.turnNumber) return;
    const p = this.projectiles.find((x) => x.alive && (x.weapon.projectile.split || x.weapon.projectile.tapBoom));
    if (!p) return;
    if (p.age >= msg.t) p.split();
    else p.splitAt = msg.t;
  }

  /** Что в оружейном ящике: сначала редкость по шансам, потом оружие этой редкости. */
  _crateWeapon() {
    const rng = this.turnRng;
    const pool = (rar) => WEAPONS.map((w, i) => ({ w, i }))
      .filter(({ w }) => w.startAmmo !== null && w.rarity === rar
        && (!this.rules.only || this.rules.only.includes(w.id)));
    let r = rng() * Object.values(WEAPON_RARITY).reduce((a, x) => a + x.odds, 0);
    let rarity = 'common';
    for (const [k, v] of Object.entries(WEAPON_RARITY)) {
      r -= v.odds;
      if (r < 0) { rarity = k; break; }
    }
    let list = pool(rarity);
    if (!list.length) { list = pool('common'); rarity = 'common'; }
    if (!list.length) return { index: this.turn.randomCrateWeapon(rng), rarity: 'common' };
    return { index: list[rng.int(0, list.length - 1)].i, rarity };
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
    this.clip?.finish();
    // Свой ход отыгран: трюк, если вышел, — плашкой, пока помнится выстрел
    this._finishTrick();
    if (shot && shot.team === actedTeam && shot.hits === 0 && !this.gameOverUi) {
      const mockers = this.worms.filter((w) => w.alive && w.team !== actedTeam);
      for (const w of mockers) w.taunt();
      if (mockers.length) voice.say('laugh', { team: mockers[0].team });
    }
    this.net?.sendState(actedTeam);
    this.explosionLog = [];
  }

  onWormDied(worm, cause = '') {
    this._noteKo(worm, cause);
    // Трюки: кого добил своим выстрелом и кто из них ушёл в воду; свой
    // выбыл — «Ни царапины» уже не будет (утонувшему урона не наносят)
    if (!this.replaying) {
      if (worm.team === this.myTeamIndex) this._myHurt = true;
      else if (this._trickLive()) {
        this._trick.kills++;
        if (cause === 'утонул') this._trick.drowns++;
      }
    }
    // Добивание — главное событие хода: мир замирает на полсекунды. Решающее
    // (команда выбита) — дольше, с наездом камеры и выкриком
    const decisive = this.checkVictory() !== null;
    if (!this.replaying) this._slow = decisive ? { until: performance.now() + 1500, k: 0.2 } : { until: performance.now() + 520, k: 0.28 };
    if (decisive) {
      this.rig.punch(0.14, 900);
      this.fx.callout(worm.x, worm.centerY - 70, 'Решающий!', '#ffd166', 44);
      // Лучший кадр боя — для сторис: чуть позже, чтобы выкрик успел вырасти
      this.time.delayedCall(140, () => this._grabHighlight(true));
      this.clip?.mark(5);
    }
    if (this._myStrike() && worm.team !== this.myTeamIndex) {
      this.battleStats.kills++;
      this.clip?.mark(3);
    }
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

  // ------------------------------------------------- почему выбыл боец

  /** Кто задел — словами: свой игрок «ты», бот или человек — «соперник». */
  _whoLabel(team) {
    const solo = this.bots?.some(Boolean) || this.net?.connected;
    if (!solo) return TEAM_NAMES[team] ?? '';
    return team === this.myTeamIndex ? 'ты' : 'соперник';
  }

  /**
   * Запомнить, кто задел бойца последним. Падение — следствие удара, автора
   * не меняет. Бита, гиря и бумеранг бьют мимо explode — тогда автор тот,
   * чей ход; монстры, бочки и молнии (взрыв без хозяина) — стихия.
   */
  _noteHit(w, cause) {
    if (cause === 'падение') return;
    const turn = this.turn.turnNumber;
    const by = this._blastBy;
    if (cause === 'кактус' || by === 'env' || (!by && !this.turn.activeWorm)) {
      w.lastHit = { team: -1, weapon: cause === 'кактус' ? 'кактус' : 'взрыв', who: null, turn };
      return;
    }
    const shooter = by?.team !== undefined ? by : this.turn.activeWorm;
    // Мина и ракета живут дольше хода: оружие — по взрыву, а не по руке
    const weapon = (this._blastCfg && WEAPONS.find((x) => x.explosion === this._blastCfg)) || this.turn.weapon;
    w.lastHit = { team: shooter.team, weapon: weapon?.name ?? '', who: this._whoLabel(shooter.team), turn };
  }

  /** Боец выбыл: причина — выкриком у него, строкой в журнал и в итог боя. */
  _noteKo(worm, cause) {
    if (!worm || this.kos.some((k) => k.worm === worm)) return;
    const ko = koCause({
      cause, hit: worm.lastHit ?? null, turn: this.turn?.turnNumber ?? 0,
      victimTeam: worm.team, tower: Boolean(this.terrain?.tops),
    });
    this.kos.push({ worm, team: worm.team, kind: ko.kind, byTeam: ko.byTeam });
    if (this.fastForward) return;    // перемотка истории дуэли — без выкриков
    // Утонувший уже под водой: выкрик — над её кромкой
    const y = Math.min(worm.centerY, (CFG.WATER_Y ?? worm.centerY) - 10) - 34;
    this.fx.callout(worm.x, y, ko.text, '#ffe9c2', 22);
    this.koLog?.add(worm.team, `${TEAM_NAMES[worm.team] ?? ''}: ${ko.text}`);
  }

  /** Строка итога «Победа: 1 добил ты · 1 утонул» — под заголовком. */
  _koResult(winner, y) {
    const solo = this.bots?.some(Boolean) || this.net?.connected;
    if (!solo || winner < 0) return;
    const text = koSummary(this.kos, { won: winner === this.myTeamIndex, myTeam: this.myTeamIndex, boss: Boolean(this.match.boss) });
    if (!text) return;
    const t = this.rig.ui(this.add.text(CFG.VIEW_W / 2, y, text, font(19, 800, '#e8f0ff'))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11).setStroke('#10131a', 5)
      .setWordWrapWidth(CFG.VIEW_W - 40).setAlign('center').setAlpha(0));
    this.tweens.add({ targets: t, alpha: 1, duration: 300, delay: 450 });
    this.gameOverUi?.push(t);
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
    this.tips?.destroy();
    if (this.net?.isDuel && !this.fastForward) {
      this.time.delayedCall(1800, () => this.tips?.show('duel_rating',
        '🏆 За победы в дуэлях растёт рейтинг: лига и место в топе — в разделе «Рейтинг»'));
    }
    // Выжившие радуются или плачут — у кого есть чем
    for (const w of this.worms) if (w.alive) w.mood = w.team === winner ? 'worm_win' : 'worm_cry';

    // Где есть бот или сеть, «победа красных» ничего не говорит: важно,
    // выиграл ли ты. В хотсите наоборот — команды равноправны.
    const solo = this.bots?.some(Boolean) || this.net?.connected;
    const mine = this.myTeamIndex;
    let text;
    if (winner < 0) text = 'Ничья';
    // Вечеринка: команд много, и людей может быть несколько — победителя
    // называем по цвету (и честно говорим, если это бот)
    else if (this.match.party) text = `Победа: ${TEAM_NAMES[winner]}${this.match.teams[winner]?.control === 'bot' ? ' (бот)' : ''}!`;
    else if (solo) text = winner === mine ? 'Победа!' : 'Поражение';
    else text = `Победа: ${TEAM_NAMES[winner]}!`;
    const color = winner >= 0 ? TEAM_COLORS[winner] : 0xffffff;

    let box = 0;
    // Первое прохождение — монеты сверх обычных за бой (и опыт: 1 — бой, 2 — босс)
    let firstCoins = 0;
    let firstClear = 0;
    if (this.match.mode === 'campaign' && winner === mine) {
      if (!loadProgress().has(this.match.missionId)) { firstCoins = FIRST_CLEAR_COINS.mission; firstClear = 1; }
      markDone(this.match.missionId);
      // За первую, каждую вторую и последнюю миссию — коробка со скином
      box = syncCampaignBoxes();
    }
    if (this.match.mode === 'ascent' && winner === mine) {
      if (markAscentDone(this.match.ascentId)) {
        const boss = ASCENT_BY_ID[this.match.ascentId]?.boss;
        firstCoins = boss ? FIRST_CLEAR_COINS.boss : FIRST_CLEAR_COINS.ascent;
        firstClear = boss ? 2 : 1;
      }
      box = syncCampaignBoxes();
      // Глава пройдена целиком — ещё коробка, один раз
      const chapters = claimChapterBoxes();
      if (chapters.length) { grantBoxes(chapters.length); box += chapters.length; }
    }
    grantCoins(firstCoins);
    // Партия доиграна: запись сессии больше не нужна
    this.net?.forget();
    this.fx.sound(winner === mine ? 'victory' : 'defeat');
    // Тема боя уходит, следом — короткая заставка. В хотсите победил
    // кто-то из своих, это праздник; ничья и проигрыш — грустное «ва-ва»
    music.sting(winner >= 0 && (winner === mine || !solo) ? 'victory' : 'defeat');
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
    // Шахматная партия — на рейтинг (его считает сервер, строка ниже из
    // _duelRatingText), монеты, опыт и задания как за бой с человеком.
    // Открыть доигранную партию можно не раз — награда одна
    const duel = Boolean(this.net?.isDuel);
    const reward = !duel || this.net.claimReward();
    if (duel) {
      ratingLine = 'дуэль · на рейтинг';
    } else if (this.net?.connected && winner >= 0 && casual) {
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
      if (!casual && !duel) this._reportToServer(winner === mine, ratingText, leagueText, tourney);
    }
    const sub = this.add.text(CFG.VIEW_W / 2, CFG.VIEW_H / 2 + (ratingLine ? 68 : 32),
      // На ПК — «клик»: «тап» там читается как опечатка
      `${isDesktop() ? 'клик' : 'тап'}${backToMenu ? ' — в меню' : ' или R — новая карта'}`,
      font(18, 700, UI.textDim))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11);
    this.rig.ui(sub);

    this.gameOverUi = [shade, title, sub];
    this.koLog?.clear();
    // За что победа или поражение — одной строкой под заголовком (с
    // рейтингом под заголовком тесно — тогда над ним)
    this._koResult(winner, CFG.VIEW_H / 2 + (ratingLine ? -70 : 6));

    // Испытание: звёзды и монеты за новые звёзды — строкой над заголовком
    const newStars = this.match.mode === 'challenge' ? this._challengeResult(winner >= 0 && winner === mine)
      : this.match.mode === 'ascent' ? this._ascentResult(winner >= 0 && winner === mine) : 0;
    // Башня дня: итог — в таблицу дня, за первую победу дня монеты
    if (this.match.mode === 'daily') this._dailyResult(winner >= 0 && winner === mine);

    // Бой — в статистику: режим, итог, сколько ходов
    if (reward) track('battle', {
      mode: this.match.fallback ? 'fallback' : duel ? 'duel' : this.net?.connected ? 'online'
        : ['campaign', 'challenge'].includes(this.match.mode) ? this.match.mode : solo ? 'quick' : 'hotseat',
      won: winner >= 0 && winner === mine, turns: this.turn.turnNumber,
    });

    // Монеты за бой и выполненные этим боем задания — над заголовком
    const daily = reward ? this._recordDaily(winner >= 0 && winner === mine) : null;
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

    // Опыт — за любой доигранный бой, и за проигрыш тоже: полоса уровня
    // внизу экрана итога, подарок за новый уровень — сразу
    this.xpGain = reward ? gainXp(battleXp({
      won: winner >= 0 && winner === mine, hotseat: !solo, online: Boolean(this.net?.connected),
      damage: this.battleStats.damage, firstClear, stars: newStars,
    }).total) : null;
    this._xpResult(this.xpGain);
    // Достижения: итог боя и вехи по прогрессу — после опыта, звёзд и глав:
    // они уже записаны. Открытое за бой — списком на экране итога, без плашек
    this.achToasts.clear();
    this._achBattleEnd(winner);
    this._achResult();

    // Дуэль: реванш — новая дуэль с тем же соперником, или к списку дуэлей
    if (duel) {
      for (const o of this.duelUi ?? []) o.destroy();
      this.duelUi = null;
      // Дуэли — на рейтинг: сдвиг считает сервер, когда примет последний ход
      this._duelSub = sub;
      sub.setText(this._duelRatingText());
      const foe = this.net.opponent;
      this.gameOverUi.push(this._overButton(-140, 'Реванш', () => {
        sub.setText('создаю дуэль…');
        createDuel({ opponent: foe.id }).then((d) => {
          // С ним уже идёт другая дуэль — она в списке
          if (d.existing) { this.toMenu('duels'); return; }
          this.registry.set('duel', { ...d, turns: [] });
          this.registry.set('seed', d.seed);
          this.scene.restart();
        }).catch((e) => sub.setText(e.message));
      }, 'rematch'));
      this.gameOverUi.push(this._overButton(140, 'Мои дуэли', () => this.toMenu('duels'), 'duels'));
      // Чем кончилось — посмотреть ещё раз
      if (this.net?.isDuel && (this.net.duel.turns ?? []).length) {
        this.gameOverUi.push(this._overButton(0, '↺ Пересмотреть ход', () => this.rewatchDuel(), 'rewatch', 96));
      }
      return;
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
        : this._overButton(-140, this.match.mode === 'daily' ? 'Ещё попытка' : 'Ещё раз', () => this.scene.restart(), 'again'));
      this.gameOverUi.push(this._overButton(140, 'В меню', () => this.toMenu(), 'menu'));
      // Позвать друга — прямо отсюда: после боя хочется, а до вкладки
      // «Задания» никто не доходит. По ссылке — обоим по коробке
      const link = refLink();
      const won = winner >= 0 && winner === mine;
      // Победа — в сторис: самая заметная реклама, ссылка ведёт по рефералке
      const story = won && canStory() && this.match.mode !== 'hotseat';
      if (story) {
        this.gameOverUi.push(this._overButton(-140, 'В сторис', () => this._shareStory(sub), 'story', 92));
      }
      // Клип лучшего выстрела: дописывается чуть позже экрана итога
      this.clip?.finish();
      this.time.delayedCall(1300, () => {
        if (!this.gameOverUi || !this.clip?.best) return;
        this.gameOverUi.push(this._overButton(0, '🎬 Клип', () => this._clipMenu(sub), 'clip', 184));
      });
      if (link && this.match.mode === 'daily') {
        // Башня дня одна на всех: делимся местом — друг идёт её побить
        this.gameOverUi.push(this._overButton(story ? 140 : 0, 'Поделиться', () => {
          trackStep('invite');
          shareLink(link, this._dailyShareText());
        }, 'share', 92));
      } else if (link && this.match.mode !== 'hotseat' && solo) {
        this.gameOverUi.push(this._overButton(story ? 140 : 0, '⚔️ Позвать друга', () => {
          // Приглашение — всегда на шахматную партию; без входа — ссылка в игру
          if (loggedIn()) {
            inviteToChess().then((r) => { if (r && !r.shared) this.fx.banner('ссылка на дуэль скопирована', '#ffd166', 1800); })
              .catch((e) => this.fx.banner(e.message, '#ff9a9a', 2200));
            return;
          }
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
    if (this.match.tutorial) return { label: 'В бой!', match: rookieMatch() };
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

  /**
   * Башня дня: монеты за первую победу дня, серия дней и карточка итога
   * «Башня дня · 4 хода · 3-е место из 27» — над заголовком, место
   * приходит с сервера. Кнопки «Поделиться» и «Ещё попытка» — в общем ряду.
   */
  _dailyResult(won) {
    const day = this.match.day;
    const hp = this.worms.filter((w) => w.team === this.myTeamIndex && w.alive).reduce((a, w) => a + w.health, 0);
    const res = recordDailyTower(won, day);
    const turns = `${this.myTurns} ${plural(this.myTurns, ['ход', 'хода', 'ходов'])}`;
    this._daily = { won, turns, place: null, players: null };
    const W = CFG.VIEW_W, cx = W / 2, y = CFG.VIEW_H / 2 - 168;
    const cw = Math.min(W - 40, 560), ch = 96;
    const ui = (o, d = 11) => { this.rig.ui(o.setScrollFactor(0).setDepth(DEPTH.HUD + d)); this.gameOverUi?.push(o); return o; };
    const g = ui(this.add.graphics());
    g.fillStyle(0x10131a, 0.9).fillRoundedRect(cx - cw / 2, y - ch / 2, cw, ch, 20);
    g.lineStyle(3, 0xffd23f, 0.85).strokeRoundedRect(cx - cw / 2, y - ch / 2, cw, ch, 20);
    const head = won ? `Башня дня · ${turns}` : 'Башня дня не взята';
    const t = ui(this.add.text(cx, y - 18, `${head} · отправляю…`, font(22, 800, '#ffe27a')).setOrigin(0.5));
    const extra = [];
    if (res.coins) extra.push(`+${res.coins} монет за первую победу дня`);
    if (res.streak) extra.push(`серия: ${res.streak} ${plural(res.streak, ['день', 'дня', 'дней'])}`);
    if (res.bonus) extra.push(`+${res.bonus} монет за серию`);
    if (!won) extra.push('серия держится, пока башня берётся каждый день');
    const t2 = ui(this.add.text(cx, y + 20, extra.join(' · '), font(17, 700, res.bonus ? '#8ef0a0' : UI.textDim)).setOrigin(0.5));
    for (const o of [t, t2]) if (o.width > cw - 24) o.setScale((cw - 24) / o.width);
    submitDailyTower({ day, won, turns: this.myTurns, hp }).then((r) => {
      if (!t.active) return;
      if (!r?.me) { t.setText(`${head} · без сервера не в таблице`); return; }
      this._daily.place = r.me.place;
      this._daily.players = r.players;
      // Таблица хранит лучшую попытку: место — её, а не этой
      t.setText(`${head} · ${r.me.place}-е место из ${r.players}${r.accepted ? '' : ' (лучшая — прежняя)'}`);
      if (t.width > cw - 24) t.setScale((cw - 24) / t.width);
    });
  }

  /** Текст «Поделиться» после «Башни дня». */
  _dailyShareText() {
    const d = this._daily;
    if (!d?.won) return 'Попробуй «Башню дня» в Smiles — одна башня на всех, кто быстрее?';
    const place = d.place ? `, ${d.place}-е место из ${d.players}` : '';
    return `Башня дня: ${d.turns}${place} 💥 Побьёшь?`;
  }

  /**
   * Звёзды боя «Подъёма» — как у испытаний, над заголовком: ★ победа,
   * ★★ за N своих ходов, ★★★ — ещё и без потерь бойцов. Монеты — за новые.
   * @returns {number} сколько звёзд добыто впервые
   */
  _ascentResult(won) {
    const m = ASCENT_BY_ID[this.match.ascentId];
    if (!m) return 0;
    const lost = this.worms.some((w) => w.team === this.myTeamIndex && !w.alive);
    const stars = ascentStarsFor(m, { won, myTurns: this.myTurns, lost });
    const res = saveAscentStars(m.id, stars);
    if (res.coins) grantCoins(res.coins);
    const y = CFG.VIEW_H / 2 - 210;
    for (let i = 0; i < 3; i++) {
      const on = i < stars;
      const t = this.rig.ui(this.add.text(CFG.VIEW_W / 2 + (i - 1) * 74, y, '★',
        font(64, 800, on ? '#ffd23f' : '#3a4052')).setOrigin(0.5).setScrollFactor(0)
        .setDepth(DEPTH.HUD + 11).setStroke('#10131a', 6).setScale(on ? 0.2 : 1));
      if (on) this.tweens.add({ targets: t, scale: 1, duration: 320, delay: 300 + i * 260, ease: 'Back.easeOut' });
      this.gameOverUi?.push(t);
    }
    const turns = ascentStarTurns(m);
    const hint = !won ? 'попробуй ещё раз'
      : stars === 1 ? `★★ — победи за ${turns} ${plural(turns, ['свой ход', 'своих хода', 'своих ходов'])}`
        : stars === 2 ? '★★★ — ещё и не потеряв ни одного бойца' : 'идеально!';
    const line = res.coins ? `${hint} · +${res.coins} монет за новые звёзды` : hint;
    const t = this.rig.ui(this.add.text(CFG.VIEW_W / 2, y + 52, line, font(19, 800, '#ffe27a'))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11).setStroke('#10131a', 5)
      .setWordWrapWidth(CFG.VIEW_W - 40).setAlign('center'));
    this.gameOverUi?.push(t);
    return res.gained;
  }

  /** Звёзды испытания на экране итога. @returns {number} сколько звёзд добыто впервые */
  _challengeResult(won) {
    const c = CHALLENGE_BY_ID[this.match.challengeId];
    if (!c) return 0;
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
    // Обучение пройдено — подарок: коробка со скином, её ждут в меню
    if (won && this.match.tutorial && claimTutorialBox()) {
      grantBoxes(1);
      const gift = this.rig.ui(this.add.text(CFG.VIEW_W / 2, y + 96, '🎁 Подарок за обучение: коробка со скином',
        font(22, 900, '#8ef0a0')).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 11).setStroke('#10131a', 5)
        .setScale(0.3));
      this.tweens.add({ targets: gift, scale: 1, duration: 380, delay: 1100, ease: 'Back.easeOut' });
      this.gameOverUi?.push(gift);
    }
    return res.gained;
  }

  /**
   * Опыт на экране итога: «Ур. 5», полоса и «+N опыта» — полосой внизу
   * экрана. Она ложится поверх кнопок боя (джойстик, «огонь», оружие): бой
   * кончился, а полоса так никому не мешает и не лезет в середину, где
   * заголовок, звёзды и кнопки итога. Полоса доливается на глазах; взят
   * уровень — она добегает до конца, номер подпрыгивает, а над кнопками
   * итога на пару секунд встаёт карточка с подарком.
   */
  _xpResult(gain) {
    if (!gain?.xp) return;
    const W = CFG.VIEW_W, H = CFG.VIEW_H, cx = W / 2;
    // В портрете джойстик и «огонь» выше — полоса закрывает их целиком
    const fh = H > W ? 210 : 104, y = H - fh / 2 - 6;
    const bw = Math.min(340, W - 380), bh = 16;
    const left = cx - bw / 2 + 10;
    const ui = (o, d = 32) => {
      this.rig.ui(o.setScrollFactor(0).setDepth(DEPTH.HUD + d));
      this.gameOverUi?.push(o);
      return o;
    };
    // Подложка до самого низа (и под рамку безопасной области); ловит тапы,
    // чтобы под ней ничего не нажималось
    ui(this.add.rectangle(0, H - fh, W, fh + 400, 0x0b1018, 0.94).setOrigin(0, 0), 31).setInteractive();
    ui(this.add.rectangle(0, H - fh, W, 2, 0xffc247, 0.35).setOrigin(0, 0), 31);
    const by = y - 10;
    const lvl = ui(this.add.text(left - 16, by, `Ур. ${gain.before.level}`, font(26, 900, '#ffe27a'))
      .setOrigin(1, 0.5).setStroke('#10131a', 5));
    ui(this.add.rectangle(left, by, bw, bh, 0x0b1220, 0.9).setOrigin(0, 0.5).setStrokeStyle(2, 0xffc247, 0.55));
    const fill = ui(this.add.rectangle(left, by, Math.max(4, bw * gain.before.progress), bh - 4, 0xffc247)
      .setOrigin(0, 0.5));
    const plus = ui(this.add.text(left + bw + 16, by, `+${gain.xp} опыта`, font(23, 800, '#8fe3ff'))
      .setOrigin(0, 0.5).setStroke('#10131a', 5).setScale(0.4));
    const toNext = (st) => `до ур. ${st.level + 1} ещё ${st.need - st.into}`;
    const note = ui(this.add.text(left + bw / 2, by + 16, toNext(gain.before), font(16, 700, UI.textDim))
      .setOrigin(0.5, 0));
    // Что дальше — строкой под полосой: тяга в следующий бой
    this._goalResult(cx, by + (H > W ? 62 : 44), ui);
    this.tweens.add({ targets: plus, scale: 1, duration: 320, delay: 600, ease: 'Back.easeOut' });

    const to = (k, onComplete) => this.tweens.add({
      targets: fill, width: Math.max(4, bw * k), duration: 700, ease: 'Cubic.easeOut', onComplete,
    });
    this.time.delayedCall(800, () => {
      if (!fill.active) return;
      if (!gain.rewards.length) { to(gain.after.progress, () => note.active && note.setText(toNext(gain.after))); return; }
      to(1, () => {
        if (!fill.active) return;
        lvl.setText(`Ур. ${gain.after.level}`);
        this.tweens.add({ targets: lvl, scale: { from: 1.8, to: 1 }, duration: 420, ease: 'Back.easeOut' });
        fill.width = 4;
        to(gain.after.progress);
        note.setText(toNext(gain.after));
        this._levelUpCard(gain);
      });
    });
  }

  /**
   * «Что дальше»: одна ближайшая цель (core/nextgoal.js) с полоской
   * прогресса. Ведёт в меню (задания, коробки, дорога наград) — строка
   * нажимается; цель «просто сыграй» нажимать незачем, для неё есть «Ещё раз».
   */
  _goalResult(cx, y, ui) {
    if (this.match.tutorial) return;
    const goal = currentGoal();
    if (!goal) return;
    const menu = { tasks: 'tasks', skins: 'skins', road: 'road', achievements: 'achievements' }[goal.action];
    const t = ui(this.add.text(cx, y, `🎯 ${goal.text}${menu ? ' ›' : ''}`, font(19, 800, menu ? '#8ef0a0' : '#ffe9c2'))
      .setOrigin(0.5).setStroke('#10131a', 5));
    if (t.width > CFG.VIEW_W - 40) t.setScale((CFG.VIEW_W - 40) / t.width);
    const bw = Math.min(t.displayWidth, 320);
    ui(this.add.rectangle(cx - bw / 2, y + 17, bw, 5, 0x0b1220, 0.9).setOrigin(0, 0.5));
    ui(this.add.rectangle(cx - bw / 2, y + 17, Math.max(3, bw * Math.min(1, goal.progress)), 5, 0x8ef0a0).setOrigin(0, 0.5));
    if (!menu) return;
    t.setInteractive({ useHandCursor: true });
    t.on('pointerup', () => this.toMenu(menu));
    (this.overButtons ??= {}).goal = { x: cx, y };
  }

  /** Что в подарке — одной строкой: «+150 монет · коробка со скином». */
  _rewardText(rewards) {
    const coins = rewards.reduce((a, r) => a + r.coins, 0);
    const boxes = rewards.reduce((a, r) => a + r.boxes, 0);
    const parts = [];
    if (coins) parts.push(`+${coins} монет`);
    if (boxes) parts.push(boxes > 1 ? `коробки со скином ×${boxes}` : 'коробка со скином');
    for (const r of rewards) {
      if (r.cos) parts.push(`${COS_LABEL[r.cos.kind]} «${cosItem(r.cos.kind, r.cos.id)?.name}»`);
    }
    return parts.join(' · ');
  }

  /** Новый уровень: карточка с подарком над кнопками итога, конфетти, вибрация. */
  _levelUpCard(gain) {
    const W = CFG.VIEW_W, H = CFG.VIEW_H, cx = W / 2;
    const cw = Math.min(W - 40, 560), ch = 220;
    const cy = H / 2 - 112;
    const top = cy - ch / 2;
    const items = [];
    const add = (o) => {
      this.rig.ui(o.setScrollFactor(0).setDepth(DEPTH.HUD + 14));
      items.push(o);
      this.gameOverUi?.push(o);
      return o;
    };
    const card = add(this.add.graphics());
    card.fillStyle(0x1c1440, 0.96).fillRoundedRect(cx - cw / 2, top, cw, ch, 26);
    card.lineStyle(4, 0xffc247, 0.9).strokeRoundedRect(cx - cw / 2, top, cw, ch, 26);
    add(this.add.text(cx, top + 34, 'Новый уровень!', font(24, 800, '#ffe9c2')).setOrigin(0.5));
    add(this.add.text(cx, top + 92, `Уровень ${gain.after.level}`, font(52, 900, '#ffe27a'))
      .setOrigin(0.5).setStroke('#5a2a08', 7));
    const boxes = gain.rewards.some((r) => r.boxes);
    const icon = boxes && this.textures.exists('shot_crate_weapon') ? 'shot_crate_weapon'
      : this.textures.exists('menu-coin') && gain.rewards.some((r) => r.coins) ? 'menu-coin' : null;
    const line = add(this.add.text(cx, top + 166, `${icon ? '' : '🎁 '}${this._rewardText(gain.rewards)}`, font(23, 800, '#8ef0a0'))
      .setOrigin(0.5).setStroke('#10131a', 5).setWordWrapWidth(cw - (icon ? 110 : 40)).setAlign('center'));
    if (icon) {
      const img = add(this.add.image(cx - line.width / 2 - 30, top + 166, icon));
      img.setScale(Math.min(46 / img.width, 46 / img.height));
      line.setX(cx + 22);
      img.setX(line.x - line.width / 2 - 30);
    }
    // Вся карточка — из центра, с перехлёстом: это главный момент экрана
    const pivot = { k: 0.2 };
    const place = () => {
      for (const o of items) {
        if (!o.active) continue;
        o.__base ??= { x: o.x, y: o.y, s: o.scale };
        o.setScale(o.__base.s * pivot.k);
        o.setPosition(cx + (o.__base.x - cx) * pivot.k, cy + (o.__base.y - cy) * pivot.k);
      }
    };
    place();
    this.tweens.add({ targets: pivot, k: 1, duration: 460, ease: 'Back.easeOut', onUpdate: place });
    this.fx.confetti();
    this.fx.sound('pickup');
    haptic('win');
    // Карточка уходит сама: экран итога под ней нужен целиком
    this.time.delayedCall(3200, () => {
      this.tweens.add({ targets: items.filter((o) => o.active), alpha: 0, duration: 450 });
    });
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
    this._tapButton(img, onTap);
    const text = this.rig.ui(this.add.text(x, y, label, font(26, 800))
      .setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH.HUD + 13));
    this.gameOverUi?.push(text);
    // Кнопку убрали — и надпись с ней (плашка дуэли живёт без gameOverUi)
    img.once('destroy', () => text.destroy());
    return img;
  }

  /** Соперник нажал реванш раньше нас — покажем это. */
  onPeerRematch() {
    this.fx.banner('соперник хочет реванш', '#8ef0a0', 2200);
  }

  /** Выход в меню: сетевую сессию рвём, иначе она переживёт партию. */
  toMenu(returnTo = null) {
    // Вышли сами — возвращаться в эту партию не предложим
    this.net?.forget();
    this.net?.destroy();
    this.registry.set('net', null);
    this.registry.set('seed', null);
    // Из дуэли по переписке — к списку дуэлей (или куда попросили)
    if (this.match.mode === 'duel') {
      this.registry.set('duel', null);
      this.registry.set('returnTo', returnTo ?? 'duels');
    }
    forgetStartRoom();
    // «Что дальше» ведёт в свой раздел меню — это важнее списка режима
    const goal = ['tasks', 'skins', 'road', 'achievements'].includes(returnTo) && this.match.mode !== 'duel';
    if (goal) this.registry.set('returnTo', returnTo);
    // Из испытания — обратно к списку испытаний
    else if (this.match.mode === 'challenge' && !this.match.tutorial) this.registry.set('returnTo', 'challenges');
    else if (this.match.mode === 'ascent') this.registry.set('returnTo', 'ascent');
    else if (this.match.mode === 'daily') this.registry.set('returnTo', 'daily');
    if (new URLSearchParams(location.search).has('room')) {
      const url = new URL(location.href);
      url.searchParams.delete('room');
      history.replaceState(null, '', url);
    }
    this.scene.start('Menu');
  }

  _shutdown() {
    // Сессия дуэли живёт одну сцену: перезапуск собирает её заново
    if (this.net?.isDuel) { this.net.destroy(); this.net = null; }
    this.duelUi = null;
    this.waitUi = null;
    this.waitStage = null;
    this.clip?.destroy();
    this.clip = null;
    this.game.events.off('worms-resize', this.relayout, this);
    globalThis.document?.body.classList.remove('in-battle');
    setBattle(false);
    closeOverlay();
    this.input?.setDefaultCursor?.('default');
    this.mouseFire = false;
    this.mines = [];
    this.springs = [];
    this.gas = [];
    this.monsters = [];
    this.props = null;
    this.ambience = null;
    this.affixes = null;
    this.aim?.destroy();
    this.shotTrace?.destroy();
    this.shotTrace = null;
    this.koLog = null;
    this.crates = [];
    this.rig?.destroy();
    this.offscreen?.destroy();
    this.projectiles = [];
    this.worms = [];
  }
}
