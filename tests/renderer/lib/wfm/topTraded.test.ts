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
  loadTopTraded,
  parseTopTradedDoc,
  resetTopTradedCacheForTest,
} from "../../../../src/lib/wfm/topTraded.js";

const STORAGE_KEY = "wf_top_traded_v1";
const NOW = Date.parse("2026-09-02T09:00:00.000Z");

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
    generatedAt: NOW,
    windowDays: 7,
    items: [
      {
        slug: "alpha",
        name: "Alpha Prime Set",
        volume: 70,
        median: 12,
        value: 840,
        thumb: "a.png",
      },
      { slug: "beta", name: "Beta Prime Set", volume: 14, median: 200, value: 2800 },
    ],
    byValue: ["beta", "alpha"],
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
  resetTopTradedCacheForTest();
  mocks.fetchBackendRaw.mockReset();
  mocks.isBackendLiteConfigured.mockReturnValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseTopTradedDoc", () => {
  it("accepts a well formed doc and normalizes the rows", () => {
    const doc = parseTopTradedDoc(validDoc());

    expect(doc).toEqual({
      generatedAt: NOW,
      windowDays: 7,
      items: [
        {
          slug: "alpha",
          name: "Alpha Prime Set",
          volume: 70,
          median: 12,
          value: 840,
          thumb: "a.png",
        },
        { slug: "beta", name: "Beta Prime Set", volume: 14, median: 200, value: 2800 },
      ],
      byValue: ["beta", "alpha"],
    });
    // A row with no art carries no key at all, the shape the worker publishes.
    expect(doc?.items[1] && "thumb" in doc.items[1]).toBe(false);
  });

  it("rejects a non-object, a missing timestamp and an implausible window", () => {
    expect(parseTopTradedDoc(null)).toBeNull();
    expect(parseTopTradedDoc([])).toBeNull();
    expect(parseTopTradedDoc(validDoc({ generatedAt: 0 }))).toBeNull();
    expect(parseTopTradedDoc(validDoc({ generatedAt: "yesterday" }))).toBeNull();
    expect(parseTopTradedDoc(validDoc({ windowDays: 4000 }))).toBeNull();
  });

  it("rejects an oversize item list outright", () => {
    const items = Array.from({ length: 101 }, (_unused, index) => ({
      slug: `slug_${index}`,
      name: `Item ${index}`,
      volume: 1,
      median: 1,
      value: 1,
    }));

    expect(parseTopTradedDoc(validDoc({ items, byValue: [] }))).toBeNull();
  });

  it("drops rows with non-finite or non-positive numbers and bad slugs", () => {
    const doc = parseTopTradedDoc(
      validDoc({
        items: [
          { slug: "alpha", name: "Alpha", volume: Number.NaN, median: 12, value: 1 },
          { slug: "beta", name: "Beta", volume: 5, median: Number.POSITIVE_INFINITY, value: 1 },
          { slug: "gamma", name: "Gamma", volume: 0, median: 12, value: 1 },
          { slug: "../secret", name: "Bad", volume: 5, median: 5, value: 25 },
          { slug: "delta", name: "Delta", volume: 5, median: 5 },
        ],
        byValue: ["delta", "ghost"],
      }),
    );

    expect(doc?.items.map((item) => item.slug)).toEqual(["delta"]);
    // A missing value falls back to volume * median, and byValue keeps only known slugs.
    expect(doc?.items[0]?.value).toBe(25);
    expect(doc?.byValue).toEqual(["delta"]);
  });

  it("caps name and thumb length and drops duplicate slugs", () => {
    const doc = parseTopTradedDoc(
      validDoc({
        items: [
          {
            slug: "alpha",
            name: "n".repeat(500),
            volume: 2,
            median: 2,
            value: 4,
            thumb: "t".repeat(500),
          },
          { slug: "alpha", name: "duplicate", volume: 9, median: 9, value: 81 },
        ],
        byValue: [],
      }),
    );

    expect(doc?.items).toHaveLength(1);
    expect(doc?.items[0]?.name).toHaveLength(120);
    expect(doc?.items[0]?.thumb).toHaveLength(300);
  });

  it("returns null when every row is unusable", () => {
    expect(parseTopTradedDoc(validDoc({ items: [{ slug: "alpha" }] }))).toBeNull();
    expect(parseTopTradedDoc(validDoc({ items: "nope" }))).toBeNull();
  });
});

describe("loadTopTraded", () => {
  it("fetches once, caches in memory and stores the copy with its etag", async () => {
    const store = stubStorage();
    mocks.fetchBackendRaw.mockResolvedValue(jsonResponse(validDoc(), { etag: '"abc-1"' }));

    const first = await loadTopTraded();
    const second = await loadTopTraded();

    expect(first?.items).toHaveLength(2);
    expect(second).toBe(first);
    expect(mocks.fetchBackendRaw).toHaveBeenCalledTimes(1);
    expect(mocks.fetchBackendRaw).toHaveBeenCalledWith("/v1/top-traded", expect.anything());
    const stored = JSON.parse(store.get(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored).toMatchObject({ savedAt: NOW, etag: '"abc-1"' });
  });

  it("serves a copy younger than an hour without a request", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({ savedAt: NOW - 60_000, etag: '"abc-1"', doc: validDoc() }),
    });

    const doc = await loadTopTraded();

    expect(doc?.items).toHaveLength(2);
    expect(mocks.fetchBackendRaw).not.toHaveBeenCalled();
  });

  it("revalidates an older copy and keeps it on 304", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: NOW - 2 * 60 * 60 * 1000,
        etag: '"abc-1"',
        doc: validDoc(),
      }),
    });
    mocks.fetchBackendRaw.mockResolvedValue({ status: 304 } as unknown as Response);

    const doc = await loadTopTraded();

    expect(doc?.items).toHaveLength(2);
    expect(mocks.fetchBackendRaw).toHaveBeenCalledWith("/v1/top-traded", {
      timeoutMs: 8000,
      headers: { "If-None-Match": '"abc-1"' },
    });
  });

  it("ignores a stored copy older than a day and falls back to null on a failed fetch", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: NOW - 25 * 60 * 60 * 1000,
        etag: '"abc-1"',
        doc: validDoc(),
      }),
    });
    mocks.fetchBackendRaw.mockResolvedValue(null);

    const doc = await loadTopTraded();

    expect(doc).toBeNull();
    expect(mocks.fetchBackendRaw).toHaveBeenCalledWith("/v1/top-traded", {
      timeoutMs: 8000,
      headers: {},
    });
  });

  it("keeps the stored copy when the backend answers with an unusable body", async () => {
    stubStorage({
      [STORAGE_KEY]: JSON.stringify({
        savedAt: NOW - 2 * 60 * 60 * 1000,
        etag: null,
        doc: validDoc(),
      }),
    });
    mocks.fetchBackendRaw.mockResolvedValue(jsonResponse({ ok: false, error: "not_ready" }));

    const doc = await loadTopTraded();

    expect(doc?.items).toHaveLength(2);
  });

  it("makes no request when the backend is not configured", async () => {
    stubStorage();
    mocks.isBackendLiteConfigured.mockReturnValue(false);

    expect(await loadTopTraded()).toBeNull();
    expect(mocks.fetchBackendRaw).not.toHaveBeenCalled();
  });
});
