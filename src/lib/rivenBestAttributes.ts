/**
 * Best riven attributes per weapon category (renderer-side lookup).
 */

import {
  RIVEN_BEST_ATTRIBUTE_SETS,
  type BestAttributes,
} from "../../config/shared/rivenBestAttributes.js";

export type { BestAttributes };

const TYPE_MAP: Record<string, BestAttributes> = {
  Rifle: RIVEN_BEST_ATTRIBUTE_SETS.rifle,
  Shotgun: RIVEN_BEST_ATTRIBUTE_SETS.shotgun,
  Pistol: RIVEN_BEST_ATTRIBUTE_SETS.pistol,
  Kitgun: RIVEN_BEST_ATTRIBUTE_SETS.pistol,
  Melee: RIVEN_BEST_ATTRIBUTE_SETS.melee,
  Zaw: RIVEN_BEST_ATTRIBUTE_SETS.melee,
  Archgun: RIVEN_BEST_ATTRIBUTE_SETS.archgun,
};

export function getBestAttributes(rivenType: string): BestAttributes {
  return TYPE_MAP[rivenType] ?? RIVEN_BEST_ATTRIBUTE_SETS.rifle;
}
