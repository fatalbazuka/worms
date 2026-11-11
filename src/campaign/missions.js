/**
 * Кампания «Компостная куча».
 *
 * История простая, как лопата: синие заняли компостную кучу — единственный
 * склад отряда, — и красных отправляют её отбивать. Сначала полигон, потом
 * перевал, пустыня, болото, город, подземелья, и в конце та самая куча.
 * Вторая глава — «За проливом»: отбитые синие уходят за море, и погоня
 * учит новому снаряжению — телепорту и авиаудару — на картах новой формы.
 * Каждая миссия учит ровно одному приёму и не даёт проскочить его мимо:
 * без ветра — нечем промахнуться, без ящиков — нечем разбрасываться.
 *
 * Миссия — это данные, а не код: карта задаётся зерном и биомом, стороны —
 * числом бойцов и уровнем бота, особые условия — полем rules, а чем миссия
 * кончится — полем objective (см. objectives.js).
 *
 * Зерно фиксировано намеренно: миссия должна быть одинаковой у всех, иначе
 * «интересная» расстановка получится случайно один раз из десяти. Каждое
 * зерно здесь не выдумано, а проверено запуском настоящей партии: все
 * бойцы стоят на суше и не в земле, стороны разнесены больше 250 px и
 * меньше 1800 px (дальность выстрела при полной силе), суши на карте
 * достаточно. Менять зерно, не перепроверив, нельзя — на плохом острове
 * миссия становится непроходимой.
 *
 * rules:
 *   wind        — фиксированный ветер вместо случайного (px/s²)
 *   windRange   — свой диапазон случайного ветра [min, max]
 *   crateChance — вероятность ящика на ходу (0 = ящиков нет)
 *   ammo        — стартовые патроны игрока по id оружия
 *   enemyAmmo   — то же для бота
 *   turnTime    — своя длительность хода
 *
 * shape — форма карты (core/shapes.js); без поля — остров, как у первой
 * главы. Зерно проверяется вместе с формой: на другой форме оно даст
 * другую карту.
 *
 * objective (проверяет objectives.js, поле необязательное):
 *   { kind: 'eliminate' }              — выбить всех (по умолчанию)
 *   { kind: 'survive',  turns: N }     — продержаться N ходов
 *   { kind: 'noLosses' }               — победить без потерь
 *   { kind: 'underPar', turns: N }     — победить за N ходов
 *   text — как задача звучит в брифинге
 */

export const MISSIONS = [
  {
    id: 'range',
    title: 'Пристрелка',
    subtitle: '2 против 1 · ветра нет',
    brief: [
      'Полигон за казармой. Ветра нет, противник один и стреляет мимо.',
      'Держи «ОГОНЬ» дольше — снаряд летит дальше.',
      'Кнопки ▲▼ крутят ствол: 45° добивает дальше всего.',
    ],
    biome: 'forest',
    seed: 20250811,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 1, control: 'bot', level: 'rookie' },
    ],
    rules: { wind: 0, crateChance: 0.25 },
    objective: { kind: 'eliminate', text: 'Выбить мишень' },
  },

  {
    id: 'storm',
    title: 'Шторм',
    subtitle: '2 против 2 · сильный боковой ветер',
    brief: [
      'Перевал. Ветер тут не «немного сносит», а уносит.',
      'Смотри на стрелку вверху: она показывает силу и сторону.',
      'Против ветра бей выше и сильнее, по ветру — короче.',
    ],
    biome: 'snow',
    seed: 771203,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 2, control: 'bot', level: 'rookie' },
    ],
    rules: { windRange: [190, 300], crateChance: 0.5 },
    objective: { kind: 'eliminate' },
  },

  {
    id: 'undermine',
    title: 'Подкоп',
    subtitle: '2 против 2 · четыре крота, ветра нет',
    brief: [
      'Синие сели на скалу и бьют сверху вниз, как в тире.',
      'В лоб не лезь: крот заходит не с фронта, а снизу.',
      'Убери землю из-под врага — падение доделает остальное.',
    ],
    biome: 'desert',
    seed: 5140922,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 2, control: 'bot', level: 'fighter' },
    ],
    // Ветра нет специально: миссия про землю, а не про поправку на снос.
    // Кротов дают с запасом, гранаты и кассеты — нет: копать так копать.
    rules: {
      wind: 0, crateChance: 0.2,
      ammo: { mole: 4, grenade: 1, cluster: 0 },
    },
    objective: { kind: 'eliminate', text: 'Выбить всех со скалы' },
  },

  {
    id: 'rations',
    title: 'Сухой паёк',
    subtitle: '2 против 2 · без ящиков, 12 ходов',
    brief: [
      'Обоз утонул в болоте: ящиков не будет, патроны наперечёт.',
      'Базука бесконечна, всё остальное — по одному выстрелу.',
      'И штаб торопит: уложись в 12 ходов, дальше нас накроют.',
    ],
    biome: 'jungle',
    seed: 3306145,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 2, control: 'bot', level: 'fighter' },
    ],
    // Ноль ящиков — не жадность, а условие задачи: пополниться негде,
    // и каждый промах стоит хода.
    rules: {
      crateChance: 0, turnTime: 25,
      ammo: { grenade: 1, cluster: 1, mole: 1 },
    },
    objective: { kind: 'underPar', turns: 12, text: 'Победить за 12 ходов' },
  },

  {
    id: 'holdout',
    title: 'Держаться',
    subtitle: '2 против 3 снайперов · продержаться 10 ходов',
    brief: [
      'Эвакуация будет, но не сейчас. Синих больше, и стреляют они метко.',
      'Задача не убить, а дожить: прячься за бетон, не стой на открытом.',
      'Продержись 10 ходов — вертушка заберёт обоих.',
    ],
    biome: 'urban',
    seed: 8820431,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 3, control: 'bot', level: 'sniper' },
    ],
    // Ящики частые: без лечения десять ходов под снайперами не живут.
    rules: { crateChance: 0.6, turnTime: 25 },
    objective: { kind: 'survive', turns: 10, text: 'Продержаться 10 ходов' },
  },

  {
    id: 'siege',
    title: 'В меньшинстве',
    subtitle: '2 против 3 · ящики выручают',
    brief: [
      'Их трое, они считают траекторию и никуда не спешат.',
      'В лоб не выйдет: разбирай землю под ними и роняй вниз.',
      'Ящики падают часто — без них не вытянуть.',
    ],
    biome: 'hell',
    seed: 4410077,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 3, control: 'bot', level: 'fighter' },
    ],
    rules: { crateChance: 0.75, ammo: { grenade: 4, cluster: 3, mole: 2 }, turnTime: 40 },
    objective: { kind: 'eliminate' },
  },

  {
    id: 'spotless',
    title: 'Все свои',
    subtitle: '3 против 3 · без потерь',
    brief: [
      'Штаб требует вернуть всех троих. Погиб один — задание провалено.',
      'Кассета накрывает сверху: бей с безопасной дистанции, не подходи.',
      'Раненого уводи вниз и в укрытие — он дороже быстрого размена.',
    ],
    biome: 'forest',
    seed: 6120388,
    teams: [
      { worms: 3, control: 'human' },
      { worms: 3, control: 'bot', level: 'fighter' },
    ],
    // Кассет много, ход длинный: цель требует не спешить, а разводить
    // бойцов и добивать с воздуха.
    rules: {
      crateChance: 0.6, turnTime: 40,
      ammo: { cluster: 4, grenade: 2, mole: 1 },
    },
    objective: { kind: 'noLosses', text: 'Победить, не потеряв ни одного бойца' },
  },

  {
    id: 'compost',
    title: 'Компостная куча',
    subtitle: '3 против 3 снайперов · ветер и никакой пощады',
    brief: [
      'Вот она — куча, из-за которой всё и началось.',
      'Трое снайперов, боковой ветер и полный склад у них за спиной.',
      'Всё, чему научился, — здесь и разом.',
    ],
    biome: 'hell',
    seed: 9017742,
    teams: [
      { worms: 3, control: 'human' },
      { worms: 3, control: 'bot', level: 'sniper' },
    ],
    rules: {
      windRange: [120, 260], crateChance: 0.55, turnTime: 40,
      ammo: { grenade: 3, cluster: 3, mole: 2 },
    },
    objective: { kind: 'eliminate', text: 'Отбить кучу: выбить всех' },
  },

  // ---------------------------------------------- глава 2: «За проливом»

  {
    id: 'islands',
    title: 'Переправа',
    subtitle: '2 против 2 · архипелаг, два телепорта',
    brief: [
      'Синие ушли за пролив. Ногами туда не дойти — между нами вода.',
      'Телепорт переносит туда, куда смотрит ствол, дальность — по силе.',
      'Силуэт показывает, где встанешь. Красный силуэт — значит, в воду.',
    ],
    biome: 'jungle',
    shape: 'archipelago',
    seed: 1741025,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 2, control: 'bot', level: 'fighter' },
    ],
    rules: { crateChance: 0.4, ammo: { teleport: 2 } },
    objective: { kind: 'eliminate', text: 'Переправиться и выбить всех' },
  },

  {
    id: 'gorge',
    title: 'Ущелье',
    subtitle: '2 против 3 · мы на дне, они на бортах',
    brief: [
      'Нас зажали на дне ущелья, синие сидят наверху по обе стороны.',
      'Снизу вверх их не достать — вызывай авиацию.',
      'Авиаудар падает туда, куда смотрит ствол; дальность — сила заряда.',
    ],
    biome: 'desert',
    shape: 'canyon',
    seed: 1547405,
    teams: [
      { worms: 2, control: 'human' },
      { worms: 3, control: 'bot', level: 'fighter' },
    ],
    rules: { crateChance: 0.4, turnTime: 35, ammo: { airstrike: 2, grenade: 2 } },
    objective: { kind: 'eliminate', text: 'Выбить всех с бортов' },
  },

  {
    id: 'twin',
    title: 'Две скалы',
    subtitle: '3 против 3 · держи высоту, без потерь',
    brief: [
      'Мы заняли скалу, синие внизу и на соседней вершине.',
      'Высота — наше всё: сверху видно каждого, гранаты катятся к ним сами.',
      'Не спускайся без нужды. Штаб ждёт всех троих обратно.',
    ],
    biome: 'snow',
    shape: 'mesas',
    seed: 1442676,
    teams: [
      { worms: 3, control: 'human' },
      { worms: 3, control: 'bot', level: 'fighter' },
    ],
    rules: {
      windRange: [80, 200], crateChance: 0.5, turnTime: 40,
      ammo: { grenade: 3, teleport: 1, airstrike: 1 },
    },
    objective: { kind: 'noLosses', text: 'Победить, не потеряв ни одного бойца' },
  },

  {
    id: 'deep',
    title: 'Подземелье',
    subtitle: '3 против 3 снайперов · пещеры, 16 ходов',
    brief: [
      'Последние синие ушли под землю, в сеть пещер.',
      'Сверху их прикрывает свод: копай кротом, клади динамит, бей с воздуха.',
      'Шестнадцать ходов — потом своды обвалятся вместе со всеми.',
    ],
    biome: 'forest',
    shape: 'caverns',
    seed: 1426838,
    teams: [
      { worms: 3, control: 'human' },
      { worms: 3, control: 'bot', level: 'sniper' },
    ],
    rules: {
      crateChance: 0.5, turnTime: 40,
      ammo: { mole: 3, dynamite: 2, airstrike: 1, grenade: 2 },
    },
    objective: { kind: 'underPar', turns: 16, text: 'Победить за 16 ходов' },
  },
];

export const MISSION_BY_ID = Object.fromEntries(MISSIONS.map((m) => [m.id, m]));

/** Цель миссии по её id. Нет миссии или цели — значит обычное выбивание. */
export function missionObjective(id) {
  return MISSION_BY_ID[id]?.objective ?? null;
}

const STORE_KEY = 'worms.campaign.v1';

/** Пройденные миссии. Хранилище может быть недоступно — это не повод падать. */
export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(data?.done) ? data.done : []);
  } catch {
    return new Set();
  }
}

export function markDone(id) {
  try {
    const done = loadProgress();
    done.add(id);
    localStorage.setItem(STORE_KEY, JSON.stringify({ done: [...done] }));
  } catch { /* режим инкогнито и прочее — просто не сохраняем */ }
}

/** Открыта ли миссия: первая всегда, дальше — после предыдущей. */
export function isUnlocked(index, done = loadProgress()) {
  if (index <= 0) return true;
  return done.has(MISSIONS[index - 1].id);
}
