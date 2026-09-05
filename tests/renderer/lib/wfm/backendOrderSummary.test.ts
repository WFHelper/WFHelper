import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BACKEND_URL = "https://backend.test";
const originalFetch = globalThis.fetch;

function toUrl(input: Request | URL | string): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function summaryResponse(): Response {
  return new Response(
    JSON.stringify({ ok: true, data: { slug: "lith_a1_relic", wts: 12, wtb: 8 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function captureUrls(): { urls: string[]; fetchMock: ReturnType<typeof vi.fn> } {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: Request | URL | string) => {
    urls.push(toUrl(input));
    return summaryResponse();
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { urls, fetchMock };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.stubEnv("VITE_WFM_BACKEND_URL", BACKEND_URL);
  vi.stubEnv("VITE_WFM_BACKEND_BOOTSTRAP_ENABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe("backend order-summary subtype", () => {
  it("keeps a real refinement on the query", async () => {
    const { urls } = captureUrls();
    const { fetchBackendOrderSummaryBySlug } =
      await import("../../../../src/lib/wfm/backendLite.js");
    await fetchBackendOrderSummaryBySlug("lith_a1_relic", { subtype: " Radiant " });
    expect(urls[0]).toBe(`${BACKEND_URL}/v1/order-summary/lith_a1_relic?subtype=radiant`);
  });

  // The worker's allowlist holds only the four refinements, so "regular" would
  // come back 400 instead of falling through to the plain summary.
  it("drops the default 'regular' subtype instead of sending it", async () => {
    const { urls } = captureUrls();
    const { fetchBackendOrderSummaryBySlug } =
      await import("../../../../src/lib/wfm/backendLite.js");
    await fetchBackendOrderSummaryBySlug("lith_a1_relic", { subtype: "Regular" });
    expect(urls[0]).toBe(`${BACKEND_URL}/v1/order-summary/lith_a1_relic`);
  });

  it("still uses the rank path when the subtype is only whitespace", async () => {
    const { urls } = captureUrls();
    const { fetchBackendOrderSummaryBySlug } =
      await import("../../../../src/lib/wfm/backendLite.js");
    await fetchBackendOrderSummaryBySlug("lith_a1_relic", { subtype: "  ", rank: 3 });
    expect(urls[0]).toBe(`${BACKEND_URL}/v1/order-summary/lith_a1_relic?rank=3`);
  });
});
