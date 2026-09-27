import { beforeEach, describe, expect, it, vi } from "vitest";

import { request } from "../../services/wfmClient";
import { searchSimilarRivens, similarListingPool } from "../../services/wfmRivenSearch";

vi.mock("../../services/wfmClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/wfmClient")>();
  return { ...actual, request: vi.fn(), requestV2: vi.fn() };
});

const requestMock = vi.mocked(request);

describe("searchSimilarRivens stat filters", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ payload: { auctions: [] } });
  });

  // WFM keeps only the first repeated positive_stats/negative_stats key, so every
  // picked stat has to travel in one comma list or the rest are silently dropped.
  it("sends every picked stat in one comma list per polarity", async () => {
    await searchSimilarRivens("rubico", {
      positiveStats: ["critical_chance", "damage"],
      negativeStats: ["zoom"],
    });

    const path = String(requestMock.mock.calls[0]?.[1]);
    expect(path).toContain("positive_stats=critical_chance%2Cdamage");
    expect(path).toContain("negative_stats=zoom");
    expect(path.match(/positive_stats=/g)).toHaveLength(1);
    expect(path.match(/negative_stats=/g)).toHaveLength(1);
  });

  it("omits the stat keys when nothing is picked", async () => {
    await searchSimilarRivens("rubico-prime");

    const path = String(requestMock.mock.calls[0]?.[1]);
    expect(path).not.toContain("positive_stats");
    expect(path).not.toContain("negative_stats");
  });
});

describe("similarListingPool", () => {
  const listing = (id: number, isDirectSell: boolean) => ({
    id: String(id),
    seller: "Fixture",
    sellerStatus: null,
    platinum: id,
    stats: [],
    rerolls: 0,
    startingPrice: isDirectSell ? null : id,
    buyoutPrice: isDirectSell ? id : null,
    isDirectSell,
  });

  it("keeps the cheapest listings and tops up direct sales hidden behind auctions", () => {
    // Cheap bidding auctions first, as price_asc returns them.
    const all = [
      ...Array.from({ length: 30 }, (_, i) => listing(i, i % 10 === 0)),
      ...Array.from({ length: 40 }, (_, i) => listing(100 + i, true)),
    ];
    const pool = similarListingPool(all, 30);

    expect(pool.slice(0, 30)).toEqual(all.slice(0, 30));
    expect(pool.filter((entry) => entry.isDirectSell)).toHaveLength(30);
    expect(pool).toHaveLength(57);
  });

  it("tops up with the cheapest direct sales even when the tail is in descending order", () => {
    // The search appends its price_desc page after price_asc without re-sorting.
    const all = [
      ...Array.from({ length: 30 }, (_, i) => listing(i, i !== 0)),
      listing(1000, true),
      listing(999, true),
    ];
    const pool = similarListingPool(all, 30);

    expect(pool.map((entry) => entry.platinum).slice(30)).toEqual([999]);
  });
});
