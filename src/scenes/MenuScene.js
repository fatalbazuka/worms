import { UI, font, ensureButton, ensureIcon } from '../ui/theme.js';
import { CFG } from '../config.js';
import { MISSIONS, loadProgress, isUnlocked } from '../campaign/missions.js';
import { objectiveText } from '../campaign/objectives.js';
import {
  quickMatch, campaignMatch, onlineMatch, towerMatch, fallbackMatch, challengeMatch, ascentMatch, QUICK_OPTIONS,
} from '../core/match.js';
import { CHALLENGES, challengeOpen, totalStars, STAR_COINS } from '../campaign/challenges.js';
import { ASCENT, CHAPTERS, ascentOpen } from '../campaign/ascent.js';
import { ascentDone } from '../platform/ascent.js';
import { challengeStars } from '../platform/challenges.js';
import { onboardStage } from '../platform/onboard.js';
import { SHAPES } from '../core/shapes.js';
import { randomRoom, copyText } from '../net/transport.js';
import { isCasualRoom, isTowerRoom } from '../net/rooms.js';
import { Lobby } from '../net/lobby.js';
import { pendingSession, forgetSession } from '../net/session.js';
import {
  syncMe, fetchTop, myRank, loggedIn, onAccountChange, track, fetchShop, buyShopItem,
  trackStep, prepareChallenge,
} from '../net/server.js';
import { openAccountDialog } from '../ui/AccountDialog.js';
import { openTournaments } from '../ui/Tournaments.js';
import { askText, closeOverlay } from '../ui/Overlay.js';
import { makeTransport } from '../net/connect.js';
import { player } from '../platform/player.js';
import {
  inviteLink as tgInviteLink, shareRoom, shareMessage, canOfferHomeScreen, addToHomeScreen, onHomeScreenChange,
  haptic, inTelegram, botLink, openInvoice, refLink, shareLink,
} from '../platform/telegram.js';
import { leagueOf, nextLeague, leagueProgress, toNextLeague, leagueLabel } from '../platform/league.js';
import { BOT_LEVELS } from '../ai/Bot.js';
import { isDesktop, setUiMode, aimScheme, setAimScheme } from '../platform/device.js';
import { sfx } from '../audio/Sfx.js';
import { SKINS, SKIN_BY_ID, SKIN_STARS, rewardMissions } from '../core/skins.js';
import {
  skinState, equippedSkin, equipSkin, openSkinBox, syncCampaignBoxes, applyServerOwned,
} from '../platform/skins.js';
import {
  TASK_BY_ID, BOX_PRICE, STREAK_COINS, STREAK_BOX_DAY, streakReady, dayKey, prevDay as prevDayOf,
} from '../core/daily.js';
import {
  dailyState, rewardWaiting, claimDailyTask, claimDailyStreak, buyBox,
} from '../platform/daily.js';
import { fitScale } from '../core/assets.js';

/**
 * Меню.
 *
 * Один экран на всё: разделы переключаются перерисовкой, отдельных сцен под
 * каждый нет — так проще держать общий фон и не гонять загрузку по кругу.
 *
 * Разделы:
 *   быстрая игра — случайная карта, соперник рядом или бот;
 *   кампания     — миссии с фиксированной картой и условиями;
 *   онлайн       — лобби: создать комнату или войти по коду.
 *
 * Кнопки складываются в this.buttons — по ним ходит тест, чтобы не считать
 * раскладку у себя заново.
 */
/** Русское склонение: 1 день, 2 дня, 5 дней. */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Через сколько секунд поиска без соперника предлагается бой с ботом. */
const FALLBACK_AFTER = 20;

export default class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  create() {
    // Раскладка — в логическом экране, фон — на весь канвас: фон рисует
    // главная камера, а всё остальное — uiCam, чей вьюпорт сдвинут внутрь
    // на рамку безопасной области (под кнопки Telegram и «чёлку»).
    this.items = [];
    this.buttons = {};

    this.cameras.main.setBackgroundColor('#0d1220');
    // Вернулись в меню — в лобби мы снова свободны
    this.lobby?.idle();
    const f = CFG.FRAME;
    this.uiCam = this.cameras.add(f.left, f.top, CFG.VIEW_W, CFG.VIEW_H);
    this._measure();
    // Всё, что появляется в сцене, — интерфейс, кроме фона: он помечается
    // отдельно в _backdrop, а остальное разводится по камерам здесь.
    const assignCamera = (go) => {
      // Лобби живёт и когда меню уснуло, и может дорисовать список уже
      // без камер — тогда просто нечего разводить
      const bg = this.cameras?.main;
      if (!bg || !this.uiCam) return;
      if (this._addingBackdrop) this.uiCam.ignore(go);
      else bg.ignore(go);
    };
    this.events.on('addedtoscene', assignCamera);
    this.events.once('shutdown', () => this.events.off('addedtoscene', assignCamera));
    this._backdrop();
    // Коробки за миссии, пройденные раньше, чем появились скины
    syncCampaignBoxes();
    this.showRoot();

    // Вернулись из турнирного матча — сразу к сетке. Пришли по кнопке бота
    // (?tour=ID или ?tour=list) — к турнирам, один раз за запуск.
    // Из испытания — обратно к их списку
    if (this.registry.get('returnTo') === 'challenges') {
      this.registry.set('returnTo', null);
      this.time.delayedCall(30, () => this.showChallenges());
    }
    if (this.registry.get('returnTo') === 'ascent') {
      this.registry.set('returnTo', null);
      this.time.delayedCall(30, () => this.showAscent());
    }
    const back = this.registry.get('returnTour');
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const fromLink = params.get('tour');
    if (back) {
      this.registry.set('returnTour', null);
      this.time.delayedCall(50, () => this.openTournaments(back));
    } else if (fromLink && !this.registry.get('tourLinkUsed')) {
      this.registry.set('tourLinkUsed', true);
      this.time.delayedCall(300, () => this.openTournaments(/^\d+$/.test(fromLink) ? Number(fromLink) : null));
    }

    this.input.keyboard?.on('keydown-ESC', () => this.showRoot());

    // Повернули телефон или уехала панель браузера — раскладка считается
    // от ширины экрана, поэтому раздел перерисовывается целиком.
    this.game.events.on('worms-resize', this._relayout, this);
    // Telegram узнал, стоит ли иконка на экране Домой: кнопка появляется
    // или пропадает
    const offHome = onHomeScreenChange(() => {
      if (this.section === this.showRoot) this.showRoot();
    });
    // Вошли, вышли, сменили ник, сервер прислал свежий рейтинг — разделы с
    // профилем перерисовываются
    const offAccount = onAccountChange(() => {
      if ([this.showRoot, this.showOnline, this.showTop].includes(this.section)) this.section.call(this);
    });
    this.events.once('shutdown', () => {
      this.game.events.off('worms-resize', this._relayout, this);
      offHome();
      offAccount();
      closeOverlay();
    });
  }

  _relayout() {
    const f = CFG.FRAME;
    this.uiCam.setViewport(f.left, f.top, CFG.VIEW_W, CFG.VIEW_H);
    this._measure();
    this.backdropImage?.destroy();
    this.textures.remove('menu-bg');
    this._backdrop();
    (this.section ?? this.showRoot).call(this);
  }

  /**
   * Размеры раскладки. Разделы размечены под высоту 720; в портрете экран
   * выше, и содержимое центрируется по вертикали: камера интерфейса
   * прокручена на oy, так что y=0 раздела оказывается на oy экрана. Что
   * прижато к низу экрана (назад, «на экран Домой»), считается от bottomY.
   */
  _measure() {
    this.W = CFG.VIEW_W;
    this.H = CFG.VIEW_H;
    this.portrait = this.H > this.W;
    // В вертикальном телефоне раздел начинается у верха экрана, как любой
    // экран в приложении; раньше блок висел посередине, а сверху и снизу
    // зияла пустота. В высоком ландшафте (планшет) — по центру, как было.
    this.oy = this.portrait ? 56 : Math.max(0, Math.round((this.H - CFG.VIEW_BASE) / 2));
    this.uiCam.scrollY = -this.oy;
  }

  /** y в координатах раздела для точки на расстоянии d от низа экрана. */
  bottomY(d) { return this.H - this.oy - d; }

  /** Небо и силуэт холмов: пустой тёмный экран смотрелся заготовкой. */
  _backdrop() {
    const W = this.scale.width, H = this.scale.height;   // весь канвас
    const key = 'menu-bg';
    if (!this.textures.exists(key)) {
      const tex = this.textures.createCanvas(key, W, H);
      const ctx = tex.getContext();
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#1b2a4a');
      sky.addColorStop(0.55, '#2c3f5e');
      sky.addColorStop(1, '#55407a');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);

      // Три гряды холмов той же формы, что и в игре: сумма синусоид
      const bands = [
        { y: H * 0.62, amp: 26, freq: 0.004, color: 'rgba(20,28,44,0.55)' },
        { y: H * 0.74, amp: 34, freq: 0.0026, color: 'rgba(14,20,32,0.75)' },
        { y: H * 0.88, amp: 22, freq: 0.0061, color: '#0b1018' },
      ];
      for (const b of bands) {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 4) {
          const y = b.y + Math.sin(x * b.freq) * b.amp + Math.sin(x * b.freq * 2.7) * b.amp * 0.4;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fillStyle = b.color;
        ctx.fill();
      }
      tex.refresh();
    }
    this._addingBackdrop = true;
    this.backdropImage = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(-10);
    this._addingBackdrop = false;
  }

  // ------------------------------------------------------------- разделы

  _clear() {
    for (const o of this.items) o.destroy();
    this.items = [];
    this.buttons = {};
    this.buttonTexts = {};
    this.copiedLabel = null;
  }

  _title(text, sub = '') {
    const t = this.add.text(this.W / 2, 54, text, font(44, 800, UI.accent)).setOrigin(0.5, 0);
    this.items.push(t);
    if (sub) {
      this.items.push(this.add.text(this.W / 2, 106, sub, font(this.fs(15), 700, UI.textDim))
        .setOrigin(0.5, 0));
    }
    return t;
  }

  /**
   * Кнопка меню. Ширина фиксированная, чтобы столбец читался как список,
   * а не как набор разных плашек.
   */
  _button(key, x, y, label, hint, onTap, {
    w = 420, h = 66, variant = 'normal', enabled = true, into = null, big = false,
    titleSize = null, hintSize = null,
  } = {}) {
    const texKey = `menu-btn-${w}x${h}-${variant}`;
    ensureButton(this, texKey, w, h, variant);
    const img = this.add.image(x, y, texKey).setOrigin(0.5);
    const alpha = enabled ? 1 : 0.45;
    img.setAlpha(alpha);

    // big — главная кнопка экрана: надпись вдвое крупнее обычной
    const title = this.add.text(x, big ? y - h * 0.13 : hint ? y - 10 : y, label,
      font(titleSize ?? (big ? 42 : isDesktop() ? (hint ? 20 : h < 50 ? 17 : 22) : (hint ? 23 : h < 50 ? 20 : 25)),
        800, enabled ? UI.text : UI.textDim))
      .setOrigin(0.5).setAlpha(alpha);
    if (!big && hint && h >= 80) title.setY(y - h * 0.16);
    this.items.push(img, title);
    into?.push(img, title);
    let sub = null;
    if (hint) {
      sub = this.add.text(x, big ? y + h * 0.27 : h >= 80 ? y + h * 0.2 : y + 15, hint,
        font(hintSize ?? (big ? 20 : this.fs(12)), 700, big ? '#ffe9c2' : UI.textDim))
        .setOrigin(0.5).setAlpha(alpha);
      this.items.push(sub);
      into?.push(sub);
    }
    // Надписи кнопки — чтобы обновлять подсказку на месте (счётчик поиска)
    this.buttonTexts ??= {};
    this.buttonTexts[key] = { title, sub };
    // Действие кнопки — чтобы нажать её из кода (вызов друга с главного экрана)
    this.buttonHandlers ??= {};
    this.buttonHandlers[key] = enabled ? onTap : null;

    if (enabled) {
      img.setInteractive({ useHandCursor: true });
      img.on('pointerdown', () => { img.setScale(0.97).setTint(0xcccccc); haptic('tap'); });
      const release = () => img.setScale(1).clearTint();
      img.on('pointerout', release);
      img.on('pointerup', () => { release(); onTap(); });
    }
    // Координаты для тестов — экранные (раздел прокручен на oy)
    this.buttons[key] = { x, y: y + this.oy, w, h, enabled };
    return img;
  }

  /**
   * Полоса лиги: где игрок внутри своей ступени и сколько до следующей.
   *
   * Голое число рейтинга не говорит ни много это, ни мало. Полоса отвечает
   * на оба вопроса сразу — видно и положение внутри лиги, и цель.
   */
  _leagueBar(cx, y, rating, w = 420, size = 12) {
    const h = size > 12 ? 14 : 10;
    const cur = leagueOf(rating);
    const next = nextLeague(rating);
    const left = cx - w / 2;

    this.items.push(this.add.rectangle(left, y, w, h, 0x0b1220, 0.85).setOrigin(0, 0.5));
    const fill = Math.max(3, Math.round(w * leagueProgress(rating)));
    this.items.push(this.add.rectangle(left, y, fill, h, cur.color).setOrigin(0, 0.5));

    this.items.push(this.add.text(left, y + 12, cur.name, font(size, 800, cur.text))
      .setOrigin(0, 0));
    this.items.push(this.add.text(left + w, y + 12,
      next ? `до «${next.name}» ещё ${toNextLeague(rating)}` : 'выше некуда',
      font(size, 700, UI.textDim)).setOrigin(1, 0));
  }

  _back(onTap = () => this.showRoot()) {
    this._button('back', 108, this.bottomY(52), '← назад', '', onTap, { w: 180, h: 60, titleSize: 22 });
  }

  /**
   * Кегль для мелкого текста. На телефоне логический пиксель — около
   * половины экранного, и 12-й кегль выходит в шесть точек: не читается.
   * Под пальцы мелкие подписи на четверть крупнее, на ПК — как были.
   */
  fs(n) { return isDesktop() ? n : Math.round(n * 1.3); }

  /** Вертикальный телефон: кнопки во всю ширину и крупные, в столбик. */
  get roomy() { return this.portrait && !isDesktop(); }

  /** Размеры крупной кнопки-строки для вертикального экрана. */
  get rowStyle() {
    return { w: Math.min(this.W - 64, 620), h: 92, titleSize: 28, hintSize: 18 };
  }

  /** y от верха экрана в координатах раздела (сам раздел сдвинут на oy). */
  topY(d) { return d - this.oy; }

  /** Маленькая квадратная кнопка со значком. */
  _iconButton(key, x, y, icon, onTap, size = 52) {
    const texKey = `menu-icon-btn-${size}`;
    ensureButton(this, texKey, size, size, 'normal');
    const img = this.add.image(x, y, texKey).setOrigin(0.5);
    const glyph = this.add.image(x, y, ensureIcon(this, icon, Math.round(size * 0.62)));
    this.items.push(img, glyph);
    img.setInteractive({ useHandCursor: true });
    img.on('pointerdown', () => { img.setScale(0.94); haptic('tap'); });
    img.on('pointerout', () => img.setScale(1));
    img.on('pointerup', () => { img.setScale(1); onTap(); });
    this.buttons[key] = { x, y: y + this.oy, w: size, h: size, enabled: true };
    return img;
  }

  /**
   * Вкладки внизу экрана — как в любой игре на телефоне: большой палец
   * достаёт до них без перехвата. «Турниры» и «Профиль» открываются поверх
   * (это окна), «Бой» и «Топ» — разделы меню.
   * @returns {number} высота полосы
   */
  _tabs(active) {
    const W = this.W;
    // Логический пиксель на телефоне — около половины экранного, поэтому
    // подписи здесь 19–20: меньше уже не читается
    const h = this.portrait ? 116 : 96;
    const y0 = this.bottomY(h);
    this.items.push(this.add.rectangle(0, y0, W, h + 600, 0x0b1018, 0.94).setOrigin(0, 0));
    this.items.push(this.add.rectangle(0, y0, W, 2, 0xffffff, 0.09).setOrigin(0, 0));
    const tabs = [
      ['battle', 'Бой', 'battle', () => this.showRoot()],
      ['tasks', 'Задания', 'tasks', () => this.showTasks()],
      ['tournaments', 'Турниры', 'trophy', () => this.openTournaments()],
      ['top', 'Топ', 'podium', () => { this.topFrom = 'tab'; this.showTop(); }],
      ['account', 'Профиль', 'profile', () => this.openAccount()],
    ];
    const span = Math.min(W, 960);
    const cell = span / tabs.length;
    const x0 = (W - span) / 2;
    tabs.forEach(([key, label, icon, onTap], i) => {
      const x = x0 + cell * (i + 0.5);
      const on = key === active;
      const size = this.portrait ? 48 : 40;
      const glyph = this.add.image(x, y0 + h * 0.36, ensureIcon(this, icon, size))
        .setAlpha(on ? 1 : 0.6);
      if (on) glyph.setTint(0xffc247);
      const text = this.add.text(x, y0 + h * 0.76, label,
        font(this.portrait ? 18 : 18, 800, on ? UI.accent : UI.textDim)).setOrigin(0.5);
      // Есть что забрать — красная точка на «Заданиях»
      if (key === 'tasks' && !on && rewardWaiting()) {
        this.items.push(this.add.circle(x + size * 0.55, y0 + h * 0.36 - size * 0.45, 9, 0xff4d4d)
          .setStrokeStyle(3, 0x0b1018));
      }
      const zone = this.add.zone(x, y0 + h / 2, cell, h).setInteractive({ useHandCursor: true });
      zone.on('pointerdown', () => { glyph.setScale(0.9); haptic('tap'); });
      zone.on('pointerout', () => glyph.setScale(1));
      zone.on('pointerup', () => { glyph.setScale(1); onTap(); });
      this.items.push(glyph, text, zone);
      if (on) this.items.push(this.add.rectangle(x, y0 + 3, 54, 4, 0xffc247).setOrigin(0.5, 0));
      this.buttons[key] = { x, y: y0 + h / 2 + this.oy, w: cell, h, enabled: true };
    });
    return h;
  }

  /** Чем запускает большая кнопка: последний выбранный вариант «Башни». */
  get playChoice() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('worms.play.v1') ?? 'null'); } catch { saved = null; }
    // Пока игрок не выбрал бота сам и ни разу не победил — «Новичок»
    const level = saved && 'level' in saved ? saved.level : (onboardStage() === 'rookie' ? 'rookie' : 'fighter');
    return { level: level === null || BOT_LEVELS[level] ? level : 'fighter' };
  }

  set playChoice(v) {
    try { localStorage.setItem('worms.play.v1', JSON.stringify(v)); } catch { /* инкогнито */ }
  }

  /**
   * Главный экран. Одна большая кнопка — «Играть», остальное вокруг неё:
   * сверху кто ты и где в лиге, по центру твой боец, внизу вкладки. Всё
   * привязано к краям экрана, а не к блоку высотой 720: в вертикальном
   * телефоне раньше весь экран был пуст, а меню жалось в середину.
   */
  showRoot() {
    this.section = this.showRoot;
    this._clear();
    const W = this.W, cx = W / 2;
    const portrait = this.portrait;
    const me = player();
    const tabH = this._tabs('battle');
    const top = this.topY(0), bottom = this.bottomY(0);
    const pad = 28;

    // --- кто ты: имя, рейтинг, лига ---
    const name = this.add.text(pad, top + 18, me.name, font(28, 800)).setOrigin(0, 0);
    // Пять тапов по имени — диагностика экрана (index.html): что видит
    // страница на самом деле, когда с телефона приходит «не весь экран»
    name.setInteractive();
    name.on('pointerdown', () => {
      this.diagTaps = (this.diagTaps ?? 0) + 1;
      if (this.diagTaps % 5 === 0) {
        this.diagOn = !this.diagOn;
        globalThis.__diag?.(this.diagOn);
      }
    });
    this.items.push(name);
    this._iconButton('sound', W - pad - 30, top + 36, sfx.muted ? 'mute' : 'sound',
      () => { sfx.setMuted(!sfx.muted); this.showRoot(); }, 60);
    this.items.push(this.add.text(W - pad - 76, top + 18,
      `${me.rating}${me.rank ? ` · место ${me.rank}` : ''}`, font(28, 800, UI.accent)).setOrigin(1, 0));
    this._leagueBar(cx, top + 84, me.rating, Math.min(W - pad * 2, 760), 18);
    this._coinBadge(W - pad - 76, top + 156, true);

    // Редкое — мелкими плашками под лигой: иконка на экран Домой (пока
    // Telegram говорит, что её нет) и схема управления (вне Telegram)
    let pillX = pad;
    const pill = (key, label, w, onTap) => {
      this._button(key, pillX + w / 2, top + 156, label, '', onTap, { w, h: 48, titleSize: 19 });
      pillX += w + 10;
    };
    if (canOfferHomeScreen()) pill('home', '⌂ На экран Домой', 250, () => addToHomeScreen());
    const desktop = isDesktop();
    if (!desktop) {
      const sling = aimScheme() === 'sling';
      pill('aim-mode', sling ? 'Прицел: рогатка' : 'Прицел: кнопки', 230,
        () => { setAimScheme(sling ? 'buttons' : 'sling'); this.showRoot(); });
    }
    if (!inTelegram()) {
      pill('ui-mode', desktop ? 'Управление: ПК' : 'Управление: сенсор', 260,
        () => { setUiMode(desktop ? 'touch' : 'desktop'); this.showRoot(); });
    }

    // --- «Играть» ---
    const playH = portrait ? 128 : 104;
    const playY = bottom - tabH - (portrait ? 168 : 124);
    const choice = this.playChoice;
    // Самый первый раз «Играть» — это обучение: мишень, без ветра
    const tutorial = onboardStage() === 'tutorial';
    this._button('play', cx, playY, 'ИГРАТЬ',
      tutorial ? 'Первый бой · научим стрелять'
        : choice.level ? `Башня · бот «${BOT_LEVELS[choice.level].name}»` : 'Башня · вдвоём на одном телефоне',
      () => this.start(tutorial ? { ...challengeMatch('first'), tutorial: true } : towerMatch(choice.level)),
      { w: Math.min(W - 72, 560), h: playH, variant: 'primary', big: true });
    // Под «Играть»: другие режимы и вызов друга — бок о бок
    const subY = playY + playH / 2 + (portrait ? 48 : 36);
    const subW = Math.min(300, (Math.min(W - 72, 560) - 16) / 2);
    this._button('modes', cx - subW / 2 - 8, subY, 'другие режимы', '',
      () => this.showModes(), { w: subW, h: portrait ? 56 : 48, titleSize: 22 });
    this._button('challenge', cx + subW / 2 + 8, subY, 'вызвать друга', '',
      () => this.challengeFriend(), { w: subW, h: portrait ? 56 : 48, titleSize: 22 });

    // Партия оборвалась (Telegram перезапустился, погас экран), а мы
    // открылись без ссылки: предлагаем вернуться, пока соперник ждёт
    let areaBottom = playY - playH / 2 - 22;
    const pending = pendingSession();
    if (pending && Date.now() - pending.at < 15 * 60 * 1000) {
      const y = areaBottom - 30;
      this._button('resume', cx - 32, y, 'Вернуться в бой',
        `комната ${pending.room} · соперник ждёт`, () => this.startOnline(pending.room),
        { w: 360, h: 60, variant: 'active' });
      this._button('resume-no', cx + 184, y, '✕', '',
        () => { forgetSession(pending.room); this.showRoot(); }, { w: 56, h: 56 });
      areaBottom = y - 44;
    }

    // --- твой боец ---
    const areaTop = top + 196;
    const areaH = areaBottom - areaTop;
    // Первый вход за день — бонус серии, одним окном поверх экрана
    if (streakReady(dailyState(), dayKey()) && !this.streakShown) {
      this.streakShown = true;
      this.time.delayedCall(350, () => { if (this.section === this.showRoot) this._streakPopup(); });
    }

    const sheet = this.textures.exists(equippedSkin().sheet) ? equippedSkin().sheet : 'smiley';
    if (areaH > 110 && this.textures.exists(sheet)) {
      const k = Phaser.Math.Clamp(areaH / 175, 1, 2.8);
      const fy = areaTop + areaH * 0.6;
      this.items.push(this.add.ellipse(cx, fy + 6 * k, 130 * k, 20 * k, 0x000000, 0.28));
      const hero = this.add.sprite(cx, fy, sheet, 0).setOrigin(0.5, 0.92).setScale(k).setFlipX(true);
      hero.play(`${sheet}_idle`);
      // Тап по бойцу — к его скинам
      hero.setInteractive({ useHandCursor: true });
      hero.on('pointerdown', () => { haptic('tap'); this.showSkins(); });
      this.items.push(hero);
      this.buttons.hero = { x: cx, y: fy - 40 * k + this.oy, w: 100 * k, h: 90 * k, enabled: true };

      // Подпись под бойцом и коробка, если есть неоткрытая: она
      // подпрыгивает, чтобы её заметили
      const st = skinState();
      this.items.push(this.add.text(cx, fy + 22 * k, `скин: ${equippedSkin().name} · ${st.owned.length} из ${SKINS.length}`,
        font(18, 700, UI.textDim)).setOrigin(0.5, 0));
      if (st.boxes > 0 && this.textures.exists('shot_crate_weapon')) {
        const bx = cx + 78 * k, by = fy - 8 * k;
        const box = this.add.image(bx, by, 'shot_crate_weapon').setOrigin(0.5, 1)
          .setScale(fitScale(this, 'shot_crate_weapon', 46 * k));
        box.setInteractive({ useHandCursor: true });
        box.on('pointerdown', () => { haptic('tap'); this.showSkins(); });
        this.tweens.add({ targets: box, y: by - 10 * k, duration: 420, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        const badge = this.add.text(bx + 22 * k, by - 46 * k, `×${st.boxes}`, font(22, 800, '#1a1408'))
          .setOrigin(0.5).setPadding(8, 2, 8, 2).setBackgroundColor('#ffe27a');
        this.items.push(box, badge);
        this.buttons.box = { x: bx, y: by - 20 * k + this.oy, w: 50 * k, h: 46 * k, enabled: true };
      }
    }
  }

  // ------------------------------------------------------------- монеты

  /** Значок монеты, нарисованный один раз. */
  _coinTexture() {
    const key = 'menu-coin';
    if (!this.textures.exists(key)) {
      const tex = this.textures.createCanvas(key, 44, 44);
      const c = tex.getContext();
      c.fillStyle = '#b8860b'; c.beginPath(); c.arc(22, 23, 19, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#ffd23f'; c.beginPath(); c.arc(22, 21, 18, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#e0a800'; c.lineWidth = 3; c.beginPath(); c.arc(22, 21, 12, 0, Math.PI * 2); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.65)'; c.beginPath(); c.arc(15, 14, 4, 0, Math.PI * 2); c.fill();
      tex.refresh();
    }
    return key;
  }

  /** Монеты игрока: значок и число. right — прижать к правому краю по x. */
  _coinBadge(x, y, right = false) {
    const n = dailyState().coins;
    const t = this.add.text(x, y, `${n}`, font(28, 800, '#ffe27a')).setOrigin(right ? 1 : 0, 0.5);
    const icon = this.add.image(right ? x - t.width - 24 : x - 26, y, this._coinTexture()).setScale(0.9);
    this.items.push(icon, t);
    return { icon, text: t };
  }

  /**
   * Бонус серии дней: окно поверх главного экрана. Дни серии кружками,
   * сегодняшний подсвечен; на седьмом — коробка.
   */
  _streakPopup() {
    const W = this.W, H = this.H, cx = W / 2;
    const st = dailyState();
    const yesterday = st.streakDay && st.streakDay === prevDayOf(dayKey());
    const day = yesterday ? st.streak + 1 : 1;
    const coins = STREAK_COINS[Math.min(day, STREAK_COINS.length) - 1];
    const box = day % STREAK_BOX_DAY === 0;
    const cy = this.topY(H * 0.42);
    const layer = [];
    const add = (o) => { o.setDepth(50); layer.push(o); this.items.push(o); return o; };
    const shade = add(this.add.rectangle(0, this.topY(0), W, H, 0x05070c, 0.78).setOrigin(0, 0));
    shade.setInteractive();
    const pw = Math.min(W - 48, 640), ph = 420;
    ensureButton(this, `menu-streak-${pw}x${ph}`, pw, ph, 'normal');
    add(this.add.image(cx, cy, `menu-streak-${pw}x${ph}`));
    add(this.add.text(cx, cy - 160, `День ${day} подряд`, font(36, 800, UI.accent)).setOrigin(0.5));
    add(this.add.text(cx, cy - 116, 'заходи каждый день — награда растёт', font(18, 700, UI.textDim)).setOrigin(0.5));
    // Семь кружков недели
    const n = STREAK_BOX_DAY, step = Math.min(78, (pw - 60) / n);
    const inWeek = ((day - 1) % n) + 1;
    for (let i = 1; i <= n; i++) {
      const x = cx + (i - (n + 1) / 2) * step, y = cy - 40;
      const past = i < inWeek, now = i === inWeek;
      add(this.add.circle(x, y, now ? 30 : 24, now ? 0xffc247 : past ? 0x4f7a3a : 0x22293a)
        .setStrokeStyle(3, now ? 0xffffff : 0x0b1018));
      if (i === n && this.textures.exists('shot_crate_weapon')) {
        add(this.add.image(x, y, 'shot_crate_weapon').setScale(fitScale(this, 'shot_crate_weapon', now ? 40 : 32)));
      } else {
        add(this.add.text(x, y, past ? '✓' : `${STREAK_COINS[i - 1]}`, font(now ? 20 : 16, 800, now ? '#2a1c06' : UI.text)).setOrigin(0.5));
      }
    }
    add(this.add.image(cx - 70, cy + 52, this._coinTexture()).setScale(1.3));
    add(this.add.text(cx - 40, cy + 52, `+${coins}${box ? '  и коробка!' : ''}`, font(34, 800, '#ffe27a')).setOrigin(0, 0.5));
    const before = this.items.length;
    this._button('streak-claim', cx, cy + 140, 'Забрать', '', () => {
      const res = claimDailyStreak();
      // Серия выросла — серверу, чтобы вечернее напоминание знало число
      if (res) track('streak', { streak: res.streak });
      haptic('win');
      sfx.play('pickup');
      for (const o of layer) o.destroy();
      if (res) this._coinBurst(cx, cy);
      this.showRoot();
    }, { w: 300, h: 80, variant: 'primary', titleSize: 30 });
    for (const o of this.items.slice(before)) o.setDepth(51);
  }

  /** Россыпь монет — награда должна быть видна, а не только посчитана. */
  _coinBurst(x, y) {
    const em = this.add.particles(x, y, this._coinTexture(), {
      speed: { min: 180, max: 460 }, angle: { min: 200, max: 340 }, gravityY: 900,
      lifespan: { min: 700, max: 1100 }, scale: { start: 0.8, end: 0.5 }, rotate: { min: -180, max: 180 },
      emitting: false,
    }).setDepth(60);
    em.explode(18);
    this.time.delayedCall(1300, () => em.destroy());
  }

  // ------------------------------------------------------------ задания

  /**
   * Задания дня: три карточки с прогрессом, монеты за каждое. Выполненное
   * забирается кнопкой — с россыпью монет. Ниже — серия дней и коробка за
   * монеты.
   */
  showTasks() {
    this.section = this.showTasks;
    this._clear();
    const st = dailyState();
    this._title('Задания', 'обновляются каждый день в полночь');
    const W = this.W;
    this._coinBadge(W - 40, 72, true);
    // В вертикальном экране всё в один столбец; в горизонтальном задания
    // слева, серия, коробка и друг — справа: иначе не влезает по высоте
    const wide = !this.portrait;
    let cx = wide ? W * 0.32 : W / 2;
    const cw = Math.min(wide ? W * 0.56 : W - 48, 660), ch = wide ? 112 : 132;
    let y = wide ? 150 : 196;
    st.tasks.forEach((t) => {
      const def = TASK_BY_ID[t.id];
      const done = t.progress >= def.goal;
      const variant = t.claimed ? 'normal' : done ? 'active' : 'normal';
      const key = `menu-task-${cw}x${ch}-${variant}`;
      ensureButton(this, key, cw, ch, variant);
      this.items.push(this.add.image(cx, y + ch / 2, key).setAlpha(t.claimed ? 0.5 : 1));
      const left = cx - cw / 2 + 24;
      const ink = done && !t.claimed ? '#2a1c06' : UI.text;
      this.items.push(this.add.text(left, y + 20, def.text, font(25, 800, ink)).setOrigin(0, 0));
      // Полоса прогресса и число
      const bw = cw - 230, by = y + ch - 48;
      this.items.push(this.add.rectangle(left, by, bw, 16, 0x0b1220, 0.85).setOrigin(0, 0.5));
      const k = Math.min(1, t.progress / def.goal);
      if (k > 0) this.items.push(this.add.rectangle(left, by, Math.max(6, bw * k), 16, done ? 0x6ee36e : 0xffc247).setOrigin(0, 0.5));
      this.items.push(this.add.text(left + bw + 12, by, `${t.progress}/${def.goal}`, font(19, 800, ink)).setOrigin(0, 0.5));
      // Справа — награда или кнопка «Забрать»
      const rx = cx + cw / 2 - 80;
      if (done && !t.claimed) {
        const before = this.items.length;
        this._button(`task-${t.id}`, rx, y + ch / 2, `+${def.coins}`, 'забрать', () => {
          const got = claimDailyTask(t.id);
          if (got) { haptic('win'); sfx.play('pickup'); this._coinBurst(rx, y + ch / 2); }
          this.showTasks();
        }, { w: 140, h: 84, variant: 'primary', titleSize: 26, hintSize: 16 });
        for (const o of this.items.slice(before)) o.setDepth(2);
      } else {
        this.items.push(this.add.image(rx - 34, y + ch / 2, this._coinTexture()).setScale(0.8).setAlpha(t.claimed ? 0.5 : 1));
        this.items.push(this.add.text(rx - 12, y + ch / 2, t.claimed ? '✓' : `${def.coins}`,
          font(26, 800, t.claimed ? '#8ef0a0' : '#ffe27a')).setOrigin(0, 0.5));
      }
      y += ch + (wide ? 10 : 16);
    });

    // Серия дней
    if (wide) { cx = W * 0.79; y = 150; }
    y += 10;
    this.items.push(this.add.text(cx, y, st.streak > 0
      ? `Серия: ${st.streak} ${plural(st.streak, 'день', 'дня', 'дней')} подряд · на ${STREAK_BOX_DAY}-й день — коробка`
      : `Заходи каждый день: на ${STREAK_BOX_DAY}-й день подряд — коробка`,
      font(19, 700, UI.textDim)).setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(wide ? W * 0.36 : cw));

    // Коробка за монеты
    y += 76;
    const can = st.coins >= BOX_PRICE;
    this._button('buy-box', cx, y, `Коробка со скином · ${BOX_PRICE}`, can ? 'купить за монеты' : `не хватает ${BOX_PRICE - st.coins}`,
      () => this._buyBox(), { w: Math.min(cw, 460), h: 90, titleSize: 25, hintSize: 17, enabled: can });
    if (this.textures.exists('shot_crate_weapon')) {
      this.items.push(this.add.image(cx - Math.min(cw, 460) / 2 + 40, y, 'shot_crate_weapon')
        .setScale(fitScale(this, 'shot_crate_weapon', 52)).setAlpha(can ? 1 : 0.5));
    }

    // Позвать друга: новичку и тебе — по коробке
    const link = refLink();
    this._button('invite', cx, y + 106, 'Позвать друга', link ? 'вам обоим — по коробке со скином' : 'работает в Telegram',
      () => {
        trackStep('invite');
        if (!shareLink(link, 'Залетай в бой на башне! По этой ссылке нам обоим дадут коробку со скином 🎁')) {
          copyText(link);
        }
      }, { w: Math.min(cw, 460), h: 90, titleSize: 25, hintSize: 17, enabled: Boolean(link), variant: 'primary' });
    this._tabs('tasks');
  }

  /** Купить коробку и сразу перейти к скинам, где её можно открыть. */
  _buyBox() {
    const res = buyBox();
    if (res === 'ok') {
      haptic('win');
      sfx.play('pickup');
      this.showSkins();
      return;
    }
    haptic('warn');
    this.showTasks();
    const msg = res === 'full' ? 'все скины уже собраны' : 'не хватает монет';
    const t = this.add.text(this.W / 2, 150, msg, font(22, 800, '#ff9a9a')).setOrigin(0.5);
    this.items.push(t);
    this.tweens.add({ targets: t, alpha: 0, delay: 1400, duration: 400 });
  }

  // --------------------------------------------------------------- скины

  /**
   * Скины бойца: что надето, что собрано, что ещё закрыто, и коробки.
   * Закрытые показаны тёмным силуэтом — видно, что там кто-то есть, но не
   * кто именно: открытие коробки остаётся сюрпризом.
   */
  showSkins() {
    this.section = this.showSkins;
    this._clear();
    const st = skinState();
    this._title('Скины', `собрано ${st.owned.length} из ${SKINS.length}`);
    const W = this.W, cx = W / 2;

    // --- коробки ---
    const full = st.owned.length >= SKINS.length;
    const boxY = 186;
    if (this.textures.exists('shot_crate_weapon')) {
      this.items.push(this.add.image(cx - 190, boxY, 'shot_crate_weapon')
        .setScale(fitScale(this, 'shot_crate_weapon', 72)).setAlpha(st.boxes > 0 ? 1 : 0.4));
    }
    this.items.push(this.add.text(cx - 140, boxY - 24, `Коробок: ${st.boxes}`, font(24, 800)).setOrigin(0, 0));
    this.items.push(this.add.text(cx - 140, boxY + 8,
      full ? 'все скины собраны' : st.boxes > 0 ? 'внутри — случайный скин' : 'за кампанию, серию и монеты',
      font(17, 700, UI.textDim)).setOrigin(0, 0).setWordWrapWidth(220));
    if (st.boxes > 0 || full) {
      this._button('open-box', cx + 190, boxY, 'Открыть', '', () => this._openBox(),
        { w: 170, h: 64, variant: 'primary', enabled: st.boxes > 0 && !full, titleSize: 24 });
    } else {
      // Коробок нет — можно купить за монеты
      this._button('buy-box', cx + 190, boxY, `Купить · ${BOX_PRICE}`, '', () => this._buyBox(),
        { w: 190, h: 64, enabled: dailyState().coins >= BOX_PRICE, titleSize: 22 });
    }

    // Что ещё можно получить: скины, которых нет, минус неоткрытые коробки.
    // Коробку, в которой заведомо ничего не будет, не продаём
    const left = SKINS.length - st.owned.length - st.boxes;
    const can = inTelegram() && loggedIn();

    // --- сетка скинов ---
    const cols = this.portrait ? 4 : 8;
    const cw = Math.min(170, Math.floor((W - 40) / cols));
    const ch = cw + 34;
    const x0 = cx - (cols * cw) / 2 + cw / 2;
    const y0 = 270 + ch / 2;
    SKINS.forEach((skin, i) => {
      const x = x0 + (i % cols) * cw, y = y0 + Math.floor(i / cols) * (ch + 10);
      const owned = st.owned.includes(skin.id);
      const on = st.equipped === skin.id;
      const key = `menu-skin-${cw - 10}x${ch}-${on ? 'active' : 'normal'}`;
      ensureButton(this, key, cw - 10, ch, on ? 'active' : 'normal');
      const plate = this.add.image(x, y, key).setAlpha(owned ? 1 : 0.5);
      this.items.push(plate);
      const sheet = this.textures.exists(skin.sheet) ? skin.sheet : 'smiley';
      const face = this.add.sprite(x, y + cw * 0.22, sheet, 0).setOrigin(0.5, 0.92)
        .setScale((cw - 30) / 100).setFlipX(true);
      if (owned) face.play(`${sheet}_idle`);
      else face.setTintFill(0x10141f).setAlpha(0.85);
      this.items.push(face);
      // Закрытый скин можно купить сразу — тап по силуэту открывает счёт
      const buy = !owned && can;
      this.items.push(this.add.text(x, y + ch / 2 - 16,
        owned ? (on ? 'надет' : skin.name) : buy ? `${SKIN_STARS} ⭐` : '???',
        font(17, 800, on ? '#2a1c06' : owned ? UI.text : buy ? UI.accent : UI.textDim)).setOrigin(0.5));
      if (owned) {
        plate.setInteractive({ useHandCursor: true });
        plate.on('pointerup', () => { haptic('select'); equipSkin(skin.id); this.showSkins(); });
      } else if (buy) {
        plate.setInteractive({ useHandCursor: true });
        plate.on('pointerup', () => { haptic('select'); this._buy(`skin-${skin.id}`); });
      }
      this.buttons[`skin-${skin.id}`] = { x, y: y + this.oy, w: cw - 10, h: ch, enabled: owned || buy };
    });

    // --- магазин: коробки за звёзды ---
    const rows = Math.ceil(SKINS.length / cols);
    const sy = y0 + rows * (ch + 10) - ch / 2 + 26;
    this.items.push(this.add.text(cx, sy, 'Магазин', font(26, 800, UI.accent)).setOrigin(0.5, 0));
    trackStep('shop_open');
    const bw = Math.min(300, (W - 60) / 2);
    const shopRow = [['box1', 'Коробка', '25 ⭐', 1], ['box5', '5 коробок', '99 ⭐', 5]];
    shopRow.forEach(([id, label, price, n], i) => {
      this._button(`shop-${id}`, cx + (i ? 1 : -1) * (bw / 2 + 8), sy + 96, label, price,
        () => this._buy(id), { w: bw, h: 88, titleSize: 25, hintSize: 20, enabled: can && left >= n });
    });
    this.items.push(this.add.text(cx, sy + 152, !can
      ? 'покупки за звёзды работают в Telegram'
      : left <= 0 ? 'все скины уже твои или ждут в коробках'
        : `в коробке — скин, которого у тебя ещё нет; закрытый скин — тап, ${SKIN_STARS} ⭐`,
      font(17, 700, UI.textDim)).setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(W - 48));
    this._back();
  }

  /**
   * Покупка за звёзды: счёт выписывает сервер, оплату показывает Telegram.
   * После «оплачено» ждём, пока сервер запишет платёж (он узнаёт о нём от
   * бота чуть позже), и кладём покупку в профиль.
   */
  async _buy(item) {
    trackStep('buy_click');
    const toast = (msg, color = '#ff9a9a') => {
      const t = this.add.text(this.W / 2, 150, msg, font(22, 800, color)).setOrigin(0.5).setDepth(60);
      this.items.push(t);
      this.tweens.add({ targets: t, alpha: 0, delay: 1800, duration: 400 });
    };
    let link;
    try { link = await buyShopItem(item); } catch (e) { toast(e.message || 'не вышло'); return; }
    const status = await openInvoice(link);
    if (status !== 'paid') {
      if (status !== 'cancelled') toast('оплата не прошла');
      return;
    }
    haptic('win');
    const before = skinState().boxes;
    const skin = /^skin-(\w+)$/.exec(item)?.[1];
    for (let i = 0; i < 8; i++) {
      const shop = await fetchShop();
      const got = shop?.owned ? applyServerOwned(shop.owned) : null;
      if (got && (got.boxes || got.skins.length)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (this.section !== this.showSkins) return;
    if (skin && skinState().owned.includes(skin)) equipSkin(skin);
    this.showSkins();
    if (skin) {
      if (skinState().owned.includes(skin)) toast(`Готово! «${SKIN_BY_ID[skin]?.name}» уже на тебе`, '#8ef0a0');
      else toast('Оплата прошла — скин появится через минуту', '#ffd166');
    } else if (skinState().boxes > before) toast('Готово! Коробки уже здесь', '#8ef0a0');
    else toast('Оплата прошла — коробки появятся через минуту', '#ffd166');
  }

  /**
   * Открытие коробки: она трясётся, лопается, из неё выскакивает скин.
   * Что выпадет, решается сразу; анимация только показывает.
   */
  _openBox() {
    const res = openSkinBox();
    if (!res.skin) { this.showSkins(); return; }
    const skin = SKIN_BY_ID[res.skin];
    const W = this.W, H = this.H, cx = W / 2;
    const cy = this.topY(H * 0.42);
    const layer = [];
    const add = (o) => { o.setDepth(50); layer.push(o); this.items.push(o); return o; };

    // Затемнение ловит касания: под ним ничего нажать нельзя
    const shade = add(this.add.rectangle(0, this.topY(0), W, H, 0x05070c, 0.82).setOrigin(0, 0));
    shade.setInteractive();
    const box = add(this.add.image(cx, cy, 'shot_crate_weapon')
      .setScale(fitScale(this, 'shot_crate_weapon', 190)));
    haptic('tap');
    sfx.play('crateDrop');
    this.tweens.add({ targets: box, angle: { from: -9, to: 9 }, duration: 90, yoyo: true, repeat: 7 });
    this.tweens.add({ targets: box, scale: box.scale * 1.18, duration: 1300, ease: 'Quad.easeIn' });

    this.time.delayedCall(1350, () => {
      if (!box.active) return;
      box.destroy();
      haptic('win');
      sfx.play('pickup');
      sfx.play('explosion', { radius: 30 });
      // Вспышка, лучи и конфетти
      const flash = add(this.add.circle(cx, cy, 40, 0xffffff, 0.95));
      this.tweens.add({ targets: flash, radius: 420, alpha: 0, duration: 500, ease: 'Cubic.easeOut' });
      if (!this.textures.exists('fx-dot')) {
        const tex = this.textures.createCanvas('fx-dot', 12, 12);
        const c = tex.getContext();
        c.fillStyle = '#ffffff';
        c.beginPath(); c.arc(6, 6, 5.5, 0, Math.PI * 2); c.fill();
        tex.refresh();
      }
      const em = add(this.add.particles(cx, cy, 'fx-dot', {
        speed: { min: 160, max: 520 }, angle: { min: 0, max: 360 }, gravityY: 520,
        lifespan: { min: 900, max: 1700 }, scale: { start: 1.3, end: 0.4 },
        tint: [0xff5a5a, 0x5aa9ff, 0x6ee36e, 0xffd45a, 0xff8ad4, 0xffffff], emitting: false,
      }));
      em.explode(70);

      const sheet = this.textures.exists(skin.sheet) ? skin.sheet : 'smiley';
      const hero = add(this.add.sprite(cx, cy + 70, sheet, 0).setOrigin(0.5, 0.92).setScale(0.2).setFlipX(true));
      hero.play(`${sheet}_win`);
      this.tweens.add({ targets: hero, scale: 3, duration: 520, ease: 'Back.easeOut' });
      add(this.add.text(cx, cy - 200, 'Новый скин!', font(26, 800, UI.textDim)).setOrigin(0.5));
      const name = add(this.add.text(cx, cy + 120, skin.name, font(48, 800, UI.accent)).setOrigin(0.5).setScale(0.3));
      this.tweens.add({ targets: name, scale: 1, duration: 420, delay: 180, ease: 'Back.easeOut' });

      const btn = (key, dx, label, variant, onTap) => {
        const before = this.items.length;
        this._button(key, cx + dx, cy + 230, label, '', onTap, { w: 250, h: 78, variant, titleSize: 26 });
        for (const o of this.items.slice(before)) o.setDepth(51);
      };
      this.time.delayedCall(600, () => {
        if (this.section !== this.showSkins) return;
        btn('skin-wear', -140, 'Надеть', 'primary', () => { equipSkin(skin.id); this.showSkins(); });
        btn('skin-later', 140, 'Потом', 'normal', () => this.showSkins());
      });
    });
  }

  // -------------------------------------------------------------- режимы

  /** Всё, кроме «Играть»: выбор соперника на башне и прежние режимы. */
  showModes() {
    this.section = this.showModes;
    this._clear();
    this._title('Режимы');
    const cx = this.W / 2;
    const y0 = 176, step = this.portrait ? 104 : 84;
    const big = { w: Math.min(this.W - 64, 620), h: this.portrait ? 92 : 74, titleSize: 28, hintSize: 18 };
    const stars = totalStars(challengeStars());
    const done = ascentDone().size;
    this._button('ascent', cx, y0, 'Кампания «Подъём»', `15 боёв на башне, монстры и Великан · пройдено ${done} из ${ASCENT.length}`,
      () => this.showAscent(), { ...big, variant: 'primary' });
    this._button('tower', cx, y0 + step, 'Башня', 'высокая арена и трос · выбрать соперника',
      () => this.showTower(), big);
    this._button('challenges', cx, y0 + step * 2, 'Испытания', `задачи на три звезды · собрано ★ ${stars} из ${CHALLENGES.length * 3}`,
      () => this.showChallenges(), big);
    this._button('online', cx, y0 + step * 3, 'Онлайн', 'бой с человеком на башне · рейтинг',
      () => this.showOnline(), big);
    this._button('campaign', cx, y0 + step * 4, 'Классика', 'старые миссии на широких картах · горизонтально',
      () => this.showCampaign(), big);
    this._button('quick', cx, y0 + step * 5, 'Свои правила', 'обычная карта, бот или вдвоём · горизонтально',
      () => this.showQuick(), big);
    this._back();
  }

  // ------------------------------------------------------ кампания «Подъём»

  /** Три главы: прогресс в каждой; закрытая — пока не пройдена предыдущая. */
  showAscent() {
    this.section = this.showAscent;
    this._clear();
    const done = ascentDone();
    this._title('Подъём', `пройдено ${done.size} из ${ASCENT.length} · коробки со скинами по пути`);
    const cx = this.W / 2;
    const w = Math.min(this.W - 64, 620), h = this.portrait ? 120 : 96;
    const step = h + 18;
    CHAPTERS.forEach((ch, i) => {
      const list = ASCENT.filter((m) => m.chapter === ch.id);
      const first = ASCENT.indexOf(list[0]);
      const open = ascentOpen(first, done);
      const n = list.filter((m) => done.has(m.id)).length;
      this._button(`chapter-${ch.id}`, cx, 196 + h / 2 + i * step, `${i + 1}. ${ch.title}`,
        open ? `${n} из ${list.length}${n === list.length ? ' · пройдено' : ''}` : 'откроется после предыдущей главы',
        () => this.showAscentChapter(ch), {
          w, h, enabled: open, variant: open && n < list.length ? 'primary' : 'normal', titleSize: 30, hintSize: 20,
        });
    });
    this._back(() => this.showModes());
  }

  showAscentChapter(ch) {
    this.section = () => this.showAscentChapter(ch);
    this._clear();
    const done = ascentDone();
    const list = ASCENT.filter((m) => m.chapter === ch.id);
    this._title(ch.title, `${list.filter((m) => done.has(m.id)).length} из ${list.length}`);
    const cx = this.W / 2;
    const w = Math.min(this.W - 64, 620), h = this.portrait ? 96 : 76, gap = 12;
    list.forEach((m, k) => {
      const i = ASCENT.indexOf(m);
      const open = ascentOpen(i, done);
      const won = done.has(m.id);
      const tag = m.boss && !/Великан/.test(m.title) ? ' · Великан' : '';
      this._button(`up-${m.id}`, cx, 186 + h / 2 + k * (h + gap), `${i + 1}. ${m.title}${tag}`,
        won ? '✓ пройдено' : open ? 'открыто' : 'откроется после предыдущего боя',
        () => this.showAscentBrief(m), {
          w, h, enabled: open, variant: open && !won ? 'primary' : 'normal', titleSize: 26, hintSize: 17,
        });
    });
    this._back(() => this.showAscent());
  }

  showAscentBrief(m) {
    this.section = () => this.showAscentBrief(m);
    this._clear();
    this._title(m.title, ascentDone().has(m.id) ? 'пройдено' : '');
    const cx = this.W / 2;
    const w = Math.min(640, this.W - 56);
    const mons = m.monsters ?? {};
    const parts = [];
    if (m.boss) parts.push('Великан');
    if (mons.slime) parts.push(`слизней: ${mons.slime}`);
    if (mons.cactus) parts.push(`кактусов: ${mons.cactus}`);
    const sides = m.teams.length > 1
      ? `${m.teams[0].worms} против ${m.teams[1].worms}`
      : `${m.teams[0].worms} бойца против Великана`;
    const t = this.add.text(cx, 176, [m.brief, '', sides, parts.join(' · ')].join('\n'), font(this.fs(16), 700))
      .setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(w - 40).setLineSpacing(6);
    this.items.push(t);
    this._button('start', cx, 176 + t.height + 90, 'В бой', '', () => this.start(ascentMatch(m.id)),
      this.portrait ? { variant: 'primary', w: 360, h: 88, titleSize: 30 } : { variant: 'primary', w: 300, h: 66 });
    this._back(() => this.showAscentChapter(CHAPTERS.find((c) => c.id === m.chapter)));
  }

  // ----------------------------------------------------------- испытания

  /** Список испытаний: звёзды у каждого, закрытые — до звезды в предыдущем. */
  showChallenges() {
    this.section = this.showChallenges;
    this._clear();
    const best = challengeStars();
    this._title('Испытания', `★ ${totalStars(best)} из ${CHALLENGES.length * 3} · за новую звезду +${STAR_COINS} монет`);
    const W = this.W;
    const roomy = this.portrait;
    const cols = roomy ? 1 : 3;
    const w = roomy ? Math.min(W - 64, 620) : Math.min(440, (W - 80) / 3);
    const h = roomy ? 96 : 84, gap = roomy ? 12 : 12;
    const x0 = W / 2 - ((cols - 1) * (w + 16)) / 2;
    const y0 = 172 + h / 2;
    CHALLENGES.forEach((c, i) => {
      const open = challengeOpen(i, best);
      const n = best[c.id] ?? 0;
      const x = x0 + (i % cols) * (w + 16), y = y0 + Math.floor(i / cols) * (h + gap);
      const next = open && n === 0;
      this._button(`ch-${c.id}`, x, y, `${i + 1}. ${c.title}`,
        open ? `${'★'.repeat(n)}${'☆'.repeat(3 - n)}` : 'откроется после звезды в предыдущем',
        () => this.showChallengeBrief(c), {
          w, h, enabled: open, variant: next ? 'primary' : 'normal',
          titleSize: roomy ? 26 : 22, hintSize: open ? (roomy ? 26 : 22) : (roomy ? 16 : 14),
        });
    });
    this._back(() => this.showModes());
  }

  showChallengeBrief(c) {
    this.section = () => this.showChallengeBrief(c);
    this._clear();
    const n = challengeStars()[c.id] ?? 0;
    this._title(c.title, `лучший результат: ${n ? '★'.repeat(n) + '☆'.repeat(3 - n) : 'ещё не пройдено'}`);
    const W = this.W, cx = W / 2;
    const w = Math.min(640, W - 56);
    const lines = [
      c.brief,
      '',
      '★ — победить',
      `★★ — победить не дольше чем за ${c.stars.turns} своих ${c.stars.turns < 5 ? 'хода' : 'ходов'}`,
      '★★★ — и не потерять ни одного очка здоровья',
    ];
    const t = this.add.text(cx, 176, lines.join('\n'), font(this.fs(16), 700))
      .setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(w - 40).setLineSpacing(6);
    this.items.push(t);
    this._button('start', cx, 176 + t.height + 90, 'В бой', '', () => this.start(challengeMatch(c.id)),
      this.portrait ? { variant: 'primary', w: 360, h: 88, titleSize: 30 } : { variant: 'primary', w: 300, h: 66 });
    this._back(() => this.showChallenges());
  }

  // --------------------------------------------------------------- башня

  showTower() {
    this.section = this.showTower;
    this._clear();
    this._title('Башня', 'по два бойца · ход 25 с · три троса за ход');
    const cx = this.W / 2;
    const y0 = 196, step = 106;
    const big = { w: Math.min(this.W - 64, 620), h: 92, titleSize: 28, hintSize: 18 };
    // Выбор запоминается: большая кнопка «Играть» запускает его же
    const go = (level) => { this.playChoice = { level }; this.start(towerMatch(level)); };
    this._button('tower-fighter', cx, y0, 'Против бота: Боец', 'считает выстрел и пользуется тросом',
      () => go('fighter'), { ...big, variant: 'primary' });
    this._button('tower-rookie', cx, y0 + step, 'Против бота: Новичок', 'стоит на месте, целится грубо',
      () => go('rookie'), big);
    this._button('tower-sniper', cx, y0 + step * 2, 'Против бота: Снайпер', 'промахивается редко',
      () => go('sniper'), big);
    this._button('tower-hotseat', cx, y0 + step * 3, 'Вдвоём на одном телефоне', 'ходы по очереди',
      () => go(null), big);
    // С другом по сети: комната башни, ссылка-приглашение, без рейтинга
    this._button('tower-friend', cx, y0 + step * 4, 'С другом по ссылке', 'каждый со своего телефона · без рейтинга',
      () => this.showRoom(randomRoom(true, true)), big);
    this._back(() => this.showModes());
  }

  // ------------------------------------------------------- быстрая игра

  showQuick() {
    this.section = this.showQuick;
    this._clear();
    const o = this.quickOptions;
    this._title('Быстрая игра', `${o.worms} на ${o.worms} · ход ${o.turnTime} с`);
    const cx = this.W / 2;

    // Настройки партии: каждая кнопка перебирает свои варианты по кругу.
    // Выбор запоминается и действует и на игру вдвоём, и против бота.
    const shapes = ['random', ...SHAPES.filter((sh) => !sh.hidden).map((sh) => sh.id)];
    const shapeName = (id) => (id === 'random' ? 'любая' : SHAPES.find((sh) => sh.id === id)?.name ?? id);
    const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
    const roomy = this.roomy;
    const opt = (key, x, w, label, next) => this._button(key, x, roomy ? 180 : 168, label, '',
      () => { this.quickOptions = { ...this.quickOptions, ...next() }; this.showQuick(); },
      roomy ? { w, h: 58, titleSize: 20 } : { w, h: 44 });
    opt('opt-shape', cx - 140, 270, `Карта: ${shapeName(o.shape)}`,
      () => ({ shape: cycle(shapes, o.shape) }));
    opt('opt-worms', cx + 70, 140, `Бойцов: ${o.worms}`,
      () => ({ worms: cycle(QUICK_OPTIONS.worms, o.worms) }));
    opt('opt-time', cx + 215, 140, `Ход: ${o.turnTime} с`,
      () => ({ turnTime: cycle(QUICK_OPTIONS.turnTime, o.turnTime) }));

    const y0 = roomy ? 286 : 240, step = roomy ? 106 : 74;
    const row = roomy ? this.rowStyle : {};
    this._button('hotseat', cx, y0, 'Вдвоём на одном устройстве', 'ходы по очереди',
      () => this.start(quickMatch(null, o)), { ...row, variant: 'primary' });

    const levels = ['rookie', 'fighter', 'sniper'];
    const hints = {
      rookie: 'только базука, целится грубо',
      fighter: 'считает траекторию, бьёт уверенно',
      sniper: 'всё оружие, промахивается редко',
    };
    levels.forEach((id, i) => {
      this._button(id, cx, y0 + step * (i + 1), `Против бота: ${BOT_LEVELS[id].name}`,
        hints[id], () => this.start(quickMatch(id, o)), row);
    });
    this._back(() => this.showModes());
  }

  /** Настройки быстрой игры: запоминаются в браузере. */
  get quickOptions() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('worms.quick.v1') ?? 'null'); } catch { saved = null; }
    const pick = (list, v, d) => (list.includes(v) ? v : d);
    const shapes = ['random', ...SHAPES.filter((sh) => !sh.hidden).map((sh) => sh.id)];
    return {
      shape: pick(shapes, saved?.shape, 'random'),
      worms: pick(QUICK_OPTIONS.worms, saved?.worms, 2),
      turnTime: pick(QUICK_OPTIONS.turnTime, saved?.turnTime, 30),
    };
  }

  set quickOptions(v) {
    try { localStorage.setItem('worms.quick.v1', JSON.stringify(v)); } catch { /* инкогнито */ }
  }

  // ------------------------------------------------------------ кампания

  showCampaign() {
    this.section = this.showCampaign;
    this._clear();
    const done = loadProgress();
    this._title('Кампания', `пройдено ${done.size} из ${MISSIONS.length}`);

    // Восемь миссий в столбик не влезают по высоте — раскладываем в две
    // колонки. Ширина плашки при этом меньше обычной кнопки меню.
    // В вертикальном телефоне места по высоте хватает на один столбец
    // крупных строк — так и читать, и попадать пальцем проще
    const roomy = this.roomy;
    const w = roomy ? Math.min(this.W - 64, 620) : Math.min(400, (this.W - 60) / 2);
    const rows = roomy ? MISSIONS.length : Math.ceil(MISSIONS.length / 2);
    const step = roomy ? 94 : 70;
    const y0 = roomy ? 178 : 168;
    const colX = roomy ? [this.W / 2] : [this.W / 2 - w / 2 - 14, this.W / 2 + w / 2 + 14];

    const rewards = new Set(rewardMissions(MISSIONS.map((mm) => mm.id)));
    const claimed = new Set(skinState().claimed);
    MISSIONS.forEach((m, i) => {
      const open = isUnlocked(i, done);
      const mark = done.has(m.id) ? ' ✓' : '';
      // Красная плашка — только у той миссии, которую играть дальше:
      // тусклая красная у запертой читалась как «сломано», а не «закрыто».
      const next = open && !done.has(m.id);
      this._button(m.id, colX[Math.floor(i / rows)], y0 + step * (i % rows),
        `${i + 1}. ${m.title}${mark}`,
        open ? m.subtitle : 'откроется после предыдущей',
        () => this.showBrief(m),
        roomy
          ? { enabled: open, variant: next ? 'primary' : 'normal', w, h: 82, titleSize: 25, hintSize: 17 }
          : { enabled: open, variant: next ? 'primary' : 'normal', w, h: 60 });
      // Миссии с наградой помечены коробкой, пока она не получена
      if (rewards.has(m.id) && !claimed.has(m.id) && this.textures.exists('shot_crate_weapon')) {
        const size = roomy ? 44 : 32;
        this.items.push(this.add.image(colX[Math.floor(i / rows)] + w / 2 - size * 0.8,
          y0 + step * (i % rows), 'shot_crate_weapon')
          .setScale(fitScale(this, 'shot_crate_weapon', size)).setAlpha(open ? 1 : 0.5));
      }
    });
    this._back(() => this.showModes());
  }

  /** Вводная перед миссией: без неё условия видно только по факту. */
  showBrief(mission) {
    this.section = () => this.showBrief(mission);
    this._clear();
    this._title(mission.title, mission.subtitle);
    const cx = this.W / 2;

    // Строки переносятся по ширине плашки, высота считается по тексту:
    // на телефоне кегль крупнее, и длинная фраза в одну строку не влезает
    const w = Math.min(640, this.W - 56);
    const y = 168;
    let ty = y + 24;
    const lines = mission.brief.map((line) => {
      const t = this.add.text(cx, ty, line, font(this.fs(15), 700))
        .setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(w - 48);
      ty += t.height + 10;
      this.items.push(t);
      return t;
    });
    const h = ty - y + 14;
    ensureButton(this, `menu-panel-${w}x${Math.round(h)}`, w, Math.round(h), 'normal');
    const panel = this.add.image(cx, y + h / 2, `menu-panel-${w}x${Math.round(h)}`).setOrigin(0.5).setDepth(-1);
    this.items.push(panel);
    for (const t of lines) t.setDepth(1);
    this.items.push(this.add.text(cx, y + h + 14,
      `Задача: ${objectiveText(mission.objective)}`, font(this.fs(14), 800, UI.accent))
      .setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(w));

    this._button('start', cx, y + h + (this.roomy ? 110 : 74), 'В бой', '',
      () => this.start(campaignMatch(mission.id)),
      this.roomy ? { variant: 'primary', w: 360, h: 88, titleSize: 30 } : { variant: 'primary', w: 300, h: 62 });
    this._back(() => this.showCampaign());
  }

  // -------------------------------------------------------------- онлайн

  showOnline() {
    this.section = this.showOnline;
    this._clear();
    // Профиль с сервера (только в Telegram): рейтинг там главный. Придёт —
    // раздел перерисуется с настоящими числами
    syncMe().then((row) => { if (row && this.section === this.showOnline) this.showOnline(); });
    const me = player();
    this._title('Онлайн', leagueLabel(me.rating));
    const cx = this.W / 2;

    this._leagueBar(cx, 132, me.rating);

    // Профиль — Telegram-аккаунт; кабинет со статистикой по кнопке
    this._button('profile', cx, 186, `${me.name} · кабинет`, '', () => this.openAccount(), { w: 300, h: 44 });
    this.items.push(this.add.text(cx, 214,
      `побед ${me.wins} · поражений ${me.losses}`, font(this.fs(12), 700, UI.textDim))
      .setOrigin(0.5, 0));

    // Режим: на рейтинг или без. У каждого свои столы и своя очередь
    // поиска; выбор запоминается.
    const casual = this.onlineQueue === 'casual';
    const tab = (key, label, queue) => this._button(key, cx + (queue === 'casual' ? 106 : -106), 262,
      label, '', () => { this.onlineQueue = queue; this.showOnline(); },
      { w: 208, h: 40, variant: this.onlineQueue === queue ? 'active' : 'normal' });
    tab('mode-rated', 'Рейтинг', 'rated');
    tab('mode-casual', 'Без рейтинга', 'casual');

    const y0 = 322, step = 74;
    this._button('create', cx, y0, 'Создать игру',
      casual ? 'без рейтинга · стол увидят все в лобби' : 'на рейтинг · стол увидят все в лобби',
      () => this.createGame(), { variant: 'primary' });
    this._button('quickmatch', cx, y0 + step, 'Быстрый бой', this._searchHint(),
      () => this.startSearch());
    // Код от друга — редкий путь, кнопка маленькая и внизу
    this._button('join', this.W - 108, this.bottomY(46), 'по коду', '',
      () => this.askCode(), { w: 180, h: 50 });
    this._button('top', this.W - 300, this.bottomY(46), '🏆 Топ', '',
      () => { this.topFrom = 'online'; this.showTop(); }, { w: 170, h: 50 });

    this._back();
    this._ensureLobby();
    this._showTables(this.lobby?.tables() ?? []);
  }

  /**
   * Таблица лидеров с сервера. Видна всем, попасть в неё — сыграть бой по
   * сети с аккаунтом против соперника с аккаунтом.
   */
  showTop(kind = this.topKind ?? 'rating') {
    this.section = this.showTop;
    this.topKind = kind;
    this._clear();
    this._title('Топ игроков', kind === 'tourney' ? 'по победам в турнирах' : 'рейтинг по подтверждённым боям');
    const cx = this.W / 2;
    const tab = (key, label, k) => this._button(key, cx + (k === 'tourney' ? 106 : -106), 160, label, '',
      () => this.showTop(k), { w: 208, h: 40, variant: kind === k ? 'active' : 'normal' });
    tab('top-rating', 'Рейтинг', 'rating');
    tab('top-tourney', 'Турниры', 'tourney');
    const note = this.add.text(cx, 204, 'загружаю…', font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0);
    this.items.push(note);
    // Пришли со вкладки — внизу вкладки; из лобби — кнопка «назад» в лобби
    if (this.topFrom === 'tab') this._tabs('top');
    else this._back(() => this.showOnline());

    fetchTop(20, kind).then((rows) => {
      if (this.section !== this.showTop || this.topKind !== kind) return;
      this.topRows = rows;
      note.destroy();
      this._renderTop(rows, kind);
    }).catch((e) => {
      if (this.section !== this.showTop) return;
      note.setText(`сервер недоступен: ${e.message}`);
    });
  }

  _renderTop(rows, kind = 'rating') {
    const cx = this.W / 2;
    const me = player();
    const x0 = cx - 300, top = 200, step = 32;
    const maxRows = Math.max(3, Math.floor((this.bottomY(70) - top) / step));
    if (!rows.length) {
      this.items.push(this.add.text(cx, top, kind === 'tourney'
        ? 'пока ни одного чемпиона — турниры впереди' : 'пока пусто — сыграй первый бой по сети на рейтинг',
      font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0));
      return;
    }
    rows.slice(0, maxRows).forEach((r, i) => {
      const y = top + i * step;
      const mine = r.id === me.id;
      const color = mine ? UI.accent : UI.text;
      this.items.push(this.add.text(x0, y, `${i + 1}.`, font(this.fs(15), 800, UI.textDim)).setOrigin(0, 0));
      this.items.push(this.add.text(x0 + 40, y, r.name, font(this.fs(15), 800, color)).setOrigin(0, 0));
      this.items.push(this.add.text(x0 + 330, y, leagueLabel(r.rating),
        font(this.fs(13), 700, leagueOf(r.rating).text)).setOrigin(0, 0));
      this.items.push(this.add.text(x0 + 600, y, kind === 'tourney' ? `🏆 ${r.tourney_wins}` : `${r.wins}–${r.losses}`,
        font(this.fs(13), 700, kind === 'tourney' ? UI.accent : UI.textDim)).setOrigin(1, 0));
    });
    const rank = myRank(rows);
    const foot = rank ? `ты на ${rank} месте` : !loggedIn() ? 'открой игру в Telegram, чтобы попасть в таблицу'
      : kind === 'tourney' ? 'выиграй турнир — и ты здесь' : 'тебя пока нет в таблице — доиграй бой по сети';
    this.items.push(this.add.text(cx, this.bottomY(74), foot, font(this.fs(12), 700, UI.textDim)).setOrigin(0.5, 1));
  }

  /** Личный кабинет. */
  openAccount() {
    openAccountDialog({
      onTop: () => { this.topFrom = 'tab'; this.showTop(); },
      onTours: () => this.openTournaments(),
    });
  }

  /**
   * Турниры. Из экрана матча — в бой; по возвращении из боя меню снова
   * откроет этот турнир (registry 'returnTour'), чтобы видеть сетку.
   */
  openTournaments(tour = null) {
    openTournaments({
      tour,
      onPlay: (room, tid) => {
        this.registry.set('returnTour', tid);
        this.startOnline(room);
      },
    });
  }

  /** Режим онлайна: rated | casual. Запоминается в браузере. */
  get onlineQueue() {
    if (!this._queue) {
      try { this._queue = localStorage.getItem('worms.online.queue'); } catch { this._queue = null; }
      if (this._queue !== 'casual') this._queue = 'rated';
    }
    return this._queue;
  }

  set onlineQueue(q) {
    this._queue = q === 'casual' ? 'casual' : 'rated';
    try { localStorage.setItem('worms.online.queue', this._queue); } catch { /* инкогнито */ }
  }

  /** Подсказка под «Быстрым боем»: как подбираем и сколько человек ищут. */
  _searchHint() {
    const casual = this.onlineQueue === 'casual';
    const how = casual ? 'любой соперник, сразу' : 'соперник по рейтингу';
    const n = this.lobby?.searchingCount(this.onlineQueue);
    return n == null ? how : `${how} · сейчас ищут ${n}`;
  }

  /** Своя открытая игра: комната случайная, стол виден в лобби. */
  createGame() {
    this.showRoom(randomRoom(this.onlineQueue === 'casual'));
  }

  /**
   * Лобби живёт, пока открыто меню: подключаемся один раз и держим —
   * иначе список игроков собирался бы заново на каждом переходе.
   */
  async _ensureLobby() {
    if (this.lobby || this.lobbyStarting) return;
    this.lobbyStarting = true;
    try {
      this.lobby = new Lobby(await makeTransport());
      this.lobby.onChange = () => this._showTables(this.lobby.tables());
      this.lobby.onMatch = (room, opponent) => {
        this.lobbyNote = opponent ? `соперник: ${opponent.name}` : '';
        this.startOnline(room);
      };
      // Игровая сцена по нему узнаёт, что лобби есть, и отмечает «в бою»
      this.registry.set('lobby', this.lobby);
      await this.lobby.start();
      // Стол открыли или поиск начали раньше, чем лобби поднялось
      if (this.hosting) this.lobby.host(this.hosting);
      else if (this.section === this.startSearch) this.lobby.search(true, this.searchQueue);
    } catch (e) {
      console.warn('[лобби] не поднялось', e);
      this.lobbyNote = 'сеть недоступна — играть можно по коду комнаты';
      if (this.section === this.showOnline) this.showOnline();
    } finally {
      this.lobbyStarting = false;
    }
  }

  /**
   * Открытые игры, как столы в «Дураке»: хозяин, лига, кнопка «Войти».
   * Список под кнопками в обеих ориентациях; в ландшафте влезает три-четыре
   * строки, в портрете — все.
   */
  _showTables(tables) {
    if (this.section !== this.showOnline) return;
    for (const o of this.playerRows ?? []) o.destroy();
    this.playerRows = [];
    const rows = this.playerRows;

    const cx = this.W / 2;
    const x = cx - 210;
    const top = 446;
    const online = (this.lobby?.list().length ?? 0) + 1;
    const casual = this.onlineQueue === 'casual';
    tables = this.lobby ? this.lobby.tables(this.onlineQueue) : tables;
    // Счётчик ищущих живёт в подсказке «Быстрого боя» и обновляется с лобби
    const hint = this.buttonTexts?.quickmatch?.sub;
    if (hint?.active) hint.setText(this._searchHint());
    const head = this.add.text(x, top,
      `Открытые игры${casual ? ' без рейтинга' : ' на рейтинг'} · в сети ${online}`,
      font(this.fs(13), 800, UI.accent)).setOrigin(0, 0);
    rows.push(head);

    if (!tables.length) {
      rows.push(this.add.text(x, top + 28, this.lobbyNote || 'пока никто не создал игру — создай свою',
        font(this.fs(12), 700, UI.textDim)).setOrigin(0, 0));
    }

    const step = 40;
    const maxRows = Math.max(1, Math.floor((this.bottomY(70) - (top + 28)) / step));
    tables.slice(0, maxRows).forEach((t, i) => {
      const y = top + 28 + i * step;
      rows.push(this.add.text(x, y, t.name, font(this.fs(14), 800, UI.text)).setOrigin(0, 0));
      rows.push(this.add.text(x, y + 17, leagueLabel(t.rating),
        font(this.fs(11), 700, leagueOf(t.rating).text)).setOrigin(0, 0));
      this._button(`join-${t.id}`, cx + 160, y + 15, 'Войти', '',
        () => this.joinTable(t.id), { w: 100, h: 34, into: rows });
    });
    // Строки живут отдельно от items: список обновляется чаще, чем раздел
    for (const o of rows) this.items.push(o);
  }

  /** Войти в чужую открытую игру: лобби само отправит в комнату. */
  joinTable(peerId) {
    return this.lobby?.join(peerId) ?? null;
  }

  /** Поиск боя: ждём, пока лобби сведёт нас с кем-нибудь. */
  startSearch() {
    this.section = this.startSearch;
    this._clear();
    const me = player();
    const queue = this.onlineQueue;
    const casual = queue === 'casual';
    this._title('Ищем соперника…', casual ? 'бой без рейтинга' : leagueLabel(me.rating));
    const cx = this.W / 2;

    // Подбор на рейтинг начинает с равных и постепенно расширяет круг.
    // Без этой строки экран выглядит зависшим: непонятно, ищет он ещё
    // впритык или уже согласен на любого.
    // Сколько человек ищут прямо сейчас — вместе с тобой. Главная строка
    // экрана: по ней видно, есть ли вообще с кем играть.
    this.searchCount = this.add.text(cx, 168, 'подключаемся к лобби…', font(24, 800, UI.text)).setOrigin(0.5, 0);
    this.items.push(this.searchCount);
    this.searchStatus = this.add.text(cx, 214, 'Ищем соперника…',
      font(this.fs(16), 800, UI.accent)).setOrigin(0.5, 0);
    this.items.push(this.searchStatus);
    this.items.push(this.add.text(cx, 244, casual
      ? 'Подойдёт любой, кто тоже ищет бой без рейтинга.'
      : 'Круг поиска расширяется каждые пять секунд ожидания.',
      font(this.fs(13), 700, UI.textDim)).setOrigin(0.5, 0));
    // Пока людей мало, ждать можно долго. Через FALLBACK_AFTER секунд — бой
    // с ботом, честно подписанный и без рейтинга; можно и не ждать
    this.searchStarted = performance.now();
    this.fallbackText = this.add.text(cx, 284, '', font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0);
    this.items.push(this.fallbackText);

    this._button('cancel', cx, 360, 'Отменить поиск', '', () => {
      this.lobby?.search(false);
      this._stopSearchTicker();
      this.showOnline();
    }, { w: 300, h: 56 });
    this._button('bot-now', cx, 432, 'Сразу с ботом', 'без рейтинга', () => this._fallbackToBot(),
      { w: 300, h: 60 });

    this._ensureLobby();
    this.searchQueue = queue;
    this.lobby?.search(true, queue);
    this._startSearchTicker();
  }

  /** Строка статуса живёт своим таймером: лобби бьётся реже, чем хочется глазу. */
  _startSearchTicker() {
    this._stopSearchTicker();
    const tick = () => {
      if (this.section !== this.startSearch || !this.searchStatus?.active) {
        this._stopSearchTicker();
        return;
      }
      // Лобби могло подняться уже после нажатия «искать»
      if (this.lobby && this.lobby.state !== 'searching' && !this.lobby.matched) {
        this.lobby.search(true, this.searchQueue);
      }
      const text = this.lobby?.statusText();
      if (text) this.searchStatus.setText(text);
      const left = Math.ceil(FALLBACK_AFTER - (performance.now() - this.searchStarted) / 1000);
      if (left <= 0 && !this.lobby?.matched) { this._fallbackToBot(); return; }
      this.fallbackText?.setText(`никого не найдём за ${left} с — сыграешь с ботом`);
      const n = this.lobby?.searchingCount(this.searchQueue);
      if (n != null) this.searchCount?.setText(`Сейчас ищут: ${n}${n === 1 ? ' — только ты' : ''}`);
    };
    this.searchTicker = this.time.addEvent({ delay: 400, loop: true, callback: tick });
    tick();
    this.events.once('shutdown', () => this._stopSearchTicker());
  }

  /** Соперник не нашёлся (или ждать не хочется): бой с ботом на башне. */
  _fallbackToBot() {
    if (this.lobby?.matched) return;
    this.lobby?.search(false);
    this._stopSearchTicker();
    this.start(fallbackMatch());
  }

  _stopSearchTicker() {
    this.searchTicker?.remove();
    this.searchTicker = null;
  }

  askCode() {
    askText({
      title: 'Войти по коду', label: 'Код комнаты', placeholder: 'например, K7QX2M',
      maxLength: 10, upper: true, okText: 'Войти',
      note: 'Код показывает тот, кто создал игру. Ссылка-приглашение работает и без него.',
      validate: (v) => (/^[A-Z0-9]{4,10}$/.test(v) ? null : 'код — от 4 до 10 букв и цифр'),
    }).then((code) => { if (code) this.startOnline(code); });
  }

  /**
   * Игра создана: стол виден в лобби, код и ссылка — для друга. Хозяин
   * ждёт здесь; как только кто-то войдёт (из лобби или по ссылке), лобби
   * отправит обоих в комнату.
   */
  showRoom(room) {
    this.section = () => this.showRoom(room);
    this._clear();
    this._title('Игра создана', isTowerRoom(room)
      ? 'башня · без рейтинга'
      : isCasualRoom(room)
        ? 'без рейтинга · стол виден всем в лобби'
        : 'на рейтинг · стол виден всем в лобби');
    const cx = this.W / 2;

    this.hosting = room;
    this._ensureLobby();
    this.lobby?.host(room);

    const code = this.add.text(cx, 176, room, font(72, 800, UI.accent)).setOrigin(0.5, 0);
    this.items.push(code);
    this.items.push(this.add.text(cx, 268, 'код для друга', font(this.fs(12), 700, UI.textDim)).setOrigin(0.5, 0));

    const link = this.inviteLink(room);
    // В Telegram зовём родным выбором чата: в башню — карточкой «вызов на
    // бой» с кнопкой (Telegram 8.0+), иначе ссылкой; снаружи — буфером обмена
    this._button('copy', cx, 330, isTowerRoom(room) ? 'Вызвать друга' : 'Позвать друга', '',
      async () => {
        trackStep('invite');
        if (isTowerRoom(room) && inTelegram()) {
          const id = await prepareChallenge(room, link);
          if (shareMessage(id)) return;
        }
        if (shareRoom(room, link)) return;
        copyText(link);
        // Подтверждение одно на все нажатия: иначе оно множится стопкой
        if (this.copiedLabel) return;
        this.copiedLabel = this.add.text(cx, 372, 'ссылка скопирована', font(this.fs(13), 700, '#8ef0a0'))
          .setOrigin(0.5, 0);
        this.items.push(this.copiedLabel);
      }, { w: 340, h: 58, variant: 'primary' });
    this.items.push(this.add.text(cx, 404, 'ждём соперника…', font(this.fs(15), 800, UI.accent)).setOrigin(0.5, 0));
    // Запасной путь, если лобби не поднялось: ждать внутри комнаты
    this._button('enter', cx, 462, 'Войти в комнату самому', 'ждать соперника внутри',
      () => this.startOnline(room), { w: 340, h: 56 });

    const leave = () => { this.hosting = null; this.lobby?.unhost(); this.showOnline(); };
    this._button('cancel', this.W - 108, this.bottomY(46), 'Отменить', '', leave, { w: 180, h: 50 });
    this._back(leave);
  }

  inviteLink(room) {
    return tgInviteLink(room);
  }

  /** Вызов с главного экрана: комната башни и сразу выбор чата для карточки. */
  challengeFriend() {
    const room = randomRoom(true, true);
    this.showRoom(room);
    if (inTelegram()) this.time.delayedCall(250, () => this.buttonHandlers?.copy?.());
  }

  // ---------------------------------------------------------------- старт

  /**
   * Онлайн отличается тем, что комната живёт в адресе: так работает ссылка
   * -приглашение и так же партия переживает перезагрузку страницы.
   */
  startOnline(room) {
    this.hosting = null;
    this.lobby?.busy();
    const url = new URL(location.href);
    url.searchParams.set('room', room);
    history.replaceState(null, '', url);
    this.start(onlineMatch(room));
  }

  start(match) {
    this.registry.set('match', match);
    this.registry.set('seed', match.seed ?? null);
    this.registry.set('forceBiome', match.biome ?? null);
    this.scene.start('Game');
  }
}
