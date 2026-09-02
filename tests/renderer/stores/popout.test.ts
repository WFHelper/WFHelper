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

  it("reads the view target and pinned flag from the window URL", async () => {
    const store = await loadPopoutStore("?popout=view:arbitrations&pinned=1");

    expect(store.popoutView).toBe("arbitrations");
    expect(store.popoutSectionId).toBeNull();
    expect(store.isPopoutWindow).toBe(true);
    expect(store.popoutPinnedAtOpen).toBe(true);
  });

  it("still reads a bare view name from a URL an older build wrote", async () => {
    const store = await loadPopoutStore("?popout=world");

    expect(store.popoutView).toBe("world");
    expect(store.popoutPinnedAtOpen).toBe(false);
  });

  it("reads a section target", async () => {
    const store = await loadPopoutStore("?popout=section:world.fissures");

    expect(store.popoutSectionId).toBe("world.fissures");
    expect(store.popoutView).toBeNull();
    expect(store.isPopoutWindow).toBe(true);
  });

  it("ignores a view that may not pop out", async () => {
    const store = await loadPopoutStore("?popout=settings&pinned=1");

    expect(store.popoutView).toBeNull();
    expect(store.isPopoutWindow).toBe(false);
  });

  it("ignores a section id that is not the registry shape", async () => {
    const store = await loadPopoutStore("?popout=section:../../etc/passwd");

    expect(store.popoutSectionId).toBeNull();
    expect(store.popoutView).toBeNull();
    expect(store.isPopoutWindow).toBe(false);
  });

  it("is inert in the main window", async () => {
    const store = await loadPopoutStore("");

    expect(store.popoutView).toBeNull();
    expect(store.popoutSectionId).toBeNull();
    expect(store.isPopoutWindow).toBe(false);
    expect(store.popoutPinnedAtOpen).toBe(false);
  });
});
