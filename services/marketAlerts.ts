/** Market alert engine: one evaluation loop over the saved rules, main-process
 *  only, alive with every view unmounted. All WFM traffic rides wfmClient at
 *  background priority; hits dedup across restarts via a persisted seen file. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";
import * as wfmClient from "./wfmClient";
import { getWfmSchedulerHealth } from "./wfmScheduler";
import { dispatch } from "./notificationChannels";
import { normalizeErrorMessage } from "../config/shared/errors";
import {
  extractWfmOrderList,
  parseOrderPlatform,
  parseOrderStatus,
  parseOrderType,
  parseOrderUserName,
} from "../config/shared/wfmOrders";
import {
  DEFAULT_MARKET_ALERT_BINDING,
  MARKET_ALERT_HISTORY_MAX,
  MARKET_ALERT_MAX_RULES,
  MARKET_ALERT_SCHEMA_VERSION,
  buildMarketAlertExport,
  parseMarketAlertBinding,
  parseMarketAlertImport,
  parseMarketAlertRule,
} from "../config/shared/marketAlertTypes";
import { rivenDissolveEndo, rivenEndoPerPlat } from "../config/shared/rivenEndo";
import type {
  ItemAlertMatch,
  MarketAlertBinding,
  MarketAlertEngineStatus,
  MarketAlertHit,
  MarketAlertImportOutcome,
  MarketAlertListResult,
  MarketAlertRule,
  MarketAlertSaveResult,
  MarketAlertTestFireResult,
  RivenAlertMatch,
} from "../config/shared/marketAlertTypes";

const log = withScope("marketAlerts");

const TICK_MS = 60_000;
const INITIAL_DELAY_MS = 30_000;
/** Minimum spacing between evaluations of the same rule. */
const RULE_EVAL_INTERVAL_MS = 3 * 60_000;
/** Engine-issued WFM requests per tick, on top of the global scheduler budget. */
const MAX_REQUESTS_PER_TICK = 4;
/** Per-rule backoff after a failed evaluation, doubling to the ceiling. */
const FAILURE_BASE_MS = 5 * 60_000;
const FAILURE_CEILING_MS = 60 * 60_000;
/** Seen entries older than this are pruned; a relisted auction may re-fire. */
const SEEN_TTL_MS = 7 * 24 * 60 * 60_000;
const SEEN_MAX_PER_RULE = 500;
const RULES_FILE = "market-alert-rules.json";
/** Riven attribute values scale linearly with mod rank; WFM serves them at the
 *  listing's rank, so a bound has to be compared at rank 8. */
const RIVEN_MAX_MOD_RANK = 8;

interface MarketAlertEngineDeps {
  /** The caller's native toast path; history recording lives inside it. */
  deliverNative: (title: string, body: string) => void;
  /** Signed-in WFM name, for excluding the user's own listings. */
  getOwnName: () => string | null;
  /** Owned count for a WFM item slug from the inventory main holds right now;
   *  null when there is none, which falls back to the save-time snapshot. */
  getLiveOwnedCount: (itemUrlName: string) => Promise<number | null>;
  /** Tells the renderer a hit landed or the engine status moved. */
  onChanged: () => void;
}

interface PersistedState {
  schema: number;
  rules: MarketAlertRule[];
  bindings: Record<string, MarketAlertBinding>;
  ownedCounts: Record<string, number>;
}

interface PersistedSeen {
  schema: number;
  seen: Record<string, Record<string, number>>;
}

interface PersistedHits {
  schema: number;
  hits: MarketAlertHit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function reviveState(parsed: unknown): PersistedState | null {
  if (!isRecord(parsed) || parsed.schema !== MARKET_ALERT_SCHEMA_VERSION) return null;
  const state: PersistedState = {
    schema: MARKET_ALERT_SCHEMA_VERSION,
    rules: [],
    bindings: {},
    ownedCounts: {},
  };
  if (Array.isArray(parsed.rules)) {
    for (const raw of parsed.rules.slice(0, MARKET_ALERT_MAX_RULES)) {
      const rule = parseMarketAlertRule(raw, randomUUID());
      if (rule.ok) state.rules.push(rule.value);
      else log.warn(`Dropped a persisted rule: ${rule.error}`);
    }
  }
  if (isRecord(parsed.bindings)) {
    for (const rule of state.rules) {
      const raw = parsed.bindings[rule.id];
      if (raw !== undefined) state.bindings[rule.id] = parseMarketAlertBinding(raw);
    }
  }
  if (isRecord(parsed.ownedCounts)) {
    for (const [slug, count] of Object.entries(parsed.ownedCounts)) {
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        state.ownedCounts[slug] = Math.trunc(count);
      }
    }
  }
  return state;
}

function reviveSeen(parsed: unknown): PersistedSeen | null {
  if (!isRecord(parsed) || parsed.schema !== MARKET_ALERT_SCHEMA_VERSION) return null;
  const out: PersistedSeen = { schema: MARKET_ALERT_SCHEMA_VERSION, seen: {} };
  if (!isRecord(parsed.seen)) return out;
  for (const [ruleId, entries] of Object.entries(parsed.seen)) {
    if (!isRecord(entries)) continue;
    const kept: Record<string, number> = {};
    for (const [key, at] of Object.entries(entries)) {
      if (typeof at === "number" && Number.isFinite(at)) kept[key] = at;
    }
    out.seen[ruleId] = kept;
  }
  return out;
}

function reviveHits(parsed: unknown): PersistedHits | null {
  if (!isRecord(parsed) || parsed.schema !== MARKET_ALERT_SCHEMA_VERSION) return null;
  const hits: MarketAlertHit[] = [];
  if (Array.isArray(parsed.hits)) {
    for (const raw of parsed.hits.slice(0, MARKET_ALERT_HISTORY_MAX)) {
      if (!isRecord(raw)) continue;
      if (
        typeof raw.id !== "string" ||
        typeof raw.ruleId !== "string" ||
        typeof raw.ruleName !== "string" ||
        typeof raw.at !== "string" ||
        typeof raw.title !== "string" ||
        typeof raw.detail !== "string" ||
        typeof raw.url !== "string"
      ) {
        continue;
      }
      const hit: MarketAlertHit = {
        id: raw.id,
        ruleId: raw.ruleId,
        ruleName: raw.ruleName,
        at: raw.at,
        kind: raw.kind === "item" || raw.kind === "baro" ? raw.kind : "riven",
        title: raw.title,
        detail: raw.detail,
        url: raw.url,
        platinum: typeof raw.platinum === "number" ? raw.platinum : null,
      };
      if (typeof raw.seller === "string") hit.seller = raw.seller;
      if (typeof raw.endoPerPlat === "number") hit.endoPerPlat = raw.endoPerPlat;
      hits.push(hit);
    }
  }
  return { schema: MARKET_ALERT_SCHEMA_VERSION, hits };
}

const stateCache = createJsonCache<PersistedState>(RULES_FILE, reviveState);
const seenCache = createJsonCache<PersistedSeen>("market-alert-seen.json", reviveSeen);
const hitsCache = createJsonCache<PersistedHits>("market-alert-hits.json", reviveHits);

let _deps: MarketAlertEngineDeps | null = null;
let _state: PersistedState | null = null;
let _seen: PersistedSeen | null = null;
let _hits: MarketAlertHit[] | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
let _startTimer: ReturnType<typeof setTimeout> | null = null;
let _stopped = false;
let _ticking = false;
let _lastTickAt: string | null = null;
let _lastError: string | null = null;
/** The rule the status line's error belongs to. Without it a failed rule that
 *  is deleted or switched off leaves an error nothing can ever clear. */
let _lastErrorRuleId: string | null = null;
let _requestTimes: number[] = [];
let _rulesRecoveredAt: string | null = null;

/** Per-rule runtime pacing; never persisted, so a restart re-evaluates soon. */
const _cooldownUntil = new Map<string, number>();
const _nextEvalAt = new Map<string, number>();
const _failureCount = new Map<string, number>();

/** A rules file the reviver rejected is kept, not overwritten: the next save
 *  would destroy it, and it is the only copy of the user's rules. */
function quarantineUnreadableRules(): void {
  const file = userDataPath(RULES_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!raw.trim()) return;
  const backup = `${file}.corrupt-${Date.now()}`;
  try {
    fs.copyFileSync(file, backup);
    _rulesRecoveredAt = new Date().toISOString();
    log.warn(`Unreadable ${RULES_FILE} copied to ${backup}; starting from an empty rule set`);
  } catch (err) {
    log.warn(`Could not quarantine ${RULES_FILE}: ${normalizeErrorMessage(err)}`);
  }
}

function state(): PersistedState {
  if (!_state) {
    _state = stateCache.read();
    if (!_state) {
      quarantineUnreadableRules();
      _state = {
        schema: MARKET_ALERT_SCHEMA_VERSION,
        rules: [],
        bindings: {},
        ownedCounts: {},
      };
    }
  }
  return _state;
}

function seen(): PersistedSeen {
  if (!_seen) _seen = seenCache.read() ?? { schema: MARKET_ALERT_SCHEMA_VERSION, seen: {} };
  return _seen;
}

function hits(): MarketAlertHit[] {
  if (!_hits) _hits = hitsCache.read()?.hits ?? [];
  return _hits;
}

function persistState(): void {
  stateCache.write(state());
}

function persistSeen(): void {
  seenCache.write(seen());
}

function persistHits(): void {
  hitsCache.write({ schema: MARKET_ALERT_SCHEMA_VERSION, hits: hits() });
}

function noteRequest(): void {
  const now = Date.now();
  _requestTimes.push(now);
  const cutoff = now - 60 * 60_000;
  while (_requestTimes.length > 0 && _requestTimes[0] <= cutoff) _requestTimes.shift();
}

async function wfmGet(path: string): Promise<unknown> {
  noteRequest();
  return wfmClient.request("GET", path, { priority: "background" });
}

// Item order books only exist on v2 now: v1 /items/{slug}/orders answers 403
// "Deprecated", which made every item rule back off forever.
async function wfmGetV2(path: string): Promise<unknown> {
  noteRequest();
  return wfmClient.requestV2("GET", path, { priority: "background" });
}

// Raw auction fields the engine reads. Parsed here instead of widening the
// shared WfmRawAuction type: an unexpected shape must degrade to a skipped
// auction, never to a thrown tick.
interface AuctionView {
  id: string;
  seller: string;
  platinum: number;
  masteryLevel: number;
  modRank: number;
  rerolls: number;
  polarity: string;
  /** No buyout price: `platinum` is the opening bid, not an asking price. */
  bidOnly: boolean;
  attributes: Array<{ urlName: string; value: number; positive: boolean }>;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function unwrapPayload(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const payload = raw.payload;
  return isRecord(payload) ? payload : null;
}

function parseAuctionViews(raw: unknown): AuctionView[] {
  const payload = unwrapPayload(raw);
  const auctions = payload?.auctions;
  if (!Array.isArray(auctions)) return [];
  const out: AuctionView[] = [];
  for (const entry of auctions) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const item = isRecord(entry.item) ? entry.item : {};
    const owner = isRecord(entry.owner) ? entry.owner : {};
    const attributes: AuctionView["attributes"] = [];
    if (Array.isArray(item.attributes)) {
      for (const attr of item.attributes) {
        if (!isRecord(attr) || typeof attr.url_name !== "string") continue;
        attributes.push({
          urlName: attr.url_name,
          value: num(attr.value),
          positive: attr.positive !== false,
        });
      }
    }
    const hasBuyout = typeof entry.buyout_price === "number" && Number.isFinite(entry.buyout_price);
    out.push({
      id: entry.id,
      seller: typeof owner.ingame_name === "string" ? owner.ingame_name : "",
      platinum: hasBuyout ? num(entry.buyout_price) : num(entry.starting_price),
      masteryLevel: num(item.mastery_level),
      modRank: num(item.mod_rank),
      rerolls: num(item.re_rolls),
      polarity: typeof item.polarity === "string" ? item.polarity.toLowerCase() : "",
      bidOnly: !hasBuyout,
      attributes,
    });
  }
  return out;
}

function buildRivenSearchPath(match: RivenAlertMatch): string {
  let path = `/auctions/search?type=riven&weapon_url_name=${encodeURIComponent(match.weaponUrlName)}`;
  // Measured on rubico 2026-09-01: repeated positive_stats keys honour only the
  // first (500 rows, all critical_chance, 199 also critical_damage) and
  // similarity is ignored at 50, 100 and absent alike; a comma list is a real
  // AND (282 rows, all both), so only an all-required rule can push one.
  if (match.requirePositive.length > 0 && (match.minSimilarityPct ?? 100) >= 100) {
    path += `&positive_stats=${encodeURIComponent(match.requirePositive.join(","))}`;
  }
  for (const stat of match.requireNegative) path += `&negative_stats=${encodeURIComponent(stat)}`;
  if (match.polarity) path += `&polarity=${match.polarity}`;
  if (match.minMasteryRank !== undefined) path += `&mastery_rank_min=${match.minMasteryRank}`;
  if (match.maxMasteryRank !== undefined) path += `&mastery_rank_max=${match.maxMasteryRank}`;
  if (match.minRerolls !== undefined) path += `&re_rolls_min=${match.minRerolls}`;
  if (match.maxRerolls !== undefined) path += `&re_rolls_max=${match.maxRerolls}`;
  return path + "&sort_by=price_asc";
}

function inBounds(value: number, min?: number, max?: number): boolean {
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

/** The attribute value a listing would show at mod rank 8. WFM serves the value
 *  at the listing's own rank and riven stats scale with (rank + 1). */
function valueAtMaxRank(value: number, modRank: number): number {
  const rank = Math.min(RIVEN_MAX_MOD_RANK, Math.max(0, Math.trunc(modRank)));
  const scaled = (value * (RIVEN_MAX_MOD_RANK + 1)) / (rank + 1);
  return Math.round(scaled * 10) / 10;
}

/** Every gate, locally, on exact url_name equality. Substring matching is the
 *  documented failure mode: critical_chance must never claim the slide slug. */
function matchRivenAuction(match: RivenAlertMatch, auction: AuctionView): boolean {
  if (auction.bidOnly && match.includeBidOnly !== true) return false;
  const positives = new Set(auction.attributes.filter((a) => a.positive).map((a) => a.urlName));
  const negatives = new Set(auction.attributes.filter((a) => !a.positive).map((a) => a.urlName));

  const requiredHits = match.requirePositive.filter((stat) => positives.has(stat)).length;
  const requiredPct =
    match.requirePositive.length > 0 ? (requiredHits / match.requirePositive.length) * 100 : 100;
  if (requiredPct < (match.minSimilarityPct ?? 100)) return false;

  for (const stat of match.requireNegative) {
    if (!negatives.has(stat)) return false;
  }
  for (const stat of match.excludeAttributes) {
    if (positives.has(stat) || negatives.has(stat)) return false;
  }
  // A tolerated-curse list bounds what a curse may be, not whether one exists;
  // a clean roll passes and hasNegative still decides if one is wanted at all.
  if (match.allowedNegatives && match.allowedNegatives.length > 0) {
    for (const stat of negatives) {
      if (!match.allowedNegatives.includes(stat)) return false;
    }
  }
  if (match.hasNegative === true && negatives.size === 0) return false;
  if (match.hasNegative === false && negatives.size > 0) return false;

  // A roll that does not carry the bounded stat cannot satisfy the bound.
  for (const bound of match.statBounds) {
    const attr = auction.attributes.find((a) => a.urlName === bound.attribute);
    if (!attr) return false;
    if (!inBounds(valueAtMaxRank(attr.value, auction.modRank), bound.min, bound.max)) return false;
  }

  if (!inBounds(auction.masteryLevel, match.minMasteryRank, match.maxMasteryRank)) return false;
  if (!inBounds(auction.modRank, match.minModRank, match.maxModRank)) return false;
  if (!inBounds(auction.platinum, match.minPlatinum, match.maxPlatinum)) return false;
  if (!inBounds(auction.rerolls, match.minRerolls, match.maxRerolls)) return false;
  if (match.polarity && auction.polarity !== match.polarity) return false;

  if (match.minEndoPerPlat !== undefined) {
    const ratio = rivenEndoPerPlat(
      auction.masteryLevel,
      auction.modRank,
      auction.rerolls,
      auction.platinum,
    );
    if (ratio === null || ratio < match.minEndoPerPlat) return false;
  }
  return true;
}

function rivenHit(rule: MarketAlertRule, auction: AuctionView): MarketAlertHit {
  const endo = rivenDissolveEndo(auction.masteryLevel, auction.modRank, auction.rerolls);
  const ratio = rivenEndoPerPlat(
    auction.masteryLevel,
    auction.modRank,
    auction.rerolls,
    auction.platinum,
  );
  const hit: MarketAlertHit = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    at: new Date().toISOString(),
    kind: "riven",
    title: `Riven: ${rule.name}`,
    // English on purpose, like every stored hit string.
    detail:
      `${auction.platinum}p${auction.bidOnly ? " starting bid" : ""} - ` +
      `MR${auction.masteryLevel} r${auction.modRank} ` +
      `${auction.rerolls} rerolls - ${endo} endo` +
      (ratio !== null ? ` (${ratio.toFixed(1)}/plat)` : ""),
    url: `https://warframe.market/auction/${auction.id}`,
    platinum: auction.platinum,
  };
  if (auction.seller) hit.seller = auction.seller;
  if (ratio !== null) hit.endoPerPlat = Math.round(ratio * 10) / 10;
  return hit;
}

interface OrderView {
  id: string;
  owner: string;
  status: string;
  side: "sell" | "buy";
  platinum: number;
  quantity: number;
}

// Reads both envelopes: v2 `{ data: [...] }` with `type` / `user.ingameName`
// is what the engine fetches; the v1 field names stay accepted for fixtures
// and for the day the endpoint is swapped again.
function parseOrderViews(raw: unknown): OrderView[] {
  const orders = extractWfmOrderList(raw);
  if (!orders) return [];
  const out: OrderView[] = [];
  for (const entry of orders) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    if (entry.visible === false) continue;
    const user = isRecord(entry.user) ? entry.user : {};
    // v2 requests carry Crossplay: true, so the answer holds console and mobile
    // sellers; only one with crossplay on can trade with a PC account. A row
    // that names no platform is kept: silencing every unlabelled order is worse.
    const platform = parseOrderPlatform(entry);
    if (platform !== null && platform !== "pc" && user.crossplay !== true) continue;
    const side = parseOrderType(entry);
    if (!side) continue;
    out.push({
      id: entry.id,
      owner: parseOrderUserName(entry),
      status: parseOrderStatus(entry) ?? "",
      side,
      platinum: num(entry.platinum),
      quantity: num(entry.quantity, 1),
    });
  }
  return out;
}

function matchItemOrder(
  match: ItemAlertMatch,
  order: OrderView,
  ownedCount: number | null,
): boolean {
  if (order.side !== match.side) return false;
  if (match.statuses.length > 0 && !(match.statuses as readonly string[]).includes(order.status)) {
    return false;
  }
  if (!inBounds(order.platinum, match.minPlatinum, match.maxPlatinum)) return false;
  if (match.minQuantity !== undefined && order.quantity < match.minQuantity) return false;
  // Owned gates fail open when no count was ever pushed: alerts must keep
  // working on a machine with no inventory source configured.
  if (ownedCount !== null) {
    if (match.ownedBelow !== undefined && ownedCount >= match.ownedBelow) return false;
    if (match.ownedAbove !== undefined && ownedCount <= match.ownedAbove) return false;
  }
  return true;
}

function itemHit(rule: MarketAlertRule, match: ItemAlertMatch, order: OrderView): MarketAlertHit {
  const verb = order.side === "sell" ? "WTS" : "WTB";
  const hit: MarketAlertHit = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    at: new Date().toISOString(),
    kind: "item",
    title: `Item: ${rule.name}`,
    detail: `${verb} ${match.itemUrlName} ${order.platinum}p x${order.quantity}`,
    url: `https://warframe.market/items/${match.itemUrlName}`,
    platinum: order.platinum,
  };
  if (order.owner) hit.seller = order.owner;
  return hit;
}

function isOwnListing(name: string): boolean {
  const own = _deps?.getOwnName() ?? null;
  return !!own && !!name && own.toLowerCase() === name.toLowerCase();
}

/** Dedup key includes the price so a real price drop on the same listing may
 *  fire again while an unchanged listing never does. */
function seenKey(id: string, platinum: number): string {
  return `${id}:${platinum}`;
}

function takeUnseen(ruleId: string, entries: Array<{ key: string }>): Set<string> {
  const bucket = seen().seen[ruleId] ?? {};
  const fresh = new Set<string>();
  for (const entry of entries) {
    if (bucket[entry.key] === undefined) fresh.add(entry.key);
  }
  return fresh;
}

function markSeen(ruleId: string, keys: string[]): void {
  const store = seen();
  const bucket = store.seen[ruleId] ?? {};
  const now = Date.now();
  for (const key of keys) bucket[key] = now;
  // TTL prune first, then a hard cap dropping the oldest entries.
  for (const [key, at] of Object.entries(bucket)) {
    if (now - at > SEEN_TTL_MS) delete bucket[key];
  }
  const remaining = Object.entries(bucket);
  if (remaining.length > SEEN_MAX_PER_RULE) {
    remaining.sort((a, b) => a[1] - b[1]);
    for (const [key] of remaining.slice(0, remaining.length - SEEN_MAX_PER_RULE)) {
      delete bucket[key];
    }
  }
  store.seen[ruleId] = bucket;
  persistSeen();
}

/** Live count from the inventory main already holds. A throw or a slug the
 *  catalog cannot resolve reads as "no live count", not as zero owned. */
async function liveOwnedCount(itemUrlName: string): Promise<number | null> {
  const read = _deps?.getLiveOwnedCount;
  if (!read) return null;
  try {
    return await read(itemUrlName);
  } catch (err) {
    log.debug(`Live owned count for ${itemUrlName} failed: ${normalizeErrorMessage(err)}`);
    return null;
  }
}

interface EvalOutcome {
  hits: MarketAlertHit[];
  /** Dedup keys, aligned with hits, so the caller can mark exactly what fired. */
  keys: string[];
  candidates: number;
}

async function evaluateRule(rule: MarketAlertRule, skipDedup: boolean): Promise<EvalOutcome> {
  if (rule.kind === "riven" && rule.riven) {
    const raw = await wfmGet(buildRivenSearchPath(rule.riven));
    const auctions = parseAuctionViews(raw).filter(
      (a) => !isOwnListing(a.seller) && matchRivenAuction(rule.riven as RivenAlertMatch, a),
    );
    const keyed = auctions.map((a) => ({ key: seenKey(a.id, a.platinum), auction: a }));
    const fresh = skipDedup ? null : takeUnseen(rule.id, keyed);
    const matched = fresh === null ? keyed : keyed.filter((k) => fresh.has(k.key));
    return {
      hits: matched.map((k) => rivenHit(rule, k.auction)),
      keys: matched.map((k) => k.key),
      candidates: auctions.length,
    };
  }
  if (rule.kind === "item" && rule.item) {
    const match = rule.item;
    const raw = await wfmGetV2(`/orders/item/${encodeURIComponent(match.itemUrlName)}`);
    const owned =
      (await liveOwnedCount(match.itemUrlName)) ?? state().ownedCounts[match.itemUrlName] ?? null;
    const orders = parseOrderViews(raw).filter(
      (o) => !isOwnListing(o.owner) && matchItemOrder(match, o, owned),
    );
    const keyed = orders.map((o) => ({ key: seenKey(o.id, o.platinum), order: o }));
    const fresh = skipDedup ? null : takeUnseen(rule.id, keyed);
    const matched = fresh === null ? keyed : keyed.filter((k) => fresh.has(k.key));
    return {
      hits: matched.map((k) => itemHit(rule, match, k.order)),
      keys: matched.map((k) => k.key),
      candidates: orders.length,
    };
  }
  // Baro rules are schema-only in this slice; they never evaluate.
  return { hits: [], keys: [], candidates: 0 };
}

function recordHits(newHits: MarketAlertHit[]): void {
  if (newHits.length === 0) return;
  const list = hits();
  list.unshift(...newHits);
  if (list.length > MARKET_ALERT_HISTORY_MAX) list.length = MARKET_ALERT_HISTORY_MAX;
  persistHits();
}

function notify(rule: MarketAlertRule, newHits: MarketAlertHit[]): void {
  const first = newHits[0];
  const extra = newHits.length > 1 ? ` (+${newHits.length - 1} more)` : "";
  const binding = state().bindings[rule.id] ?? DEFAULT_MARKET_ALERT_BINDING;
  const deliver = _deps?.deliverNative;
  dispatch(
    { source: "marketAlerts", title: first.title, body: `${first.detail}${extra}` },
    binding.native && deliver ? () => deliver(first.title, `${first.detail}${extra}`) : undefined,
  );
}

function emitChanged(): void {
  try {
    _deps?.onChanged();
  } catch (err) {
    log.debug(`Alert change push failed: ${normalizeErrorMessage(err)}`);
  }
}

/** Identity, not id: an edit replaces the rule object, so a result that started
 *  before the edit is as stale as one for a rule that was deleted. */
function isCurrentRule(rule: MarketAlertRule): boolean {
  return state().rules.includes(rule);
}

function setLastError(error: string | null, ruleId: string | null = null): void {
  if (_lastError === error && _lastErrorRuleId === ruleId) return;
  _lastError = error;
  _lastErrorRuleId = ruleId;
  emitChanged();
}

function clearLastErrorForRule(id: string): void {
  if (_lastErrorRuleId === id) setLastError(null);
}

async function runRule(rule: MarketAlertRule): Promise<void> {
  try {
    const outcome = await evaluateRule(rule, false);
    // A delete, an edit or a stop landing while the request was in flight: the
    // result must not resurrect seen buckets, hits or pacing state, and a
    // teardown must not have the seen and hits files rewritten under it.
    if (_stopped || !isCurrentRule(rule)) return;
    const now = Date.now();
    _failureCount.delete(rule.id);
    _nextEvalAt.set(rule.id, now + RULE_EVAL_INTERVAL_MS);
    setLastError(null);
    if (outcome.hits.length === 0) return;
    markSeen(rule.id, outcome.keys);
    recordHits(outcome.hits);
    notify(rule, outcome.hits);
    _cooldownUntil.set(rule.id, now + rule.cooldownMinutes * 60_000);
    emitChanged();
    log.info(`Rule "${rule.name}" fired with ${outcome.hits.length} new hit(s)`);
  } catch (err) {
    // Same teardown rule as the success path: a stop must not re-pace the rule
    // or push its error at a renderer that is going away.
    if (_stopped) return;
    const message = normalizeErrorMessage(err);
    if (!isCurrentRule(rule)) {
      setLastError(message, rule.id);
      return;
    }
    const failures = (_failureCount.get(rule.id) ?? 0) + 1;
    _failureCount.set(rule.id, failures);
    const backoff = Math.min(FAILURE_BASE_MS * 2 ** (failures - 1), FAILURE_CEILING_MS);
    _nextEvalAt.set(rule.id, Date.now() + backoff);
    setLastError(message, rule.id);
    log.warn(`Rule "${rule.name}" evaluation failed (backoff ${backoff / 1000}s): ${message}`);
  }
}

function isDue(rule: MarketAlertRule, now: number): boolean {
  if (!rule.enabled) return false;
  if (rule.kind === "baro") return false;
  if ((_cooldownUntil.get(rule.id) ?? 0) > now) return false;
  return (_nextEvalAt.get(rule.id) ?? 0) <= now;
}

async function tick(): Promise<void> {
  if (_ticking || _stopped) return;
  _ticking = true;
  try {
    _lastTickAt = new Date().toISOString();
    // The whole tick yields while the shared budget is gated or degraded;
    // background alerts must never compete with a recovering scheduler.
    if (getWfmSchedulerHealth().state !== "ok") return;
    const now = Date.now();
    // Longest-waiting first, over a snapshot: array order plus the per-tick cap
    // starved every rule past the twelfth, and the live array is spliced by a
    // delete that can land mid-tick.
    const due = state()
      .rules.filter((rule) => isDue(rule, now))
      .sort((a, b) => (_nextEvalAt.get(a.id) ?? 0) - (_nextEvalAt.get(b.id) ?? 0))
      .slice(0, MAX_REQUESTS_PER_TICK);
    for (const rule of due) {
      if (_stopped) break;
      if (!isCurrentRule(rule)) continue;
      await runRule(rule);
    }
  } finally {
    _ticking = false;
  }
}

export function initMarketAlerts(deps: MarketAlertEngineDeps): void {
  _deps = deps;
  _stopped = false;
  state();
  seen();
  hits();
  if (_timer || _startTimer) return;
  _startTimer = setTimeout(() => {
    _startTimer = null;
    void tick();
    _timer = setInterval(() => {
      void tick();
    }, TICK_MS);
  }, INITIAL_DELAY_MS);
  log.info(`Engine armed: ${state().rules.length} rule(s), tick ${TICK_MS / 1000}s`);
}

export function listMarketAlertRules(): MarketAlertListResult {
  const current = state();
  const bindings: Record<string, MarketAlertBinding> = {};
  for (const rule of current.rules) {
    bindings[rule.id] = current.bindings[rule.id] ?? { ...DEFAULT_MARKET_ALERT_BINDING };
  }
  return { rules: current.rules.map((rule) => ({ ...rule })), bindings };
}

export function saveMarketAlertRule(
  rawRule: unknown,
  rawBinding: unknown,
  ownedCount: number | null,
): MarketAlertSaveResult {
  const current = state();
  const parsed = parseMarketAlertRule(rawRule, randomUUID());
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const rule = parsed.value;

  const index = current.rules.findIndex((r) => r.id === rule.id);
  if (index < 0 && current.rules.length >= MARKET_ALERT_MAX_RULES) {
    return { ok: false, error: "rule limit reached" };
  }
  if (index >= 0) current.rules[index] = rule;
  else current.rules.push(rule);

  current.bindings[rule.id] = parseMarketAlertBinding(rawBinding);
  if (rule.kind === "item" && rule.item && ownedCount !== null) {
    current.ownedCounts[rule.item.itemUrlName] = Math.max(0, Math.trunc(ownedCount));
  }
  persistState();
  // A changed rule means new criteria; re-evaluate on the next tick. The
  // cooldown goes too, or an edit right after a fire stays silent for its rest.
  _cooldownUntil.delete(rule.id);
  _nextEvalAt.delete(rule.id);
  _failureCount.delete(rule.id);
  return { ok: true, rule };
}

export function deleteMarketAlertRule(id: string): boolean {
  const current = state();
  const index = current.rules.findIndex((r) => r.id === id);
  if (index < 0) return false;
  const [removed] = current.rules.splice(index, 1);
  delete current.bindings[id];
  // The owned-count snapshot only exists for the rules that gate on it.
  const slug = removed.item?.itemUrlName;
  if (slug && !current.rules.some((r) => r.item?.itemUrlName === slug)) {
    delete current.ownedCounts[slug];
  }
  persistState();
  const store = seen();
  if (store.seen[id]) {
    delete store.seen[id];
    persistSeen();
  }
  _cooldownUntil.delete(id);
  _nextEvalAt.delete(id);
  _failureCount.delete(id);
  clearLastErrorForRule(id);
  return true;
}

export function setMarketAlertRuleEnabled(id: string, enabled: boolean): boolean {
  const rule = state().rules.find((r) => r.id === id);
  if (!rule) return false;
  rule.enabled = enabled;
  persistState();
  // A rule switched off will not evaluate again, so its error cannot clear itself.
  if (!enabled) clearLastErrorForRule(id);
  return true;
}

export function getMarketAlertHits(): MarketAlertHit[] {
  return hits().map((hit) => ({ ...hit }));
}

export function clearMarketAlertHits(): void {
  _hits = [];
  persistHits();
}

export function getMarketAlertEngineStatus(): MarketAlertEngineStatus {
  const now = Date.now();
  _requestTimes = _requestTimes.filter((at) => now - at <= 60 * 60_000);
  const health = getWfmSchedulerHealth();
  const scheduler: MarketAlertEngineStatus["scheduler"] = {
    state: health.state,
    recentFailures: health.recentFailures,
  };
  if (health.backoffUntil !== undefined) scheduler.backoffUntil = health.backoffUntil;
  return {
    running: _timer !== null || _startTimer !== null,
    ruleCount: state().rules.length,
    enabledCount: state().rules.filter((r) => r.enabled).length,
    lastTickAt: _lastTickAt,
    requestsLastHour: _requestTimes.length,
    scheduler,
    lastError: _lastError,
    rulesRecoveredAt: _rulesRecoveredAt,
  };
}

/** Evaluates one rule now, ignoring cooldown and dedup, and sends a toast so
 *  the user can see what a fire looks like. Nothing is marked seen. */
export async function testFireMarketAlertRule(id: string): Promise<MarketAlertTestFireResult> {
  const rule = state().rules.find((r) => r.id === id);
  if (!rule) return { ok: false, error: "unknown rule" };
  if (rule.kind === "baro") return { ok: false, error: "baro rules are not evaluated yet" };
  try {
    const outcome = await evaluateRule(rule, true);
    const detail =
      outcome.hits.length > 0
        ? outcome.hits[0].detail
        : `no current matches (${outcome.candidates} listings checked)`;
    const deliver = _deps?.deliverNative;
    dispatch(
      { source: "marketAlerts", title: `Test: ${rule.name}`, body: detail },
      deliver ? () => deliver(`Test: ${rule.name}`, detail) : undefined,
    );
    return { ok: true, matches: outcome.hits.length, detail };
  } catch (err) {
    return { ok: false, error: normalizeErrorMessage(err) };
  }
}

export function exportMarketAlertRules(): string {
  return JSON.stringify(buildMarketAlertExport(state().rules), null, 2);
}

export function importMarketAlertRules(text: unknown): MarketAlertImportOutcome {
  const parsed = parseMarketAlertImport(text, () => randomUUID());
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const current = state();
  if (current.rules.length + parsed.value.length > MARKET_ALERT_MAX_RULES) {
    return { ok: false, error: "rule limit reached" };
  }
  // Imported rules arrive disabled so a shared file never starts firing (and
  // spending WFM budget) before the user has looked at it.
  for (const rule of parsed.value) {
    rule.enabled = false;
    current.rules.push(rule);
    current.bindings[rule.id] = { ...DEFAULT_MARKET_ALERT_BINDING };
  }
  persistState();
  return { ok: true, added: parsed.value.length };
}

/** Stops the loop for shutdown. A tick that lands mid-quit would write the seen
 *  and hits files while the app is tearing down, so an in-flight one bails too. */
export function stopMarketAlerts(): void {
  _stopped = true;
  if (_timer) clearInterval(_timer);
  if (_startTimer) clearTimeout(_startTimer);
  _timer = null;
  _startTimer = null;
}

/** Full teardown for tests: timers, deps and every in-memory cache. */
export function resetMarketAlertsForTest(): void {
  stopMarketAlerts();
  _stopped = false;
  _deps = null;
  _state = null;
  _seen = null;
  _hits = null;
  _ticking = false;
  _lastTickAt = null;
  _lastError = null;
  _lastErrorRuleId = null;
  _requestTimes = [];
  _rulesRecoveredAt = null;
  _cooldownUntil.clear();
  _nextEvalAt.clear();
  _failureCount.clear();
}

/** Runs one tick immediately; tests drive the loop without waiting a minute. */
export function runMarketAlertTickForTest(): Promise<void> {
  return tick();
}
