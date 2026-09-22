import type { MessageKey } from "../i18n.js";
import type { EnemyInfo } from "./enemyInfo.js";

export const TILE_SET_PLANETS_KEY: MessageKey = "enemy.planetsFromTileSets";

interface EnemySpawnGroup {
  labelKey: MessageKey;
  values: readonly string[];
}

/** The spawn lists a codex entry states, plus the planets derived from its
 *  tilesets, in reading order and without the empty ones. */
export function enemySpawnGroups(
  info: EnemyInfo | null,
  tileSetPlanets: readonly string[],
): EnemySpawnGroup[] {
  if (!info) return [];
  const groups: EnemySpawnGroup[] = [
    { labelKey: "enemy.planets", values: info.planets },
    { labelKey: TILE_SET_PLANETS_KEY, values: tileSetPlanets },
    { labelKey: "enemy.tileSets", values: info.tileSets },
    { labelKey: "enemy.missions", values: info.missions },
  ];
  return groups.filter((group) => group.values.length > 0);
}
