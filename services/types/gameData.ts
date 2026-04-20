/**
 * Typed interfaces for external game data packages:
 * - warframe-public-export-plus (raw DE data)
 * - @wfcd/items (curated community data)
 *
 * These cover the fields actually accessed in itemDatabase.ts,
 * worldStateParser.ts, and masteryHelper.ts.
 */

// ── warframe-public-export-plus item fields ─────────────────────────────────

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

/** Region entry from ExportRegions. */
export interface PepRegionEntry {
  name?: string;
  systemIndex?: number;
  systemName?: string;
  nodeType?: number;
  missionType?: string;
  factionIndex?: number;
}

// ── @wfcd/items fields ──────────────────────────────────────────────────────

export interface WfcdDrop {
  location: string;
  type: string;
  chance: number;
  rarity: string;
}

export interface WfcdComponent {
  uniqueName: string;
  name: string;
  imageName?: string;
  tradable?: boolean;
  ducats?: number;
  itemCount?: number;
  drops?: WfcdDrop[];
}

export interface WfcdItem {
  uniqueName: string;
  name: string;
  imageName?: string;
  category: string;
  masteryReq?: number;
  masterable?: boolean;
  tradable?: boolean;
  vaulted?: boolean;
  exalted?: boolean;
  ducats?: number;
  description?: string;
  productCategory?: string;
  type?: string;
  wikiaUrl?: string;
  components?: WfcdComponent[];
  drops?: WfcdDrop[];
}

// ── Recipe / crafting types ──────────────────────────────────────────────────

export interface RecipeIngredient {
  uniqueName: string;
  count: number;
}

export interface RecipeData {
  buildPrice: number;
  buildTime: number;
  num: number;
  ingredients: RecipeIngredient[];
}

// ── Item database output types ──────────────────────────────────────────────

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

// ── World state raw API types ───────────────────────────────────────────────

export interface WorldStateDate {
  $date: { $numberLong: string };
}

export interface ActiveMissionRaw {
  Modifier: string;
  MissionType: string;
  Node: string;
  Hard?: boolean;
  Expiry: WorldStateDate;
}

export interface VoidTraderRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
  Node: string;
  Manifest?: { ItemType: string; PrimePrice?: number; RegularPrice?: number }[];
}

export interface VaultTraderRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
  Node: string;
  Manifest?: { ItemType: string }[];
}

export interface SortieRaw {
  Expiry: WorldStateDate;
}

export interface SyndicateMissionJobRaw {
  jobType: string;
  rewards: string;
  masteryReq: number;
  minEnemyLevel: number;
  maxEnemyLevel: number;
  xpAmounts: number[];
}

export interface SyndicateMissionRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
  Tag: string;
  Seed: number;
  Nodes?: string[];
  Jobs?: SyndicateMissionJobRaw[];
}

export interface InvasionCountedItemRaw {
  ItemType: string;
  ItemCount: number;
}

export interface InvasionRewardRaw {
  countedItems?: InvasionCountedItemRaw[];
  credits?: number;
}

export interface InvasionRaw {
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

export interface WorldStateRaw {
  ActiveMissions?: ActiveMissionRaw[];
  VoidTraders?: VoidTraderRaw | VoidTraderRaw[];
  PrimeVaultTraders?: VaultTraderRaw | VaultTraderRaw[];
  Sorties?: SortieRaw | SortieRaw[];
  Descents?: DescentRaw[];
  EndlessXpChoices?: EndlessXpChoice[];
  SyndicateMissions?: SyndicateMissionRaw[];
  Invasions?: InvasionRaw[];
}

export interface DescentRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
}

export interface EndlessXpChoice {
  Category: string;
  Choices: string[];
}

// ── World state parsed output types ─────────────────────────────────────────

export interface Fissure {
  tier: string;
  tierNum: number;
  missionType: string;
  node: string;
  nodeLabel: string;
  isHard: boolean;
  expiry: string;
}

export interface VoidTrader {
  active: boolean;
  node: string;
  nodeLabel: string;
  activation: string;
  expiry: string;
}

export interface VaultTrader {
  active: boolean;
  node: string;
  nodeLabel: string;
  activation: string;
  expiry: string;
  itemCount: number;
}

export interface Sortie {
  expiry: string;
}

export interface CycleInfo {
  state: string;
  timeLeft: string;
  expiry: string;
}

export interface ParsedWorldState {
  fissures: Fissure[];
  voidTrader: VoidTrader | null;
  vaultTrader: VaultTrader | null;
  sortie: Sortie | null;
  steelPath: Fissure[];
  duviriCycle: CycleInfo | null;
  earthCycle: CycleInfo | null;
  cetusCycle: CycleInfo | null;
  vallisCycle: CycleInfo | null;
  cambionCycle: CycleInfo | null;
}
