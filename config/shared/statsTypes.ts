/** Classification of a trade event. */
export type TradeType = "sale" | "purchase" | "trade";

/** Download stage for the API helper binary. */
export type DownloadStage = "resolving" | "downloading" | "done" | "error";

/** Direction of an item in a trade. */
export type TradeDirection = "given" | "received";

export interface TradeItem {
  internalName: string;
  displayName: string;
  count: number;
  direction: TradeDirection;
  wfmSlug?: string;
  wfmThumb?: string;
}

/** Where a ledger row came from; absent on legacy rows and means "live". */
export type TradeEventSource = "live" | "gdpr";

export interface TradeEvent {
  id: string;
  date: string; // ISO datetime
  type: TradeType;
  platChange: number; // always positive (0 for pure item swaps)
  items: TradeItem[];
  partner?: string; // trading partner username (best-effort from EE.log)
  wfmClosed?: boolean; // true when a WFM order was auto-closed for this trade
  schemaVersion?: number; // absent = v1 legacy row
  source?: TradeEventSource;
  /** Deterministic id of the source record so re-imports stay idempotent. */
  sourceRecordId?: string;
  importBatchId?: string;
  credits?: number; // credits moved in the trade, when known
  tradeTax?: number;
  editedAt?: string; // ISO, set when the user fixes a row by hand
}

/** One resource's numbers for a single day. */
export interface StatResourceDay {
  delta: number;
  abs?: number;
}

export interface DailyStatEntry {
  date: string; // "YYYY-MM-DD"
  platDelta: number; // net plat change this session/day
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number; // net Void Ducat change (MiscItems/PrimeBucks)
  ayaDelta: number; // net Aya (MiscItems/SchismKey) change
  vitusDelta: number; // net Vitus Essence change (MiscItems/Elitium)
  relicsOpened: number; // relics consumed (LevelKeys net decrease, >=0)
  daysPlayed: number; // 1 = played; 0 = no inventory data (imported gap)
  dailyTrades: number; // number of trades detected or imported for this day
  absPlat?: number; // absolute platinum balance at end of day
  absCredits?: number; // absolute credits balance at end of day
  absEndo?: number; // absolute endo balance at end of day
  absDucats?: number; // absolute ducats balance at end of day
  absAya?: number; // absolute aya balance at end of day
  absVitus?: number; // absolute vitus essence balance at end of day
  resourcesVersion?: number; // schema of `resources`; absent on pre-map entries
  // Every tracked resource, keyed by catalog id. The six fields above stay
  // written so a downgraded build still reads its own history.
  resources?: Record<string, StatResourceDay>;
}

export interface SessionStats {
  platDelta: number;
  creditsDelta: number;
  endoDelta: number;
  ducatsDelta: number;
  ayaDelta: number;
  vitusDelta: number;
  currentPlat: number | null;
  currentCredits: number | null;
  currentEndo: number | null;
  currentDucats: number | null;
  currentAya: number | null;
  currentVitus: number | null;
  resources: Record<string, { delta: number; current: number | null }>;
  hasData: boolean;
}

/** Schema marker for `DailyStatEntry.resources`. */
export const STAT_RESOURCES_VERSION = 1;

/** Where a resource's amount lives in the raw DE inventory payload. */
type StatResourceSource =
  | { readonly kind: "field"; readonly field: string }
  | { readonly kind: "misc"; readonly uniqueName: string };

interface StatResourceDef {
  readonly id: string;
  readonly source: StatResourceSource;
  /** "compact" renders large balances as k/M. */
  readonly format: "plain" | "compact";
}

const MISC = "/Lotus/Types/Items/MiscItems/";

function topLevel<Id extends string>(
  id: Id,
  field: string,
  format: StatResourceDef["format"] = "plain",
): StatResourceDef & { readonly id: Id } {
  return { id, source: { kind: "field", field }, format };
}

function miscItem<Id extends string>(
  id: Id,
  uniqueName: string,
  format: StatResourceDef["format"] = "plain",
): StatResourceDef & { readonly id: Id } {
  return { id, source: { kind: "misc", uniqueName }, format };
}

// Recording covers this whole list unconditionally; only display is a user choice.
// uniqueNames verified against @wfcd/items. Traps that must not be "fixed":
// PrimeBucks is Ducats, top-level PrimeTokens is Regal Aya, Aya is SchismKey,
// Vitus Essence is Elitium. Labels live in src/stores/statsDisplay.ts.
const RESOURCE_DEFS = [
  topLevel("plat", "PremiumCredits"),
  miscItem("ducats", `${MISC}PrimeBucks`),
  miscItem("aya", `${MISC}SchismKey`),
  topLevel("credits", "RegularCredits", "compact"),
  topLevel("endo", "FusionPoints", "compact"),
  miscItem("vitus", `${MISC}Elitium`),
  miscItem("kuva", `${MISC}Kuva`, "compact"),
  topLevel("regalAya", "PrimeTokens"),
  miscItem("voidTraces", `${MISC}VoidTearDrop`),
  miscItem("steelEssence", `${MISC}SteelEssence`),
  miscItem("rivenSliver", `${MISC}RivenFragment`),
  miscItem("vosfor", `${MISC}DistillPoints`, "compact"),
  miscItem("nitain", `${MISC}Alertium`),
  miscItem("forma", `${MISC}Forma`),
  miscItem("argonCrystal", `${MISC}ArgonCrystal`),
  miscItem("orokinCell", `${MISC}OrokinCell`),
  miscItem("tellurium", `${MISC}Tellurium`),
  miscItem("somaticFibers", `${MISC}MemoryCryptoFragment`),
  miscItem("hexenon", `${MISC}ConcentratedGas`),
  miscItem("narmerIsoplast", `${MISC}NarmerBountyResource`),
  // These two are resources but live outside the MiscItems namespace.
  miscItem("cetusWisp", "/Lotus/Types/Gameplay/Eidolon/Resources/CetusWispItem"),
  miscItem("pathosClamp", "/Lotus/Types/Gameplay/Duviri/Resource/DuviriDragonDropItem"),
] as const;

export const STAT_RESOURCES: readonly StatResourceDef[] = RESOURCE_DEFS;

/** Catalog ids as a union, so the renderer's label map cannot miss one. */
export type StatResourceId = (typeof RESOURCE_DEFS)[number]["id"];

/** Charts shown before the user picks: the six pre-map resources plus Kuva. */
export const DEFAULT_STAT_RESOURCE_IDS: readonly string[] = [
  "plat",
  "ducats",
  "aya",
  "credits",
  "endo",
  "vitus",
  "kuva",
];

// The six resources that predate the map and therefore own a flat field pair.
const LEGACY_STAT_FIELDS = {
  plat: { delta: "platDelta", abs: "absPlat" },
  credits: { delta: "creditsDelta", abs: "absCredits" },
  endo: { delta: "endoDelta", abs: "absEndo" },
  ducats: { delta: "ducatsDelta", abs: "absDucats" },
  aya: { delta: "ayaDelta", abs: "absAya" },
  vitus: { delta: "vitusDelta", abs: "absVitus" },
} as const;

/**
 * A resource's day values, reading the map first and falling back to the flat
 * fields so history written before the map still charts.
 */
export function readStatResourceDay(entry: DailyStatEntry, id: string): StatResourceDay | null {
  const mapped = entry.resources?.[id];
  if (mapped && typeof mapped.delta === "number") {
    if (typeof mapped.abs === "number") return { delta: mapped.delta, abs: mapped.abs };
    return { delta: mapped.delta };
  }
  const legacy = LEGACY_STAT_FIELDS[id as keyof typeof LEGACY_STAT_FIELDS];
  if (!legacy) return null;
  const rawDelta = entry[legacy.delta];
  const rawAbs = entry[legacy.abs];
  const delta = typeof rawDelta === "number" ? rawDelta : 0;
  return typeof rawAbs === "number" ? { delta, abs: rawAbs } : { delta };
}

/** Mirrors a resource onto the flat fields a downgraded build reads. */
export function writeLegacyStatFields(
  entry: DailyStatEntry,
  id: string,
  day: StatResourceDay,
): void {
  const legacy = LEGACY_STAT_FIELDS[id as keyof typeof LEGACY_STAT_FIELDS];
  if (!legacy) return;
  entry[legacy.delta] = day.delta;
  if (day.abs !== undefined) entry[legacy.abs] = day.abs;
}
