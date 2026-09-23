import type { MissionRewardItem } from "../config/shared/missionRewardsTypes";

/** New entries here are builds, research or trade offers in progress, not items received. */
const NON_REWARD_UNIQUE_ARRAYS: ReadonlySet<string> = new Set([
  "PendingRecipes",
  "PendingTrades",
  "PersonalTechProjects",
]);

/** The parts of a raw inventory a mission can add to. */
export interface InventoryRewardSnapshot {
  stacks: ReadonlyMap<string, number>;
  uniqueIds: ReadonlyMap<string, string>;
  credits: number;
  endo: number;
}

interface MissionRewardDelta {
  items: MissionRewardItem[];
  credits: number;
  endo: number;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function itemIdOf(entry: Record<string, unknown>): string | null {
  const id = entry.ItemId;
  if (typeof id === "string") return id || null;
  if (id && typeof id === "object") {
    const oid = (id as Record<string, unknown>).$oid;
    if (typeof oid === "string" && oid) return oid;
  }
  return null;
}

/** Stack counts summed per uniqueName across every ItemType + ItemCount array,
 *  and every ItemId-keyed entry of the other arrays. */
export function snapshotInventory(inventory: unknown): InventoryRewardSnapshot | null {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return null;
  const record = inventory as Record<string, unknown>;
  const stacks = new Map<string, number>();
  const uniqueIds = new Map<string, string>();

  for (const [arrayName, value] of Object.entries(record)) {
    if (!Array.isArray(value)) continue;
    const countsUniques = !NON_REWARD_UNIQUE_ARRAYS.has(arrayName);
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const uniqueName = item.ItemType;
      if (typeof uniqueName !== "string" || !uniqueName) continue;
      if (typeof item.ItemCount === "number") {
        if (Number.isFinite(item.ItemCount)) {
          stacks.set(uniqueName, (stacks.get(uniqueName) ?? 0) + item.ItemCount);
        }
        continue;
      }
      if (!countsUniques) continue;
      const id = itemIdOf(item);
      if (id) uniqueIds.set(id, uniqueName);
    }
  }

  return {
    stacks,
    uniqueIds,
    credits: finiteNumber(record.RegularCredits),
    endo: finiteNumber(record.FusionPoints),
  };
}

/** Gains only: anything spent, sold or consumed between the reads is ignored. */
export function diffInventorySnapshots(
  before: InventoryRewardSnapshot,
  after: InventoryRewardSnapshot,
): MissionRewardDelta {
  const gained = new Map<string, number>();
  for (const [uniqueName, count] of after.stacks) {
    const delta = count - (before.stacks.get(uniqueName) ?? 0);
    if (delta > 0) gained.set(uniqueName, delta);
  }
  for (const [id, uniqueName] of after.uniqueIds) {
    if (!before.uniqueIds.has(id)) gained.set(uniqueName, (gained.get(uniqueName) ?? 0) + 1);
  }

  const items = [...gained]
    .map(([uniqueName, count]) => ({ uniqueName, count }))
    .sort((a, b) => (a.uniqueName < b.uniqueName ? -1 : a.uniqueName > b.uniqueName ? 1 : 0));

  return {
    items,
    credits: Math.max(0, after.credits - before.credits),
    endo: Math.max(0, after.endo - before.endo),
  };
}
