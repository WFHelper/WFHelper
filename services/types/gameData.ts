/**
 * Typed interfaces for external game data packages:
 * - warframe-public-export-plus (raw DE data)
 * - @wfcd/items (curated community data)
 *
 * These cover the fields actually accessed in itemDatabase.ts,
 * worldStateParser.ts, and masteryHelper.ts.
 */


/** A single item from any PEP Export* record. */
export interface PepExportItem {
  name: string;
  description?: string;
  resultType?: string;
  icon?: string;
  masteryReq?: number;
  primeSellingPrice?: number;
  tradable?: boolean;
  vaulted?: boolean;
  productCategory?: string;
  era?: string;
  category?: string;
}

interface RecipeIngredient {
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

export interface DropEntry {
  location: string;
  type: string;
  chance: number;
  rarity: string;
}

export interface ComponentEntry {
  uniqueName: string;
  name: string;
  imageName?: string;
  tradable?: boolean;
  ducats?: number;
  itemCount?: number;
  drops?: DropEntry[];
}

/** Renderer-facing subset of ItemEntry sent via IPC. */
export interface RendererItemEntry {
  name: string;
  category: string;
  imageUrl: string | null;
  isPrime: boolean;
  tradable?: boolean;
  masteryReq: number;
  vaulted: boolean;
  exalted?: boolean;
  masterable?: boolean;
  type: string;
  isBuildComponent: boolean;
  componentOf?: string;
  description: string;
  productCategory: string | null;
  ducats: number | null;
  components: {
    name: string;
    uniqueName: string;
    tradable?: boolean;
    itemCount: number;
    drops: DropEntry[];
  }[];
  drops: DropEntry[];
  wikiaUrl?: string | null;
  recipe?: RecipeData;
}

export interface WorldStateDate {
  $date: { $numberLong: string };
}

interface ActiveMissionRaw {
  Modifier: string;
  MissionType: string;
  Node: string;
  Hard?: boolean;
  Expiry: WorldStateDate;
}

interface VoidTraderRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
  Node: string;
  Manifest?: { ItemType: string; PrimePrice?: number; RegularPrice?: number }[];
}

interface VaultTraderRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
  Node: string;
  Manifest?: { ItemType: string }[];
}

interface SortieRaw {
  Expiry: WorldStateDate;
}

interface SyndicateMissionJobRaw {
  jobType: string;
  rewards: string;
  masteryReq: number;
  minEnemyLevel: number;
  maxEnemyLevel: number;
  xpAmounts: number[];
}

interface SyndicateMissionRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
  Tag: string;
  Seed: number;
  Nodes?: string[];
  Jobs?: SyndicateMissionJobRaw[];
}

interface InvasionCountedItemRaw {
  ItemType: string;
  ItemCount: number;
}

interface InvasionRewardRaw {
  countedItems?: InvasionCountedItemRaw[];
  credits?: number;
}

interface InvasionRaw {
  _id: { $oid: string };
  Faction: string;
  DefenderFaction: string;
  Node: string;
  Count: number;
  Goal: number;
  LocTag: string;
  Completed: boolean;
  AttackerReward?: InvasionRewardRaw;
  DefenderReward?: InvasionRewardRaw;
  Activation?: WorldStateDate;
}

interface VoidStormRaw {
  Node: string;
  ActiveMissionTier: string;
  Activation?: WorldStateDate;
  Expiry: WorldStateDate;
}

export interface WorldStateRaw {
  ActiveMissions?: ActiveMissionRaw[];
  VoidStorms?: VoidStormRaw[];
  VoidTraders?: VoidTraderRaw | VoidTraderRaw[];
  PrimeVaultTraders?: VaultTraderRaw | VaultTraderRaw[];
  Sorties?: SortieRaw | SortieRaw[];
  Descents?: DescentRaw[];
  EndlessXpChoices?: EndlessXpChoice[];
  SyndicateMissions?: SyndicateMissionRaw[];
  Invasions?: InvasionRaw[];
}

interface DescentRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
}

interface EndlessXpChoice {
  Category: string;
  Choices: string[];
}

