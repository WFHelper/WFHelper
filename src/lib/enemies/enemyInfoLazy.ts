import type * as EnemyInfo from "./enemyInfo.js";

/** Shares the ~800 KB codex table's chunk with codexScansLazy, so the enemy
 *  panel only pulls it once something opens the panel. */
export function loadEnemyInfo(): Promise<typeof EnemyInfo> {
  return import("./enemyInfo.js");
}
