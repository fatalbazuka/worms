import {
  Weapon, ClusterWeapon, PlacedWeapon, InstantWeapon, BatWeapon, MineWeapon,
  AirstrikeWeapon, TeleportWeapon, SpringWeapon,
} from './Weapon.js';

/**
 * Реестр оружия. Порядок = порядок кнопок в HUD и клавиш 1..N.
 * Добавить новое оружие = дописать сюда объект.
 *
 * spriteKey — спрайтшит снаряда, iconKey — иконка для панели.
 * rotational: true означает, что кадры спрайтшита это 32 предрассчитанных
 * поворота (кадр выбирается по направлению полёта), иначе кадры крутятся
 * как обычная анимация — снаряд кувыркается.
 */

const BOMBLET = new Weapon({
  id: 'bomblet',
  name: 'Бомблет',
  icon: '·',
  color: 0xffc36b,
  spriteKey: 'proj_bomblet',
  projectile: { radius: 3, windScale: 0.6, trail: false },
  explosion: { radius: 22, damageRadius: 40, damage: 18, knockback: 190, shake: 0.003 },
});

/** Осколок мортиры: мельче кассетного, но их больше и летят они вниз. */
const SHARD = new Weapon({
  id: 'shard',
  name: 'Осколок',
  icon: '·',
  color: 0xffd39b,
  spriteKey: 'proj_bomblet',
  projectile: { radius: 3, windScale: 0.4, trail: false },
  explosion: { radius: 18, damageRadius: 34, damage: 14, knockback: 150, shake: 0.002 },
});

/** Осколок сплит-ракеты: одна из трёх после тапа в полёте. */
const SPLITLET = new Weapon({
  id: 'splitlet',
  name: 'Осколок ракеты',
  icon: '·',
  color: 0x9fd2ff,
  spriteKey: 'proj_mortar',
  projectile: { radius: 4, windScale: 0.6, trail: true },
  explosion: { radius: 28, damageRadius: 52, damage: 26, knockback: 220, shake: 0.004 },
});

/** Ракета авиаудара: падает почти отвесно, ветер её едва сносит. */
const AIR_MISSILE = new Weapon({
  id: 'airmissile',
  name: 'Ракета',
  icon: '·',
  color: 0x9fd2ff,
  spriteKey: 'proj_airmissile',
  rotational: true,
  projectile: { radius: 4, windScale: 0.2, gravityScale: 0.6 },
  // Отброс небольшой: иначе первая ракета выносила бойца из-под остальных
  // четырёх, и залп «эпика» бил слабее одной базуки
  explosion: { radius: 30, damageRadius: 58, damage: 30, knockback: 150, shake: 0.005 },
});

export const WEAPONS = [
  new Weapon({
    id: 'bazooka',
    rarity: 'common',    name: 'Базука',
    icon: '➶',
    color: 0xffe066,
    spriteKey: 'proj_bazooka',
    iconKey: 'icon_bazooka',
    rotational: true,
    startAmmo: null,                       // базука всегда есть
    projectile: { radius: 5, windScale: 1, gravityScale: 1 },
    explosion: { radius: 40, damageRadius: 72, damage: 45, knockback: 300, shake: 0.006 },
  }),

  new Weapon({
    id: 'grenade',
    rarity: 'common',    name: 'Граната',
    icon: '◕',
    color: 0x8ee06a,
    spriteKey: 'proj_grenade',
    iconKey: 'icon_grenade',
    startAmmo: 3,
    projectile: {
      radius: 5, windScale: 0.35, bounciness: 0.45, friction: 0.72, fuse: 3,
    },
    explosion: { radius: 46, damageRadius: 80, damage: 50, knockback: 340, shake: 0.007 },
  }),

  new ClusterWeapon({
    id: 'cluster',
    rarity: 'common',    name: 'Кассета',
    icon: '❋',
    color: 0xff8ad4,
    spriteKey: 'proj_cluster',
    iconKey: 'icon_cluster',
    startAmmo: 1,
    projectile: { radius: 6, windScale: 0.8 },
    explosion: { radius: 26, damageRadius: 46, damage: 22, knockback: 180, shake: 0.004 },
    clusterCount: 5,
    clusterSpeed: 250,
    bombletWeapon: BOMBLET,
  }),

  new Weapon({
    id: 'mole',
    rarity: 'rare',    name: 'Крот',
    icon: '⇩',
    color: 0xc0c8d8,
    spriteKey: 'proj_mole',
    iconKey: 'icon_mole',
    startAmmo: 0,
    projectile: {
      radius: 6, windScale: 0.15, gravityScale: 1.15,
      digRadius: 9, digTime: 0.55,
    },
    explosion: { radius: 52, damageRadius: 78, damage: 40, knockback: 260, shake: 0.008 },
  }),

  // Банан прыгуч до неприличия: попасть им — вопрос чтения рельефа,
  // зато прилетает больно.
  new Weapon({
    id: 'banana',
    rarity: 'rare',    name: 'Попрыгунчик',
    icon: '⌒',
    color: 0xf7e14a,
    spriteKey: 'proj_banana',
    iconKey: 'icon_banana',
    startAmmo: 0,
    crateAmmo: 1,
    // Резиновый: от стен и потолков отскакивает почти без потерь, рвётся,
    // коснувшись бойца, или на пятом отскоке
    projectile: {
      radius: 5, windScale: 0.3, bounciness: 0.95, friction: 0.97, maxBounces: 5,
    },
    explosion: { radius: 46, damageRadius: 84, damage: 55, knockback: 420, shake: 0.009 },
  }),

  // Святая граната: три секунды ожидания и очень большая воронка.
  // Дорогая по патронам намеренно — это оружие «на один раз».
  new Weapon({
    id: 'holy',
    rarity: 'legendary',    name: 'Святая',
    icon: '✚',
    color: 0xffe9a8,
    spriteKey: 'proj_holy',
    iconKey: 'icon_holy',
    startAmmo: 0,
    crateAmmo: 1,
    projectile: {
      radius: 7, windScale: 0.3, bounciness: 0.45, friction: 0.7, fuse: 3,
    },
    explosion: { radius: 88, damageRadius: 150, damage: 95, knockback: 620, shake: 0.02 },
  }),

  // Динамит кладётся под ноги: сила заряда не важна, важно успеть отойти.
  new PlacedWeapon({
    id: 'dynamite',
    rarity: 'rare',    name: 'Динамит',
    icon: '❚',
    color: 0xff6b4a,
    spriteKey: 'proj_dynamite',
    iconKey: 'icon_dynamite',
    category: 'снаряжение',
    startAmmo: 0,
    retreat: 5,
    projectile: {
      radius: 6, windScale: 0, drag: 4, fuse: 4, trail: false,
    },
    explosion: { radius: 72, damageRadius: 120, damage: 85, knockback: 520, shake: 0.016 },
  }),

  // Мортира бьёт слабее базуки, но осыпает осколками сверху — хороша
  // против тех, кто прячется за холмом.
  // Сплит-ракета: летит как базука, тап по экрану в полёте — делится на
  // три веером по курсу. Не тапнул — рвётся при ударе одна.
  new Weapon({
    id: 'mortar',
    name: 'Сплит-ракета',
    icon: '◭',
    color: 0x9fd2ff,
    spriteKey: 'proj_mortar',
    iconKey: 'icon_mortar',
    rarity: 'rare',
    startAmmo: 0,
    crateAmmo: 2,
    projectile: { radius: 5, windScale: 0.8, gravityScale: 1, split: SPLITLET },
    explosion: { radius: 36, damageRadius: 64, damage: 40, knockback: 280, shake: 0.006 },
  }),

  // Дробовик: два выстрела за ход, попадание считается сразу. Ветер и
  // дальность на него не влияют — это оружие ближней перестрелки.
  new InstantWeapon({
    id: 'shotgun',
    rarity: 'common',    name: 'Дробовик',
    icon: '⋙',
    color: 0xffcf7a,
    iconKey: 'icon_shotgun',
    category: 'стрелковое',
    startAmmo: 2,
    shots: 2,
    range: 700,
    explosion: { radius: 16, damageRadius: 34, damage: 26, knockback: 190, shake: 0.003 },
  }),

  // Мина остаётся лежать между ходами — единственное оружие, которое
  // работает, когда твой ход уже прошёл.
  new MineWeapon({
    id: 'mine',
    rarity: 'rare',    name: 'Магнитная мина',
    icon: '◉',
    color: 0xb04040,
    iconKey: 'icon_mine',
    category: 'снаряжение',
    startAmmo: 0,
    crateAmmo: 2,
    // Бросается рогаткой, где легла — там мина; взвелась — ползёт к врагу
    projectile: { radius: 6, windScale: 0.4, deploy: 'mine' },
    explosion: { radius: 46, damageRadius: 84, damage: 50, knockback: 380, shake: 0.008 },
  }),

  // Бита: земля цела, зато сосед летит. Дешёвый способ утопить.
  new BatWeapon({
    id: 'bat',
    rarity: 'common',    name: 'Бита',
    icon: '↷',
    color: 0xc98b5a,
    iconKey: 'icon_bat',
    category: 'ближний бой',
    startAmmo: 1,
    range: 60,
    explosion: { radius: 0, damageRadius: 46, damage: 24, knockback: 700, shake: 0.004 },
  }),

  // Авиаудар: пять ракет почти отвесно на точку прицела. На широкой карте
  // сторона — куда смотрит ствол, дальность — сила заряда; на башне точка —
  // куда показывает прицел, этажи выше ракеты пролетают (AirstrikeWeapon).
  new AirstrikeWeapon({
    id: 'airstrike',
    rarity: 'epic',    name: 'Авиаудар',
    icon: '✈',
    color: 0x9fd2ff,
    iconKey: 'icon_airstrike',
    category: 'авиация',
    startAmmo: 0,
    crateAmmo: 1,
    reach: 1500,
    missiles: 5,
    spacing: 28,
    missileWeapon: AIR_MISSILE,
  }),

  // Телепорт: туда, куда смотрит ствол, на расстояние по силе заряда.
  // Уйти из-под обстрела, забраться на скалу, встать за спину — и ход
  // на этом кончается.
  new TeleportWeapon({
    id: 'teleport',
    rarity: 'rare',    name: 'Телепорт',
    icon: '◌',
    color: 0x9fd2ff,
    iconKey: 'icon_teleport',
    category: 'снаряжение',
    startAmmo: 0,
    crateAmmo: 1,
    reach: 900,
    explosion: { radius: 0, damageRadius: 0, damage: 0, knockback: 0, shake: 0 },
  }),
];

// --- Оружие башни: всё про этажи ---

// Гиря: тяжёлая, ветер её не сносит. Первый пол, на который упадёт,
// проламывает насквозь и рвётся этажом ниже — на того, кто под ним прятался.
WEAPONS.push(new Weapon({
  id: 'weight',
    rarity: 'epic',  name: 'Гиря',
  icon: '⚖',
  color: 0x9aa0ac,
  spriteKey: 'shot_weight',
  startAmmo: 0,
  crateAmmo: 1,
  projectile: { radius: 7, windScale: 0, gravityScale: 1.5, pierce: 64, trail: false },
  explosion: { radius: 36, damageRadius: 66, damage: 50, knockback: 280, shake: 0.009 },
}));

// Липкая бомба: прилипает к первой поверхности — стене, потолку, полу — и
// рвётся через три секунды. Можно заминировать уступ над чужой головой.
WEAPONS.push(new Weapon({
  id: 'sticky',
    rarity: 'rare',  name: 'Липучка',
  icon: '◍',
  color: 0x7ed650,
  spriteKey: 'shot_sticky',
  startAmmo: 0,
  crateAmmo: 2,
  projectile: { radius: 6, windScale: 0.5, sticky: true, stickFuse: 3 },
  explosion: { radius: 42, damageRadius: 76, damage: 46, knockback: 320, shake: 0.007 },
}));

// Батут: пружина на полу. Свой — лифт на этаж выше, чужой — ловушка.
WEAPONS.push(new SpringWeapon({
  id: 'spring',
    rarity: 'rare',  name: 'Батут',
  icon: '⇞',
  color: 0xec4848,
  category: 'снаряжение',
  startAmmo: 0,
  crateAmmo: 1,
  retreat: 5,
  explosion: { radius: 0, damageRadius: 0, damage: 0, knockback: 0, shake: 0 },
}));

// Бумеранг: летит по прицелу, тормозит и возвращается. Бьёт каждого на пути
// туда и обратно — достаёт того, кто спрятался за углом. Стена его ловит.
WEAPONS.push(new Weapon({
  id: 'boomerang',
  name: 'Бумеранг',
  icon: '⟲',
  color: 0xd99a4e,
  category: 'стрелковое',
  rarity: 'epic',
  startAmmo: 0,
  crateAmmo: 2,
  projectile: { radius: 6, windScale: 0.15, gravityScale: 0, boomerang: 900, hitDamage: 28 },
  explosion: { radius: 0, damageRadius: 0, damage: 0, knockback: 0, shake: 0 },
}));

// Самонаводка: первые полсекунды летит по прицелу, потом сама доворачивает
// к ближайшему врагу. Сильная, но стены и потолки её всё равно ловят.
WEAPONS.push(new Weapon({
  id: 'homing',
  name: 'Самонаводка',
  icon: '➹',
  color: 0xff7a5a,
  rarity: 'epic',
  startAmmo: 0,
  crateAmmo: 1,
  projectile: { radius: 5, windScale: 0.6, homing: 3.0, homeDelay: 0.6 },
  explosion: { radius: 40, damageRadius: 72, damage: 45, knockback: 300, shake: 0.007 },
}));

// ---------------------------------------------------------- новые стволы
// Добавляются только в конец: номер оружия едет в ходах по сети и в
// истории дуэлей, сдвинуть старые — значит сломать начатые партии.

/** Пчела: летит к ближайшему сопернику и жалит — немного, но их рой. */
const BEE = new Weapon({
  id: 'bee',
  name: 'Пчела',
  icon: '🐝',
  emojiIcon: '🐝',
  shotKey: 'emoji_bee',
  color: 0xffd23f,
  projectile: { radius: 3, windScale: 0.15, gravityScale: 0.35, homing: 4.2, homeDelay: 0.25, homeSpeed: 240, trail: false },
  explosion: { radius: 7, damageRadius: 26, damage: 9, knockback: 70, shake: 0.002 },
});

// Пчёлы: улей разбивается — и шесть пчёл сами летят к соперникам рядом.
// За укрытием не спрятаться, но каждая жалит слабо: хорошо добивать.
WEAPONS.push(new ClusterWeapon({
  id: 'bees',
  rarity: 'rare', name: 'Пчёлы',
  icon: '🐝',
  emojiIcon: '🍯',
  iconKey: 'emoji_honey', shotKey: 'emoji_honey',
  color: 0xffc23a,
  startAmmo: 0,
  crateAmmo: 1,
  projectile: { radius: 6, windScale: 0.7 },
  explosion: { radius: 14, damageRadius: 30, damage: 8, knockback: 90, shake: 0.003 },
  clusterCount: 6,
  clusterSpeed: 230,
  bombletWeapon: BEE,
}));

// Бур: падает и прошивает до трёх перекрытий насквозь, взрывается ниже.
// Достать того, кто засел под потолком этажом ниже.
WEAPONS.push(new Weapon({
  id: 'drill',
  rarity: 'epic', name: 'Бур',
  icon: '⛏',
  emojiIcon: '🔩',
  iconKey: 'emoji_nutbolt', shotKey: 'emoji_nutbolt',
  color: 0xb9c2d0,
  startAmmo: 0,
  crateAmmo: 1,
  projectile: { radius: 6, windScale: 0.1, gravityScale: 1.3, pierce: 44, pierceTimes: 3, trail: false },
  explosion: { radius: 40, damageRadius: 68, damage: 44, knockback: 260, shake: 0.008 },
}));

// Магнит: не взрывает землю, а тянет бойцов к точке падения. Попал над
// краем этажа — соперник сам съезжает вниз, в воду или под удар.
WEAPONS.push(new Weapon({
  id: 'magnet',
  rarity: 'rare', name: 'Магнит',
  icon: '🧲',
  emojiIcon: '🧲',
  iconKey: 'emoji_magnet', shotKey: 'emoji_magnet',
  color: 0xff5a6e,
  startAmmo: 0,
  crateAmmo: 1,
  projectile: { radius: 6, windScale: 0.6 },
  explosion: { radius: 0, damageRadius: 150, damage: 6, knockback: -520, pull: true, shake: 0.004 },
}));

export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export { BOMBLET, AIR_MISSILE, SPLITLET, BEE };

/** Редкость оружия: шанс в ящике (%), цвет ящика и надписи. */
export const WEAPON_RARITY = {
  common: { name: 'обычное', odds: 52, color: 0xd9c7a3, text: '#e8dcc5' },
  rare: { name: 'редкое', odds: 30, color: 0x6fb7ff, text: '#8cc8ff' },
  epic: { name: 'эпическое', odds: 14, color: 0xc58bff, text: '#d3a8ff' },
  legendary: { name: 'легендарное', odds: 4, color: 0xffc23a, text: '#ffd166' },
};
