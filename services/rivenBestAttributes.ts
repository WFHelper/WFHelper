/**
 * rivenBestAttributes.ts - Desired riven attributes per weapon category.
 */

import {
  RIVEN_BEST_ATTRIBUTE_SETS,
  type BestAttributes,
} from "../config/shared/rivenBestAttributes";

export type { BestAttributes };

const CATEGORY_MAP: Record<string, BestAttributes> = {
  LongGuns: RIVEN_BEST_ATTRIBUTE_SETS.rifle,
  Pistols: RIVEN_BEST_ATTRIBUTE_SETS.pistol,
  Melee: RIVEN_BEST_ATTRIBUTE_SETS.melee,
  SpaceGuns: RIVEN_BEST_ATTRIBUTE_SETS.archgun,
  SpaceMelee: RIVEN_BEST_ATTRIBUTE_SETS.melee,
  Shotgun: RIVEN_BEST_ATTRIBUTE_SETS.shotgun,
};

export function getBestAttributes(
  weaponCategory: string,
  isShotgun?: boolean,
): BestAttributes {
  if (isShotgun) return RIVEN_BEST_ATTRIBUTE_SETS.shotgun;
  return CATEGORY_MAP[weaponCategory] || RIVEN_BEST_ATTRIBUTE_SETS.fallback;
}
