import { UI, font, ensureButton, ensureIcon } from '../ui/theme.js';
import { CFG } from '../config.js';
import { MISSIONS, loadProgress, isUnlocked } from '../campaign/missions.js';
import { objectiveText } from '../campaign/objectives.js';
import {
  quickMatch, campaignMatch, onlineMatch, towerMatch, fallbackMatch, challengeMatch, ascentMatch, dailyMatch, QUICK_OPTIONS,
} from '../core/match.js';
import { CHALLENGES, challengeOpen, totalStars, STAR_COINS } from '../campaign/challenges.js';
import { ASCENT, CHAPTERS, ascentOpen, bossName, chapterOf } from '../campaign/ascent.js';
import { AFFIXES, DEFAULT_AFFIXES } from '../entities/Affixes.js';
import { ascentDone } from '../platform/ascent.js';
import { challengeStars } from '../platform/challenges.js';
import { onboardStage, isNewbie } from '../platform/onboard.js';
import { SHAPES } from '../core/shapes.js';
import { randomRoom, copyText } from '../net/transport.js';
import { isCasualRoom, isTowerRoom } from '../net/rooms.js';
import { Lobby } from '../net/lobby.js';
import { pendingSession, forgetSession } from '../net/session.js';
import {
  syncMe, fetchTop, myRank, loggedIn, onAccountChange, track,
  trackStep, prepareChallenge, fetchDailyTower, redeemPromo, fetchFriends, inviteFriend,
} from '../net/server.js';
import { openAccountDialog } from '../ui/AccountDialog.js';
import { openTournaments } from '../ui/Tournaments.js';
import { askText, closeOverlay } from '../ui/Overlay.js';
import { makeTransport } from '../net/connect.js';
import { player } from '../platform/player.js';
import {
  inviteLink as tgInviteLink, shareRoom, shareMessage, canOfferHomeScreen, addToHomeScreen, onHomeScreenChange,
  haptic, inTelegram, botLink, refLink, shareLink,
} from '../platform/telegram.js';
import { leagueOf, nextLeague, leagueProgress, toNextLeague, leagueLabel } from '../platform/league.js';
import { BOT_LEVELS } from '../ai/Bot.js';
import { isDesktop, setUiMode, aimScheme, setAimScheme } from '../platform/device.js';
import { sfx } from '../audio/Sfx.js';
import { music } from '../audio/Music.js';
import { SKINS, SKIN_BY_ID, BOX_SKINS, RARITY, RARITY_ORDER, skinPrice, rewardMissions } from '../core/skins.js';
import {
  skinState, equippedSkin, equipSkin, openSkinBox, syncCampaignBoxes, buySkin, applyServerOwned,
} from '../platform/skins.js';
import {
  TASK_BY_ID, BOX_PRICE, STREAK_COINS, STREAK_BOX_DAY, streakReady, dayKey, claimStreak,
  FREEZE_PRICE, FREEZE_MAX,
} from '../core/daily.js';
import {
  dailyState, rewardWaiting, claimDailyTask, claimDailyStreak, buyBox, buyStreakFreeze,
} from '../platform/daily.js';
import { COSMETICS, KINDS, KIND_NAMES } from '../core/cosmetics.js';
import { cosState, buyCosmetic, equipCosmetic } from '../platform/cosmetics.js';
import { fitScale } from '../core/assets.js';
import { LANG, setLang } from '../i18n/index.js';

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

/** Когда друг был в игре: «сегодня», «вчера», «3 дн. назад», «давно». */
function seenText(at) {
  if (!at) return '';
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (at >= midnight.getTime()) return 'в игре сегодня';
  const days = Math.ceil((midnight.getTime() - at) / 86400_000);
  if (days <= 1) return 'в игре вчера';
  return days > 30 ? 'в игре давно' : `в игре ${days} дн. назад`;
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
    // Своя тема у меню: из боя переходим в неё плавно, без обрыва
    music.play('menu');
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
    this._initScroll();
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
    if (this.registry.get('returnTo') === 'daily') {
      this.registry.set('returnTo', null);
      this.time.delayedCall(30, () => this.showDailyTower());
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
    } else if (params.get('top') === 'friends' && !this.registry.get('topLinkUsed')) {
      // Кнопка из сообщения бота «друг тебя обогнал» — сразу к топу друзей
      this.registry.set('topLinkUsed', true);
      this.time.delayedCall(300, () => { this.topFrom = 'tab'; this.showTop('rating', 'friends'); });
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
    this.scrollY = 0;
    this.uiCam.scrollY = -this.oy;
  }

  /**
   * Прокрутка раздела пальцем и колёсиком — там, где он длиннее экрана
   * (скины на телефоне). Раздел сам говорит, докуда он доходит
   * (_scrollable); «назад» прибита к экрану и не уезжает.
   * Протянул — это прокрутка, а не нажатие: кнопка под пальцем не сработает.
   */
  _initScroll() {
    this.scrollMax = 0;
    this.scrollY = 0;
    let start = null;
    this.input.on('pointerdown', (p) => {
      this._dragging = false;
      start = this.scrollMax > 0 ? { y: p.y, s: this.scrollY } : null;
    });
    this.input.on('pointermove', (p) => {
      if (!start || !p.isDown) return;
      const dy = p.y - start.y;
      if (!this._dragging && Math.abs(dy) < 10) return;
      this._dragging = true;
      this._setScroll(start.s - dy);
    });
    this.input.on('pointerup', () => { start = null; });
    this.input.on('wheel', (p, objs, dx, dy) => { if (this.scrollMax > 0) this._setScroll(this.scrollY + dy); });
  }

  _setScroll(v) {
    this.scrollY = Math.max(0, Math.min(this.scrollMax, v));
    this.uiCam.scrollY = -this.oy + this.scrollY;
  }

  /** Раздел доходит до y (в своих координатах): если ниже экрана — можно крутить. */
  _scrollable(bottom) {
    this.scrollMax = Math.max(0, Math.round(bottom - this.bottomY(96)));
    this._setScroll(this.scrollY);
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
    // Новый раздел — снова сверху и без прокрутки, пока он сам не попросит
    this.scrollMax = 0;
    this._setScroll?.(0);
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
      img.on('pointerup', () => { release(); if (!this._dragging) onTap(); });
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
    const n = this.items.length;
    this._button('back', 108, this.bottomY(52), '← назад', '', onTap, { w: 180, h: 60, titleSize: 22 });
    // Не прокручивается вместе с разделом: без прокрутки камеры (oy) — на
    // своё экранное место, и поверх содержимого
    for (const o of this.items.slice(n)) o.setScrollFactor(0).setY(o.y + this.oy).setDepth(50);
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
  // С учётом прокрутки: окно поверх раздела встаёт по экрану, а не по разделу
  topY(d) { return d - this.oy + (this.scrollY ?? 0); }

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
    const n = this.items.length;
    // Логический пиксель на телефоне — около половины экранного, поэтому
    // подписи здесь 19–20: меньше уже не читается
    const h = this.portrait ? 116 : 96;
    const y0 = this.bottomY(h);
    this.items.push(this.add.rectangle(0, y0, W, h + 600, 0x0b1018, 0.94).setOrigin(0, 0));
    this.items.push(this.add.rectangle(0, y0, W, 2, 0xffffff, 0.09).setOrigin(0, 0));
    const tabs = [
      ['battle', 'Бой', 'battle', () => this.showRoot()],
      ['tasks', 'Задания', 'tasks', () => this.showTasks()],
      ['shop', 'Магазин', 'shop', () => this.showShop()],
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
        font(this.portrait && W < 640 ? 16 : 18, 800, on ? UI.accent : UI.textDim)).setOrigin(0.5);
      // Есть что забрать — красная точка на «Заданиях»
      // Красные точки — после первой победы: до неё новичку нужна одна «Играть»
      if (!on && !isNewbie() && ((key === 'tasks' && rewardWaiting()) || (key === 'shop' && skinState().boxes > 0))) {
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
    // Как «назад»: не уезжают, когда раздел прокручивается (топ друзей)
    for (const o of this.items.slice(n)) o.setScrollFactor(0).setY(o.y + this.oy).setDepth(50);
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
    this.fromShop = false;
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
    // Музыка — отдельно от звука: эффекты оставить, мелодию выключить.
    // Общий «звук выкл» глушит и её, но переключатель помнит своё
    this._iconButton('music', W - pad - 96, top + 36, music.enabled ? 'music' : 'music-off',
      () => { music.toggle(); this.showRoot(); }, 60);
    this.items.push(this.add.text(W - pad - 142, top + 18,
      `${me.rating}${me.rank ? ` · место ${me.rank}` : ''}`, font(28, 800, UI.accent)).setOrigin(1, 0));
    this._leagueBar(cx, top + 84, me.rating, Math.min(W - pad * 2, 760), 18);
    // Монеты — вход в магазин: плашка с «+», как в любой игре. На узком
    // экране ряд плашек слева её бы накрыл — тогда она строкой ниже
    const coinY = W < 900 ? top + 222 : top + 156;
    this._coinShopLink(W - pad, coinY);

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
    // Язык: по умолчанию — из Telegram, здесь можно сменить
    pill('lang', LANG === 'en' ? 'RU' : 'EN', 74, () => setLang(LANG === 'en' ? 'ru' : 'en'));
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
    const areaTop = coinY + 40;
    const areaH = areaBottom - areaTop;
    // Первый вход за день — бонус серии, одним окном поверх экрана
    // Новичку — никаких окон до первого боя: сначала «Играть», бонус подождёт
    if (onboardStage() !== 'tutorial' && streakReady(dailyState(), dayKey()) && !this.streakShown) {
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
    // Прибавилось с прошлого раза (бой, задание, подарок) — досчитываем вверх
    // с россыпью монет: награда видна, а не просто другое число
    const prev = this.registry.get('coinsShown') ?? n;
    this.registry.set('coinsShown', n);
    const t = this.add.text(x, y, `${prev}`, font(28, 800, '#ffe27a')).setOrigin(right ? 1 : 0, 0.5);
    const icon = this.add.image(right ? x - t.width - 24 : x - 26, y, this._coinTexture()).setScale(0.9);
    this.items.push(icon, t);
    if (n > prev) {
      const c = { v: prev };
      this.tweens.add({
        targets: c, v: n, delay: 350, duration: 900, ease: 'Cubic.easeOut',
        onUpdate: () => {
          if (!t.active) return;
          t.setText(`${Math.round(c.v)}`);
          if (right) icon.setX(x - t.width - 24);
        },
      });
      this.tweens.add({ targets: [t, icon], scale: '*=1.25', yoyo: true, delay: 350, duration: 160, repeat: 2 });
      this.time.delayedCall(350, () => { if (t.active) this._coinBurst(icon.x, icon.y); });
    }
    return { icon, text: t };
  }

  /**
   * Бонус серии дней: окно поверх главного экрана. Дни серии кружками,
   * сегодняшний подсвечен; на седьмом — коробка.
   */
  _streakPopup() {
    const W = this.W, H = this.H, cx = W / 2;
    const st = dailyState();
    // Что даст «Забрать» — те же правила, что и само забирание (с заморозкой)
    const pre = claimStreak(st, dayKey());
    const day = pre.streak, coins = pre.coins, box = pre.box;
    const cy = this.topY(H * 0.42);
    const layer = [];
    const add = (o) => { o.setDepth(50); layer.push(o); this.items.push(o); return o; };
    const shade = add(this.add.rectangle(0, this.topY(0), W, H, 0x05070c, 0.78).setOrigin(0, 0));
    shade.setInteractive();
    const pw = Math.min(W - 48, 640), ph = 420;
    ensureButton(this, `menu-streak-${pw}x${ph}`, pw, ph, 'normal');
    add(this.add.image(cx, cy, `menu-streak-${pw}x${ph}`));
    add(this.add.text(cx, cy - 160, `День ${day} подряд`, font(36, 800, UI.accent)).setOrigin(0.5));
    add(this.add.text(cx, cy - 116, pre.frozen ? 'вчера пропустил — заморозка спасла серию!' : 'заходи каждый день — награда растёт',
      font(18, 700, pre.frozen ? '#8fe3ff' : UI.textDim)).setOrigin(0.5));
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
    this.fromShop = false;
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
      ? `Серия: ${st.streak} ${plural(st.streak, 'день', 'дня', 'дней')} подряд · на ${STREAK_BOX_DAY}-й день — коробка · заморозок: ${st.freezes ?? 0}`
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
    this._inviteButton(cx, y + 106, Math.min(cw, 460));
    // Куда тратить монеты, кроме коробок
    this._button('cosmetics', cx, y + 212, 'Украшения', 'трос, след, надгробие · заморозка серии',
      () => this.showCosmetics(), { w: Math.min(cw, 460), h: 90, titleSize: 25, hintSize: 17 });
    this._tabs('tasks');
  }

  /** «Позвать друга» по своей ссылке: новичку и тебе — по коробке (shop.referral). */
  _inviteButton(x, y, w, h = 90) {
    const link = refLink();
    return this._button('invite', x, y, 'Позвать друга', link ? 'вам обоим — по коробке со скином' : 'работает в Telegram',
      () => {
        trackStep('invite');
        if (!shareLink(link, 'Залетай в бой на башне! По этой ссылке нам обоим дадут коробку со скином 🎁')) {
          copyText(link);
        }
      }, { w, h, titleSize: 25, hintSize: 17, enabled: Boolean(link), variant: 'primary' });
  }

  // -------------------------------------------------------------- магазин

  /** Монеты на главном — кнопка магазина: плашка с монетами и «+». right — правый край. */
  _coinShopLink(right, y) {
    const w = 300, h = 58, x = right - w / 2;
    const plate = this.add.graphics();
    plate.fillStyle(0x1c1440, 0.95).fillRoundedRect(x - w / 2, y - h / 2, w, h, h / 2);
    plate.lineStyle(3, 0xffc247, 0.9).strokeRoundedRect(x - w / 2, y - h / 2, w, h, h / 2);
    this.items.push(plate);
    const left = right - w;
    this.items.push(this.add.image(left + 32, y, ensureIcon(this, 'shop', 34)).setTint(0xffc247));
    this.items.push(this.add.text(left + 56, y, 'Магазин', font(21, 800, '#ffe27a')).setOrigin(0, 0.5));
    const coin = this._coinBadge(right - 62, y, true);
    const plus = this.add.circle(right - 28, y, 21, 0xffc247).setStrokeStyle(3, 0x5a2a08);
    const sign = this.add.text(right - 28, y - 1, '+', font(34, 900, '#2a1c06')).setOrigin(0.5);
    this.tweens.add({ targets: [plus, sign], scale: 1.12, duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.items.push(plus, sign);
    const zone = this.add.zone(x, y, w, h).setInteractive({ useHandCursor: true });
    zone.on('pointerdown', () => { haptic('tap'); coin.icon.setScale(0.8); });
    zone.on('pointerout', () => coin.icon.setScale(0.9));
    zone.on('pointerup', () => this.showShop());
    this.items.push(zone);
    this.buttons['coins-shop'] = { x, y: y + this.oy, w, h, enabled: true };
  }

  /**
   * Магазин: всё, на что тратятся монеты, в одном месте. Сверху кошелёк,
   * главная витрина — коробка-сюрприз (светится и покачивается, рядом шансы),
   * ниже — скины поштучно, украшения и промокод. Купил коробку — она
   * открывается сразу, без перехода в другой раздел.
   */
  showShop() {
    this.section = this.showShop;
    this.fromShop = true;
    this._clear();
    trackStep('shop_open');
    this._fxTextures();
    const W = this.W;
    const wide = !this.portrait;
    const st = skinState();
    const coins = dailyState().coins;
    const full = BOX_SKINS.every((s) => st.owned.includes(s.id));
    this._title('Магазин', 'монеты — за бои, задания дня и серию дней');

    // Кошелёк
    const wy = 160;
    const n = this.add.text(W / 2 + 26, wy, `${coins}`, font(46, 900, '#ffe27a')).setOrigin(0.5).setStroke('#5a2a08', 6);
    const ic = this.add.image(n.x - n.width / 2 - 30, wy, this._coinTexture()).setScale(1.3);
    this.items.push(n, ic);

    // Витрина: коробка-сюрприз
    const cardW = Math.min(W - 40, 560);
    const cx = wide ? Math.max(cardW / 2 + 30, W * 0.3) : W / 2;
    const cardTop = wide ? 212 : 216;
    const cardH = 400;
    const card = this.add.graphics();
    card.fillStyle(0x1c1440, 0.92).fillRoundedRect(cx - cardW / 2, cardTop, cardW, cardH, 28);
    card.lineStyle(4, 0xffc247, 0.85).strokeRoundedRect(cx - cardW / 2, cardTop, cardW, cardH, 28);
    this.items.push(card);
    const by = cardTop + 130;
    const rays = this.add.image(cx, by, 'fx-rays').setTint(0xffc247).setAlpha(0.32).setScale(0.85);
    this.tweens.add({ targets: rays, angle: 360, duration: 12000, repeat: -1 });
    const glow = this.add.circle(cx, by, 80, 0xffc247, 0.22);
    this.tweens.add({ targets: glow, scale: 1.2, alpha: 0.1, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.items.push(rays, glow);
    if (this.textures.exists('shot_crate_weapon')) {
      const box = this.add.image(cx, by, 'shot_crate_weapon').setScale(fitScale(this, 'shot_crate_weapon', 150));
      this.tweens.add({ targets: box, y: by - 10, angle: { from: -4, to: 4 }, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      box.setInteractive({ useHandCursor: true }).on('pointerup', () => {
        if (this._dragging) return;
        if (st.boxes > 0) this._openBox(() => this.showShop()); else this._buyBox();
      });
      this.items.push(box);
      if (st.boxes > 0) {
        this.items.push(this.add.text(cx + 70, by - 70, `×${st.boxes}`, font(28, 900, '#1a1408'))
          .setOrigin(0.5).setPadding(10, 2, 10, 2).setBackgroundColor('#ffe27a'));
      }
    }
    this.items.push(this.add.text(cx, cardTop + 240, 'Коробка-сюрприз', font(32, 900, '#ffffff'))
      .setOrigin(0.5).setStroke('#140a20', 6));
    // Шансы — цветом редкости, в строку
    const parts = RARITY_ORDER.map((k) => this.add.text(0, 0, `${RARITY[k].name} ${RARITY[k].odds}%`, font(17, 800, RARITY[k].color)));
    const gap = 14;
    const total = parts.reduce((a, t) => a + t.width, 0) + gap * (parts.length - 1);
    let px = cx - total / 2;
    for (const t of parts) { t.setPosition(px, cardTop + 280).setOrigin(0, 0.5); px += t.width + gap; this.items.push(t); }
    const bw = cardW - 60;
    if (st.boxes > 0) {
      this._button('shop-open', cx, cardTop + 342, `Открыть коробку${st.boxes > 1 ? ` · ×${st.boxes}` : ''}`, '',
        () => this._openBox(() => this.showShop()), { w: bw, h: 76, variant: 'primary', titleSize: 27 });
    } else {
      const can = coins >= BOX_PRICE && !full;
      this._button('shop-box', cx, cardTop + 342, `Купить · ${BOX_PRICE} 🪙`,
        full ? 'все скины уже собраны' : can ? 'повтор — монеты назад' : `не хватает ${BOX_PRICE - coins}`,
        () => this._buyBox(), { w: bw, h: 76, variant: 'primary', titleSize: 27, hintSize: 15, enabled: can });
    }

    // Остальное: скины поштучно, украшения, промокод
    const lx = wide ? Math.min(W - 250, W * 0.72) : W / 2;
    const lw = wide ? Math.min(420, W - cx - cardW / 2 - 60) : cardW;
    let y = wide ? 250 : cardTop + cardH + 66;
    const row = (key, title, hint, onTap, variant) => {
      this._button(key, lx, y, title, hint, onTap, { w: lw, h: 90, titleSize: 25, hintSize: 16, variant });
      y += 106;
    };
    row('shop-skins', 'Скины', `собрано ${st.owned.length} из ${SKINS.length} · любой — поштучно`, () => this.showSkins());
    row('shop-cosmetics', 'Украшения', 'трос, след, надгробие · заморозка серии', () => this.showCosmetics());
    row('shop-promo', '🎟 Промокод', 'подарок от друга или из канала', () => this._askPromo());
    this._tabs('shop');
    this._scrollable(y + 20);
  }

  // ------------------------------------------------------------ украшения

  /**
   * Украшения за монеты: по ряду на трос, след и надгробие. Купленное —
   * тап, и надето; некупленное — цена, тап — купить и надеть. Внизу —
   * заморозка серии.
   */
  showCosmetics() {
    this.section = this.showCosmetics;
    this._clear();
    this._title('Украшения', 'на бой не влияют · соперник видит их тоже');
    const W = this.W, cx = W / 2;
    this._coinBadge(W - 40, 72, true);
    const st = cosState();
    const coins = dailyState().coins;
    const toast = (msg, color = '#ff9a9a') => {
      const t = this.add.text(cx, 150, msg, font(22, 800, color)).setOrigin(0.5).setDepth(60);
      this.items.push(t);
      this.tweens.add({ targets: t, alpha: 0, delay: 1400, duration: 400 });
    };
    let y = 176;
    const rowH = this.portrait ? 92 : 70;
    for (const kind of KINDS) {
      this.items.push(this.add.text(cx, y, KIND_NAMES[kind], font(this.fs(15), 800, UI.accent)).setOrigin(0.5, 0));
      y += 34;
      const list = COSMETICS[kind];
      const cols = this.portrait ? 3 : list.length;
      const bw = Math.min(200, (W - 48 - (cols - 1) * 10) / cols), bh = rowH - 10;
      list.forEach((it, i) => {
        const x = cx + ((i % cols) - (cols - 1) / 2) * (bw + 10);
        const yy = y + Math.floor(i / cols) * rowH + bh / 2;
        const own = st.owned[kind].includes(it.id);
        const on = st.equipped[kind] === it.id;
        this._button(`cos-${kind}-${it.id}`, x, yy, it.name, on ? 'надето' : own ? 'надеть' : `${it.price} монет`, () => {
          if (own) { equipCosmetic(kind, it.id); haptic('select'); this.showCosmetics(); return; }
          const res = buyCosmetic(kind, it.id);
          if (res === 'ok') { haptic('win'); sfx.play('pickup'); this.showCosmetics(); toast(`«${it.name}» куплено и надето`, '#8ef0a0'); return; }
          haptic('warn'); toast('не хватает монет');
        }, {
          w: bw, h: bh, titleSize: this.portrait ? 21 : 18, hintSize: 15,
          variant: on ? 'active' : 'normal', enabled: own || coins >= it.price,
        });
        // Образец цвета у троса и следа
        if (it.color || it.rainbow) {
          const c = it.rainbow ? 0xff7ad9 : it.color;
          this.items.push(this.add.rectangle(x - bw / 2 + 12, yy, 8, bh - 22, c).setOrigin(0.5).setDepth(1));
        }
      });
      y += Math.ceil(list.length / cols) * rowH + 12;
    }
    // Заморозка серии
    const d = dailyState();
    const full = (d.freezes ?? 0) >= FREEZE_MAX;
    this._button('freeze', cx, y + 40, `Заморозка серии · ${FREEZE_PRICE}`,
      `в запасе ${d.freezes ?? 0} из ${FREEZE_MAX} · спасает серию, если пропустил день · одна бесплатно в неделю`, () => {
        if (buyStreakFreeze()) { haptic('win'); sfx.play('pickup'); this.showCosmetics(); toast('заморозка в запасе', '#8fe3ff'); return; }
        haptic('warn'); toast(full ? 'запас полон' : 'не хватает монет');
      }, { w: Math.min(W - 48, 620), h: 84, titleSize: 24, hintSize: 14, enabled: !full && d.coins >= FREEZE_PRICE });
    this._back(() => (this.fromShop ? this.showShop() : this.showTasks()));
  }

  /** Купить коробку и сразу открыть; назад — в раздел, откуда покупали. */
  _buyBox() {
    const from = this.section ?? this.showSkins;
    const back = () => from.call(this);
    const res = buyBox();
    if (res === 'ok') {
      haptic('win');
      sfx.play('pickup');
      this._openBox(back);
      return;
    }
    haptic('warn');
    const t = this.add.text(this.W / 2, 150, res === 'full' ? 'все скины уже собраны' : 'не хватает монет',
      font(24, 800, '#ff9a9a')).setOrigin(0.5).setDepth(60).setStroke('#140a20', 6);
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
    // Перерисовка того же раздела (надел скин, закрыл окно) — место прокрутки
    // сохраняем, а не прыгаем наверх
    const keep = this.section === this.showSkins ? this.scrollY : 0;
    this.section = this.showSkins;
    this._clear();
    const st = skinState();
    this._title('Скины', `собрано ${st.owned.length} из ${SKINS.length}`);
    const W = this.W, cx = W / 2;

    // Промокод — в шапке: низ раздела на телефоне за краем экрана
    this._button('promo', W - 92, 80, '🎟 Код', '', () => this._askPromo(), { w: 150, h: 52, titleSize: 20 });

    // --- коробки ---
    const full = BOX_SKINS.every((s) => st.owned.includes(s.id));
    const coins = dailyState().coins;
    const boxY = 186;
    if (this.textures.exists('shot_crate_weapon')) {
      this.items.push(this.add.image(cx - 190, boxY, 'shot_crate_weapon')
        .setScale(fitScale(this, 'shot_crate_weapon', 72)).setAlpha(st.boxes > 0 ? 1 : 0.4));
    }
    this.items.push(this.add.text(cx - 140, boxY - 24, `Коробок: ${st.boxes}`, font(24, 800)).setOrigin(0, 0));
    this.items.push(this.add.text(cx - 140, boxY + 8, `монет: ${coins}`,
      font(17, 700, UI.accent)).setOrigin(0, 0));
    if (st.boxes > 0) {
      this._button('open-box', cx + 190, boxY, 'Открыть', '', () => this._openBox(),
        { w: 170, h: 64, variant: 'primary', titleSize: 24 });
    } else {
      this._button('buy-box', cx + 190, boxY, `Коробка · ${BOX_PRICE}`, '', () => this._buyBox(),
        { w: 190, h: 64, enabled: coins >= BOX_PRICE && !full, titleSize: 21 });
    }
    // Шансы коробки — на виду: игрок знает, на что тратит
    const odds = RARITY_ORDER.map((k) => `${RARITY[k].name} ${RARITY[k].odds}%`).join(' · ');
    this.items.push(this.add.text(cx, boxY + 50, `в коробке: ${odds}\nповтор — монеты назад`,
      font(15, 700, UI.textDim)).setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(W - 40));

    // --- сетка скинов ---
    const cols = this.portrait ? 4 : 8;
    const cw = Math.min(170, Math.floor((W - 40) / cols));
    const ch = cw + 34;
    const x0 = cx - (cols * cw) / 2 + cw / 2;
    const y0 = 300 + ch / 2;
    SKINS.forEach((skin, i) => {
      const x = x0 + (i % cols) * cw, y = y0 + Math.floor(i / cols) * (ch + 10);
      const owned = st.owned.includes(skin.id);
      const on = st.equipped === skin.id;
      const key = `menu-skin-${cw - 10}x${ch}-${on ? 'active' : 'normal'}`;
      ensureButton(this, key, cw - 10, ch, on ? 'active' : 'normal');
      const plate = this.add.image(x, y, key).setAlpha(owned ? 1 : 0.6);
      this.items.push(plate);
      const sheet = this.textures.exists(skin.sheet) ? skin.sheet : 'smiley';
      const face = this.add.sprite(x, y + cw * 0.22, sheet, 0).setOrigin(0.5, 0.92)
        .setScale((cw - 30) / 100).setFlipX(true);
      if (owned) face.play(`${sheet}_idle`);
      else face.setTintFill(0x10141f).setAlpha(0.85);
      this.items.push(face);
      const rar = RARITY[skin.rarity] ?? RARITY.common;
      // Закрытый: цена в монетах цветом редкости; тап — окно покупки
      this.items.push(this.add.text(x, y + ch / 2 - 16,
        owned ? (on ? 'надет' : skin.name) : `${skinPrice(skin.id)} 🪙`,
        font(17, 800, on ? '#2a1c06' : rar.color)).setOrigin(0.5));
      plate.setInteractive({ useHandCursor: true });
      if (owned) plate.on('pointerup', () => { if (this._dragging) return; haptic('select'); equipSkin(skin.id); this.showSkins(); });
      else plate.on('pointerup', () => { if (this._dragging) return; haptic('select'); this._skinOffer(skin); });
      this.buttons[`skin-${skin.id}`] = { x, y: y + this.oy, w: cw - 10, h: ch, enabled: true };
    });

    // --- магазин: коробка за монеты ---
    const rows = Math.ceil(SKINS.length / cols);
    const sy = y0 + rows * (ch + 10) - ch / 2 + 26;
    this.items.push(this.add.text(cx, sy, 'Магазин', font(26, 800, UI.accent)).setOrigin(0.5, 0));
    trackStep('shop_open');
    this._button('shop-box', cx, sy + 92, `Коробка-сюрприз · ${BOX_PRICE} 🪙`,
      full ? 'все скины уже собраны' : coins >= BOX_PRICE ? 'случайный скин по шансам выше' : `не хватает ${BOX_PRICE - coins}`,
      () => this._buyBox(), { w: Math.min(W - 48, 520), h: 88, titleSize: 24, hintSize: 16, enabled: coins >= BOX_PRICE && !full });
    this.items.push(this.add.text(cx, sy + 148,
      'монеты — за бои, задания дня, серию дней и первое прохождение кампании',
      font(16, 700, UI.textDim)).setOrigin(0.5, 0).setAlign('center').setWordWrapWidth(W - 48));
    // Ниже экрана на телефоне — крутится пальцем
    this._back(this.fromShop ? () => this.showShop() : undefined);
    this._scrollable(sy + 210);
    this._setScroll(keep);
  }

  /** Ввести промокод: сервер проверяет, подарок сразу в коробки и кошелёк. */
  _askPromo() {
    let got = null;
    askText({
      title: 'Промокод', label: 'Код',
      maxLength: 32, upper: true, okText: 'Активировать',
      note: 'Один код — один раз на игрока.',
      validate: async (v) => {
        if (!/^[A-Z0-9_-]{3,32}$/.test(v)) return 'код — от 3 до 32 букв и цифр';
        try { got = await redeemPromo(v); return null; } catch (e) { return e.message || 'не вышло'; }
      },
    }).then(() => {
      if (!got) return;
      if (got.owned) applyServerOwned(got.owned);
      haptic('win');
      (this.section === this.showShop ? this.showShop : this.showSkins).call(this);
      const parts = [got.boxes && `коробок: ${got.boxes}`, got.coins && `монет: ${got.coins}`].filter(Boolean).join(' · ');
      const t = this.add.text(this.W / 2, 120, `🎁 ${parts}`, font(30, 800, UI.accent)).setOrigin(0.5).setScale(0.4);
      this.items.push(t);
      this.tweens.add({ targets: t, scale: 1, duration: 300, ease: 'Back.easeOut' });
      this.tweens.add({ targets: t, alpha: 0, delay: 2200, duration: 500 });
    });
  }

  /**
   * Окно покупки закрытого скина: кто это, какой редкости, сколько стоит.
   * Силуэт остаётся силуэтом — сюрприз у коробки не отнимаем.
   */
  _skinOffer(skin) {
    this.scrollMax = 0;          // окно поверх — раздел под ним не крутится
    const W = this.W, H = this.H, cx = W / 2, cy = this.topY(H * 0.45);
    const price = skinPrice(skin.id);
    const coins = dailyState().coins;
    const rar = RARITY[skin.rarity] ?? RARITY.common;
    const before = this.items.length;
    const shade = this.add.rectangle(0, this.topY(0), W, H, 0x05070c, 0.8).setOrigin(0, 0).setInteractive();
    shade.on('pointerup', () => this.showSkins());
    this.items.push(shade);
    const sheet = this.textures.exists(skin.sheet) ? skin.sheet : 'smiley';
    // Силуэт светлее затемнения, с ободком цвета редкости — видно форму, но не лицо
    this.items.push(this.add.circle(cx, cy - 110, 120, Phaser.Display.Color.HexStringToColor(rar.color).color, 0.12));
    this.items.push(this.add.sprite(cx, cy - 20, sheet, 0).setOrigin(0.5, 0.92).setScale(2.2).setFlipX(true)
      .setTintFill(0x3a4766).setAlpha(0.95));
    this.items.push(this.add.text(cx, cy - 250, skin.name, font(40, 800, UI.text)).setOrigin(0.5));
    this.items.push(this.add.text(cx, cy - 205, rar.name, font(24, 800, rar.color)).setOrigin(0.5));
    this.items.push(this.add.text(cx, cy + 30, `у тебя ${coins} 🪙`, font(20, 700, UI.textDim)).setOrigin(0.5));
    this._button('skin-buy', cx, cy + 110, `Купить · ${price} 🪙`, coins >= price ? '' : `не хватает ${price - coins}`,
      () => this._buySkin(skin), { w: 320, h: 84, variant: 'primary', titleSize: 26, hintSize: 16, enabled: coins >= price });
    this._button('skin-cancel', cx, cy + 210, 'Отмена', '', () => this.showSkins(), { w: 220, h: 64, titleSize: 22 });
    for (const o of this.items.slice(before)) o.setDepth(50);
  }

  _buySkin(skin) {
    const res = buySkin(skin.id);
    if (res !== 'ok') { haptic('warn'); this.showSkins(); return; }
    haptic('win');
    sfx.play('pickup');
    this.showSkins();
    const t = this.add.text(this.W / 2, 150, `«${skin.name}» твой и уже надет`, font(22, 800, '#8ef0a0')).setOrigin(0.5).setDepth(60);
    this.items.push(t);
    this.tweens.add({ targets: t, alpha: 0, delay: 1600, duration: 400 });
  }

  /**
   * Открытие коробки: она трясётся, лопается, из неё выскакивает скин.
   * Что выпадет, решается сразу; анимация только показывает.
   */
  /**
   * Открытие коробки — маленькое шоу. Коробка трясётся всё сильнее и
   * светится, перебирая цвета редкостей, пока не остановится на выпавшей:
   * чем реже скин, тем дольше перебор. Потом вспышка цвета редкости,
   * вращающиеся лучи, конфетти, скин выпрыгивает с прыжком, крупная
   * надпись редкости. Легендарный — золотой дождь и тряска экрана;
   * повтор — россыпь монет.
   */
  _openBox(back = () => this.showSkins()) {
    const res = openSkinBox();
    if (!res.skin) { back(); return; }
    const skin = SKIN_BY_ID[res.skin];
    this.scrollMax = 0;          // окно поверх — раздел под ним не крутится
    const W = this.W, H = this.H, cx = W / 2;
    // В альбомной экран низкий: всё окно чуть плотнее
    const k = Math.min(1, (H - 120) / 680);
    const cy = this.topY(H * (this.portrait ? 0.42 : 0.47));
    const layer = [];
    const add = (o, d = 50) => { o.setDepth(d); layer.push(o); this.items.push(o); return o; };
    const hex = (c) => parseInt(String(c).slice(1), 16);
    const rank = Math.max(0, RARITY_ORDER.indexOf(skin.rarity));
    const rar = RARITY[skin.rarity] ?? RARITY.common;
    const color = hex(rar.color);
    this._fxTextures();

    // Затемнение ловит касания: под ним ничего нажать нельзя
    const shade = add(this.add.rectangle(0, this.topY(0), W, H, 0x05070c, 0.86).setOrigin(0, 0));
    shade.setInteractive();
    // Лучи за коробкой: медленно вращаются, пока белые
    const rays = add(this.add.image(cx, cy, 'fx-rays').setAlpha(0.18).setScale(1.6));
    this.tweens.add({ targets: rays, angle: 360, duration: 9000, repeat: -1 });
    // Свечение — перебирает цвета редкостей
    const glow = add(this.add.circle(cx, cy, 120, hex(RARITY.common.color), 0.35));
    this.tweens.add({ targets: glow, scale: 1.25, alpha: 0.15, duration: 260, yoyo: true, repeat: -1 });
    const box = add(this.add.image(cx, cy, 'shot_crate_weapon').setScale(fitScale(this, 'shot_crate_weapon', 190)));
    const base = box.scale;
    haptic('tap');
    sfx.play('crateDrop');

    // Нарастание: тряска сильнее, коробка разбухает, цвет ступенькой вверх
    const steps = 3 + rank * 2;
    const stepMs = 260;
    for (let k = 0; k < steps; k++) {
      this.time.delayedCall(k * stepMs, () => {
        if (!box.active) return;
        const lvl = Math.min(rank, Math.floor((k / (steps - 1)) * (rank + 0.999)));
        const c = hex(RARITY[RARITY_ORDER[lvl]].color);
        glow.setFillStyle(c, 0.4);
        rays.setTint(c);
        const amp = 5 + k * 2.2;
        this.tweens.add({ targets: box, angle: { from: -amp, to: amp }, duration: 60, yoyo: true, repeat: 1 });
        box.setScale(base * (1 + k * 0.035));
        haptic('select');
        if (k === steps - 1) sfx.play('tick');
      });
    }

    this.time.delayedCall(steps * stepMs + 120, () => {
      if (!box.active) return;
      box.destroy();
      haptic('win');
      sfx.play('pickup');
      sfx.play('explosion', { radius: 24 + rank * 14 });
      this.uiCam.shake(180 + rank * 120, 0.004 + rank * 0.003);
      glow.setFillStyle(color, 0.45);
      rays.setTint(color);
      this.tweens.add({ targets: rays, alpha: 0.3 + rank * 0.1, scale: 2.4, duration: 400, ease: 'Cubic.easeOut' });

      // Вспышка цвета редкости и белая середина
      const flash = add(this.add.circle(cx, cy, 40, color, 0.9));
      this.tweens.add({ targets: flash, radius: 520, alpha: 0, duration: 600, ease: 'Cubic.easeOut' });
      const core = add(this.add.circle(cx, cy, 30, 0xffffff, 1));
      this.tweens.add({ targets: core, radius: 220, alpha: 0, duration: 380, ease: 'Cubic.easeOut' });
      const ring = add(this.add.circle(cx, cy, 60).setStrokeStyle(10, color, 1));
      this.tweens.add({ targets: ring, scale: 6, alpha: 0, duration: 700, ease: 'Cubic.easeOut' });

      // Конфетти: цвет редкости, белый и золото — и звёздочки
      const palette = [color, 0xffffff, 0xffd166, color, 0xff8ad4, 0x8ef0a0];
      const em = add(this.add.particles(cx, cy, 'fx-dot', {
        speed: { min: 200, max: 640 }, angle: { min: 0, max: 360 }, gravityY: 560,
        lifespan: { min: 1000, max: 1900 }, scale: { start: 1.5, end: 0.3 }, rotate: { min: 0, max: 360 },
        tint: palette, emitting: false,
      }), 52);
      em.explode(70 + rank * 40);
      const stars = add(this.add.particles(cx, cy, 'fx-star', {
        speed: { min: 80, max: 300 }, angle: { min: 0, max: 360 }, lifespan: { min: 700, max: 1300 },
        scale: { start: 1.1, end: 0 }, rotate: { start: 0, end: 360 }, tint: [color, 0xffffff], emitting: false,
      }), 52);
      stars.explode(18 + rank * 10);
      // Легендарный — золотой дождь сверху ещё полторы секунды
      if (rank >= 3) {
        const rain = add(this.add.particles(0, this.topY(-20), 'fx-star', {
          x: { min: 0, max: W }, speedY: { min: 220, max: 420 }, speedX: { min: -40, max: 40 },
          lifespan: 2400, scale: { start: 0.9, end: 0.4 }, rotate: { start: 0, end: 540 },
          tint: [0xffd166, 0xffb347, 0xffffff], frequency: 30, quantity: 2,
        }), 52);
        this.time.delayedCall(1600, () => rain.active && rain.stop());
      }

      // Скин выпрыгивает и подпрыгивает
      const sheet = this.textures.exists(skin.sheet) ? skin.sheet : 'smiley';
      const hero = add(this.add.sprite(cx, cy + 70 * k, sheet, 0).setOrigin(0.5, 0.92).setScale(0.2).setFlipX(true), 53);
      hero.play(`${sheet}_win`);
      this.tweens.add({ targets: hero, scale: 3 * k, duration: 560, ease: 'Back.easeOut' });
      this.tweens.add({ targets: hero, y: cy + 50 * k, duration: 360, delay: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

      // Редкость — крупно, с ударом; ниже имя
      const tag = res.dup ? 'ПОВТОР' : `${rar.name.toUpperCase()}!`;
      const head = add(this.add.text(cx, cy - 280 * k, tag, font(rank >= 2 ? 54 : 46, 900, rar.color))
        .setOrigin(0.5).setStroke('#140a20', 10).setShadow(0, 6, '#000000', 12, true, true).setScale(2.4).setAlpha(0), 54);
      this.tweens.add({ targets: head, scale: 1, alpha: 1, duration: 360, ease: 'Back.easeOut' });
      this.tweens.add({ targets: head, scale: 1.08, duration: 520, delay: 400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      const name = add(this.add.text(cx, cy + 130 * k, skin.name, font(50, 900, '#ffffff'))
        .setOrigin(0.5).setStroke('#140a20', 8).setScale(0.3), 54);
      this.tweens.add({ targets: name, scale: 1, duration: 420, delay: 180, ease: 'Back.easeOut' });
      add(this.add.text(cx, cy + 180 * k, res.dup ? `уже есть — +${res.refund} монет назад` : 'новый скин в коллекции',
        font(22, 800, res.dup ? '#ffe27a' : '#cfe8ff')).setOrigin(0.5).setStroke('#140a20', 6), 54);

      // Повтор — монеты сыплются вверх
      if (res.dup) {
        const coins = add(this.add.particles(cx, cy + 40, this._coinTexture(), {
          speed: { min: 260, max: 520 }, angle: { min: 230, max: 310 }, gravityY: 700,
          lifespan: 1400, scale: { start: 0.8, end: 0.5 }, emitting: false,
        }), 52);
        coins.explode(18);
        sfx.play('pickup');
      }

      const btn = (key, dx, label, variant, onTap) => {
        const before = this.items.length;
        this._button(key, cx + dx, cy + 260 * k, label, '', onTap, { w: 250, h: 78, variant, titleSize: 26 });
        for (const o of this.items.slice(before)) o.setDepth(56);
      };
      this.time.delayedCall(700, () => {
        if (!shade.active) return;
        if (res.dup) btn('skin-later', 0, 'Дальше', 'primary', back);
        else {
          btn('skin-wear', -140, 'Надеть', 'primary', () => { equipSkin(skin.id); back(); });
          btn('skin-later', 140, 'Потом', 'normal', back);
        }
      });
    });
  }

  /** Текстуры эффектов меню: точка конфетти, звёздочка, лучи. */
  _fxTextures() {
    if (!this.textures.exists('fx-dot')) {
      const tex = this.textures.createCanvas('fx-dot', 12, 12);
      const c = tex.getContext();
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(6, 6, 5.5, 0, Math.PI * 2); c.fill();
      tex.refresh();
    }
    if (!this.textures.exists('fx-star')) {
      const tex = this.textures.createCanvas('fx-star', 28, 28);
      const c = tex.getContext();
      c.fillStyle = '#ffffff';
      c.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 5 : 13, a = -Math.PI / 2 + (k * Math.PI) / 5;
        c.lineTo(14 + Math.cos(a) * r, 14 + Math.sin(a) * r);
      }
      c.closePath(); c.fill();
      tex.refresh();
    }
    if (!this.textures.exists('fx-rays')) {
      const S = 512, tex = this.textures.createCanvas('fx-rays', S, S);
      const c = tex.getContext();
      const g = c.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, S / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2, w = Math.PI / 22;
        c.beginPath(); c.moveTo(S / 2, S / 2);
        c.arc(S / 2, S / 2, S / 2, a - w, a + w);
        c.closePath(); c.fill();
      }
      tex.refresh();
    }
  }

  // -------------------------------------------------------------- режимы

  /** Всё, кроме «Играть»: выбор соперника на башне и прежние режимы. */
  showModes() {
    this.section = this.showModes;
    this._clear();
    this._title('Режимы');
    const cx = this.W / 2;
    const stars = totalStars(challengeStars());
    const done = ascentDone().size;
    const modes = [
      ['ascent', 'Кампания «Подъём»', `${ASCENT.length} боёв, монстры и боссы · пройдено ${done} из ${ASCENT.length}`, () => this.showAscent()],
      ['daily', 'Башня дня', 'одна башня на всех · таблица дня', () => this.showDailyTower()],
      ['tower', 'Башня', 'высокая арена и трос · выбрать соперника', () => this.showTower()],
      ['challenges', 'Испытания', `задачи на три звезды · ★ ${stars} из ${CHALLENGES.length * 3}`, () => this.showChallenges()],
      ['online', 'Онлайн', 'бой с человеком на башне · рейтинг', () => this.showOnline()],
      ['campaign', 'Классика', 'старые миссии на широких картах', () => this.showCampaign()],
      ['quick', 'Свои правила', 'обычная карта, бот или вдвоём', () => this.showQuick()],
    ];
    // В портрете — столбиком, в ландшафте — в две колонки: семь не влезают
    const cols = this.portrait ? 1 : 2;
    const w = this.portrait ? Math.min(this.W - 64, 620) : Math.min(420, (this.W - 96) / 2);
    const h = this.portrait ? 92 : 72, step = this.portrait ? 104 : 84;
    const y0 = 176;
    modes.forEach(([key, title, hint, go], i) => {
      const x = cols === 1 ? cx : cx + ((i % 2) ? 1 : -1) * (w / 2 + 12);
      const y = y0 + Math.floor(i / cols) * step;
      this._button(key, x, y, title, hint, go,
        { w, h, titleSize: 28, hintSize: 17, variant: i < 2 ? 'primary' : 'normal' });
    });
    this._back();
  }

  // ------------------------------------------------------------- башня дня

  /** Башня дня: таблица дня, моё место, «В бой». Без сервера — просто бой. */
  async showDailyTower() {
    this.section = this.showDailyTower;
    this._clear();
    this._title('Башня дня', 'одна башня на всех · меньше ходов — выше место');
    const cx = this.W / 2;
    const wait = this.add.text(cx, 190, 'загружаю таблицу…', font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0);
    this.items.push(wait);
    const local = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const res = await fetchDailyTower();
    if (this.section !== this.showDailyTower) return;
    wait.destroy();
    const day = res?.day ?? local;
    const w = Math.min(560, this.W - 48);
    let y = 186;
    if (res) {
      const head = res.players ? `сегодня сыграли: ${res.players}` : 'сегодня ещё никто не играл — будь первым';
      this.items.push(this.add.text(cx, y, head, font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0));
      y += 40;
      res.top.slice(0, this.portrait ? 10 : 5).forEach((r, i) => {
        const what = r.won ? `${r.turns} ${r.turns < 5 ? 'хода' : 'ходов'} · ${r.hp} hp` : 'не взял';
        this.items.push(this.add.text(cx - w / 2, y, `${i + 1}. ${r.name}`, font(this.fs(15), 800, i < 3 ? UI.accent : UI.text)).setOrigin(0, 0));
        this.items.push(this.add.text(cx + w / 2, y, what, font(this.fs(15), 700, UI.textDim)).setOrigin(1, 0));
        y += this.portrait ? 40 : 30;
      });
      if (res.me) {
        const me = res.me.won ? `${res.me.turns} ходов · ${res.me.hp} hp` : 'пока не взята';
        this.items.push(this.add.text(cx, y + 8, `ты: место ${res.me.place} · ${me} · попыток ${res.me.tries}`,
          font(this.fs(15), 800, '#8ef0a0')).setOrigin(0.5, 0));
        y += 40;
      }
    } else {
      this.items.push(this.add.text(cx, y, 'таблица дня — в Telegram', font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0));
      y += 40;
    }
    this._button('daily-go', cx, Math.max(y + 70, this.portrait ? 640 : 0), 'В бой', 'первая победа дня — +60 монет',
      () => this.start(dailyMatch(day)),
      this.portrait ? { variant: 'primary', w: 360, h: 96, titleSize: 30 } : { variant: 'primary', w: 320, h: 74 });
    this._back(() => this.showModes());
  }

  // ------------------------------------------------------ кампания «Подъём»

  /** Три главы: прогресс в каждой; закрытая — пока не пройдена предыдущая. */
  showAscent() {
    this.section = this.showAscent;
    this._clear();
    const done = ascentDone();
    this._title('Подъём', `пройдено ${done.size} из ${ASCENT.length} · коробки со скинами по пути`);
    const cx0 = this.W / 2;
    // Четыре главы: в портрете столбиком, в ландшафте — два на два
    const cols = this.portrait ? 1 : 2;
    const w = this.portrait ? Math.min(this.W - 64, 620) : Math.min(420, (this.W - 96) / 2);
    const h = this.portrait ? 120 : 96;
    const step = h + 18;
    CHAPTERS.forEach((ch, idx) => {
      const i = Math.floor(idx / cols);
      const cx = cols === 1 ? cx0 : cx0 + (idx % 2 ? 1 : -1) * (w / 2 + 12);
      const list = ASCENT.filter((m) => m.chapter === ch.id);
      const first = ASCENT.indexOf(list[0]);
      const open = ascentOpen(first, done);
      const n = list.filter((m) => done.has(m.id)).length;
      this._button(`chapter-${ch.id}`, cx, 196 + h / 2 + i * step, `${idx + 1}. ${ch.title}`,
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
      const tag = m.boss && m.title !== bossName(m) && !m.title.includes(bossName(m)) ? ` · ${bossName(m)}` : '';
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
    if (m.boss) parts.push(`босс: ${bossName(m)}`);
    if (mons.slime) parts.push(`слизней: ${mons.slime}`);
    if (mons.cactus) parts.push(`кактусов: ${mons.cactus}`);
    const sides = m.teams.length > 1
      ? `${m.teams[0].worms} против ${m.teams[1].worms}`
      : `${m.teams[0].worms} бойца против босса`;
    // Аффиксы уровня — что здесь особенного
    const affixes = (m.affixes ?? DEFAULT_AFFIXES[chapterOf(m).variant] ?? []).map((id) => AFFIXES[id]).filter(Boolean);
    const affixLines = affixes.length ? ['', ...affixes.map((a) => `◆ ${a.name}: ${a.desc}`)] : [];
    const t = this.add.text(cx, 176, [m.brief, '', sides, parts.join(' · '), ...affixLines].join('\n'), font(this.fs(16), 700))
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
   *
   * Сверху два переключателя в один ряд: «Все / Друзья» и, для всех,
   * «Рейтинг / Турниры». Друзья — свой список с местом и «Вызвать».
   */
  showTop(kind = this.topKind ?? 'rating', scope = this.topScope ?? 'all') {
    this.section = this.showTop;
    this.topKind = kind;
    this.topScope = scope;
    this._clear();
    const friends = scope === 'friends';
    this._title(friends ? 'Друзья' : 'Топ игроков', friends ? 'кого ты позвал, кто позвал тебя и с кем ты сыграл на рейтинг'
      : kind === 'tourney' ? 'по победам в турнирах' : 'рейтинг по подтверждённым боям');
    const cx = this.W / 2;
    // Ряд: [Все][Друзья]  [Рейтинг][Турниры] — 652 в ширину, влезает и в портрет 720
    const bw = 150, x0 = cx - 326;
    const seg = (key, label, x, on, onTap) => this._button(key, x, 160, label, '', onTap,
      { w: bw, h: 40, variant: on ? 'active' : 'normal' });
    seg('top-all', 'Все', x0 + 75, !friends, () => this.showTop(kind, 'all'));
    seg('top-friends', 'Друзья', x0 + 233, friends, () => this.showTop(kind, 'friends'));
    if (!friends) {
      seg('top-rating', 'Рейтинг', x0 + 419, kind === 'rating', () => this.showTop('rating', 'all'));
      seg('top-tourney', 'Турниры', x0 + 577, kind === 'tourney', () => this.showTop('tourney', 'all'));
    }
    const note = this.add.text(cx, 204, 'загружаю…', font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0);
    this.items.push(note);
    // Пришли со вкладки — внизу вкладки; из лобби — кнопка «назад» в лобби
    if (this.topFrom === 'tab') this._tabs('top');
    else this._back(() => this.showOnline());
    const still = () => this.section === this.showTop && this.topKind === kind && this.topScope === scope;

    if (friends) {
      // Сводка — на месте второго переключателя
      this.friendsHead = this.add.text(x0 + 498, 160, '', font(this.fs(13), 800, UI.accent)).setOrigin(0.5);
      this.items.push(this.friendsHead);
      if (!loggedIn()) {
        note.destroy();
        this._renderFriends(null);
        return;
      }
      fetchFriends().then((data) => {
        if (!still()) return;
        this.friendRows = data.friends;
        note.destroy();
        this._renderFriends(data);
      }).catch((e) => {
        if (still()) note.setText(`сервер недоступен: ${e.message}`);
      });
      return;
    }

    fetchTop(10, kind).then((rows) => {
      if (!still()) return;
      this.topRows = rows;
      note.destroy();
      this._renderTop(rows, kind);
    }).catch((e) => {
      if (!still()) return;
      note.setText(`сервер недоступен: ${e.message}`);
    });
  }

  /** Лист модельки по скину; нет такого — обычный смайлик. */
  _skinSheet(skin) {
    const sheet = SKIN_BY_ID[skin]?.sheet;
    return sheet && this.textures.exists(sheet) ? sheet : 'smiley';
  }

  /**
   * Топ друзей списком: место, моделька в надетом скине, ник, лига, когда
   * был в игре, рейтинг и «Вызвать». Ты — в списке со своим местом и
   * подсвечен. Длинный список крутится пальцем, вкладки стоят на месте.
   * Друзей нет (или нет входа) — пара строк о том, кто здесь появится, и
   * «Позвать друга».
   */
  _renderFriends(data) {
    const W = this.W, cx = W / 2;
    const add = (o) => { this.items.push(o); return o; };
    const short = (name, n) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);
    const rows = data?.friends ?? [];
    const others = rows.filter((r) => !r.me);
    const tabs = this.topFrom === 'tab';
    const listTop = 200;

    if (!others.length) {
      this.friendsHead?.setText('');
      const lines = data
        ? ['Здесь пока только ты.',
          'Позови друга по своей ссылке — он появится здесь, а вам обоим дадут по коробке со скином.',
          'Сюда же попадает каждый, с кем ты доиграл бой по сети на рейтинг.']
        : ['Друзья видны в Telegram.', 'Открой игру в Telegram — и здесь появятся те, кого ты позвал и с кем сыграл.'];
      // В ландшафте по высоте тесно: плотнее строки и кнопки
      const p = this.portrait;
      const t = add(this.add.text(cx, listTop + (p ? 40 : 14), lines, font(this.fs(15), 700, UI.text))
        .setOrigin(0.5, 0).setAlign('center').setLineSpacing(p ? 10 : 3).setWordWrapWidth(Math.min(W - 80, 640)));
      const y = t.y + t.height + (p ? 70 : 52);
      const w = Math.min(W - 64, 460);
      this._inviteButton(cx, y, w, p ? 90 : 80);
      this._button('friends-duel', cx, y + (p ? 104 : 88), 'Вызвать на бой', 'карточкой в любой чат · без рейтинга',
        () => this.challengeFriend(), { w, h: p ? 80 : 70, titleSize: 23, hintSize: 16 });
      this._scrollable(y + 140 + (tabs ? 40 : 0));
      return;
    }

    this.friendsHead?.setText(data.place ? `ты ${data.place}-й из ${data.total}` : `друзей: ${others.length}`);
    const roomy = this.portrait;
    const rowH = roomy ? 100 : 76;
    const lw = Math.min(W - 48, 980);
    const lx0 = cx - lw / 2, lx1 = cx + lw / 2;
    const g = add(this.add.graphics());
    rows.forEach((r, i) => {
      const y = listTop + i * rowH;
      const h = rowH - 10;
      const mine = Boolean(r.me);
      g.fillStyle(mine ? 0x2a2a1a : 0x161d2e, 1).fillRoundedRect(lx0, y, lw, h, 12);
      g.lineStyle(mine ? 3 : 2, mine ? 0xffd166 : 0xffffff, mine ? 1 : 0.08).strokeRoundedRect(lx0, y, lw, h, 12);
      const placeColor = r.place <= 3 ? ['#ffc93c', '#c9d4e6', '#d98c4a'][r.place - 1] : UI.textDim;
      add(this.add.text(lx0 + 34, y + h / 2, `${r.place}`, font(this.fs(16), 800, placeColor)).setOrigin(0.5));
      const sheet = this._skinSheet(r.skin);
      add(this.add.sprite(lx0 + 92, y + h - 2, sheet, 0).setOrigin(0.5, 0.92).setScale((h * 0.95) / 100).setFlipX(true))
        .play(`${sheet}_idle`);
      const nx = lx0 + 140;
      add(this.add.text(nx, y + h / 2 - 2, short(r.name, roomy ? 14 : 20), font(this.fs(15), 800, mine ? UI.accent : UI.text))
        .setOrigin(0, 1));
      const sub = [leagueOf(r.rating).name, `побед ${r.wins}`, mine ? '' : seenText(r.seenAt)].filter(Boolean).join(' · ');
      add(this.add.text(nx, y + h / 2 + 4, sub, font(this.fs(11), 700, leagueOf(r.rating).text)).setOrigin(0, 0));
      const bx = lx1 - 86;
      add(this.add.text(bx - 92, y + h / 2, `${r.rating}`, font(this.fs(16), 800, UI.text)).setOrigin(1, 0.5));
      if (mine) {
        add(this.add.text(bx, y + h / 2, 'это ты', font(this.fs(13), 800, UI.accent)).setOrigin(0.5));
      } else {
        this._button(`duel-${r.id}`, bx, y + h / 2, 'Вызвать', '', () => this.challengeFriend(r),
          { w: 148, h: Math.min(56, h - 18), titleSize: roomy ? 22 : 19, variant: 'primary' });
      }
    });
    // Под списком — позвать ещё кого-нибудь
    const endY = listTop + rows.length * rowH + 56;
    this._inviteButton(cx, endY, Math.min(lw, 460), 84);
    // Низ раздела — над вкладками (или «назад»), чтобы последняя строка не пряталась
    this._scrollable(endY + 42 + (tabs ? (this.portrait ? 116 : 96) - 96 + 24 : 0));
  }

  /**
   * Топ-10 лестницей: тройка — на пьедестале в своих скинах (первый в
   * короне и радуется), дальше ступени вниз — место, моделька, ник, лига
   * и рейтинг. В портрете пьедестал над лестницей, в ландшафте — рядом.
   */
  _renderTop(rows, kind = 'rating') {
    const W = this.W, cx = W / 2;
    const me = player();
    const top = 196;
    const bottom = this.bottomY(this.topFrom === 'tab' ? (this.portrait ? 170 : 140) : 110);
    if (!rows.length) {
      this.items.push(this.add.text(cx, top + 20, kind === 'tourney'
        ? 'пока ни одного чемпиона — турниры впереди' : 'пока пусто — сыграй первый бой по сети на рейтинг',
      font(this.fs(14), 700, UI.textDim)).setOrigin(0.5, 0));
      return;
    }
    const score = (r) => (kind === 'tourney' ? `🏆 ${r.tourney_wins}` : `${r.rating}`);
    const sheetOf = (r) => this._skinSheet(r.skin);
    const short = (name, n) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);
    const add = (o) => { this.items.push(o); return o; };

    // Где пьедестал и где лестница
    const podW = this.portrait ? W : W * 0.46;
    const podCx = this.portrait ? cx : podW / 2 + 10;
    const podBottom = this.portrait ? top + Math.min(380, (bottom - top) * 0.47) : bottom - 10;
    const lx0 = this.portrait ? 24 : podW + 20;
    const lx1 = W - 24;
    const ly0 = this.portrait ? podBottom + 18 : top;

    // --- пьедестал ---
    const bw = Math.min(200, (podW - 60) / 3);
    const heights = [Math.min(170, (podBottom - top) * 0.45), 0, 0];
    heights[1] = heights[0] * 0.82; heights[2] = heights[0] * 0.68;
    const spots = [[podCx, heights[0]], [podCx - bw - 10, heights[1]], [podCx + bw + 10, heights[2]]];
    const medal = [0xffc93c, 0xc9d4e6, 0xd98c4a];
    const g = add(this.add.graphics());
    rows.slice(0, 3).forEach((r, i) => {
      const [x, h] = spots[i];
      const mine = r.id === me.id;
      const y = podBottom - h;
      g.fillStyle(0x1a2338, 1).fillRoundedRect(x - bw / 2, y, bw, h, 14);
      g.fillStyle(medal[i], 1).fillRoundedRect(x - bw / 2, y, bw, 10, { tl: 14, tr: 14, bl: 0, br: 0 });
      g.lineStyle(mine ? 4 : 2, mine ? 0xffd166 : 0xffffff, mine ? 1 : 0.12).strokeRoundedRect(x - bw / 2, y, bw, h, 14);
      add(this.add.text(x, y + 16, `${i + 1}`, font(this.fs(i ? 26 : 32), 800, `#${medal[i].toString(16).padStart(6, '0')}`)).setOrigin(0.5, 0));
      add(this.add.text(x, y + h - 52, short(r.name, 11), font(this.fs(13), 800, mine ? UI.accent : UI.text)).setOrigin(0.5, 0));
      add(this.add.text(x, y + h - 28, score(r), font(this.fs(12), 700, kind === 'tourney' ? UI.accent : leagueOf(r.rating).text)).setOrigin(0.5, 0));
      // Моделька на ступени: первый радуется, остальные стоят
      const sheet = sheetOf(r);
      const k = (bw * (i ? 0.68 : 0.8)) / 100;
      const hero = add(this.add.sprite(x, y + 4, sheet, 0).setOrigin(0.5, 0.92).setScale(k).setFlipX(i !== 2));
      hero.play(i === 0 ? `${sheet}_win` : `${sheet}_idle`);
      if (i === 0) {
        const crown = add(this.add.text(x, y - 100 * k * 0.86, '👑', { fontSize: `${Math.round(40 * k)}px` }).setOrigin(0.5, 1));
        this.tweens.add({ targets: crown, y: crown.y - 8, yoyo: true, repeat: -1, duration: 900, ease: 'Sine.easeInOut' });
      }
    });

    // --- лестница 4–10: каждая ступень чуть ниже и правее ---
    const rest = rows.slice(3, 10);
    const rowH = Math.min(86, (bottom - ly0) / Math.max(1, rest.length));
    const shift = Math.min(14, (lx1 - lx0) * 0.02);
    rest.forEach((r, i) => {
      const place = i + 4;
      const mine = r.id === me.id;
      const y = ly0 + i * rowH;
      const x0 = lx0 + i * shift;
      const w = lx1 - x0;
      const h = rowH - 8;
      g.fillStyle(mine ? 0x2a2a1a : 0x161d2e, 1).fillRoundedRect(x0, y, w, h, 12);
      g.lineStyle(mine ? 3 : 2, mine ? 0xffd166 : 0xffffff, mine ? 1 : 0.08).strokeRoundedRect(x0, y, w, h, 12);
      add(this.add.text(x0 + 30, y + h / 2, `${place}`, font(this.fs(16), 800, UI.textDim)).setOrigin(0.5));
      const sheet = sheetOf(r);
      add(this.add.sprite(x0 + 82, y + h - 2, sheet, 0).setOrigin(0.5, 0.92).setScale((h * 0.95) / 100).setFlipX(true))
        .play(`${sheet}_idle`);
      add(this.add.text(x0 + 128, y + h / 2 - 2, short(r.name, 16), font(this.fs(14), 800, mine ? UI.accent : UI.text)).setOrigin(0, 1));
      add(this.add.text(x0 + 128, y + h / 2 + 2, leagueLabel(r.rating), font(this.fs(11), 700, leagueOf(r.rating).text)).setOrigin(0, 0));
      add(this.add.text(lx1 - 18, y + h / 2, score(r), font(this.fs(15), 800, kind === 'tourney' ? UI.accent : UI.text)).setOrigin(1, 0.5));
    });

    const rank = myRank(rows);
    const foot = rank ? `ты на ${rank} месте` : !loggedIn() ? 'открой игру в Telegram, чтобы попасть в таблицу'
      : kind === 'tourney' ? 'выиграй турнир — и ты здесь' : 'тебя пока нет в десятке — побеждай в боях по сети';
    add(this.add.text(cx, bottom + 8, foot, font(this.fs(12), 700, UI.textDim)).setOrigin(0.5, 0));
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
    // Вызов другу через бота — что с ним (challengeFriend)
    this.roomNoteText = this.add.text(cx, 142, this.roomNote?.room === room ? this.roomNote.text : '',
      font(this.fs(14), 800, '#8ef0a0')).setOrigin(0.5, 0);
    this.items.push(this.roomNoteText);
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

  /**
   * Вызов с главного экрана: комната башни и сразу выбор чата для карточки.
   * friend — «Вызвать» из топа друзей: сначала бот пишет этому другу с
   * кнопкой прямо в комнату; не вышло (лимит, друг отписался от бота, нет
   * сети) — тот же выбор чата с карточкой, что и без друга.
   */
  challengeFriend(friend = null) {
    const room = randomRoom(true, true);
    this.roomNote = null;
    this.showRoom(room);
    const share = () => { if (inTelegram()) this.buttonHandlers?.copy?.(); };
    if (!friend || !loggedIn()) {
      this.time.delayedCall(250, share);
      return;
    }
    this._setRoomNote(room, `отправляю вызов: ${friend.name}…`);
    inviteFriend(friend.id, room).then((sent) => {
      if (this.hosting !== room) return;
      if (sent) {
        trackStep('invite');
        haptic('win');
        this._setRoomNote(room, `Вызов ушёл в Telegram: ${friend.name}. Ждём здесь`);
      } else {
        this._setRoomNote(room, null);
        share();
      }
    });
  }

  /** Строка над кодом комнаты: что с вызовом другу. Живёт и после поворота экрана. */
  _setRoomNote(room, text) {
    this.roomNote = text ? { room, text } : null;
    if (this.roomNoteText?.active) this.roomNoteText.setText(text ?? '');
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
