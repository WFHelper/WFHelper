import { beforeEach, describe, expect, it, vi } from "vitest";

import { request } from "../../services/wfmClient";
import { searchSimilarRivens } from "../../services/wfmRivenSearch";

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
