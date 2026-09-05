import { toMarketSlug } from "../../../lib/marketNaming.js";
import { titleFromSlug } from "../../../../config/shared/wfm.js";
import type { MarketAlertRule } from "../../../../config/shared/marketAlertTypes.js";
import type { MessageKey } from "../../../lib/i18n.js";
import type { ItemDbEntry } from "../../../types/inventory.js";
import type { RivenStatOption, WfmItemsLookup } from "../../../types/ipc.js";

interface ThumbEntry {
  thumb: string | null;
  name: string | null;
}

/** Product categories a riven can roll for. A mod or blueprint sharing the
 *  weapon's name must not win the thumbnail. */
const RIVEN_WEAPON_CATEGORIES = new Set([
  "LongGuns",
  "Pistols",
  "Melee",
  "SpaceGuns",
  "SpaceMelee",
  "SentinelWeapons",
]);

// "Ack & Brunt" folds to ack_brunt here while warframe.market slugs it
// ack_and_brunt, so both spellings go into the index.
function slugKeys(name: string): string[] {
  const base = toMarketSlug(name);
  const expanded = toMarketSlug(name.replace(/&/g, " and "));
  const keys = base ? [base] : [];
  if (expanded && expanded !== base) keys.push(expanded);
  return keys;
}

let weaponIndexSource: Record<string, ItemDbEntry> | null = null;
let weaponIndex = new Map<string, ThumbEntry>();

// Identity-cached: the item database is thousands of entries and the grid asks
// once per card on every store push.
function itemDbIndex(itemDb: Record<string, ItemDbEntry>): Map<string, ThumbEntry> {
  if (itemDb === weaponIndexSource) return weaponIndex;
  const weapons = new Map<string, ThumbEntry>();
  const others = new Map<string, ThumbEntry>();
  for (const entry of Object.values(itemDb)) {
    if (!entry.name) continue;
    const value: ThumbEntry = {
      thumb: typeof entry.imageUrl === "string" && entry.imageUrl ? entry.imageUrl : null,
      name: entry.displayName || entry.name,
    };
    const target = RIVEN_WEAPON_CATEGORIES.has(entry.productCategory ?? "") ? weapons : others;
    for (const key of slugKeys(entry.name)) {
      const existing = target.get(key);
      if (!existing) target.set(key, value);
      else if (!existing.thumb && value.thumb) existing.thumb = value.thumb;
    }
  }
  for (const [key, value] of others) if (!weapons.has(key)) weapons.set(key, value);
  weaponIndexSource = itemDb;
  weaponIndex = weapons;
  return weapons;
}

let catalogIndexSource: WfmItemsLookup | null = null;
let catalogIndex = new Map<string, ThumbEntry>();

function wfmIndex(wfmItems: WfmItemsLookup): Map<string, ThumbEntry> {
  if (wfmItems === catalogIndexSource) return catalogIndex;
  const index = new Map<string, ThumbEntry>();
  for (const entry of Object.values(wfmItems)) {
    const slug = toMarketSlug(entry.url_name);
    if (!slug || index.has(slug)) continue;
    index.set(slug, { thumb: entry.thumb || entry.icon || null, name: entry.item_name ?? null });
  }
  catalogIndexSource = wfmItems;
  catalogIndex = index;
  return index;
}

function ruleSlug(rule: MarketAlertRule): string {
  const raw = rule.riven?.weaponUrlName ?? rule.item?.itemUrlName ?? rule.baro?.itemUrlName ?? "";
  return toMarketSlug(raw);
}

// Riven rules name a weapon, so the item database wins; item and baro rules name
// a catalog slug, so the warframe.market thumbnail wins. Each falls back to the
// other before giving up.
function lookup(
  rule: MarketAlertRule,
  itemDb: Record<string, ItemDbEntry>,
  wfmItems: WfmItemsLookup,
): ThumbEntry | null {
  const slug = ruleSlug(rule);
  if (!slug) return null;
  const dbHit = itemDbIndex(itemDb).get(slug) ?? null;
  const wfmHit = wfmIndex(wfmItems).get(slug) ?? null;
  const [first, second] = rule.kind === "riven" ? [dbHit, wfmHit] : [wfmHit, dbHit];
  if (!first) return second;
  if (first.thumb) return first;
  return second?.thumb ? { thumb: second.thumb, name: first.name ?? second.name } : first;
}

/** Card thumbnail for a rule; null when nothing resolves, never a guessed URL. */
export function resolveAlertThumb(
  rule: MarketAlertRule,
  itemDb: Record<string, ItemDbEntry>,
  wfmItems: WfmItemsLookup,
): string | null {
  return lookup(rule, itemDb, wfmItems)?.thumb ?? null;
}

/** Display name of what the rule watches, falling back to the slug's title. */
export function resolveAlertTarget(
  rule: MarketAlertRule,
  itemDb: Record<string, ItemDbEntry>,
  wfmItems: WfmItemsLookup,
): string {
  const slug = ruleSlug(rule);
  if (!slug) return rule.name;
  return lookup(rule, itemDb, wfmItems)?.name || titleFromSlug(slug);
}

export function statLabel(urlName: string, options: RivenStatOption[]): string {
  return (
    options.find((option) => option.wfmUrlName === urlName)?.displayName ?? titleFromSlug(urlName)
  );
}

interface AlertChip {
  id: string;
  /** Explains the bare number the chip shows; resolved at the use site. */
  titleKey: MessageKey;
  labelKey?: MessageKey;
  text?: string;
  /** Translated chip value, for chips whose value is a word rather than a number. */
  textKey?: MessageKey;
  icon?: "platinum" | "endo";
  polarity?: string;
}

function rangeText(min: number | undefined, max: number | undefined): string | null {
  if (min !== undefined && max !== undefined) return min === max ? `${min}` : `${min}-${max}`;
  if (max !== undefined) return `<=${max}`;
  if (min !== undefined) return `>=${min}`;
  return null;
}

/** The criteria a rule actually sets, in card order. Unset bounds are dropped so
 *  a card never shows a filter the engine is not applying. */
export function criteriaChips(rule: MarketAlertRule): AlertChip[] {
  const chips: AlertChip[] = [];
  const riven = rule.riven;
  if (riven) {
    const plat = rangeText(riven.minPlatinum, riven.maxPlatinum);
    if (plat) chips.push({ id: "plat", titleKey: "common.platinum", text: plat, icon: "platinum" });
    if (riven.minSimilarityPct !== undefined) {
      chips.push({
        id: "similarity",
        titleKey: "marketAlerts.similarity",
        labelKey: "marketAlerts.matchShort",
        text: `>=${riven.minSimilarityPct}%`,
      });
    }
    const mastery = rangeText(riven.minMasteryRank, riven.maxMasteryRank);
    if (mastery) {
      chips.push({ id: "mastery", titleKey: "marketAlerts.masteryRank", text: `MR ${mastery}` });
    }
    const modRank = rangeText(riven.minModRank, riven.maxModRank);
    if (modRank) {
      chips.push({
        id: "modRank",
        titleKey: "common.rank",
        labelKey: "common.rank",
        text: modRank,
      });
    }
    const rerolls = rangeText(riven.minRerolls, riven.maxRerolls);
    if (rerolls) {
      chips.push({
        id: "rerolls",
        titleKey: "common.rerolls",
        labelKey: "common.rerolls",
        text: rerolls,
      });
    }
    if (riven.minEndoPerPlat !== undefined) {
      chips.push({
        id: "endo",
        titleKey: "marketAlerts.minEndoPerPlat",
        text: `>=${Math.round(riven.minEndoPerPlat * 10) / 10}`,
        icon: "endo",
      });
    }
    if (riven.polarity) {
      chips.push({
        id: "polarity",
        titleKey: "marketAlerts.polarity",
        labelKey: "marketAlerts.polarity",
        polarity: riven.polarity,
      });
    }
    if (riven.hasNegative !== undefined) {
      // "Required" alone says nothing about what is required, so the chip names
      // the criterion and carries the answer as its value.
      chips.push({
        id: "curse",
        titleKey: "marketAlerts.curse",
        labelKey: "marketAlerts.curse",
        textKey: riven.hasNegative ? "marketAlerts.curseRequired" : "marketAlerts.curseForbidden",
      });
    }
  }

  const item = rule.item;
  if (item) {
    // Trade shorthand, English on every client.
    chips.push({
      id: "side",
      titleKey: "common.orderType",
      text: item.side === "buy" ? "WTB" : "WTS",
    });
    const plat = rangeText(item.minPlatinum, item.maxPlatinum);
    if (plat) chips.push({ id: "plat", titleKey: "common.platinum", text: plat, icon: "platinum" });
    if (item.minQuantity !== undefined) {
      chips.push({ id: "qty", titleKey: "marketAlerts.minQuantity", text: `x${item.minQuantity}` });
    }
    for (const status of item.statuses) {
      chips.push({
        id: `status-${status}`,
        titleKey: "marketAlerts.sellerStatus",
        labelKey: status === "ingame" ? "common.inGame" : "common.online",
      });
    }
    if (item.ownedBelow !== undefined) {
      chips.push({
        id: "ownedBelow",
        titleKey: "marketAlerts.ownedBelow",
        labelKey: "common.owned",
        text: `<${item.ownedBelow}`,
      });
    }
    if (item.ownedAbove !== undefined) {
      chips.push({
        id: "ownedAbove",
        titleKey: "marketAlerts.ownedAbove",
        labelKey: "common.owned",
        text: `>${item.ownedAbove}`,
      });
    }
  }

  const baro = rule.baro;
  if (baro) {
    if (baro.maxDucats !== undefined) {
      chips.push({
        id: "ducats",
        titleKey: "common.ducats",
        labelKey: "common.ducats",
        text: `<=${baro.maxDucats}`,
      });
    }
    if (baro.maxCredits !== undefined) {
      chips.push({
        id: "credits",
        titleKey: "common.credits",
        labelKey: "common.credits",
        text: `<=${baro.maxCredits}`,
      });
    }
  }
  return chips;
}
