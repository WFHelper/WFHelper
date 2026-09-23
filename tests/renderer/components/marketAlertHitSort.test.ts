import { describe, expect, it } from "vitest";

import {
  ALERT_HIT_SORTS,
  ALERT_HIT_SORT_LABELS,
  sortAlertHits,
} from "../../../src/components/market/alerts/alertHitSort.js";
import type { MarketAlertHit } from "../../../config/shared/marketAlertTypes.js";

function hit(id: string, extra: Partial<MarketAlertHit> = {}): MarketAlertHit {
  return {
    id,
    ruleId: "rule-1",
    ruleName: "Rule",
    at: "2026-09-12T10:00:00.000Z",
    kind: "riven",
    title: "Riven: Rule",
    detail: "",
    url: `https://warframe.market/auction/${id}`,
    platinum: null,
    ...extra,
  };
}

// Newest first, the order the engine stores.
const HISTORY: MarketAlertHit[] = [
  hit("a", { platinum: 50, endo: 1000, endoPerPlat: 20 }),
  hit("b", { platinum: null, kind: "item" }),
  hit("c", { platinum: 20, endo: 600, endoPerPlat: 30 }),
  hit("d", { platinum: 50, kind: "item" }),
  hit("e", { platinum: 80, endo: 1000, endoPerPlat: 12.5 }),
  hit("f", { platinum: 20 }),
];

const ids = (list: MarketAlertHit[]): string[] => list.map((entry) => entry.id);

describe("sortAlertHits", () => {
  it("keeps the stored order for newest first and reverses it for oldest first", () => {
    expect(ids(sortAlertHits(HISTORY, "newest"))).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(ids(sortAlertHits(HISTORY, "oldest"))).toEqual(["f", "e", "d", "c", "b", "a"]);
  });

  it("orders by price both ways with missing prices last and ties newest first", () => {
    expect(ids(sortAlertHits(HISTORY, "priceAsc"))).toEqual(["c", "f", "a", "d", "e", "b"]);
    expect(ids(sortAlertHits(HISTORY, "priceDesc"))).toEqual(["e", "a", "d", "c", "f", "b"]);
  });

  it("orders by endo per plat and puts hits without it last in both directions", () => {
    expect(ids(sortAlertHits(HISTORY, "endoPerPlatDesc"))).toEqual(["c", "a", "e", "b", "d", "f"]);
    expect(ids(sortAlertHits(HISTORY, "endoPerPlatAsc"))).toEqual(["e", "a", "c", "b", "d", "f"]);
  });

  it("orders by total endo with equal totals newest first", () => {
    expect(ids(sortAlertHits(HISTORY, "endoDesc"))).toEqual(["a", "e", "c", "b", "d", "f"]);
    expect(ids(sortAlertHits(HISTORY, "endoAsc"))).toEqual(["c", "a", "e", "b", "d", "f"]);
  });

  it("treats a non-finite value as missing", () => {
    const list = [hit("x", { endo: Number.NaN }), hit("y", { endo: 5 })];
    expect(ids(sortAlertHits(list, "endoAsc"))).toEqual(["y", "x"]);
    expect(ids(sortAlertHits(list, "endoDesc"))).toEqual(["y", "x"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const before = ids(HISTORY);
    for (const sort of ALERT_HIT_SORTS) {
      const sorted = sortAlertHits(HISTORY, sort);
      expect(sorted).not.toBe(HISTORY);
      expect(sorted).toHaveLength(HISTORY.length);
    }
    expect(ids(HISTORY)).toEqual(before);
  });

  it("labels every sort", () => {
    expect(Object.keys(ALERT_HIT_SORT_LABELS).sort()).toEqual([...ALERT_HIT_SORTS].sort());
  });
});
