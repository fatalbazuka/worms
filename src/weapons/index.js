import {
  Weapon, ClusterWeapon, PlacedWeapon, InstantWeapon, BatWeapon, MineWeapon,
  AirstrikeWeapon, TeleportWeapon,
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

/** Ракета авиаудара: падает почти отвесно, ветер её едва сносит. */
const AIR_MISSILE = new Weapon({
  id: 'airmissile',
  name: 'Ракета',
  icon: '·',
  color: 0x9fd2ff,
  spriteKey: 'proj_airmissile',
  rotational: true,
  projectile: { radius: 4, windScale: 0.2, gravityScale: 0.6 },
  explosion: { radius: 30, damageRadius: 56, damage: 26, knockback: 240, shake: 0.005 },
});

export const WEAPONS = [
  new Weapon({
    id: 'bazooka',
    name: 'Базука',
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
    name: 'Граната',
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
    name: 'Кассета',
    icon: '❋',
    color: 0xff8ad4,
    spriteKey: 'proj_cluster',
    iconKey: 'icon_cluster',
    startAmmo: 2,
    projectile: { radius: 6, windScale: 0.8 },
    explosion: { radius: 26, damageRadius: 46, damage: 22, knockback: 180, shake: 0.004 },
    clusterCount: 5,
    clusterSpeed: 250,
    bombletWeapon: BOMBLET,
  }),

  new Weapon({
    id: 'mole',
    name: 'Крот',
    icon: '⇩',
    color: 0xc0c8d8,
    spriteKey: 'proj_mole',
    iconKey: 'icon_mole',
    startAmmo: 1,
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
    name: 'Банан',
    icon: '⌒',
    color: 0xf7e14a,
    spriteKey: 'proj_banana',
    iconKey: 'icon_banana',
    startAmmo: 1,
    crateAmmo: 1,
    projectile: {
      radius: 5, windScale: 0.4, bounciness: 0.72, friction: 0.86, fuse: 4,
    },
    explosion: { radius: 58, damageRadius: 105, damage: 72, knockback: 470, shake: 0.011 },
  }),

  // Святая граната: три секунды ожидания и очень большая воронка.
  // Дорогая по патронам намеренно — это оружие «на один раз».
  new Weapon({
    id: 'holy',
    name: 'Святая',
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
    name: 'Динамит',
    icon: '❚',
    color: 0xff6b4a,
    spriteKey: 'proj_dynamite',
    iconKey: 'icon_dynamite',
    category: 'снаряжение',
    startAmmo: 1,
    retreat: 5,
    projectile: {
      radius: 6, windScale: 0, drag: 4, fuse: 4, trail: false,
    },
    explosion: { radius: 72, damageRadius: 120, damage: 85, knockback: 520, shake: 0.016 },
  }),

  // Мортира бьёт слабее базуки, но осыпает осколками сверху — хороша
  // против тех, кто прячется за холмом.
  new ClusterWeapon({
    id: 'mortar',
    name: 'Мортира',
    icon: '◭',
    color: 0x9fd2ff,
    spriteKey: 'proj_mortar',
    iconKey: 'icon_mortar',
    startAmmo: 2,
    projectile: { radius: 5, windScale: 0.7, gravityScale: 1.1 },
    explosion: { radius: 24, damageRadius: 44, damage: 20, knockback: 170, shake: 0.004 },
    clusterCount: 6,
    clusterSpeed: 200,
    bombletWeapon: SHARD,
  }),

  // Дробовик: два выстрела за ход, попадание считается сразу. Ветер и
  // дальность на него не влияют — это оружие ближней перестрелки.
  new InstantWeapon({
    id: 'shotgun',
    name: 'Дробовик',
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
    name: 'Мина',
    icon: '◉',
    color: 0xb04040,
    iconKey: 'icon_mine',
    category: 'снаряжение',
    startAmmo: 2,
    retreat: 5,
    explosion: { radius: 46, damageRadius: 84, damage: 50, knockback: 380, shake: 0.008 },
  }),

  // Бита: земля цела, зато сосед летит. Дешёвый способ утопить.
  new BatWeapon({
    id: 'bat',
    name: 'Бита',
    icon: '↷',
    color: 0xc98b5a,
    iconKey: 'icon_bat',
    category: 'ближний бой',
    startAmmo: 1,
    range: 60,
    explosion: { radius: 0, damageRadius: 46, damage: 24, knockback: 700, shake: 0.004 },
  }),

  // Авиаудар: пять ракет почти отвесно на точку впереди. Сторона — куда
  // смотрит ствол, дальность — сила заряда. За холмом от него не укрыться.
  new AirstrikeWeapon({
    id: 'airstrike',
    name: 'Авиаудар',
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
    name: 'Телепорт',
    icon: '◌',
    color: 0x9fd2ff,
    iconKey: 'icon_teleport',
    category: 'снаряжение',
    startAmmo: 1,
    crateAmmo: 1,
    reach: 900,
    explosion: { radius: 0, damageRadius: 0, damage: 0, knockback: 0, shake: 0 },
  }),
];

export const WEAPONS_BY_ID = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export { BOMBLET, AIR_MISSILE };
