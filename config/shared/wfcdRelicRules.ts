/** Rules the backend's /v1/wfcd-relics route and the app's reader both enforce. */

// @wfcd/items 1.1276.6 has 3,196 rows that pass these rules.
const WFCD_RELIC_MIN_ROWS = 2_500;
const WFCD_RELIC_MAX_ROWS = 10_000;
const WFCD_RELIC_MAX_REWARDS = 12;
export const WFCD_RELIC_MAX_STRING = 256;
// 1.1276.6: 608 distinct reward names, the longest 36 characters. Both bound the reward
// matcher, which runs on the main process for every reward screen.
const MAX_REWARD_NAMES = 2_000;
const MAX_REWARD_NAME_LENGTH = 64;
// The trimmed 1.1276.6 document is 4.9 MB.
export const WFCD_RELICS_MAX_BYTES = 20 * 1024 * 1024;

const RELIC_PATH_PREFIX = "/Lotus/Types/Game/Projections/";
const RELIC_NAME =
  /^(Lith|Meso|Neo|Axi|Requiem|Vanguard) \S+ (Intact|Exceptional|Flawless|Radiant)$/;
const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
const RARITIES = ["Common", "Uncommon", "Rare"] as const;
// Inventory rows and market orders take the refinement from the uniqueName suffix.
const REFINEMENT_SUFFIX: Record<string, string> = {
  Intact: "Bronze",
  Exceptional: "Silver",
  Flawless: "Gold",
  Radiant: "Platinum",
};

export type WfcdRelicRarity = (typeof RARITIES)[number];

export function isBoundedWfcdString(value: unknown): value is string {
  return typeof value === "string" && value.length <= WFCD_RELIC_MAX_STRING;
}

/** A refinement row: a projection path whose suffix matches its `<Tier> <Code> <Quality>` name. */
export function isWfcdRelicIdentity(uniqueName: unknown, name: unknown): boolean {
  if (!isBoundedWfcdString(uniqueName) || !uniqueName.startsWith(RELIC_PATH_PREFIX)) return false;
  const match = isBoundedWfcdString(name) ? RELIC_NAME.exec(name) : null;
  return match !== null && uniqueName.endsWith(REFINEMENT_SUFFIX[match[2]]);
}

export function isWfcdRewardName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REWARD_NAME_LENGTH;
}

export function hasTooManyWfcdRewardNames(
  relics: readonly { rewards: readonly { item?: { name?: string } }[] }[],
): boolean {
  const names = new Set<string>();
  for (const relic of relics) {
    for (const reward of relic.rewards) {
      if (reward.item?.name) names.add(reward.item.name);
    }
    if (names.size > MAX_REWARD_NAMES) return true;
  }
  return false;
}

export function isWfcdRewardCount(count: number): boolean {
  return count >= 1 && count <= WFCD_RELIC_MAX_REWARDS;
}

export function isWfcdRewardChance(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

export function isWfcdRelicRarity(value: unknown): value is WfcdRelicRarity {
  return RARITIES.some((rarity) => rarity === value);
}

export function isWfcdRelicRowCount(count: number): boolean {
  return count >= WFCD_RELIC_MIN_ROWS && count <= WFCD_RELIC_MAX_ROWS;
}

export function isWfcdVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION.test(value);
}

/** A different major is refused, so a far-off version number cannot outrank every later release. */
export function isSameWfcdMajor(a: string, b: string): boolean {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  return left !== null && right !== null && Number(left[1]) === Number(right[1]);
}

/** Numeric `major.minor.patch` order; 0 when either side is not a plain version. */
export function compareWfcdVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}
