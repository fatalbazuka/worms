import { SPRITE_META } from './sprite-meta.js';
import { BIOMES } from './biomes.js';
import { SKINS } from './skins.js';

/**
 * Манифест спрайтов.
 *
 * Содержимое assets/ собирается из рипов Worms Armageddon скриптом
 * tools/build_assets.py — он же выписывает размеры кадров в sprite-meta.js.
 * Пересобрать: `python3 tools/build_assets.py`.
 *
 * Любого файла может не быть — тогда движок молча рисует цветной
 * плейсхолдер, и игра остаётся играбельной.
 */

/** Одиночные картинки. */
export const IMAGES = {
  grave: 'assets/grave.png',
  crate_weapon: 'assets/crate_weapon.png',
  crate_health: 'assets/crate_health.png',
  crate_chute: 'assets/crate_chute.png',
  worm_chute: 'assets/worm_chute.png',
  crosshair_0: 'assets/crosshair_0.png',
  crosshair_1: 'assets/crosshair_1.png',
  icon_bazooka: 'assets/icon_bazooka.png',
  icon_grenade: 'assets/icon_grenade.png',
  icon_cluster: 'assets/icon_cluster.png',
  icon_mole: 'assets/icon_mole.png',
  icon_banana: 'assets/icon_banana.png',
  icon_holy: 'assets/icon_holy.png',
  // Нарисованные фоны мест (tools/build_location_art.py): bg_<вид башни>
  ...Object.fromEntries(['classic', 'ice', 'lava', 'space', 'wind'].map((id) => [`bg_${id}`, `assets/bg/${id}.jpg`])),
  icon_dynamite: 'assets/icon_dynamite.png',
  icon_mine: 'assets/icon_mine.png',
  icon_airstrike: 'assets/icon_airstrike.png',
  icon_shotgun: 'assets/icon_shotgun.png',
  icon_bat: 'assets/icon_bat.png',
  icon_teleport: 'assets/icon_teleport.png',
  icon_mortar: 'assets/icon_mortar.png',
};

/**
 * Своё оружие и предметы (tools/build_items.py): по картинке на штуку.
 * hand_<id> — оружие в перчатке: значок арсенала и то, что боец держит;
 * shot_<id> — снаряд в полёте, мина, ящик, парашют, крюк. Где своей
 * картинки нет, остаётся прежняя.
 */
const HANDS = ['bazooka', 'grenade', 'cluster', 'mole', 'banana', 'holy', 'dynamite', 'mine',
  'airstrike', 'shotgun', 'bat', 'teleport', 'mortar', 'hook', 'weight', 'sticky', 'spring'];
const SHOTS = ['bazooka', 'grenade', 'cluster', 'bomblet', 'mole', 'banana', 'holy', 'dynamite',
  'mine', 'mine_on', 'mortar', 'airmissile', 'crate_weapon', 'crate_health', 'chute', 'hook',
  'weight', 'sticky', 'spring', 'rock', 'snowball', 'fireball'];
for (const id of HANDS) IMAGES[`hand_${id}`] = `assets/items/hand_${id}.png`;
for (const id of SHOTS) IMAGES[`shot_${id}`] = `assets/items/shot_${id}.png`;
// Монстры «Подъёма» (tools/build_tower_sheet.py): слизень, кактус, тролль-Великан в трёх позах
for (const id of ['mon_slime', 'mon_cactus', 'mon_boss', 'mon_boss_throw', 'mon_boss_down',
  'mon_yeti', 'mon_yeti_throw', 'mon_yeti_down', 'mon_golem', 'mon_golem_throw', 'mon_golem_down',
  // эффекты аффиксов (лист affixes_sheet.png)
  'fx_vent1', 'fx_vent2', 'fx_geyser', 'fx_icicles', 'fx_shatter', 'fx_bolt', 'fx_impact', 'fx_vortex']) {
  IMAGES[id] = `assets/items/${id}.png`;
}

/**
 * Эмодзи как графика: декор башни, разрушаемые предметы, монстры.
 * Картинки — Twemoji (CC-BY 4.0, см. README), SVG; грузятся растром
 * 128×128 под ключом emoji_<имя>.
 */
export const EMOJI = ['pine', 'tree', 'palm', 'mushroom', 'rock', 'barrel', 'cactus', 'ogre',
  'slime', 'cloud', 'sun', 'mountain', 'herb', 'sunflower', 'bricks', 'box', 'volcano', 'ice',
  'snowflake', 'fire', 'snowman', 'blossom', 'headstone', 'skull', 'crown',
  'planet', 'rocket', 'satellite', 'moon', 'star', 'comet', 'ufo', 'gem',
  // аффиксы: оживлённые эмодзи (entities/Affixes.js)
  'dash', 'warning', 'boom', 'windface', 'storm', 'zap', 'cyclone', 'sparkles'];

/** Текстуры ландшафта: по четыре файла на каждую тему из biomes.js. */
for (const b of BIOMES) {
  IMAGES[`${b.id}_soil`] = `assets/terrain/${b.id}/soil.png`;
  IMAGES[`${b.id}_grass`] = `assets/terrain/${b.id}/grass.png`;
  IMAGES[`${b.id}_back`] = `assets/terrain/${b.id}/back.png`;
  IMAGES[`${b.id}_sky`] = `assets/terrain/${b.id}/sky.png`;
}

/**
 * Спрайтшиты: горизонтальные ленты кадров. Размер кадра берётся из
 * sprite-meta.js, число кадров Phaser определяет сам.
 *
 * `anims` описывает анимации, которые надо создать при загрузке.
 * `rotational: true` означает, что кадры — это не анимация, а 32
 * предрассчитанных поворота (кадр выбирается по направлению полёта).
 */
/**
 * Анимации листа бойца: у всех скинов одна раскладка кадров, отличается
 * только имя листа — оно же приставка к именам анимаций.
 */
function fighterAnims(sheet) {
  return {
    [`${sheet}_idle`]: { frameRate: 6, repeat: -1, frames: [0, 0, 0, 2, 0, 3, 0, 0, 0, 0, 1, 0, 0, 2, 0, 3] },
    [`${sheet}_walk`]: { frameRate: 12, repeat: -1, frames: [4, 5, 6, 7] },
    [`${sheet}_fall`]: { frameRate: 6, repeat: -1, frames: [6, 9] },
    [`${sheet}_fly`]: { frameRate: 1, repeat: -1, frames: [8] },
    [`${sheet}_hurt`]: { frameRate: 1, repeat: -1, frames: [10] },
    [`${sheet}_dizzy`]: { frameRate: 1, repeat: -1, frames: [11] },
    [`${sheet}_aim`]: { frameRate: 1, repeat: -1, frames: [12] },
    [`${sheet}_win`]: { frameRate: 5, repeat: -1, frames: [13, 3] },
    [`${sheet}_cry`]: { frameRate: 1, repeat: -1, frames: [14] },
  };
}

export const SHEETS = {
  // Боец-смайлик и его скины: по листу на все позы (tools/build_smiley.py).
  // Если лист загрузился, бойцы рисуются им, а червяки ниже остаются
  // запасными. Анимации — наборы кадров по номерам, а не отрезки подряд.
  ...Object.fromEntries(SKINS.map((s) => [s.sheet, { anims: fighterAnims(s.sheet) }])),
  worm_idle: { anims: { worm_idle: { frameRate: 10, repeat: -1 } } },
  worm_walk: { anims: { worm_walk: { frameRate: 18, repeat: -1 } } },
  worm_fall: { anims: { worm_fall: { frameRate: 8, repeat: -1 } } },

  marker_0: { anims: { marker_0: { frameRate: 12, repeat: -1 } } },
  marker_1: { anims: { marker_1: { frameRate: 12, repeat: -1 } } },

  proj_bazooka: { rotational: true },
  proj_grenade: { anims: { proj_grenade: { frameRate: 24, repeat: -1 } } },
  proj_cluster: { anims: { proj_cluster: { frameRate: 24, repeat: -1 } } },
  proj_bomblet: { anims: { proj_bomblet: { frameRate: 16, repeat: -1 } } },
  proj_mole: { anims: { proj_mole: { frameRate: 16, repeat: -1 } } },
  proj_banana: { anims: { proj_banana: { frameRate: 24, repeat: -1 } } },
  proj_holy: { anims: { proj_holy: { frameRate: 20, repeat: -1 } } },
  proj_dynamite: { anims: { proj_dynamite: { frameRate: 14, repeat: -1 } } },
  proj_mortar: { anims: { proj_mortar: { frameRate: 24, repeat: -1 } } },
  proj_airmissile: { rotational: true },
  // Мина: два состояния, не анимация — спокойная и заведённая
  proj_mine: {},
  proj_mine_on: { anims: { proj_mine_on: { frameRate: 12, repeat: -1 } } },

  fx_flash: {},
  fx_smoke: { anims: { fx_smoke: { frameRate: 30, repeat: 0 } } },
};

/** Число предрассчитанных поворотов у снарядов с rotational: true. */
export const ROT_FRAMES = 32;
/**
 * Кадр 7 смотрит вправо, дальше кадры идут по часовой стрелке с шагом
 * 360/32 градуса. Проверено по центроиду носа ракеты в tools.
 */
export const ROT_ZERO_FRAME = 7;

/** Ключи, которые не удалось загрузить. Заполняется в BootScene. */
export const missing = new Set();

export function has(scene, key) {
  return !missing.has(key) && scene.textures.exists(key);
}

/**
 * Размеры листов, которые собирает не build_assets.py (он пишет
 * sprite-meta.js), а отдельный скрипт. scale — во сколько раз кадр
 * уменьшается на экране, originY — где в кадре линия ног, ghost — кадр
 * призрака.
 */
const FIGHTER_META = { frameWidth: 100, frameHeight: 100, frames: 16, originY: 0.92, scale: 0.52, ghost: 15 };
const EXTRA_META = Object.fromEntries(SKINS.map((s) => [s.sheet, FIGHTER_META]));

export function meta(key) {
  return SPRITE_META[key] ?? EXTRA_META[key] ?? null;
}

/** Масштаб, при котором картинка вписывается в квадрат box. */
export function fitScale(scene, key, box) {
  const src = scene.textures.get(key).getSourceImage();
  return box / Math.max(src.width, src.height, 1);
}

/** Значок оружия: свой, если загрузился, иначе прежний; null — картинки нет. */
export function weaponIcon(scene, weapon) {
  const own = `hand_${weapon.id}`;
  if (has(scene, own)) return own;
  return has(scene, weapon.iconKey) ? weapon.iconKey : null;
}

/** Оружие, которое в руках смотрит стволом на цель; остальное просто держат. */
export const AIMED = new Set(['bazooka', 'mole', 'shotgun', 'bat']);

/** Индекс предрассчитанного поворота для направления (vx, vy). */
export function rotFrame(vx, vy) {
  const a = Math.atan2(-vy, vx);                       // угол в «математической» системе
  const step = (Math.PI * 2) / ROT_FRAMES;
  let f = Math.round(ROT_ZERO_FRAME - a / step) % ROT_FRAMES;
  if (f < 0) f += ROT_FRAMES;
  return f;
}
