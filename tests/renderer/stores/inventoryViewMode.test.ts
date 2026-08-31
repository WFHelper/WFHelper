import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const STORAGE_KEY = "wf_inventory_view_mode";

async function loadStore(stored: string | null): Promise<{
  store: typeof import("../../../src/stores/inventoryViewMode.js");
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
  const store = await import("../../../src/stores/inventoryViewMode.js");
  return { store, mem };
}

describe("inventoryViewMode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("offers cards first and list second", async () => {
    const { store } = await loadStore(null);
    expect([...store.INVENTORY_VIEW_MODES]).toEqual(["cards", "list"]);
  });

  it("defaults to cards with nothing stored", async () => {
    const { store } = await loadStore(null);
    expect(get(store.inventoryViewMode)).toBe("cards");
  });

  it("restores a stored mode", async () => {
    const { store } = await loadStore("list");
    expect(get(store.inventoryViewMode)).toBe("list");
  });

  it.each(["table", "", "LIST", "rows"])("degrades the unknown value %j to cards", async (raw) => {
    const { store } = await loadStore(raw);
    expect(get(store.inventoryViewMode)).toBe("cards");
  });

  it("persists the selected mode", async () => {
    const { store, mem } = await loadStore(null);
    store.inventoryViewMode.set("list");
    expect(mem.get(STORAGE_KEY)).toBe("list");
    expect(get(store.inventoryViewMode)).toBe("list");
  });

  it("survives localStorage being unavailable", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const store = await import("../../../src/stores/inventoryViewMode.js");
    expect(get(store.inventoryViewMode)).toBe("cards");
    expect(() => store.inventoryViewMode.set("list")).not.toThrow();
  });
});
