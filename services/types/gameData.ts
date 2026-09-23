/** Fields consumed from DE public exports and WFCD items. */

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
  /** Sentinels only: the weapon the sentinel ships with. */
  defaultWeapon?: string;
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
  /** `/Lotus/Language/...` key this name came from, for game-language lookup. */
  nameKey?: string | null;
  imageName?: string;
  tradable?: boolean;
  ducats?: number;
  itemCount?: number;
  drops?: DropEntry[];
}

export interface RendererItemEntry {
  /** English. Stays the join key for warframe.market, OCR and by-name lookups. */
  name: string;
  /** Generated from an internal path because no source supplied an English name. */
  nameIsFallback?: true;
  /** Active game language, present only when it differs from `name`. Display only. */
  displayName?: string;
  /** Art is the framed wiki card, so a marketplace thumbnail must not replace it. */
  cardArt?: true;
  category: string;
  imageUrl: string | null;
  isPrime: boolean;
  tradable?: boolean;
  masteryReq: number;
  vaulted: boolean;
  exalted?: boolean;
  incarnon?: true;
  masterable?: boolean;
  type: string;
  isBuildComponent: boolean;
  componentOf?: string;
  description: string;
  productCategory: string | null;
  ducats: number | null;
  components: {
    name: string;
    displayName?: string;
    uniqueName: string;
    tradable?: boolean;
    itemCount: number;
    drops: DropEntry[];
  }[];
  drops: DropEntry[];
  wikiaUrl?: string | null;
  recipe?: RecipeData;
  /** For blueprint entries: uniqueName of the item this blueprint crafts. */
  buildsProduct?: string;
  /** For blueprint entries: building it does not consume the owned copy. */
  reusableBlueprint?: boolean;
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

interface SortieVariantRaw {
  missionType?: string;
  modifierType?: string;
  node?: string;
}

interface SortieRaw {
  _id?: { $oid?: string };
  Activation?: WorldStateDate;
  Expiry?: WorldStateDate;
  Boss?: string;
  Variants?: SortieVariantRaw[];
}

interface LiteSortieMissionRaw {
  missionType?: string;
  node?: string;
}

/** Archon hunt: same envelope as a sortie, with plain missions and no modifiers. */
interface LiteSortieRaw {
  _id?: { $oid?: string };
  Activation?: WorldStateDate;
  Expiry?: WorldStateDate;
  Boss?: string;
  Missions?: LiteSortieMissionRaw[];
}

/** Nightwave act. `Daily` is absent, not false, on weeklies. */
export interface SeasonChallengeRaw {
  _id?: { $oid?: string };
  Daily?: boolean;
  Activation?: WorldStateDate;
  Expiry?: WorldStateDate;
  Challenge?: string;
}

interface SeasonInfoRaw {
  Activation?: WorldStateDate;
  Expiry?: WorldStateDate;
  AffiliationTag?: string;
  Season?: number;
  Phase?: number;
  ActiveChallenges?: SeasonChallengeRaw[];
}

interface TimeWindowRaw {
  Activation?: WorldStateDate;
  Expiry?: WorldStateDate;
}

/** One dated slot of the 1999 calendar; DE ships several event kinds and only
 *  ever fills the field its own type names. */
export interface CalendarEventRaw {
  type?: string;
  challenge?: string;
  reward?: string;
  upgrade?: string;
}

export interface CalendarDayRaw {
  day?: number;
  events?: CalendarEventRaw[];
}

interface CalendarSeasonRaw extends TimeWindowRaw {
  /** Season tag, e.g. "CST_SUMMER". */
  Season?: string;
  Days?: CalendarDayRaw[];
}

interface AlertRewardRaw {
  credits?: number;
  countedItems?: { ItemType?: string; ItemCount?: number }[];
  /** Plain uniqueName strings, quantity one. */
  items?: string[];
}

export interface AlertRaw {
  _id?: { $oid?: string };
  Activation?: WorldStateDate;
  Expiry?: WorldStateDate;
  MissionInfo?: {
    location?: string;
    missionType?: string;
    faction?: string;
    minEnemyLevel?: number;
    maxEnemyLevel?: number;
    missionReward?: AlertRewardRaw;
  };
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

interface DailyDealRaw {
  StoreItem: string;
  Activation?: WorldStateDate;
  Expiry: WorldStateDate;
  Discount?: number;
  OriginalPrice?: number;
  SalePrice?: number;
  AmountTotal?: number;
  AmountSold?: number;
}

export interface WorldStateRaw {
  ActiveMissions?: ActiveMissionRaw[];
  VoidStorms?: VoidStormRaw[];
  VoidTraders?: VoidTraderRaw | VoidTraderRaw[];
  PrimeVaultTraders?: VaultTraderRaw | VaultTraderRaw[];
  Sorties?: SortieRaw | SortieRaw[];
  LiteSorties?: LiteSortieRaw | LiteSortieRaw[];
  SeasonInfo?: SeasonInfoRaw;
  KnownCalendarSeasons?: CalendarSeasonRaw | CalendarSeasonRaw[];
  Alerts?: AlertRaw[];
  Descents?: DescentRaw[];
  EndlessXpChoices?: EndlessXpChoice[];
  EndlessXpSchedule?: EndlessXpScheduleEntry[];
  SyndicateMissions?: SyndicateMissionRaw[];
  Invasions?: InvasionRaw[];
  DailyDeals?: DailyDealRaw[];
}

interface DescentRaw {
  Activation: WorldStateDate;
  Expiry: WorldStateDate;
}

interface EndlessXpChoice {
  Category: string;
  Choices: string[];
}

interface EndlessXpScheduleEntry {
  Activation?: WorldStateDate;
  Expiry?: WorldStateDate;
  CategoryChoices?: EndlessXpChoice[];
}
