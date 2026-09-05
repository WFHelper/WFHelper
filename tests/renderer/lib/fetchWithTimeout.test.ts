import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "../../../config/shared/fetchWithTimeout.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("fetchWithTimeout", () => {
  it("aborts a request at the configured deadline", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_input: Request | URL | string, init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;

    const request = fetchWithTimeout("https://example.test", 25);
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("clears the deadline after a response", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;

    await expect(fetchWithTimeout("https://example.test", 25)).resolves.toBeInstanceOf(Response);
    expect(vi.getTimerCount()).toBe(0);
  });
});
