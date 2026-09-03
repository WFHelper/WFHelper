import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchBackendRaw: vi.fn(),
  isBackendLiteConfigured: vi.fn(() => true),
}));

vi.mock("../../../../src/lib/wfm/backendLite.js", () => ({
  fetchBackendRaw: mocks.fetchBackendRaw,
  isBackendLiteConfigured: mocks.isBackendLiteConfigured,
}));
vi.mock("../../../../src/lib/log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  bonusTier,
  codaItemsForBatch,
  loadAdversaryVendors,
  parseAdversaryVendorsDoc,
  resetAdversaryVendorsCacheForTest,
  vendorBonusLookup,
} from "../../../../src/lib/world/adversaryVendors.js";

const STORAGE_KEY = "wf_adversary_vendors_v1";
const NOW = Date.parse("2026-09-03T06:35:00.000Z");

function stubStorage(seed: Record<string, string> = {}): Map<string, string> {
  const mem = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
  });
  return mem;
}

function validDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    generatedAt: NOW,
    source: "wiki",
    coda: {
      batch: "B",
      items: [
        { name: "Coda Bassocyst", element: "Magnetic", bonus: 25.5 },
        { name: "Coda Bubonico", element: "Toxin", bonus: 43.7 },
      ],
    },
    codaNext: {
      batch: "A",
      items: [{ name: "Coda Catabolyst", element: "Radiation", bonus: 30.5 }],
    },
    tenet: {
      items: [
        { name: "Tenet Livia", element: "Heat", bonus: 42.1 },
        { name: "Tenet Ferrox", element: "Radiation", bonus: 25 },
      ],
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return {
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  resetAdversaryVendorsCacheForTest();
  mocks.fetchBackendRaw.mockReset();
  mocks.isBackendLiteConfigured.mockReturnValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseAdversaryVendorsDoc", () => {
  it("accepts the worker payload and keeps both batches", () => {
    const doc = parseAdversaryVendorsDoc(validDoc());

    expect(doc?.generatedAt).toBe(NOW);
    expect(doc?.coda).toEqual({
      batch: "B",
      items: [
        { name: "Coda Bassocyst", element: "Magnetic", bonus: 25.5 },
        { name: "Coda Bubonico", element: "Toxin", bonus: 43.7 },
      ],
    });
    expect(doc?.codaNext?.batch).toBe("A");
    expect(doc?.tenet).toHaveLength(2);
  });

  it("rejects a non-object, a missing timestamp and an empty payload", () => {
    expect(parseAdversaryVendorsDoc(null)).toBeNull();
    expect(parseAdversaryVendorsDoc([])).toBeNull();
    expect(parseAdversaryVendorsDoc(validDoc({ generatedAt: 0 }))).toBeNull();
    expect(parseAdversaryVendorsDoc(validDoc({ generatedAt: "today" }))).toBeNull();
    expect(
      parseAdversaryVendorsDoc({ generatedAt: NOW, coda: null, codaNext: null, tenet: null }),
    ).toBeNull();
  });

  it("drops rows with an unknown element, a bad bonus or an overlong name", () => {
    const doc = parseAdversaryVendorsDoc(
      validDoc({
        coda: {
          batch: "B",
          items: [
            { name: "Coda Bassocyst", element: "Kinetic", bonus: 25.5 },
            { name: "Coda Bubonico", element: "Toxin", bonus: 140 },
            { name: "Coda Synapse", element: "Magnetic", bonus: Number.NaN },
            { name: "n".repeat(61), element: "Cold", bonus: 30 },
            { name: "Coda Tysis", element: "impact", bonus: -1 },
            { name: "Coda Hirudo", element: " toxin ", bonus: 37.24 },
          ],
        },
      }),
    );

    // The element is normalised back to its canonical spelling and the bonus rounded.
    expect(doc?.coda.items).toEqual([{ name: "Coda Hirudo", element: "Toxin", bonus: 37.2 }]);
  });

  it("keeps the tenet stock when the coda batch is unusable", () => {
    const doc = parseAdversaryVendorsDoc(validDoc({ coda: { batch: "C", items: [] } }));

    expect(doc?.coda.items).toEqual([]);
    expect(doc?.tenet).toHaveLength(2);
  });
});

describe("codaItemsForBatch", () => {
  it("prefers the matching batch and falls back to the next one", () => {
    const doc = parseAdversaryVendorsDoc(validDoc());

    expect(codaItemsForBatch(doc, "B").map((item) => item.name)).toEqual([
      "Coda Bassocyst",
      "Coda Bubonico",
    ]);
    // A stale edge copy can name the other batch; the app's own clock decides.
    expect(codaItemsForBatch(doc, "A").map((item) => item.name)).toEqual(["Coda Catabolyst"]);
    expect(codaItemsForBatch(null, "A")).toEqual([]);
  });

  it("shows nothing rather than the wrong batch when neither matches", () => {
    const doc = parseAdversaryVendorsDoc(validDoc({ codaNext: null }));

    expect(codaItemsForBatch(doc, "A")).toEqual([]);
  });
});

describe("vendorBonusLookup and bonusTier", () => {
  it("keys weapons case-insensitively", () => {
    const doc = parseAdversaryVendorsDoc(validDoc());
    const lookup = vendorBonusLookup(doc?.tenet ?? []);

    expect(lookup.get("tenet livia")?.bonus).toBe(42.1);
    expect(lookup.get("Tenet Livia")).toBeUndefined();
  });

  it("splits the wiki bonus tiers at 30 and 40", () => {
    expect(bonusTier(29.9)).toBe("low");
    expect(bonusTier(30)).toBe("mid");
    expect(bonusTier(39.9)).toBe("mid");
    expect(bonusTier(40)).toBe("high");
  });
});

describe("loadAdversaryVendors", () => {
  it("fetches once, caches in memory and stores the copy with its etag", async () => {
    const store = stubStorage();
    mocks.fetchBackendRaw.mockResolvedValue(jsonResponse(validDoc(), { etag: '"abc-1-B"' }));

    const first = await loadAdversaryVendors();
    const second = await loadAdversaryVendors();

    expect(first?.coda.items).toHaveLength(2);
    expect(second).toBe(first);
    expect(mocks.fetchBackendRaw).toHaveBeenCalledTimes(1);
    expect(mocks.fetchBackendRaw).toHaveBeenCalledWith("/v1/adversary-vendors", {
      timeoutMs: 8000,
      headers: {},
    });
    const stored = JSON.parse(store.get(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored).toMatchObject({ savedAt: NOW, etag: '"abc-1-B"' });
  });

  it("serves a copy younger than an hour without a request", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({ savedAt: NOW - 60_000, etag: null, doc: validDoc() }),
    });

    expect((await loadAdversaryVendors())?.coda.batch).toBe("B");
    expect(mocks.fetchBackendRaw).not.toHaveBeenCalled();
  });

  it("revalidates an older copy and keeps it on 304", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: NOW - 2 * 60 * 60 * 1000,
        etag: '"abc-1-B"',
        doc: validDoc(),
      }),
    });
    mocks.fetchBackendRaw.mockResolvedValue({ status: 304 } as unknown as Response);

    expect((await loadAdversaryVendors())?.tenet).toHaveLength(2);
    expect(mocks.fetchBackendRaw).toHaveBeenCalledWith("/v1/adversary-vendors", {
      timeoutMs: 8000,
      headers: { "If-None-Match": '"abc-1-B"' },
    });
  });

  it("keeps the stored copy when the backend is unreachable or answers 404", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: NOW - 2 * 60 * 60 * 1000,
        etag: null,
        doc: validDoc(),
      }),
    });
    mocks.fetchBackendRaw.mockResolvedValue(null);

    expect((await loadAdversaryVendors())?.coda.items).toHaveLength(2);

    resetAdversaryVendorsCacheForTest();
    mocks.fetchBackendRaw.mockResolvedValue(
      jsonResponse({ ok: false, error: "adversary_vendors_not_ready" }),
    );

    expect((await loadAdversaryVendors())?.coda.items).toHaveLength(2);
  });

  it("returns null when the copy aged out and the backend has nothing", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: NOW - 25 * 60 * 60 * 1000,
        etag: null,
        doc: validDoc(),
      }),
    });
    mocks.fetchBackendRaw.mockResolvedValue(null);

    expect(await loadAdversaryVendors()).toBeNull();
  });

  it("makes no request when the backend is not configured", async () => {
    stubStorage();
    mocks.isBackendLiteConfigured.mockReturnValue(false);

    expect(await loadAdversaryVendors()).toBeNull();
    expect(mocks.fetchBackendRaw).not.toHaveBeenCalled();
  });
});

describe("stored copy shape", () => {
  it("keeps the tenet rows when the parsed doc is parsed again", async () => {
    const { parseAdversaryVendorsDoc } =
      await import("../../../../src/lib/world/adversaryVendors.js");
    const first = parseAdversaryVendorsDoc({
      generatedAt: 5,
      coda: { batch: "A", items: [{ name: "Coda Hema", element: "Magnetic", bonus: 28.9 }] },
      tenet: { items: [{ name: "Tenet Livia", element: "Heat", bonus: 42.1 }] },
    });
    expect(first?.tenet).toHaveLength(1);
    const again = parseAdversaryVendorsDoc(JSON.parse(JSON.stringify(first)));
    expect(again?.tenet).toEqual(first?.tenet);
  });
});
