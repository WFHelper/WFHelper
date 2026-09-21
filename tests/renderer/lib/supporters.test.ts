import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_PRODUCT_NAME } from "../../../config/shared/appMeta.js";

const originalFetch = globalThis.fetch;

function supportersResponse(): Response {
  return new Response(JSON.stringify({ ok: true, supporters: [{ name: "Ordis", tier: "big" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_APP_VERSION", "1.9.0");
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe("loadSupporters", () => {
  it("identifies the client to the backend", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(
      async (input: Request | URL | string, init: { headers?: Record<string, string> } = {}) => {
        requests.push({ url: String(input), headers: init.headers ?? {} });
        return supportersResponse();
      },
    ) as unknown as typeof fetch;

    const { loadSupporters } = await import("../../../src/lib/supporters.js");
    await expect(loadSupporters()).resolves.toEqual([{ name: "Ordis", tier: "big" }]);

    expect(requests[0].url).toContain("/v1/supporters");
    const headers = requests[0].headers;
    expect(headers["x-wfhelper-client"]).toBe(`${APP_PRODUCT_NAME}/1.9.0`);
  });

  it("resolves to an empty list when the backend is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const { loadSupporters } = await import("../../../src/lib/supporters.js");
    await expect(loadSupporters()).resolves.toEqual([]);
  });
});
