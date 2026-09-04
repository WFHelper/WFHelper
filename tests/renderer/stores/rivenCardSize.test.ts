import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "wf_rivens_card_size";

async function loadStore(stored: string | null): Promise<{
  store: typeof import("../../../src/stores/rivenCardSize.js");
  mem: Map<string, string>;
}> {
  const mem = new Map<string, string>();
  if (stored !== null) mem.set(STORAGE_KEY, stored);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
  });
  // The store reads localStorage once at module load, so hydration only differs
  // per test if the module is re-evaluated after the stub is in place.
  vi.resetModules();
  const store = await import("../../../src/stores/rivenCardSize.js");
  return { store, mem };
}

describe("rivenCardSize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("offers full first and compact second", async () => {
    const { store } = await loadStore(null);
    expect([...store.RIVEN_CARD_SIZES]).toEqual(["full", "compact"]);
  });

  it("defaults to full with nothing stored", async () => {
    const { store } = await loadStore(null);
    expect(get(store.rivenCardSize)).toBe("full");
  });

  it("restores a stored size", async () => {
    const { store } = await loadStore("compact");
    expect(get(store.rivenCardSize)).toBe("compact");
  });

  it.each(["small", "", "COMPACT", "tiny"])(
    "degrades the unknown value %j to full",
    async (raw) => {
      const { store } = await loadStore(raw);
      expect(get(store.rivenCardSize)).toBe("full");
    },
  );

  it("persists the selected size", async () => {
    const { store, mem } = await loadStore(null);
    store.rivenCardSize.set("compact");
    expect(mem.get(STORAGE_KEY)).toBe("compact");
    expect(get(store.rivenCardSize)).toBe("compact");
  });

  it("survives localStorage being unavailable", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const store = await import("../../../src/stores/rivenCardSize.js");
    expect(get(store.rivenCardSize)).toBe("full");
    expect(() => store.rivenCardSize.set("compact")).not.toThrow();
  });
});
