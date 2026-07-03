import { beforeEach, describe, expect, it, vi } from "vitest";

const loadItemPriceMock = vi.hoisted(() =>
  vi.fn<
    (
      name: string,
      lookup: Record<string, { url_name: string }>,
      isTradable: boolean,
    ) => Promise<{ text: string; slug: string | null }>
  >(),
);

vi.mock("../../../src/lib/priceLoader.js", () => ({
  loadItemPrice: loadItemPriceMock,
}));

import { createPriceLoader } from "../../../src/lib/priceState.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createPriceLoader", () => {
  beforeEach(() => {
    loadItemPriceMock.mockReset();
  });

  it("tries a fallback full name when the first lookup has no listing slug", async () => {
    loadItemPriceMock
      .mockResolvedValueOnce({ text: "No listing found.", slug: null })
      .mockResolvedValueOnce({ text: "~15 platinum (48h median)", slug: "trinity_prime_chassis" });

    const states: Array<{ text: string; slug: string | null }> = [];
    const loader = createPriceLoader((state) => states.push(state));

    await loader.load("Trinity Prime Chassis Blueprint", {}, true, {
      fallbackName: "Trinity Prime Chassis",
      fallbackTradable: true,
    });

    expect(loadItemPriceMock).toHaveBeenNthCalledWith(
      1,
      "Trinity Prime Chassis Blueprint",
      {},
      true,
    );
    expect(loadItemPriceMock).toHaveBeenNthCalledWith(2, "Trinity Prime Chassis", {}, true);
    expect(states[states.length - 1]).toEqual({
      text: "~15 platinum (48h median)",
      slug: "trinity_prime_chassis",
    });
  });

  it("ignores stale async results after a newer load starts", async () => {
    const oldResult = deferred<{ text: string; slug: string | null }>();
    loadItemPriceMock.mockImplementation((name) => {
      if (name === "Old Item") return oldResult.promise;
      return Promise.resolve({ text: "New price", slug: "new_item" });
    });

    const states: Array<{ text: string; slug: string | null }> = [];
    const loader = createPriceLoader((state) => states.push(state));

    const oldLoad = loader.load("Old Item", {}, true);
    await loader.load("New Item", {}, true);
    oldResult.resolve({ text: "Old price", slug: "old_item" });
    await oldLoad;

    expect(states[states.length - 1]).toEqual({ text: "New price", slug: "new_item" });
  });
});
