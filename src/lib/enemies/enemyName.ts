/** Split out of enemyInfo so the enemy panel can key its lookups without pulling
 *  that module's ~800 KB codex table into the always-loaded bundle. */
export function normalizeEnemyName(name: string): string {
  return name.trim().toLowerCase();
}
