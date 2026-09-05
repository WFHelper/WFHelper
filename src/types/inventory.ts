import type { MasteryStatus } from "../../config/shared/masteryTypes.js";
export type { MasteryStatus };
export type PartType = "normal" | "prime";

/** A recipe on the path between a part and the build that is really unfinished. */
export interface ClaimNode {
  uniqueName: string;
  name: string;
  status: MasteryStatus | undefined;
}

/** One reason a part is held back from the sellable count. */
export interface RecipeClaim {
  parentUniqueName: string;
  parentName: string;
  /** Copies of this part that recipe still consumes. */
  count: number;
  parentStatus: MasteryStatus | undefined;
  /** Direct parent first, the unfinished build that drives the demand last. */
  chain: ClaimNode[];
}

export interface RecipeIngredient {
  uniqueName: string;
  count: number;
}

export interface RecipeData {
  buildPrice: number;
  buildTime: number;
  num: number;
  blueprintUniqueName?: string;
  reusableBlueprint?: boolean;
  ingredients: RecipeIngredient[];
}

export interface DropInfo {
  location: string;
  rarity?: string;
  chance?: number;
  [key: string]: unknown;
}

export interface ComponentInfo {
  name: string;
  /** Active game language. Render this; `name` stays English for lookups. */
  displayName?: string;
  uniqueName?: string;
  tradable?: boolean;
  itemCount?: number;
  ownedCount?: number;
  owned?: boolean;
  /** Set in the mastery view when this part's blueprint is currently in the foundry. */
  building?: boolean;
  drops?: DropInfo[];
  [key: string]: unknown;
}

export interface ItemDbEntry {
  /** English. Every by-name lookup and market slug is built from this. */
  name?: string;
  /** Active game language, absent when it matches `name`. Render this. */
  displayName?: string;
  /** Art is the framed wiki card, so a marketplace thumbnail must not replace it. */
  cardArt?: true;
  imageUrl?: string | null;
  category?: string;
  productCategory?: string;
  type?: string;
  isPrime?: boolean;
  isBuildComponent?: boolean;
  componentOf?: string;
  masteryReq?: number;
  vaulted?: boolean;
  tradable?: boolean;
  description?: string;
  components?: ComponentInfo[];
  drops?: DropInfo[];
  wikiaUrl?: string | null;
  exalted?: boolean;
  masterable?: boolean;
  ducats?: number | null;
  recipe?: RecipeData;
  /** For blueprint entries: uniqueName of the item this blueprint crafts. */
  buildsProduct?: string;
  /** For blueprint entries: building it does not consume the owned copy. */
  reusableBlueprint?: boolean;
  [key: string]: unknown;
}

export interface RawInventoryEntry {
  ItemType?: string;
  ItemCount?: number;
  XP?: number;
  CompletionDate?: unknown;
  /** Parts fitted to a modular build (kitgun, zaw, amp, K-Drive, Moa). */
  ModularParts?: string[];
  [key: string]: unknown;
}

/** One Archon Shard socket on a Warframe. DE clears both fields in place when a
 *  shard is pulled and pads skipped sockets with `{}`, so an empty socket is an
 *  empty object rather than a gap. */
export interface RawArchonCrystalUpgrade {
  /** `/Lotus/Upgrades/Invigorations/ArchonCrystalUpgrades/...`; `Mythic` suffix = tauforged. */
  UpgradeType?: string;
  /** `ACC_RED`/`ACC_YELLOW`/`ACC_BLUE`/`ACC_GREEN`/`ACC_ORANGE`/`ACC_PURPLE`, `_MYTHIC` = tauforged. */
  Color?: string;
}

export interface RawSuitEntry extends RawInventoryEntry {
  /** Socket array addressed by index; DE sends only up to the highest used socket. */
  ArchonCrystalUpgrades?: RawArchonCrystalUpgrade[];
}

export interface RawInventoryData {
  InventoryJson?: RawInventoryData | string;
  Suits?: RawSuitEntry[];
  LongGuns?: RawInventoryEntry[];
  Pistols?: RawInventoryEntry[];
  Melee?: RawInventoryEntry[];
  Sentinels?: RawInventoryEntry[];
  SentinelWeapons?: RawInventoryEntry[];
  SpaceSuits?: RawInventoryEntry[];
  SpaceGuns?: RawInventoryEntry[];
  SpaceMelee?: RawInventoryEntry[];
  OperatorAmps?: RawInventoryEntry[];
  MechSuits?: RawInventoryEntry[];
  Hoverboards?: RawInventoryEntry[];
  MoaPets?: RawInventoryEntry[];
  KubrowPets?: RawInventoryEntry[];
  /** Stored Genetic Code Templates; one entry per imprint, not a stack. */
  KubrowPetPrints?: RawInventoryEntry[];
  PendingRecipes?: RawInventoryEntry[];
  Recipes?: RawInventoryEntry[];
  MiscItems?: RawInventoryEntry[];
  LevelKeys?: RawInventoryEntry[];
  RawUpgrades?: RawInventoryEntry[];
  Upgrades?: RawInventoryEntry[];
  Arcanes?: RawInventoryEntry[];
  [key: string]: unknown;
}

export type InventoryGroup =
  | "all_parts"
  | "relics"
  | "mods"
  | "arcanes"
  | "full_sets"
  | "incomplete_sets"
  | "equipment"
  | "misc";

export interface ParsedItem {
  /** English. Every by-name lookup and market slug is built from this. */
  name: string;
  /** Active game language, absent when it matches `name`. Render this. */
  displayName?: string;
  /** Art is the framed wiki card, so a marketplace thumbnail must not replace it. */
  cardArt?: true;
  internalName: string;
  category: string;
  categoryLabel: string;
  rank: number;
  maxRank: number;
  imageUrl: string | null;
  isPrime: boolean;
  masteryReq: number;
  vaulted: boolean;
  tradable: boolean;
  description: string;
  components: ComponentInfo[];
  drops: DropInfo[];
  wikiaUrl: string | null;
  status?: MasteryStatus;
  /** Mastery still on the table: what ranking this item to max would add. */
  masteryXpRemaining?: number;
  currentlyOwned?: boolean;
  uniqueName?: string;
  inventoryKey?: string;
  keywords?: string[];
  platinum?: number | null;
  ducats?: number | null;
  amount?: number | null;
  /** Copies across all rank variants of a mod/arcane; rows stay rank-split. */
  combinedAmount?: number | null;
  ducatonator?: number | null;
  /** Copies free to sell once every unfinished recipe above this part is served. */
  sellable?: number;
  reserved?: number;
  claims?: RecipeClaim[];
  completeSets?: number | boolean | null;
  /** Incomplete-set progress: distinct part types still to farm, and owned/total. */
  missingParts?: number | null;
  ownedPartTypes?: number | null;
  totalPartTypes?: number | null;
  orderPlaced?: boolean;
  partType?: PartType;
  /** Fitted part names of a built modular item, resolved for display. */
  modularParts?: string[];
  inventoryGroup?: InventoryGroup;
  favorite?: boolean;
  equipped?: boolean;
  equippedIn?: string[];
  leveledUp?: boolean;
  debugReason?: string;
  [key: string]: unknown;
}

export interface FoundryBuildingItem {
  name: string;
  displayName?: string;
  imageUrl: string | null;
  endDate: Date | null;
  /** Blueprint recipe uniqueName (the raw ItemType in PendingRecipes). */
  uniqueName: string | null;
  /** Resolved product uniqueName (the thing being built), if the recipe could be mapped. */
  productUniqueName: string | null;
  /** Product category (e.g. "Warframes", "Primary", "Gear"). "" when unresolved. */
  category: string;
  /** Ingredient list + build cost from the product's recipe. Empty when no recipe. */
  ingredients: RecipeIngredient[];
  buildPrice: number;
}

export interface FoundryRecipeItem {
  name: string;
  displayName?: string;
  imageUrl: string | null;
  count: number;
  /** Blueprint recipe uniqueName (the raw ItemType in Recipes). */
  uniqueName: string | null;
  /** Resolved product uniqueName (the thing this blueprint builds), if mapped. */
  productUniqueName: string | null;
  /** True when the product is used as an ingredient in some other recipe. */
  isIngredient: boolean;
  /** Product category (e.g. "Warframes", "Primary", "Gear"). "" when unresolved. */
  category: string;
  /** Ingredient list + build cost from the product's recipe. Empty when no recipe. */
  ingredients: RecipeIngredient[];
  buildPrice: number;
  buildTime: number;
}

export interface FoundryData {
  building: FoundryBuildingItem[];
  recipes: FoundryRecipeItem[];
}

export interface Resource {
  name: string;
  displayName?: string;
  imageUrl: string | null;
  internalName: string;
  count: number;
}

export interface MasteryCategoryStats {
  total: number;
  mastered: number;
  inProgress: number;
  missing: number;
}

interface ProfileMastery {
  rank: number;
  percentToNext: number | null;
  totalXp?: number | null;
  xpIntoRank?: number | null;
  xpForNext?: number | null;
  testReady?: boolean;
}

export interface ProgressPair {
  done: number;
  total: number;
}

/** Star chart + intrinsic completion; display only, never part of the XP total. */
interface AccountCompletion {
  starChart: {
    normal: ProgressPair;
    junctions: ProgressPair;
    steelPath: ProgressPair;
    steelPathJunctions: ProgressPair;
  };
  intrinsics: { railjack: ProgressPair; drifter: ProgressPair };
}

interface MasteryStats {
  total: number;
  mastered: number;
  inProgress: number;
  missing: number;
  byCategory: Record<string, MasteryCategoryStats>;
  profileMastery?: ProfileMastery | null;
  completion?: AccountCompletion | null;
}

export interface MasteryData {
  items: ParsedItem[];
  stats: MasteryStats;
}
