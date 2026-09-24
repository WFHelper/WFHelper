import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import { persistedString, persistedStringList } from "../../../src/lib/persistence.js";

function stubStorage(stored: Record<string, string> = {}): Map<string, string> {
  const mem = new Map(Object.entries(stored));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  });
  return mem;
}

describe("persistedString", () => {
  afterEach(() => vi.unstubAllGlobals());

  const allowed = ["a", "b", "c"] as const;

  it("restores a saved value and falls back on anything outside the list", () => {
    stubStorage({ saved: "c", bogus: "d", cased: "B" });
    expect(get(persistedString("saved", allowed, "a"))).toBe("c");
    expect(get(persistedString("bogus", allowed, "a"))).toBe("a");
    expect(get(persistedString("cased", allowed, "a"))).toBe("a");
    expect(get(persistedString("missing", allowed, "a"))).toBe("a");
  });

  it("saves on set and update", () => {
    const mem = stubStorage();
    const store = persistedString("key", allowed, "a");
    store.set("b");
    expect(mem.get("key")).toBe("b");
    store.update(() => "c");
    expect(mem.get("key")).toBe("c");
    expect(get(store)).toBe("c");
  });
});

describe("persistedStringList", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the newest entries at the cap", () => {
    const store = persistedStringList("test.cap", 3);
    store.set(["a", "b", "c"]);
    store.update((list) => [...list, "d"]);
    expect(get(store)).toEqual(["b", "c", "d"]);
  });

  it("drops non-strings and trims from the front on load", () => {
    stubStorage({ "test.load": JSON.stringify(["a", "b", "c", "d", 5]) });
    const store = persistedStringList("test.load", 3);
    expect(get(store)).toEqual(["b", "c", "d"]);
  });
});
