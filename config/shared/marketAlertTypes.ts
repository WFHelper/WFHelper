// Rule schema for the market alert engine. Split in two on purpose: the rule is
// the shareable half an export carries, MarketAlertBinding is the device-local
// half (delivery choices) that never leaves the machine. Anything added here
// has to stay on the right side of that line.

import { TAG_TO_WFM_URL_NAME } from "./wfmRivenVocabulary";

export const MARKET_ALERT_SCHEMA_VERSION = 1;

/** Rejected above this; an import is untrusted input, not a config file. */
export const MARKET_ALERT_IMPORT_MAX_BYTES = 256 * 1024;
export const MARKET_ALERT_MAX_RULES = 100;
export const MARKET_ALERT_MAX_NAME_CHARS = 60;
/** A riven carries at most four attributes; the slack is for future rolls. */
export const MARKET_ALERT_MAX_ATTRIBUTES = 8;
export const MARKET_ALERT_MAX_STAT_BOUNDS = 8;
export const MARKET_ALERT_HISTORY_MAX = 500;
export const MARKET_ALERT_MIN_COOLDOWN_MINUTES = 5;
export const MARKET_ALERT_MAX_COOLDOWN_MINUTES = 24 * 60;
export const MARKET_ALERT_DEFAULT_COOLDOWN_MINUTES = 60;

// IPC channel names live with the schema so preload, ipc and renderer share one
// spelling without touching the central channel list.
export const MARKET_ALERTS_LIST = "market-alerts:list";
export const MARKET_ALERTS_SAVE = "market-alerts:save";
export const MARKET_ALERTS_DELETE = "market-alerts:delete";
export const MARKET_ALERTS_SET_ENABLED = "market-alerts:set-enabled";
export const MARKET_ALERTS_HITS = "market-alerts:hits";
export const MARKET_ALERTS_CLEAR_HITS = "market-alerts:clear-hits";
export const MARKET_ALERTS_STATUS = "market-alerts:status";
export const MARKET_ALERTS_TEST_FIRE = "market-alerts:test-fire";
export const MARKET_ALERTS_EXPORT = "market-alerts:export";
export const MARKET_ALERTS_IMPORT = "market-alerts:import";
/** Main -> renderer push: a hit was recorded or the engine status moved. */
export const MARKET_ALERTS_CHANGED = "market-alerts:changed";

const MARKET_ALERT_KINDS = ["riven", "item", "baro"] as const;
type MarketAlertKind = (typeof MARKET_ALERT_KINDS)[number];

export const RIVEN_POLARITIES = ["madurai", "naramon", "vazarin"] as const;
export type RivenPolarity = (typeof RIVEN_POLARITIES)[number];

export const MARKET_ORDER_SIDES = ["sell", "buy"] as const;
type MarketOrderSide = (typeof MARKET_ORDER_SIDES)[number];

export const MARKET_ALERT_SELLER_STATUSES = ["ingame", "online"] as const;
export type MarketAlertSellerStatus = (typeof MARKET_ALERT_SELLER_STATUSES)[number];

// The closed set of WFM auction attribute slugs. An import naming anything
// outside it is rejected rather than passed through to a query string.
const ATTRIBUTE_SET: ReadonlySet<string> = new Set(Object.values(TAG_TO_WFM_URL_NAME));

function isRivenAttributeUrlName(value: unknown): value is string {
  return typeof value === "string" && ATTRIBUTE_SET.has(value);
}

/** WFM item and weapon slugs. Attribute slugs are checked against the closed
 *  vocabulary instead because those legitimately contain a slash. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;

export interface RivenStatBound {
  /** WFM auction attribute url_name, matched exactly, never by substring. */
  attribute: string;
  min?: number;
  max?: number;
}

export interface RivenAlertMatch {
  /** WFM riven family slug, resolved from the catalog, never a display name. */
  weaponUrlName: string;
  /** Buffs the roll should carry; minSimilarityPct relaxes how many. */
  requirePositive: string[];
  /** Curses that must all be present. */
  requireNegative: string[];
  /** Curses the roll is allowed to carry. Empty means no restriction; a
   *  non-empty list rejects any other curse and still accepts a clean roll. */
  allowedNegatives?: string[];
  /** Attributes that must not appear on either side. */
  excludeAttributes: string[];
  /** true = the roll must carry a curse, false = must not, absent = either. */
  hasNegative?: boolean;
  /** Share of requirePositive the roll must carry, 0-100; absent means all. */
  minSimilarityPct?: number;
  /** Auctions with no buyout price. Off by default so a rule never quotes an
   *  opening bid as if it were the asking price. */
  includeBidOnly?: boolean;
  /** Compared against the attribute value normalised to mod rank 8. */
  statBounds: RivenStatBound[];
  minMasteryRank?: number;
  maxMasteryRank?: number;
  polarity?: RivenPolarity;
  minModRank?: number;
  maxModRank?: number;
  minPlatinum?: number;
  maxPlatinum?: number;
  minRerolls?: number;
  maxRerolls?: number;
  /** Dissolve value per platinum asked; see rivenDissolveEndo. */
  minEndoPerPlat?: number;
}

export interface ItemAlertMatch {
  itemUrlName: string;
  /** Which side of the order book to watch. */
  side: MarketOrderSide;
  /** An order matches when its platinum lies inside the given bounds. */
  maxPlatinum?: number;
  minPlatinum?: number;
  minQuantity?: number;
  /** Only orders whose owner is in one of these; empty means any status. */
  statuses: MarketAlertSellerStatus[];
  /** Owned-count gates, checked against the count the renderer last pushed. */
  ownedBelow?: number;
  ownedAbove?: number;
}

// Reserved. The schema accepts and round-trips these rules; nothing evaluates
// them yet, so a baro rule can never fire.
interface BaroAlertMatch {
  itemUrlName: string;
  maxDucats?: number;
  maxCredits?: number;
}

export interface MarketAlertRule {
  id: string;
  name: string;
  kind: MarketAlertKind;
  enabled: boolean;
  /** Minutes a rule stays quiet after it fires. */
  cooldownMinutes: number;
  riven?: RivenAlertMatch;
  item?: ItemAlertMatch;
  baro?: BaroAlertMatch;
}

/** A rule on its way into a save; the engine assigns the id when absent. */
export type MarketAlertRuleInput = Omit<MarketAlertRule, "id"> & { id?: string };

/** Device-local. Never exported, never shared, never part of a rule. */
export interface MarketAlertBinding {
  /** Desktop toast for this rule; source-level routing still applies on top. */
  native: boolean;
}

export const DEFAULT_MARKET_ALERT_BINDING: Readonly<MarketAlertBinding> = Object.freeze({
  native: true,
});

export interface MarketAlertHit {
  id: string;
  ruleId: string;
  /** Copied at fire time so a renamed or deleted rule keeps its history. */
  ruleName: string;
  at: string;
  kind: MarketAlertKind;
  /** English on purpose: a stored translated string freezes its language. */
  title: string;
  detail: string;
  /** warframe.market deep link; the UI opens it through open-external. */
  url: string;
  platinum: number | null;
  seller?: string;
  endoPerPlat?: number;
}

/** Mirror of the wfm scheduler health, reachable as EngineStatus["scheduler"]. */
interface MarketAlertSchedulerHealth {
  state: "ok" | "backoff" | "degraded";
  recentFailures: number;
  backoffUntil?: number;
}

export interface MarketAlertEngineStatus {
  running: boolean;
  ruleCount: number;
  enabledCount: number;
  lastTickAt: string | null;
  /** Requests the engine itself issued in the trailing hour. */
  requestsLastHour: number;
  scheduler: MarketAlertSchedulerHealth;
  /** Last evaluation failure, already normalized; null once a tick succeeds. */
  lastError: string | null;
  /** Set when an unreadable rules file was quarantined and the engine started
   *  from an empty rule set, so the view can say the rules did not vanish. */
  rulesRecoveredAt: string | null;
}

export interface MarketAlertListResult {
  rules: MarketAlertRule[];
  bindings: Record<string, MarketAlertBinding>;
}

export type MarketAlertSaveResult =
  | { ok: true; rule: MarketAlertRule }
  | { ok: false; error: string };

export type MarketAlertImportOutcome = { ok: true; added: number } | { ok: false; error: string };

export type MarketAlertTestFireResult =
  | { ok: true; matches: number; detail: string }
  | { ok: false; error: string };

export interface MarketAlertSavePayload {
  rule: MarketAlertRuleInput;
  binding?: MarketAlertBinding;
  /** Display name for main to resolve into riven.weaponUrlName on save. */
  weaponName?: string;
  /** Renderer-computed owned count for the rule's item slug. */
  ownedCount?: number | null;
}

type MarketAlertParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): MarketAlertParseResult<T> {
  return { ok: false, error };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Unknown keys are rejected rather than dropped: a file we did not write is
// either a different version or hand-edited, and both deserve a hard error
// instead of a rule that silently means something else.
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return `unexpected field "${key}"`;
  }
  return null;
}

function readOptionalInt(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): MarketAlertParseResult<number | undefined> {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${key} must be a number`);
  const int = Math.trunc(value);
  if (int < min || int > max) return fail(`${key} out of range`);
  return { ok: true, value: int };
}

function readOptionalNumber(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): MarketAlertParseResult<number | undefined> {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${key} must be a number`);
  if (value < min || value > max) return fail(`${key} out of range`);
  return { ok: true, value };
}

function readAttributeList(
  raw: Record<string, unknown>,
  key: string,
): MarketAlertParseResult<string[]> {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return fail(`${key} must be an array`);
  if (value.length > MARKET_ALERT_MAX_ATTRIBUTES) return fail(`${key} has too many entries`);
  const out: string[] = [];
  for (const entry of value) {
    if (!isRivenAttributeUrlName(entry)) return fail(`${key} has an unknown attribute`);
    if (!out.includes(entry)) out.push(entry);
  }
  return { ok: true, value: out };
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

const RIVEN_MATCH_KEYS = [
  "weaponUrlName",
  "requirePositive",
  "requireNegative",
  "allowedNegatives",
  "excludeAttributes",
  "hasNegative",
  "minSimilarityPct",
  "includeBidOnly",
  "statBounds",
  "minMasteryRank",
  "maxMasteryRank",
  "polarity",
  "minModRank",
  "maxModRank",
  "minPlatinum",
  "maxPlatinum",
  "minRerolls",
  "maxRerolls",
  "minEndoPerPlat",
] as const;

function parseStatBounds(value: unknown): MarketAlertParseResult<RivenStatBound[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return fail("statBounds must be an array");
  if (value.length > MARKET_ALERT_MAX_STAT_BOUNDS) return fail("statBounds has too many entries");
  const out: RivenStatBound[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return fail("statBounds entry must be an object");
    const unknownKey = rejectUnknownKeys(entry, ["attribute", "min", "max"]);
    if (unknownKey) return fail(`statBounds ${unknownKey}`);
    if (!isRivenAttributeUrlName(entry.attribute)) {
      return fail("statBounds has an unknown attribute");
    }
    const min = readOptionalNumber(entry, "min", -100_000, 100_000);
    if (!min.ok) return fail(`statBounds ${min.error}`);
    const max = readOptionalNumber(entry, "max", -100_000, 100_000);
    if (!max.ok) return fail(`statBounds ${max.error}`);
    if (min.value === undefined && max.value === undefined) {
      return fail("statBounds entry needs a min or a max");
    }
    if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
      return fail("statBounds min is above max");
    }
    // First bound per attribute wins, like readAttributeList: a second one is
    // an editor slip, and the alert card keys its chips by attribute.
    if (out.some((existing) => existing.attribute === entry.attribute)) continue;
    const bound: RivenStatBound = { attribute: entry.attribute };
    if (min.value !== undefined) bound.min = min.value;
    if (max.value !== undefined) bound.max = max.value;
    out.push(bound);
  }
  return { ok: true, value: out };
}

function parseRivenMatch(value: unknown): MarketAlertParseResult<RivenAlertMatch> {
  if (!isPlainObject(value)) return fail("riven must be an object");
  const unknownKey = rejectUnknownKeys(value, RIVEN_MATCH_KEYS);
  if (unknownKey) return fail(`riven ${unknownKey}`);
  if (!isSlug(value.weaponUrlName)) return fail("riven weaponUrlName is not a slug");

  const requirePositive = readAttributeList(value, "requirePositive");
  if (!requirePositive.ok) return fail(`riven ${requirePositive.error}`);
  const requireNegative = readAttributeList(value, "requireNegative");
  if (!requireNegative.ok) return fail(`riven ${requireNegative.error}`);
  const excludeAttributes = readAttributeList(value, "excludeAttributes");
  if (!excludeAttributes.ok) return fail(`riven ${excludeAttributes.error}`);

  const statBounds = parseStatBounds(value.statBounds);
  if (!statBounds.ok) return fail(`riven ${statBounds.error}`);

  const match: RivenAlertMatch = {
    weaponUrlName: value.weaponUrlName,
    requirePositive: requirePositive.value,
    requireNegative: requireNegative.value,
    excludeAttributes: excludeAttributes.value,
    statBounds: statBounds.value,
  };

  // Absent stays absent: an export must not gain a field the user never set.
  if (value.allowedNegatives !== undefined) {
    const allowedNegatives = readAttributeList(value, "allowedNegatives");
    if (!allowedNegatives.ok) return fail(`riven ${allowedNegatives.error}`);
    match.allowedNegatives = allowedNegatives.value;
  }

  if (value.hasNegative !== undefined) {
    if (typeof value.hasNegative !== "boolean") return fail("riven hasNegative must be a boolean");
    match.hasNegative = value.hasNegative;
  }
  if (value.includeBidOnly !== undefined) {
    if (typeof value.includeBidOnly !== "boolean") {
      return fail("riven includeBidOnly must be a boolean");
    }
    match.includeBidOnly = value.includeBidOnly;
  }
  if (value.polarity !== undefined) {
    if (!RIVEN_POLARITIES.includes(value.polarity as RivenPolarity)) {
      return fail("riven polarity is not a riven polarity");
    }
    match.polarity = value.polarity as RivenPolarity;
  }

  const numbers: Array<[keyof RivenAlertMatch, number, number, boolean]> = [
    ["minSimilarityPct", 0, 100, true],
    ["minMasteryRank", 0, 16, true],
    ["maxMasteryRank", 0, 16, true],
    ["minModRank", 0, 8, true],
    ["maxModRank", 0, 8, true],
    ["minPlatinum", 0, 1_000_000, true],
    ["maxPlatinum", 0, 1_000_000, true],
    ["minRerolls", 0, 10_000, true],
    ["maxRerolls", 0, 10_000, true],
    ["minEndoPerPlat", 0, 100_000, false],
  ];
  for (const [key, min, max, isInt] of numbers) {
    const parsed = isInt
      ? readOptionalInt(value, key, min, max)
      : readOptionalNumber(value, key, min, max);
    if (!parsed.ok) return fail(`riven ${parsed.error}`);
    if (parsed.value !== undefined) {
      (match as unknown as Record<string, unknown>)[key] = parsed.value;
    }
  }

  const ranges: Array<[keyof RivenAlertMatch, keyof RivenAlertMatch]> = [
    ["minMasteryRank", "maxMasteryRank"],
    ["minModRank", "maxModRank"],
    ["minPlatinum", "maxPlatinum"],
    ["minRerolls", "maxRerolls"],
  ];
  for (const [lowKey, highKey] of ranges) {
    const low = match[lowKey] as number | undefined;
    const high = match[highKey] as number | undefined;
    if (low !== undefined && high !== undefined && low > high) {
      return fail(`riven ${String(lowKey)} is above ${String(highKey)}`);
    }
  }

  // A require-negative list and "must have no curse" cannot both hold, and a
  // required attribute that is also excluded never matches anything.
  if (match.hasNegative === false && match.requireNegative.length > 0) {
    return fail("riven hasNegative false contradicts requireNegative");
  }
  for (const attribute of match.excludeAttributes) {
    if (match.requirePositive.includes(attribute) || match.requireNegative.includes(attribute)) {
      return fail("riven excludeAttributes contradicts a required attribute");
    }
  }
  if (match.allowedNegatives && match.allowedNegatives.length > 0) {
    for (const attribute of match.requireNegative) {
      if (!match.allowedNegatives.includes(attribute)) {
        return fail("riven requireNegative is outside allowedNegatives");
      }
    }
  }
  return { ok: true, value: match };
}

const ITEM_MATCH_KEYS = [
  "itemUrlName",
  "side",
  "maxPlatinum",
  "minPlatinum",
  "minQuantity",
  "statuses",
  "ownedBelow",
  "ownedAbove",
] as const;

function parseItemMatch(value: unknown): MarketAlertParseResult<ItemAlertMatch> {
  if (!isPlainObject(value)) return fail("item must be an object");
  const unknownKey = rejectUnknownKeys(value, ITEM_MATCH_KEYS);
  if (unknownKey) return fail(`item ${unknownKey}`);
  if (!isSlug(value.itemUrlName)) return fail("item itemUrlName is not a slug");
  if (!MARKET_ORDER_SIDES.includes(value.side as MarketOrderSide)) {
    return fail("item side is invalid");
  }

  const statuses: MarketAlertSellerStatus[] = [];
  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses)) return fail("item statuses must be an array");
    if (value.statuses.length > MARKET_ALERT_SELLER_STATUSES.length) {
      return fail("item statuses has too many entries");
    }
    for (const entry of value.statuses) {
      if (!MARKET_ALERT_SELLER_STATUSES.includes(entry as MarketAlertSellerStatus)) {
        return fail("item statuses has an unknown status");
      }
      if (!statuses.includes(entry as MarketAlertSellerStatus)) {
        statuses.push(entry as MarketAlertSellerStatus);
      }
    }
  }

  const match: ItemAlertMatch = {
    itemUrlName: value.itemUrlName,
    side: value.side as MarketOrderSide,
    statuses,
  };
  const numbers: Array<[keyof ItemAlertMatch, number, number]> = [
    ["maxPlatinum", 0, 1_000_000],
    ["minPlatinum", 0, 1_000_000],
    ["minQuantity", 1, 1_000_000],
    ["ownedBelow", 0, 1_000_000],
    ["ownedAbove", 0, 1_000_000],
  ];
  for (const [key, min, max] of numbers) {
    const parsed = readOptionalInt(value, key, min, max);
    if (!parsed.ok) return fail(`item ${parsed.error}`);
    if (parsed.value !== undefined) {
      (match as unknown as Record<string, unknown>)[key] = parsed.value;
    }
  }
  if (match.maxPlatinum === undefined && match.minPlatinum === undefined) {
    return fail("item needs a price threshold");
  }
  if (
    match.minPlatinum !== undefined &&
    match.maxPlatinum !== undefined &&
    match.minPlatinum > match.maxPlatinum
  ) {
    return fail("item minPlatinum is above maxPlatinum");
  }
  return { ok: true, value: match };
}

const BARO_MATCH_KEYS = ["itemUrlName", "maxDucats", "maxCredits"] as const;

function parseBaroMatch(value: unknown): MarketAlertParseResult<BaroAlertMatch> {
  if (!isPlainObject(value)) return fail("baro must be an object");
  const unknownKey = rejectUnknownKeys(value, BARO_MATCH_KEYS);
  if (unknownKey) return fail(`baro ${unknownKey}`);
  if (!isSlug(value.itemUrlName)) return fail("baro itemUrlName is not a slug");
  const match: BaroAlertMatch = { itemUrlName: value.itemUrlName };
  const ducats = readOptionalInt(value, "maxDucats", 0, 1_000_000);
  if (!ducats.ok) return fail(`baro ${ducats.error}`);
  if (ducats.value !== undefined) match.maxDucats = ducats.value;
  const credits = readOptionalInt(value, "maxCredits", 0, 1_000_000_000);
  if (!credits.ok) return fail(`baro ${credits.error}`);
  if (credits.value !== undefined) match.maxCredits = credits.value;
  return { ok: true, value: match };
}

const RULE_KEYS = [
  "id",
  "name",
  "kind",
  "enabled",
  "cooldownMinutes",
  "riven",
  "item",
  "baro",
] as const;

/** Validates one rule from untrusted input. `id` is optional on the way in so
 *  the same parser serves an import, an IPC save and a persisted file. */
export function parseMarketAlertRule(
  value: unknown,
  fallbackId: string,
): MarketAlertParseResult<MarketAlertRule> {
  if (!isPlainObject(value)) return fail("rule must be an object");
  const unknownKey = rejectUnknownKeys(value, RULE_KEYS);
  if (unknownKey) return fail(`rule ${unknownKey}`);

  const id = value.id === undefined ? fallbackId : value.id;
  if (typeof id !== "string" || !id || id.length > 64) return fail("rule id is invalid");

  if (typeof value.name !== "string") return fail("rule name must be a string");
  const name = value.name.trim();
  if (!name || name.length > MARKET_ALERT_MAX_NAME_CHARS) {
    return fail("rule name length is invalid");
  }

  if (!MARKET_ALERT_KINDS.includes(value.kind as MarketAlertKind)) {
    return fail("rule kind is invalid");
  }
  const kind = value.kind as MarketAlertKind;

  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return fail("rule enabled must be a boolean");
  }
  const cooldown = readOptionalInt(
    value,
    "cooldownMinutes",
    MARKET_ALERT_MIN_COOLDOWN_MINUTES,
    MARKET_ALERT_MAX_COOLDOWN_MINUTES,
  );
  if (!cooldown.ok) return fail(`rule ${cooldown.error}`);

  const rule: MarketAlertRule = {
    id,
    name,
    kind,
    enabled: value.enabled !== false,
    cooldownMinutes: cooldown.value ?? MARKET_ALERT_DEFAULT_COOLDOWN_MINUTES,
  };

  // Exactly the section its kind names, so a rule cannot carry a hidden second
  // criteria block that a later version would start evaluating.
  const sections = ["riven", "item", "baro"] as const;
  for (const section of sections) {
    if (section !== kind && value[section] !== undefined) {
      return fail(`rule kind ${kind} cannot carry a ${section} section`);
    }
  }
  if (kind === "riven") {
    const parsed = parseRivenMatch(value.riven);
    if (!parsed.ok) return parsed;
    rule.riven = parsed.value;
  } else if (kind === "item") {
    const parsed = parseItemMatch(value.item);
    if (!parsed.ok) return parsed;
    rule.item = parsed.value;
  } else {
    const parsed = parseBaroMatch(value.baro);
    if (!parsed.ok) return parsed;
    rule.baro = parsed.value;
  }
  return { ok: true, value: rule };
}

export function parseMarketAlertBinding(value: unknown): MarketAlertBinding {
  if (!isPlainObject(value)) return { ...DEFAULT_MARKET_ALERT_BINDING };
  return { native: value.native !== false };
}

interface MarketAlertExport {
  schema: number;
  exportedAt: string;
  rules: MarketAlertRule[];
}

const EXPORT_KEYS = ["schema", "exportedAt", "rules"] as const;

/** Criteria only. Bindings, owned counts, hit history and anything naming this
 *  machine are left behind by construction, not by filtering. */
export function buildMarketAlertExport(rules: readonly MarketAlertRule[]): MarketAlertExport {
  return {
    schema: MARKET_ALERT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    rules: rules.map((rule) => {
      const copy: MarketAlertRule = {
        id: rule.id,
        name: rule.name,
        kind: rule.kind,
        enabled: rule.enabled,
        cooldownMinutes: rule.cooldownMinutes,
      };
      if (rule.riven) copy.riven = rule.riven;
      if (rule.item) copy.item = rule.item;
      if (rule.baro) copy.baro = rule.baro;
      return copy;
    }),
  };
}

/** Parses an export file. `text` is the raw file so the byte cap is applied
 *  before JSON.parse sees it. */
export function parseMarketAlertImport(
  text: unknown,
  makeId: (index: number) => string,
): MarketAlertParseResult<MarketAlertRule[]> {
  if (typeof text !== "string") return fail("import must be text");
  // Byte length, not character count: a multi-byte payload is what costs memory.
  const bytes =
    typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;
  if (bytes > MARKET_ALERT_IMPORT_MAX_BYTES) return fail("import is too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("import is not valid JSON");
  }
  if (!isPlainObject(parsed)) return fail("import must be an object");
  const unknownKey = rejectUnknownKeys(parsed, EXPORT_KEYS);
  if (unknownKey) return fail(`import ${unknownKey}`);
  if (parsed.schema !== MARKET_ALERT_SCHEMA_VERSION) return fail("import schema version mismatch");
  if (parsed.exportedAt !== undefined && typeof parsed.exportedAt !== "string") {
    return fail("import exportedAt must be a string");
  }
  if (!Array.isArray(parsed.rules)) return fail("import rules must be an array");
  if (parsed.rules.length > MARKET_ALERT_MAX_RULES) return fail("import has too many rules");

  const rules: MarketAlertRule[] = [];
  for (let i = 0; i < parsed.rules.length; i++) {
    // Imported ids are dropped: a shared file must never collide with or
    // silently overwrite a rule that already exists on this machine.
    const raw = isPlainObject(parsed.rules[i]) ? { ...parsed.rules[i] } : parsed.rules[i];
    if (isPlainObject(raw)) delete raw.id;
    const rule = parseMarketAlertRule(raw, makeId(i));
    if (!rule.ok) return fail(`import rule ${i + 1}: ${rule.error}`);
    rules.push(rule.value);
  }
  return { ok: true, value: rules };
}
