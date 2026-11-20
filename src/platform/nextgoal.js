import { nextGoal } from '../core/nextgoal.js';
import { dailyState } from './daily.js';
import { skinState, allSkinsOwned } from './skins.js';
import { levelState } from './levels.js';
import { achState } from './achievements.js';

/** Ближайшая цель игрока сейчас — из того, что лежит на устройстве. */
export function currentGoal() {
  try {
    return nextGoal({
      daily: dailyState(), boxes: skinState().boxes, allSkins: allSkinsOwned(),
      level: levelState(), ach: achState().list,
    });
  } catch {
    return null;
  }
}
