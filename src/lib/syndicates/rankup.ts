import { toFiniteNumber } from "../../../config/shared/numeric.js";
import type {
  SyndicateMeta,
  SyndicateSacrificeItem,
} from "../../../config/shared/syndicateTypes.js";
import type { RawInventoryData } from "../../types/inventory.js";

/** Standing gained per day at mastery rank 0, plus the per-rank bonus. */
const DAILY_CAP_BASE = 16000;
const DAILY_CAP_PER_MASTERY_RANK = 500;

export interface SyndicateStatus {
  /** DE rank; 0 means joined-but-unranked or not joined at all. */
  level: number;
  /** Rank name at the current level, empty at level 0. */
  title: string;
  standing: number;
  /** Next reachable rank, null at the top. */
  nextLevel: number | null;
  /** Standing still missing to unlock nextLevel; 0 once the tier is capped. */
  standingToNext: number;
  /** Standing band of the current rank, for a progress bar. */
  tierStart: number;
  tierEnd: number;
  initiated: boolean;
  /** Today's remaining pool for this syndicate's bin, null when unreported. */
  dailyRemaining: number | null;
}

export interface RankUpStep {
  level: number;
  title: string;
  /** Standing to earn during this step alone, so the steps sum to the total. */
  standingNeeded: number;
  credits: number;
  items: SyndicateSacrificeItem[];
  /** True when this step also pays the one-time initiation (rank 0 -> 1). */
  initiation: boolean;
}

export interface SyndicateGoalPlan {
  meta: SyndicateMeta;
  targetLevel: number;
  steps: RankUpStep[];
}

interface NeededItem {
  itemType: string;
  name: string;
  needed: number;
  owned: number;
  missing: number;
}

interface StandingNeed {
  bin: string;
  dailyField: string;
  /** Tags feeding this pool, in plan order; the six normal ones share one. */
  tags: string[];
  needed: number;
  remainingToday: number | null;
  dailyCap: number;
  daysEstimate: number;
}

interface AggregateNeeds {
  credits: { needed: number; owned: number; missing: number };
  items: NeededItem[];
  standing: StandingNeed[];
}

interface AlignmentConflict {
  a: string;
  b: string;
  factor: number;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function affiliationOf(inv: RawInventoryData | null, tag: string): Record<string, unknown> | null {
  for (const entry of asArray(inv?.Affiliations)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.Tag === tag) return record;
  }
  return null;
}

/** The same pool size applies to every standing bin. */
export function dailyStandingCap(inv: RawInventoryData | null): number {
  const masteryRank = toFiniteNumber(inv?.PlayerLevel);
  if (masteryRank === null || masteryRank < 0) return DAILY_CAP_BASE;
  return DAILY_CAP_BASE + DAILY_CAP_PER_MASTERY_RANK * Math.floor(masteryRank);
}

function titleAt(meta: SyndicateMeta, level: number): SyndicateMeta["titles"][number] | null {
  return meta.titles.find((title) => title.level === level) ?? null;
}

/** Standing at which rank `level` begins. DE lists no title for rank 0, so the
 *  aligned six enter it where rank -1 ends (-5000); everyone else starts at 0. */
function rankThreshold(meta: SyndicateMeta, level: number): number | null {
  const own = titleAt(meta, level);
  if (own) return own.minStanding;
  const below = titleAt(meta, level - 1);
  if (below) return below.maxStanding;
  return level === 0 ? 0 : null;
}

/** What the step into `level` costs. A negative title carries the price of
 *  leaving it (rank -1 lists the Forma that buys Neutral), a positive one the
 *  price of reaching it. */
function stepSacrifice(meta: SyndicateMeta, level: number) {
  return (level <= 0 ? titleAt(meta, level - 1) : titleAt(meta, level))?.sacrifice ?? null;
}

function maxLevel(meta: SyndicateMeta): number {
  return meta.titles.reduce((max, title) => Math.max(max, title.level), 0);
}

export function syndicateStatus(
  inv: RawInventoryData | null,
  meta: SyndicateMeta,
): SyndicateStatus {
  const entry = affiliationOf(inv, meta.tag);
  const level = toFiniteNumber(entry?.Title) ?? 0;
  const standing = toFiniteNumber(entry?.Standing) ?? 0;
  const nextLevel = level < maxLevel(meta) ? level + 1 : null;
  const nextThreshold = nextLevel === null ? null : rankThreshold(meta, nextLevel);
  const tierStart = rankThreshold(meta, level) ?? 0;
  const dailyRemaining = toFiniteNumber(inv?.[meta.dailyField]);

  return {
    level,
    title: titleAt(meta, level)?.name ?? "",
    standing,
    nextLevel,
    standingToNext: nextThreshold === null ? 0 : Math.max(0, nextThreshold - standing),
    tierStart,
    tierEnd: nextThreshold ?? titleAt(meta, level)?.maxStanding ?? tierStart,
    initiated: entry?.Initiated === true,
    dailyRemaining,
  };
}

function mergeItems(into: Map<string, SyndicateSacrificeItem>, items: SyndicateSacrificeItem[]) {
  for (const item of items) {
    const existing = into.get(item.itemType);
    if (existing) existing.count += item.count;
    else into.set(item.itemType, { ...item });
  }
}

/** Ordered rank-ups from the current rank up to targetLevel, one per level
 *  including the untitled rank 0. A rank-up does not consume standing, so each
 *  step only needs the gap to its own threshold: the first measures from the
 *  live standing, later ones span a full tier. */
export function planSteps(
  inv: RawInventoryData | null,
  meta: SyndicateMeta,
  targetLevel: number,
): RankUpStep[] {
  const status = syndicateStatus(inv, meta);
  const top = Math.min(targetLevel, maxLevel(meta));

  const steps: RankUpStep[] = [];
  let previousThreshold: number | null = null;
  for (let level = status.level + 1; level <= top; level++) {
    const threshold = rankThreshold(meta, level);
    if (threshold === null) continue;
    const items = new Map<string, SyndicateSacrificeItem>();
    let credits = 0;
    // Joining is paid once, on the way past rank 0, and only where DE lists it.
    const initiation = level === 1 && !status.initiated && !!meta.initiation;
    if (initiation && meta.initiation) {
      credits += meta.initiation.credits;
      mergeItems(items, meta.initiation.items);
    }
    const sacrifice = stepSacrifice(meta, level);
    if (sacrifice) {
      credits += sacrifice.credits;
      mergeItems(items, sacrifice.items);
    }

    steps.push({
      level,
      title: titleAt(meta, level)?.name ?? "",
      standingNeeded: Math.max(0, threshold - (previousThreshold ?? status.standing)),
      credits,
      items: [...items.values()],
      initiation,
    });
    previousThreshold = threshold;
  }
  return steps;
}

/** Everything the selected goals still cost: credits, items and standing per pool.
 *  `owned` is the componentOwnership map, so foundry-committed blueprints are
 *  already gone from it when the user hides foundry claims. */
export function aggregateNeeds(
  plans: readonly SyndicateGoalPlan[],
  inv: RawInventoryData | null,
  owned: ReadonlyMap<string, number>,
): AggregateNeeds {
  const dailyCap = dailyStandingCap(inv);
  const items = new Map<string, NeededItem>();
  const standing = new Map<string, StandingNeed>();
  let creditsNeeded = 0;

  for (const plan of plans) {
    let planStanding = 0;
    for (const step of plan.steps) {
      creditsNeeded += step.credits;
      planStanding += step.standingNeeded;
      for (const item of step.items) {
        const existing = items.get(item.itemType);
        if (existing) existing.needed += item.count;
        else
          items.set(item.itemType, {
            itemType: item.itemType,
            name: item.name,
            needed: item.count,
            owned: 0,
            missing: 0,
          });
      }
    }

    const pool = standing.get(plan.meta.dailyBin);
    if (pool) {
      pool.needed += planStanding;
      if (!pool.tags.includes(plan.meta.tag)) pool.tags.push(plan.meta.tag);
    } else {
      standing.set(plan.meta.dailyBin, {
        bin: plan.meta.dailyBin,
        dailyField: plan.meta.dailyField,
        tags: [plan.meta.tag],
        needed: planStanding,
        remainingToday: toFiniteNumber(inv?.[plan.meta.dailyField]),
        dailyCap,
        daysEstimate: 0,
      });
    }
  }

  for (const item of items.values()) {
    item.owned = owned.get(item.itemType) ?? 0;
    item.missing = Math.max(0, item.needed - item.owned);
  }

  for (const pool of standing.values()) {
    // An unreported pool counts as spent, so the estimate never under-promises.
    const afterToday = Math.max(0, pool.needed - (pool.remainingToday ?? 0));
    pool.daysEstimate = afterToday === 0 ? 0 : Math.ceil(afterToday / pool.dailyCap);
  }

  const creditsOwned = toFiniteNumber(inv?.RegularCredits) ?? 0;
  return {
    credits: {
      needed: creditsNeeded,
      owned: creditsOwned,
      missing: Math.max(0, creditsNeeded - creditsOwned),
    },
    items: [...items.values()].sort(
      (a, b) => b.missing - a.missing || a.name.localeCompare(b.name),
    ),
    standing: [...standing.values()],
  };
}

/** Selected syndicates that lose each other standing; only the aligned six have factors. */
export function alignmentConflicts(metas: readonly SyndicateMeta[]): AlignmentConflict[] {
  const selected = new Set(metas.map((meta) => meta.tag));
  const seen = new Set<string>();
  const conflicts: AlignmentConflict[] = [];

  for (const meta of metas) {
    for (const [other, factor] of Object.entries(meta.alignments ?? {})) {
      if (factor >= 0 || !selected.has(other)) continue;
      const key = [meta.tag, other].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ a: meta.tag, b: other, factor });
    }
  }
  return conflicts;
}
