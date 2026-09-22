import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type PreviewPart = {
  name: string;
  ownedCount: number;
  requiredCount: number;
  isReward: boolean;
  building: boolean;
};
type PreviewItem = Record<string, unknown> & {
  name: string;
  partOwnedCount: number;
  partRequiredCount: number;
  vaulted: boolean;
  setParts?: PreviewPart[];
};
type PreviewSlot = { item: PreviewItem; price: number; setPrice: number };

// Everything enrichRewardItems (ipc/overlay/scan.ts) puts on a scanned reward,
// plus the pool fields it spreads through. The editor card may carry no more.
const ENRICHED_KEYS = new Set([
  "name",
  "rarity",
  "ducats",
  "urlName",
  "uniqueName",
  "slotIndex",
  "confidence",
  "partOwnedCount",
  "partRequiredCount",
  "mastered",
  "building",
  "setOwnedCount",
  "setRequiredCount",
  "completeSetCount",
  "setParts",
  "setName",
  "setUrlName",
  "vaulted",
]);

const VARIANTS = ["mixed", "rewards", "missing"] as const;
const SLOTS = [0, 1, 2, 3] as const;

function loadPreviewSlot(): (index: number, variant: string) => PreviewSlot {
  const source = readFileSync("renderer/overlay.js", "utf8");
  return runInNewContext(`${source}\nrewardPreviewSlot;`, {
    URLSearchParams,
    window: {
      location: { search: "?mode=editor&kind=reward" },
      overlay: {},
      overlayI18n: { t: (key: string) => key },
    },
    document: { addEventListener: vi.fn(), getElementById: () => null },
    requestAnimationFrame: vi.fn(),
    getComputedStyle: () => ({}),
  }) as (index: number, variant: string) => PreviewSlot;
}

const rewardPreviewSlot = loadPreviewSlot();
const every = VARIANTS.flatMap((variant) =>
  SLOTS.map((index) => [variant, index, rewardPreviewSlot(index, variant)] as const),
);

describe("reward editor preview cards", () => {
  it.each(every)("keeps %s slot %i to properties a scan produces", (_variant, _index, slot) => {
    for (const key of Object.keys(slot.item)) expect(ENRICHED_KEYS.has(key), key).toBe(true);
    expect(typeof slot.item.vaulted).toBe("boolean");
    // A scanned reward always resolves its own owned count, set or no set.
    expect(slot.item.partRequiredCount).toBeGreaterThanOrEqual(1);
    expect(slot.item.partOwnedCount).toBeGreaterThanOrEqual(0);
  });

  it.each(every)("derives %s slot %i totals from its own parts", (_variant, _index, slot) => {
    const parts = slot.item.setParts;
    if (!parts) {
      for (const key of ["setUrlName", "setOwnedCount", "setRequiredCount", "building", "mastered"])
        expect(key in slot.item, key).toBe(false);
      return;
    }
    // warframe.market lists no set for a single-part parent, so neither may the card.
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const reward = parts.filter((part) => part.isReward);
    expect(reward).toHaveLength(1);
    expect(slot.item.partOwnedCount).toBe(reward[0].ownedCount);
    expect(slot.item.partRequiredCount).toBe(reward[0].requiredCount);
    expect("building" in slot.item).toBe(reward[0].building);
    expect(slot.item.setOwnedCount).toBe(
      parts.reduce((total, part) => total + Math.min(part.ownedCount, part.requiredCount), 0),
    );
    expect(slot.item.setRequiredCount).toBe(
      parts.reduce((total, part) => total + part.requiredCount, 0),
    );
    expect(slot.item.setUrlName).toBeTruthy();
  });

  it("stops the foundry chip from wrapping the set price onto a second row", () => {
    // The reported mismatch: the editor card claimed the foundry on every slot,
    // which the game only shows while that exact part is building.
    const slot = rewardPreviewSlot(0, "mixed");
    expect(slot.item.setParts?.[0].isReward).toBe(true);
    expect(slot.item.setParts?.[0].building).toBe(false);
    expect("building" in slot.item).toBe(false);
  });

  it("leaves Forma Blueprint without a set to price", () => {
    for (const variant of VARIANTS) {
      const slot = rewardPreviewSlot(1, variant);
      expect(slot.item.name).toBe("Forma Blueprint");
      expect(slot.item.setParts).toBeUndefined();
      expect(slot.setPrice).toBe(0);
    }
  });
});
