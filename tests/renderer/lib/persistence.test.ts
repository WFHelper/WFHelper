import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { persistedStringList } from "../../../src/lib/persistence.js";

describe("persistedStringList", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the newest entries at the cap", () => {
    const store = persistedStringList("test.cap", 3);
    store.set(["a", "b", "c"]);
    store.update((list) => [...list, "d"]);
    expect(get(store)).toEqual(["b", "c", "d"]);
  });

  it("drops non-strings and trims from the front on load", () => {
    const mem = new Map([["test.load", JSON.stringify(["a", "b", "c", "d", 5])]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    });
    const store = persistedStringList("test.load", 3);
    expect(get(store)).toEqual(["b", "c", "d"]);
  });
});
