import type { MasteryStatus } from "../../config/shared/masteryTypes.js";
export type { MasteryStatus };
export type PartType = "normal" | "prime";

export interface RecipeIngredient {
  uniqueName: string;
  count: number;
}

export interface RecipeData {
  buildPrice: number;
  buildTime: number;
  num: number;
  blueprintUniqueName?: string;
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
  uniqueName?: string;
  tradable?: boolean;
  itemCount?: number;
  ownedCount?: number;
  owned?: boolean;
  drops?: DropInfo[];
  [key: string]: unknown;
}

export interface ItemDbEntry {
  name?: string;
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
  ducats?: number | null;
  recipe?: RecipeData;
  [key: string]: unknown;
}

export interface RawInventoryEntry {
  ItemType?: string;
  ItemCount?: number;
  XP?: number;
  CompletionDate?: unknown;
  [key: string]: unknown;
}

export interface RawInventoryData {
  InventoryJson?: RawInventoryData | string;
  Suits?: RawInventoryEntry[];
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
  PendingRecipes?: RawInventoryEntry[];
  Recipes?: RawInventoryEntry[];
  MiscItems?: RawInventoryEntry[];
  LevelKeys?: RawInventoryEntry[];
  RawUpgrades?: RawInventoryEntry[];
  Upgrades?: RawInventoryEntry[];
  Arcanes?: RawInventoryEntry[];
  [key: string]: unknown;
}

export type InventoryGroup = "all_parts" | "relics" | "mods" | "arcanes" | "full_sets" | "misc";

export interface ParsedItem {
  name: string;
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
  currentlyOwned?: boolean;
  uniqueName?: string;
  inventoryKey?: string;
  keywords?: string[];
  platinum?: number | null;
  ducats?: number | null;
  amount?: number | null;
  ducatonator?: number | null;
  completeSets?: number | boolean | null;
  orderPlaced?: boolean;
  partType?: PartType;
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
}

interface MasteryStats {
  total: number;
  mastered: number;
  inProgress: number;
  missing: number;
  byCategory: Record<string, MasteryCategoryStats>;
  profileMastery?: ProfileMastery | null;
}

export interface MasteryData {
  items: ParsedItem[];
  stats: MasteryStats;
}
