export interface DropInfo {
  location: string;
  rarity?: string;
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
  status?: "mastered" | "progress" | "missing";
  currentlyOwned?: boolean;
  uniqueName?: string;
  keywords?: string[];
  platinum?: number | null;
  ducats?: number | null;
  amount?: number | null;
  ducatonator?: number | null;
  completeSets?: number | boolean | null;
  orderPlaced?: boolean;
  partType?: "normal" | "prime";
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
}

export interface FoundryRecipeItem {
  name: string;
  imageUrl: string | null;
  count: number;
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

export interface ProfileMastery {
  rank: number;
  percentToNext: number | null;
}

export interface MasteryStats {
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
