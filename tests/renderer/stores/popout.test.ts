import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadPopoutStore(search: string) {
  vi.resetModules();
  vi.stubGlobal("window", { location: { search } });
  return import("../../../src/stores/popout.js");
}

describe("popout window flag", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the view and pinned flag from the window URL", async () => {
    const store = await loadPopoutStore("?popout=arbitrations&pinned=1");

    expect(store.popoutView).toBe("arbitrations");
    expect(store.isPopoutWindow).toBe(true);
    expect(store.popoutPinnedAtOpen).toBe(true);
  });

  it("defaults to unpinned", async () => {
    const store = await loadPopoutStore("?popout=world");

    expect(store.popoutView).toBe("world");
    expect(store.popoutPinnedAtOpen).toBe(false);
  });

  it("ignores a view that may not pop out", async () => {
    const store = await loadPopoutStore("?popout=settings&pinned=1");

    expect(store.popoutView).toBeNull();
    expect(store.isPopoutWindow).toBe(false);
  });

  it("is inert in the main window", async () => {
    const store = await loadPopoutStore("");

    expect(store.popoutView).toBeNull();
    expect(store.isPopoutWindow).toBe(false);
    expect(store.popoutPinnedAtOpen).toBe(false);
  });
});
