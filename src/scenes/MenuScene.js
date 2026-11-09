import { UI, font, ensureButton } from '../ui/theme.js';
import { CFG } from '../config.js';
import { MISSIONS, loadProgress, isUnlocked } from '../campaign/missions.js';
import { objectiveText } from '../campaign/objectives.js';
import { quickMatch, campaignMatch, onlineMatch, QUICK_OPTIONS } from '../core/match.js';
import { SHAPES } from '../core/shapes.js';
import { randomRoom, copyText } from '../net/transport.js';
import { isCasualRoom } from '../net/rooms.js';
import { Lobby } from '../net/lobby.js';
import { pendingSession, forgetSession } from '../net/session.js';
import { syncMe, fetchTop, myRank, loggedIn, onAccountChange } from '../net/server.js';
import { openAccountDialog, closeAccountDialog } from '../ui/AccountDialog.js';
import { makeTransport } from '../net/connect.js';
import { player, setName } from '../platform/player.js';
import {
  inviteLink as tgInviteLink, shareRoom, canOfferHomeScreen, addToHomeScreen, onHomeScreenChange,
} from '../platform/telegram.js';
import { leagueOf, nextLeague, leagueProgress, toNextLeague, leagueLabel } from '../platform/league.js';
import { BOT_LEVELS } from '../ai/Bot.js';
import { isDesktop, setUiMode } from '../platform/device.js';
import { sfx } from '../audio/Sfx.js';

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
    this.showRoot();

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
      closeAccountDialog();
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
    this.oy = Math.max(0, Math.round((this.H - CFG.VIEW_BASE) / 2));
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
      this.items.push(this.add.text(this.W / 2, 106, sub, font(15, 700, UI.textDim))
        .setOrigin(0.5, 0));
    }
    return t;
  }

  /**
   * Кнопка меню. Ширина фиксированная, чтобы столбец читался как список,
   * а не как набор разных плашек.
   */
  _button(key, x, y, label, hint, onTap, { w = 420, h = 66, variant = 'normal', enabled = true, into = null } = {}) {
    const texKey = `menu-btn-${w}x${h}-${variant}`;
    ensureButton(this, texKey, w, h, variant);
    const img = this.add.image(x, y, texKey).setOrigin(0.5);
    const alpha = enabled ? 1 : 0.45;
    img.setAlpha(alpha);

    const title = this.add.text(x, hint ? y - 10 : y, label,
      font(hint ? 20 : h < 50 ? 17 : 22, 800, enabled ? UI.text : UI.textDim)).setOrigin(0.5).setAlpha(alpha);
    this.items.push(img, title);
    into?.push(img, title);
    let sub = null;
    if (hint) {
      sub = this.add.text(x, y + 15, hint, font(12, 700, UI.textDim))
        .setOrigin(0.5).setAlpha(alpha);
      this.items.push(sub);
      into?.push(sub);
    }
    // Надписи кнопки — чтобы обновлять подсказку на месте (счётчик поиска)
    this.buttonTexts ??= {};
    this.buttonTexts[key] = { title, sub };

    if (enabled) {
      img.setInteractive({ useHandCursor: true });
      img.on('pointerdown', () => { img.setScale(0.97).setTint(0xcccccc); });
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
  _leagueBar(cx, y, rating) {
    const w = 420, h = 10;
    const cur = leagueOf(rating);
    const next = nextLeague(rating);
    const left = cx - w / 2;

    this.items.push(this.add.rectangle(left, y, w, h, 0x0b1220, 0.85).setOrigin(0, 0.5));
    const fill = Math.max(3, Math.round(w * leagueProgress(rating)));
    this.items.push(this.add.rectangle(left, y, fill, h, cur.color).setOrigin(0, 0.5));

    this.items.push(this.add.text(left, y + 12, cur.name, font(12, 800, cur.text))
      .setOrigin(0, 0));
    this.items.push(this.add.text(left + w, y + 12,
      next ? `до «${next.name}» ещё ${toNextLeague(rating)}` : 'выше некуда',
      font(12, 700, UI.textDim)).setOrigin(1, 0));
  }

  _back(onTap = () => this.showRoot()) {
    this._button('back', 92, this.bottomY(46), '← назад', '', onTap, { w: 148, h: 50 });
  }

  showRoot() {
    this.section = this.showRoot;
    this._clear();
    this._title('WORMS', 'прототип пошаговой артиллерии');
    const cx = this.W / 2;
    const y0 = 214, step = 86;

    this._button('quick', cx, y0, 'Быстрая игра', 'случайная карта',
      () => this.showQuick(), { variant: 'primary' });
    this._button('campaign', cx, y0 + step, 'Кампания', 'миссии с условиями',
      () => this.showCampaign());
    this._button('online', cx, y0 + step * 2, 'Онлайн', 'игра вдвоём по ссылке',
      () => this.showOnline());

    // Аккаунт: ник и пароль, нужен для общего рейтинга
    const me = player();
    if (loggedIn()) {
      this._button('account', cx, y0 + step * 3, me.name,
        `рейтинг ${me.rating}${me.rank ? ` · место ${me.rank}` : ''} · профиль`, () => this.openAccount());
    } else {
      this._button('account', cx, y0 + step * 3, 'Аккаунт',
        'войти или создать — для общего рейтинга', () => this.openAccount());
    }

    // Партия оборвалась (Telegram перезапустился, погас экран), а мы
    // открылись без ссылки: предлагаем вернуться, пока соперник ждёт
    const pending = pendingSession();
    if (pending && Date.now() - pending.at < 15 * 60 * 1000) {
      this._button('resume', cx, y0 + step * 4, 'Вернуться в бой',
        `комната ${pending.room} · соперник ждёт`, () => this.startOnline(pending.room),
        { variant: 'primary' });
      this._button('resume-no', cx + 300, y0 + step * 4, '✕', '',
        () => { forgetSession(pending.room); this.showRoot(); }, { w: 56, h: 56 });
    }

    // Иконка на экран Домой: открывает игру внутри Telegram сразу в полный
    // экран. Кнопка есть, только пока Telegram говорит, что иконки нет
    if (canOfferHomeScreen()) {
      this._button('home', 132, this.bottomY(46), '⌂ На экран Домой', '',
        () => addToHomeScreen(), { w: 228, h: 50 });
    }

    // Настройки в правом нижнем углу: схема управления и звук. Схема
    // выбирается сама по устройству, но ноутбук с сенсорным экраном или
    // планшет с мышью игрок переключит сам — выбор запоминается.
    const desktop = isDesktop();
    this._button('ui-mode', this.W - 130, this.bottomY(62),
      desktop ? 'Управление: ПК' : 'Управление: сенсор', '',
      () => { setUiMode(desktop ? 'touch' : 'desktop'); this.showRoot(); }, { w: 228, h: 44 });
    this._button('sound', this.W - 330, this.bottomY(62),
      sfx.muted ? 'Звук: выкл' : 'Звук: вкл', '',
      () => { sfx.setMuted(!sfx.muted); this.showRoot(); }, { w: 156, h: 44 });

    // Пять тапов по подписи — диагностика экрана (index.html): что видит
    // страница на самом деле, когда с телефона приходит «не весь экран»
    const foot = this.add.text(this.W - 16, this.bottomY(14),
      desktop ? 'мышь и клавиатура · в бою F1 — подсказка' : 'бой — в ландшафте',
      font(11, 700, UI.textDim)).setOrigin(1, 1);
    foot.setInteractive();
    foot.on('pointerdown', () => {
      this.diagTaps = (this.diagTaps ?? 0) + 1;
      if (this.diagTaps % 5 === 0) {
        this.diagOn = !this.diagOn;
        globalThis.__diag?.(this.diagOn);
      }
    });
    this.items.push(foot);
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
    const shapes = ['random', ...SHAPES.map((sh) => sh.id)];
    const shapeName = (id) => (id === 'random' ? 'любая' : SHAPES.find((sh) => sh.id === id)?.name ?? id);
    const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
    const opt = (key, x, w, label, next) => this._button(key, x, 168, label, '',
      () => { this.quickOptions = { ...this.quickOptions, ...next() }; this.showQuick(); },
      { w, h: 44 });
    opt('opt-shape', cx - 140, 270, `Карта: ${shapeName(o.shape)}`,
      () => ({ shape: cycle(shapes, o.shape) }));
    opt('opt-worms', cx + 70, 140, `Бойцов: ${o.worms}`,
      () => ({ worms: cycle(QUICK_OPTIONS.worms, o.worms) }));
    opt('opt-time', cx + 215, 140, `Ход: ${o.turnTime} с`,
      () => ({ turnTime: cycle(QUICK_OPTIONS.turnTime, o.turnTime) }));

    const y0 = 240, step = 74;
    this._button('hotseat', cx, y0, 'Вдвоём на одном устройстве', 'ходы по очереди',
      () => this.start(quickMatch(null, o)), { variant: 'primary' });

    const levels = ['rookie', 'fighter', 'sniper'];
    const hints = {
      rookie: 'только базука, целится грубо',
      fighter: 'считает траекторию, бьёт уверенно',
      sniper: 'всё оружие, промахивается редко',
    };
    levels.forEach((id, i) => {
      this._button(id, cx, y0 + step * (i + 1), `Против бота: ${BOT_LEVELS[id].name}`,
        hints[id], () => this.start(quickMatch(id, o)));
    });
    this._back();
  }

  /** Настройки быстрой игры: запоминаются в браузере. */
  get quickOptions() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('worms.quick.v1') ?? 'null'); } catch { saved = null; }
    const pick = (list, v, d) => (list.includes(v) ? v : d);
    const shapes = ['random', ...SHAPES.map((sh) => sh.id)];
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
    const w = Math.min(400, (this.W - 120) / 2);
    const rows = Math.ceil(MISSIONS.length / 2);
    const step = 70;
    const y0 = 168;
    const colX = [this.W / 2 - w / 2 - 14, this.W / 2 + w / 2 + 14];

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
        { enabled: open, variant: next ? 'primary' : 'normal', w, h: 60 });
    });
    this._back();
  }

  /** Вводная перед миссией: без неё условия видно только по факту. */
  showBrief(mission) {
    this.section = () => this.showBrief(mission);
    this._clear();
    this._title(mission.title, mission.subtitle);
    const cx = this.W / 2;

    const w = Math.min(620, this.W - 80);
    const h = mission.brief.length * 30 + 44;
    const y = 168;
    ensureButton(this, `menu-panel-${w}x${h}`, w, h, 'normal');
    this.items.push(this.add.image(cx, y + h / 2, `menu-panel-${w}x${h}`).setOrigin(0.5));
    mission.brief.forEach((line, i) => {
      this.items.push(this.add.text(cx, y + 26 + i * 30, line, font(15, 700))
        .setOrigin(0.5, 0));
    });
    this.items.push(this.add.text(cx, y + h + 12,
      `Задача: ${objectiveText(mission.objective)}`, font(14, 800, UI.accent))
      .setOrigin(0.5, 0));

    this._button('start', cx, y + h + 74, 'В бой', '',
      () => this.start(campaignMatch(mission.id)), { variant: 'primary', w: 300, h: 62 });
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

    // Профиль. С аккаунтом — окно профиля (там и смена ника); без него —
    // вход и смена имени, которое увидит соперник. В Telegram имя своё.
    if (loggedIn()) {
      this._button('profile', cx, 186, `${me.name} · профиль`, '', () => this.openAccount(), { w: 300, h: 44 });
    } else if (me.telegram) {
      this._button('login', cx, 186, 'Войти в аккаунт', '', () => this.openAccount(),
        { w: 256, h: 44, variant: 'primary' });
    } else {
      this._button('login', cx - 106, 186, 'Войти в аккаунт', '', () => this.openAccount(),
        { w: 208, h: 44, variant: 'primary' });
      this._button('rename', cx + 106, 186, 'Сменить имя', '', () => {
        const v = globalThis.prompt?.('Имя в бою:', me.name);
        if (v) { setName(v); this.showOnline(); }
      }, { w: 208, h: 44 });
    }
    this.items.push(this.add.text(cx, 214,
      `побед ${me.wins} · поражений ${me.losses}`, font(12, 700, UI.textDim))
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
      () => this.showTop(), { w: 170, h: 50 });

    this._back();
    this._ensureLobby();
    this._showTables(this.lobby?.tables() ?? []);
  }

  /**
   * Таблица лидеров с сервера. Видна всем, попасть в неё — сыграть бой по
   * сети с аккаунтом против соперника с аккаунтом.
   */
  showTop() {
    this.section = this.showTop;
    this._clear();
    this._title('Топ игроков', 'рейтинг по подтверждённым боям');
    const cx = this.W / 2;
    const note = this.add.text(cx, 150, 'загружаю…', font(14, 700, UI.textDim)).setOrigin(0.5, 0);
    this.items.push(note);
    this._back(() => this.showOnline());
    if (!loggedIn()) {
      this._button('login', this.W - 130, this.bottomY(46), 'Войти', '', () => this.openAccount(), { w: 200, h: 50 });
    }

    fetchTop(20).then((rows) => {
      if (this.section !== this.showTop) return;
      this.topRows = rows;
      note.destroy();
      this._renderTop(rows);
    }).catch((e) => {
      if (this.section !== this.showTop) return;
      note.setText(`сервер недоступен: ${e.message}`);
    });
  }

  _renderTop(rows) {
    const cx = this.W / 2;
    const me = player();
    const x0 = cx - 300, top = 146, step = 32;
    const maxRows = Math.max(3, Math.floor((this.bottomY(70) - top) / step));
    if (!rows.length) {
      this.items.push(this.add.text(cx, top, 'пока пусто — сыграй первый бой по сети с аккаунтом',
        font(14, 700, UI.textDim)).setOrigin(0.5, 0));
      return;
    }
    rows.slice(0, maxRows).forEach((r, i) => {
      const y = top + i * step;
      const mine = r.id === me.id;
      const color = mine ? UI.accent : UI.text;
      this.items.push(this.add.text(x0, y, `${i + 1}.`, font(15, 800, UI.textDim)).setOrigin(0, 0));
      this.items.push(this.add.text(x0 + 40, y, r.name, font(15, 800, color)).setOrigin(0, 0));
      this.items.push(this.add.text(x0 + 330, y, leagueLabel(r.rating),
        font(13, 700, leagueOf(r.rating).text)).setOrigin(0, 0));
      this.items.push(this.add.text(x0 + 600, y, `${r.wins}–${r.losses}`,
        font(13, 700, UI.textDim)).setOrigin(1, 0));
    });
    const rank = myRank(rows);
    const foot = rank ? `ты на ${rank} месте` : loggedIn()
      ? 'тебя пока нет в таблице — доиграй бой по сети' : 'в таблицу попадают игроки с аккаунтом';
    this.items.push(this.add.text(cx, this.bottomY(74), foot, font(12, 700, UI.textDim)).setOrigin(0.5, 1));
  }

  /** Окно аккаунта: вход и регистрация или профиль. */
  openAccount() {
    openAccountDialog({ onTop: () => this.showTop() });
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
      font(13, 800, UI.accent)).setOrigin(0, 0);
    rows.push(head);

    if (!tables.length) {
      rows.push(this.add.text(x, top + 28, this.lobbyNote || 'пока никто не создал игру — создай свою',
        font(12, 700, UI.textDim)).setOrigin(0, 0));
    }

    const step = 40;
    const maxRows = Math.max(1, Math.floor((this.bottomY(70) - (top + 28)) / step));
    tables.slice(0, maxRows).forEach((t, i) => {
      const y = top + 28 + i * step;
      rows.push(this.add.text(x, y, t.name, font(14, 800, UI.text)).setOrigin(0, 0));
      rows.push(this.add.text(x, y + 17, leagueLabel(t.rating),
        font(11, 700, leagueOf(t.rating).text)).setOrigin(0, 0));
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
      font(16, 800, UI.accent)).setOrigin(0.5, 0);
    this.items.push(this.searchStatus);
    this.items.push(this.add.text(cx, 244, casual
      ? 'Подойдёт любой, кто тоже ищет бой без рейтинга.'
      : 'Круг поиска расширяется каждые пять секунд ожидания.',
      font(13, 700, UI.textDim)).setOrigin(0.5, 0));

    this._button('cancel', cx, 316, 'Отменить поиск', '', () => {
      this.lobby?.search(false);
      this._stopSearchTicker();
      this.showOnline();
    }, { w: 300, h: 56 });

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
      const n = this.lobby?.searchingCount(this.searchQueue);
      if (n != null) this.searchCount?.setText(`Сейчас ищут: ${n}${n === 1 ? ' — только ты' : ''}`);
    };
    this.searchTicker = this.time.addEvent({ delay: 400, loop: true, callback: tick });
    tick();
    this.events.once('shutdown', () => this._stopSearchTicker());
  }

  _stopSearchTicker() {
    this.searchTicker?.remove();
    this.searchTicker = null;
  }

  askCode() {
    const raw = globalThis.prompt?.('Код комнаты:', '') ?? '';
    const code = raw.trim().toUpperCase();
    if (code) this.startOnline(code);
  }

  /**
   * Игра создана: стол виден в лобби, код и ссылка — для друга. Хозяин
   * ждёт здесь; как только кто-то войдёт (из лобби или по ссылке), лобби
   * отправит обоих в комнату.
   */
  showRoom(room) {
    this.section = () => this.showRoom(room);
    this._clear();
    this._title('Игра создана', isCasualRoom(room)
      ? 'без рейтинга · стол виден всем в лобби'
      : 'на рейтинг · стол виден всем в лобби');
    const cx = this.W / 2;

    this.hosting = room;
    this._ensureLobby();
    this.lobby?.host(room);

    const code = this.add.text(cx, 176, room, font(72, 800, UI.accent)).setOrigin(0.5, 0);
    this.items.push(code);
    this.items.push(this.add.text(cx, 268, 'код для друга', font(12, 700, UI.textDim)).setOrigin(0.5, 0));

    const link = this.inviteLink(room);
    // В Telegram зовём родным выбором чата, снаружи — буфером обмена
    this._button('copy', cx, 330, 'Позвать друга', '',
      () => {
        if (shareRoom(room, link)) return;
        copyText(link);
        // Подтверждение одно на все нажатия: иначе оно множится стопкой
        if (this.copiedLabel) return;
        this.copiedLabel = this.add.text(cx, 372, 'ссылка скопирована', font(13, 700, '#8ef0a0'))
          .setOrigin(0.5, 0);
        this.items.push(this.copiedLabel);
      }, { w: 340, h: 58, variant: 'primary' });
    this.items.push(this.add.text(cx, 404, 'ждём соперника…', font(15, 800, UI.accent)).setOrigin(0.5, 0));
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
    this.start(onlineMatch());
  }

  start(match) {
    this.registry.set('match', match);
    this.registry.set('seed', match.seed ?? null);
    this.registry.set('forceBiome', match.biome ?? null);
    this.scene.start('Game');
  }
}
