import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchBackendRaw: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("../../../src/lib/ipc.js", () => ({ invoke: mocks.invoke }));
vi.mock("../../../src/lib/wfm/backendLite.js", () => ({
  fetchBackendRaw: mocks.fetchBackendRaw,
  isBackendLiteConfigured: () => true,
}));
vi.mock("../../../src/lib/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { tryLoadSnapshot } from "../../../src/lib/wfm/snapshotLoader.js";
import { getCachedPriceState } from "../../../src/lib/wfm/priceCache.js";
import {
  importSetCatalogFromSnapshotMeta,
  resolveSnapshotSetSlug,
} from "../../../src/lib/wfm/wfmItemMeta.js";

function completeSetMeta(now: number) {
  return Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => {
      const slug = `cached_${index}_set`;
      return [
        slug,
        {
          slug,
          ducats: null,
          setRoot: true,
          thumb: null,
          icon: null,
          timestamp: now - 24 * 60 * 60 * 1000,
        },
      ];
    }),
  );
}

afterEach(() => {
  mocks.fetchBackendRaw.mockReset();
  mocks.invoke.mockReset();
  importSetCatalogFromSnapshotMeta({});
});

describe("snapshot set-catalog fallback", () => {
  it("refreshes legacy prices even on fresh disk snapshots and keeps their catalog", async () => {
    const now = Date.now();
    const meta = completeSetMeta(now);
    mocks.invoke.mockResolvedValue({
      version: 1,
      generatedAt: now,
      prices: { legacy_item: { status: "ok", median: 999, timestamp: now } },
      meta,
      orderSummaries: {},
    });
    mocks.fetchBackendRaw.mockResolvedValue(null);

    await tryLoadSnapshot();

    expect(mocks.fetchBackendRaw).toHaveBeenCalledOnce();
    expect(getCachedPriceState("legacy_item")).toBeNull();
    expect(resolveSnapshotSetSlug([Object.keys(meta)[0]])).toBe(Object.keys(meta)[0]);
  });
  it("restores a stale last-good catalog when the backend is unavailable", async () => {
    const now = Date.now();
    const meta = completeSetMeta(now);
    const firstSlug = Object.keys(meta)[0];
    mocks.invoke.mockResolvedValue({
      version: 1,
      generatedAt: now - 3 * 60 * 60 * 1000,
      prices: {},
      meta,
      orderSummaries: {},
    });
    mocks.fetchBackendRaw.mockResolvedValue(null);

    await tryLoadSnapshot();

    expect(resolveSnapshotSetSlug([firstSlug])).toBe(firstSlug);
    expect(resolveSnapshotSetSlug(["seer_set"])).toBeNull();
  });
});
